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
            .join("kbrain")
    }

    pub fn settings_dir(&self, data_root: &Path) -> PathBuf {
        self.backend_dir(data_root).with_file_name("settings")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
