//! Upstream K-brain host tools, bound to one verified native account and sidecar.
mod registration;

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::{Arc, Weak};

use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::runtime::terminal::TerminalSessionRegistry;
use crate::services::gateway::GatewayController;
use crate::services::kbrain_backend::KBrainBackendConnection;
use crate::services::tunnel::{GatewayTunnelCreateInput, TunnelStatePayload};

const MAX_BODY_BYTES: usize = 64 * 1024;
const READ_TERMINAL: &str = "ReadTerminal";
const TUNNEL_MANAGER: &str = "TunnelManager";
pub(crate) const CAPABILITY: &str = "zeroagent.account-host-bridge.v1";

struct HostBridgeEndpoint {
    port: u16,
    token: String,
}

pub(crate) struct HostBridge {
    listener: tauri::async_runtime::JoinHandle<()>,
    registrar: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for HostBridge {
    fn drop(&mut self) {
        self.listener.abort();
        self.registrar.abort();
    }
}

struct ServerState {
    endpoint: HostBridgeEndpoint,
    is_live: Arc<dyn Fn() -> bool + Send + Sync>,
    terminals: Arc<TerminalSessionRegistry>,
    gateway: Weak<GatewayController>,
    protected_ports: [u16; 2],
}

impl HostBridge {
    pub(crate) fn start(
        connection: KBrainBackendConnection,
        facade_url: &str,
        terminals: Arc<TerminalSessionRegistry>,
        gateway: &Arc<GatewayController>,
        is_live: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let port_of = |base: &str| {
            reqwest::Url::parse(base)
                .ok()
                .and_then(|url| url.port())
                .ok_or_else(|| "Invalid local backend address".to_string())
        };
        let protected_ports = [port_of(&connection.base_url)?, port_of(facade_url)?];
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .map_err(|_| "Could not bind the local host bridge")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Could not configure the local host bridge")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Could not read the local host bridge address")?
            .port();
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| "Could not generate the local host bridge credential")?;
        let state = Arc::new(ServerState {
            endpoint: HostBridgeEndpoint {
                port,
                token: bytes.iter().map(|b| format!("{b:02x}")).collect(),
            },
            is_live: Arc::new(is_live),
            terminals,
            gateway: Arc::downgrade(gateway),
            protected_ports,
        });
        let router = Router::new()
            .route("/v1/host/{command}", any(handle_command))
            .with_state(Arc::clone(&state));
        let listener = tauri::async_runtime::spawn(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                let _ = axum::serve(listener, router).await;
            }
        });
        let (initial_attempt, ready) = std::sync::mpsc::sync_channel(1);
        let registrar = tauri::async_runtime::spawn(registration::follow(
            state,
            connection,
            gateway.subscribe_host_bridge_settings(),
            initial_attempt,
        ));
        // This is called on the blocking backend-start path. Give the first
        // turn a registered bridge without making a degraded bridge block login.
        let _ = ready.recv_timeout(std::time::Duration::from_secs(1));
        Ok(Self {
            listener,
            registrar,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostBridgeError {
    pub code: &'static str,
    pub message: String,
}

impl HostBridgeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid_arguments(message: impl Into<String>) -> Self {
        Self::new("invalid_arguments", message)
    }

    fn command_failed(message: impl Into<String>) -> Self {
        Self::new("command_failed", message)
    }
}

fn json_response(status: StatusCode, body: Value) -> Response {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn error_response(status: StatusCode, error: HostBridgeError) -> Response {
    json_response(status, json!({ "ok": false, "error": error }))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let diff = left
        .iter()
        .zip(right)
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(diff) == 0
}

/// `Host` must name this loopback listener; anything else is a rebinding attempt.
fn host_is_loopback_listener(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let host = host.trim().to_ascii_lowercase();
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

fn is_browser_request(headers: &HeaderMap) -> bool {
    headers.contains_key(header::ORIGIN)
        || headers
            .keys()
            .any(|name| name.as_str().starts_with("sec-fetch-"))
}

fn bearer_matches(headers: &HeaderMap, token: &str) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some((scheme, presented)) = value.trim().split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("bearer")
        && constant_time_eq(presented.trim().as_bytes(), token.as_bytes())
}

/// Shared request guards; `Err` is the refusal to send.
fn guard(state: &ServerState, headers: &HeaderMap) -> Result<(), Response> {
    if !host_is_loopback_listener(headers, state.endpoint.port) || is_browser_request(headers) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            HostBridgeError::new("forbidden", "request refused"),
        ));
    }
    if !bearer_matches(headers, &state.endpoint.token) {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            HostBridgeError::new("unauthorized", "missing or invalid bearer token"),
        ));
    }
    Ok(())
}

fn parse_args<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, HostBridgeError> {
    let value: Value = if bytes.iter().all(u8::is_ascii_whitespace) {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(bytes)
            .map_err(|error| HostBridgeError::invalid_arguments(format!("invalid JSON: {error}")))?
    };
    if !value.is_object() {
        return Err(HostBridgeError::invalid_arguments(
            "arguments must be a JSON object",
        ));
    }
    serde_json::from_value(value)
        .map_err(|error| HostBridgeError::invalid_arguments(error.to_string()))
}

fn to_result<T: Serialize>(value: &T) -> Result<Value, HostBridgeError> {
    serde_json::to_value(value)
        .map_err(|error| HostBridgeError::command_failed(format!("serialize result: {error}")))
}

fn revoked() -> HostBridgeError {
    HostBridgeError::new(
        "revoked",
        "The desktop account or backend session has ended",
    )
}

fn require_live(state: &ServerState) -> Result<(), HostBridgeError> {
    if (state.is_live)() {
        Ok(())
    } else {
        Err(revoked())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandArgs {
    project_path_key: String,
    session_id: Option<String>,
    max_bytes: Option<usize>,
    tunnel_id: Option<String>,
    input: Option<GatewayTunnelCreateInput>,
}

async fn handle_command(
    State(state): State<Arc<ServerState>>,
    Path(command): Path<String>,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(response) = guard(&state, &headers) {
        return response;
    }
    if let Err(error) = require_live(&state) {
        return error_response(StatusCode::UNAUTHORIZED, error);
    }
    if method != Method::POST {
        return error_response(
            StatusCode::METHOD_NOT_ALLOWED,
            HostBridgeError::new("method_not_allowed", "use POST"),
        );
    }
    let body = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        to_bytes(body, MAX_BODY_BYTES),
    )
    .await;
    let Ok(Ok(bytes)) = body else {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            HostBridgeError::new(
                "invalid_body",
                "Host bridge request body is too large or incomplete",
            ),
        );
    };
    let outcome = dispatch(&state, &command, &bytes).await;
    if let Err(error) = require_live(&state) {
        return error_response(StatusCode::UNAUTHORIZED, error);
    }
    match outcome {
        Ok(result) => json_response(StatusCode::OK, json!({ "ok": true, "result": result })),
        Err(error) => error_response(StatusCode::OK, error),
    }
}

fn scoped_tunnels(mut state: TunnelStatePayload, project: &str) -> TunnelStatePayload {
    state
        .tunnels
        .retain(|tunnel| tunnel.project_path_key == project);
    state
}

fn is_protected_target(target: &str, ports: impl IntoIterator<Item = u16>) -> bool {
    reqwest::Url::parse(target.trim())
        .ok()
        .and_then(|url| url.port_or_known_default())
        .is_some_and(|port| ports.into_iter().any(|private| private == port))
}

async fn dispatch(
    state: &ServerState,
    command: &str,
    body: &[u8],
) -> Result<Value, HostBridgeError> {
    require_live(state)?;
    if !matches!(
        command,
        "terminal_read_tail"
            | "gateway_tunnel_state"
            | "gateway_tunnel_create"
            | "gateway_tunnel_close"
            | "gateway_tunnel_check"
    ) {
        return Err(HostBridgeError::new(
            "unknown_command",
            "Unknown host bridge command",
        ));
    }
    let args: CommandArgs = parse_args(body)?;
    let gateway = state.gateway.upgrade().ok_or_else(revoked)?;
    let project = gateway
        .host_bridge_workspace(&args.project_path_key)
        .await
        .map_err(HostBridgeError::command_failed)?;
    require_live(state)?;
    if command == "terminal_read_tail" {
        let tail = state
            .terminals
            .read_tail(project, args.session_id, args.max_bytes)
            .map_err(HostBridgeError::command_failed)?;
        return to_result(&tail);
    }
    let settings = gateway.subscribe_host_bridge_settings().borrow().clone();
    if !settings.enabled || !settings.enable_web_tunnels {
        return Err(HostBridgeError::new(
            "tool_disabled",
            "Remote tunnels are turned off in ZeroAgent (Settings > Remote)",
        ));
    }
    let snapshot = || scoped_tunnels(gateway.tunnel_state(), &project);
    let tunnel_id = || {
        let id = args.tunnel_id.as_deref().unwrap_or_default().trim();
        snapshot()
            .tunnels
            .into_iter()
            .find(|item| item.id == id)
            .map(|item| item.id)
            .ok_or_else(|| HostBridgeError::new("not_found", "Tunnel not found in this workspace"))
    };
    // The store rechecks authorization on its blocking worker, immediately
    // before writing to this profile. Disabling tunnels revokes pending writes.
    let mutation_allowed = {
        let live = Arc::clone(&state.is_live);
        let gateway = state.gateway.clone();
        Arc::new(move || {
            live()
                && gateway.upgrade().is_some_and(|gateway| {
                    let settings = gateway.subscribe_host_bridge_settings();
                    let settings = settings.borrow();
                    settings.enabled && settings.enable_web_tunnels
                })
        })
    };
    match command {
        "gateway_tunnel_state" => {
            let mut result = to_result(&snapshot())?;
            let effective = settings.effective_gateway_settings();
            result["publicBaseUrl"] = Value::String(gateway_public_base_url(
                &effective.gateway_url,
                effective.gateway_port,
            ));
            Ok(result)
        }
        "gateway_tunnel_create" => {
            let mut input = args
                .input
                .ok_or_else(|| HostBridgeError::invalid_arguments("input is required"))?;
            if is_protected_target(
                &input.target_url,
                state
                    .protected_ports
                    .into_iter()
                    .chain([state.endpoint.port]),
            ) {
                return Err(HostBridgeError::invalid_arguments(
                    "targetUrl must not point at a native ZeroAgent service",
                ));
            }
            input.project_path_key = Some(project);
            let id = gateway
                .create_host_bridge_tunnel(input, mutation_allowed)
                .await
                .map_err(HostBridgeError::command_failed)?;
            Ok(json!({ "id": id }))
        }
        "gateway_tunnel_close" => {
            gateway
                .close_host_bridge_tunnel(tunnel_id()?, project, mutation_allowed)
                .await
                .map_err(HostBridgeError::command_failed)?;
            Ok(Value::Null)
        }
        "gateway_tunnel_check" => {
            let ids = if args.tunnel_id.is_some() {
                vec![tunnel_id()?]
            } else {
                snapshot().tunnels.into_iter().map(|item| item.id).collect()
            };
            gateway.check_host_bridge_tunnels(ids).await;
            Ok(Value::Null)
        }
        _ => unreachable!(),
    }
}

pub(crate) fn gateway_public_base_url(gateway_url: &str, gateway_port: u16) -> String {
    let trimmed = gateway_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Ok(mut url) = reqwest::Url::parse(trimmed) else {
        return String::new();
    };
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        "http" => "http",
        "https" => "https",
        _ => return String::new(),
    };
    // ws/wss/http/https are all "special" schemes, so switching between them succeeds.
    if url.set_scheme(scheme).is_err() {
        return String::new();
    }
    if gateway_port != 0 && url.set_port(Some(gateway_port)).is_err() {
        return String::new();
    }
    format!(
        "{}{}",
        url.origin().ascii_serialization(),
        url.path().trim_end_matches('/')
    )
}

#[cfg(test)]
mod tests;
