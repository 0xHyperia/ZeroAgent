//! Native-only Gateway cookies for the complete desktop remote-device workbench.
//!
//! The existing one-use desktop handoff establishes the HTTP session required by
//! Gateway uploads. Neither that cookie nor the USA-Zero token reaches the view.
use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::header::{COOKIE, LOCATION, SET_COOKIE};
use std::{collections::HashMap, future::Future};
use tauri::{Manager, State};
use tokio::sync::watch;

const COOKIE_NAME: &str = "zeroagent_session";
const MAX_BRIDGES: usize = 8;
// Keep the WebUI's 200 MiB directory limit, plus bounded multipart metadata.
const MAX_REQUEST_BYTES: usize = 208 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

struct RemoteBridge {
    owner: String,
    origin: Url,
    device_id: String,
    cookie: String,
    selection: Value,
    credential: String,
    closed: watch::Sender<bool>,
}

#[derive(Default)]
pub struct RemoteGatewayState {
    bridges: Mutex<HashMap<String, Arc<RemoteBridge>>>,
}

impl RemoteGatewayState {
    async fn bridge(&self, owner: &str, id: &str) -> Result<Arc<RemoteBridge>, String> {
        self.bridges
            .lock()
            .await
            .get(id)
            .filter(|bridge| bridge.owner == owner && !*bridge.closed.borrow())
            .cloned()
            .ok_or_else(|| "Remote Gateway connection is no longer active".into())
    }

    async fn remove(&self, owner: &str, id: &str) -> Result<Option<Arc<RemoteBridge>>, String> {
        let mut bridges = self.bridges.lock().await;
        if bridges.get(id).is_some_and(|bridge| bridge.owner != owner) {
            return Err("Remote Gateway connection belongs to another account session".into());
        }
        let bridge = bridges.remove(id);
        if let Some(bridge) = &bridge {
            bridge.closed.send_replace(true);
        }
        Ok(bridge)
    }

    pub(crate) async fn close_session(&self, state: &AccountSessionState, owner: &str) {
        let retired = {
            let mut bridges = self.bridges.lock().await;
            let ids: Vec<_> = bridges
                .iter()
                .filter(|(_, bridge)| bridge.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| bridges.remove(&id))
                .collect::<Vec<_>>()
        };
        for bridge in retired {
            bridge.closed.send_replace(true);
            let client = state.client.clone();
            tokio::spawn(async move { logout_bridge(&client, &bridge).await });
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOpenRequest {
    pub session_handle: String,
    pub origin: String,
    pub device_id: String,
    pub selection_lease: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOpenResponse {
    pub bridge_id: String,
    pub selection: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteHttpRequest {
    pub session_handle: String,
    pub bridge_id: String,
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body_base64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCloseRequest {
    pub session_handle: String,
    pub bridge_id: String,
}

fn component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn session_cookie(headers: &reqwest::header::HeaderMap) -> Result<String, String> {
    let mut cookie = None;
    for value in headers.get_all(SET_COOKIE) {
        let raw = value
            .to_str()
            .map_err(|_| "Invalid Gateway session cookie")?;
        if raw.len() > 4096 {
            return Err("Invalid Gateway session cookie".into());
        }
        let Some((name, value)) = raw.split(';').next().and_then(|part| part.split_once('='))
        else {
            continue;
        };
        if name.trim() == COOKIE_NAME {
            if cookie.is_some() || !component(value) || value.len() > 128 {
                return Err("Invalid Gateway session cookie".into());
            }
            cookie = Some(value.to_string());
        }
    }
    cookie.ok_or_else(|| "Gateway did not establish an HTTP session".into())
}

fn handoff_selection(origin: &Url, location: &str, device_id: &str) -> Result<Value, String> {
    let destination = origin
        .join(location)
        .map_err(|_| "Invalid Gateway handoff")?;
    if !location.starts_with("/?")
        || destination.origin() != origin.origin()
        || destination.path() != "/"
        || destination.fragment().is_some()
    {
        return Err("Invalid Gateway handoff destination".into());
    }
    let pairs: Vec<_> = destination.query_pairs().into_owned().collect();
    let read = |key: &str| -> Result<String, String> {
        let values: Vec<_> = pairs.iter().filter(|(name, _)| name == key).collect();
        if values.len() != 1 {
            return Err("Invalid Gateway handoff selection".into());
        }
        Ok(values[0].1.clone())
    };
    let lease = read("selection_lease")?;
    let conversation = read("conversation_id")?;
    if read("runtime_kind")? != "device_agent"
        || read("device_id")? != device_id
        || read("agent_id")? != device_id
        || !read("workspace_id")?.is_empty()
        || !component(&lease)
        || !component(&conversation)
    {
        return Err("Gateway handoff changed the selected device".into());
    }
    Ok(json!({
        "selection_lease": lease,
        "runtime_kind": "device_agent",
        "device_id": device_id,
        "agent_id": device_id,
        "workspace_id": "",
        "scope": "device",
        "target_fingerprint": format!("device_agent:{device_id}:"),
        "conversation_id": conversation,
        // The existing redirect does not expose a deadline. The desktop shell
        // retains its original, server-issued deadline; Gateway enforces both.
        "expires_at": ""
    }))
}

fn selection_credential(selection: &Value) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!(
        "selection.{}",
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "lease": selection["selection_lease"],
                "runtimeKind": "device_agent",
                "deviceId": selection["device_id"],
                "agentId": selection["agent_id"],
                "workspaceId": ""
            }))
            .expect("serialize a Gateway selection")
        )
    )
}

async fn logout_bridge(client: &Client, bridge: &RemoteBridge) {
    let Ok(url) = super::gateway::gateway_url(&bridge.origin, "/api/auth/logout") else {
        return;
    };
    let _ = client
        .post(url)
        .header(COOKIE, format!("{COOKIE_NAME}={}", bridge.cookie))
        .timeout(Duration::from_secs(1))
        .send()
        .await;
}

async fn open_remote(
    state: &AccountSessionState,
    remote: &RemoteGatewayState,
    origin: Url,
    request: RemoteOpenRequest,
) -> Result<RemoteOpenResponse, String> {
    if Url::parse(&request.origin)
        .map_err(|_| "Invalid Gateway origin")?
        .origin()
        != origin.origin()
        || !component(&request.device_id)
        || !component(&request.selection_lease)
    {
        return Err("Invalid selected Gateway device".into());
    }
    state.require_current(&request.session_handle).await?;
    let handoff = state
        .gateway_raw(
            &request.session_handle,
            &origin,
            "POST",
            "/api/desktop/handoff",
            Some(&json!({"selection_lease": request.selection_lease})),
        )
        .await?;
    if handoff.status != 200 {
        return Err("Remote device authorization must be renewed".into());
    }
    let code = handoff.body["handoff_code"]
        .as_str()
        .filter(|code| !code.is_empty() && code.len() <= 4096)
        .ok_or("Invalid Gateway handoff response")?;
    let mut url = super::gateway::gateway_url(&origin, "/api/auth/handoff")?;
    url.query_pairs_mut().append_pair("code", code);
    let response = state
        .client
        .get(url)
        .send()
        .await
        .map_err(|_| "Gateway handoff failed")?;
    if response.status() != StatusCode::SEE_OTHER {
        return Err("Gateway handoff was not accepted".into());
    }
    let cookie = session_cookie(response.headers())?;
    let (closed, _) = watch::channel(false);
    let mut bridge = RemoteBridge {
        owner: request.session_handle.clone(),
        origin,
        device_id: request.device_id.clone(),
        cookie,
        selection: Value::Null,
        credential: String::new(),
        closed,
    };
    let initialized = async {
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 8192)
            .ok_or("Invalid Gateway handoff destination")?;
        let selection = handoff_selection(&bridge.origin, location, &bridge.device_id)?;
        state.require_current(&request.session_handle).await?;
        Ok::<_, String>(selection)
    }
    .await;
    bridge.selection = match initialized {
        Ok(selection) => selection,
        Err(error) => {
            logout_bridge(&state.client, &bridge).await;
            return Err(error);
        }
    };
    bridge.credential = selection_credential(&bridge.selection);
    let bridge = Arc::new(bridge);
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut bridges = remote.bridges.lock().await;
        if bridges.len() >= MAX_BRIDGES {
            drop(bridges);
            logout_bridge(&state.client, &bridge).await;
            return Err("Too many remote Gateway connections".into());
        }
        bridges.insert(id.clone(), bridge.clone());
    }
    if let Err(error) = state.require_current(&request.session_handle).await {
        let _ = remote.remove(&request.session_handle, &id).await;
        logout_bridge(&state.client, &bridge).await;
        return Err(error);
    }
    Ok(RemoteOpenResponse {
        bridge_id: id,
        selection: bridge.selection.clone(),
    })
}

fn resource_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/api/status") | ("POST", "/api/files/import" | "/api/files/import-directory")
    )
}

fn redact_cookie(value: &mut Value, cookie: &str) {
    match value {
        Value::String(text) => *text = text.replace(cookie, "[protected]"),
        Value::Array(items) => {
            for item in items {
                redact_cookie(item, cookie);
            }
        }
        Value::Object(items) => {
            let mut clean = serde_json::Map::new();
            for (key, mut value) in std::mem::take(items) {
                redact_cookie(&mut value, cookie);
                clean.insert(key.replace(cookie, "[protected]"), value);
            }
            *items = clean;
        }
        _ => {}
    }
}

async fn while_current<T, F>(
    state: &AccountSessionState,
    bridge: &RemoteBridge,
    operation: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let mut ended = state.subscribe_ended();
    let mut closed = bridge.closed.subscribe();
    state.require_current(&bridge.owner).await?;
    if *closed.borrow() {
        return Err("Remote Gateway connection is no longer active".into());
    }
    let owner_ended = async {
        loop {
            match ended.recv().await {
                Ok(event) if event.handle != bridge.owner => continue,
                _ => break,
            }
        }
    };
    tokio::select! {
        result = operation => result,
        _ = owner_ended => Err(SESSION_CHANGED.into()),
        _ = closed.changed() => Err("Remote Gateway connection is no longer active".into())
    }
}

async fn remote_http(
    state: &AccountSessionState,
    remote: &RemoteGatewayState,
    request: RemoteHttpRequest,
) -> Result<RemoteHttpResponse, String> {
    let bridge = remote
        .bridge(&request.session_handle, &request.bridge_id)
        .await?;
    let mut url = super::gateway::gateway_url(&bridge.origin, &request.path)?;
    let method = request.method.to_ascii_uppercase();
    if !resource_route(&method, url.path()) {
        return Err("Remote Gateway endpoint is not allowed".into());
    }
    if request.headers.len() > 8
        || request.headers.iter().any(|(name, value)| {
            name.len() + value.len() > 4096
                || !matches!(
                    name.to_ascii_lowercase().as_str(),
                    "accept" | "content-type" | "authorization"
                )
                || reqwest::header::HeaderValue::from_str(value).is_err()
        })
    {
        return Err("Remote Gateway request headers are not allowed".into());
    }
    if request.headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("authorization")
            && value != &format!("Bearer {}", bridge.credential)
    }) {
        return Err("Remote Gateway request targets another selection".into());
    }
    let encoded = request.body_base64.unwrap_or_default();
    if encoded.len() > (MAX_REQUEST_BYTES + 2) / 3 * 4 {
        return Err("Remote Gateway upload is too large".into());
    }
    let body = BASE64
        .decode(encoded)
        .map_err(|_| "Invalid remote Gateway body")?;
    if body.len() > MAX_REQUEST_BYTES || method == "GET" && !body.is_empty() {
        return Err("Invalid remote Gateway request body".into());
    }
    let query: Vec<_> = url
        .query_pairs()
        .into_owned()
        .filter(|(key, _)| key != "agent_id")
        .collect();
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(query);
    if method == "POST" {
        url.query_pairs_mut()
            .append_pair("agent_id", &bridge.device_id);
    }
    while_current(state, &bridge, async {
        let mut outgoing = state
            .client
            .request(
                reqwest::Method::from_bytes(method.as_bytes())
                    .map_err(|_| "Invalid remote method")?,
                url,
            )
            .header(COOKIE, format!("{COOKIE_NAME}={}", bridge.cookie))
            .bearer_auth(&bridge.credential)
            .timeout(Duration::from_secs(120));
        for (name, value) in &request.headers {
            if !name.eq_ignore_ascii_case("authorization") {
                outgoing = outgoing.header(name, value);
            }
        }
        if !body.is_empty() {
            outgoing = outgoing.body(body);
        }
        let mut response = outgoing
            .send()
            .await
            .map_err(|_| "Remote Gateway request failed")?;
        let status = response.status().as_u16();
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err("Remote Gateway response is too large".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Remote Gateway response failed")?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("Remote Gateway response is too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let bytes = if status == 204 {
            Vec::new()
        } else {
            let mut value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid remote Gateway response")?;
            redact_cookie(&mut value, &bridge.cookie);
            state.redact(&bridge.owner, &mut value).await?;
            serde_json::to_vec(&value).map_err(|_| "Invalid remote Gateway response")?
        };
        state.require_current(&bridge.owner).await?;
        if *bridge.closed.borrow() {
            return Err("Remote Gateway connection is no longer active".into());
        }
        Ok(RemoteHttpResponse {
            status,
            headers: HashMap::from([("content-type".into(), "application/json".into())]),
            body_base64: BASE64.encode(bytes),
        })
    })
    .await
}

#[tauri::command]
pub async fn account_remote_open(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    remote: State<'_, Arc<RemoteGatewayState>>,
    request: RemoteOpenRequest,
) -> Result<RemoteOpenResponse, String> {
    super::api::guard_viewer(&app, state.inner(), &request.session_handle).await?;
    open_remote(
        state.inner(),
        remote.inner(),
        super::gateway::configured_gateway_origin()?,
        request,
    )
    .await
}

#[tauri::command]
pub async fn account_remote_http(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    remote: State<'_, Arc<RemoteGatewayState>>,
    request: RemoteHttpRequest,
) -> Result<RemoteHttpResponse, String> {
    super::api::guard_viewer(&app, state.inner(), &request.session_handle).await?;
    remote_http(state.inner(), remote.inner(), request).await
}

#[tauri::command]
pub async fn account_remote_close(
    state: State<'_, Arc<AccountSessionState>>,
    remote: State<'_, Arc<RemoteGatewayState>>,
    request: RemoteCloseRequest,
) -> Result<(), String> {
    // A retired view may still clean up its own capability after account logout.
    // A matching opaque ID and owner never grants access to another connection.
    if let Some(bridge) = remote
        .remove(&request.session_handle, &request.bridge_id)
        .await?
    {
        logout_bridge(&state.client, &bridge).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
