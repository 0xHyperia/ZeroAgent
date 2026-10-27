use super::*;
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State as HttpState},
    response::{IntoResponse, Response},
    Router,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex as StdMutex,
};
use tokio::sync::{oneshot, Notify};

#[derive(Default)]
struct WireState {
    calls: StdMutex<Vec<(String, String, String, Vec<u8>)>>,
    handoffs: AtomicUsize,
    logout: AtomicUsize,
    invalid_target: AtomicUsize,
    upload_started: Notify,
    upload_gate: StdMutex<Option<oneshot::Receiver<()>>>,
}

struct Wire {
    origin: Url,
    state: Arc<WireState>,
    server: tokio::task::JoinHandle<()>,
}

impl Wire {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let state = Arc::new(WireState::default());
        let router = Router::new().fallback(serve).with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            origin,
            state,
            server,
        }
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn serve(HttpState(state): HttpState<Arc<WireState>>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or("").to_string();
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let cookie = request
        .headers()
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    state
        .calls
        .lock()
        .unwrap()
        .push((path.clone(), auth.clone(), cookie.clone(), body.clone()));
    match path.as_str() {
        "/api/desktop/handoff" => {
            assert_eq!(auth, "Bearer access-a");
            assert!(cookie.is_empty());
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["selection_lease"],
                "source-lease"
            );
            axum::Json(json!({"handoff_code":"private-one-use-code","expires_in":60}))
                .into_response()
        }
        "/api/auth/handoff" => {
            assert!(auth.is_empty());
            assert!(cookie.is_empty());
            assert_eq!(query, "code=private-one-use-code");
            let index = state.handoffs.fetch_add(1, Ordering::SeqCst) + 1;
            let target = if state.invalid_target.load(Ordering::SeqCst) == 1 {
                "other-device"
            } else {
                "owned-device"
            };
            Response::builder().status(303)
                .header("set-cookie", format!("zeroagent_session=private-http-cookie-{index}; Path=/; HttpOnly"))
                .header("location", format!("/?selection_lease=new-lease-{index}&runtime_kind=device_agent&device_id={target}&agent_id={target}&workspace_id=&conversation_id=conversation-{index}"))
                .body(Body::empty()).unwrap()
        }
        "/api/status" | "/api/files/import" | "/api/files/import-directory" => {
            assert!(cookie.starts_with("zeroagent_session=private-http-cookie-"));
            let encoded = auth.strip_prefix("Bearer selection.").unwrap();
            let selection: Value = serde_json::from_slice(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(encoded)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(selection["deviceId"], "owned-device");
            assert!(selection["lease"]
                .as_str()
                .unwrap()
                .starts_with("new-lease-"));
            if path != "/api/status" {
                let params: HashMap<_, _> = url::form_urlencoded::parse(query.as_bytes())
                    .into_owned()
                    .collect();
                assert_eq!(params.get("agent_id").unwrap(), "owned-device");
                let gate = state.upload_gate.lock().unwrap().take();
                state.upload_started.notify_one();
                if let Some(gate) = gate {
                    let _ = gate.await;
                }
            }
            axum::Json(json!({"files":[{"file_name":"probe.txt","path":"/remote/probe.txt"}],"privateEcho":format!("access-a refresh-a {cookie}"),"private-http-cookie-1":"access-a"})).into_response()
        }
        "/api/auth/logout" => {
            assert!(auth.is_empty());
            assert!(cookie.starts_with("zeroagent_session=private-http-cookie-"));
            state.logout.fetch_add(1, Ordering::SeqCst);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

fn open_request(origin: &Url, handle: &str) -> RemoteOpenRequest {
    RemoteOpenRequest {
        session_handle: handle.into(),
        origin: origin.origin().ascii_serialization(),
        device_id: "owned-device".into(),
        selection_lease: "source-lease".into(),
    }
}

fn http_request(handle: &str, response: &RemoteOpenResponse, path: &str) -> RemoteHttpRequest {
    RemoteHttpRequest {
        session_handle: handle.into(),
        bridge_id: response.bridge_id.clone(),
        path: path.into(),
        method: if path.starts_with("/api/files/") {
            "POST"
        } else {
            "GET"
        }
        .into(),
        headers: HashMap::from([(
            "Authorization".into(),
            format!("Bearer {}", selection_credential(&response.selection)),
        )]),
        body_base64: None,
    }
}

#[tokio::test]
async fn complete_workbench_uploads_use_native_cookie_and_preserve_multipart_bytes() {
    let account = super::super::tests::Fixture::new().await;
    let owner = account.login("a", false).await;
    account
        .state
        .public_summary(&owner.session_handle)
        .await
        .unwrap();
    let wire = Wire::new().await;
    let remote = RemoteGatewayState::default();
    let opened = open_remote(
        &account.state,
        &remote,
        wire.origin.clone(),
        open_request(&wire.origin, &owner.session_handle),
    )
    .await
    .unwrap();
    let public = serde_json::to_string(&opened).unwrap();
    for private in [
        "access-a",
        "refresh-a",
        "private-http-cookie",
        "private-one-use-code",
    ] {
        assert!(!public.contains(private), "public handoff leaked {private}");
    }
    let multipart = b"--probe\r\nContent-Disposition: form-data; name=\"files\"; filename=\"probe.txt\"\r\n\r\n\x00\xffhello\r\n--probe--\r\n";
    let mut request = http_request(
        &owner.session_handle,
        &opened,
        "/api/files/import?agent_id=foreign-device",
    );
    request.headers.insert(
        "Content-Type".into(),
        "multipart/form-data; boundary=probe".into(),
    );
    request.body_base64 = Some(BASE64.encode(multipart));
    let result = remote_http(&account.state, &remote, request).await.unwrap();
    assert_eq!(result.status, 200);
    assert!(!result.headers.contains_key("set-cookie"));
    let text = String::from_utf8(BASE64.decode(result.body_base64).unwrap()).unwrap();
    for private in ["access-a", "refresh-a", "private-http-cookie"] {
        assert!(!text.contains(private));
    }
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["files"][0]["file_name"],
        "probe.txt"
    );
    assert_eq!(
        wire.state.calls.lock().unwrap().last().unwrap().3,
        multipart
    );
    let closed = remote
        .remove(&owner.session_handle, &opened.bridge_id)
        .await
        .unwrap()
        .unwrap();
    logout_bridge(&account.state.client, &closed).await;
    assert_eq!(wire.state.logout.load(Ordering::SeqCst), 1);
    assert!(remote
        .remove(&owner.session_handle, &opened.bridge_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn bridge_rejects_other_accounts_routes_headers_and_selection_credentials() {
    let account = super::super::tests::Fixture::new().await;
    let owner = account.login("a", false).await;
    let wire = Wire::new().await;
    let remote = RemoteGatewayState::default();
    let opened = open_remote(
        &account.state,
        &remote,
        wire.origin.clone(),
        open_request(&wire.origin, &owner.session_handle),
    )
    .await
    .unwrap();
    let before = wire.state.calls.lock().unwrap().len();
    for path in [
        "/api/auth/me",
        "/api/usa-zero/app/keys",
        "/api/desktop/devices/register",
        "//foreign.invalid/api/status",
        "/api/files/%2e%2e/import",
        "/api/status#fragment",
    ] {
        assert!(
            remote_http(
                &account.state,
                &remote,
                http_request(&owner.session_handle, &opened, path)
            )
            .await
            .is_err(),
            "accepted {path}"
        );
    }
    for header in ["Cookie", "Host", "Origin", "X-Proxy-Authorization"] {
        let mut request = http_request(&owner.session_handle, &opened, "/api/status");
        request.headers.insert(header.into(), "injected".into());
        assert!(remote_http(&account.state, &remote, request).await.is_err());
    }
    let mut request = http_request(&owner.session_handle, &opened, "/api/status");
    request.headers.insert(
        "Authorization".into(),
        "Bearer selection.other-target".into(),
    );
    assert!(remote_http(&account.state, &remote, request).await.is_err());
    assert!(remote
        .remove("other-owner", &opened.bridge_id)
        .await
        .is_err());
    let mut request = http_request(&owner.session_handle, &opened, "/api/status");
    request.session_handle = "other-owner".into();
    assert!(remote_http(&account.state, &remote, request).await.is_err());
    assert_eq!(wire.state.calls.lock().unwrap().len(), before);
}

#[tokio::test]
async fn rejected_handoff_target_is_logged_out_and_never_becomes_a_bridge() {
    let account = super::super::tests::Fixture::new().await;
    let owner = account.login("a", false).await;
    let wire = Wire::new().await;
    wire.state.invalid_target.store(1, Ordering::SeqCst);
    let remote = RemoteGatewayState::default();
    assert!(open_remote(
        &account.state,
        &remote,
        wire.origin.clone(),
        open_request(&wire.origin, &owner.session_handle)
    )
    .await
    .is_err());
    assert_eq!(remote.bridges.lock().await.len(), 0);
    assert_eq!(wire.state.logout.load(Ordering::SeqCst), 1);
    for location in [
        "https://foreign.invalid/?selection_lease=x",
        "/api/auth/login",
        "/?selection_lease=x&selection_lease=y",
    ] {
        assert!(handoff_selection(&wire.origin, location, "owned-device").is_err());
    }
}

#[tokio::test]
async fn closing_a_remote_device_cancels_waiting_http_and_preserves_replacement_bridge() {
    let account = super::super::tests::Fixture::new().await;
    let owner = account.login("a", false).await;
    let wire = Wire::new().await;
    let remote = Arc::new(RemoteGatewayState::default());
    let opened = open_remote(
        &account.state,
        &remote,
        wire.origin.clone(),
        open_request(&wire.origin, &owner.session_handle),
    )
    .await
    .unwrap();
    let replacement = open_remote(
        &account.state,
        &remote,
        wire.origin.clone(),
        open_request(&wire.origin, &owner.session_handle),
    )
    .await
    .unwrap();
    let (_release, gate) = oneshot::channel();
    *wire.state.upload_gate.lock().unwrap() = Some(gate);
    let request = http_request(&owner.session_handle, &opened, "/api/files/import");
    let task_state = account.state.clone();
    let task_remote = remote.clone();
    let pending =
        tokio::spawn(async move { remote_http(&task_state, &task_remote, request).await });
    tokio::time::timeout(Duration::from_secs(2), wire.state.upload_started.notified())
        .await
        .unwrap();
    remote
        .remove(&owner.session_handle, &opened.bridge_id)
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
    assert!(remote
        .bridge(&owner.session_handle, &replacement.bridge_id)
        .await
        .is_ok());
}

#[tokio::test]
async fn account_replacement_cancels_http_and_cannot_reuse_the_previous_bridge() {
    let account = super::super::tests::Fixture::new().await;
    let owner = account.login("a", false).await;
    let wire = Wire::new().await;
    let remote = Arc::new(RemoteGatewayState::default());
    let opened = open_remote(
        &account.state,
        &remote,
        wire.origin.clone(),
        open_request(&wire.origin, &owner.session_handle),
    )
    .await
    .unwrap();
    let (_release, gate) = oneshot::channel();
    *wire.state.upload_gate.lock().unwrap() = Some(gate);
    let request = http_request(
        &owner.session_handle,
        &opened,
        "/api/files/import-directory",
    );
    let task_state = account.state.clone();
    let task_remote = remote.clone();
    let pending =
        tokio::spawn(async move { remote_http(&task_state, &task_remote, request).await });
    tokio::time::timeout(Duration::from_secs(2), wire.state.upload_started.notified())
        .await
        .unwrap();
    let next = account.login("b", false).await;
    assert_ne!(next.session_handle, owner.session_handle);
    assert!(tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(remote_http(
        &account.state,
        &remote,
        http_request(&next.session_handle, &opened, "/api/status")
    )
    .await
    .is_err());
    assert!(remote_http(
        &account.state,
        &remote,
        http_request(&owner.session_handle, &opened, "/api/status")
    )
    .await
    .is_err());
    remote
        .close_session(&account.state, &owner.session_handle)
        .await;
    assert!(remote.bridges.lock().await.is_empty());
}
