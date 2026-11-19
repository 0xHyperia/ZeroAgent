//! Bounded cloud-only HTTP transport owned by the current native account.
use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::{collections::HashMap, sync::Mutex as RegistryMutex};
use tauri::State;
use tokio::sync::watch;

const MAX_BODY_BYTES: usize = 36 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 128 * 1024 * 1024;

#[tauri::command]
pub async fn account_workspace_handoff(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    gateway: State<'_, Arc<crate::services::gateway::GatewayController>>,
    session_handle: String,
    workspace_id: String,
    expected_workspace_path: String,
    operation_id: String,
    file_name: String,
    body_base64: String,
    check_only: Option<bool>,
) -> Result<Option<String>, String> {
    api::guard_viewer(&app, state.inner(), &session_handle).await?;
    if body_base64.len() > MAX_BODY_BYTES.div_ceil(3) * 4 {
        return Err("File is too large".into());
    }
    let content = BASE64
        .decode(body_base64)
        .map_err(|_| "Invalid workspace transfer")?;
    state.require_current(&session_handle).await?;
    let destination = gateway.workspace_handoff_destination(&workspace_id).await?;
    // Settings resolution is asynchronous and can observe an account switch.
    // Check the caller again before publishing into the resolved directory.
    state.require_current(&session_handle).await?;
    let relative_path = crate::services::gateway::GatewayController::handle_workspace_handoff_to(
        destination,
        crate::services::gateway::proto::WorkspaceHandoffRequest {
            workspace_id,
            operation_id,
            file_name,
            content,
            check_only: check_only.unwrap_or_default(),
            expected_workspace_path,
        },
    )
    .await?;
    state.require_current(&session_handle).await?;
    Ok(relative_path)
}

struct CloudBridge {
    owner: String,
    origin: Url,
    retired: watch::Sender<bool>,
}

struct CloudStream {
    response: reqwest::Response,
    total: usize,
}

struct StreamEntry {
    bridge_id: String,
    retired: watch::Sender<bool>,
    body: Mutex<Option<CloudStream>>,
}

#[derive(Default)]
pub struct CloudGatewayState(RegistryMutex<CloudRegistry>);

#[derive(Default)]
struct CloudRegistry {
    document: u64,
    bridges: HashMap<String, Arc<CloudBridge>>,
    streams: HashMap<String, Arc<StreamEntry>>,
}

impl CloudRegistry {
    fn register(
        &mut self,
        document: u64,
        owner: String,
        origin: Url,
    ) -> Result<(String, watch::Receiver<bool>), String> {
        if document != self.document {
            return Err(SESSION_CHANGED.into());
        }
        if self.bridges.len() >= 4 {
            return Err("Too many cloud workbench connections".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (retired, closed) = watch::channel(false);
        self.bridges.insert(
            id.clone(),
            Arc::new(CloudBridge {
                owner,
                origin,
                retired,
            }),
        );
        Ok((id, closed))
    }

    fn bridge(&self, owner: &str, id: &str) -> Result<Arc<CloudBridge>, String> {
        self.bridges
            .get(id)
            .filter(|bridge| bridge.owner == owner)
            .cloned()
            .ok_or_else(|| SESSION_CHANGED.into())
    }

    fn register_stream(
        &mut self,
        stream_id: String,
        entry: Arc<StreamEntry>,
    ) -> Result<(), String> {
        if !self.bridges.contains_key(&entry.bridge_id)
            || self.streams.len() >= 24
            || self.streams.contains_key(&stream_id)
        {
            return Err("Cloud stream is unavailable".into());
        }
        self.streams.insert(stream_id, entry);
        Ok(())
    }

    fn stream(&self, bridge_id: &str, stream_id: &str) -> Result<Arc<StreamEntry>, String> {
        self.streams
            .get(stream_id)
            .filter(|entry| entry.bridge_id == bridge_id)
            .cloned()
            .ok_or_else(|| "Cloud stream has ended".into())
    }

    fn close_stream(&mut self, bridge_id: &str, stream_id: &str) {
        if let Ok(entry) = self.stream(bridge_id, stream_id) {
            self.streams.remove(stream_id);
            entry.retired.send_replace(true);
        }
    }

    fn close(&mut self, owner: &str, id: &str, stream: Option<&str>) -> Result<(), String> {
        self.bridge(owner, id)?;
        if let Some(stream_id) = stream {
            self.close_stream(id, stream_id);
        } else {
            self.retire_where(|bridge_id, _| bridge_id == id);
        }
        Ok(())
    }

    fn retire_where(&mut self, mut matches: impl FnMut(&str, &CloudBridge) -> bool) {
        self.bridges.retain(|id, bridge| {
            if matches(id, bridge) {
                bridge.retired.send_replace(true);
                false
            } else {
                true
            }
        });
        self.streams.retain(|_, entry| {
            if self.bridges.contains_key(&entry.bridge_id) {
                true
            } else {
                entry.retired.send_replace(true);
                false
            }
        });
    }
}

impl CloudGatewayState {
    fn registry(&self) -> std::sync::MutexGuard<'_, CloudRegistry> {
        self.0.lock().expect("cloud transport registry lock")
    }

    pub(crate) fn retire(&self, owner: &str) {
        self.registry()
            .retire_where(|_, bridge| bridge.owner == owner);
    }

    pub(crate) fn start_document(&self) {
        // Navigation may destroy the renderer before its cleanup can invoke Native.
        // Advance before retiring so a pending authorization cannot reinsert a bridge.
        let mut registry = self.registry();
        registry.document = registry.document.wrapping_add(1);
        registry.retire_where(|_, _| true);
    }
}

fn cloud_path(method: &str, path: &str) -> bool {
    matches!(method, "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE")
        && (path.starts_with("/api/web-chat/") && path != super::device_skills::DEVICE_SKILL_PATH
            || matches!(
                (method, path),
                (
                    "GET",
                    "/api/auth/me"
                        | "/api/environments"
                        | "/api/web-settings"
                        | "/api/workbench/availability"
                ) | ("PATCH", "/api/web-settings")
            ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloading_releases_transport_capacity_and_rejects_late_authorization() {
        let cloud = CloudGatewayState::default();
        let origin = Url::parse("https://example.test").unwrap();
        let mut previous_document = None;

        for _ in 0..6 {
            let mut registry = cloud.registry();
            let document = registry.document;
            if let Some(previous) = previous_document {
                assert!(registry
                    .register(previous, "account".into(), origin.clone())
                    .is_err());
            }
            let (bridge_id, closed) = registry
                .register(document, "account".into(), origin.clone())
                .unwrap();
            for _ in 0..3 {
                registry
                    .register(document, "account".into(), origin.clone())
                    .unwrap();
            }
            assert!(registry
                .register(document, "account".into(), origin.clone())
                .is_err());

            let (retired, stream_closed) = watch::channel(false);
            let entry = Arc::new(StreamEntry {
                bridge_id,
                retired,
                body: Mutex::new(None),
            });
            registry
                .register_stream("stream".into(), entry.clone())
                .unwrap();
            drop(registry);

            cloud.start_document();

            assert!(*closed.borrow());
            assert!(*stream_closed.borrow());
            assert!(cloud
                .registry()
                .register_stream("late".into(), entry)
                .is_err());
            previous_document = Some(document);
        }
    }

    #[test]
    fn cloud_workbench_can_read_and_update_its_account_model_settings() {
        assert!(cloud_path("GET", "/api/web-settings"));
        assert!(cloud_path("PATCH", "/api/web-settings"));
        assert!(!cloud_path("DELETE", "/api/web-settings"));
        assert!(!cloud_path("PATCH", "/api/web-settings/device"));
        assert!(!cloud_path("GET", "/api/managed-provider-keys"));
        assert!(!cloud_path(
            "POST",
            super::super::device_skills::DEVICE_SKILL_PATH
        ));
    }

    #[tokio::test]
    async fn cloud_viewer_requires_a_successful_json_identity_for_the_native_account() {
        use axum::{http::HeaderMap, routing::get, Router};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/api/auth/me",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let router = Router::new().route(
                "/api/auth/me",
                get(|headers: HeaderMap| async move {
                    assert_eq!(headers["x-zeroagent-account-id"], "7");
                    let (status, mime, body) = match headers["authorization"].to_str().unwrap() {
                        "Bearer fixture-current" | "Bearer fixture-renewed" => (
                            StatusCode::OK,
                            "application/json; charset=utf-8",
                            r#"{"user":{"id":7}}"#,
                        ),
                        "Bearer fixture-other" => {
                            (StatusCode::OK, "application/json", r#"{"user":{"id":8}}"#)
                        }
                        "Bearer fixture-spa" => (
                            StatusCode::OK,
                            "text/html",
                            "<!doctype html><title>WebUI</title>",
                        ),
                        "Bearer fixture-malformed" => {
                            (StatusCode::OK, "application/json", r#"{"user":"#)
                        }
                        _ => (StatusCode::UNAUTHORIZED, "application/json", "{}"),
                    };
                    (status, [("content-type", mime)], body)
                }),
            );
            axum::serve(listener, router).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (token, accepted) in [
            ("fixture-current", true),
            ("fixture-renewed", true),
            ("fixture-other", false),
            ("fixture-spa", false),
            ("fixture-malformed", false),
            ("fixture-expired", false),
        ] {
            assert_eq!(
                verify_cloud_viewer(&client, &url, token, 7, Duration::from_secs(3))
                    .await
                    .is_ok(),
                accepted,
                "{token}"
            );
        }
        server.abort();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOpenResponse {
    bridge_id: String,
    origin: String,
}

async fn verify_cloud_viewer(
    client: &reqwest::Client,
    url: &Url,
    access_token: &str,
    user_id: u64,
    timeout: Duration,
) -> Result<(), String> {
    const UNAVAILABLE: &str = "Cloud workbench authorization is unavailable";
    let response = client
        .get(url.clone())
        .bearer_auth(access_token)
        .header("X-ZeroAgent-Account-ID", user_id.to_string())
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| "Cloud authorization exchange failed")?;
    let json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"));
    if response.status() != StatusCode::OK || !json {
        return Err(UNAVAILABLE.into());
    }
    let identity = response_json(response).await.map_err(|_| UNAVAILABLE)?;
    if identity["user"]["id"].as_u64() != Some(user_id) {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn account_cloud_open(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    cloud: State<'_, Arc<CloudGatewayState>>,
    session_handle: String,
) -> Result<CloudOpenResponse, String> {
    let document = cloud.registry().document;
    api::guard_viewer(&app, state.inner(), &session_handle).await?;
    let origin = gateway::configured_gateway_origin()?;
    let url = gateway::gateway_url(&origin, "/api/auth/me")?;
    let user_id = state.snapshot(&session_handle).await?.public.user["id"]
        .as_u64()
        .ok_or(RESPONSE_ERROR)?;
    let tokens = state.access(&session_handle, false).await?;
    verify_cloud_viewer(
        &state.client,
        &url,
        &tokens.access_token,
        user_id,
        Duration::from_secs(30),
    )
    .await?;
    state.require_current(&session_handle).await?;
    let origin_string = origin.origin().ascii_serialization();
    let (id, mut closed) = cloud
        .registry()
        .register(document, session_handle.clone(), origin)?;
    if let Err(error) = state.require_current(&session_handle).await {
        let _ = cloud.registry().close(&session_handle, &id, None);
        return Err(error);
    }
    // Keep active Cloud Run references current when the native account rotates
    // its access token. Native remains the only holder of the refresh token.
    let account = state.inner().clone();
    let mut last_access = tokens.access_token;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = closed.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(15)) => {}
            }
            let Ok(tokens) = account.access(&session_handle, false).await else {
                if account.require_current(&session_handle).await.is_err() {
                    break;
                }
                continue;
            };
            if tokens.access_token == last_access {
                continue;
            }
            let renewal = verify_cloud_viewer(
                &account.client,
                &url,
                &tokens.access_token,
                user_id,
                Duration::from_secs(10),
            );
            let result = tokio::select! {
                _ = closed.changed() => break,
                result = renewal => result,
            };
            if result.is_ok() {
                last_access = tokens.access_token;
            }
        }
    });
    Ok(CloudOpenResponse {
        bridge_id: id,
        origin: origin_string,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudFetchRequest {
    session_handle: String,
    bridge_id: String,
    stream_id: String,
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body_base64: Option<String>,
}

#[derive(Serialize)]
pub struct CloudFetchResponse {
    status: u16,
    headers: HashMap<String, String>,
}

#[tauri::command]
pub async fn account_cloud_fetch(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    cloud: State<'_, Arc<CloudGatewayState>>,
    request: CloudFetchRequest,
) -> Result<CloudFetchResponse, String> {
    api::guard_viewer(&app, state.inner(), &request.session_handle).await?;
    let bridge = cloud
        .registry()
        .bridge(&request.session_handle, &request.bridge_id)?;
    if request.path.len() > 8192 || uuid::Uuid::parse_str(&request.stream_id).is_err() {
        return Err("Invalid cloud request".into());
    }
    let url = gateway::gateway_url(&bridge.origin, &request.path)?;
    if !cloud_path(&request.method, url.path()) {
        return Err("Cloud endpoint is not allowed".into());
    }
    let tokens = state.access(&request.session_handle, false).await?;
    let mut outgoing = state
        .client
        .request(
            reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|_| "Invalid cloud request method")?,
            url,
        )
        .bearer_auth(&tokens.access_token)
        .timeout(Duration::from_secs(3600));
    if request.headers.len() > 10 {
        return Err("Invalid cloud request headers".into());
    }
    for (name, value) in request.headers {
        if value.len() > 4096
            || !matches!(
                name.as_str(),
                "accept"
                    | "content-type"
                    | "range"
                    | "if-none-match"
                    | "x-zeroagent-account-id"
                    | "last-event-id"
            )
        {
            return Err("Invalid cloud request header".into());
        }
        outgoing = outgoing.header(name, value);
    }
    if let Some(encoded) = request.body_base64 {
        if encoded.len() > MAX_BODY_BYTES.div_ceil(3) * 4
            || matches!(request.method.as_str(), "GET" | "HEAD")
        {
            return Err("Invalid cloud request body".into());
        }
        let bytes = BASE64
            .decode(encoded)
            .map_err(|_| "Invalid cloud request body")?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err("Cloud request is too large".into());
        }
        outgoing = outgoing.body(bytes);
    }
    let (cancel, mut retired) = watch::channel(false);
    let entry = Arc::new(StreamEntry {
        bridge_id: request.bridge_id.clone(),
        retired: cancel,
        body: Mutex::new(None),
    });
    cloud
        .registry()
        .register_stream(request.stream_id.clone(), entry.clone())?;
    let response = tokio::select! {
        _ = retired.changed() => Err("Cloud request was cancelled"),
        result = tokio::time::timeout(Duration::from_secs(30),outgoing.send()) => result.ok().and_then(Result::ok).ok_or("Cloud request failed"),
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            cloud
                .registry()
                .close_stream(&request.bridge_id, &request.stream_id);
            return Err(error.into());
        }
    };
    if let Err(error) = state.require_current(&request.session_handle).await {
        cloud
            .registry()
            .close_stream(&request.bridge_id, &request.stream_id);
        return Err(error);
    }
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            matches!(
                name.as_str(),
                "content-type"
                    | "content-length"
                    | "content-range"
                    | "content-disposition"
                    | "etag"
                    | "x-zeroagent-account-mismatch"
                    | "retry-after"
            )
            .then(|| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_string()))
            })
            .flatten()
        })
        .collect();
    if matches!(status, 204 | 205 | 304) || request.method == "HEAD" {
        cloud
            .registry()
            .close_stream(&request.bridge_id, &request.stream_id);
    } else {
        *entry.body.lock().await = Some(CloudStream { response, total: 0 });
    }
    Ok(CloudFetchResponse { status, headers })
}

#[tauri::command]
pub async fn account_cloud_read(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    cloud: State<'_, Arc<CloudGatewayState>>,
    session_handle: String,
    bridge_id: String,
    stream_id: String,
) -> Result<Option<String>, String> {
    api::guard_viewer(&app, state.inner(), &session_handle).await?;
    let entry = {
        let registry = cloud.registry();
        registry.bridge(&session_handle, &bridge_id)?;
        registry.stream(&bridge_id, &stream_id)?
    };
    let mut body = entry.body.lock().await;
    let stream = body.as_mut().ok_or("Cloud response is not ready")?;
    let mut retired = entry.retired.subscribe();
    if *retired.borrow() {
        return Err(SESSION_CHANGED.into());
    }
    let chunk = tokio::select! {
        _ = retired.changed() => return Err(SESSION_CHANGED.into()),
        result = stream.response.chunk() => result.map_err(|_| "Cloud response failed")?,
    };
    state.require_current(&session_handle).await?;
    if *retired.borrow() {
        return Err(SESSION_CHANGED.into());
    }
    if let Some(chunk) = chunk {
        stream.total += chunk.len();
        if stream.total > MAX_STREAM_BYTES {
            return Err("Cloud response is too large".into());
        }
        return Ok(Some(BASE64.encode(chunk)));
    }
    cloud.registry().close_stream(&bridge_id, &stream_id);
    Ok(None)
}

#[tauri::command]
pub async fn account_cloud_close(
    cloud: State<'_, Arc<CloudGatewayState>>,
    session_handle: String,
    bridge_id: String,
    stream_id: Option<String>,
) -> Result<(), String> {
    cloud
        .registry()
        .close(&session_handle, &bridge_id, stream_id.as_deref())
}
