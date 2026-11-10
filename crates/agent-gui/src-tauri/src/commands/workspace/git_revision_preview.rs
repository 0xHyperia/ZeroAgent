//! Resolve read-only image and PDF previews from the objects in the selected Git comparison.
use super::{
    ensure_ready_state, git_output_configured, git_success, ref_exists, repo_path_matches_filter,
    resolve_review_base, validate_commit_sha, validate_repo_relative_path, GitCommitFile,
    GitRepositoryState, GIT_DIFF_MAX_BYTES,
};
use crate::commands::workspace_commands::fs::{infer_image_mime, infer_image_mime_from_bytes};
use crate::services::kbrain_backend::KBrainBackendState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path, process::Command, sync::Arc, time::Duration};
use uuid::Uuid;

const PREVIEW_UNAVAILABLE: &str = "The selected Git revision cannot be previewed.";
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const GIT_PREVIEW_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Serialize, Deserialize)]
pub struct RevisionPreviewSide {
    mime: String,
    base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RevisionPreview {
    before: Option<RevisionPreviewSide>,
    after: Option<RevisionPreviewSide>,
}

impl RevisionPreview {
    pub(super) fn encoded_size(&self) -> usize {
        self.before
            .iter()
            .chain(self.after.iter())
            .map(|side| side.base64.len())
            .sum()
    }
}

#[derive(Debug)]
pub(super) struct RawChange<'a> {
    pub(super) path: &'a str,
    pub(super) old_path: &'a str,
    status: &'a str,
    before_mode: &'a str,
    after_mode: &'a str,
    before_oid: &'a str,
    after_oid: &'a str,
}

fn is_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_null_oid(value: &str) -> bool {
    value.bytes().all(|byte| byte == b'0')
}

pub(super) fn raw_changes(raw: &str) -> Vec<RawChange<'_>> {
    let mut changes = Vec::new();
    let mut records = raw.split_terminator('\0');
    while let Some(header) = records.next() {
        let Some(header) = header.strip_prefix(':') else {
            break;
        };
        let fields: Vec<_> = header.split_ascii_whitespace().collect();
        let [before_mode, after_mode, before_oid, after_oid, status] = fields.as_slice() else {
            break;
        };
        let Some(old_path) = records.next() else {
            break;
        };
        let path = if status.starts_with(['R', 'C']) {
            let Some(path) = records.next() else {
                break;
            };
            path
        } else {
            old_path
        };
        if is_oid(before_oid) && is_oid(after_oid) && before_oid.len() == after_oid.len() {
            changes.push(RawChange {
                path,
                old_path,
                status,
                before_mode,
                after_mode,
                before_oid,
                after_oid,
            });
        }
    }
    changes
}

impl RawChange<'_> {
    pub(super) fn is_previewable(&self) -> bool {
        preview_mime(self.path).is_some() || preview_mime(self.old_path).is_some()
    }

    pub(super) fn change(&self) -> GitCommitFile {
        GitCommitFile {
            path: self.path.to_owned(),
            old_path: self
                .status
                .starts_with(['R', 'C'])
                .then(|| self.old_path.to_owned()),
            status: self.status.chars().take(1).collect(),
            kind: super::commit_file_kind(self.status),
            // Git omits the index header when a rename has no content changes.
            preview_index: (self.status.starts_with(['R', 'C'])
                && !is_null_oid(self.after_oid)
                && self.is_previewable())
            .then(|| format!("index {}..{}", self.before_oid, self.after_oid)),
        }
    }

    pub(super) fn previews(
        &self,
        mut git: impl FnMut(&[&str]) -> Result<Vec<u8>, String>,
        worktree: Option<(&Path, &str)>,
    ) -> Result<RevisionPreview, String> {
        let mut load = |mode, oid, path| match mode {
            "000000" => Ok(None),
            "100644" | "100755" => {
                let bytes = if is_null_oid(oid) {
                    let (root, expected) = worktree.ok_or(PREVIEW_UNAVAILABLE)?;
                    let bytes = read_worktree(root, path)?;
                    if git_blob_oid(&bytes, expected.len()) != expected {
                        return Err(PREVIEW_UNAVAILABLE.into());
                    }
                    bytes
                } else {
                    read_blob(oid, &mut git)?
                };
                encode_preview(path, &bytes).map(Some)
            }
            _ => Err(PREVIEW_UNAVAILABLE.into()),
        };
        Ok(RevisionPreview {
            before: load(self.before_mode, self.before_oid, self.old_path)?,
            after: load(self.after_mode, self.after_oid, self.path)?,
        })
    }
}

fn preview_mime(path: &str) -> Option<&'static str> {
    let path = Path::new(path);
    if path.extension()?.eq_ignore_ascii_case("pdf") {
        Some("application/pdf")
    } else {
        infer_image_mime(path)
    }
}

fn encode_preview(path: &str, bytes: &[u8]) -> Result<RevisionPreviewSide, String> {
    // An extension selects a viewer. The bytes still have to match its format.
    let mime = preview_mime(path).ok_or(PREVIEW_UNAVAILABLE)?;
    let matches = if mime == "application/pdf" {
        bytes.starts_with(b"%PDF-")
    } else {
        infer_image_mime_from_bytes(bytes) == Some(mime)
    };
    if !matches {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    Ok(RevisionPreviewSide {
        mime: mime.into(),
        base64: STANDARD.encode(bytes),
    })
}

fn read_blob(
    oid: &str,
    git: &mut impl FnMut(&[&str]) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    if !is_oid(oid) {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    let size = git(&["cat-file", "-s", oid])?;
    let size = std::str::from_utf8(&size)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|size| *size <= MAX_PREVIEW_BYTES)
        .ok_or(PREVIEW_UNAVAILABLE)?;
    let bytes = git(&["cat-file", "blob", oid])?;
    if bytes.len() != size {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    Ok(bytes)
}

fn canonical_repo_path(path: &str) -> Result<(), String> {
    if path != validate_repo_relative_path(path)?
        || path.contains('\0')
        || (cfg!(windows) && path.contains(':'))
        || path
            .split('/')
            .any(|part| matches!(part, "" | ".") || part.eq_ignore_ascii_case(".git"))
    {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    Ok(())
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn read_worktree(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    canonical_repo_path(path)?;
    let mut target = root.to_path_buf();
    for part in path.split('/') {
        target.push(part);
        let metadata = fs::symlink_metadata(&target).map_err(|_| PREVIEW_UNAVAILABLE)?;
        if is_link(&metadata) {
            return Err(PREVIEW_UNAVAILABLE.into());
        }
    }
    let target = fs::canonicalize(target).map_err(|_| PREVIEW_UNAVAILABLE)?;
    if !target.starts_with(root) {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    let file = fs::File::open(target).map_err(|_| PREVIEW_UNAVAILABLE)?;
    let metadata = file.metadata().map_err(|_| PREVIEW_UNAVAILABLE)?;
    if !metadata.is_file() || metadata.len() > MAX_PREVIEW_BYTES as u64 {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PREVIEW_UNAVAILABLE)?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    Ok(bytes)
}

fn git_blob_oid(bytes: &[u8], oid_length: usize) -> String {
    let header = format!("blob {}\0", bytes.len());
    if oid_length == 40 {
        use sha1::{Digest, Sha1};
        let mut hash = Sha1::new();
        hash.update(header.as_bytes());
        hash.update(bytes);
        format!("{:x}", hash.finalize())
    } else {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(header.as_bytes());
        hash.update(bytes);
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

fn expected_oids(patch: &str) -> Option<(&str, &str)> {
    if patch.len() > GIT_DIFF_MAX_BYTES {
        return None;
    }
    let mut ids = patch
        .lines()
        .filter_map(|line| line.strip_prefix("index "))
        .filter_map(|header| header.split_ascii_whitespace().next()?.split_once(".."));
    let (before, after) = ids.next()?;
    (ids.next().is_none() && is_oid(before) && is_oid(after) && before.len() == after.len())
        .then_some((before, after))
}

fn offline_git(command: &mut Command) {
    command
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1");
}

fn read_originals(repo: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = git_output_configured(repo, args, GIT_PREVIEW_TIMEOUT, offline_git)?;
    if !output.status.success() {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    Ok(output.stdout)
}

pub(super) fn review_branch(
    state: &GitRepositoryState,
    comparison: &str,
) -> Result<String, String> {
    if let Some(reference) = comparison.strip_prefix("branch:") {
        if !(reference.starts_with("refs/heads/") || reference.starts_with("refs/remotes/"))
            || git_success(&state.repo_root, &["check-ref-format", reference]).is_err()
            || !ref_exists(&state.repo_root, reference)
        {
            return Err("找不到选定的基线分支。".to_string());
        }
        return Ok(reference.to_owned());
    }
    let reference = resolve_review_base(state);
    if reference.is_empty() {
        return Err("找不到可用于审查的基线分支。请先设置 upstream 或 fetch 主分支。".to_string());
    }
    Ok(reference)
}

pub(super) fn first_parent(repo: &str, commit: &str) -> Result<String, String> {
    Ok(git_success(repo, &["show", "-s", "--format=%P", commit])?
        .stdout
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_owned())
}

fn read(
    workdir: &str,
    comparison: &str,
    path: &str,
    expected_patch: &str,
) -> Result<RevisionPreview, String> {
    canonical_repo_path(path)?;
    let (before, after) = expected_oids(expected_patch).ok_or(PREVIEW_UNAVAILABLE)?;
    let state = ensure_ready_state(workdir)?;
    let repo = state.repo_root.as_str();
    let root = fs::canonicalize(repo).map_err(|_| PREVIEW_UNAVAILABLE)?;
    let workdir = fs::canonicalize(workdir).map_err(|_| PREVIEW_UNAVAILABLE)?;
    let scope = workdir
        .strip_prefix(&root)
        .ok()
        .and_then(Path::to_str)
        .ok_or(PREVIEW_UNAVAILABLE)?
        .replace('\\', "/");
    let scope = (!scope.is_empty()).then_some(scope.as_str());
    if !repo_path_matches_filter(path, scope) {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    let mut args = vec![
        "--literal-pathspecs".to_owned(),
        "diff".to_owned(),
        "--raw".to_owned(),
        "--no-abbrev".to_owned(),
        "--no-ext-diff".to_owned(),
        "--no-textconv".to_owned(),
        "--find-renames".to_owned(),
        "-z".to_owned(),
    ];
    let working = matches!(comparison, "working_tree" | "unstaged");
    match comparison {
        "working_tree" => args.push("HEAD".to_owned()),
        "staged" => args.push("--cached".to_owned()),
        "unstaged" => (),
        "branch" => args.push(format!("{}...HEAD", review_branch(&state, comparison)?)),
        _ if comparison.starts_with("branch:") => {
            args.push(format!("{}...HEAD", review_branch(&state, comparison)?))
        }
        _ if comparison.starts_with("commit:") => {
            let commit = validate_commit_sha(repo, &comparison["commit:".len()..])?;
            let parent = first_parent(repo, &commit)?;
            if parent.is_empty() {
                args[1] = "show".to_owned();
                args.push("--format=".to_owned());
            } else {
                args.push(parent);
            }
            args.push(commit);
        }
        _ => return Err(PREVIEW_UNAVAILABLE.into()),
    }
    args.push("--".to_owned());
    args.extend(scope.map(str::to_owned));
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    let raw = read_originals(repo, &args)?;
    let raw = std::str::from_utf8(&raw).map_err(|_| PREVIEW_UNAVAILABLE)?;
    let changes = raw_changes(raw);
    let change = changes
        .iter()
        .find(|change| change.path == path)
        .filter(|change| {
            change.is_previewable()
                && repo_path_matches_filter(change.old_path, scope)
                && change.before_oid == before
                && if working && change.after_mode != "000000" && is_null_oid(change.after_oid) {
                    !is_null_oid(after)
                } else {
                    change.after_oid == after
                }
        })
        .ok_or(PREVIEW_UNAVAILABLE)?;
    canonical_repo_path(change.old_path)?;
    change.previews(
        |args| read_originals(repo, args),
        working.then_some((&root, after)),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn git_workspace_diff_preview(
    state: tauri::State<'_, Arc<KBrainBackendState>>,
    workdir: String,
    comparison: String,
    path: String,
    expected_patch: Option<String>,
    conversation_id: Option<String>,
    snapshot_id: Option<Uuid>,
) -> Result<RevisionPreview, String> {
    if !state.allows_profile_commands() {
        return Err(PREVIEW_UNAVAILABLE.into());
    }
    let owner = state.configuration_root()?;
    let backend = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if !backend.allows_profile_commands() || backend.configuration_root()? != owner {
            return Err(PREVIEW_UNAVAILABLE.into());
        }
        let result = if comparison == "last-turn" {
            canonical_repo_path(&path)?;
            super::turn_review::read_preview(
                &owner,
                conversation_id.as_deref().ok_or(PREVIEW_UNAVAILABLE)?,
                &workdir,
                &path,
                snapshot_id.ok_or(PREVIEW_UNAVAILABLE)?,
            )
        } else {
            read(
                &workdir,
                &comparison,
                &path,
                expected_patch.as_deref().ok_or(PREVIEW_UNAVAILABLE)?,
            )
        };
        if !backend.allows_profile_commands() || backend.configuration_root()? != owner {
            return Err(PREVIEW_UNAVAILABLE.into());
        }
        result
    })
    .await
    .map_err(|_| PREVIEW_UNAVAILABLE.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(repo: &str) -> String {
        git_success(repo, &["add", "-A"]).unwrap();
        git_success(
            repo,
            &[
                "-c",
                "user.name=Preview Fixture",
                "-c",
                "user.email=preview@example.test",
                "commit",
                "--no-gpg-sign",
                "-m",
                "Fixture",
            ],
        )
        .unwrap();
        git_success(repo, &["rev-parse", "HEAD"]).unwrap().stdout
    }

    fn png(value: u8) -> Vec<u8> {
        [b"\x89PNG\r\n\x1a\n\0".as_slice(), &[value]].concat()
    }

    fn index(before: Option<&[u8]>, after: Option<&[u8]>) -> String {
        let oid = |bytes: Option<&[u8]>| {
            bytes.map_or_else(|| "0".repeat(40), |bytes| git_blob_oid(bytes, 40))
        };
        format!("index {}..{}", oid(before), oid(after))
    }

    fn bytes(side: Option<RevisionPreviewSide>) -> Option<Vec<u8>> {
        side.map(|side| STANDARD.decode(side.base64).unwrap())
    }

    #[test]
    fn git_revision_preview_reads_commit_merge_base_and_rename_without_current_disk() {
        const ADDED_PDF: &[u8] = b"%PDF-1.7\nnew original PDF body\0\x01\n%%EOF\n";
        const REMOVED_PDF: &[u8] = b"%PDF-1.7\nremoved previous version\0\x02\n%%EOF\n";
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repository = tempfile::tempdir().unwrap();
        let root = repository.path();
        let repo = root.to_str().unwrap();
        let scope = root.join("sub");
        let workdir = scope.to_str().unwrap();
        fs::create_dir(&scope).unwrap();
        git_success(repo, &["init", "-b", "main", "--object-format=sha1"]).unwrap();
        fs::write(scope.join("picture.png"), png(1)).unwrap();
        fs::write(scope.join("rename.png"), png(2)).unwrap();
        fs::write(scope.join("removed.pdf"), REMOVED_PDF).unwrap();
        fs::write(root.join("sibling.png"), png(3)).unwrap();
        fs::write(scope.join("zz.txt"), b"old value\n").unwrap();
        commit(repo);
        git_success(repo, &["switch", "-c", "comparison"]).unwrap();
        fs::write(scope.join("picture.png"), png(4)).unwrap();
        commit(repo);
        git_success(repo, &["switch", "main"]).unwrap();
        fs::write(scope.join("picture.png"), png(5)).unwrap();
        fs::rename(scope.join("rename.png"), scope.join("renamed.png")).unwrap();
        fs::remove_file(scope.join("removed.pdf")).unwrap();
        fs::write(scope.join("added.pdf"), ADDED_PDF).unwrap();
        fs::write(root.join("sibling.png"), png(6)).unwrap();
        fs::write(scope.join("zz.txt"), b"new value  \n").unwrap();
        let revision = commit(repo);
        let commit = format!("commit:{revision}");
        fs::write(scope.join("picture.png"), png(7)).unwrap();
        fs::write(scope.join("added.pdf"), b"%PDF-1.7\nmutable replacement").unwrap();
        fs::write(scope.join("removed.pdf"), b"%PDF-1.7\nmutable replacement").unwrap();
        let diff = super::super::git_commit_diff_sync(repo.to_owned(), revision, None).unwrap();
        assert!(diff.patch.ends_with("+new value  \n"));
        let image_index = index(Some(&png(1)), Some(&png(5)));
        assert!(diff.patch.contains(&image_index));
        let rename = diff
            .changes
            .iter()
            .find(|change| change.path == "sub/renamed.png")
            .unwrap();
        let rename_index = index(Some(&png(2)), Some(&png(2)));
        assert_eq!(rename.preview_index.as_deref(), Some(rename_index.as_str()));
        fs::remove_file(scope.join("renamed.png")).unwrap();
        let rename = read(workdir, &commit, "sub/renamed.png", &rename_index).unwrap();
        assert_eq!(bytes(rename.before), Some(png(2)));
        assert_eq!(bytes(rename.after), Some(png(2)));
        for comparison in [&commit, "branch:refs/heads/comparison"] {
            let preview = read(workdir, comparison, "sub/picture.png", &image_index).unwrap();
            assert_eq!(bytes(preview.before), Some(png(1)));
            assert_eq!(bytes(preview.after), Some(png(5)));
        }
        let added = read(
            workdir,
            &commit,
            "sub/added.pdf",
            &index(None, Some(ADDED_PDF)),
        )
        .unwrap();
        assert!(added.before.is_none());
        assert_eq!(added.after.as_ref().unwrap().mime, "application/pdf");
        assert_eq!(bytes(added.after).unwrap(), ADDED_PDF);
        let deleted = read(
            workdir,
            &commit,
            "sub/removed.pdf",
            &index(Some(REMOVED_PDF), None),
        )
        .unwrap();
        assert_eq!(bytes(deleted.before).unwrap(), REMOVED_PDF);
        assert!(deleted.after.is_none());
        assert!(read(
            workdir,
            &commit,
            "sibling.png",
            &index(Some(&png(3)), Some(&png(6))),
        )
        .is_err());
    }

    #[test]
    fn git_revision_preview_checks_worktree_identity_and_rejects_oversized_objects() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repository = tempfile::tempdir().unwrap();
        let root = repository.path();
        let repo = root.to_str().unwrap();
        git_success(repo, &["init", "-b", "main", "--object-format=sha1"]).unwrap();
        let path = root.join("picture.png");
        fs::write(&path, png(1)).unwrap();
        commit(repo);
        fs::write(&path, png(2)).unwrap();
        git_success(repo, &["add", "picture.png"]).unwrap();
        fs::write(&path, png(3)).unwrap();
        for (mode, before, after) in [("staged", 1, 2), ("unstaged", 2, 3), ("working_tree", 1, 3)]
        {
            let expected = index(Some(&png(before)), Some(&png(after)));
            let diff =
                super::super::git_diff_sync(repo.to_owned(), Some(mode.into()), None).unwrap();
            assert!(diff.patch.contains(&expected));
            let preview = read(repo, mode, "picture.png", &expected).unwrap();
            assert_eq!(bytes(preview.before), Some(png(before)));
            assert_eq!(bytes(preview.after), Some(png(after)));
        }
        fs::write(&path, png(4)).unwrap();
        let stale = index(Some(&png(1)), Some(&png(3)));
        assert!(read(repo, "working_tree", "picture.png", &stale).is_err());
        fs::remove_file(path).unwrap();
        assert!(read(repo, "working_tree", "picture.png", &stale).is_err());
        let mut calls = 0;
        assert!(read_blob(&git_blob_oid(&png(1), 40), &mut |args| {
            calls += 1;
            assert_eq!(args[1], "-s");
            Ok((MAX_PREVIEW_BYTES + 1).to_string().into_bytes())
        })
        .is_err());
        assert_eq!(calls, 1);
    }
}
