//! One configuration gate per stable backend profile. It spans HTTP configuration
//! access, Native preferences and backup collection/application/compensation.
//! Model streams, files and history never take this gate.
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

pub(crate) struct ConfigurationCoordinator {
    gate: Arc<AsyncMutex<()>>,
    nonce: String,
    changes: AtomicU64,
    mcp_changes: AtomicU64,
    uncertain: AtomicBool,
}

pub(crate) struct ConfigurationGuard {
    // Drop the mutex guard before its registry owner. A live operation must keep
    // the coordinator discoverable even when its original backend manager ends.
    _guard: OwnedMutexGuard<()>,
    _owner: Arc<ConfigurationCoordinator>,
}

impl ConfigurationCoordinator {
    pub(crate) fn for_profile(identity: &str) -> Result<Arc<Self>, String> {
        if identity.is_empty() {
            return Err("Configuration profile identity is unavailable".into());
        }
        static REGISTRY: OnceLock<Mutex<HashMap<String, Weak<ConfigurationCoordinator>>>> =
            OnceLock::new();
        let mut registry = REGISTRY
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "Configuration coordinator is unavailable")?;
        registry.retain(|_, entry| entry.strong_count() > 0);
        if let Some(coordinator) = registry.get(identity).and_then(Weak::upgrade) {
            return Ok(coordinator);
        }
        let coordinator = Arc::new(Self {
            gate: Arc::new(AsyncMutex::new(())),
            nonce: uuid::Uuid::new_v4().simple().to_string(),
            changes: AtomicU64::new(0),
            mcp_changes: AtomicU64::new(0),
            uncertain: AtomicBool::new(false),
        });
        registry.insert(identity.to_owned(), Arc::downgrade(&coordinator));
        Ok(coordinator)
    }

    pub(crate) async fn lock(self: &Arc<Self>) -> ConfigurationGuard {
        ConfigurationGuard {
            _guard: Arc::clone(&self.gate).lock_owned().await,
            _owner: Arc::clone(self),
        }
    }

    /// Call only from a blocking Native worker, never a Tokio runtime thread.
    pub(crate) fn blocking_lock(self: &Arc<Self>) -> ConfigurationGuard {
        ConfigurationGuard {
            _guard: Arc::clone(&self.gate).blocking_lock_owned(),
            _owner: Arc::clone(self),
        }
    }

    /// Call under the profile gate. Even a rejected mutation invalidates an old
    /// read rather than treating a lost/failed response as proof of no change.
    pub(crate) fn changed(&self) {
        self.changes.fetch_add(1, Ordering::SeqCst);
    }

    /// Native OAuth waits outside the configuration gate. Even an MCP edit later
    /// reverted to its old value must invalidate a pending authorization.
    pub(crate) fn mcp_changed(&self) {
        self.mcp_changes.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn mcp_revision(&self) -> u64 {
        self.mcp_changes.load(Ordering::SeqCst)
    }

    pub(crate) fn uncertain_commit(&self) {
        self.uncertain.store(true, Ordering::SeqCst);
    }

    pub(crate) fn ensure_consistent(&self) -> Result<(), String> {
        if self.uncertain.load(Ordering::SeqCst) {
            Err("配置保存结果待确认，请重启客户端并核对当前配置".into())
        } else {
            Ok(())
        }
    }

    /// Material is the document actually read, never a renderer's cached value.
    pub(crate) fn version(&self, material: &serde_json::Value) -> Result<String, String> {
        let bytes = serde_json::to_vec(material).map_err(|_| "无法校验配置快照")?;
        let digest = Sha256::digest(bytes);
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(format!(
            "za-config-v1-{}-{}-{hex}",
            self.nonce,
            self.changes.load(Ordering::SeqCst)
        ))
    }
}

/// Endpoints owning configuration in a canonical snapshot. Template expansion is
/// an operation on content, rather than a configuration edit.
pub(crate) fn configuration_route(path: &str) -> bool {
    matches!(path, "/v1/skills" | "/v1/skills/settings")
        || path == "/v1/configuration"
        || path == "/v1/settings"
        || (path.starts_with("/v1/settings/") && !path.ends_with("/models"))
        || path == "/v1/mcp"
        || (path.starts_with("/v1/mcp/")
            && !path.starts_with("/v1/mcp/tools")
            && path != "/v1/mcp/search")
        || ((path == "/v1/prompts" || path.starts_with("/v1/prompts/"))
            && !path.ends_with("/expand"))
        || path == "/v1/network/proxy"
}

// Both direct configuration services and transport-only fixtures share the gate.
pub(crate) fn configuration_gate_route(path: &str) -> bool {
    configuration_route(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[tokio::test]
    async fn native_blocking_and_http_async_writers_share_one_profile_gate() {
        let id = uuid::Uuid::new_v4().to_string();
        let native = ConfigurationCoordinator::for_profile(&id).unwrap();
        let http = ConfigurationCoordinator::for_profile(&id).unwrap();
        assert!(Arc::ptr_eq(&native, &http));
        let guard = native.lock().await;
        let (sent, received) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = http.blocking_lock();
            sent.send(()).unwrap();
        });
        assert!(received.recv_timeout(Duration::from_millis(50)).is_err());
        drop(guard);
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn a_live_operation_keeps_the_same_gate_across_manager_replacement() {
        let id = uuid::Uuid::new_v4().to_string();
        let original = ConfigurationCoordinator::for_profile(&id).unwrap();
        let guard = original.lock().await;
        drop(original);
        let replacement = ConfigurationCoordinator::for_profile(&id).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), replacement.lock())
                .await
                .is_err()
        );
        drop(guard);
        let _guard = tokio::time::timeout(Duration::from_secs(1), replacement.lock())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn distinct_profiles_do_not_block_each_other() {
        let a = ConfigurationCoordinator::for_profile(&uuid::Uuid::new_v4().to_string()).unwrap();
        let b = ConfigurationCoordinator::for_profile(&uuid::Uuid::new_v4().to_string()).unwrap();
        let _a = a.lock().await;
        let _b = tokio::time::timeout(Duration::from_millis(100), b.lock())
            .await
            .unwrap();
    }

    #[test]
    fn gate_covers_configuration_aliases_without_claiming_model_or_file_streams() {
        for path in [
            "/v1/settings",
            "/v1/settings/providers/a",
            "/v1/mcp",
            "/v1/mcp/servers/a/auth",
            "/v1/prompts/templates",
            "/v1/prompts/project",
        ] {
            assert!(configuration_route(path), "{path}");
        }
        for path in [
            "/v1/sessions/s/events",
            "/v1/prompts/templates/a/expand",
            "/v1/files/download",
            "/v1/history",
            "/v1/mcp/tools",
            "/v1/mcp/tools/call",
            "/v1/mcp/search",
            "/v1/settings/providers/p/models",
        ] {
            assert!(!configuration_route(path), "{path}");
        }
    }
    #[test]
    fn snapshot_versions_detect_aba_and_namespace_restarts_and_profiles() {
        let id = uuid::Uuid::new_v4().to_string();
        let a = ConfigurationCoordinator::for_profile(&id).unwrap();
        let first = a.version(&serde_json::json!({"value":1})).unwrap();
        a.changed();
        a.changed();
        let returned = a.version(&serde_json::json!({"value":1})).unwrap();
        assert_ne!(first, returned);
        assert_ne!(
            returned,
            a.version(&serde_json::json!({"value":2})).unwrap()
        );
        let other =
            ConfigurationCoordinator::for_profile(&uuid::Uuid::new_v4().to_string()).unwrap();
        assert_ne!(
            returned,
            other.version(&serde_json::json!({"value":1})).unwrap()
        );
        a.uncertain_commit();
        assert!(a.ensure_consistent().is_err());
        drop(a);
        let restarted = ConfigurationCoordinator::for_profile(&id).unwrap();
        assert!(restarted.ensure_consistent().is_ok());
        assert_ne!(
            first,
            restarted.version(&serde_json::json!({"value":1})).unwrap()
        );
    }

    #[test]
    fn skill_settings_share_the_gate_without_capturing_skill_tools_and_files() {
        assert!(configuration_gate_route("/v1/skills"));
        assert!(configuration_gate_route("/v1/skills/settings"));
        assert!(configuration_route("/v1/skills/settings"));
        assert!(!configuration_gate_route("/v1/skills/manage"));
        assert!(!configuration_gate_route("/v1/skills/file"));
    }
}
