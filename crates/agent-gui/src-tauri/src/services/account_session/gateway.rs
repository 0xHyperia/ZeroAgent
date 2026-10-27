use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use std::collections::HashMap;
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

use crate::services::{
    device_credentials,
    gateway::{proto, GatewayController},
};

const SOCKET_EVENT: &str = "account-gateway-socket";
const PROTOCOL: &str = "liveagent.v2.pb";

pub(crate) fn configured_gateway_origin() -> Result<Url, String> {
    let value = option_env!("ZEROAGENT_GATEWAY_URL").unwrap_or("https://agent.usa0.top");
    let port = option_env!("ZEROAGENT_GATEWAY_PORT")
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(443);
    let mut url = Url::parse(value).map_err(|_| "Invalid Gateway build origin")?;
    if !matches!(url.scheme(), "http" | "https")
        || (!cfg!(debug_assertions) && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Invalid Gateway build origin".into());
    }
    url.set_port(Some(port))
        .map_err(|_| "Invalid Gateway build port")?;
    Ok(url)
}

pub(super) fn gateway_url(origin: &Url, path: &str) -> Result<Url, String> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path.split('?').next().is_some_and(|p| {
            p.contains('%') || p.split('/').any(|part| part == "." || part == "..")
        })
    {
        return Err("Gateway endpoint is not allowed".into());
    }
    let url = origin.join(path).map_err(|_| "Invalid Gateway endpoint")?;
    if url.origin() != origin.origin() {
        return Err("Gateway endpoint is not allowed".into());
    }
    Ok(url)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayHttpRequest {
    pub session_handle: String,
    pub origin: String,
    pub path: String,
    pub method: String,
    pub body: Option<Value>,
}

fn desktop_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        (
            "GET",
            "/api/desktop/environments" | "/api/desktop/conversation-routes"
        ) | (
            "POST",
            "/api/desktop/execution-target/select" | "/api/desktop/handoff"
        )
    ) || matches!(method, "PATCH" | "DELETE")
        && path
            .strip_prefix("/api/desktop/devices/")
            .is_some_and(valid_device_id)
}
fn valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

impl AccountSessionState {
    pub(super) async fn gateway_raw(
        &self,
        handle: &str,
        origin: &Url,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<api::AccountHttpResponse, String> {
        let url = gateway_url(origin, path)?;
        let method =
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid Gateway method")?;
        let mut tokens = self.access(handle, false).await?;
        for attempt in 0..2 {
            self.require_current(handle).await?;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .bearer_auth(&tokens.access_token)
                .header("Accept", "application/json");
            if let Some(body) = body {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|_| "Gateway request failed")?;
            self.require_current(handle).await?;
            if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                let current = self.access(handle, false).await?;
                tokens = if current.access_token != tokens.access_token {
                    current
                } else {
                    self.access(handle, true).await?
                };
                continue;
            }
            let status = response.status().as_u16();
            let body = if status == 204 {
                Value::Null
            } else if response.status().is_success() {
                response_json(response).await?
            } else {
                json!({"error":"Gateway request failed"})
            };
            self.require_current(handle).await?;
            return Ok(api::AccountHttpResponse { status, body });
        }
        Err("Gateway authentication failed".into())
    }
}

#[tauri::command]
pub async fn account_gateway_http(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    request: GatewayHttpRequest,
) -> Result<api::AccountHttpResponse, String> {
    super::api::guard_viewer(&app, state.inner(), &request.session_handle).await?;
    let origin = configured_gateway_origin()?;
    if Url::parse(&request.origin)
        .map_err(|_| "Invalid Gateway origin")?
        .origin()
        != origin.origin()
    {
        return Err("Gateway origin is not the configured origin".into());
    }
    let url = gateway_url(&origin, &request.path)?;
    let method = request.method.to_ascii_uppercase();
    if !desktop_route(&method, url.path()) {
        return Err("Gateway endpoint is not allowed".into());
    }
    if request
        .body
        .as_ref()
        .is_some_and(|body| serde_json::to_vec(body).map_or(true, |data| data.len() > MAX_BODY))
    {
        return Err("Gateway request is too large".into());
    }
    let mut result = state
        .gateway_raw(
            &request.session_handle,
            &origin,
            &method,
            &request.path,
            request.body.as_ref(),
        )
        .await?;
    state
        .redact(&request.session_handle, &mut result.body)
        .await?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRegistrationRequest {
    session_handle: String,
    origin: String,
    installation_id: String,
    version: String,
    platform: String,
}

#[tauri::command]
pub async fn account_device_register(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    request: DeviceRegistrationRequest,
) -> Result<Value, String> {
    super::api::guard_viewer(&app, state.inner(), &request.session_handle).await?;
    let public = state.verified_current(&request.session_handle).await?;
    device_credentials::require_active_scope(Some(&public.account_scope))?;
    let origin = configured_gateway_origin()?;
    if Url::parse(&request.origin)
        .map_err(|_| "Invalid Gateway origin")?
        .origin()
        != origin.origin()
    {
        return Err("Gateway origin is not configured".into());
    }
    if request.installation_id.is_empty() || request.installation_id.len() > 128 {
        return Err("Invalid installation identity".into());
    }
    let existing =
        device_credentials::load_device_credential_for_scope(Some(&public.account_scope))?;
    let record = existing.clone().unwrap_or_default();
    let canonical = !record.agent_id.is_empty() && !record.token.is_empty();
    let body = json!({"installation_id":request.installation_id,"name":if existing.is_some(){String::new()}else{device_credentials::device_default_name()},"platform":std::env::consts::OS,"version":crate::app_version(),
        "agent_id":if canonical{record.effective_agent_id()}else{""},"agent_token":if canonical{record.effective_token()}else{""},"device_id":if canonical{""}else{record.effective_agent_id()},"device_credential":if canonical{""}else{record.effective_token()}});
    let response = state
        .gateway_raw(
            &request.session_handle,
            &origin,
            "POST",
            "/api/desktop/devices/register",
            Some(&body),
        )
        .await?;
    if response.status != 200 && response.status != 201 {
        return Err("Gateway device registration failed".into());
    }
    let payload = response.body;
    let device = payload
        .get("device")
        .filter(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        })
        .ok_or("Gateway returned no device")?;
    let id = payload
        .get("agent_id")
        .or_else(|| device.get("agent_id"))
        .or_else(|| device.get("id"))
        .and_then(Value::as_str)
        .ok_or("Gateway returned no Agent identity")?;
    let token = payload
        .get("agent_token")
        .or_else(|| payload.get("device_credential"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .unwrap_or(record.effective_token());
    if id.is_empty() || token.is_empty() {
        return Err("Gateway returned no device credential".into());
    }
    state.require_current(&request.session_handle).await?;
    device_credentials::require_active_scope(Some(&public.account_scope))?;
    device_credentials::save_device_credential_for_scope(
        &device_credentials::DeviceCredentialRecord {
            agent_id: id.into(),
            token: token.into(),
            device_id: String::new(),
            credential: String::new(),
        },
        Some(&public.account_scope),
    )?;
    if let Some(gateway) = app.try_state::<Arc<GatewayController>>() {
        gateway.reload_from_db().await?;
        let _ = gateway.nudge_connection("device_registered", true);
    }
    let mut device = device.clone();
    state.redact(&request.session_handle, &mut device).await?;
    Ok(device)
}

#[tauri::command]
pub async fn account_device_identity(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    session_handle: String,
) -> Result<Value, String> {
    super::api::guard_viewer(&app, state.inner(), &session_handle).await?;
    let public = state.verified_current(&session_handle).await?;
    device_credentials::require_active_scope(Some(&public.account_scope))?;
    let record = device_credentials::load_device_credential_for_scope(Some(&public.account_scope))?;
    state.require_current(&session_handle).await?;
    Ok(record.map(|record|json!({"agentId":record.effective_agent_id(),"deviceId":record.effective_agent_id()})).unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn account_device_rotate(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    session_handle: String,
    agent_id: String,
) -> Result<(), String> {
    if !valid_device_id(&agent_id) {
        return Err("Invalid device identity".into());
    }
    let public = state.verified_current(&session_handle).await?;
    device_credentials::require_active_scope(Some(&public.account_scope))?;
    let old = device_credentials::load_device_credential_for_scope(Some(&public.account_scope))?
        .ok_or("Device is not registered")?;
    if old.effective_agent_id() != agent_id {
        return Err("Device identity does not match this installation".into());
    }
    let response = state
        .gateway_raw(
            &session_handle,
            &configured_gateway_origin()?,
            "POST",
            &format!("/api/desktop/devices/{agent_id}/rotate-token"),
            None,
        )
        .await?;
    if response.status != 200 {
        return Err("Gateway device credential rotation failed".into());
    }
    let token = response
        .body
        .get("agent_token")
        .or_else(|| response.body.get("device_credential"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or("Gateway returned no credential")?;
    state.require_current(&session_handle).await?;
    device_credentials::require_active_scope(Some(&public.account_scope))?;
    device_credentials::save_device_credential_for_scope(
        &device_credentials::DeviceCredentialRecord {
            agent_id,
            token: token.into(),
            device_id: String::new(),
            credential: String::new(),
        },
        Some(&public.account_scope),
    )?;
    if let Some(gateway) = app.try_state::<Arc<GatewayController>>() {
        gateway.reload_from_db().await?;
        let _ = gateway.nudge_connection("device_credential_rotated", true);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SocketConnect {
    pub id: String,
    pub session_handle: String,
    pub origin: String,
    pub path: String,
    pub protocols: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SocketSend {
    pub id: String,
    pub data: String,
    pub session_handle: String,
}
struct SocketEntry {
    handle: String,
    connection: String,
    cancel: oneshot::Sender<()>,
    sender: mpsc::Sender<Message>,
    max_frame_bytes: usize,
}
#[derive(Default)]
pub struct AccountSocketState {
    sockets: Mutex<HashMap<String, SocketEntry>>,
}

#[derive(Clone, Serialize)]
struct SocketEvent<'a> {
    id: &'a str,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}
type SocketEvents = Arc<dyn Fn(&str, &str, Option<String>) + Send + Sync>;
fn emit(events: &SocketEvents, id: &str, kind: &str, data: Option<String>) {
    events(id, kind, data);
}

impl AccountSocketState {
    async fn remove_connection(&self, id: &str, connection: &str) -> bool {
        let mut sockets = self.sockets.lock().await;
        if sockets
            .get(id)
            .is_some_and(|entry| entry.connection != connection)
        {
            return false;
        }
        sockets.remove(id);
        true
    }
    pub(crate) async fn close_session(&self, handle: &str) {
        let mut sockets = self.sockets.lock().await;
        let ids = sockets
            .iter()
            .filter(|(_, entry)| entry.handle == handle)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(entry) = sockets.remove(&id) {
                let _ = entry.cancel.send(());
            }
        }
    }
}

fn replace_hello(
    data: &[u8],
    terminal: bool,
    handle: &str,
    access: &str,
) -> Result<Vec<u8>, String> {
    fn bind(hello: &mut proto::ClientHello, handle: &str, access: &str) -> Result<(), String> {
        if hello.protocol_version != 2
            || hello.role != proto::ClientRole::Browser as i32
            || hello.token != handle
            || hello.selection_lease.is_empty()
            || !hello.device_credential.is_empty()
            || !hello.device_id.is_empty()
        {
            return Err("Invalid account Gateway handshake".into());
        }
        hello.token = access.into();
        Ok(())
    }
    if terminal {
        let mut frame =
            proto::TerminalClientFrame::decode(data).map_err(|_| "Invalid terminal handshake")?;
        let Some(proto::terminal_client_frame::Payload::Hello(ref mut hello)) = frame.payload
        else {
            return Err("Expected terminal handshake".into());
        };
        bind(hello, handle, access)?;
        Ok(frame.encode_to_vec())
    } else {
        let mut frame =
            proto::WebClientFrame::decode(data).map_err(|_| "Invalid Gateway handshake")?;
        let Some(proto::web_client_frame::Payload::Hello(ref mut hello)) = frame.payload else {
            return Err("Expected Gateway handshake".into());
        };
        bind(hello, handle, access)?;
        Ok(frame.encode_to_vec())
    }
}

#[tauri::command]
pub async fn account_gateway_socket_connect(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    sockets: State<'_, Arc<AccountSocketState>>,
    request: SocketConnect,
) -> Result<(), String> {
    super::api::guard_viewer(&app, state.inner(), &request.session_handle).await?;
    let events: SocketEvents = Arc::new(move |id, kind, data| {
        let _ = app.emit(SOCKET_EVENT, SocketEvent { id, kind, data });
    });
    connect_socket(
        state.inner().clone(),
        sockets.inner().clone(),
        configured_gateway_origin()?,
        request,
        events,
    )
    .await
}

async fn connect_socket(
    state: Arc<AccountSessionState>,
    sockets: Arc<AccountSocketState>,
    origin: Url,
    request: SocketConnect,
    events: SocketEvents,
) -> Result<(), String> {
    if request.id.is_empty()
        || request.id.len() > 128
        || request.protocols != [PROTOCOL]
        || !matches!(request.path.as_str(), "/ws/v2" | "/ws/v2/terminal")
    {
        return Err("Invalid Gateway socket request".into());
    }
    if Url::parse(&request.origin)
        .map_err(|_| "Invalid Gateway origin")?
        .origin()
        != origin.origin()
    {
        return Err("Gateway origin is not configured".into());
    }
    state.require_current(&request.session_handle).await?;
    let mut url = gateway_url(&origin, &request.path)?;
    url.set_scheme(if origin.scheme() == "https" {
        "wss"
    } else {
        "ws"
    })
    .map_err(|_| "Invalid Gateway socket scheme")?;
    let mut handshake = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid Gateway socket request")?;
    handshake
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", HeaderValue::from_static(PROTOCOL));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (socket, response) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(handshake),
    )
    .await
    .map_err(|_| "Gateway socket connection timed out")?
    .map_err(|_| "Gateway socket connection failed")?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|v| v.to_str().ok())
        != Some(PROTOCOL)
    {
        return Err("Gateway socket protocol mismatch".into());
    }
    state.require_current(&request.session_handle).await?;
    let (sender, mut receiver) = mpsc::channel::<Message>(64);
    let (cancel, mut cancellation) = oneshot::channel();
    let connection = uuid::Uuid::new_v4().to_string();
    {
        let mut registry = sockets.sockets.lock().await;
        if registry.len() >= 16 {
            return Err("Too many account Gateway sockets".into());
        }
        if registry.contains_key(&request.id) {
            return Err("Gateway socket ID is already in use".into());
        }
        registry.insert(
            request.id.clone(),
            SocketEntry {
                handle: request.session_handle.clone(),
                connection: connection.clone(),
                cancel,
                sender,
                max_frame_bytes: if request.path.ends_with("/terminal") {
                    1 << 20
                } else {
                    4 << 20
                },
            },
        );
    }
    tokio::spawn(async move {
        let (mut sink, mut stream) = socket.split();
        let mut ended = state.subscribe_ended();
        let mut hello = false;
        let mut used_access = String::new();
        let terminal = request.path.ends_with("/terminal");
        if state
            .require_current(&request.session_handle)
            .await
            .is_err()
        {
            if sockets.remove_connection(&request.id, &connection).await {
                emit(&events, &request.id, "close", None);
            }
            return;
        }
        emit(&events, &request.id, "open", None);
        let owner_ended = async {
            loop {
                match ended.recv().await {
                    Ok(event) if event.handle != request.session_handle => continue,
                    _ => break,
                }
            }
        };
        let relay = async {
            loop {
                tokio::select! {
                    message=receiver.recv()=>{
                        let Some(mut message)=message else{break;};
                        if state.require_current(&request.session_handle).await.is_err(){break;}
                        if let Message::Binary(ref data)=message {
                            if !hello {
                                let tokens=match state.access(&request.session_handle,false).await{Ok(tokens)=>tokens,Err(_)=>break};
                                used_access=tokens.access_token.clone();
                                message=match replace_hello(data,terminal,&request.session_handle,&tokens.access_token){Ok(data)=>Message::Binary(data.into()),Err(_)=>break};
                                hello=true;
                            }
                        }
                        let closing=matches!(message,Message::Close(_));
                        if sink.send(message).await.is_err()||closing{break;}
                    }
                    message=stream.next()=>{
                        if state.require_current(&request.session_handle).await.is_err(){break;}
                        match message {
                            Some(Ok(Message::Binary(data)))=>{
                                let snapshot=match state.snapshot(&request.session_handle).await{Ok(value)=>value,Err(_)=>break};
                                let mut secrets=snapshot.protected_keys;secrets.push(snapshot.tokens.access_token);secrets.push(used_access.clone());if let Some(refresh)=snapshot.tokens.refresh_token{secrets.push(refresh);}
                                if secrets.iter().any(|secret|!secret.is_empty()&&data.windows(secret.len()).any(|part|part==secret.as_bytes())){break;}
                                emit(&events,&request.id,"message",Some(BASE64.encode(data)));
                            }
                            Some(Ok(Message::Ping(data)))=>{if sink.send(Message::Pong(data)).await.is_err(){break;}},
                            Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                            _=>{}
                        }
                    }
                }
            }
        };
        // Cancel the whole relay future, including a send blocked by a peer that stopped reading.
        tokio::select! { _ = &mut cancellation => {}, _ = owner_ended => {}, _ = relay => {} }
        let _ =
            tokio::time::timeout(Duration::from_millis(100), sink.send(Message::Close(None))).await;
        if sockets.remove_connection(&request.id, &connection).await {
            emit(&events, &request.id, "close", None);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn account_gateway_socket_send(
    account: State<'_, Arc<AccountSessionState>>,
    state: State<'_, Arc<AccountSocketState>>,
    request: SocketSend,
) -> Result<(), String> {
    queue_frame(account.inner(), state.inner(), request).await
}

async fn queue_frame(
    account: &AccountSessionState,
    state: &AccountSocketState,
    request: SocketSend,
) -> Result<(), String> {
    account.require_current(&request.session_handle).await?;
    if request.data.len() > ((4 * 1024 * 1024 + 2) / 3) * 4 {
        return Err("Gateway frame is too large".into());
    }
    let bytes = BASE64
        .decode(request.data)
        .map_err(|_| "Invalid Gateway frame")?;
    let sockets = state.sockets.lock().await;
    let entry = sockets.get(&request.id).ok_or("Gateway socket is closed")?;
    if entry.handle != request.session_handle {
        return Err("Gateway socket belongs to another account session".into());
    }
    if bytes.len() > entry.max_frame_bytes {
        return Err("Gateway frame is too large".into());
    }
    entry
        .sender
        .try_send(Message::Binary(bytes.into()))
        .map_err(|_| "Gateway socket buffer is full".into())
}

#[tauri::command]
pub async fn account_gateway_socket_close(
    account: State<'_, Arc<AccountSessionState>>,
    state: State<'_, Arc<AccountSocketState>>,
    id: String,
    session_handle: String,
) -> Result<(), String> {
    close_socket(account.inner(), state.inner(), &id, &session_handle).await
}

async fn close_socket(
    account: &AccountSessionState,
    state: &AccountSocketState,
    id: &str,
    session_handle: &str,
) -> Result<(), String> {
    account.require_current(session_handle).await?;
    let mut sockets = state.sockets.lock().await;
    if sockets
        .get(id)
        .is_some_and(|entry| entry.handle != session_handle)
    {
        return Err("Gateway socket belongs to another account session".into());
    }
    if let Some(entry) = sockets.remove(id) {
        let _ = entry.cancel.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hello(handle: &str) -> proto::ClientHello {
        proto::ClientHello {
            protocol_version: 2,
            role: proto::ClientRole::Browser as i32,
            token: handle.into(),
            selection_lease: "verified-server-lease".into(),
            agent_id: "owned-device".into(),
            ..Default::default()
        }
    }
    fn frame(hello: proto::ClientHello, terminal: bool) -> Vec<u8> {
        if terminal {
            proto::TerminalClientFrame {
                payload: Some(proto::terminal_client_frame::Payload::Hello(hello)),
                ..Default::default()
            }
            .encode_to_vec()
        } else {
            proto::WebClientFrame {
                payload: Some(proto::web_client_frame::Payload::Hello(hello)),
                ..Default::default()
            }
            .encode_to_vec()
        }
    }
    #[test]
    fn browser_and_terminal_handshakes_inject_only_the_native_owners_access_token() {
        for terminal in [false, true] {
            let source = frame(hello("opaque-handle"), terminal);
            assert!(!source.windows(12).any(|part| part == b"native-token"));
            let rewritten =
                replace_hello(&source, terminal, "opaque-handle", "native-token").unwrap();
            let actual = if terminal {
                match proto::TerminalClientFrame::decode(rewritten.as_slice())
                    .unwrap()
                    .payload
                    .unwrap()
                {
                    proto::terminal_client_frame::Payload::Hello(hello) => hello,
                    _ => panic!("wrong payload"),
                }
            } else {
                match proto::WebClientFrame::decode(rewritten.as_slice())
                    .unwrap()
                    .payload
                    .unwrap()
                {
                    proto::web_client_frame::Payload::Hello(hello) => hello,
                    _ => panic!("wrong payload"),
                }
            };
            assert_eq!(actual.token, "native-token");
            assert_eq!(actual.selection_lease, "verified-server-lease");
            assert_eq!(actual.agent_id, "owned-device");
        }
    }
    #[test]
    fn handshakes_reject_other_roles_handles_versions_and_device_credentials() {
        for terminal in [false, true] {
            for change in 0..6 {
                let mut hello = hello("opaque-handle");
                match change {
                    0 => hello.protocol_version = 1,
                    1 => hello.role = proto::ClientRole::Agent as i32,
                    2 => hello.token = "other-handle".into(),
                    3 => hello.selection_lease.clear(),
                    4 => hello.device_id = "device".into(),
                    _ => hello.device_credential = "private-device-token".into(),
                };
                assert!(replace_hello(
                    &frame(hello, terminal),
                    terminal,
                    "opaque-handle",
                    "native-token"
                )
                .is_err());
            }
            assert!(replace_hello(&[], terminal, "opaque-handle", "native-token").is_err());
        }
    }
    #[test]
    fn gateway_paths_cannot_change_origin_or_escape_the_route() {
        let origin = Url::parse("https://agent.usa0.top").unwrap();
        for path in [
            "//foreign.test/ws/v2",
            "/ws/../api",
            "/ws/%2e%2e/api",
            "/ws/v2#fragment",
            r"/ws\v2",
        ] {
            assert!(gateway_url(&origin, path).is_err());
        }
        assert_eq!(
            gateway_url(&origin, "/ws/v2").unwrap().origin(),
            origin.origin()
        );
    }
    type Wire = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;
    type CapturedEvent = (String, String, Option<String>);
    async fn wire_fixture(path: &'static str) -> (Url, tokio::task::JoinHandle<Wire>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_hdr_async(stream,move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,mut response:tokio_tungstenite::tungstenite::handshake::server::Response| {
                assert_eq!(request.uri().path(),path);
                assert!(request.uri().query().is_none());
                assert!(request.headers().get("Authorization").is_none());
                assert_eq!(request.headers().get("Sec-WebSocket-Protocol").unwrap(),PROTOCOL);
                response.headers_mut().insert("Sec-WebSocket-Protocol",HeaderValue::from_static(PROTOCOL));
                Ok(response)
            }).await.unwrap()
        });
        (origin, server)
    }
    fn capture_events() -> (SocketEvents, mpsc::UnboundedReceiver<CapturedEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(move |id, kind, data| {
                let _ = tx.send((id.into(), kind.into(), data));
            }),
            rx,
        )
    }
    async fn next_event(
        rx: &mut mpsc::UnboundedReceiver<CapturedEvent>,
        kind: &str,
    ) -> CapturedEvent {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = rx.recv().await.expect("socket event channel closed");
                if event.1 == kind {
                    return event;
                }
            }
        })
        .await
        .expect("socket event timed out")
    }
    fn connect_request(origin: &Url, handle: &str, path: &str, id: &str) -> SocketConnect {
        SocketConnect {
            id: id.into(),
            session_handle: handle.into(),
            origin: origin.origin().ascii_serialization(),
            path: path.into(),
            protocols: vec![PROTOCOL.into()],
        }
    }
    fn send_request(handle: &str, id: &str, bytes: &[u8]) -> SocketSend {
        SocketSend {
            id: id.into(),
            session_handle: handle.into(),
            data: BASE64.encode(bytes),
        }
    }
    #[tokio::test]
    async fn real_browser_and_terminal_wires_inject_native_auth_and_end_on_logout() {
        for path in ["/ws/v2", "/ws/v2/terminal"] {
            let account = super::super::tests::Fixture::new().await;
            let public = account.login("a", false).await;
            account
                .state
                .public_summary(&public.session_handle)
                .await
                .unwrap();
            let sockets = Arc::new(AccountSocketState::default());
            let (origin, server) = wire_fixture(path).await;
            let (events, mut rx) = capture_events();
            connect_socket(
                account.state.clone(),
                sockets.clone(),
                origin.clone(),
                connect_request(&origin, &public.session_handle, path, "wire"),
                events,
            )
            .await
            .unwrap();
            let mut peer = server.await.unwrap();
            next_event(&mut rx, "open").await;
            let source = frame(hello(&public.session_handle), path.ends_with("/terminal"));
            queue_frame(
                &account.state,
                &sockets,
                send_request(&public.session_handle, "wire", &source),
            )
            .await
            .unwrap();
            let Message::Binary(sent) = tokio::time::timeout(Duration::from_secs(3), peer.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
            else {
                panic!("missing binary hello")
            };
            let actual = if path.ends_with("/terminal") {
                match proto::TerminalClientFrame::decode(sent)
                    .unwrap()
                    .payload
                    .unwrap()
                {
                    proto::terminal_client_frame::Payload::Hello(value) => value,
                    _ => panic!("wrong terminal hello"),
                }
            } else {
                match proto::WebClientFrame::decode(sent)
                    .unwrap()
                    .payload
                    .unwrap()
                {
                    proto::web_client_frame::Payload::Hello(value) => value,
                    _ => panic!("wrong browser hello"),
                }
            };
            assert_eq!(actual.token, "access-a");
            assert_eq!(actual.selection_lease, "verified-server-lease");
            peer.send(Message::Binary(b"safe-renderer-binary".to_vec().into()))
                .await
                .unwrap();
            let event = next_event(&mut rx, "message").await;
            assert_eq!(
                BASE64.decode(event.2.unwrap()).unwrap(),
                b"safe-renderer-binary"
            );
            account.state.logout(&public.session_handle).await.unwrap();
            next_event(&mut rx, "close").await;
            assert!(queue_frame(
                &account.state,
                &sockets,
                send_request(&public.session_handle, "wire", b"late")
            )
            .await
            .is_err());
            assert!(sockets.sockets.lock().await.is_empty());
        }
    }
    #[tokio::test]
    async fn real_wire_never_delivers_reflected_account_tokens_or_managed_keys() {
        for secret in ["access-a", "refresh-a", "sk-managed-a", "sk-inactive-a"] {
            let account = super::super::tests::Fixture::new().await;
            let public = account.login("a", false).await;
            account
                .state
                .public_summary(&public.session_handle)
                .await
                .unwrap();
            let sockets = Arc::new(AccountSocketState::default());
            let (origin, server) = wire_fixture("/ws/v2").await;
            let (events, mut rx) = capture_events();
            connect_socket(
                account.state.clone(),
                sockets.clone(),
                origin.clone(),
                connect_request(&origin, &public.session_handle, "/ws/v2", "reflect"),
                events,
            )
            .await
            .unwrap();
            let mut peer = server.await.unwrap();
            next_event(&mut rx, "open").await;
            queue_frame(
                &account.state,
                &sockets,
                send_request(
                    &public.session_handle,
                    "reflect",
                    &frame(hello(&public.session_handle), false),
                ),
            )
            .await
            .unwrap();
            peer.next().await.unwrap().unwrap();
            peer.send(Message::Binary(
                format!("prefix {secret} suffix").into_bytes().into(),
            ))
            .await
            .unwrap();
            let closed = tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                closed.1, "close",
                "private bytes must never become a renderer message"
            );
            assert!(closed.2.is_none());
            assert!(sockets.sockets.lock().await.is_empty());
        }
    }
    #[tokio::test]
    async fn blocked_wire_writes_are_cancellable_and_old_owners_cannot_close_a_replacement() {
        let account = super::super::tests::Fixture::new().await;
        let a = account.login("a", false).await;
        let sockets = Arc::new(AccountSocketState::default());
        let (origin, server) = wire_fixture("/ws/v2").await;
        let (events, mut rx) = capture_events();
        connect_socket(
            account.state.clone(),
            sockets.clone(),
            origin.clone(),
            connect_request(&origin, &a.session_handle, "/ws/v2", "reused-id"),
            events,
        )
        .await
        .unwrap();
        let mut peer = server.await.unwrap();
        next_event(&mut rx, "open").await;
        queue_frame(
            &account.state,
            &sockets,
            send_request(
                &a.session_handle,
                "reused-id",
                &frame(hello(&a.session_handle), false),
            ),
        )
        .await
        .unwrap();
        peer.next().await.unwrap().unwrap();
        // The peer stops reading. Shared immutable payloads fill the native transport queue
        // without allocating a separate multi-megabyte buffer for every message.
        let sender = sockets
            .sockets
            .lock()
            .await
            .get("reused-id")
            .unwrap()
            .sender
            .clone();
        let payload = Message::Binary(vec![0; 4 << 20].into());
        for _ in 0..16 {
            sender.try_send(payload.clone()).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            sender.capacity() < 63,
            "fixture must exercise a blocked or queued write"
        );
        close_socket(&account.state, &sockets, "reused-id", &a.session_handle)
            .await
            .unwrap();
        next_event(&mut rx, "close").await;
        let b = account.login("b", false).await;
        let (origin, new_server) = wire_fixture("/ws/v2").await;
        let (events, mut rx) = capture_events();
        connect_socket(
            account.state.clone(),
            sockets.clone(),
            origin.clone(),
            connect_request(&origin, &b.session_handle, "/ws/v2", "reused-id"),
            events,
        )
        .await
        .unwrap();
        let mut new_peer = new_server.await.unwrap();
        next_event(&mut rx, "open").await;
        assert!(queue_frame(
            &account.state,
            &sockets,
            send_request(&a.session_handle, "reused-id", b"old")
        )
        .await
        .is_err());
        assert!(
            close_socket(&account.state, &sockets, "reused-id", &a.session_handle)
                .await
                .is_err()
        );
        queue_frame(
            &account.state,
            &sockets,
            send_request(
                &b.session_handle,
                "reused-id",
                &frame(hello(&b.session_handle), false),
            ),
        )
        .await
        .unwrap();
        let Message::Binary(sent) = new_peer.next().await.unwrap().unwrap() else {
            panic!("missing replacement hello")
        };
        let proto::web_client_frame::Payload::Hello(actual) = proto::WebClientFrame::decode(sent)
            .unwrap()
            .payload
            .unwrap()
        else {
            panic!("wrong replacement hello")
        };
        assert_eq!(actual.token, "access-b");
        close_socket(&account.state, &sockets, "reused-id", &b.session_handle)
            .await
            .unwrap();
        next_event(&mut rx, "close").await;
        assert!(sockets.sockets.lock().await.is_empty());
    }
}
