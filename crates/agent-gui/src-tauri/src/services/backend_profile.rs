use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// A storage namespace, never an authorization credential. Account scope is supplied only after
/// USA-Zero's authenticated current-user response; Gateway independently checks every remote lease.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum BackendProfile {
    #[default]
    Local,
    Account(String),
}

impl BackendProfile {
    pub fn from_account_scope(scope: Option<&str>) -> Result<Self, String> {
        let Some(scope) = scope else {
            return Ok(Self::Local);
        };
        if scope.is_empty()
            || scope.len() > 512
            || scope.trim() != scope
            || scope.chars().any(char::is_control)
        {
            return Err("Invalid ZeroAgent account storage scope".into());
        }
        let digest = Sha256::digest(scope.as_bytes());
        let id: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self::Account(id))
    }

    pub fn backend_dir(&self, app_data: &Path) -> PathBuf {
        let profile = match self {
            Self::Local => "local".to_string(),
            Self::Account(id) => format!("account-{id}"),
        };
        app_data
            .join("runtime-v2")
            .join("profiles")
            .join(profile)
            .join("engine")
    }

    pub fn settings_dir(&self, data_root: &Path) -> PathBuf {
        self.backend_dir(data_root).with_file_name("settings")
    }
}

/// Adopt only the current ZeroAgent v2 profile layout, before opening its stores.
/// Never scan legacy product homes, merge directories, or overwrite a destination.
fn is_current_engine_directory(destination: &Path) -> bool {
    let Some(profile) = destination.parent() else {
        return false;
    };
    let Some(profiles) = profile.parent() else {
        return false;
    };
    let Some(runtime) = profiles.parent() else {
        return false;
    };
    let name = profile
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let account = name
        .strip_prefix("account-")
        .is_some_and(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()));
    destination.file_name().is_some_and(|name| name == "engine")
        && profiles.file_name().is_some_and(|name| name == "profiles")
        && runtime.file_name().is_some_and(|name| name == "runtime-v2")
        && (name == "local" || account)
}

// Keep the established opaque identity when a v2 profile directory is renamed.
// Browser drafts, history mappings and credential bindings must not get a new scope.
pub(crate) fn storage_identity_path(canonical: &Path) -> PathBuf {
    if is_current_engine_directory(canonical) {
        canonical.with_file_name("kbrain")
    } else {
        canonical.to_path_buf()
    }
}

pub(crate) fn prepare_backend_directory(destination: &Path) -> Result<(), String> {
    if !is_current_engine_directory(destination) {
        return Ok(());
    }
    let profile = destination
        .parent()
        .ok_or("Missing ZeroAgent profile directory")?;
    let profiles = profile
        .parent()
        .ok_or("Missing ZeroAgent profiles directory")?;
    let runtime = profiles
        .parent()
        .ok_or("Missing ZeroAgent runtime directory")?;
    let source = profile.join("kbrain");
    let inspect = |path: &Path| -> Result<bool, String> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse || !metadata.is_dir() {
                    return Err("ZeroAgent data directory must be a real directory".into());
                }
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Unable to inspect ZeroAgent data directory: {error}"
            )),
        }
    };
    for ancestor in [runtime, profiles, profile] {
        inspect(ancestor)?;
    }
    let old_exists = inspect(&source)?;
    let new_exists = inspect(destination)?;
    if old_exists && new_exists {
        return Err("ZeroAgent data directory conflict: both engine and previous profile data exist; no data was changed".into());
    }
    if old_exists {
        std::fs::rename(&source, destination).map_err(|error| {
            format!("Unable to rename ZeroAgent profile data; previous data was retained: {error}")
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_profile_rename_preserves_data_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let profile =
            BackendProfile::from_account_scope(Some("https://usa0.top|user:rename")).unwrap();
        let destination = profile.backend_dir(temp.path());
        let source = destination.with_file_name("kbrain");
        std::fs::create_dir_all(source.join("imaging")).unwrap();
        std::fs::write(
            source.join("imaging/transactions.wal"),
            b"existing image receipt",
        )
        .unwrap();
        std::fs::write(source.join("config.json"), b"existing configuration").unwrap();
        let identity_before = source.canonicalize().unwrap();
        prepare_backend_directory(&destination).unwrap();
        prepare_backend_directory(&destination).unwrap();
        assert!(!source.exists());
        assert_eq!(
            storage_identity_path(&destination.canonicalize().unwrap()),
            identity_before
        );
        assert_eq!(
            std::fs::read(destination.join("imaging/transactions.wal")).unwrap(),
            b"existing image receipt"
        );
        assert_eq!(
            std::fs::read(destination.join("config.json")).unwrap(),
            b"existing configuration"
        );
        assert!(!BackendProfile::Local.backend_dir(temp.path()).exists());
    }

    #[test]
    fn conflicting_profile_directories_are_never_merged_or_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let destination = BackendProfile::Local.backend_dir(temp.path());
        let source = destination.with_file_name("kbrain");
        for dir in [&source, &destination] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(source.join("keep"), b"old").unwrap();
        std::fs::write(destination.join("keep"), b"new").unwrap();
        assert!(prepare_backend_directory(&destination)
            .unwrap_err()
            .contains("conflict"));
        assert_eq!(std::fs::read(source.join("keep")).unwrap(), b"old");
        assert_eq!(std::fs::read(destination.join("keep")).unwrap(), b"new");
    }

    #[test]
    fn unrelated_engine_directories_are_not_adopted() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("kbrain");
        std::fs::create_dir_all(&source).unwrap();
        prepare_backend_directory(&temp.path().join("engine")).unwrap();
        assert!(source.exists());
    }

    #[test]
    fn profiles_are_stable_and_separate_accounts_origins_and_offline_data() {
        let root = std::env::temp_dir().join("zeroagent-profile-test");
        let a = BackendProfile::from_account_scope(Some("https://usa0.top|user:1")).unwrap();
        assert_eq!(
            a,
            BackendProfile::from_account_scope(Some("https://usa0.top|user:1")).unwrap()
        );
        let roots = [
            BackendProfile::Local.backend_dir(&root),
            a.backend_dir(&root),
            BackendProfile::from_account_scope(Some("https://usa0.top|user:2"))
                .unwrap()
                .backend_dir(&root),
            BackendProfile::from_account_scope(Some("https://other.example|user:1"))
                .unwrap()
                .backend_dir(&root),
        ];
        for (index, candidate) in roots.iter().enumerate() {
            assert!(candidate.starts_with(&root));
            assert!(!candidate.to_string_lossy().contains("usa0.top"));
            for other in &roots[index + 1..] {
                assert_ne!(candidate, other);
            }
        }
    }

    #[test]
    fn invalid_scope_never_falls_back_to_the_local_profile() {
        for scope in [
            "".to_string(),
            " user:1".into(),
            "user:1\n".into(),
            "a".repeat(513),
        ] {
            assert!(BackendProfile::from_account_scope(Some(&scope)).is_err());
        }
        assert_eq!(
            BackendProfile::from_account_scope(None).unwrap(),
            BackendProfile::Local
        );
    }
}
