use sha2::{Digest, Sha256};
#[cfg(test)]
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::runtime::process::terminate_child_process_tree;
use crate::services::account_identity::VerifiedProfile;
#[cfg(desktop)]
use crate::services::account_session::AccountSessionState;
use crate::services::backend_facade::BackendFacade;
use crate::services::backend_profile::BackendProfile;
use crate::services::kbrain_health::parse_health;
use crate::services::managed_model_broker::{
    configured_origin, ManagedBinding, ManagedCredential, ManagedModelBroker,
};
use crate::services::system_proxy;

const BACKEND_DIR: &str = "kbrain";
#[cfg(test)]
const CONFIG_FILE: &str = "config.json";
const TOKEN_ENV: &str = "K_BRAIN_BACKEND_TOKEN";
/// 应用代理取值（见 `system_proxy::kbrain_proxy_value`）；必须总是设置，
/// 否则 K-brain 会回退到继承的 HTTP(S)_PROXY。
const PROXY_ENV: &str = "LIVEAGENT_KBRAIN_PROXY";
const DEBUG_BINARY_ENV: &str = "ZEROAGENT_BACKEND_BINARY";
#[cfg(test)]
const TEST_BINARY_ENV: &str = "ZEROAGENT_BACKEND_TEST_BINARY";
const PROTOCOL_VERSION: &str = "kbrain.agent.v1";
const READY_PREFIX: &str = "k-brain backend listening on ";
// The pinned backend can need more than 30s before emitting READY on Windows cold starts.
// Keep a finite deadline and the existing cancellation/process cleanup paths.
pub(crate) const STARTUP_TIMEOUT: Duration =
    Duration::from_secs(if cfg!(windows) { 60 } else { 15 });
const STOP_GRACE: Duration = Duration::from_secs(2);
const MAX_STDOUT_LINE: usize = 16 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

// This type deliberately cannot be serialized by an IPC command.
#[derive(Clone)]
pub struct KBrainBackendConnection {
    pub base_url: String,
    pub token: String,
    pub protocol_version: String,
    pub storage_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicBackendConnection {
    pub base_url: String,
    pub token: String,
    pub protocol_version: String,
    pub storage_id: String,
}

impl std::fmt::Debug for KBrainBackendConnection {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_struct("KBrainBackendConnection")
            .field("base_url", &self.base_url)
            .field("storage_id", &self.storage_id)
            .finish_non_exhaustive()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivatedProfileConnection {
    #[serde(flatten)]
    connection: PublicBackendConnection,
    account_scope: Option<String>,
}

struct BackendProcess {
    child: Child,
    // Keeping stdin open enables the backend's parent-stdio watchdog.
    stdin: Option<ChildStdin>,
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        drop(self.stdin.take());
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                let _ = terminate_child_process_tree(&mut self.child, STOP_GRACE);
            }
        }
    }
}

enum StartupEvent {
    Ready(String),
    Eof,
    Error(String),
}

pub struct KBrainBackendManager {
    process: Mutex<Option<BackendProcess>>,
    connection: KBrainBackendConnection,
    facade: Mutex<Option<BackendFacade>>,
    configuration: Arc<crate::services::configuration_coordinator::ConfigurationCoordinator>,
    configuration_root: PathBuf,
    mcp_credentials: Mutex<Option<crate::services::mcp_oauth::broker::NativeCredentialBroker>>,
    #[cfg(desktop)]
    host_bridge: Mutex<Option<(u64, super::host_bridge::HostBridge)>>,
}

struct McpCredentialOwner {
    settings_root: PathBuf,
    profile_live: Arc<AtomicBool>,
    #[cfg(desktop)]
    device_skills: Option<crate::services::account_session::device_skills::DeviceSkillAccount>,
}

fn supports_native_mcp_credentials(binary: &Path) -> Result<bool, String> {
    let receipt: serde_json::Value = serde_json::from_str(env!("ZEROAGENT_MCP_BRIDGE_RECEIPT"))
        .map_err(|_| "Native MCP capability receipt is invalid")?;
    if receipt.get("origin").and_then(serde_json::Value::as_str) != Some("zeroagent-patched-source")
    {
        return Ok(false);
    }
    let lock: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../scripts/release/kbrain.lock.json"
    )))
    .map_err(|_| "Native MCP source lock is invalid")?;
    let patch = receipt
        .get("zeroagentPatchSet")
        .ok_or("Native MCP patch provenance is missing")?;
    if receipt.get("sourceRevision") != lock.get("sourceRevision")
        || receipt.get("protocol").and_then(serde_json::Value::as_str) != Some(PROTOCOL_VERSION)
        || patch.get("sourceRevision") != lock.get("sourceRevision")
        || patch.get("repository") != lock.get("repository")
        || !patch
            .get("capabilities")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|caps| {
                caps.iter()
                    .any(|cap| cap.as_str() == Some(crate::services::mcp_oauth::broker::PROTOCOL))
            })
    {
        return Err("Native MCP sidecar capability does not match the source lock".into());
    }
    let expected = receipt
        .pointer("/sha256/backend")
        .and_then(serde_json::Value::as_str)
        .ok_or("Native MCP binary checksum is missing")?;
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Native MCP binary checksum is invalid".into());
    }
    let mut input = std::fs::File::open(binary).map_err(|_| "Native MCP sidecar is unavailable")?;
    let mut hash = Sha256::new();
    let mut bytes = [0_u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut input, &mut bytes)
            .map_err(|_| "Unable to verify Native MCP sidecar")?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    let actual = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != expected {
        return Err("Native MCP sidecar differs from the compiled capability receipt".into());
    }
    Ok(true)
}

pub struct KBrainBackendState {
    profile: Mutex<BackendProfile>,
    // Separate from the active-profile lock, which can be held throughout cold startup.
    requested_profile: Mutex<(BackendProfile, u64)>,
    profile_verification_epoch: AtomicU64,
    profile_initialized: AtomicBool,
    bound_session: Mutex<Option<String>>,
    account_bound: AtomicBool,
    account_live: AtomicBool,
    profile_liveness: Mutex<Option<Arc<AtomicBool>>>,
    #[cfg(desktop)]
    account_sessions: Option<Arc<AccountSessionState>>,
    model_broker: Mutex<Option<ManagedModelBroker>>,
    managed_binding_refresh: tokio::sync::Mutex<()>,
    transport_credentials: Mutex<Vec<String>>,
    manager: Mutex<Option<Arc<KBrainBackendManager>>>,
    start_lock: Mutex<()>,
    shutdown_epoch: AtomicU64,
    exiting: AtomicBool,
    /// Every listener/token change (start, restart on a new port, shutdown), so
    /// dependents such as the managed Gateway never keep a stale backend.
    connection_tx: tokio::sync::watch::Sender<Option<PublicBackendConnection>>,
}

impl Default for KBrainBackendState {
    fn default() -> Self {
        Self {
            profile: Mutex::new(BackendProfile::Local),
            requested_profile: Mutex::new((BackendProfile::Local, 0)),
            profile_verification_epoch: AtomicU64::new(0),
            profile_initialized: AtomicBool::new(false),
            bound_session: Mutex::new(None),
            account_bound: AtomicBool::new(false),
            account_live: AtomicBool::new(false),
            profile_liveness: Mutex::new(None),
            #[cfg(desktop)]
            account_sessions: None,
            model_broker: Mutex::new(None),
            managed_binding_refresh: tokio::sync::Mutex::new(()),
            transport_credentials: Mutex::new(Vec::new()),
            manager: Mutex::new(None),
            start_lock: Mutex::new(()),
            shutdown_epoch: AtomicU64::new(0),
            exiting: AtomicBool::new(false),
            connection_tx: tokio::sync::watch::channel(None).0,
        }
    }
}

// Storage identity follows the canonical data root, never the ephemeral listener or token.
fn backend_storage_id(root: &Path) -> Result<String, String> {
    let canonical = root
        .canonicalize()
        .map_err(|_| "Unable to identify ZeroAgent data root".to_string())?;
    let identity = crate::services::backend_profile::storage_identity_path(&canonical);
    let digest = Sha256::digest(identity.as_os_str().as_encoded_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("local-{hex}"))
}

impl KBrainBackendManager {
    #[cfg(test)]
    pub(crate) fn start_with_binary_and_timeout(
        binary: PathBuf,
        backend_dir: PathBuf,
        startup_timeout: Duration,
    ) -> Result<Arc<Self>, String> {
        Self::start(binary, backend_dir, None, startup_timeout, &|| false, None)
    }

    fn start(
        binary: PathBuf,
        backend_dir: PathBuf,
        legacy_desktop_dir: Option<PathBuf>,
        startup_timeout: Duration,
        cancelled: &dyn Fn() -> bool,
        mcp_owner: Option<McpCredentialOwner>,
    ) -> Result<Arc<Self>, String> {
        if cancelled() {
            return Err("ZeroAgent engine startup cancelled".into());
        }
        crate::services::backend_profile::prepare_backend_directory(&backend_dir)?;
        std::fs::create_dir_all(&backend_dir)
            .map_err(|_| "Unable to create ZeroAgent data root".to_string())?;
        crate::services::skills::ensure_backend_builtin_agent_skills(&backend_dir)?;
        let storage_id = backend_storage_id(&backend_dir)?;
        let configuration =
            crate::services::configuration_coordinator::ConfigurationCoordinator::for_profile(
                &storage_id,
            )?;
        let token = uuid::Uuid::new_v4().to_string();
        #[cfg(desktop)]
        let has_device_skills = mcp_owner
            .as_ref()
            .is_some_and(|owner| owner.device_skills.is_some());
        let mcp_credentials = mcp_owner
            .map(|owner| {
                crate::services::mcp_oauth::broker::NativeCredentialBroker::start(
                    backend_dir.clone(),
                    owner.settings_root,
                    storage_id.clone(),
                    owner.profile_live,
                    crate::runtime::data_home::isolation_requested(),
                    #[cfg(desktop)]
                    owner.device_skills,
                )
            })
            .transpose()?;

        let mut command = Command::new(&binary);
        command
            .arg("backend")
            .arg("-listen")
            .arg("127.0.0.1:0")
            .arg("-data-dir")
            .arg(&backend_dir)
            .arg("-parent-stdio")
            .env(TOKEN_ENV, &token)
            .env("LIVEAGENT_HOME", &backend_dir)
            .env(PROXY_ENV, system_proxy::kbrain_proxy_value())
            .env_remove("ZEROAGENT_MCP_CREDENTIAL_ENDPOINT")
            .env_remove("ZEROAGENT_MCP_CREDENTIAL_TOKEN")
            .env_remove("ZEROAGENT_DEVICE_SKILL_ENDPOINT")
            .env_remove("ZEROAGENT_DEVICE_SKILL_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(host) = &mcp_credentials {
            command
                .env("ZEROAGENT_MCP_CREDENTIAL_ENDPOINT", host.endpoint())
                .env("ZEROAGENT_MCP_CREDENTIAL_TOKEN", host.capability());
            #[cfg(desktop)]
            if has_device_skills {
                command
                    .env(
                        "ZEROAGENT_DEVICE_SKILL_ENDPOINT",
                        host.device_skill_endpoint(),
                    )
                    .env("ZEROAGENT_DEVICE_SKILL_TOKEN", host.capability());
            }
        }
        if let Some(legacy) = legacy_desktop_dir {
            command.arg("-legacy-desktop-dir").arg(legacy);
        }
        crate::runtime::process::configure_child_process_group(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start ZeroAgent engine: {error}"))?;
        let stdin = child.stdin.take();
        let mut process = BackendProcess { child, stdin };
        let stdout = match process.child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                return Err("ZeroAgent engine stdout was not piped".to_string());
            }
        };
        if let Some(stderr) = process.child.stderr.take() {
            spawn_stderr_drain(stderr, token.clone())?;
        }
        // Only READY and the terminal stream event enter this bounded channel.
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(2);
        let mcp_process_guard = mcp_credentials.as_ref().map(|host| host.process_guard());
        thread::Builder::new()
            .name("kbrain-stdout".into())
            .spawn(move || {
                let _mcp_process_guard = mcp_process_guard;
                let mut reader = BufReader::new(stdout);
                loop {
                    match read_bounded_line(&mut reader, MAX_STDOUT_LINE) {
                        Ok(Some(line)) => {
                            if let Some(url) = parse_ready_url(&line) {
                                let _ = ready_tx.send(StartupEvent::Ready(url));
                                match io::copy(&mut reader, &mut io::sink()) {
                                    Ok(_) => {
                                        let _ = ready_tx.send(StartupEvent::Eof);
                                    }
                                    Err(error) => {
                                        let _ =
                                            ready_tx.send(StartupEvent::Error(error.to_string()));
                                    }
                                }
                                return;
                            }
                        }
                        Ok(None) => {
                            let _ = ready_tx.send(StartupEvent::Eof);
                            return;
                        }
                        Err(error) => {
                            let _ = ready_tx.send(StartupEvent::Error(error.to_string()));
                            return;
                        }
                    }
                }
            })
            .map_err(|error| format!("failed to start ZeroAgent engine stdout reader: {error}"))?;

        let deadline = Instant::now() + startup_timeout;
        let base_url = loop {
            if cancelled() {
                return Err("ZeroAgent engine startup cancelled".into());
            }
            let wait = deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(100));
            match ready_rx.recv_timeout(wait) {
                Ok(StartupEvent::Ready(url)) => break url,
                Ok(StartupEvent::Eof) => {
                    let status = child_status_after_eof(&mut process.child)?;
                    return Err(match status {
                        Some(status) => format!(
                            "ZeroAgent engine exited before becoming ready (code {})",
                            status.code().unwrap_or(-1)
                        ),
                        None => "ZeroAgent engine stdout closed before becoming ready".to_string(),
                    });
                }
                Ok(StartupEvent::Error(error)) => {
                    return Err(format!(
                        "failed to read ZeroAgent engine startup output: {error}"
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("ZeroAgent engine startup output reader disconnected".to_string());
                }
            }
            if let Some(status) = process
                .child
                .try_wait()
                .map_err(|error| format!("failed to inspect ZeroAgent engine: {error}"))?
            {
                return Err(format!(
                    "ZeroAgent engine exited before becoming ready (code {})",
                    status.code().unwrap_or(-1)
                ));
            }
            if Instant::now() >= deadline {
                return Err(
                    "ZeroAgent engine did not become ready before the startup timeout".into(),
                );
            }
        };

        let connection = KBrainBackendConnection {
            base_url,
            token,
            protocol_version: PROTOCOL_VERSION.to_string(),
            storage_id,
        };
        wait_for_health(
            &connection,
            deadline,
            &mut process.child,
            &ready_rx,
            cancelled,
        )?;

        Ok(Arc::new(Self {
            process: Mutex::new(Some(process)),
            connection,
            facade: Mutex::new(None),
            configuration,
            configuration_root: backend_dir,
            mcp_credentials: Mutex::new(mcp_credentials),
            #[cfg(desktop)]
            host_bridge: Mutex::new(None),
        }))
    }

    pub fn connection(&self) -> KBrainBackendConnection {
        self.connection.clone()
    }

    pub(crate) fn configuration_root(&self) -> PathBuf {
        self.configuration_root.clone()
    }

    fn public_connection(
        &self,
        profile_live: Arc<AtomicBool>,
        configuration_http: Arc<dyn crate::services::backend_facade::ConfigurationHttpService>,
    ) -> Result<PublicBackendConnection, String> {
        let mut facade = self
            .facade
            .lock()
            .map_err(|_| "Native backend transport lock failed")?;
        if !facade.as_ref().is_some_and(BackendFacade::is_running) {
            facade.take();
            *facade = Some(BackendFacade::start_with_configuration(
                self.connection(),
                profile_live,
                configuration_http,
            )?);
        }
        Ok(facade
            .as_ref()
            .ok_or("Native backend transport unavailable")?
            .connection())
    }

    fn stop_facade(&self) {
        let facade = self.facade.lock().ok().and_then(|mut value| value.take());
        drop(facade);
    }

    fn stop_mcp_credentials(&self) {
        let host = self
            .mcp_credentials
            .lock()
            .ok()
            .and_then(|mut host| host.take());
        drop(host);
    }

    fn mcp_credential_capability(&self) -> Option<String> {
        self.mcp_credentials
            .lock()
            .ok()?
            .as_ref()
            .map(|host| host.capability().to_owned())
    }

    pub fn is_running(&self) -> bool {
        let running = self.process.lock().ok().is_some_and(|mut guard| {
            let Some(process) = guard.as_mut() else {
                return false;
            };
            match process.child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) | Err(_) => {
                    guard.take();
                    false
                }
            }
        });
        if !running {
            self.stop_mcp_credentials();
            self.stop_facade();
        }
        running
    }

    pub fn shutdown(&self) {
        #[cfg(desktop)]
        if let Ok(mut bridge) = self.host_bridge.lock() {
            bridge.take();
        }
        self.stop_mcp_credentials();
        self.stop_facade();
        // Release the process mutex before waiting for the child tree.
        let process = self.process.lock().ok().and_then(|mut guard| guard.take());
        if let Some(process) = process {
            drop(process);
        }
    }
}

impl KBrainBackendState {
    pub(crate) fn capture_mcp_oauth_store(
        &self,
        server_id: &str,
    ) -> Result<crate::services::mcp_oauth::store::TokenStore, String> {
        // Profile activation updates config_dir under this same lock. Capture before the
        // command enters spawn_blocking; a browser callback must never select a new root.
        let profile = self
            .profile
            .lock()
            .map_err(|_| "Backend profile lock failed")?;
        if !self.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        self.profile_start_epoch(&profile, None)?;
        crate::services::mcp_oauth::store::TokenStore::capture(server_id)
    }

    pub(crate) fn with_current_ssh_profile<T>(
        &self,
        expected: &KBrainBackendConnection,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let profile = self.profile.lock().map_err(|_| "Backend profile lock failed")?;
        if !self.allows_profile_commands()
            || !self.running_connection().is_some_and(|current| {
                current.storage_id == expected.storage_id
                    && current.base_url == expected.base_url
                    && current.token == expected.token
            })
        {
            return Err("SSH configuration no longer belongs to the active profile".into());
        }
        self.profile_start_epoch(&profile, None)?;
        action()
    }

    pub(crate) fn configuration_root(&self) -> Result<PathBuf, String> {
        self.manager
            .lock()
            .map_err(|_| "配置后端不可用")?
            .as_ref()
            .map(|manager| manager.configuration_root())
            .ok_or_else(|| "配置后端尚未就绪".into())
    }
    pub(crate) fn prepare_configuration_settings(
        &self,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if !self.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let mut update = input.as_object().cloned().ok_or("服务商更新必须是对象")?;
        let mut checked = update.clone();
        if let Some(providers) = update.get_mut("providers") {
            let providers = providers.as_array_mut().ok_or("服务商更新必须是数组")?;
            let broker = self
                .model_broker
                .lock()
                .map_err(|_| "托管模型凭据暂不可用")?;
            for (index, provider) in providers.iter_mut().enumerate() {
                let provider = provider.as_object_mut().ok_or("服务商配置无效")?;
                let id = provider
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("服务商缺少 ID")?
                    .to_owned();
                let binding = broker
                    .as_ref()
                    .ok_or("请先刷新托管模型")?
                    .binding(&id)?
                    .ok_or("只能配置当前账户已授权的托管模型")?;
                if let Some(items) = checked
                    .get_mut("providers")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    if items[index]
                        .get("apiKey")
                        .and_then(serde_json::Value::as_str)
                        == Some(binding.api_key.as_str())
                    {
                        items[index]
                            .as_object_mut()
                            .ok_or("服务商配置无效")?
                            .remove("apiKey");
                    }
                }
                crate::services::managed_model_broker::constrain_managed_provider(
                    provider, &binding,
                )?;
            }
        }
        if let Some(id) = update
            .get("defaultProvider")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
        {
            let broker = self
                .model_broker
                .lock()
                .map_err(|_| "托管模型凭据暂不可用")?;
            if broker
                .as_ref()
                .ok_or("请先刷新托管模型")?
                .binding(id)?
                .is_none()
            {
                return Err("只能选择当前账户已授权的托管模型".into());
            }
        }
        self.verify_portable_backup(&serde_json::Value::Object(checked))?;
        Ok(serde_json::Value::Object(update))
    }

    /// A remote settings/catalog request can arrive before this device's own
    /// renderer has refreshed a newly created platform key. Fill the broker
    /// from the same Native owner without importing renderer credentials.
    #[cfg(desktop)]
    pub(crate) async fn ensure_managed_provider_bindings(
        self: &Arc<Self>,
        provider_ids: &[String],
    ) -> Result<(), String> {
        if provider_ids.is_empty() {
            return Ok(());
        }
        for provider in provider_ids {
            let key_id = provider
                .strip_prefix("relay-key-")
                .and_then(|id| id.parse::<u64>().ok())
                .filter(|id| *id > 0)
                .ok_or("只能配置当前账户已授权的托管模型")?;
            if provider != &format!("relay-key-{key_id}") {
                return Err("托管模型 ID 无效".into());
            }
        }
        if !self.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let _refresh = self.managed_binding_refresh.lock().await;
        let ready = {
            let broker = self
                .model_broker
                .lock()
                .map_err(|_| "托管模型凭据暂不可用")?;
            if let Some(broker) = broker.as_ref() {
                provider_ids.iter().try_fold(true, |ready, id| {
                    Ok::<_, String>(ready && broker.binding(id)?.is_some())
                })?
            } else {
                false
            }
        };
        if ready {
            return Ok(());
        }
        let account = self
            .account_sessions
            .as_ref()
            .ok_or("Native 账号尚未就绪")?;
        let handle = self
            .bound_session
            .lock()
            .map_err(|_| "账号绑定不可用")?
            .clone()
            .ok_or("USA_ZERO_PROFILE_AUTH_REQUIRED")?;
        let public = account.verified_current(&handle).await?;
        let live = account.profile_liveness(Some(&handle)).await?;
        let credentials = account.all_active_managed_credentials(&handle).await?;
        if provider_ids.iter().any(|id| {
            !credentials
                .iter()
                .any(|credential| &credential.provider_id == id)
        }) {
            return Err("只能配置当前账户已启用的托管模型".into());
        }
        // Replace the complete authenticated set, so registering a new key
        // cannot revoke the remaining providers or rotate their capabilities.
        let origin = account.trusted_origin().clone();
        let state = Arc::clone(self);
        let current_handle = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if !live.load(Ordering::SeqCst)
                || state
                    .bound_session
                    .lock()
                    .map_err(|_| "账号绑定不可用")?
                    .as_deref()
                    != Some(&current_handle)
            {
                return Err("USA-Zero account session changed".into());
            }
            state.register_managed_credentials_with_origin(
                &public.account_scope,
                origin,
                credentials,
            )?;
            if !live.load(Ordering::SeqCst) {
                return Err("USA-Zero account session changed".into());
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "托管模型凭据准备任务失败")??;
        account.require_current(&handle).await?;
        Ok(())
    }

    pub(crate) fn prepare_provider_models(
        &self,
        provider_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if !self.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let mut provider = input.as_object().cloned().ok_or("服务商配置无效")?;
        let binding = self
            .model_broker
            .lock()
            .map_err(|_| "托管模型凭据暂不可用")?
            .as_ref()
            .ok_or("请先刷新托管模型")?
            .binding(provider_id)?
            .ok_or("只能查询当前账户已授权的托管模型")?;
        provider.insert("id".into(), serde_json::json!(provider_id));
        provider.insert("providerId".into(), serde_json::json!(provider_id));
        crate::services::managed_model_broker::constrain_managed_provider(&mut provider, &binding)?;
        Ok(serde_json::Value::Object(provider))
    }

    pub(crate) fn configuration_coordinator(
        &self,
    ) -> Result<Arc<crate::services::configuration_coordinator::ConfigurationCoordinator>, String>
    {
        self.manager
            .lock()
            .map_err(|_| "Configuration backend is unavailable")?
            .as_ref()
            .map(|manager| Arc::clone(&manager.configuration))
            .ok_or_else(|| "Configuration backend is not ready".into())
    }

    #[cfg(desktop)]
    pub(crate) fn with_account_sessions(account_sessions: Arc<AccountSessionState>) -> Self {
        Self {
            account_sessions: Some(account_sessions),
            ..Self::default()
        }
    }

    fn profile_lease_live(&self) -> bool {
        self.profile_liveness
            .lock()
            .map(|lease| {
                lease
                    .as_ref()
                    .is_none_or(|live| live.load(Ordering::SeqCst))
            })
            .unwrap_or(false)
    }

    pub fn allows_profile_commands(&self) -> bool {
        self.profile_initialized.load(Ordering::SeqCst)
            && self.profile_lease_live()
            && (!self.account_bound.load(Ordering::SeqCst)
                || self.account_live.load(Ordering::SeqCst))
    }

    #[cfg(desktop)]
    pub(crate) fn guard_account_viewer(&self, app: &AppHandle, handle: &str) -> Result<(), String> {
        if !self.profile_initialized.load(Ordering::SeqCst) {
            return Ok(());
        }
        let bound = self
            .bound_session
            .lock()
            .map_err(|_| "Account profile binding failed")?;
        if bound.as_deref() == Some(handle) {
            return if self.account_live.load(Ordering::SeqCst) && self.profile_lease_live() {
                Ok(())
            } else {
                Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into())
            };
        }
        drop(bound);
        if !self.exiting.swap(true, Ordering::SeqCst) {
            self.shutdown();
            if let Some(allow_exit) = app.try_state::<Arc<AtomicBool>>() {
                allow_exit.store(true, Ordering::SeqCst);
            }
            app.restart();
        }
        Err("USA-Zero account session changed".into())
    }

    pub(crate) fn close_account_session(&self, handle: &str) -> bool {
        let Ok(bound) = self.bound_session.lock() else {
            return false;
        };
        if bound.as_deref() != Some(handle) {
            return false;
        }
        self.account_live.store(false, Ordering::SeqCst);
        self.shutdown();
        true
    }
    fn register_managed_credentials(
        &self,
        account_scope: &str,
        origin: &str,
        credentials: Vec<ManagedCredential>,
    ) -> Result<Vec<ManagedBinding>, String> {
        self.register_managed_credentials_with_origin(
            account_scope,
            configured_origin(origin)?,
            credentials,
        )
    }

    fn register_managed_credentials_with_origin(
        &self,
        account_scope: &str,
        origin: url::Url,
        credentials: Vec<ManagedCredential>,
    ) -> Result<Vec<ManagedBinding>, String> {
        if !self.allows_profile_commands() {
            return Err("USA-Zero account session ended".into());
        }
        let expected = BackendProfile::from_account_scope(Some(account_scope))?;
        let profile = self
            .profile
            .lock()
            .map_err(|_| "Backend profile lock failed")?;
        if *profile != expected
            || !matches!(*profile, BackendProfile::Account(_))
            || self.running_connection().is_none()
        {
            return Err(
                "Managed credentials require the active authenticated backend profile".into(),
            );
        }
        if !account_scope.starts_with(&format!("{}|user:", origin.origin().ascii_serialization())) {
            return Err("Managed credential account origin mismatch".into());
        }
        let mut broker = self
            .model_broker
            .lock()
            .map_err(|_| "Model broker lock failed")?;
        if broker.is_none() {
            *broker = Some(ManagedModelBroker::start(origin)?);
        }
        broker
            .as_ref()
            .ok_or("Model broker unavailable")?
            .replace(credentials)
    }

    pub fn ensure_started(
        self: &Arc<Self>,
        app: &AppHandle,
    ) -> Result<KBrainBackendConnection, String> {
        let profile = self
            .profile
            .lock()
            .map_err(|_| "Backend profile lock is poisoned".to_string())?;
        if !self.profile_initialized.load(Ordering::SeqCst) {
            return Err("Verify the ZeroAgent account profile before starting the backend".into());
        }
        if !self.allows_profile_commands() {
            return Err("USA-Zero account session ended".into());
        }
        self.ensure_profile_started(app, &profile, None)
    }

    fn begin_profile_verification(&self) -> Result<u64, String> {
        // Never hold the active-profile lock during network verification or cold startup.
        let _requested = self
            .requested_profile
            .lock()
            .map_err(|_| "Backend profile request lock is poisoned")?;
        if self.exiting.load(Ordering::SeqCst) {
            return Err("ZeroAgent engine profile activation cancelled".into());
        }
        Ok(self
            .profile_verification_epoch
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1))
    }

    fn require_profile_verification(&self, ticket: u64) -> Result<(), String> {
        if self.exiting.load(Ordering::SeqCst)
            || self.profile_verification_epoch.load(Ordering::SeqCst) != ticket
        {
            return Err("ZeroAgent engine profile verification superseded".into());
        }
        Ok(())
    }

    #[cfg(test)]
    fn publish_profile_request(&self, next: &BackendProfile) -> Result<u64, String> {
        self.publish_verified_profile_request(next, None)
    }

    fn publish_verified_profile_request(
        &self,
        next: &BackendProfile,
        verification_ticket: Option<u64>,
    ) -> Result<u64, String> {
        let mut requested = self
            .requested_profile
            .lock()
            .map_err(|_| "Backend profile request lock is poisoned".to_string())?;
        if self.exiting.load(Ordering::SeqCst) {
            return Err("ZeroAgent engine profile activation cancelled".into());
        }
        // Checked under the same lock as begin_profile_verification: an older HTTP response
        // cannot publish after a newer activation request, including a failed newer proof.
        if let Some(ticket) = verification_ticket {
            self.require_profile_verification(ticket)?;
        }
        if requested.0 != *next {
            requested.0 = next.clone();
            requested.1 = requested.1.wrapping_add(1);
            self.shutdown_epoch.fetch_add(1, Ordering::SeqCst);
        }
        Ok(requested.1)
    }

    fn profile_start_epoch(
        &self,
        profile: &BackendProfile,
        ticket: Option<u64>,
    ) -> Result<u64, String> {
        let requested = self
            .requested_profile
            .lock()
            .map_err(|_| "Backend profile request lock is poisoned".to_string())?;
        if self.exiting.load(Ordering::SeqCst)
            || requested.0 != *profile
            || ticket.is_some_and(|ticket| ticket != requested.1)
        {
            return Err("ZeroAgent engine profile activation cancelled".into());
        }
        // Capture while holding the request lock. A later request must invalidate this
        // epoch even when it arrives before ensure_started_with_paths obtains start_lock.
        Ok(self.shutdown_epoch.load(Ordering::SeqCst))
    }

    fn ensure_profile_started(
        self: &Arc<Self>,
        app: &AppHandle,
        profile: &BackendProfile,
        ticket: Option<u64>,
    ) -> Result<KBrainBackendConnection, String> {
        let epoch = self.profile_start_epoch(profile, ticket)?;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve ZeroAgent app data directory: {error}"))?;
        let binary = resolve_binary()?;
        // Never inherit another product's data root or silently import unowned history.
        let connection = self.ensure_started_with_paths(
            binary,
            profile.backend_dir(&data_dir),
            None,
            epoch,
            #[cfg(test)]
            false,
        )?;
        #[cfg(desktop)]
        if self.host_bridge_epoch_live(epoch) {
            if let Err(error) = self.ensure_host_bridge(app, &connection, epoch) {
                eprintln!("ZeroAgent host bridge is unavailable: {error}");
            }
        }
        Ok(connection)
    }

    #[cfg(desktop)]
    fn ensure_host_bridge(
        self: &Arc<Self>,
        app: &AppHandle,
        connection: &KBrainBackendConnection,
        epoch: u64,
    ) -> Result<(), String> {
        use crate::{runtime::terminal::TerminalSessionRegistry, services::gateway::GatewayController};
        let manager = self
            .manager
            .lock()
            .map_err(|_| "Backend state unavailable")?
            .as_ref()
            .cloned()
            .ok_or("Backend is unavailable")?;
        // A manager with this broker has already verified the sidecar bytes
        // against the compiled provenance. Do not hash the binary on reconnect.
        let receipt: serde_json::Value = serde_json::from_str(env!("ZEROAGENT_MCP_BRIDGE_RECEIPT"))
            .map_err(|_| "Native capability receipt is invalid")?;
        if !receipt
            .pointer("/zeroagentPatchSet/capabilities")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some(super::host_bridge::CAPABILITY)))
            || manager.mcp_credential_capability().is_none()
        {
            return Ok(());
        }
        let actual = manager.connection();
        if actual.token != connection.token || actual.base_url != connection.base_url {
            return Err("Backend connection changed".into());
        }
        let mut bridge = manager
            .host_bridge
            .lock()
            .map_err(|_| "Host bridge state unavailable")?;
        if bridge.as_ref().is_some_and(|(owner, _)| *owner == epoch) {
            return Ok(());
        }
        bridge.take();
        let lease = self
            .profile_liveness
            .lock()
            .map_err(|_| "Account profile lease unavailable")?
            .as_ref()
            .cloned()
            .ok_or("A verified account session is required")?;
        let public = self.connection_tx.borrow().clone().ok_or("Backend facade is unavailable")?;
        let gateway = app
            .try_state::<Arc<GatewayController>>()
            .ok_or("Gateway controller is unavailable")?;
        let terminals = app
            .try_state::<Arc<TerminalSessionRegistry>>()
            .ok_or("Terminal registry is unavailable")?;
        let backend = Arc::downgrade(self);
        let process = Arc::downgrade(&manager);
        let is_live = move || {
            lease.load(Ordering::SeqCst)
                && backend.upgrade().is_some_and(|state| state.host_bridge_epoch_live(epoch))
                && process.upgrade().is_some_and(|manager| manager.is_running())
        };
        if !is_live() {
            return Err("Backend or account session ended".into());
        }
        let registration = super::host_bridge::HostBridge::start(
            actual, &public.base_url, Arc::clone(terminals.inner()), gateway.inner(), is_live,
        )?;
        *bridge = Some((epoch, registration));
        Ok(())
    }

    #[cfg(desktop)]
    fn host_bridge_epoch_live(&self, epoch: u64) -> bool {
        self.profile_initialized.load(Ordering::SeqCst)
            && self.account_bound.load(Ordering::SeqCst)
            && self.account_live.load(Ordering::SeqCst)
            && !self.exiting.load(Ordering::SeqCst)
            && self.shutdown_epoch.load(Ordering::SeqCst) == epoch
    }

    fn activate_profile(
        self: &Arc<Self>,
        app: &AppHandle,
        identity: &VerifiedProfile,
        verification_ticket: u64,
        session_handle: Option<&str>,
        liveness: Arc<AtomicBool>,
    ) -> Result<KBrainBackendConnection, String> {
        if !liveness.load(Ordering::SeqCst) {
            return Err("USA-Zero account session changed".into());
        }
        let account_scope = identity.account_scope();
        let next = BackendProfile::from_account_scope(account_scope)?;
        // Publish cancellation before waiting for a cold start's active-profile lock.
        let ticket = self.publish_verified_profile_request(&next, Some(verification_ticket))?;
        let mut profile = self
            .profile
            .lock()
            .map_err(|_| "Backend profile lock is poisoned".to_string())?;
        self.profile_start_epoch(&next, Some(ticket))?;
        self.require_profile_verification(verification_ticket)?;
        let binding_changed = self
            .bound_session
            .lock()
            .map_err(|_| "Account profile binding failed")?
            .as_deref()
            != session_handle;
        if *profile != next || binding_changed {
            if let Some(gateway) =
                app.try_state::<Arc<crate::services::gateway::GatewayController>>()
            {
                gateway.disconnect_runtime()?;
                gateway.shutdown_local_gateway();
            }
            self.shutdown();
            // The logical scope is already cleared even if deleting an obsolete OS entry fails.
            // That entry is never consulted by the new runner, so local model use can proceed.
            let _ = crate::services::device_credentials::deactivate_device_credential();
            if self.profile_initialized.load(Ordering::SeqCst) {
                // Native settings operations, terminal registries and subscriptions can outlive
                // a WebView reload. End the old process before another account can use them.
                self.exiting.store(true, Ordering::SeqCst);
                if let Some(allow_exit) = app.try_state::<Arc<AtomicBool>>() {
                    allow_exit.store(true, Ordering::SeqCst);
                }
                app.restart();
            }
            crate::commands::settings::set_active_config_profile(next.clone())?;
            *profile = next;
        }
        *self
            .bound_session
            .lock()
            .map_err(|_| "Account profile binding failed")? = session_handle.map(str::to_string);
        *self
            .profile_liveness
            .lock()
            .map_err(|_| "Account profile liveness failed")? = Some(liveness);
        self.account_bound
            .store(session_handle.is_some(), Ordering::SeqCst);
        self.account_live
            .store(session_handle.is_some(), Ordering::SeqCst);
        crate::services::device_credentials::set_active_account_scope(account_scope)?;
        // A failed backend startup must still bind this process to its selected profile:
        // native registries may already contain work for it before a later retry/switch.
        self.profile_initialized.store(true, Ordering::SeqCst);
        if !self.profile_lease_live() {
            return Err("USA-Zero account session changed".into());
        }
        #[cfg(desktop)]
        crate::start_native_profile_services(app)?;
        self.ensure_profile_started(app, &profile, Some(ticket))
    }

    #[cfg(test)]
    fn ensure_started_with_binary(
        self: &Arc<Self>,
        binary: PathBuf,
        app_data_dir: PathBuf,
    ) -> Result<KBrainBackendConnection, String> {
        self.ensure_started_with_paths(
            binary,
            app_data_dir,
            None,
            self.shutdown_epoch.load(Ordering::SeqCst),
            false,
        )
    }

    #[cfg(test)]
    fn ensure_started_with_capabilityless_fixture(
        self: &Arc<Self>,
        binary: PathBuf,
        app_data_dir: PathBuf,
    ) -> Result<KBrainBackendConnection, String> {
        self.ensure_started_with_paths(
            binary,
            app_data_dir,
            None,
            self.shutdown_epoch.load(Ordering::SeqCst),
            true,
        )
    }

    fn ensure_started_with_paths(
        self: &Arc<Self>,
        binary: PathBuf,
        app_data_dir: PathBuf,
        legacy_desktop_dir: Option<PathBuf>,
        epoch: u64,
        #[cfg(test)] fixture_without_mcp: bool,
    ) -> Result<KBrainBackendConnection, String> {
        let cancelled = || {
            self.exiting.load(Ordering::SeqCst)
                || !self.profile_lease_live()
                || self.shutdown_epoch.load(Ordering::SeqCst) != epoch
        };
        let _start_guard = self
            .start_lock
            .lock()
            .map_err(|_| "ZeroAgent engine start lock is poisoned".to_string())?;

        if cancelled() {
            return Err("ZeroAgent engine startup cancelled".into());
        }
        let existing = {
            let guard = self
                .manager
                .lock()
                .map_err(|_| "ZeroAgent engine state is poisoned".to_string())?;
            guard.as_ref().cloned()
        };
        if let Some(manager) = existing {
            if manager.is_running() {
                let public = manager.public_connection(
                    self.transport_profile_lease()?,
                    self.facade_configuration(&manager)?,
                )?;
                self.remember_transport_credentials(&manager.connection(), &public)?;
                self.publish_public_connection(public);
                return Ok(manager.connection());
            }
            // The snapshot above deliberately drops the state mutex before
            // probing/removing a dead process; do not nest manager locks.
            let stale = self
                .manager
                .lock()
                .map_err(|_| "ZeroAgent engine state is poisoned".to_string())?
                .take();
            if let Some(stale) = stale {
                stale.shutdown();
                self.connection_tx.send_replace(None);
            }
        }

        // Convert startup panics before unwinding through the serialization lock.
        #[cfg(not(test))]
        let mcp_owner = if supports_native_mcp_credentials(&binary)? {
            Some(McpCredentialOwner {
                settings_root: crate::commands::settings::config_dir()?,
                profile_live: self.transport_profile_lease()?,
                #[cfg(desktop)]
                device_skills: self.device_skill_account()?,
            })
        } else {
            None
        };
        #[cfg(test)]
        let mcp_owner = if !fixture_without_mcp && supports_native_mcp_credentials(&binary)? {
            Some(McpCredentialOwner {
                settings_root: crate::commands::settings::config_dir()?,
                profile_live: self.transport_profile_lease()?,
                #[cfg(desktop)]
                device_skills: self.device_skill_account()?,
            })
        } else {
            None
        };
        let manager = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            KBrainBackendManager::start(
                binary,
                app_data_dir,
                legacy_desktop_dir,
                STARTUP_TIMEOUT,
                &cancelled,
                mcp_owner,
            )
        }))
        .map_err(|_| "ZeroAgent engine startup panicked".to_string())??;
        if cancelled() {
            return Err("ZeroAgent engine startup cancelled".into());
        }
        let connection = manager.connection();
        if let Some(capability) = manager.mcp_credential_capability() {
            let mut known = self
                .transport_credentials
                .lock()
                .map_err(|_| "Backend credential guard unavailable")?;
            if !known.contains(&capability) {
                known.push(capability);
            }
        }
        let public = manager.public_connection(
            self.transport_profile_lease()?,
            self.facade_configuration(&manager)?,
        )?;
        if cancelled() {
            return Err("ZeroAgent engine startup cancelled".into());
        }
        self.remember_transport_credentials(&connection, &public)?;
        self.manager
            .lock()
            .map_err(|_| "ZeroAgent engine state is poisoned".to_string())?
            .replace(manager);
        self.publish_public_connection(public);
        Ok(connection)
    }

    fn transport_profile_lease(&self) -> Result<Arc<AtomicBool>, String> {
        self.profile_liveness
            .lock()
            .map_err(|_| "Account profile lease failed".into())
            .map(|lease| {
                lease
                    .clone()
                    .unwrap_or_else(|| Arc::new(AtomicBool::new(true)))
            })
    }

    #[cfg(desktop)]
    fn device_skill_account(
        &self,
    ) -> Result<Option<crate::services::account_session::device_skills::DeviceSkillAccount>, String>
    {
        use crate::services::account_session::device_skills::{DeviceSkillAccount, PROTOCOL};

        let receipt: serde_json::Value = serde_json::from_str(env!("ZEROAGENT_MCP_BRIDGE_RECEIPT"))
            .map_err(|_| "Native capability receipt is invalid")?;
        if !receipt
            .pointer("/zeroagentPatchSet/capabilities")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(PROTOCOL)))
        {
            return Ok(None);
        }
        let handle = self
            .bound_session
            .lock()
            .map_err(|_| "Account profile binding failed")?
            .clone();
        Ok(self
            .account_sessions
            .as_ref()
            .cloned()
            .zip(handle)
            .map(|(session, handle)| DeviceSkillAccount::new(session, handle)))
    }

    fn publish_public_connection(&self, connection: PublicBackendConnection) {
        self.connection_tx.send_if_modified(|current| {
            if current.as_ref().is_some_and(|old| {
                old.base_url == connection.base_url && old.token == connection.token
            }) {
                return false;
            }
            *current = Some(connection);
            true
        });
    }

    fn remember_transport_credentials(
        &self,
        private: &KBrainBackendConnection,
        public: &PublicBackendConnection,
    ) -> Result<(), String> {
        let mut known = self
            .transport_credentials
            .lock()
            .map_err(|_| "Backend credential guard unavailable")?;
        for value in [&private.token, &public.token] {
            if !known.contains(value) {
                known.push(value.clone());
            }
        }
        Ok(())
    }

    /// Only this profile-owned capability may be serialized to a renderer. Native backup,
    /// model/runtime adapters and the installed Gateway keep their private connection.
    fn facade_configuration(
        self: &Arc<Self>,
        manager: &KBrainBackendManager,
    ) -> Result<Arc<dyn crate::services::backend_facade::ConfigurationHttpService>, String> {
        crate::commands::settings::configuration_http_service(
            Arc::downgrade(self),
            manager.connection(),
            manager.configuration_root(),
        )
    }

    fn viewer_connection(
        self: &Arc<Self>,
        expected: &KBrainBackendConnection,
    ) -> Result<PublicBackendConnection, String> {
        if !self.profile_lease_live() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let manager = self
            .manager
            .lock()
            .map_err(|_| "Backend state unavailable")?
            .as_ref()
            .cloned()
            .ok_or("Backend is unavailable")?;
        let actual = manager.connection();
        if !manager.is_running()
            || actual.token != expected.token
            || actual.base_url != expected.base_url
        {
            return Err("Backend connection changed".into());
        }
        let public = manager.public_connection(
            self.transport_profile_lease()?,
            self.facade_configuration(&manager)?,
        )?;
        self.remember_transport_credentials(&actual, &public)?;
        Ok(public)
    }

    /// The live backend, without starting one: callers that merely follow
    /// K-Brain (the managed Gateway) must never launch it, e.g. during an update.
    pub fn running_connection(&self) -> Option<KBrainBackendConnection> {
        let manager = self.manager.lock().ok()?.as_ref().cloned()?;
        manager.is_running().then(|| manager.connection())
    }

    pub fn verify_portable_backup(&self, value: &serde_json::Value) -> Result<(), String> {
        let known = self
            .transport_credentials
            .lock()
            .map_err(|_| "Backend credential guard unavailable")?
            .clone();
        fn contains(value: &serde_json::Value, known: &[String]) -> bool {
            let protected = |text: &str| {
                known
                    .iter()
                    .any(|secret| !secret.is_empty() && text.contains(secret))
            };
            match value {
                serde_json::Value::String(text) => protected(text),
                serde_json::Value::Array(items) => items.iter().any(|item| contains(item, known)),
                serde_json::Value::Object(items) => items
                    .iter()
                    .any(|(key, value)| protected(key) || contains(value, known)),
                _ => false,
            }
        }
        if contains(value, &known) {
            return Err("配置包含受保护的运行时凭据，请移除该引用后重试".into());
        }
        if self
            .transport_credentials
            .lock()
            .map_err(|_| "Backend credential guard unavailable")?
            .len()
            != known.len()
        {
            return Err("运行时凭据在操作期间变化，请重试配置操作".into());
        }
        #[cfg(desktop)]
        if let Some(account) = &self.account_sessions {
            let handle = self
                .bound_session
                .lock()
                .map_err(|_| "Account profile binding failed")?
                .clone();
            account.verify_portable_value(handle.as_deref(), value)?;
        } else if self.account_bound.load(Ordering::SeqCst) {
            return Err("Authenticated config operations require the native account guard".into());
        }
        if let Some(broker) = self
            .model_broker
            .lock()
            .map_err(|_| "Managed broker lock failed")?
            .as_ref()
        {
            broker.verify_portable_value(value)?;
        }
        Ok(())
    }

    pub(crate) fn portable_backup_guard(
        &self,
    ) -> Result<Option<crate::services::managed_model_broker::PortableSecretGuard>, String> {
        Ok(self
            .model_broker
            .lock()
            .map_err(|_| "Managed broker lock failed")?
            .as_ref()
            .map(ManagedModelBroker::portable_guard))
    }

    pub fn subscribe_connection(
        &self,
    ) -> tokio::sync::watch::Receiver<Option<PublicBackendConnection>> {
        self.connection_tx.subscribe()
    }

    pub fn shutdown(&self) {
        // Wake the startup/health loops before waiting for serialization.
        self.shutdown_epoch.fetch_add(1, Ordering::SeqCst);
        let Ok(_start_guard) = self.start_lock.lock() else {
            return;
        };
        if let Ok(mut broker) = self.model_broker.lock() {
            broker.take();
        }
        let manager = self.manager.lock().ok().and_then(|mut guard| guard.take());
        if let Some(manager) = manager {
            manager.shutdown();
            self.connection_tx.send_replace(None);
        }
    }

    pub fn shutdown_for_exit(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        self.shutdown();
    }

    /// 把当前应用代理推给运行中的 K-brain（best effort）。持有 start_lock，
    /// 避免与并发启动竞争：启动中的进程要么已用新值 spawn，要么在此之后收到推送。
    /// 未运行时无需推送，下次 spawn 会经 env 读取最新值。
    pub fn push_proxy_setting(&self) {
        let Ok(coordinator) = self.configuration_coordinator() else {
            return;
        };
        let _configuration_guard = coordinator.blocking_lock();
        self.push_proxy_setting_locked();
    }

    /// Caller already owns this profile's configuration gate.
    pub(crate) fn push_proxy_setting_locked(&self) {
        let Ok(_start_guard) = self.start_lock.lock() else {
            return;
        };
        let manager = self
            .manager
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned());
        let Some(manager) = manager.filter(|manager| manager.is_running()) else {
            return;
        };
        let proxy = system_proxy::kbrain_proxy_value();
        if let Err(error) = put_proxy_setting(&manager.connection(), &proxy) {
            eprintln!("failed to push proxy setting to ZeroAgent engine: {error}");
        }
    }
}

fn put_proxy_setting(connection: &KBrainBackendConnection, proxy: &str) -> Result<(), String> {
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("failed to create ZeroAgent engine client: {error}"))?;
    // 错误信息只带状态码，不带代理 URL/凭据。
    client
        .put(format!("{}/v1/network/proxy", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .json(&serde_json::json!({ "proxy": proxy }))
        .send()
        .map_err(|error| format!("request failed: {}", error.without_url()))?
        .error_for_status()
        .map(|_| ())
        .map_err(|error| format!("unexpected status {:?}", error.status()))
}

impl Drop for KBrainBackendManager {
    fn drop(&mut self) {
        if let Ok(facade) = self.facade.get_mut() {
            facade.take();
        }
        if let Ok(process) = self.process.get_mut() {
            if let Some(process) = process.take() {
                drop(process);
            }
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn kbrain_managed_credentials_replace(
    state: State<'_, Arc<KBrainBackendState>>,
    account: State<'_, Arc<AccountSessionState>>,
    session_handle: String,
    provider_ids: Vec<String>,
) -> Result<Vec<ManagedBinding>, String> {
    let _refresh = state.managed_binding_refresh.lock().await;
    let public = account.verified_current(&session_handle).await?;
    let credentials = account
        .managed_credentials(&session_handle, provider_ids)
        .await?;
    let account_scope = public.account_scope;
    let origin = option_env!("ZEROAGENT_USA_ZERO_ORIGIN")
        .unwrap_or("https://usa0.top")
        .to_string();
    let state = Arc::clone(state.inner());
    let result = tauri::async_runtime::spawn_blocking(move || {
        state.register_managed_credentials(&account_scope, &origin, credentials)
    })
    .await
    .map_err(|_| "Managed credential registration task failed".to_string())??;
    account.require_current(&session_handle).await?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSessionCredential {
    session_handle: String,
}

#[cfg(desktop)]
#[tauri::command]
pub async fn kbrain_backend_activate_profile(
    app: AppHandle,
    state: State<'_, Arc<KBrainBackendState>>,
    account: State<'_, Arc<AccountSessionState>>,
    account_credential: Option<NativeSessionCredential>,
) -> Result<ActivatedProfileConnection, String> {
    let state = Arc::clone(state.inner());
    let verification_ticket = state.begin_profile_verification()?;
    let handle = account_credential.map(|value| value.session_handle);
    let identity = if let Some(handle) = handle.as_deref() {
        let summary = account.public_summary(handle).await?;
        crate::services::account_identity::profile_from_native_session(&summary)?
    } else {
        if account.bootstrap().await?.is_some() {
            return Err("Activate the authenticated USA-Zero profile".into());
        }
        crate::services::account_identity::verify_profile_credential(None)?
    };
    if let Some(handle) = handle.as_deref() {
        account.require_current(handle).await?;
    }
    let liveness = account.profile_liveness(handle.as_deref()).await?;
    let handle_after = handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let connection = state.activate_profile(
            &app,
            &identity,
            verification_ticket,
            handle.as_deref(),
            liveness,
        )?;
        state.require_profile_verification(verification_ticket)?;
        Ok::<ActivatedProfileConnection, String>(ActivatedProfileConnection {
            connection: state.viewer_connection(&connection)?,
            account_scope: identity.account_scope().map(str::to_string),
        })
    })
    .await
    .map_err(|_| "Backend profile activation task failed".to_string())??;
    if let Some(handle) = handle_after.as_deref() {
        account.require_current(handle).await?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn kbrain_backend_connection(
    app: AppHandle,
    state: State<'_, Arc<KBrainBackendState>>,
) -> Result<PublicBackendConnection, String> {
    let state = Arc::clone(state.inner());
    let handle = app.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || {
        let private = state.ensure_started(&handle)?;
        state.viewer_connection(&private)
    })
    .await
    .map_err(|error| format!("ZeroAgent engine startup task failed: {error}"))??;
    Ok(connection)
}

fn resolve_binary() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var(DEBUG_BINARY_ENV) {
        let path = PathBuf::from(value.trim());
        if !path.is_absolute() {
            return Err(format!("{DEBUG_BINARY_ENV} must be an absolute path"));
        }
        return Ok(path);
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("failed to locate ZeroAgent executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "ZeroAgent executable has no parent directory".to_string())?;
    let name = if cfg!(windows) {
        "k-brain.exe"
    } else {
        "k-brain"
    };
    Ok(directory.join(name))
}

fn child_status_after_eof(child: &mut Child) -> Result<Option<std::process::ExitStatus>, String> {
    let deadline = Instant::now() + Duration::from_millis(100);
    loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            format!("failed to inspect ZeroAgent engine after stdout EOF: {error}")
        })? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn check_startup_process(
    child: &mut Child,
    events: &std::sync::mpsc::Receiver<StartupEvent>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    if cancelled() {
        return Err("ZeroAgent engine startup cancelled".into());
    }
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("failed to inspect ZeroAgent engine: {error}"))?
    {
        return Err(format!(
            "ZeroAgent engine exited during health check ({status})"
        ));
    }
    match events.try_recv() {
        Ok(StartupEvent::Eof) => Err("ZeroAgent engine stdout closed during health check".into()),
        Ok(StartupEvent::Error(error)) => {
            Err(format!("failed to read ZeroAgent engine output: {error}"))
        }
        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
            Err("ZeroAgent engine output reader disconnected during health check".into())
        }
        Ok(StartupEvent::Ready(_)) | Err(std::sync::mpsc::TryRecvError::Empty) => Ok(()),
    }
}

fn wait_for_health(
    connection: &KBrainBackendConnection,
    deadline: Instant,
    child: &mut Child,
    events: &std::sync::mpsc::Receiver<StartupEvent>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| format!("failed to create ZeroAgent engine health client: {error}"))?;
    let url = format!("{}/v1/health", connection.base_url);
    loop {
        check_startup_process(child, events, cancelled)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("ZeroAgent engine health check timed out".into());
        }
        let result = client
            .get(&url)
            .timeout(remaining.min(Duration::from_millis(500)))
            .header(AUTHORIZATION, format!("Bearer {}", connection.token))
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json::<serde_json::Value>());
        check_startup_process(child, events, cancelled)?;
        if Instant::now() >= deadline {
            return Err("ZeroAgent engine health check timed out".into());
        }
        // 传输或 JSON 错误继续等待；拿到 JSON 后按契约判定，矛盾或类型错误立即失败。
        if let Ok(body) = result {
            return parse_health(&body).map(|_| ());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

fn spawn_stderr_drain(stderr: impl Read + Send + 'static, token: String) -> Result<(), String> {
    thread::Builder::new()
        .name("kbrain-stderr".into())
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            #[cfg(test)]
            let trace_enabled = std::env::var_os("ZEROAGENT_TEST_BACKEND_TRACE").is_some();
            #[cfg(test)]
            let trace_started = Instant::now();
            #[cfg(test)]
            let (mut trace_pending, mut trace_bytes, mut trace_inits, mut trace_last_ms, mut trace_clock_ms) =
                (String::new(), 0usize, 0usize, 0f64, 0f64);

            let mut retained = Vec::with_capacity(MAX_STDERR_BYTES);
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(bytes) => {
                        #[cfg(test)]
                        if trace_enabled {
                            trace_bytes += bytes;
                            trace_pending.push_str(&String::from_utf8_lossy(&buffer[..bytes]));
                            while let Some(end) = trace_pending.find('\n') {
                                let line = &trace_pending[..end];
                                if let Some((_, times)) = line.strip_prefix("init ").and_then(|value| value.split_once(" @")) {
                                    if let Some((at, rest)) = times.split_once(" ms, ") {
                                        if let Some((clock, _)) = rest.split_once(" ms clock") {
                                            if let (Ok(at), Ok(clock)) = (at.parse::<f64>(), clock.parse::<f64>()) {
                                                if at.is_finite() && clock.is_finite() {
                                                    trace_inits += 1; trace_last_ms = at; trace_clock_ms += clock;
                                                }
                                            }
                                        }
                                    }
                                }
                                trace_pending.drain(..=end);
                            }
                            if trace_pending.len() > 4096 { trace_pending.clear(); }
                            eprintln!("backend-stderr-trace elapsed_ms={} bytes={} init_count={} last_init_ms={} init_clock_ms={}",
                                trace_started.elapsed().as_millis(),trace_bytes,trace_inits,trace_last_ms,trace_clock_ms);
                        }
                        let keep = bytes.min(MAX_STDERR_BYTES);
                        if retained.len() < MAX_STDERR_BYTES {
                            let available = MAX_STDERR_BYTES - retained.len();
                            retained.extend_from_slice(&buffer[..keep.min(available)]);
                        }
                    }
                }
            }
            let _diagnostic = String::from_utf8_lossy(&retained).replace(&token, "<redacted>");
        })
        .map_err(|error| format!("failed to start ZeroAgent engine stderr reader: {error}"))?;
    Ok(())
}

fn read_bounded_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(String::from_utf8_lossy(&line).into_owned()))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consume = newline.map(|index| index + 1).unwrap_or(buffer.len());
        let remaining = max_bytes.saturating_sub(line.len());
        if consume > remaining {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ZeroAgent engine stdout line exceeds limit",
            ));
        }
        line.extend_from_slice(&buffer[..consume]);
        reader.consume(consume);
        if newline.is_some() {
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
    }
}

fn parse_ready_url(line: &str) -> Option<String> {
    let candidate = line.trim().strip_prefix(READY_PREFIX)?.trim();
    let url = tauri::Url::parse(candidate).ok()?;
    if url.scheme() != "http"
        || url.host_str()? != "127.0.0.1"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return None;
    }
    let port = url.port()?;
    if port == 0 {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    include!("kbrain_backend/mcp_oauth_sse_fixture.rs");
    include!("kbrain_backend/mcp_oauth_tests.rs");
    include!("kbrain_backend/managed_model_discovery_tests.rs");
    include!("kbrain_backend/prompt_cache_tests.rs");
    #[cfg(desktop)]
    include!("kbrain_backend/remote_managed_bindings_tests.rs");

    #[test]
    fn native_configuration_rebinds_managed_transport_and_rejects_external_providers() {
        let state = KBrainBackendState::default();
        state.profile_initialized.store(true, Ordering::SeqCst);
        let broker =
            ManagedModelBroker::start(configured_origin("https://usa0.top").unwrap()).unwrap();
        broker
            .replace(vec![ManagedCredential {
                provider_id: "relay-key-7".into(),
                api_key: "synthetic-owned-platform-key".into(),
            }])
            .unwrap();
        *state.model_broker.lock().unwrap() = Some(broker);
        let input = serde_json::json!({"providers":[{"id":"relay-key-7","api":"openai-responses","baseUrl":"https://external.invalid","modelsUrl":"https://external.invalid/models","apiKey":"external-key","isFullUrl":true,"customHeaders":[{"key":"X-Target","value":"external"}],"useSystemProxy":true,"models":[{"id":"custom/glm-5","displayName":"Alias","contextWindow":131072,"maxOutputToken":8192}],"activeModels":[]}]});
        let output = state.prepare_configuration_settings(input).unwrap();
        let binding = state
            .model_broker
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .binding("relay-key-7")
            .unwrap()
            .unwrap();
        let provider = &output["providers"][0];
        assert_eq!(provider["baseUrl"], binding.base_url);
        assert_eq!(provider["apiKey"], binding.api_key);
        assert_eq!(provider["modelsUrl"], "");
        assert_eq!(provider["isFullUrl"], false);
        assert_eq!(provider["customHeaders"], serde_json::json!([]));
        assert_eq!(provider["activeModels"], serde_json::json!([]));
        assert_eq!(provider["models"][0]["displayName"], "Alias");
        assert!(state.prepare_configuration_settings(serde_json::json!({"providers":[{"id":"external","baseUrl":"https://external.invalid"}]})).is_err());
    }

    #[test]
    fn delayed_identity_response_cannot_override_newer_profile_verification() {
        let state = Arc::new(KBrainBackendState::default());
        let account_a =
            BackendProfile::from_account_scope(Some("https://usa0.top|user:7")).unwrap();
        let account_b =
            BackendProfile::from_account_scope(Some("https://usa0.top|user:8")).unwrap();
        let old = state.begin_profile_verification().unwrap();
        let (release, delayed) = std::sync::mpsc::channel();
        let old_state = state.clone();
        let old_response = thread::spawn(move || {
            delayed.recv().unwrap();
            old_state.publish_verified_profile_request(&account_a, Some(old))
        });
        let latest = state.begin_profile_verification().unwrap();
        let current = state
            .publish_verified_profile_request(&account_b, Some(latest))
            .unwrap();
        release.send(()).unwrap();
        assert!(old_response
            .join()
            .unwrap()
            .unwrap_err()
            .contains("superseded"));
        assert_eq!(
            *state.requested_profile.lock().unwrap(),
            (account_b.clone(), current)
        );
        assert!(state.profile_start_epoch(&account_b, Some(current)).is_ok());
        assert!(state.running_connection().is_none());
        assert!(!state.profile_initialized.load(Ordering::SeqCst));
    }

    #[test]
    fn verification_starts_without_active_lock_and_failed_new_proof_does_not_bind_a_profile() {
        let state = Arc::new(KBrainBackendState::default());
        let active = state.profile.lock().unwrap();
        let old = state.begin_profile_verification().unwrap();
        let latest = state.begin_profile_verification().unwrap();
        let account = BackendProfile::from_account_scope(Some("https://usa0.top|user:7")).unwrap();
        // The newer HTTP request failed: it never publishes a profile. The old response
        // must nevertheless remain obsolete, with no implicit offline/account activation.
        assert!(state
            .publish_verified_profile_request(&account, Some(old))
            .is_err());
        assert_eq!(
            *state.requested_profile.lock().unwrap(),
            (BackendProfile::Local, 0)
        );
        assert!(state.require_profile_verification(latest).is_ok());
        assert!(!state.profile_initialized.load(Ordering::SeqCst));
        drop(active);
        let offline = state.begin_profile_verification().unwrap();
        state
            .publish_verified_profile_request(&BackendProfile::Local, Some(offline))
            .unwrap();
        assert!(state.require_profile_verification(latest).is_err());
        state.exiting.store(true, Ordering::SeqCst);
        assert!(state.begin_profile_verification().is_err());
    }

    static CHILD_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_dir() -> TempDir {
        let root = std::env::var_os("ZEROAGENT_BACKEND_TEST_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        tempfile::Builder::new()
            .prefix("kbrain-native-")
            .tempdir_in(root)
            .expect("test directory")
    }

    /// 单请求 HTTP 桩：返回给定状态码，并把收到的原始请求交回。
    fn proxy_endpoint_stub(status: &'static str) -> (String, thread::JoinHandle<String>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let base_url = format!("http://{}", listener.local_addr().expect("stub addr"));
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).expect("read request");
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request);
                if read == 0
                    || text
                        .split_once("\r\n\r\n")
                        .is_some_and(|(_, b)| b.ends_with('}'))
                {
                    break;
                }
            }
            let response =
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            String::from_utf8_lossy(&request).into_owned()
        });
        (base_url, handle)
    }

    #[test]
    fn storage_identity_is_stable_and_data_root_scoped() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let id = backend_storage_id(root.path()).unwrap();
        assert_eq!(id, backend_storage_id(&root.path().join(".")).unwrap());
        assert_ne!(id, backend_storage_id(other.path()).unwrap());
        assert!(!id.contains(root.path().to_string_lossy().as_ref()));
        #[cfg(unix)]
        {
            let link_parent = tempfile::tempdir().unwrap();
            let link = link_parent.path().join("alias");
            std::os::unix::fs::symlink(root.path(), &link).unwrap();
            assert_eq!(id, backend_storage_id(&link).unwrap());
        }
    }

    #[test]
    fn profile_request_cancels_without_waiting_for_the_active_profile_lock() {
        let state = Arc::new(KBrainBackendState::default());
        let next = BackendProfile::from_account_scope(Some("https://usa0.top|user:7")).unwrap();
        let active = state.profile.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker_state = state.clone();
        let worker_profile = next.clone();
        let worker = thread::spawn(move || {
            tx.send(worker_state.publish_profile_request(&worker_profile))
                .unwrap();
        });
        let requested_while_locked = rx.recv_timeout(Duration::from_secs(5));
        drop(active);
        worker.join().unwrap();
        let ticket = requested_while_locked
            .expect("profile request waited for the old startup lock")
            .unwrap();
        assert_eq!(state.shutdown_epoch.load(Ordering::SeqCst), 1);
        assert!(state
            .profile_start_epoch(&BackendProfile::Local, None)
            .is_err());
        assert_eq!(state.profile_start_epoch(&next, Some(ticket)).unwrap(), 1);
        assert_eq!(state.publish_profile_request(&next).unwrap(), ticket);
        assert_eq!(state.shutdown_epoch.load(Ordering::SeqCst), 1);
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn native_config_guard_uses_account_secrets_before_any_model_broker_registration() {
        let fixture = crate::services::account_session::tests::Fixture::new().await;
        let a = fixture.login("a", false).await;
        fixture
            .state
            .public_summary(&a.session_handle)
            .await
            .unwrap();
        let state = KBrainBackendState::with_account_sessions(fixture.state.clone());
        *state.bound_session.lock().unwrap() = Some(a.session_handle.clone());
        state.account_bound.store(true, Ordering::SeqCst);
        assert!(state.model_broker.lock().unwrap().is_none());
        state.verify_portable_backup(&serde_json::json!({"archivedProviders":[{"id":"own-custom","apiKey":"self-hosted-secret"}]})).unwrap();
        for secret in ["sk-managed-a", "sk-inactive-a", "access-a", "refresh-a"] {
            assert!(state
                .verify_portable_backup(
                    &serde_json::json!({"mcp":{"env":{"ALIAS":format!("prefix {secret} suffix")}}})
                )
                .is_err());
        }
        let b = fixture.login("b", false).await;
        assert!(state
            .verify_portable_backup(&serde_json::json!({"safe":true}))
            .is_err());
        fixture
            .state
            .require_current(&b.session_handle)
            .await
            .unwrap();
        let unbound = KBrainBackendState::default();
        unbound.account_bound.store(true, Ordering::SeqCst);
        assert!(unbound
            .verify_portable_backup(&serde_json::json!({"safe":true}))
            .is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn bridge_epoch_requires_a_live_bound_account_and_changes_before_backend_shutdown() {
        let state = KBrainBackendState::default();
        assert!(!state.host_bridge_epoch_live(0));
        state.profile_initialized.store(true, Ordering::SeqCst);
        state.account_bound.store(true, Ordering::SeqCst);
        state.account_live.store(true, Ordering::SeqCst);
        assert!(state.host_bridge_epoch_live(0));
        state.shutdown();
        assert!(!state.host_bridge_epoch_live(0));
        assert!(state.host_bridge_epoch_live(1));
        state.account_live.store(false, Ordering::SeqCst);
        assert!(!state.host_bridge_epoch_live(1));
    }

    #[test]
    fn portable_guard_retains_current_and_retired_backend_authorities_after_shutdown() {
        let state = Arc::new(KBrainBackendState::default());
        let mut private = KBrainBackendConnection {
            base_url: "http://127.0.0.1:1".into(),
            token: "private-runtime-credential".into(),
            protocol_version: PROTOCOL_VERSION.into(),
            storage_id: "profile-a".into(),
        };
        let mut public = PublicBackendConnection {
            base_url: "http://127.0.0.1:2".into(),
            token: "za-backend-current-capability".into(),
            protocol_version: PROTOCOL_VERSION.into(),
            storage_id: "profile-a".into(),
        };
        state
            .remember_transport_credentials(&private, &public)
            .unwrap();
        private.token = "private-runtime-rotated".into();
        public.token = "za-backend-next-capability".into();
        state
            .remember_transport_credentials(&private, &public)
            .unwrap();
        state.shutdown();
        for secret in [
            "private-runtime-credential",
            "za-backend-current-capability",
            "private-runtime-rotated",
            "za-backend-next-capability",
        ] {
            for value in [
                serde_json::json!({"mcp":{"env":{"alias":format!("prefix {secret} suffix")}}}),
                serde_json::json!({format!("field-{secret}"):"safe"}),
            ] {
                assert!(state.verify_portable_backup(&value).is_err());
            }
        }
        state.verify_portable_backup(&serde_json::json!({"archivedProviders":[{"id":"own","apiKey":"own-self-hosted-secret"}]})).unwrap();
    }

    #[test]
    fn an_expired_account_lease_blocks_commands_and_late_startup_before_creating_data() {
        let state = Arc::new(KBrainBackendState::default());
        let live = Arc::new(AtomicBool::new(true));
        *state.profile_liveness.lock().unwrap() = Some(live.clone());
        state.profile_initialized.store(true, Ordering::SeqCst);
        state.account_bound.store(true, Ordering::SeqCst);
        state.account_live.store(true, Ordering::SeqCst);
        assert!(state.allows_profile_commands());
        live.store(false, Ordering::SeqCst);
        assert!(!state.allows_profile_commands());
        let temp = test_dir();
        let data = temp.path().join("account-must-not-start");
        let error = state
            .ensure_started_with_paths(
                temp.path().join("absent-backend"),
                data.clone(),
                None,
                0,
                false,
            )
            .err()
            .unwrap();
        assert_eq!(error, "ZeroAgent engine startup cancelled");
        assert!(!data.exists());
    }

    #[test]
    fn superseded_profile_epoch_cannot_spawn_or_create_a_data_root() {
        let state = Arc::new(KBrainBackendState::default());
        let initial_ticket = state
            .publish_profile_request(&BackendProfile::Local)
            .unwrap();
        let initial_epoch = state
            .profile_start_epoch(&BackendProfile::Local, Some(initial_ticket))
            .unwrap();
        let next = BackendProfile::from_account_scope(Some("https://usa0.top|user:7")).unwrap();
        state.publish_profile_request(&next).unwrap();
        let current_ticket = state
            .publish_profile_request(&BackendProfile::Local)
            .unwrap();
        assert!(state
            .profile_start_epoch(&BackendProfile::Local, Some(initial_ticket))
            .is_err());
        let temp = test_dir();
        let data = temp.path().join("must-not-be-created");
        let error = state
            .ensure_started_with_paths(
                temp.path().join("missing-backend"),
                data.clone(),
                None,
                initial_epoch,
                false,
            )
            .expect_err("superseded start must be rejected before spawning");
        assert!(error.contains("cancelled"));
        assert!(!data.exists());
        assert!(state.running_connection().is_none());
        assert!(state.subscribe_connection().borrow().is_none());
        state.shutdown_for_exit();
        assert!(state.publish_profile_request(&next).is_err());
        assert!(state
            .profile_start_epoch(&BackendProfile::Local, Some(current_ticket))
            .is_err());
    }

    #[test]
    fn put_proxy_setting_sends_authorized_json_and_hides_value_on_failure() {
        let proxy = "socks5h://user:secret@proxy.local:1080";
        let connection = |base_url: String| KBrainBackendConnection {
            base_url,
            token: "test-token".into(),
            protocol_version: PROTOCOL_VERSION.into(),
            storage_id: "test-storage".into(),
        };

        let (base_url, handle) = proxy_endpoint_stub("200 OK");
        put_proxy_setting(&connection(base_url), proxy).expect("push accepted");
        let request = handle.join().expect("stub thread");
        assert!(request.starts_with("PUT /v1/network/proxy HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token\r\n"));
        assert!(request.ends_with(r#"{"proxy":"socks5h://user:secret@proxy.local:1080"}"#));

        let (base_url, handle) = proxy_endpoint_stub("400 Bad Request");
        let error = put_proxy_setting(&connection(base_url), proxy).expect_err("push rejected");
        handle.join().expect("stub thread");
        assert!(error.contains("400"), "{error}");
        assert!(!error.contains("secret") && !error.contains("proxy.local"));
    }

    #[test]
    fn push_proxy_setting_is_a_noop_without_a_running_backend() {
        KBrainBackendState::default().push_proxy_setting();
    }

    #[test]
    fn parses_only_strict_loopback_ready_urls() {
        assert_eq!(
            parse_ready_url("k-brain backend listening on http://127.0.0.1:41234"),
            Some("http://127.0.0.1:41234".to_string())
        );
        for line in [
            "ready http://127.0.0.1:41234",
            "k-brain backend listening on http://localhost:41234",
            "k-brain backend listening on http://127.0.0.1:41234/path",
            "k-brain backend listening on http://user:pass@127.0.0.1:41234/",
            "k-brain backend listening on http://127.0.0.1:41234/?x=1",
            "k-brain backend listening on http://192.168.1.2:41234/",
        ] {
            assert_eq!(
                parse_ready_url(line),
                None,
                "accepted invalid ready line: {line}"
            );
        }
    }

    #[cfg(unix)]
    fn fixture_binary(temp: &TempDir, mode: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = temp.path().join(format!("kbrain-fixture-{mode}"));
        let script = r##"#!/usr/bin/env python3
import json
import os
from pathlib import Path
import select
import signal
import socket
import sys
import threading
import time

mode = os.path.basename(sys.argv[0]).split("kbrain-fixture-", 1)[-1]
data = Path(sys.argv[sys.argv.index("-data-dir") + 1])
data.mkdir(parents=True, exist_ok=True)
(data / "fixture.pid").write_text(str(os.getpid()))
if mode == "oversized":
    print("x" * 20000, flush=True)
    time.sleep(30)
if mode == "error":
    print("fixture startup failure", file=sys.stderr, flush=True)
    sys.exit(23)
if mode == "timeout":
    time.sleep(30)
    sys.exit(0)
if mode == "stdout-close":
    os.close(1)
    time.sleep(30)
    sys.exit(0)

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(8)
port = server.getsockname()[1]
if mode == "pre-ready":
    for index in range(12):
        print(f"fixture pre-ready {index}", flush=True)
print(f"k-brain backend listening on http://127.0.0.1:{port}", flush=True)
if mode == "health-close":
    os.close(1)
    time.sleep(30)

def parent_watch():
    sys.stdin.buffer.read()
    if mode == "parent-loss":
        os._exit(0)

threading.Thread(target=parent_watch, daemon=True).start()
if mode == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
token = os.environ["K_BRAIN_BACKEND_TOKEN"]
while True:
    ready, _, _ = select.select([server], [], [], 0.1)
    if not ready:
        continue
    conn, _ = server.accept()
    try:
        request = conn.recv(4096)
        if mode == "health-hang":
            (data / "health-started").touch()
            time.sleep(30)
        authorized = (f"authorization: bearer {token}".encode() in request.lower())
        if b"/v1/health" in request and authorized:
            body = json.dumps({"status": "ok", "version": "kbrain.agent.v1"}).encode()
            response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body
        else:
            body = b"unauthorized"
            response = b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\nConnection: close\r\n\r\n" + body
        conn.sendall(response)
    finally:
        conn.close()
"##;
        fs::write(&path, script).expect("fixture script");
        let mut permissions = fs::metadata(&path).expect("fixture metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).expect("fixture executable");
        path
    }

    #[cfg(unix)]
    fn assert_fixture_reaped(data: &std::path::Path) {
        let pid_path = data.join("fixture.pid");
        let deadline = Instant::now() + Duration::from_secs(1);
        let pid = loop {
            if let Ok(pid) = fs::read_to_string(&pid_path) {
                break pid;
            }
            assert!(Instant::now() < deadline, "fixture pid was not recorded");
            thread::sleep(Duration::from_millis(10));
        };
        assert_fixture_pid_absent(&pid, deadline);
    }

    #[cfg(unix)]
    fn assert_fixture_pid_absent(pid: &str, deadline: Instant) {
        loop {
            let output = Command::new("ps")
                .args(["-p", pid.trim(), "-o", "pid="])
                .output()
                .expect("ps");
            if output.stdout.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "fixture still exists: {pid}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn assert_fixture_reaped_if_recorded(data: &std::path::Path) {
        if let Ok(pid) = fs::read_to_string(data.join("fixture.pid")) {
            assert_fixture_pid_absent(&pid, Instant::now() + Duration::from_secs(1));
        }
    }

    #[cfg(unix)]
    #[test]
    fn fixture_read_errors_and_health_eof_are_propagated_and_reaped() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (mode, expected) in [
            ("oversized", "stdout line exceeds limit"),
            ("health-close", "stdout closed during health check"),
        ] {
            let temp = test_dir();
            let data = temp.path().join("data");
            let started = Instant::now();
            let error = KBrainBackendManager::start_with_binary_and_timeout(
                fixture_binary(&temp, mode),
                data.clone(),
                Duration::from_secs(5),
            )
            .err()
            .expect("startup should fail");
            assert!(error.contains(expected), "{mode}: {error}");
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_fixture_reaped(&data);
        }
    }

    #[cfg(unix)]
    #[test]
    fn fixture_health_timeout_is_bounded_and_reaped() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let data = temp.path().join("data");
        let started = Instant::now();
        let error = KBrainBackendManager::start_with_binary_and_timeout(
            fixture_binary(&temp, "health-hang"),
            data.clone(),
            Duration::from_secs(3),
        )
        .err()
        .expect("health should time out");
        assert!(error.contains("health check timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_fixture_reaped(&data);
    }

    #[cfg(unix)]
    #[test]
    fn fixture_shutdown_cancels_startup_and_health_and_allows_retry() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (mode, marker) in [
            ("timeout", "fixture.pid"),
            ("health-hang", "health-started"),
        ] {
            let temp = test_dir();
            let data = temp.path().join("data");
            let binary = fixture_binary(&temp, mode);
            let state = Arc::new(KBrainBackendState::default());
            let worker_state = Arc::clone(&state);
            let worker_data = data.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                let _ = tx.send(
                    worker_state.ensure_started_with_capabilityless_fixture(binary, worker_data),
                );
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !data.join(marker).exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(data.join(marker).exists(), "fixture never entered {mode}");
            let started = Instant::now();
            state.shutdown();
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "shutdown took too long"
            );
            let error = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("startup result")
                .expect_err("startup should be cancelled");
            assert!(error.contains("cancelled"), "{error}");
            worker.join().expect("startup worker");
            assert_fixture_reaped(&data);
            assert!(state.manager.lock().expect("manager lock").is_none());
            state
                .ensure_started_with_capabilityless_fixture(
                    fixture_binary(&temp, "parent-loss"),
                    data.clone(),
                )
                .expect("start after cancellation");
            state.shutdown();
            assert_fixture_reaped(&data);
        }
    }

    #[test]
    fn running_connection_without_a_backend_is_none_and_never_starts_one() {
        let state = Arc::new(KBrainBackendState::default());
        assert!(state.running_connection().is_none());
        assert!(
            state.manager.lock().unwrap().is_none(),
            "reading must not launch K-Brain"
        );
        assert!(state.subscribe_connection().borrow().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn connection_changes_are_published_for_followers_like_the_gateway() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "parent-loss");
        let data = temp.path().join("data");
        let state = Arc::new(KBrainBackendState::default());
        let mut changes = state.subscribe_connection();
        let started = state
            .ensure_started_with_capabilityless_fixture(binary, data.clone())
            .expect("backend");
        assert!(changes.has_changed().unwrap(), "start must notify");
        let published = changes
            .borrow_and_update()
            .clone()
            .expect("public transport");
        assert_ne!(published.base_url, started.base_url);
        assert_ne!(published.token, started.token);
        assert!(published.token.starts_with("za-backend-"));
        assert_eq!(published.storage_id, started.storage_id);
        assert_eq!(
            state.running_connection().map(|c| c.token),
            Some(started.token.clone())
        );
        state.shutdown();
        assert!(changes.has_changed().unwrap(), "shutdown must notify");
        assert!(changes.borrow_and_update().is_none());
        assert!(state.running_connection().is_none());
        assert_fixture_reaped(&data);
    }

    #[cfg(unix)]
    #[test]
    fn exit_stops_only_owned_backend_and_prevents_restart() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "parent-loss");
        let state = Arc::new(KBrainBackendState::default());
        let other = Arc::new(KBrainBackendState::default());
        let own_data = temp.path().join("owned");
        let other_data = temp.path().join("other");
        state
            .ensure_started_with_capabilityless_fixture(binary.clone(), own_data.clone())
            .expect("owned backend");
        other
            .ensure_started_with_capabilityless_fixture(binary.clone(), other_data.clone())
            .expect("other backend");
        let started = Instant::now();
        state.shutdown_for_exit();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_fixture_reaped(&own_data);
        assert!(other.manager.lock().unwrap().as_ref().unwrap().is_running());
        assert!(state
            .ensure_started_with_capabilityless_fixture(binary, own_data)
            .unwrap_err()
            .contains("cancelled"));
        state.shutdown_for_exit();
        other.shutdown_for_exit();
        assert_fixture_reaped(&other_data);
    }

    #[cfg(unix)]
    #[test]
    fn exit_force_stops_unresponsive_owned_backend() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let state = Arc::new(KBrainBackendState::default());
        let data = temp.path().join("data");
        state
            .ensure_started_with_capabilityless_fixture(
                fixture_binary(&temp, "stubborn"),
                data.clone(),
            )
            .expect("backend");
        let started = Instant::now();
        state.shutdown_for_exit();
        assert!(started.elapsed() < STOP_GRACE + Duration::from_secs(1));
        assert_fixture_reaped(&data);
    }

    #[cfg(unix)]
    #[test]
    fn exit_cancels_inflight_startup_and_stays_closed() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "health-hang");
        let data = temp.path().join("data");
        let state = Arc::new(KBrainBackendState::default());
        let worker_state = Arc::clone(&state);
        let worker_data = data.clone();
        let worker_binary = binary.clone();
        let worker = thread::spawn(move || {
            worker_state.ensure_started_with_capabilityless_fixture(worker_binary, worker_data)
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !data.join("health-started").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(data.join("health-started").exists());
        state.shutdown_for_exit();
        assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
        assert_fixture_reaped(&data);
        assert!(state
            .ensure_started_with_capabilityless_fixture(binary, data)
            .unwrap_err()
            .contains("cancelled"));
    }

    #[cfg(unix)]
    #[test]
    fn fixture_ready_survives_more_than_eight_pre_ready_lines() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "pre-ready");
        let manager = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("data"),
            Duration::from_secs(5),
        )
        .expect("ready line must not be dropped");
        assert!(manager
            .connection()
            .base_url
            .starts_with("http://127.0.0.1:"));
        manager.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn fixture_stdout_eof_while_child_is_alive_fails_without_startup_timeout() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "stdout-close");
        let started = Instant::now();
        let result = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("data"),
            Duration::from_secs(5),
        );
        assert!(result
            .err()
            .expect("EOF error")
            .contains("stdout closed before becoming ready"));
        assert_fixture_reaped(&temp.path().join("data"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "EOF was not propagated"
        );
    }

    #[cfg(unix)]
    #[test]
    fn fixture_child_error_and_startup_timeout_are_reported_and_bounded() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "error");
        let error = match KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("error-data"),
            Duration::from_secs(5),
        ) {
            Ok(_) => panic!("child error must fail startup"),
            Err(error) => error,
        };
        assert!(
            error.contains("code 23") || error.contains("stdout closed before becoming ready"),
            "{error}"
        );

        let binary = fixture_binary(&temp, "timeout");
        let started = Instant::now();
        let error = match KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("timeout-data"),
            Duration::from_secs(2),
        ) {
            Ok(_) => panic!("startup timeout must fail"),
            Err(error) => error,
        };
        assert!(error.contains("startup timeout"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_fixture_reaped(&temp.path().join("error-data"));
        // The deadline can expire before the interpreter records its PID.
        assert_fixture_reaped_if_recorded(&temp.path().join("timeout-data"));
    }

    #[cfg(unix)]
    #[test]
    fn fixture_exits_after_manager_parent_stdin_is_lost() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let temp = test_dir();
        let binary = fixture_binary(&temp, "parent-loss");
        let manager = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            temp.path().join("data"),
            Duration::from_secs(5),
        )
        .expect("parent-loss fixture should become ready");
        {
            let mut process = manager.process.lock().expect("process lock");
            process.as_mut().expect("backend process").stdin.take();
        }
        for _ in 0..40 {
            if !manager.is_running() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("backend did not exit after parent stdin loss");
    }

    #[cfg(unix)]
    #[test]
    fn host_does_not_mutate_user_config() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use std::os::unix::fs::PermissionsExt;

        let temp = test_dir();
        let data = temp.path().join("data");
        fs::create_dir_all(&data).expect("data directory");
        let config = data.join(CONFIG_FILE);
        let content = b"{\"language\":\"en\",\"provider\":\"fixture\"}\n";
        fs::write(&config, content).expect("config");
        let mut permissions = fs::metadata(&config)
            .expect("config metadata")
            .permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&config, permissions).expect("insecure config mode");

        let binary = fixture_binary(&temp, "parent-loss");
        let manager = KBrainBackendManager::start_with_binary_and_timeout(
            binary,
            data.clone(),
            Duration::from_secs(5),
        )
        .expect("fixture should start with existing config");
        manager.shutdown();
        assert_eq!(fs::read(&config).expect("config content"), content);
        assert_eq!(
            fs::metadata(&config)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[test]
    #[ignore = "requires an explicit prepared Go backend artifact"]
    fn starts_real_go_backend_checks_auth_stop_restart_and_preserves_config() {
        let _serial = CHILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let binary = std::env::var(TEST_BINARY_ENV)
            .expect("set ZEROAGENT_BACKEND_TEST_BINARY to the built real Go binary");
        let binary = PathBuf::from(binary);
        assert!(binary.is_absolute(), "test binary path must be absolute");
        assert!(
            binary.is_file(),
            "test binary does not exist: {}",
            binary.display()
        );

        let temp = test_dir();
        let config = temp.path().join(CONFIG_FILE);
        fs::create_dir_all(config.parent().unwrap()).expect("config directory");
        fs::write(&config, b"{\"language\":\"en\"}\n").expect("config");
        let original_config = fs::read(&config).expect("read config");

        let state = Arc::new(KBrainBackendState::default());
        state.profile_initialized.store(true, Ordering::SeqCst);
        assert!(
            state
                .ensure_started_with_binary(
                    temp.path().join("missing-k-brain"),
                    temp.path().to_path_buf()
                )
                .is_err(),
            "initial missing binary must fail without preventing retry"
        );

        let first = state
            .ensure_started_with_binary(binary.clone(), temp.path().to_path_buf())
            .expect("real Go backend should start");
        assert_ne!(first.token, "");
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("client");
        let health_url = format!("{}/v1/health", first.base_url);
        let first_public = state.viewer_connection(&first).expect("public transport");
        assert!(state
            .verify_portable_backup(&serde_json::json!({"alias":first_public.token}))
            .is_err());
        assert!(state
            .verify_portable_backup(&serde_json::json!({"alias":first.token}))
            .is_err());
        assert_ne!(first_public.token, first.token);
        assert_ne!(first_public.base_url, first.base_url);
        assert_eq!(first_public.storage_id, first.storage_id);
        let published = state
            .subscribe_connection()
            .borrow()
            .clone()
            .expect("published transport");
        assert_eq!(published.token, first_public.token);
        assert_eq!(
            client
                .get(format!("{}/v1/health", first_public.base_url))
                .bearer_auth(&first.token)
                .send()
                .expect("private token must not authenticate the public transport")
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        for path in [
            "/v1/health",
            "/v1/settings",
            "/v1/mcp",
            "/v1/prompts",
            "/v1/models",
        ] {
            assert!(
                client
                    .get(format!("{}{path}", first_public.base_url))
                    .bearer_auth(&first_public.token)
                    .send()
                    .expect("public backend read")
                    .status()
                    .is_success(),
                "{path}"
            );
        }
        assert_eq!(
            client
                .post(format!(
                    "{}/v1/settings/providers/relay-key-11/secrets",
                    first_public.base_url
                ))
                .bearer_auth(&first_public.token)
                .json(&serde_json::json!({"confirm":true}))
                .send()
                .expect("public secret route")
                .status(),
            reqwest::StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(&health_url)
                .header(AUTHORIZATION, "Bearer wrong-token")
                .send()
                .expect("unauthorized health response")
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        assert!(client
            .get(&health_url)
            .header(AUTHORIZATION, format!("Bearer {}", first.token))
            .send()
            .expect("authorized health response")
            .status()
            .is_success());
        let first_manager = {
            let guard = state.manager.lock().expect("state lock");
            guard.as_ref().cloned().expect("manager")
        };
        let first_pid = {
            let guard = first_manager.process.lock().expect("process lock");
            guard.as_ref().expect("child process").child.id()
        };
        crate::runtime::process::signal_process_tree_by_pid(first_pid, true);
        let mut dead = false;
        for _ in 0..100 {
            if !first_manager.is_running() {
                dead = true;
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(dead, "real backend child did not die within the test bound");

        let (restart_tx, restart_rx) = std::sync::mpsc::sync_channel(1);
        let restart_state = Arc::clone(&state);
        let restart_binary = binary.clone();
        let restart_dir = temp.path().to_path_buf();
        std::thread::spawn(move || {
            let result = restart_state.ensure_started_with_binary(restart_binary, restart_dir);
            let _ = restart_tx.send(result);
        });
        let second = restart_rx
            .recv_timeout(STARTUP_TIMEOUT + Duration::from_secs(10))
            .expect("dead backend restart timed out")
            .expect("dead backend should restart");
        assert_ne!(first.token, second.token);
        assert_eq!(first.storage_id, second.storage_id);
        let second_public = state
            .viewer_connection(&second)
            .expect("restarted public transport");
        assert_ne!(first_public.token, second_public.token);
        assert_eq!(first_public.storage_id, second_public.storage_id);
        assert_eq!(
            client
                .get(format!("{}/v1/health", second_public.base_url))
                .bearer_auth(&first_public.token)
                .send()
                .expect("obsolete public token")
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{}/v1/health", second.base_url))
                .header(AUTHORIZATION, format!("Bearer {}", first.token))
                .send()
                .expect("old token response after restart")
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );

        state.shutdown();
        let third = state
            .ensure_started_with_binary(binary, temp.path().to_path_buf())
            .expect("stopped backend should restart");
        assert_ne!(second.token, third.token);
        assert_eq!(second.storage_id, third.storage_id);
        assert_eq!(
            fs::read(&config).expect("read preserved config"),
            original_config
        );
        state.shutdown();
        assert!(state
            .verify_portable_backup(&serde_json::json!({"alias":first_public.token}))
            .is_err());
    }
}
