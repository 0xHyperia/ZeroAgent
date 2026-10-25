//! Private host-to-sidecar OAuth transport. This is not a renderer/Gateway API.
use super::{store::TokenStore, CredentialOwner};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, Uri},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tokio::sync::{oneshot, Semaphore};

pub(crate) const PROTOCOL: &str = "zeroagent.mcp-credentials.v1";
#[cfg(test)]
mod tests;

struct BrokerState {
    backend_root: PathBuf,
    settings_root: PathBuf,
    storage_id: String,
    profile_live: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    capability: String,
    file_only: bool,
    slots: Arc<Semaphore>,
    configuration: Arc<crate::services::configuration_coordinator::ConfigurationCoordinator>,
    recovery: Arc<super::rotation::RotationRecovery>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialRequest {
    protocol: String,
    target: Value,
    #[serde(default)]
    previous_token_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialReply {
    protocol: &'static str,
    access_token: String,
}

pub(crate) struct NativeCredentialBroker {
    endpoint: String,
    capability: String,
    running: Arc<AtomicBool>,
    stop: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    worker: Option<thread::JoinHandle<()>>,
    recovery: Arc<super::rotation::RotationRecovery>,
}

// Owned by the sidecar stdout reader, independently of manager polling. EOF,
// read failure, and reader unwind revoke both pending grants and the listener.
pub(crate) struct NativeCredentialProcessGuard {
    running: Arc<AtomicBool>,
    stop: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    recovery: Arc<super::rotation::RotationRecovery>,
}

fn revoke(
    running: &AtomicBool,
    stop: &Mutex<Option<oneshot::Sender<()>>>,
    recovery: &super::rotation::RotationRecovery,
) {
    running.store(false, Ordering::SeqCst);
    recovery.revoke();
    if let Some(stop) = stop
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        let _ = stop.send(());
    }
}

impl Drop for NativeCredentialProcessGuard {
    fn drop(&mut self) {
        revoke(&self.running, &self.stop, &self.recovery);
    }
}

impl NativeCredentialBroker {
    pub(crate) fn start(
        backend_root: PathBuf,
        settings_root: PathBuf,
        storage_id: String,
        profile_live: Arc<AtomicBool>,
        file_only: bool,
    ) -> Result<Self, String> {
        if !backend_root.is_absolute()
            || !settings_root.is_absolute()
            || !profile_live.load(Ordering::SeqCst)
        {
            return Err(super::AUTH_REQUIRED_MARKER.into());
        }
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "启动 MCP 凭据宿主失败")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "配置 MCP 凭据宿主失败")?;
        let endpoint = format!(
            "http://{}/v1/mcp/credential",
            listener
                .local_addr()
                .map_err(|_| "读取 MCP 凭据宿主地址失败")?
        );
        let capability = format!("za-mcp-host-{}", uuid::Uuid::new_v4());
        let running = Arc::new(AtomicBool::new(true));
        let recovery = Arc::new(super::rotation::RotationRecovery::new());
        let state = Arc::new(BrokerState {
            configuration:
                crate::services::configuration_coordinator::ConfigurationCoordinator::for_profile(
                    &storage_id,
                )?,
            backend_root,
            settings_root,
            storage_id,
            profile_live,
            running: running.clone(),
            capability: capability.clone(),
            file_only,
            slots: Arc::new(Semaphore::new(16)),
            recovery: recovery.clone(),
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "创建 MCP 凭据宿主运行时失败")?;
        let (stop, shutdown) = oneshot::channel();
        let worker=thread::Builder::new().name("mcp-credential-host".into()).spawn(move||{
            runtime.block_on(async move{
                let Ok(listener)=tokio::net::TcpListener::from_std(listener) else {return};
                let router=Router::new().route("/v1/mcp/credential",post(credential))
                    .layer(DefaultBodyLimit::max(1024*1024)).with_state(state);
                tokio::select!{_ = async { axum::serve(listener,router).await } =>{}, _ = shutdown =>{}}
            });
            // A cancelled HTTP future cannot interrupt a blocking token endpoint.
            // Its owner is already invalid; bound runtime shutdown independently.
            runtime.shutdown_timeout(Duration::from_millis(100));
        }).map_err(|_|"启动 MCP 凭据宿主线程失败")?;
        Ok(Self {
            endpoint,
            capability,
            running,
            stop: Arc::new(Mutex::new(Some(stop))),
            worker: Some(worker),
            recovery,
        })
    }

    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }
    pub(crate) fn capability(&self) -> &str {
        &self.capability
    }
    pub(crate) fn process_guard(&self) -> NativeCredentialProcessGuard {
        NativeCredentialProcessGuard {
            running: self.running.clone(),
            stop: self.stop.clone(),
            recovery: self.recovery.clone(),
        }
    }
    pub(crate) fn stop(&mut self) {
        revoke(&self.running, &self.stop, &self.recovery);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for NativeCredentialBroker {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn credential(
    State(state): State<Arc<BrokerState>>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> axum::response::Response {
    let denied =
        |status| (status, Json(json!({"error":super::AUTH_REQUIRED_MARKER}))).into_response();
    if uri.query().is_some()
        || headers.contains_key("origin")
        || headers.contains_key("cookie")
        || headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some(format!("Bearer {}", state.capability).as_str())
    {
        return denied(StatusCode::UNAUTHORIZED);
    }
    let Ok(input) = serde_json::from_slice::<CredentialRequest>(&body) else {
        return denied(StatusCode::BAD_REQUEST);
    };
    if input.protocol != PROTOCOL
        || (!input.previous_token_hash.is_empty()
            && (input.previous_token_hash.len() != 64
                || !input
                    .previous_token_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))))
    {
        return denied(StatusCode::BAD_REQUEST);
    }
    let Ok(permit) = state.slots.clone().try_acquire_owned() else {
        return denied(StatusCode::SERVICE_UNAVAILABLE);
    };
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        state.resolve(input)
    })
    .await
    {
        Ok(Ok(access_token)) => Json(CredentialReply {
            protocol: PROTOCOL,
            access_token,
        })
        .into_response(),
        _ => denied(StatusCode::UNAUTHORIZED),
    }
}

impl BrokerState {
    fn verify(&self, target: &Value) -> Result<(super::OauthServer, String), String> {
        if !self.profile_live.load(Ordering::SeqCst) || !self.running.load(Ordering::SeqCst) {
            self.recovery.revoke();
            return Err(super::AUTH_REQUIRED_MARKER.into());
        }
        crate::commands::settings::verify_mcp_credential_target_file(
            &self.backend_root,
            &self.storage_id,
            target,
        )
    }

    fn resolve(&self, input: CredentialRequest) -> Result<String, String> {
        let revision = self.configuration.mcp_revision();
        let (server, digest) = self.verify(&input.target)?;
        let owner = FileOwner {
            state: self,
            target: &input.target,
            digest: &digest,
            revision,
        };
        owner.validate()?;
        let store =
            TokenStore::for_profile(self.settings_root.clone(), &server.id, self.file_only)?;
        let record = self.recovery.credential(
            &store,
            &server.url,
            &digest,
            revision,
            &input.previous_token_hash,
            &owner,
        )?;
        owner.validate()?;
        // A concurrent clear invalidates the response even if it completed after
        // the token endpoint and before the final owner check.
        let current = store
            .snapshot()?
            .record
            .ok_or(super::AUTH_REQUIRED_MARKER)?;
        if current.access_token != record.access_token
            || current.target_binding != record.target_binding
        {
            return Err(super::AUTH_REQUIRED_MARKER.into());
        }
        if record.access_token.len() > 64 * 1024
            || record.access_token.is_empty()
            || record
                .access_token
                .bytes()
                .any(|byte| !(33..=126).contains(&byte))
        {
            return Err(super::AUTH_REQUIRED_MARKER.into());
        }
        Ok(record.access_token)
    }
}

struct FileOwner<'a> {
    state: &'a BrokerState,
    target: &'a Value,
    digest: &'a str,
    revision: u64,
}
impl CredentialOwner for FileOwner<'_> {
    fn validate(&self) -> Result<(), String> {
        if self.state.configuration.mcp_revision() != self.revision
            || self.state.verify(self.target)?.1 != self.digest
        {
            return Err(super::AUTH_REQUIRED_MARKER.into());
        }
        Ok(())
    }
}
