use super::*;
use axum::{body::to_bytes, http::HeaderMap};
use futures_util::stream;
use std::sync::Mutex;
use tokio::sync::Notify;

const PRIVATE_TOKEN: &str = "fixture-private-backend-token";
const PING: &str = "event: ping\ndata: {}\n\n";

#[derive(Default)]
struct FixtureState {
    calls: Mutex<Vec<(String, HeaderMap, Vec<u8>)>>,
    started: Notify,
    release: Notify,
    origin: Mutex<String>,
}

async fn backend(State(state): State<Arc<FixtureState>>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let headers = request.headers().clone();
    let bytes = to_bytes(request.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    state
        .calls
        .lock()
        .unwrap()
        .push((path.clone(), headers, bytes.to_vec()));
    if path == "/v1/redirect" {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [("location", "https://foreign.invalid/collect")],
            PRIVATE_TOKEN,
        )
            .into_response();
    }
    if path == "/v1/slow" || (path == "/v1/settings" && bytes.as_ref() == br#"{"slow":true}"#) {
        state.started.notify_one();
        state.release.notified().await;
    }
    if path == "/v1/events" || path == "/v1/idle" {
        let first =
            stream::once(async { Ok::<_, std::io::Error>(Bytes::from_static(PING.as_bytes())) });
        let worker = state.clone();
        let tail = stream::once(async move {
            worker.started.notify_one();
            worker.release.notified().await;
            let origin = worker.origin.lock().unwrap().clone();
            Ok::<_, std::io::Error>(Bytes::from(format!("data: {PRIVATE_TOKEN} {origin}\n\n")))
        });
        return (
            [("content-type", "text/event-stream")],
            Body::from_stream(first.chain(tail)),
        )
            .into_response();
    }
    if path == "/v1/binary" {
        return (
            [
                ("content-type", "application/octet-stream"),
                ("content-disposition", "attachment; filename=fixture.bin"),
            ],
            bytes,
        )
            .into_response();
    }
    if path == "/v1/error" {
        return (
            StatusCode::CONFLICT,
            [("etag", PRIVATE_TOKEN)],
            format!("configuration changed: {PRIVATE_TOKEN}"),
        )
            .into_response();
    }
    if path == "/v1/not-modified" {
        return (
            StatusCode::NOT_MODIFIED,
            [("etag", "fixture-resource-version")],
        )
            .into_response();
    }
    (
        [("content-type", "application/json")],
        "{\"version\":\"kbrain.agent.v1\",\"status\":\"ok\"}",
    )
        .into_response()
}

struct Fixture {
    state: Arc<FixtureState>,
    private: KBrainBackendConnection,
    lease: Arc<AtomicBool>,
    facade: Option<BackendFacade>,
    server: tokio::task::JoinHandle<()>,
    client: reqwest::Client,
}

impl Fixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(FixtureState::default());
        *state.origin.lock().unwrap() = origin.clone();
        let routes = Router::new().fallback(backend).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, routes).await.unwrap();
        });
        let private = KBrainBackendConnection {
            base_url: origin,
            token: PRIVATE_TOKEN.into(),
            storage_id: format!("fixture-profile-{}", uuid::Uuid::new_v4()),
            protocol_version: "kbrain.agent.v1".into(),
        };
        let lease = Arc::new(AtomicBool::new(true));
        let facade = Some(BackendFacade::start(private.clone(), lease.clone()).unwrap());
        Self {
            state,
            private,
            lease,
            facade,
            server,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        }
    }
    fn public(&self) -> PublicBackendConnection {
        self.facade.as_ref().unwrap().connection()
    }
    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        let public = self.public();
        self.client
            .get(format!("{}{path}", public.base_url))
            .bearer_auth(public.token)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.facade.take();
        self.server.abort();
    }
}

#[tokio::test]
async fn abandoning_a_received_config_write_keeps_the_gate_until_backend_response() {
    let fixture = Fixture::new().await;
    let coordinator =
        super::super::configuration_coordinator::ConfigurationCoordinator::for_profile(
            &fixture.private.storage_id,
        )
        .unwrap();
    let public = fixture.public();
    let client = fixture.client.clone();
    let request = tokio::spawn(async move {
        client
            .put(format!("{}/v1/settings", public.base_url))
            .bearer_auth(public.token)
            .header("content-type", "application/json")
            .body(r#"{"slow":true}"#)
            .send()
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), fixture.state.started.notified())
        .await
        .unwrap();
    request.abort();
    let next_writer = tokio::spawn(async move { coordinator.lock().await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !next_writer.is_finished(),
        "a cancelled client cannot let compensation overtake its backend write"
    );
    fixture.state.release.notify_one();
    let guard = tokio::time::timeout(Duration::from_secs(2), next_writer)
        .await
        .unwrap()
        .unwrap();
    drop(guard);
}

#[tokio::test]
async fn native_configuration_gate_blocks_config_http_without_blocking_models_or_tools() {
    let fixture = Fixture::new().await;
    let coordinator =
        super::super::configuration_coordinator::ConfigurationCoordinator::for_profile(
            &fixture.private.storage_id,
        )
        .unwrap();
    let guard = coordinator.lock().await;
    let public = fixture.public();
    let client = fixture.client.clone();
    let write = tokio::spawn(async move {
        client
            .put(format!("{}/v1/settings", public.base_url))
            .bearer_auth(public.token)
            .json(&serde_json::json!({"defaultModel":"after-backup"}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!write.is_finished());
    assert!(!fixture
        .state
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| call.0 == "/v1/settings"));
    for path in [
        "/v1/models",
        "/v1/mcp/tools",
        "/v1/settings/providers/p/models",
    ] {
        let response = tokio::time::timeout(Duration::from_secs(2), fixture.get(path).send())
            .await
            .unwrap()
            .unwrap();
        assert!(response.status().is_success());
        response.bytes().await.unwrap();
    }
    drop(guard);
    tokio::time::timeout(Duration::from_secs(2), write)
        .await
        .unwrap()
        .unwrap();
    assert!(fixture
        .state
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| call.0 == "/v1/settings"));
}

#[tokio::test]
async fn a_config_request_waiting_for_native_work_is_cancelled_when_profile_ends() {
    let fixture = Fixture::new().await;
    let coordinator =
        super::super::configuration_coordinator::ConfigurationCoordinator::for_profile(
            &fixture.private.storage_id,
        )
        .unwrap();
    let _guard = coordinator.lock().await;
    let request = fixture.get("/v1/settings");
    let waiting = tokio::spawn(async move { request.send().await.unwrap().status() });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiting.is_finished());
    fixture.lease.store(false, Ordering::SeqCst);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );
    assert!(fixture.state.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn capability_is_distinct_and_only_native_credentials_reach_the_backend() {
    let fixture = Fixture::new().await;
    let public = fixture.public();
    assert_ne!(public.token, PRIVATE_TOKEN);
    assert!(public.token.starts_with("za-backend-"));
    assert_ne!(public.base_url, fixture.private.base_url);
    assert_eq!(public.storage_id, fixture.private.storage_id);
    let wire = serde_json::to_value(&public).unwrap();
    assert_eq!(wire["storageId"], fixture.private.storage_id);
    assert_eq!(wire["protocolVersion"], "kbrain.agent.v1");
    assert!(!serde_json::to_string(&wire)
        .unwrap()
        .contains(PRIVATE_TOKEN));
    let response = fixture
        .get("/v1/health")
        .header("origin", "tauri://localhost")
        .header("cookie", "private-cookie")
        .header("proxy-authorization", "Bearer caller-proxy")
        .header("last-event-id", "23")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
    assert!(response.text().await.unwrap().contains("kbrain.agent.v1"));
    let calls = fixture.state.calls.lock().unwrap();
    assert_eq!(
        calls[0].1["authorization"],
        format!("Bearer {PRIVATE_TOKEN}")
    );
    assert_eq!(calls[0].1["last-event-id"], "23");
    assert_eq!(
        calls[0].1["host"],
        public.base_url.trim_start_matches("http://")
    );
    for key in ["origin", "cookie", "proxy-authorization"] {
        assert!(!calls[0].1.contains_key(key));
    }
}

#[tokio::test]
async fn private_routes_encoded_aliases_and_raw_backend_tokens_cannot_bypass_the_facade() {
    let fixture = Fixture::new().await;
    for path in [
        "/v1/settings/providers/relay-key-11/secrets",
        "/v1/settings/providers/x/%73ecrets",
        "/v1/settings/providers/x/%2573ecrets",
        "/v1/settings/providers/x%2fsecrets",
        "/v1/network/proxy",
        "/api/v1/auth/login",
    ] {
        let public = fixture.public();
        let response = fixture
            .client
            .post(format!("{}{path}", public.base_url))
            .bearer_auth(public.token)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }
    for method in [Method::GET, Method::PUT, Method::DELETE] {
        for path in [
            "/v1/host-bridge",
            "/v1/%68ost-bridge",
            "/v1//host-bridge",
            "/v1/host-bridge/",
        ] {
            let public = fixture.public();
            let response = fixture.client
                .request(method.clone(), format!("{}{path}", public.base_url))
                .bearer_auth(public.token)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
        }
    }
    for token in ["", "wrong-capability", PRIVATE_TOKEN] {
        assert_eq!(
            fixture
                .client
                .get(format!("{}/v1/health", fixture.public().base_url))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let response = fixture
        .client
        .request(
            Method::OPTIONS,
            format!("{}/v1/settings", fixture.public().base_url),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(response.headers()["access-control-allow-headers"]
        .to_str()
        .unwrap()
        .contains("If-Match"));
    assert!(fixture.state.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn image_job_preflight_and_forwarding_preserve_the_standard_idempotency_key() {
    let fixture = Fixture::new().await;
    let public = fixture.public();
    let preflight = fixture
        .client
        .request(
            Method::OPTIONS,
            format!("{}/v1/image/jobs", public.base_url),
        )
        .header("origin", "http://tauri.localhost")
        .header("access-control-request-method", "POST")
        .header(
            "access-control-request-headers",
            "authorization,content-type,idempotency-key",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
    assert!(preflight.headers()["access-control-allow-headers"]
        .to_str()
        .unwrap()
        .split(',')
        .any(|name| name.trim().eq_ignore_ascii_case("idempotency-key")));
    assert!(fixture.state.calls.lock().unwrap().is_empty());

    let key = uuid::Uuid::new_v4().to_string();
    let response = fixture
        .client
        .post(format!("{}/v1/image/jobs", public.base_url))
        .bearer_auth(&public.token)
        .header("origin", "http://tauri.localhost")
        .header("cookie", "must-not-reach-backend")
        .header("Idempotency-Key", &key)
        .json(&serde_json::json!({"prompt":"synthetic fixture"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let calls = fixture.state.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1["idempotency-key"], key);
    assert_eq!(
        calls[0].1["authorization"],
        format!("Bearer {PRIVATE_TOKEN}")
    );
    assert!(!calls[0].1.contains_key("cookie"));
    assert!(!calls[0].1.contains_key("origin"));
}

#[tokio::test]
async fn raw_mcp_calls_are_blocked_without_blocking_session_execution_or_discovery() {
    let fixture = Fixture::new().await;
    let public = fixture.public();
    for path in [
        "/v1/mcp/tools/call",
        "/v1/mcp/tools/%63all",
        "/v1/mcp/tools/%2563all",
        "/v1/mcp/tools%2fcall",
        "/v1/mcp/tools%252fcall",
    ] {
        for method in [Method::POST, Method::OPTIONS] {
            let response = fixture
                .client
                .request(method, format!("{}{path}", public.base_url))
                .bearer_auth(&public.token)
                .body("{}")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
    }
    assert!(fixture.state.calls.lock().unwrap().is_empty());

    for path in [
        "/v1/sessions",
        "/v1/sessions/fixture/runs",
        "/v1/sessions/fixture/permissions/permission",
    ] {
        let response = fixture
            .client
            .post(format!("{}{path}", public.base_url))
            .bearer_auth(&public.token)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "{path}");
    }
    assert!(fixture
        .get("/v1/mcp/tools")
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    let calls = fixture.state.calls.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(calls
        .iter()
        .any(|call| call.0 == "/v1/sessions/fixture/runs"));
    assert!(calls.iter().all(|call| call.0 != "/v1/mcp/tools/call"));
}

#[tokio::test]
async fn large_binary_upload_download_and_range_headers_are_preserved() {
    let fixture = Fixture::new().await;
    let public = fixture.public();
    let mut content = (0..131072)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    content[..fixture.private.base_url.len()].copy_from_slice(fixture.private.base_url.as_bytes());
    let chunk = Bytes::from(content);
    let expected = chunk.repeat(64);
    let body = reqwest::Body::wrap_stream(stream::iter(
        (0..64).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
    ));
    let response = fixture
        .client
        .post(format!("{}/v1/binary", public.base_url))
        .bearer_auth(public.token)
        .header("range", "bytes=0-")
        .header("content-type", "application/octet-stream")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-disposition"],
        "attachment; filename=fixture.bin"
    );
    assert_eq!(
        response.bytes().await.unwrap().as_ref(),
        expected.as_slice()
    );
    let calls = fixture.state.calls.lock().unwrap();
    assert_eq!(calls[0].1["range"], "bytes=0-");
    assert_eq!(calls[0].2, expected);
}

#[tokio::test]
async fn small_sse_events_are_delivered_before_the_next_upstream_chunk_and_reflections_are_rewritten(
) {
    let fixture = Fixture::new().await;
    let mut response = fixture.get("/v1/events").send().await.unwrap();
    let first = tokio::time::timeout(Duration::from_secs(2), response.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first, PING.as_bytes());
    fixture.state.release.notify_one();
    let tail = response.text().await.unwrap();
    assert!(!tail.contains(PRIVATE_TOKEN));
    assert!(tail.contains(&fixture.private.base_url));
    assert!(!tail.contains(&fixture.public().token));
    assert!(tail.contains("[protected]"));
}

#[tokio::test]
async fn profile_revocation_cancels_idle_sse_and_waiting_response_headers() {
    for path in ["/v1/idle", "/v1/slow"] {
        let fixture = Fixture::new().await;
        if path.ends_with("idle") {
            let mut response = fixture.get(path).send().await.unwrap();
            assert_eq!(response.chunk().await.unwrap().unwrap(), PING.as_bytes());
            fixture.lease.store(false, Ordering::SeqCst);
            let next = tokio::time::timeout(Duration::from_secs(2), response.chunk())
                .await
                .unwrap();
            assert!(next.is_err() || next.unwrap().is_none());
        } else {
            let request = fixture.get(path);
            let waiting = tokio::spawn(async move { request.send().await });
            fixture.state.started.notified().await;
            fixture.lease.store(false, Ordering::SeqCst);
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), waiting)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let count = fixture.state.calls.lock().unwrap().len();
        assert_eq!(
            fixture.get("/v1/health").send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(fixture.state.calls.lock().unwrap().len(), count);
    }
}

#[tokio::test]
async fn shutdown_retires_old_capabilities_and_does_not_wait_for_an_idle_backend() {
    let mut fixture = Fixture::new().await;
    let old = fixture.public();
    let mut response = fixture.get("/v1/idle").send().await.unwrap();
    response.chunk().await.unwrap().unwrap();
    let started = std::time::Instant::now();
    fixture.facade.take();
    assert!(started.elapsed() < Duration::from_secs(2));
    let next = tokio::time::timeout(Duration::from_secs(2), response.chunk())
        .await
        .unwrap();
    assert!(next.is_err() || next.unwrap().is_none());
    fixture.facade =
        Some(BackendFacade::start(fixture.private.clone(), fixture.lease.clone()).unwrap());
    let current = fixture.public();
    assert_eq!(current.storage_id, old.storage_id);
    assert_ne!(current.token, old.token);
    assert_eq!(
        fixture
            .client
            .get(format!("{}/v1/health", current.base_url))
            .bearer_auth(old.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn redirects_are_rejected_and_error_status_and_sanitized_headers_survive() {
    let fixture = Fixture::new().await;
    let response = fixture.get("/v1/redirect").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(!response.headers().contains_key("location"));
    assert!(!response.text().await.unwrap().contains(PRIVATE_TOKEN));
    let response = fixture.get("/v1/error").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.headers()["etag"], "[protected]");
    let body = response.text().await.unwrap();
    assert!(!body.contains(PRIVATE_TOKEN));
    assert!(body.contains("configuration changed"));
    let response = fixture
        .get("/v1/not-modified")
        .header("if-none-match", "fixture-resource-version")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(response.headers()["etag"], "fixture-resource-version");
}

#[tokio::test]
async fn stream_rewriter_handles_all_token_splits_without_holding_complete_sse_frames() {
    let fixture = Fixture::new().await;
    let state = &fixture.facade.as_ref().unwrap().state;
    let input = format!(
        "data: {PRIVATE_TOKEN} {} {}\n\n",
        fixture.public().token,
        fixture.private.base_url
    );
    for width in 1..=input.len() {
        let mut held = Vec::new();
        let mut output = Vec::new();
        for chunk in input.as_bytes().chunks(width) {
            held.extend_from_slice(chunk);
            let (bytes, consumed) = rewrite_bytes(&held, state, false);
            output.extend(bytes);
            held.drain(..consumed);
        }
        output.extend(rewrite_bytes(&held, state, true).0);
        assert_eq!(
            String::from_utf8(output).unwrap(),
            format!(
                "data: [protected] [protected] {}\n\n",
                fixture.private.base_url
            )
        );
    }
    assert_eq!(
        rewrite_bytes(PING.as_bytes(), state, false),
        (PING.as_bytes().to_vec(), PING.len())
    );
}

#[tokio::test]
async fn invalid_private_origins_and_dead_profiles_cannot_start_a_public_transport() {
    let fixture = Fixture::new().await;
    for origin in [
        "https://127.0.0.1:1234",
        "http://localhost:1234",
        "http://127.0.0.1:1234/path",
        "http://127.0.0.1:1234/?token=value",
        "http://user@127.0.0.1:1234",
        "http://127.0.0.1:0",
    ] {
        let mut private = fixture.private.clone();
        private.base_url = origin.into();
        assert!(BackendFacade::start(private, fixture.lease.clone()).is_err());
    }
    assert!(
        BackendFacade::start(fixture.private.clone(), Arc::new(AtomicBool::new(false))).is_err()
    );
}

#[tokio::test]
async fn cancelling_the_public_request_closes_a_waiting_upstream_request() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (started, ready) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = Vec::new();
        let mut bytes = [0; 1024];
        loop {
            let size = socket.read(&mut bytes).await.unwrap();
            assert_ne!(size, 0);
            buffer.extend_from_slice(&bytes[..size]);
            if buffer.windows(4).any(|value| value == b"\r\n\r\n") {
                break;
            }
        }
        started.send(()).unwrap();
        loop {
            if socket.read(&mut bytes).await.unwrap_or(0) == 0 {
                break;
            }
        }
    });
    let private = KBrainBackendConnection {
        base_url: origin,
        token: PRIVATE_TOKEN.into(),
        protocol_version: "kbrain.agent.v1".into(),
        storage_id: "cancel-fixture".into(),
    };
    let facade = BackendFacade::start(private, Arc::new(AtomicBool::new(true))).unwrap();
    let public = facade.connection();
    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
    let waiting = tokio::spawn(async move {
        client
            .get(format!("{}/v1/slow", public.base_url))
            .bearer_auth(public.token)
            .send()
            .await
    });
    ready.await.unwrap();
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("public abort must close the pending upstream connection")
        .unwrap();
}
