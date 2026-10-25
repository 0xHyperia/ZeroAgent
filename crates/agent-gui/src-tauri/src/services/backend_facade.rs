//! Profile-owned public transport. The renderer never receives the backend bearer token.
//! Native configuration/backup callers retain the private connection; this is the entrypoint
//! on which the coordinated configuration protocol will be enforced.
use std::{
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use futures_util::{Stream, StreamExt};
use tokio::sync::oneshot;

use super::kbrain_backend::{KBrainBackendConnection, PublicBackendConnection};

struct FacadeState {
    private: KBrainBackendConnection,
    public: PublicBackendConnection,
    profile_live: Arc<AtomicBool>,
    running: AtomicBool,
    client: reqwest::Client,
    configuration: Arc<super::configuration_coordinator::ConfigurationCoordinator>,
    configuration_http: Option<Arc<dyn ConfigurationHttpService>>,
}

pub(crate) struct ConfigurationHttpRequest {
    pub method: String,
    pub uri: String,
    pub if_match: Option<String>,
    pub if_none_match: Option<String>,
    pub body: Option<serde_json::Value>,
}

pub(crate) struct ConfigurationHttpResponse {
    pub status: u16,
    pub body: Option<serde_json::Value>,
    pub etag: Option<String>,
}

pub(crate) trait ConfigurationHttpService: Send + Sync {
    fn request(&self, request: ConfigurationHttpRequest) -> ConfigurationHttpResponse;
    fn prepare_provider_models(
        &self,
        provider_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, String>;
}

pub(crate) struct BackendFacade {
    state: Arc<FacadeState>,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl BackendFacade {
    // Transport-only fixtures exercise streaming independently of configuration storage.
    #[cfg(test)]
    pub(crate) fn start(
        private: KBrainBackendConnection,
        profile_live: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        Self::start_inner(private, profile_live, None)
    }

    pub(crate) fn start_with_configuration(
        private: KBrainBackendConnection,
        profile_live: Arc<AtomicBool>,
        configuration_http: Arc<dyn ConfigurationHttpService>,
    ) -> Result<Self, String> {
        Self::start_inner(private, profile_live, Some(configuration_http))
    }

    fn start_inner(
        private: KBrainBackendConnection,
        profile_live: Arc<AtomicBool>,
        configuration_http: Option<Arc<dyn ConfigurationHttpService>>,
    ) -> Result<Self, String> {
        let url = url::Url::parse(&private.base_url).map_err(|_| "Invalid private backend")?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none_or(|port| port == 0)
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !(16..=16384).contains(&private.token.len())
            || !private.token.bytes().all(|byte| (33..=126).contains(&byte))
        {
            return Err("Native backend transport requires authenticated numeric loopback".into());
        }
        if !profile_live.load(Ordering::SeqCst) {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Unable to bind native backend transport")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Unable to configure native backend transport")?;
        let public = PublicBackendConnection {
            base_url: format!(
                "http://127.0.0.1:{}",
                listener
                    .local_addr()
                    .map_err(|_| "Backend transport address unavailable")?
                    .port()
            ),
            token: format!(
                "za-backend-{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            protocol_version: private.protocol_version.clone(),
            storage_id: private.storage_id.clone(),
        };
        let state = Arc::new(FacadeState {
            configuration_http,
            configuration: super::configuration_coordinator::ConfigurationCoordinator::for_profile(
                &private.storage_id,
            )?,
            private,
            public,
            profile_live,
            running: AtomicBool::new(true),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                // SSE and long model/tool requests retain their callers' cancellation/deadlines.
                .build()
                .map_err(|_| "Unable to initialize native backend transport")?,
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Unable to initialize native backend transport runtime")?;
        let (stop, stopped) = oneshot::channel();
        let worker = state.clone();
        let thread = thread::Builder::new()
            .name("zeroagent-backend-transport".into())
            .spawn(move || {
                runtime.block_on(async {
                    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                        return;
                    };
                    let app = Router::new().fallback(forward).with_state(worker.clone());
                    tokio::select! {
                        _ = async { let _ = axum::serve(listener, app).await; } => {},
                        _ = stopped => {},
                    }
                });
                worker.running.store(false, Ordering::SeqCst);
                // Runtime drop cancels headers, uploads and idle SSE bodies together.
            })
            .map_err(|_| "Unable to start native backend transport")?;
        Ok(Self {
            state,
            stop: Some(stop),
            thread: Some(thread),
        })
    }

    pub(crate) fn connection(&self) -> PublicBackendConnection {
        self.state.public.clone()
    }

    pub(crate) fn is_running(&self) -> bool {
        live(&self.state)
    }
}

impl Drop for BackendFacade {
    fn drop(&mut self) {
        self.state.running.store(false, Ordering::SeqCst);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.thread.take() {
            let _ = worker.join();
        }
    }
}

fn live(state: &FacadeState) -> bool {
    state.running.load(Ordering::SeqCst) && state.profile_live.load(Ordering::SeqCst)
}

async fn invalidated(state: &FacadeState) {
    while live(state) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn canonical_path(path: &str) -> Option<String> {
    let mut decoded = path.to_string();
    for _ in 0..4 {
        let next = urlencoding::decode(&decoded).ok()?.into_owned();
        if next == decoded {
            break;
        }
        decoded = next;
    }
    if decoded.contains(['%', '\\', '?', '#'])
        || decoded.chars().any(char::is_control)
        || decoded.split('/').any(|part| matches!(part, "." | ".."))
        || !decoded.starts_with('/')
        || decoded.starts_with("//")
    {
        return None;
    }
    Some(decoded)
}

fn public_share(method: &Method, path: &str) -> bool {
    method == Method::GET
        && ["/v1/shares/", "/share/"].iter().any(|prefix| {
            path.strip_prefix(prefix)
                .is_some_and(|id| !id.is_empty() && !id.contains('/'))
        })
}

fn allowed_route(method: &Method, path: &str) -> bool {
    if public_share(method, path) {
        return true;
    }
    path.starts_with("/v1/")
        && matches!(
            *method,
            Method::GET
                | Method::POST
                | Method::PUT
                | Method::PATCH
                | Method::DELETE
                | Method::HEAD
        )
        && !path.split('/').any(|part| part == "secrets")
        && path != "/v1/network/proxy"
        && path != "/v1/mcp/tools/call"
}

fn cors(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"),
    );
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Authorization, Content-Type, Accept, Last-Event-ID, If-Match, If-None-Match, Range, If-Range, X-Idempotency-Key"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(
            "ETag, Content-Range, Accept-Ranges, Content-Disposition, X-ZeroAgent-Configuration",
        ),
    );
}

async fn forward(State(state): State<Arc<FacadeState>>, request: Request) -> Response {
    // A client disconnect must not release the configuration gate while the
    // backend is still applying an already received write. Let this owned job
    // reach its response even if the requesting view disappears.
    let coordinated = canonical_path(request.uri().path())
        .is_some_and(|path| super::configuration_coordinator::configuration_gate_route(&path));
    let mut response = if coordinated {
        tokio::spawn(forward_inner(state, request))
            .await
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
    } else {
        forward_inner(state, request).await
    };
    cors(&mut response);
    response
}

// A renderer can close its response before Go finishes a configuration write.
// Keep the gate and mark the profile uncertain unless the upstream body completes.
struct ConfigurationMutation {
    coordinator: Arc<super::configuration_coordinator::ConfigurationCoordinator>,
    complete: bool,
}
impl Drop for ConfigurationMutation {
    fn drop(&mut self) {
        if !self.complete {
            self.coordinator.uncertain_commit();
        }
    }
}

async fn forward_configuration(
    state: &FacadeState,
    configuration: Arc<dyn ConfigurationHttpService>,
    request: Request,
    path: String,
) -> Response {
    let method = request.method().to_string();
    let head = request.method() == Method::HEAD;
    let uri = match request.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path,
    };
    let (if_match, if_none_match) = {
        let header = |name| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        (header(header::IF_MATCH), header(header::IF_NONE_MATCH))
    };
    // A bounded configuration document is completely received before any mutation starts.
    let body = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(30), axum::body::to_bytes(request.into_body(),16*1024*1024)) => match result {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        },
        _ = invalidated(state) => return StatusCode::UNAUTHORIZED.into_response(),
    };
    let body = if body.is_empty() {
        None
    } else {
        match serde_json::from_slice(&body) {
            Ok(body) => Some(body),
            Err(_) => {
                return (StatusCode::BAD_REQUEST, "Invalid configuration JSON").into_response()
            }
        }
    };
    // The app's blocking runtime owns this work. Dropping the facade runtime must not
    // wait for a worker whose last Native state reference can itself close the facade.
    let work = tauri::async_runtime::spawn_blocking(move || {
        configuration.request(ConfigurationHttpRequest {
            method,
            uri,
            if_match,
            if_none_match,
            body,
        })
    });
    let result = tokio::select! {
        result = work => match result { Ok(result)=>result,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() },
        _ = invalidated(state) => return StatusCode::UNAUTHORIZED.into_response(),
    };
    if !live(state) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-zeroagent-configuration",
        HeaderValue::from_static("zeroagent.configuration.v1"),
    );
    if let Some(etag) = result
        .etag
        .and_then(|etag| HeaderValue::from_str(&etag).ok())
    {
        headers.insert(header::ETAG, etag);
    }
    let status = StatusCode::from_u16(result.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = if head {
        Vec::new()
    } else if let Some(body) = result.body {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        match serde_json::to_vec(&body) {
            Ok(bytes) => rewrite_bytes(&bytes, state, true).0,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    } else {
        Vec::new()
    };
    (status, headers, bytes).into_response()
}

async fn forward_inner(state: Arc<FacadeState>, mut request: Request) -> Response {
    if !live(&state) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(path) = canonical_path(request.uri().path()) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if request.method() == Method::OPTIONS {
        return if allowed_route(&Method::GET, &path) || allowed_route(&Method::POST, &path) {
            StatusCode::NO_CONTENT.into_response()
        } else {
            StatusCode::FORBIDDEN.into_response()
        };
    }
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if !public_share(request.method(), &path)
        && bearer != Some(format!("Bearer {}", state.public.token).as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !allowed_route(request.method(), &path) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if super::configuration_coordinator::configuration_route(&path) {
        if let Some(configuration) = &state.configuration_http {
            return forward_configuration(&state, Arc::clone(configuration), request, path).await;
        }
    }
    if request.method() == Method::POST {
        if let Some(provider_id) = path
            .strip_prefix("/v1/settings/providers/")
            .and_then(|path| path.strip_suffix("/models"))
        {
            if provider_id.is_empty() || provider_id.contains('/') {
                return StatusCode::FORBIDDEN.into_response();
            }
            let Some(configuration) = &state.configuration_http else {
                return StatusCode::FORBIDDEN.into_response();
            };
            let (parts, body) = request.into_parts();
            let bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
                Ok(bytes) => bytes,
                Err(_) => return StatusCode::BAD_REQUEST.into_response(),
            };
            let input = match serde_json::from_slice(&bytes) {
                Ok(input) => input,
                Err(_) => return StatusCode::BAD_REQUEST.into_response(),
            };
            let projected = match configuration.prepare_provider_models(provider_id, input) {
                Ok(projected) => projected,
                Err(_) => return StatusCode::FORBIDDEN.into_response(),
            };
            let bytes = match serde_json::to_vec(&projected) {
                Ok(bytes) => bytes,
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
            request = Request::from_parts(parts, Body::from(bytes));
        }
    }
    let configuration_guard = if super::configuration_coordinator::configuration_gate_route(&path) {
        Some(tokio::select! {
            guard = state.configuration.lock() => guard,
            _ = invalidated(&state) => return StatusCode::UNAUTHORIZED.into_response(),
        })
    } else {
        None
    };
    if configuration_guard.is_some() && state.configuration.ensure_consistent().is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Configuration result requires verification; restart the client",
        )
            .into_response();
    }
    let mutation =
        configuration_guard.is_some() && !matches!(*request.method(), Method::GET | Method::HEAD);
    let mutation_guard = if mutation {
        state.configuration.changed();
        Some(ConfigurationMutation {
            coordinator: Arc::clone(&state.configuration),
            complete: false,
        })
    } else {
        None
    };
    let uri = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let url = format!("{}{}", state.private.base_url.trim_end_matches('/'), uri);
    let mut upstream = state
        .client
        .request(request.method().clone(), url)
        .bearer_auth(&state.private.token)
        .header(
            header::HOST,
            state.public.base_url.trim_start_matches("http://"),
        );
    // Never forward caller cookies, origin, proxy credentials or hop-by-hop headers.
    for name in [
        "content-type",
        "accept",
        "last-event-id",
        "if-match",
        "if-none-match",
        "range",
        "if-range",
        "x-idempotency-key",
    ] {
        if let Some(value) = request.headers().get(name) {
            upstream = upstream.header(name, value);
        }
    }
    let body = reqwest::Body::wrap_stream(request.into_body().into_data_stream());
    let response = tokio::select! {
        response = upstream.body(body).send() => match response {
            Ok(response) => response,
            Err(_) => return (StatusCode::BAD_GATEWAY, "Native backend request failed").into_response(),
        },
        _ = invalidated(&state) => return StatusCode::UNAUTHORIZED.into_response(),
    };
    if !live(&state) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if mutation && response.status().is_server_error() {
        state.configuration.uncertain_commit();
    }
    if response.status().is_redirection() && response.status() != StatusCode::NOT_MODIFIED {
        return (StatusCode::BAD_GATEWAY, "Native backend redirect rejected").into_response();
    }
    let status = response.status();
    let mut headers = HeaderMap::new();
    for name in [
        "content-type",
        "cache-control",
        "etag",
        "content-range",
        "accept-ranges",
        "content-disposition",
    ] {
        if let Some(value) = response.headers().get(name) {
            let value = rewrite_bytes(value.as_bytes(), &state, true).0;
            if let Ok(value) = HeaderValue::from_bytes(&value) {
                headers.insert(name, value);
            }
        }
    }
    let stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>> =
        Box::pin(response.bytes_stream());
    let body = futures_util::stream::try_unfold(
        (
            stream,
            Vec::new(),
            state,
            false,
            mutation_guard,
            configuration_guard,
        ),
        |(mut source, mut pending, state, done, mut mutation_guard, configuration_guard)| async move {
            if done {
                return Ok::<_, std::io::Error>(None);
            }
            loop {
                let next = tokio::select! {
                    next = source.next() => next,
                    _ = invalidated(&state) => return Err(std::io::Error::other("Native backend permission ended")),
                };
                let finished = next.is_none();
                if finished {
                    if let Some(guard) = &mut mutation_guard {
                        guard.complete = true;
                    }
                }
                match next {
                    Some(Ok(bytes)) => pending.extend_from_slice(&bytes),
                    Some(Err(_)) => {
                        return Err(std::io::Error::other("Native backend stream failed"))
                    }
                    None => {}
                }
                let (bytes, consumed) = rewrite_bytes(&pending, &state, finished);
                pending.drain(..consumed);
                if !bytes.is_empty() {
                    return Ok(Some((
                        Bytes::from(bytes),
                        (
                            source,
                            pending,
                            state,
                            finished,
                            mutation_guard,
                            configuration_guard,
                        ),
                    )));
                }
                if finished {
                    return Ok(None);
                }
            }
        },
    );
    (status, headers, Body::from_stream(body)).into_response()
}

// Retain only a possible credential prefix, rather than a fixed-size tail: even a
// small complete SSE event must be delivered immediately while the backend is idle.
fn rewrite_bytes(input: &[u8], state: &FacadeState, finished: bool) -> (Vec<u8>, usize) {
    let patterns = [
        (state.private.token.as_bytes(), b"[protected]".as_slice()),
        (state.public.token.as_bytes(), b"[protected]".as_slice()),
    ];
    let mut output = Vec::with_capacity(input.len());
    let mut offset = 0;
    while offset < input.len() {
        let remaining = &input[offset..];
        if let Some((pattern, replacement)) = patterns
            .iter()
            .find(|(pattern, _)| remaining.starts_with(pattern))
        {
            output.extend_from_slice(replacement);
            offset += pattern.len();
        } else if !finished
            && patterns
                .iter()
                .any(|(pattern, _)| pattern.starts_with(remaining))
        {
            break;
        } else {
            output.push(input[offset]);
            offset += 1;
        }
    }
    (output, offset)
}

#[cfg(test)]
mod tests;
