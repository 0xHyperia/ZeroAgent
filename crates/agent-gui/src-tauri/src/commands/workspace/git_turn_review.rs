//! Account-scoped, read-only review capture. The temporary repository can read
//! existing Git objects but owns every index and object it writes.
use super::{
    discover_repo, git_output_configured, git_success, parse_status_porcelain_v2, ref_exists,
    repo_path_matches_filter, review_numstat_paths,
    revision_preview::{raw_changes, RawChange, RevisionPreview},
    trim_output, validate_repo_relative_path, GitDiffResponse, GitReviewDiffOptions,
    GIT_DIFF_MAX_BYTES,
};
use crate::services::kbrain_backend::KBrainBackendState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;

const MAX_DIRTY_PATHS: usize = 512;
const MAX_OVERLAY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STORED_REVIEW_BYTES: usize = GIT_DIFF_MAX_BYTES * 3;
const MAX_STORED_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
const MAX_PREVIEW_FILES: usize = 48;
const MAX_SNAPSHOT_AGE: Duration = Duration::from_secs(4 * 60 * 60);
const GIT_TIMEOUT: Duration = Duration::from_secs(6);
const UNAVAILABLE: &str = "The last turn has no complete workspace snapshot.";

struct Snapshot {
    temporary: TempDir,
    repo: String,
    objects: String,
    autocrlf: String,
    scope: Option<String>,
    before: String,
}

#[derive(Deserialize, Serialize)]
struct ReviewSnapshot {
    #[serde(flatten)]
    diff: GitDiffResponse,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_patch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    whitespace_patch: Option<WhitespaceReview>,
}

#[derive(Deserialize, Serialize)]
struct ReviewPreviews {
    snapshot_id: Uuid,
    files: HashMap<String, RevisionPreview>,
}

#[derive(Deserialize, Serialize)]
struct WhitespaceReview {
    patch: String,
    visible_indices: BTreeSet<usize>,
}

fn isolated(command: &mut Command) {
    command
        .env_remove("GIT_DIR")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_NO_LAZY_FETCH", "1");
    command.env("GIT_NO_REPLACE_OBJECTS", "1");
}

impl Snapshot {
    fn new(repo: String, workdir: &Path) -> Result<Self, String> {
        let root = fs::canonicalize(&repo).map_err(|error| error.to_string())?;
        let relative = workdir
            .strip_prefix(root)
            .map_err(|error| error.to_string())?;
        let relative = relative.to_str().ok_or(UNAVAILABLE)?.replace('\\', "/");
        let scope = (!relative.is_empty()).then_some(relative);
        let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
        let objects = git_success(
            &repo,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
        )?
        .stdout
        .trim()
        .to_owned();
        let format = git_success(&repo, &["rev-parse", "--show-object-format"])?;
        let format = format!("--object-format={}", format.stdout.trim());
        let output = git_output_configured(
            temporary.path().to_str().ok_or(UNAVAILABLE)?,
            &["init", "--bare", "--template=", &format],
            GIT_TIMEOUT,
            isolated,
        )?;
        if !output.status.success() {
            return Err(trim_output(&output.stderr));
        }
        let autocrlf = git_success(&repo, &["config", "--get", "core.autocrlf"])
            .ok()
            .map(|value| value.stdout.trim().to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), "true" | "input"))
            .unwrap_or_else(|| "false".into());
        let mut snapshot = Self {
            temporary,
            repo,
            objects,
            autocrlf,
            scope,
            before: String::new(),
        };
        snapshot.before = snapshot.tree()?;
        Ok(snapshot)
    }

    fn git(&self, args: &[&str], input: Option<fs::File>) -> Result<String, String> {
        String::from_utf8(self.git_bytes(args, input)?).map_err(|_| UNAVAILABLE.into())
    }

    fn git_bytes(&self, args: &[&str], input: Option<fs::File>) -> Result<Vec<u8>, String> {
        let autocrlf = format!("core.autocrlf={}", self.autocrlf);
        let mut full_args = vec![
            "--git-dir",
            self.temporary.path().to_str().ok_or(UNAVAILABLE)?,
            "--work-tree",
            &self.repo,
            "--literal-pathspecs",
            "-c",
            &autocrlf,
            "-c",
            "core.fsmonitor=false",
        ];
        full_args.extend_from_slice(args);
        let output = git_output_configured(&self.repo, &full_args, GIT_TIMEOUT, |command| {
            isolated(command);
            command.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &self.objects);
            if let Some(input) = input {
                command.stdin(Stdio::from(input));
            }
        })?;
        if !output.status.success() {
            return Err(trim_output(&output.stderr));
        }
        Ok(output.stdout)
    }

    fn tree(&self) -> Result<String, String> {
        let filter_config = git_output_configured(
            &self.repo,
            &[
                "config",
                "-z",
                "--name-only",
                "--get-regexp",
                "^filter\\..*\\.(clean|smudge|process|required)$",
            ],
            GIT_TIMEOUT,
            |_| {},
        )?;
        if !matches!(filter_config.status.code(), Some(0 | 1)) {
            return Err(UNAVAILABLE.into());
        }
        let config = std::str::from_utf8(&filter_config.stdout).map_err(|_| UNAVAILABLE)?;
        let overrides = config
            .split_terminator('\0')
            .map(|key| {
                let value = if key.ends_with(".required") {
                    "false"
                } else {
                    ""
                };
                format!("{key}={value}")
            })
            .collect::<Vec<_>>();
        let mut status_args = vec!["-c", "core.fsmonitor=false"];
        for filter in &overrides {
            status_args.extend(["-c", filter.as_str()]);
        }
        status_args.extend(["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
        let status = git_output_configured(&self.repo, &status_args, GIT_TIMEOUT, |command| {
            command.env("GIT_NO_LAZY_FETCH", "1");
        })?;
        if !status.status.success() || std::str::from_utf8(&status.stdout).is_err() {
            return Err(UNAVAILABLE.into());
        }
        let (_, _, _, _, _, entries) = parse_status_porcelain_v2(&status.stdout);
        if ref_exists(&self.repo, "HEAD") {
            let head = git_success(&self.repo, &["rev-parse", "--verify", "HEAD"])?;
            self.git(&["read-tree", head.stdout.trim()], None)?;
        } else {
            self.git(&["read-tree", "--empty"], None)?;
        }
        let mut paths = BTreeSet::new();
        for entry in entries {
            for path in std::iter::once(entry.path).chain(entry.old_path) {
                if repo_path_matches_filter(&path, self.scope.as_deref()) {
                    if validate_repo_relative_path(&path)? != path {
                        return Err(UNAVAILABLE.into());
                    }
                    paths.insert(path);
                }
            }
        }
        if paths.len() > MAX_DIRTY_PATHS {
            return Err(UNAVAILABLE.into());
        }
        let mut removed =
            NamedTempFile::new_in(self.temporary.path()).map_err(|e| e.to_string())?;
        let mut present =
            NamedTempFile::new_in(self.temporary.path()).map_err(|e| e.to_string())?;
        let mut bytes = 0;
        for path in paths {
            let file = Path::new(&self.repo).join(&path);
            let target = match fs::symlink_metadata(&file) {
                Ok(meta) if meta.is_file() || meta.is_symlink() => {
                    bytes += meta.len();
                    if bytes > MAX_OVERLAY_BYTES {
                        return Err(UNAVAILABLE.into());
                    }
                    &mut present
                }
                Ok(meta) if meta.is_dir() && file.join(".git").exists() => {
                    return Err(UNAVAILABLE.into())
                }
                Ok(_) => &mut removed,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => &mut removed,
                Err(error) => return Err(error.to_string()),
            };
            write!(target, "{path}\0").map_err(|error| error.to_string())?;
        }
        let stdin = |file: &mut NamedTempFile| -> Result<fs::File, String> {
            file.as_file_mut().rewind().map_err(|e| e.to_string())?;
            file.reopen().map_err(|e| e.to_string())
        };
        if removed
            .as_file()
            .metadata()
            .map_err(|e| e.to_string())?
            .len()
            > 0
        {
            self.git(
                &["update-index", "--force-remove", "-z", "--stdin"],
                Some(stdin(&mut removed)?),
            )?;
        }
        if present
            .as_file()
            .metadata()
            .map_err(|e| e.to_string())?
            .len()
            > 0
        {
            self.git(
                &[
                    "add",
                    "--force",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                Some(stdin(&mut present)?),
            )?;
        }
        Ok(self.git(&["write-tree"], None)?.trim().to_owned())
    }

    fn finish(&self, id: Uuid) -> Result<(ReviewSnapshot, ReviewPreviews), String> {
        let after = self.tree()?;
        let compare = |output_options: &[&str]| {
            let mut args = vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--find-renames",
                "--full-index",
            ];
            args.extend_from_slice(output_options);
            args.extend([self.before.as_str(), after.as_str(), "--"]);
            args.extend(self.scope.as_deref());
            self.git(&args, None)
        };
        let raw = compare(&["--raw", "--no-abbrev", "-z"])?;
        let raw = raw_changes(&raw);
        let changes: Vec<_> = raw.iter().map(RawChange::change).collect();
        if changes.len() > MAX_DIRTY_PATHS {
            return Err(UNAVAILABLE.into());
        }
        let patch = compare(&["--patch", "--src-prefix=a/", "--dst-prefix=b/"])?;
        if patch.len() > GIT_DIFF_MAX_BYTES {
            return Err(UNAVAILABLE.into());
        }
        let full_patch = if changes.is_empty() {
            None
        } else {
            compare(&[
                "--patch",
                "--unified=1000000",
                "--src-prefix=a/",
                "--dst-prefix=b/",
            ])
            .ok()
            .filter(|patch| patch.len() <= GIT_DIFF_MAX_BYTES)
        };
        let whitespace_patch = (!changes.is_empty())
            .then(|| {
                let patch = compare(&[
                    "--patch",
                    "--ignore-all-space",
                    "--src-prefix=a/",
                    "--dst-prefix=b/",
                ])
                .ok()?;
                if patch.len() > GIT_DIFF_MAX_BYTES {
                    return None;
                }
                let numstat = compare(&["--ignore-all-space", "--numstat", "-z"]).ok()?;
                let paths = review_numstat_paths(&numstat)?;
                let visible_indices = changes
                    .iter()
                    .enumerate()
                    .filter_map(|(index, change)| {
                        paths.contains(change.path.as_str()).then_some(index)
                    })
                    .collect();
                Some(WhitespaceReview {
                    patch,
                    visible_indices,
                })
            })
            .flatten();
        let mut previews = ReviewPreviews {
            snapshot_id: id,
            files: HashMap::new(),
        };
        let started = Instant::now();
        let mut encoded_size = 0;
        for change in raw
            .iter()
            .filter(|change| {
                change.is_previewable()
                    && repo_path_matches_filter(change.path, self.scope.as_deref())
                    && repo_path_matches_filter(change.old_path, self.scope.as_deref())
            })
            .take(MAX_PREVIEW_FILES)
        {
            if started.elapsed() >= GIT_TIMEOUT {
                break;
            }
            if let Ok(preview) = change.previews(|args| self.git_bytes(args, None), None) {
                // Leave room for names and the JSON envelope under the same disk budget.
                encoded_size += preview.encoded_size();
                if encoded_size > MAX_STORED_PREVIEW_BYTES - GIT_DIFF_MAX_BYTES {
                    break;
                }
                previews.files.insert(change.path.to_owned(), preview);
            }
        }
        let snapshot = ReviewSnapshot {
            full_patch,
            whitespace_patch,
            diff: GitDiffResponse {
                base_ref: "TURN_START".into(),
                head_ref: "TURN_END".into(),
                mode: "last-turn".into(),
                files: changes.iter().map(|change| change.path.clone()).collect(),
                changes,
                patch,
                stat: String::new(),
                truncated: false,
                binary_files: Vec::new(),
                snapshot_id: Some(id),
            },
        };
        Ok((snapshot, previews))
    }
}

struct Pending {
    owner: PathBuf,
    store: PathBuf,
    repo: String,
    started: Instant,
    overlapped: bool,
    baseline: Option<Snapshot>,
}

static PENDING: LazyLock<Mutex<HashMap<Uuid, Pending>>> = LazyLock::new(Mutex::default);

fn review_path(owner: &Path, conversation_id: &str, workdir: &Path) -> Result<PathBuf, String> {
    if conversation_id.is_empty() || conversation_id.len() > 256 {
        return Err(UNAVAILABLE.into());
    }
    let digest = Sha256::digest(format!("{conversation_id}\0{}", workdir.display()).as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(owner.join("workspace-review").join(format!("{hex}.json")))
}

fn review_directory(owner: &Path, directory: &Path, create: bool) -> Result<PathBuf, String> {
    if create {
        match fs::create_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let owner = fs::canonicalize(owner).map_err(|_| UNAVAILABLE)?;
    let path = fs::canonicalize(directory).map_err(|_| UNAVAILABLE)?;
    if path.parent() != Some(&owner) || path.file_name() != directory.file_name() {
        return Err(UNAVAILABLE.into());
    }
    Ok(path)
}

fn begin(
    owner: PathBuf,
    conversation_id: &str,
    workdir: &str,
    capture: bool,
) -> Result<Option<Uuid>, String> {
    let Some(repo) = discover_repo(workdir)? else {
        return Ok(None);
    };
    let workdir = fs::canonicalize(workdir).map_err(|error| error.to_string())?;
    let store = review_path(&owner, conversation_id, &workdir)?;
    let id = Uuid::new_v4();
    let overlapped = {
        let mut pending = PENDING.lock().map_err(|_| UNAVAILABLE)?;
        pending.retain(|_, item| item.started.elapsed() < MAX_SNAPSHOT_AGE);
        if pending.len() >= 32 {
            return Err(UNAVAILABLE.into());
        }
        let mut overlapped = false;
        for item in pending.values_mut().filter(|item| item.repo == repo) {
            item.overlapped = true;
            overlapped = true;
        }
        pending.insert(
            id,
            Pending {
                owner,
                store,
                repo: repo.clone(),
                started: Instant::now(),
                overlapped,
                baseline: None,
            },
        );
        overlapped
    };
    if capture && !overlapped {
        let snapshot = Snapshot::new(repo, &workdir).ok();
        if let Some(item) = PENDING.lock().map_err(|_| UNAVAILABLE)?.get_mut(&id) {
            item.baseline = snapshot;
        }
    }
    Ok(Some(id))
}

fn finish(owner: &Path, id: Uuid, completed: Option<bool>) -> Result<(), String> {
    let baseline = {
        let mut pending = PENDING.lock().map_err(|_| UNAVAILABLE)?;
        let Some(item) = pending.get_mut(&id).filter(|item| item.owner == owner) else {
            return Ok(());
        };
        if completed.is_none() {
            pending.remove(&id);
            return Ok(());
        }
        item.baseline
            .take()
            .filter(|_| completed == Some(true) && !item.overlapped)
    };
    let diff = baseline.and_then(|snapshot| snapshot.finish(id).ok());
    let mut pending = PENDING.lock().map_err(|_| UNAVAILABLE)?;
    let Some(item) = pending.remove(&id) else {
        return Ok(());
    };
    let parent = review_directory(owner, item.store.parent().ok_or(UNAVAILABLE)?, true)?;
    let target = parent.join(item.store.file_name().ok_or(UNAVAILABLE)?);
    let mut temporary = NamedTempFile::new_in(&parent).map_err(|e| e.to_string())?;
    let (mut snapshot, previews) = match diff.filter(|_| !item.overlapped) {
        Some((snapshot, previews)) => (Some(snapshot), Some(previews)),
        None => (None, None),
    };
    let mut bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_STORED_REVIEW_BYTES
        && snapshot
            .as_mut()
            .is_some_and(|snapshot| snapshot.whitespace_patch.take().is_some())
    {
        bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    }
    if bytes.len() > MAX_STORED_REVIEW_BYTES {
        if let Some(snapshot) = &mut snapshot {
            snapshot.full_patch = None;
        }
        bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    }
    temporary.write_all(&bytes).map_err(|e| e.to_string())?;
    let preview_target = target.with_extension("previews.json");
    let written = previews
        .filter(|previews| !previews.files.is_empty())
        .and_then(|previews| serde_json::to_vec(&previews).ok())
        .filter(|bytes| bytes.len() <= MAX_STORED_PREVIEW_BYTES)
        .and_then(|bytes| {
            let mut file = NamedTempFile::new_in(&parent).ok()?;
            file.write_all(&bytes).ok()?;
            file.persist(&preview_target).ok()
        })
        .is_some();
    if !written {
        let _ = fs::remove_file(&preview_target);
    }
    temporary.persist(&target).map_err(|e| e.to_string())?;
    Ok(())
}

fn stored_review(
    owner: &Path,
    conversation_id: &str,
    workdir: &str,
) -> Result<(ReviewSnapshot, PathBuf), String> {
    let workdir = fs::canonicalize(workdir).map_err(|_| UNAVAILABLE)?;
    let stored = review_path(owner, conversation_id, &workdir)?;
    let directory = review_directory(owner, stored.parent().ok_or(UNAVAILABLE)?, false)?;
    let target = directory.join(stored.file_name().ok_or(UNAVAILABLE)?);
    let stored = read_bounded_file(&target, MAX_STORED_REVIEW_BYTES)?;
    let snapshot: ReviewSnapshot = serde_json::from_slice::<Option<_>>(&stored)
        .map_err(|_| UNAVAILABLE)?
        .ok_or(UNAVAILABLE)?;
    Ok((snapshot, target))
}

fn read_bounded_file(target: &Path, max: usize) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(target).map_err(|_| UNAVAILABLE)?;
    if !meta.is_file() || meta.len() > max as u64 {
        return Err(UNAVAILABLE.into());
    }
    let file = fs::File::open(target).map_err(|_| UNAVAILABLE)?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() > max {
        return Err(UNAVAILABLE.into());
    }
    Ok(bytes)
}

pub(super) fn read_preview(
    owner: &Path,
    conversation_id: &str,
    workdir: &str,
    path: &str,
    snapshot_id: Uuid,
) -> Result<RevisionPreview, String> {
    let (snapshot, target) = stored_review(owner, conversation_id, workdir)?;
    if snapshot.diff.snapshot_id != Some(snapshot_id)
        || !snapshot
            .diff
            .changes
            .iter()
            .any(|change| change.path == path)
    {
        return Err(UNAVAILABLE.into());
    }
    let bytes = read_bounded_file(
        &target.with_extension("previews.json"),
        MAX_STORED_PREVIEW_BYTES,
    )?;
    let mut previews: ReviewPreviews = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    if previews.snapshot_id != snapshot_id {
        return Err(UNAVAILABLE.into());
    }
    previews
        .files
        .remove(path)
        .ok_or_else(|| UNAVAILABLE.into())
}

fn read(
    owner: &Path,
    conversation_id: &str,
    workdir: &str,
    path: Option<String>,
    options: GitReviewDiffOptions,
) -> Result<GitDiffResponse, String> {
    let (snapshot, _) = stored_review(owner, conversation_id, workdir)?;
    let mut response = snapshot.diff;
    if options.full_context {
        if path.is_none() || options.hide_whitespace {
            return Err(UNAVAILABLE.into());
        }
        response.patch = snapshot.full_patch.ok_or(UNAVAILABLE)?;
    }
    if options.hide_whitespace && !response.changes.is_empty() {
        let filtered = snapshot
            .whitespace_patch
            .ok_or("The frozen diff has no whitespace-filtered snapshot.")?;
        response.patch = filtered.patch;
        response.changes = response
            .changes
            .into_iter()
            .enumerate()
            .filter_map(|(index, change)| {
                filtered.visible_indices.contains(&index).then_some(change)
            })
            .collect();
        response.files = response
            .changes
            .iter()
            .map(|change| change.path.clone())
            .collect();
    }
    let Some(path) = path.filter(|_| !response.changes.is_empty()) else {
        return Ok(response);
    };
    let path = validate_repo_relative_path(&path)?;
    let patches: Vec<_> = response
        .patch
        .split_inclusive("\ndiff --git ")
        .enumerate()
        .map(|(index, part)| {
            let prefix = if index == 0 { "" } else { "diff --git " };
            format!(
                "{prefix}{}",
                part.strip_suffix("diff --git ").unwrap_or(part)
            )
        })
        .collect();
    if patches.len() != response.changes.len() {
        return Err(UNAVAILABLE.into());
    }
    response.patch = response
        .changes
        .iter()
        .zip(patches)
        .filter(|(change, _)| change.path == path || change.old_path.as_deref() == Some(&path))
        .map(|(_, patch)| patch)
        .collect();
    response
        .changes
        .retain(|change| change.path == path || change.old_path.as_deref() == Some(&path));
    response.files = response
        .changes
        .iter()
        .map(|change| change.path.clone())
        .collect();
    Ok(response)
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TurnReviewRequest {
    Begin {
        conversation_id: String,
        workdir: String,
        capture: bool,
    },
    Finish {
        id: Uuid,
        completed: bool,
    },
    Discard {
        id: Uuid,
    },
    Read {
        conversation_id: String,
        workdir: String,
        path: Option<String>,
        full_context: Option<bool>,
        hide_whitespace: Option<bool>,
    },
}

#[tauri::command]
pub async fn git_workspace_turn_review(
    state: tauri::State<'_, Arc<KBrainBackendState>>,
    request: TurnReviewRequest,
) -> Result<serde_json::Value, String> {
    if !state.allows_profile_commands() {
        return Err(UNAVAILABLE.into());
    }
    let owner = state.configuration_root()?;
    let backend = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if !backend.allows_profile_commands() || backend.configuration_root()? != owner {
            return Err(UNAVAILABLE.into());
        }
        let result = match request {
            TurnReviewRequest::Begin {
                conversation_id,
                workdir,
                capture,
            } => serde_json::to_value(begin(owner.clone(), &conversation_id, &workdir, capture)?),
            TurnReviewRequest::Finish { id, completed } => {
                serde_json::to_value(finish(&owner, id, Some(completed))?)
            }
            TurnReviewRequest::Discard { id } => serde_json::to_value(finish(&owner, id, None)?),
            TurnReviewRequest::Read {
                conversation_id,
                workdir,
                path,
                full_context,
                hide_whitespace,
            } => serde_json::to_value(read(
                &owner,
                &conversation_id,
                &workdir,
                path,
                GitReviewDiffOptions {
                    full_context: full_context.unwrap_or_default(),
                    hide_whitespace: hide_whitespace.unwrap_or_default(),
                },
            )?),
        };
        if !backend.allows_profile_commands() || backend.configuration_root()? != owner {
            return Err(UNAVAILABLE.into());
        }
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn git_revision_preview_freezes_last_turn_objects_by_conversation_and_account() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repository = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let foreign_profile = tempfile::tempdir().unwrap();
        let workdir = repository.path().to_str().unwrap();
        let path = repository.path().join("report.pdf");
        let owner = profile.path();
        git_success(workdir, &["init", "-b", "main"]).unwrap();
        let original = b"%PDF-1.7\noriginal";
        let revised = b"%PDF-1.7\nrevised during turn";
        fs::write(&path, original).unwrap();
        git_success(workdir, &["add", "report.pdf"]).unwrap();
        git_success(
            workdir,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "--no-gpg-sign",
                "-m",
                "initial",
            ],
        )
        .unwrap();
        let index = repository.path().join(".git/index");
        let index_before = fs::read(&index).unwrap();
        let capture = begin(owner.to_path_buf(), "owner-conversation", workdir, true)
            .unwrap()
            .unwrap();
        fs::write(&path, revised).unwrap();
        finish(owner, capture, Some(true)).unwrap();
        assert_eq!(fs::read(index).unwrap(), index_before);
        let diff = read(
            owner,
            "owner-conversation",
            workdir,
            None,
            GitReviewDiffOptions::default(),
        )
        .unwrap();
        assert_eq!(diff.snapshot_id, Some(capture));
        fs::remove_file(&path).unwrap();
        let preview =
            read_preview(owner, "owner-conversation", workdir, "report.pdf", capture).unwrap();
        let preview = serde_json::to_value(preview).unwrap();
        assert_eq!(
            STANDARD
                .decode(preview["before"]["base64"].as_str().unwrap())
                .unwrap(),
            original
        );
        assert_eq!(
            STANDARD
                .decode(preview["after"]["base64"].as_str().unwrap())
                .unwrap(),
            revised
        );
        assert!(read_preview(
            foreign_profile.path(),
            "owner-conversation",
            workdir,
            "report.pdf",
            capture
        )
        .is_err());
        assert!(read_preview(owner, "other-conversation", workdir, "report.pdf", capture).is_err());
        let next = begin(owner.to_path_buf(), "owner-conversation", workdir, true)
            .unwrap()
            .unwrap();
        fs::write(&path, original).unwrap();
        finish(owner, next, Some(true)).unwrap();
        assert!(read_preview(owner, "owner-conversation", workdir, "report.pdf", capture).is_err());
    }

    #[test]
    fn workspace_turn_review_preserves_prior_dirt_and_freezes_the_scoped_patch() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repository = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let other_profile = tempfile::tempdir().unwrap();
        let root = repository.path().to_str().unwrap();
        let workdir = repository.path().join("src");
        fs::create_dir(&workdir).unwrap();
        git_success(root, &["init", "-b", "main"]).unwrap();
        fs::write(workdir.join("edit.txt"), "committed\n").unwrap();
        fs::write(workdir.join("spacing.txt"), "same text\n").unwrap();
        fs::write(workdir.join("deleted.txt"), "to remove\n").unwrap();
        fs::write(repository.path().join("outside.txt"), "outside before\n").unwrap();
        git_success(root, &["add", "."]).unwrap();
        git_success(
            root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "--no-gpg-sign",
                "-m",
                "initial",
            ],
        )
        .unwrap();
        fs::write(workdir.join("edit.txt"), "staged before\n").unwrap();
        git_success(root, &["add", "src/edit.txt"]).unwrap();
        fs::write(
            workdir.join("edit.txt"),
            "worktree before\nconst count = 1;\n",
        )
        .unwrap();
        fs::write(workdir.join("keep.txt"), "existing untracked\n").unwrap();
        fs::write(workdir.join("stage-only.txt"), "stage only\n").unwrap();
        git_success(root, &["add", "src/stage-only.txt"]).unwrap();
        fs::remove_file(workdir.join("stage-only.txt")).unwrap();
        let index_path = repository.path().join(".git").join("index");
        let index_before = fs::read(&index_path).unwrap();

        let workdir_str = workdir.to_str().unwrap();
        let owner = profile.path();
        let id = begin(owner.to_path_buf(), "conversation-a", workdir_str, true)
            .unwrap()
            .unwrap();
        assert!(PENDING.lock().unwrap().get(&id).unwrap().baseline.is_some());
        fs::write(workdir.join("edit.txt"), "worktree after\nconst count=1;\n").unwrap();
        fs::write(workdir.join("spacing.txt"), "same   text\n").unwrap();
        fs::remove_file(workdir.join("deleted.txt")).unwrap();
        fs::write(workdir.join("new.txt"), "created in turn\n").unwrap();
        fs::write(repository.path().join("outside.txt"), "outside after\n").unwrap();
        finish(owner, id, Some(true)).unwrap();
        assert_eq!(fs::read(index_path).unwrap(), index_before);

        fs::write(workdir.join("edit.txt"), "after snapshot\n").unwrap();
        let diff = read(
            owner,
            "conversation-a",
            workdir_str,
            None,
            GitReviewDiffOptions::default(),
        )
        .unwrap();
        assert_eq!(
            diff.files,
            [
                "src/deleted.txt",
                "src/edit.txt",
                "src/new.txt",
                "src/spacing.txt"
            ]
        );
        assert!(diff.patch.contains("-worktree before"));
        assert!(diff.patch.contains("+worktree after"));
        assert!(!diff.patch.contains("after snapshot"));
        assert!(!diff.patch.contains("staged before"));
        let single = read(
            owner,
            "conversation-a",
            workdir_str,
            Some("src/new.txt".into()),
            GitReviewDiffOptions::default(),
        )
        .unwrap();
        assert_eq!(single.files, ["src/new.txt"]);
        assert!(single
            .patch
            .starts_with("diff --git a/src/new.txt b/src/new.txt"));
        assert!(!single.patch.contains("edit.txt"));
        let full = read(
            owner,
            "conversation-a",
            workdir_str,
            Some("src/edit.txt".into()),
            GitReviewDiffOptions {
                full_context: true,
                hide_whitespace: false,
            },
        )
        .unwrap();
        assert!(full.patch.contains("+worktree after"));
        assert!(!full.patch.contains("after snapshot"));
        let filtered = read(
            owner,
            "conversation-a",
            workdir_str,
            Some("src/edit.txt".into()),
            GitReviewDiffOptions {
                full_context: false,
                hide_whitespace: true,
            },
        )
        .unwrap();
        assert_eq!(filtered.files, ["src/edit.txt"]);
        assert!(filtered.patch.contains("+worktree after"));
        assert!(!filtered.patch.contains("+const count"));
        assert!(!filtered.patch.contains("after snapshot"));
        let spacing = read(
            owner,
            "conversation-a",
            workdir_str,
            Some("src/spacing.txt".into()),
            GitReviewDiffOptions {
                full_context: false,
                hide_whitespace: true,
            },
        )
        .unwrap();
        assert!(spacing.patch.is_empty());
        assert!(spacing.files.is_empty());
        assert!(read(
            other_profile.path(),
            "conversation-a",
            workdir_str,
            None,
            GitReviewDiffOptions::default(),
        )
        .is_err());
        assert!(read(
            owner,
            "conversation-b",
            workdir_str,
            None,
            GitReviewDiffOptions::default()
        )
        .is_err());
    }
}
