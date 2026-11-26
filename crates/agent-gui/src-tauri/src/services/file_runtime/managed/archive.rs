use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::{Failure, TARGET};

const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 60_000;
const MAX_FILE_BYTES: u64 = 768 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MANIFEST_NAME: &str = "runtime.json";

#[derive(Deserialize)]
struct FilesManifest {
    format: u32,
    target: String,
    files: BTreeMap<String, String>,
}

fn reserved_windows_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default();
    let stem = stem.trim_end_matches(' ').to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "aux" | "con" | "nul" | "prn" | "clock$" | "conin$" | "conout$"
    ) || ["com", "lpt"].iter().any(|prefix| {
        stem.strip_prefix(*prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

fn relative_path(name: &str) -> Result<PathBuf, Failure> {
    let mut result = PathBuf::new();
    if name.len() > 2048 {
        return Err(Failure::ArchiveInvalid);
    }
    for component in name.split('/') {
        if component.is_empty()
            || component.ends_with(['.', ' '])
            || component.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
            || component.chars().any(char::is_control)
            || component.encode_utf16().count() > 255
            || component.to_ascii_lowercase().contains("licensee")
            || reserved_windows_name(component)
        {
            return Err(Failure::ArchiveInvalid);
        }
        result.push(component);
    }
    Ok(result)
}

pub(super) fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 15) as usize] as char);
    }
    result
}

struct HashWriter<W> {
    inner: W,
    digest: Sha256,
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(data)?;
        self.digest.update(&data[..count]);
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub(super) fn checked_zip(
    mut file: File,
    bytes: u64,
    digest: &str,
) -> Result<ZipArchive<File>, Failure> {
    let mut sink = HashWriter {
        inner: io::sink(),
        digest: Sha256::new(),
    };
    let length = io::copy(&mut (&mut file).take(bytes + 1), &mut sink)
        .map_err(|_| Failure::StorageUnavailable)?;
    if length != bytes || hex_digest(&sink.digest.finalize()) != digest {
        return Err(Failure::ArchiveInvalid);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| Failure::StorageUnavailable)?;
    ZipArchive::new(file).map_err(|_| Failure::ArchiveInvalid)
}

/// Inspect the complete directory and inventory before opening member contents.
/// Extraction takes place in a newly created staging directory.
pub(super) fn extract(
    mut archive: ZipArchive<File>,
    destination: &Path,
) -> Result<String, Failure> {
    if archive.len() > MAX_ENTRIES
        || archive.file_names().any(|name| {
            name.trim_end_matches('/')
                .split('/')
                .any(|part| part.to_ascii_lowercase().contains("licensee"))
        })
    {
        return Err(Failure::ArchiveInvalid);
    }
    let mut expanded = 0u64;
    let mut identities = HashSet::new();
    let mut files = BTreeMap::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| Failure::ArchiveInvalid)?;
        let name = entry.name();
        let is_directory = entry.is_dir();
        relative_path(if is_directory {
            name.strip_suffix('/').ok_or(Failure::ArchiveInvalid)?
        } else {
            name
        })?;
        if entry.is_symlink()
            || entry.unix_mode().is_some_and(|mode| {
                let kind = mode & 0o170000;
                kind != 0 && kind != if is_directory { 0o040000 } else { 0o100000 }
            })
            || !identities.insert(name.trim_end_matches('/').to_lowercase())
            || entry.size() > MAX_FILE_BYTES
        {
            return Err(Failure::ArchiveInvalid);
        }
        expanded += entry.size();
        if expanded > MAX_EXPANDED_BYTES {
            return Err(Failure::ArchiveInvalid);
        }
        if !is_directory {
            files.insert(name.to_owned(), (index, entry.size(), entry.unix_mode()));
        }
    }
    let (manifest_index, size, _) = files.remove(MANIFEST_NAME).ok_or(Failure::ArchiveInvalid)?;
    if size > MAX_MANIFEST_BYTES {
        return Err(Failure::ArchiveInvalid);
    }
    let mut manifest_bytes = Vec::with_capacity(size as usize);
    archive
        .by_index(manifest_index)
        .map_err(|_| Failure::ArchiveInvalid)?
        .take(size + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|_| Failure::ArchiveInvalid)?;
    if manifest_bytes.len() as u64 != size {
        return Err(Failure::ArchiveInvalid);
    }
    let manifest: FilesManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| Failure::ArchiveInvalid)?;
    if manifest.format != 1 || manifest.target != TARGET || manifest.files.len() != files.len() {
        return Err(Failure::ArchiveInvalid);
    }
    for (name, digest) in &manifest.files {
        relative_path(name)?;
        if !is_sha256(digest) || !files.contains_key(name) {
            return Err(Failure::ArchiveInvalid);
        }
    }

    for (name, (index, size, mode)) in files {
        let path = destination.join(relative_path(&name)?);
        fs::create_dir_all(path.parent().ok_or(Failure::ArchiveInvalid)?)
            .map_err(|_| Failure::StorageUnavailable)?;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    Failure::ArchiveInvalid
                } else {
                    Failure::StorageUnavailable
                }
            })?;
        let mut writer = HashWriter {
            inner: file,
            digest: Sha256::new(),
        };
        let mut data = archive
            .by_index(index)
            .map_err(|_| Failure::ArchiveInvalid)?
            .take(size + 1);
        let count = io::copy(&mut data, &mut writer).map_err(|_| Failure::ArchiveInvalid)?;
        if count != size || hex_digest(&writer.digest.finalize()) != manifest.files[&name] {
            return Err(Failure::ArchiveInvalid);
        }
        #[cfg(unix)]
        {
            let permissions = if mode.is_some_and(|mode| mode & 0o111 != 0) {
                0o700
            } else {
                0o600
            };
            writer
                .inner
                .set_permissions(fs::Permissions::from_mode(permissions))
                .map_err(|_| Failure::StorageUnavailable)?;
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination.join(MANIFEST_NAME))
        .and_then(|mut output| output.write_all(&manifest_bytes))
        .map_err(|_| Failure::StorageUnavailable)?;
    Ok(sha256(&manifest_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn fixture(payload: &[(&str, &[u8])], file_map: serde_json::Value) -> File {
        let mut writer = ZipWriter::new(tempfile::tempfile().unwrap());
        let options = SimpleFileOptions::default();
        writer.start_file(MANIFEST_NAME, options).unwrap();
        writer
            .write_all(
                &serde_json::to_vec(
                    &serde_json::json!({"format":1, "target": TARGET, "files": file_map}),
                )
                .unwrap(),
            )
            .unwrap();
        for (name, data) in payload {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        let mut file = writer.finish().unwrap();
        file.rewind().unwrap();
        file
    }

    #[test]
    fn bounded_zip_verifies_archive_and_every_member() {
        let bytes = b"synthetic tool";
        let mut fixture = fixture(
            &[("tools/example.txt", bytes)],
            serde_json::json!({
                "tools/example.txt": sha256(bytes)
            }),
        );
        let mut raw = Vec::new();
        fixture.read_to_end(&mut raw).unwrap();
        fixture.rewind().unwrap();
        let checked = checked_zip(fixture, raw.len() as u64, &sha256(&raw)).unwrap();
        let root = tempfile::tempdir().unwrap();
        extract(checked, root.path()).unwrap();
        assert_eq!(
            fs::read(root.path().join("tools/example.txt")).unwrap(),
            bytes
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_companions_restore_only_owner_executable_permissions() {
        let mut writer = ZipWriter::new(tempfile::tempfile().unwrap());
        let script = b"#!/bin/sh\nexit 0\n";
        writer
            .start_file(MANIFEST_NAME, SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(
                &serde_json::to_vec(&serde_json::json!({
                    "format": 1, "target": TARGET,
                    "files": {"bin/launch": sha256(script), "README.txt": sha256(b"read me")}
                }))
                .unwrap(),
            )
            .unwrap();
        writer
            .start_file(
                "bin/launch",
                SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer.write_all(script).unwrap();
        writer
            .start_file(
                "README.txt",
                SimpleFileOptions::default().unix_permissions(0o644),
            )
            .unwrap();
        writer.write_all(b"read me").unwrap();
        let archive = ZipArchive::new(writer.finish().unwrap()).unwrap();
        let root = tempfile::tempdir().unwrap();
        extract(archive, root.path()).unwrap();
        let permission_bits = |name| {
            fs::metadata(root.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777
        };
        assert_eq!(permission_bits("bin/launch"), 0o700);
        assert_eq!(permission_bits("README.txt"), 0o600);
    }

    #[test]
    fn undeclared_altered_or_case_aliased_files_do_not_activate() {
        let raw = b"a".as_slice();
        let map = serde_json::json!({"a.txt": sha256(raw)});
        for payload in [
            vec![("a.txt", b"b".as_slice())],
            vec![("a.txt", raw), ("extra.txt", raw)],
            vec![("a.txt", raw), ("A.txt", raw)],
        ] {
            let archive = ZipArchive::new(fixture(&payload, map.clone())).unwrap();
            let root = tempfile::tempdir().unwrap();
            assert_eq!(extract(archive, root.path()), Err(Failure::ArchiveInvalid));
            assert!(!root.path().join(MANIFEST_NAME).exists());
        }
    }

    #[test]
    fn unsafe_paths_and_links_are_rejected_before_extraction() {
        for name in [
            "tools/../escape",
            "c:/outside",
            "a\\outside",
            "/outside",
            "a//b",
            "a/CON.txt",
            "a/COM¹",
            "a/name.",
            "a/name ",
            "a/NuL",
        ] {
            assert_eq!(relative_path(name), Err(Failure::ArchiveInvalid), "{name}");
        }
        let mut writer = ZipWriter::new(tempfile::tempfile().unwrap());
        writer
            .add_symlink("tools/link", "../outside", SimpleFileOptions::default())
            .unwrap();
        let archive = ZipArchive::new(writer.finish().unwrap()).unwrap();
        let root = tempfile::tempdir().unwrap();
        assert_eq!(extract(archive, root.path()), Err(Failure::ArchiveInvalid));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
