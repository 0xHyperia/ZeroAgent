//! MCP OAuth token 存储（docs/design/mcp-oauth.md §3）。
//!
//! 凭据纪律：token/client_secret 只进 OS keystore（keyring v3），keyring 不可用
//! 时降级到当前 ZeroAgent profile 设置目录的 `mcp-oauth-tokens.json`（明文，诊断标注 `file`；Unix 上
//! chmod 0600，Windows 无此语义、依赖 `%USERPROFILE%` 默认 ACL）——
//! 永不进 settings/SQLite，Gateway 同步与 WebDAV 备份天然不含凭据。
//! Keychain IPC 有毫秒级开销，故挂进程内缓存：只在 miss/授权/刷新/清除时碰后端。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

pub const KEYRING_SERVICE: &str = "ZeroAgent MCP OAuth";
const FILE_STORE_NAME: &str = "mcp-oauth-tokens.json";
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;

/// 距过期不足该窗口即视作「将过期」，请求前主动刷新。
pub const EXPIRY_SKEW_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenRecord {
    pub version: u32,
    /// 规范化后的 MCP server URL；与当前配置不符即视为无 token（防 audience 串用）。
    pub server_url: String,
    /// Native canonical MCP target digest. Legacy records remain readable but
    /// require reauthorization before the v2 configured-target boundary can use them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_binding: Option<String>,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_endpoint: Option<String>,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// RFC 7591 注册返回值："none" | "client_secret_post" | "client_secret_basic"。
    #[serde(default)]
    pub token_endpoint_auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// RFC 8707 resource 参数值（规范化 server URL）。
    pub resource: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// 0 = 服务端未声明过期时间（不主动刷新，仅被动 401 刷新）。
    #[serde(default)]
    pub expires_at_ms: u64,
}

impl TokenRecord {
    pub fn is_expiring(&self, now_ms: u64) -> bool {
        self.expires_at_ms != 0 && now_ms.saturating_add(EXPIRY_SKEW_MS) >= self.expires_at_ms
    }

    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.expires_at_ms != 0 && now_ms >= self.expires_at_ms
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- 进程内缓存 ----

#[derive(Clone)]
enum CacheSlot {
    Present(Box<TokenRecord>, &'static str),
    Absent,
}

fn cache() -> &'static Mutex<HashMap<String, CacheSlot>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheSlot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---- keyring 后端 ----

fn scoped_token_id(profile_dir: &Path, server_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(profile_dir.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(server_id.as_bytes());
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Ok(Some)=命中 Ok(None)=确认无条目 Err=后端不可用（触发文件降级）。
fn keyring_load(entry: &keyring::Entry) -> Result<Option<TokenRecord>, String> {
    match entry.get_password() {
        Ok(raw) => {
            let record: TokenRecord = serde_json::from_str(&raw)
                .map_err(|e| format!("解析 keychain 内 MCP OAuth 记录失败：{e}"))?;
            Ok(Some(record))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 keychain 失败：{e}")),
    }
}

// ---- 文件降级后端 ----

fn load_file_map_at(path: &Path) -> Result<HashMap<String, TokenRecord>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err("读取 MCP OAuth 凭据文件失败".into()),
    };
    let mut raw = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|_| "读取 MCP OAuth 凭据文件失败")?;
    if raw.len() > MAX_FILE_BYTES {
        return Err("MCP OAuth 凭据文件过大，原文件已保留".into());
    }
    // A damaged file is not an empty store: never overwrite its other credentials.
    serde_json::from_slice(&raw).map_err(|_| "MCP OAuth 凭据文件损坏，原文件已保留".into())
}

fn save_file_map_at(path: &Path, map: &HashMap<String, TokenRecord>) -> Result<(), String> {
    if map.is_empty() {
        // 空表直接移除文件，避免留下空壳。
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("删除 MCP OAuth 凭据文件失败".into()),
        };
    }
    let payload = serde_json::to_string(map).map_err(|e| format!("序列化 token 文件失败：{e}"))?;
    if payload.len() > MAX_FILE_BYTES {
        return Err("MCP OAuth 凭据文件过大".into());
    }
    let parent = path.parent().ok_or("MCP OAuth 凭据目录无效")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "创建 MCP OAuth 临时凭据文件失败")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "设置 MCP OAuth 凭据文件权限失败")?;
    }
    temporary
        .write_all(payload.as_bytes())
        .map_err(|_| "写入 MCP OAuth 临时凭据文件失败")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "同步 MCP OAuth 凭据文件失败")?;
    temporary
        .persist(path)
        .map_err(|_| "替换 MCP OAuth 凭据文件失败")?;
    Ok(())
}

// ---- 公共 API ----

#[derive(Default)]
struct ProfileState {
    revisions: HashMap<String, u64>,
}

fn profile_state(root: &Path) -> Result<Arc<Mutex<ProfileState>>, String> {
    static PROFILES: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<ProfileState>>>>> = OnceLock::new();
    let mut profiles = PROFILES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "MCP OAuth profile 锁失败")?;
    profiles.retain(|_, state| state.strong_count() != 0);
    if let Some(state) = profiles.get(root).and_then(Weak::upgrade) {
        return Ok(state);
    }
    let state = Arc::new(Mutex::new(ProfileState::default()));
    profiles.insert(root.to_owned(), Arc::downgrade(&state));
    Ok(state)
}

/// Captured once before offloading/waiting. No method consults the active profile again.
#[derive(Clone)]
pub(crate) struct TokenStore {
    root: PathBuf,
    id: String,
    cache_id: String,
    file_only: bool,
    state: Arc<Mutex<ProfileState>>,
}

pub(crate) struct Snapshot {
    pub record: Option<TokenRecord>,
    pub storage: &'static str,
    revision: u64,
    identity: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveStage {
    NotWritten,
    PossiblyWritten,
    VaultWritten,
    DurableWritten,
}

/// Issued under the entry lock after this exact failed write. Owning the store
/// also keeps its revision state alive between otherwise independent requests.
/// No Serialize/Debug implementation: this is an in-memory retry permission.
pub(crate) struct SaveRetry {
    store: TokenStore,
    revision: u64,
    record_hash: [u8; 32],
    #[cfg(test)]
    check_hook: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub(crate) struct SaveFailure {
    pub(crate) message: String,
    pub(crate) retry: Option<SaveRetry>,
    pub(crate) stage: SaveStage,
}

impl std::fmt::Debug for SaveFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpSaveFailure")
            .field("message", &self.message)
            .field("retryable", &self.retry.is_some())
            .field("stage", &self.stage)
            .finish()
    }
}

impl SaveFailure {
    fn rejected(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retry: None,
            stage: SaveStage::NotWritten,
        }
    }
}

impl SaveRetry {
    pub(crate) fn is_current(&self) -> bool {
        #[cfg(test)]
        if let Some(hook) = &self.check_hook {
            hook();
        }
        self.store
            .state
            .lock()
            .map(|state| *state.revisions.get(&self.store.id).unwrap_or(&0) == self.revision)
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub(super) fn set_check_hook(&mut self, hook: Arc<dyn Fn() + Send + Sync>) {
        self.check_hook = Some(hook);
    }
}

impl TokenStore {
    pub(crate) fn capture(server_id: &str) -> Result<Self, String> {
        Self::for_profile(
            crate::commands::settings::config_dir()?,
            server_id,
            crate::runtime::data_home::isolation_requested(),
        )
    }

    pub(crate) fn for_profile(
        root: PathBuf,
        server_id: &str,
        file_only: bool,
    ) -> Result<Self, String> {
        let id = server_id.trim();
        if id.is_empty() {
            return Err("server_id 不能为空".into());
        }
        if !root.is_absolute() {
            return Err("MCP OAuth profile 目录无效".into());
        }
        // Preserve the existing namespace byte-for-byte (including the non-canonical root).
        Ok(Self {
            cache_id: scoped_token_id(&root, id),
            state: profile_state(&root)?,
            root,
            id: id.to_owned(),
            file_only,
        })
    }

    pub(crate) fn identity(&self) -> &str {
        &self.cache_id
    }

    pub(crate) fn profile_root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn matches_target(&self, root: &Path, server_id: &str) -> bool {
        self.root == root && self.id == server_id
    }

    pub(crate) fn ensure_current_profile(&self) -> Result<(), String> {
        if crate::commands::settings::config_dir()? != self.root {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        Ok(())
    }

    fn keyring_entry(&self) -> Result<keyring::Entry, String> {
        if self.file_only {
            return Err("isolated development uses only its private file store".into());
        }
        keyring::Entry::new(KEYRING_SERVICE, &self.cache_id)
            .map_err(|_| "创建 MCP OAuth keyring 条目失败".into())
    }

    fn load_locked(&self) -> Result<(Option<TokenRecord>, &'static str), String> {
        if let Some(cached) = cache()
            .lock()
            .map_err(|_| "MCP OAuth 缓存锁失败")?
            .get(&self.cache_id)
        {
            return Ok(match cached {
                CacheSlot::Present(record, storage) => (Some((**record).clone()), *storage),
                CacheSlot::Absent => (None, "unknown"),
            });
        }
        let loaded =
            self.load_uncached(self.keyring_entry().and_then(|entry| keyring_load(&entry)))?;
        cache().lock().map_err(|_| "MCP OAuth 缓存锁失败")?.insert(
            self.cache_id.clone(),
            match &loaded.0 {
                Some(record) => CacheSlot::Present(Box::new(record.clone()), loaded.1),
                None => CacheSlot::Absent,
            },
        );
        Ok(loaded)
    }

    fn load_uncached(
        &self,
        vault: Result<Option<TokenRecord>, String>,
    ) -> Result<(Option<TokenRecord>, &'static str), String> {
        match vault {
            Ok(Some(record)) => Ok((Some(record), "keychain")),
            // A previous save may have used the private file while the vault was
            // unavailable. An empty recovered vault must not hide that record.
            Ok(None) | Err(_) => Ok((
                load_file_map_at(&self.root.join(FILE_STORE_NAME))?.remove(&self.id),
                "file",
            )),
        }
    }

    pub(crate) fn snapshot(&self) -> Result<Snapshot, String> {
        let state = self.state.lock().map_err(|_| "MCP OAuth profile 锁失败")?;
        let (record, storage) = self.load_locked()?;
        Ok(Snapshot {
            record,
            storage,
            revision: *state.revisions.get(&self.id).unwrap_or(&0),
            identity: self.cache_id.clone(),
        })
    }

    pub(crate) fn begin_authorization(&self) -> Result<Snapshot, String> {
        let mut state = self.state.lock().map_err(|_| "MCP OAuth profile 锁失败")?;
        let revision = state.revisions.entry(self.id.clone()).or_default();
        *revision = revision
            .checked_add(1)
            .ok_or("MCP_OAUTH_OPERATION_SUPERSEDED")?;
        let (record, storage) = self.load_locked()?;
        Ok(Snapshot {
            record,
            storage,
            revision: *revision,
            identity: self.cache_id.clone(),
        })
    }

    /// Same-profile read/modify/replace is serialized; browser/network waits never hold this lock.
    pub(crate) fn save(
        &self,
        record: &TokenRecord,
        expected: &Snapshot,
    ) -> Result<&'static str, String> {
        self.save_refresh(record, expected)
            .map_err(|failure| failure.message)
    }

    pub(crate) fn save_refresh(
        &self,
        record: &TokenRecord,
        expected: &Snapshot,
    ) -> Result<&'static str, SaveFailure> {
        self.save_checked(record, expected.revision, &expected.identity, || {
            self.save_vault(record)
        })
    }

    pub(crate) fn retry_refresh(
        &self,
        record: &TokenRecord,
        retry: &SaveRetry,
    ) -> Result<&'static str, SaveFailure> {
        self.retry_checked(record, retry, || self.save_vault(record))
    }

    fn retry_checked(
        &self,
        record: &TokenRecord,
        retry: &SaveRetry,
        vault_write: impl FnOnce() -> Result<(), String>,
    ) -> Result<&'static str, SaveFailure> {
        if retry.store.cache_id != self.cache_id
            || retry.store.file_only != self.file_only
            || !Arc::ptr_eq(&retry.store.state, &self.state)
            || record_hash(record)? != retry.record_hash
        {
            return Err(SaveFailure::rejected("MCP_OAUTH_OPERATION_SUPERSEDED"));
        }
        self.save_checked(record, retry.revision, &retry.store.cache_id, vault_write)
    }

    fn save_vault(&self, record: &TokenRecord) -> Result<(), String> {
        let payload = serde_json::to_string(record).map_err(|_| "序列化 OAuth 记录失败")?;
        self.keyring_entry()?
            .set_password(&payload)
            .map_err(|_| "写入 MCP OAuth keychain 失败".into())
    }

    fn save_checked(
        &self,
        record: &TokenRecord,
        expected_revision: u64,
        expected_identity: &str,
        vault_write: impl FnOnce() -> Result<(), String>,
    ) -> Result<&'static str, SaveFailure> {
        let record_hash = record_hash(record)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| SaveFailure::rejected("MCP OAuth profile 锁失败"))?;
        let revision = state.revisions.entry(self.id.clone()).or_default();
        if *revision != expected_revision || expected_identity != self.cache_id {
            return Err(SaveFailure::rejected("MCP_OAUTH_OPERATION_SUPERSEDED"));
        }
        *revision = revision
            .checked_add(1)
            .ok_or_else(|| SaveFailure::rejected("MCP_OAUTH_OPERATION_SUPERSEDED"))?;
        let failed_revision = *revision;
        let failure = |message: String, stage| SaveFailure {
            message,
            retry: Some(SaveRetry {
                store: self.clone(),
                revision: failed_revision,
                record_hash,
                #[cfg(test)]
                check_hook: None,
            }),
            stage,
        };
        cache()
            .lock()
            .map_err(|_| failure("MCP OAuth 缓存锁失败".into(), SaveStage::NotWritten))?
            .remove(&self.cache_id);
        let path = self.root.join(FILE_STORE_NAME);
        let mut map =
            load_file_map_at(&path).map_err(|message| failure(message, SaveStage::NotWritten))?;
        let storage = match vault_write() {
            Ok(()) => {
                if map.remove(&self.id).is_some() {
                    save_file_map_at(&path, &map)
                        .map_err(|message| failure(message, SaveStage::VaultWritten))?;
                }
                "keychain"
            }
            Err(_) => {
                map.insert(self.id.clone(), record.clone());
                save_file_map_at(&path, &map)
                    .map_err(|message| failure(message, SaveStage::PossiblyWritten))?;
                "file"
            }
        };
        cache()
            .lock()
            .map_err(|_| failure("MCP OAuth 缓存锁失败".into(), SaveStage::DurableWritten))?
            .insert(
                self.cache_id.clone(),
                CacheSlot::Present(Box::new(record.clone()), storage),
            );
        Ok(storage)
    }

    pub(crate) fn delete(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "MCP OAuth profile 锁失败")?;
        let revision = state.revisions.entry(self.id.clone()).or_default();
        *revision = revision
            .checked_add(1)
            .ok_or("MCP_OAUTH_OPERATION_SUPERSEDED")?;
        cache()
            .lock()
            .map_err(|_| "MCP OAuth 缓存锁失败")?
            .remove(&self.cache_id);
        let path = self.root.join(FILE_STORE_NAME);
        let mut map = load_file_map_at(&path)?;
        if map.remove(&self.id).is_some() {
            save_file_map_at(&path, &map)?;
        }
        if !self.file_only {
            match self.keyring_entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err("删除 MCP OAuth keychain 条目失败".into()),
            }
        }
        cache()
            .lock()
            .map_err(|_| "MCP OAuth 缓存锁失败")?
            .insert(self.cache_id.clone(), CacheSlot::Absent);
        Ok(())
    }
}

fn record_hash(record: &TokenRecord) -> Result<[u8; 32], SaveFailure> {
    let bytes =
        serde_json::to_vec(record).map_err(|_| SaveFailure::rejected("序列化 OAuth 记录失败"))?;
    Ok(Sha256::digest(bytes).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("store/retry_tests.rs");

    #[cfg(windows)]
    #[test]
    #[ignore = "uses one unique synthetic Windows keyring entry and removes it"]
    fn native_vault_recovers_file_fallback_then_migrates_and_clears_credentials() {
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                match self.0.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => {}
                    Err(_) if std::thread::panicking() => {}
                    Err(_) => panic!("failed to remove synthetic MCP keyring fixture"),
                }
            }
        }
        let root = tempfile::tempdir().unwrap();
        let server = format!("native-vault-fixture-{}", uuid::Uuid::new_v4());
        let vault = TokenStore::for_profile(root.path().to_owned(), &server, false).unwrap();
        let entry = vault.keyring_entry().unwrap();
        match entry.get_password() {
            Err(keyring::Error::NoEntry) => {}
            _ => panic!("synthetic keyring namespace must be available and empty"),
        }
        let cleanup = Cleanup(entry);
        let fallback = TokenStore::for_profile(root.path().to_owned(), &server, true).unwrap();
        let saved = sample_record();
        assert_eq!(
            fallback
                .save(&saved, &fallback.snapshot().unwrap())
                .unwrap(),
            "file"
        );
        cache().lock().unwrap().remove(vault.identity());
        let recovered = vault.snapshot().unwrap();
        assert_eq!(recovered.record, Some(saved.clone()));
        assert_eq!(recovered.storage, "file");
        let mut migrated = saved;
        migrated.access_token = "synthetic-native-vault-migrated-access".into();
        assert_eq!(vault.save(&migrated, &recovered).unwrap(), "keychain");
        assert!(!root.path().join(FILE_STORE_NAME).exists());
        cache().lock().unwrap().remove(vault.identity());
        let reread = vault.snapshot().unwrap();
        assert_eq!(reread.record, Some(migrated));
        assert_eq!(reread.storage, "keychain");
        vault.delete().unwrap();
        assert!(matches!(
            cleanup.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert!(!root.path().join(FILE_STORE_NAME).exists());
        assert!(vault.snapshot().unwrap().record.is_none());
    }

    #[test]
    fn file_fallback_survives_vault_recovery_without_a_keyring_entry() {
        let root = tempfile::tempdir().unwrap();
        let store = TokenStore::for_profile(root.path().to_owned(), "server", true).unwrap();
        let saved = sample_record();
        store.save(&saved, &store.snapshot().unwrap()).unwrap();
        cache().lock().unwrap().remove(store.identity());
        let (loaded, storage) = store.load_uncached(Ok(None)).unwrap();
        assert_eq!(loaded, Some(saved));
        assert_eq!(storage, "file");
    }

    #[test]
    fn existing_vault_record_wins_without_reading_a_damaged_fallback() {
        let root = tempfile::tempdir().unwrap();
        let store = TokenStore::for_profile(root.path().to_owned(), "server", true).unwrap();
        fs::write(root.path().join(FILE_STORE_NAME), b"damaged fallback").unwrap();
        let vault = sample_record();
        let (loaded, storage) = store.load_uncached(Ok(Some(vault.clone()))).unwrap();
        assert_eq!(loaded, Some(vault));
        assert_eq!(storage, "keychain");
        assert_eq!(
            fs::read(root.path().join(FILE_STORE_NAME)).unwrap(),
            b"damaged fallback"
        );
    }

    #[test]
    fn empty_vault_cannot_turn_a_damaged_fallback_into_an_empty_store() {
        let root = tempfile::tempdir().unwrap();
        let store = TokenStore::for_profile(root.path().to_owned(), "server", true).unwrap();
        fs::write(root.path().join(FILE_STORE_NAME), b"damaged fallback").unwrap();
        assert!(store.load_uncached(Ok(None)).is_err());
        assert_eq!(
            fs::read(root.path().join(FILE_STORE_NAME)).unwrap(),
            b"damaged fallback"
        );
    }

    #[test]
    fn oauth_keyring_and_cache_identity_separate_profiles_and_servers() {
        let a = Path::new("account-a");
        let b = Path::new("account-b");
        assert_eq!(
            scoped_token_id(a, "server-1"),
            scoped_token_id(a, "server-1")
        );
        assert_ne!(
            scoped_token_id(a, "server-1"),
            scoped_token_id(b, "server-1")
        );
        assert_ne!(
            scoped_token_id(a, "server-1"),
            scoped_token_id(a, "server-2")
        );
        assert_eq!(scoped_token_id(a, "server-1").len(), 64);
        assert_eq!(KEYRING_SERVICE, "ZeroAgent MCP OAuth");
    }

    fn sample_record() -> TokenRecord {
        TokenRecord {
            version: 1,
            server_url: "https://mcp.example.com/mcp".to_string(),
            target_binding: None,
            issuer: "https://auth.example.com".to_string(),
            authorization_endpoint: "https://auth.example.com/authorize".to_string(),
            token_endpoint: "https://auth.example.com/token".to_string(),
            registration_endpoint: Some("https://auth.example.com/register".to_string()),
            client_id: "client-1".to_string(),
            client_secret: None,
            token_endpoint_auth_method: "none".to_string(),
            scope: Some("mcp.read mcp.write".to_string()),
            resource: "https://mcp.example.com/mcp".to_string(),
            access_token: "at-1".to_string(),
            refresh_token: Some("rt-1".to_string()),
            expires_at_ms: 1_000_000,
        }
    }

    #[test]
    fn captured_store_keeps_original_profile_across_delayed_completion() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let start = TokenStore::for_profile(a.path().to_owned(), "same-server", true).unwrap();
        let pending = start.snapshot().unwrap();
        // A second operation selects B while A is waiting for its callback/refresh.
        let selected = TokenStore::for_profile(b.path().to_owned(), "same-server", true).unwrap();
        let mut other = sample_record();
        other.access_token = "profile-b-token".into();
        selected
            .save(&other, &selected.snapshot().unwrap())
            .unwrap();
        start.save(&sample_record(), &pending).unwrap();
        assert_eq!(
            load_file_map_at(&a.path().join(FILE_STORE_NAME)).unwrap()["same-server"],
            sample_record()
        );
        assert_eq!(selected.snapshot().unwrap().record.unwrap(), other);
        assert_ne!(start.identity(), selected.identity());
    }

    #[test]
    fn concurrent_servers_preserve_both_credentials_after_cache_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let left = TokenStore::for_profile(dir.path().to_owned(), "left", true).unwrap();
        let right = TokenStore::for_profile(dir.path().to_owned(), "right", true).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        std::thread::scope(|scope| {
            for store in [&left, &right] {
                let barrier = barrier.clone();
                scope.spawn(move || {
                    let snapshot = store.snapshot().unwrap();
                    barrier.wait();
                    store.save(&sample_record(), &snapshot).unwrap();
                });
            }
            barrier.wait();
        });
        let disk = load_file_map_at(&dir.path().join(FILE_STORE_NAME)).unwrap();
        assert_eq!(disk.len(), 2);
        for store in [&left, &right] {
            cache().lock().unwrap().remove(store.identity());
            assert_eq!(store.snapshot().unwrap().record, Some(sample_record()));
        }
    }

    #[test]
    fn clear_invalidates_pending_authorization_and_refresh_even_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::for_profile(dir.path().to_owned(), "srv", true).unwrap();
        let authorize = store.snapshot().unwrap();
        store.delete().unwrap();
        assert!(store.save(&sample_record(), &authorize).is_err());
        store
            .save(&sample_record(), &store.snapshot().unwrap())
            .unwrap();
        let refresh = store.snapshot().unwrap();
        store.delete().unwrap();
        assert!(store.save(&sample_record(), &refresh).is_err());
        assert!(!dir.path().join(FILE_STORE_NAME).exists());
        assert!(store.snapshot().unwrap().record.is_none());
    }

    #[test]
    fn superseded_or_other_profile_snapshot_cannot_overwrite_new_record() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let store = TokenStore::for_profile(a.path().to_owned(), "srv", true).unwrap();
        let other = TokenStore::for_profile(b.path().to_owned(), "srv", true).unwrap();
        assert!(store
            .save(&sample_record(), &other.snapshot().unwrap())
            .is_err());
        let old = store.snapshot().unwrap();
        let mut newer = sample_record();
        newer.access_token = "newer-token".into();
        store.save(&newer, &old).unwrap();
        assert!(store.save(&sample_record(), &old).is_err());
        assert_eq!(store.snapshot().unwrap().record, Some(newer));
    }

    #[test]
    fn damaged_file_is_preserved_and_not_cached_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_STORE_NAME);
        let damaged = b"{credential-file-must-be-preserved";
        fs::write(&path, damaged).unwrap();
        let store = TokenStore::for_profile(dir.path().to_owned(), "srv", true).unwrap();
        assert!(store.snapshot().is_err());
        assert!(store.delete().is_err());
        assert_eq!(fs::read(&path).unwrap(), damaged);
        assert!(!cache().lock().unwrap().contains_key(store.identity()));
        save_file_map_at(&path, &HashMap::new()).unwrap();
        assert!(store.snapshot().unwrap().record.is_none());
    }

    #[test]
    fn failed_atomic_replace_keeps_destination_and_cleans_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join(FILE_STORE_NAME);
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("preserved"), b"existing").unwrap();
        let mut map = HashMap::new();
        map.insert("srv".into(), sample_record());
        assert!(save_file_map_at(&destination, &map).is_err());
        assert_eq!(
            fs::read(destination.join("preserved")).unwrap(),
            b"existing"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn file_map_roundtrip_preserves_record() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(FILE_STORE_NAME);
        let mut map = HashMap::new();
        map.insert("srv".to_string(), sample_record());
        save_file_map_at(&path, &map).expect("save");
        let loaded = load_file_map_at(&path).expect("load");
        assert_eq!(loaded.get("srv"), Some(&sample_record()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "token 文件必须是 0600");
        }
    }

    #[test]
    fn empty_file_map_removes_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(FILE_STORE_NAME);
        let mut map = HashMap::new();
        map.insert("srv".to_string(), sample_record());
        save_file_map_at(&path, &map).expect("save");
        assert!(path.exists());
        save_file_map_at(&path, &HashMap::new()).expect("save empty");
        assert!(!path.exists());
    }

    #[test]
    fn expiry_windows_honor_skew_and_unknown_expiry() {
        let mut record = sample_record();
        record.expires_at_ms = 0;
        assert!(!record.is_expiring(u64::MAX - EXPIRY_SKEW_MS));
        assert!(!record.is_expired(u64::MAX));

        record.expires_at_ms = 100_000;
        assert!(!record.is_expiring(100_000 - EXPIRY_SKEW_MS - 1));
        assert!(record.is_expiring(100_000 - EXPIRY_SKEW_MS));
        assert!(!record.is_expired(99_999));
        assert!(record.is_expired(100_000));
    }

    #[test]
    fn record_serde_skips_absent_optionals() {
        let mut record = sample_record();
        record.client_secret = None;
        record.refresh_token = None;
        record.registration_endpoint = None;
        record.scope = None;
        let json = serde_json::to_string(&record).expect("serialize");
        assert!(!json.contains("client_secret"));
        assert!(!json.contains("refresh_token"));
        let back: TokenRecord = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, record);
    }
}
