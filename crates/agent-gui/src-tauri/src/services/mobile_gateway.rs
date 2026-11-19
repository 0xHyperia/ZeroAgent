#![cfg(mobile)]

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{header as ws_header, HeaderValue},
    protocol::Message,
};
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

const SESSION_COOKIE: &str = "zeroagent_session";
const OFFICIAL_GATEWAY_URL: &str = "https://agent.usa0.top";
const DEFAULT_GATEWAY_PORT: u16 = 443;

#[path = "mobile_gateway/session.rs"]
mod session;
pub use session::http_stream::HttpStreamItem;
use session::http_stream::{self, HttpStreams};
pub use session::MobileGatewayResponse;
use session::{MobileGatewaySession, RequestOwner, SocketRegistry};

#[derive(Deserialize, Serialize)]
struct PersistedMobileGatewaySession {
    origin: String,
    session_id: String,
    user_id: Option<i64>,
    cache: BTreeMap<String, MobileGatewayResponse>,
}

struct SocketChannels {
    sender: mpsc::UnboundedSender<Message>,
    cancel: oneshot::Sender<()>,
}

pub struct MobileGatewayState {
    client: Client,
    websocket_tls: Arc<rustls::ClientConfig>,
    session: Arc<Mutex<MobileGatewaySession>>,
    sockets: Arc<Mutex<SocketRegistry<SocketChannels>>>,
    streams: HttpStreams,
}

impl Default for MobileGatewayState {
    fn default() -> Self {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ZeroAgent TLS protocol versions must be valid")
        .with_root_certificates(roots)
        .with_no_client_auth();
        let client = Client::builder()
            .tls_backend_preconfigured(tls.clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("ZeroAgent mobile Gateway HTTPS client must initialize");

        Self {
            client,
            websocket_tls: Arc::new(tls),
            session: Arc::new(Mutex::new(MobileGatewaySession::default())),
            sockets: Arc::new(Mutex::new(SocketRegistry::default())),
            streams: Arc::new(Mutex::new(SocketRegistry::default())),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewaySocketConnect {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub protocols: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewaySocketSend {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileGatewaySocketEvent {
    id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewayRequest {
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewayMultipartRequest {
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub parts: Vec<MobileGatewayMultipartPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewayMultipartPart {
    pub name: String,
    pub value: Option<String>,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
    pub data: Option<String>,
}

fn normalize_origin(value: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value.trim()).map_err(|_| "Gateway URL is invalid")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Gateway URL must use HTTP or HTTPS".to_string());
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn compiled_gateway_origin() -> Result<String, String> {
    let gateway_url = option_env!("ZEROAGENT_GATEWAY_URL")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(OFFICIAL_GATEWAY_URL);
    let gateway_port = option_env!("ZEROAGENT_GATEWAY_PORT")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_GATEWAY_PORT);
    let mut url = reqwest::Url::parse(&normalize_origin(gateway_url)?)
        .map_err(|_| "Gateway URL is invalid".to_string())?;
    url.set_port(Some(gateway_port))
        .map_err(|_| "Gateway port is invalid".to_string())?;
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn cache_key(request: &MobileGatewayRequest) -> String {
    format!("{} {}", request.method.to_ascii_uppercase(), request.path)
}

fn request_url(origin: &str, path: &str) -> Result<reqwest::Url, String> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("Only Gateway-relative paths are allowed".to_string());
    }
    reqwest::Url::parse(&format!("{origin}{path}"))
        .map_err(|_| "Gateway request URL is invalid".to_string())
}

fn socket_url(origin: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = request_url(origin, path)?;
    match url.scheme() {
        "http" => {
            url.set_scheme("ws")
                .map_err(|_| "Gateway WebSocket URL is invalid")?;
        }
        "https" => {
            url.set_scheme("wss")
                .map_err(|_| "Gateway WebSocket URL is invalid")?;
        }
        _ => return Err("Gateway WebSocket URL is invalid".to_string()),
    }
    Ok(url)
}

fn emit_socket_event(app: &tauri::AppHandle, event: MobileGatewaySocketEvent) {
    let _ = app.emit("mobile-gateway-socket", event);
}

fn persist_session(session: &MobileGatewaySession) -> Result<(), String> {
    let persisted = PersistedMobileGatewaySession {
        origin: session.origin.clone(),
        session_id: session.session_id.clone(),
        user_id: session.user_id,
        cache: session.cache.clone(),
    };
    let data = serde_json::to_vec(&persisted)
        .map_err(|error| format!("serialize encrypted mobile state: {error}"))?;
    super::mobile_secure_store::save(&data)
}

#[tauri::command]
pub fn mobile_gateway_bootstrap(state: tauri::State<'_, MobileGatewayState>) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    let configured_origin = compiled_gateway_origin()?;
    if session.origin.is_empty() {
        if let Some(data) = super::mobile_secure_store::load()? {
            let persisted: PersistedMobileGatewaySession = serde_json::from_slice(&data)
                .map_err(|error| format!("parse encrypted mobile state: {error}"))?;
            if normalize_origin(&persisted.origin)? == configured_origin {
                session.restore(
                    configured_origin.clone(),
                    persisted.session_id,
                    persisted.user_id,
                    persisted.cache,
                );
            } else {
                super::mobile_secure_store::clear()?;
            }
        }
        if session.origin.is_empty() {
            session.restore(configured_origin, String::new(), None, BTreeMap::new());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn mobile_gateway_logout(state: tauri::State<'_, MobileGatewayState>) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    session.logout();
    super::mobile_secure_store::clear()?;
    let mut sockets = state
        .sockets
        .lock()
        .map_err(|_| "mobile Gateway sockets are unavailable")?;
    for channels in sockets.drain() {
        let _ = channels.cancel.send(());
    }
    let mut streams = state
        .streams
        .lock()
        .map_err(|_| "Gateway streams are unavailable")?;
    http_stream::close_all(&mut streams);
    Ok(())
}

fn stream_request_header_allowed(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "cookie"
            | "cookie2"
            | "authorization"
            | "proxy-authorization"
            | "host"
            | "origin"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "upgrade"
    )
}

#[tauri::command]
pub async fn mobile_gateway_stream_open(
    request: MobileGatewayRequest,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<String, String> {
    if !request.path.starts_with("/api/web-chat/") {
        return Err("Streaming requires a CloudChat API path".into());
    }
    if request.body.len() > 32 * 1024 * 1024 {
        return Err("Gateway stream request is too large".into());
    }
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Gateway request method is invalid")?;
    if method != Method::GET && method != Method::POST {
        return Err("Gateway stream method is not supported".into());
    }
    let owner = state
        .session
        .lock()
        .map_err(|_| "Gateway session is unavailable")?
        .owner()?;
    let url = request_url(&owner.origin, &request.path)?;
    if !url.path().starts_with("/api/web-chat/") || request.path.contains('\\') {
        return Err("Streaming requires a canonical CloudChat API path".into());
    }
    let mut builder = state.client.request(method, url);
    for (name, value) in &request.headers {
        if stream_request_header_allowed(name) {
            if let (Ok(name), Ok(value)) = (
                header::HeaderName::from_bytes(name.as_bytes()),
                header::HeaderValue::from_str(value),
            ) {
                builder = builder.header(name, value);
            }
        }
    }
    if !owner.session_id.is_empty() {
        builder = builder.header(
            header::COOKIE,
            format!("{SESSION_COOKIE}={}", owner.session_id),
        );
    }
    if !request.body.is_empty() {
        builder = builder.body(request.body);
    }
    let registered = {
        let session = state
            .session
            .lock()
            .map_err(|_| "Gateway session is unavailable")?;
        let mut streams = state
            .streams
            .lock()
            .map_err(|_| "Gateway streams are unavailable")?;
        http_stream::register(&session, &mut streams, owner.clone())?
    };
    let id = registered.id.clone();
    let session = Arc::clone(&state.session);
    let streams = Arc::clone(&state.streams);
    tokio::spawn(async move {
        let sender = registered.sender;
        let work = async {
            let result = async {
                let response = builder
                    .send()
                    .await
                    .map_err(|_| "Unable to connect Gateway stream")?;
                let status = response.status().as_u16();
                let headers = response
                    .headers()
                    .iter()
                    .filter_map(|(name, value)| {
                        value
                            .to_str()
                            .ok()
                            .map(|value| (name.as_str().to_string(), value.to_string()))
                    })
                    .collect();
                let cookies = response
                    .headers()
                    .get_all(header::SET_COOKIE)
                    .iter()
                    .filter_map(|value| value.to_str().ok().map(str::to_string))
                    .collect::<Vec<_>>();
                let public = {
                    let mut session = session
                        .lock()
                        .map_err(|_| "Gateway session is unavailable")?;
                    let public = session.accept_response(
                        &owner,
                        &request.path,
                        status,
                        headers,
                        &cookies,
                        String::new(),
                        None,
                    )?;
                    persist_session(&session)?;
                    session.require_owner(&owner)?;
                    public
                };
                sender
                    .send(Ok(HttpStreamItem::Headers {
                        status: public.status,
                        headers: public.headers,
                    }))
                    .await
                    .map_err(|_| "Gateway stream consumer closed")?;
                http_stream::forward_response(response, &sender).await
            }
            .await;
            if let Err(error) = result {
                let _ = sender.send(Err(error)).await;
            }
        };
        // This also cancels waiting for response headers and a full bounded IPC buffer.
        if http_stream::run_owned(
            owner.clone(),
            registered.cancelled,
            registered.activity,
            work,
        )
        .await
        .is_none()
        {
            if let Ok(mut streams) = streams.lock() {
                streams.remove_current(&registered.id, registered.instance);
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn mobile_gateway_stream_read(
    id: String,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<Option<HttpStreamItem>, String> {
    http_stream::read(&state.session, &state.streams, id.trim()).await
}

#[tauri::command]
pub fn mobile_gateway_stream_close(
    id: String,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<(), String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Gateway session is unavailable")?;
    let mut streams = state
        .streams
        .lock()
        .map_err(|_| "Gateway streams are unavailable")?;
    http_stream::close(&session, &mut streams, id.trim())
}

fn emit_owned_socket_event(
    app: &tauri::AppHandle,
    session: &Mutex<MobileGatewaySession>,
    sockets: &Mutex<SocketRegistry<SocketChannels>>,
    id: &str,
    instance: u64,
    kind: &'static str,
    data: Option<String>,
) -> bool {
    // Same lock order as logout/registration/send; no event from a retired connection
    // can be delivered to a replacement using the same renderer socket ID.
    let Ok(session) = session.lock() else {
        return false;
    };
    let Ok(sockets) = sockets.lock() else {
        return false;
    };
    if !sockets.is_current(&session, id, instance) {
        return false;
    }
    emit_socket_event(
        app,
        MobileGatewaySocketEvent {
            id: id.into(),
            kind,
            data,
            message: None,
        },
    );
    true
}

#[tauri::command]
pub async fn mobile_gateway_socket_connect(
    request: MobileGatewaySocketConnect,
    state: tauri::State<'_, MobileGatewayState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let id = request.id.trim().to_string();
    if id.is_empty() {
        return Err("Gateway WebSocket id is required".to_string());
    }
    let owner = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?
        .owner()?;
    if owner.session_id.is_empty() {
        return Err("Account login is required".into());
    }
    let socket_url = socket_url(&owner.origin, &request.path)?;
    let mut handshake = socket_url
        .as_str()
        .into_client_request()
        .map_err(|_| "Unable to build Gateway WebSocket request")?;
    handshake.headers_mut().insert(
        ws_header::COOKIE,
        HeaderValue::from_str(&format!("{SESSION_COOKIE}={}", owner.session_id))
            .map_err(|_| "Gateway session is invalid".to_string())?,
    );
    if !request.protocols.is_empty() {
        let protocols = request
            .protocols
            .iter()
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if !protocols.is_empty() {
            handshake.headers_mut().insert(
                ws_header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocols)
                    .map_err(|_| "Gateway WebSocket protocol is invalid".to_string())?,
            );
        }
    }
    let connector = Connector::Rustls(Arc::clone(&state.websocket_tls));
    let (socket, _) = connect_async_tls_with_config(handshake, None, false, Some(connector))
        .await
        .map_err(|_| "Unable to connect Gateway WebSocket")?;
    let (mut sink, mut stream) = socket.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
    let (cancel, cancelled) = oneshot::channel();
    let instance = {
        // Hold the owner lock through insertion so logout cannot occur between them.
        let session = state
            .session
            .lock()
            .map_err(|_| "mobile gateway state is unavailable")?;
        let mut sockets = state
            .sockets
            .lock()
            .map_err(|_| "mobile Gateway sockets are unavailable")?;
        let (instance, previous) = sockets.insert(
            &session,
            owner.clone(),
            id.clone(),
            SocketChannels { sender, cancel },
        )?;
        if let Some(previous) = previous {
            let _ = previous.cancel.send(());
        }
        instance
    };
    let session = state.session.clone();
    let sockets = state.sockets.clone();
    tokio::spawn(async move {
        let relay = async {
            if !emit_owned_socket_event(&app, &session, &sockets, &id, instance, "open", None) {
                return;
            }
            loop {
                tokio::select! {
                    message = receiver.recv() => {
                        let Some(message) = message else { break; };
                        // A replaced connection cannot drain queued writes into the old account.
                        let current = {
                            let Ok(session) = session.lock() else { break; };
                            let Ok(sockets) = sockets.lock() else { break; };
                            sockets.is_current(&session, &id, instance)
                        };
                        if !current || sink.send(message).await.is_err() { break; }
                    }
                    message = stream.next() => match message {
                        Some(Ok(Message::Binary(data))) => {
                            if !emit_owned_socket_event(&app, &session, &sockets, &id, instance,
                                "message", Some(BASE64.encode(data))) { break; }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            if sink.send(Message::Pong(data)).await.is_err() { break; }
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        };
        // Cancellation wraps the entire relay, including a blocked network write.
        session::run_owned(owner, cancelled, relay).await;
        let _ = tokio::time::timeout(std::time::Duration::from_millis(100), sink.close()).await;
        emit_owned_socket_event(&app, &session, &sockets, &id, instance, "close", None);
        if let Ok(mut sockets) = sockets.lock() {
            sockets.remove_current(&id, instance);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn mobile_gateway_socket_send(
    request: MobileGatewaySocketSend,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<(), String> {
    let data = BASE64
        .decode(request.data)
        .map_err(|_| "Gateway WebSocket payload is invalid".to_string())?;
    let session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    let sockets = state
        .sockets
        .lock()
        .map_err(|_| "mobile Gateway sockets are unavailable")?;
    sockets
        .get(&session, request.id.trim())?
        .sender
        .send(Message::Binary(data.into()))
        .map_err(|_| "Gateway WebSocket is closed".to_string())
}

#[tauri::command]
pub fn mobile_gateway_socket_close(
    id: String,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<(), String> {
    let channels = state
        .sockets
        .lock()
        .map_err(|_| "mobile Gateway sockets are unavailable")?
        .remove(id.trim());
    if let Some(channels) = channels {
        let _ = channels.cancel.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_gateway_request(
    request: MobileGatewayRequest,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<MobileGatewayResponse, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Gateway request method is invalid")?;
    let key = cache_key(&request);
    let owner = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?
        .owner()?;
    let url = request_url(&owner.origin, &request.path)?;
    let cache_request = url.path() != "/api/workbench/availability";
    let mut builder = state.client.request(method.clone(), url);
    for (name, value) in &request.headers {
        if let (Ok(name), Ok(value)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            header::HeaderValue::from_str(value),
        ) {
            builder = builder.header(name, value);
        }
    }
    if !owner.session_id.is_empty() {
        builder = builder.header(
            header::COOKIE,
            format!("{SESSION_COOKIE}={}", owner.session_id),
        );
    }
    if !request.body.is_empty() {
        builder = builder.body(request.body.clone());
    }
    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            let session = state
                .session
                .lock()
                .map_err(|_| "mobile gateway state is unavailable")?;
            session.require_owner(&owner)?;
            if cache_request && method == Method::GET {
                if let Some(cached) = session.cached(&owner, &key)? {
                    return Ok(cached);
                }
            }
            return Err(format!("Gateway request failed: {error}"));
        }
    };
    collect_gateway_response(
        response,
        &request.path,
        cache_request.then_some((&method, key.as_str())),
        &owner,
        &state,
    )
    .await
}

async fn collect_gateway_response(
    response: reqwest::Response,
    request_path: &str,
    cache_request: Option<(&Method, &str)>,
    owner: &RequestOwner,
    state: &MobileGatewayState,
) -> Result<MobileGatewayResponse, String> {
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let set_cookies = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect::<Vec<_>>();
    let body = response
        .text()
        .await
        .map_err(|error| format!("read Gateway response: {error}"))?;
    let mut session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    let key = cache_request
        .filter(|(method, _)| **method == Method::GET)
        .map(|(_, key)| key);
    let result = session.accept_response(
        owner,
        request_path,
        status,
        headers,
        &set_cookies,
        body,
        key,
    )?;
    persist_session(&session)?;
    Ok(result)
}

#[tauri::command]
pub async fn mobile_gateway_multipart_request(
    request: MobileGatewayMultipartRequest,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<MobileGatewayResponse, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Gateway request method is invalid")?;
    let owner = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?
        .owner()?;
    let url = request_url(&owner.origin, &request.path)?;
    let mut builder = state.client.request(method, url);
    for (name, value) in &request.headers {
        if name.eq_ignore_ascii_case(header::CONTENT_TYPE.as_str())
            || name.eq_ignore_ascii_case(header::CONTENT_LENGTH.as_str())
        {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            header::HeaderValue::from_str(value),
        ) {
            builder = builder.header(name, value);
        }
    }
    if !owner.session_id.is_empty() {
        builder = builder.header(
            header::COOKIE,
            format!("{SESSION_COOKIE}={}", owner.session_id),
        );
    }

    let mut form = reqwest::multipart::Form::new();
    for item in request.parts {
        let name = item.name.trim();
        if name.is_empty() {
            return Err("Gateway multipart field name is required".to_string());
        }
        if let Some(data) = item.data {
            let bytes = BASE64
                .decode(data)
                .map_err(|_| "Gateway multipart file data is invalid")?;
            let mut part = reqwest::multipart::Part::bytes(bytes);
            if let Some(file_name) = item.file_name.filter(|value| !value.trim().is_empty()) {
                part = part.file_name(file_name);
            }
            if let Some(content_type) = item.content_type.filter(|value| !value.trim().is_empty()) {
                part = part
                    .mime_str(&content_type)
                    .map_err(|_| "Gateway multipart content type is invalid")?;
            }
            form = form.part(name.to_string(), part);
        } else {
            form = form.text(name.to_string(), item.value.unwrap_or_default());
        }
    }

    let response = builder
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Gateway multipart request failed: {error}"))?;
    collect_gateway_response(response, &request.path, None, &owner, &state).await
}
