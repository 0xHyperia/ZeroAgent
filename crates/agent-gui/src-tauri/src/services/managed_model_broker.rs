//! USA-Zero model credentials stay in this native, profile-owned broker. K-brain receives
//! revocable loopback capabilities, so its secrets/export/config endpoints cannot reveal a key.
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCredential {
    pub provider_id: String,
    pub api_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedBinding {
    pub provider_id: String,
    pub base_url: String,
    pub api_key: String,
}

/// Keep provider-model metadata editable while transport and credential ownership remain Native.
pub(crate) fn constrain_managed_provider(
    provider: &mut serde_json::Map<String, serde_json::Value>,
    binding: &ManagedBinding,
) -> Result<(), String> {
    if provider.get("id").and_then(serde_json::Value::as_str) != Some(binding.provider_id.as_str())
    {
        return Err("只能配置当前账户已授权的托管模型".into());
    }
    if let Some(api) = provider.get("api").and_then(serde_json::Value::as_str) {
        if !matches!(
            api,
            "openai-completions"
                | "openai-responses"
                | "anthropic-messages"
                | "google-generative-ai"
        ) {
            return Err("托管模型不支持此请求协议".into());
        }
    }
    provider.insert("baseUrl".into(), serde_json::json!(binding.base_url));
    provider.insert("apiKey".into(), serde_json::json!(binding.api_key));
    provider.insert("isFullUrl".into(), serde_json::json!(false));
    provider.insert("modelsUrl".into(), serde_json::json!(""));
    provider.insert("customHeaders".into(), serde_json::json!([]));
    provider.insert("useSystemProxy".into(), serde_json::json!(false));
    provider.insert("usageQuery".into(), serde_json::json!({"enabled":false}));
    provider.remove("clearApiKey");
    Ok(())
}

#[derive(Clone)]
struct Credential {
    provider_id: String,
    key: String,
}

struct BrokerState {
    origin: Url,
    credentials: Mutex<HashMap<String, Credential>>,
    protected_key_hashes: Mutex<HashSet<String>>,
    client: reqwest::Client,
}

pub struct ManagedModelBroker {
    state: Arc<BrokerState>,
    base_url: String,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

/// A backup operation retains the protection history even when the broker is stopped/replaced.
pub(crate) struct PortableSecretGuard {
    state: Arc<BrokerState>,
}

pub fn configured_origin(input: &str) -> Result<Url, String> {
    let configured = option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top");
    configured_origin_for_build(input, configured, cfg!(debug_assertions))
}

fn configured_origin_for_build(input: &str, configured: &str, debug: bool) -> Result<Url, String> {
    let expected = Url::parse(configured).map_err(|_| "Invalid USA-Zero build origin")?;
    let url = Url::parse(input).map_err(|_| "Invalid managed model origin")?;
    // Development still pins the exact build origin; release never accepts HTTP.
    let development_http = debug
        && url.scheme() == "http"
        && match url.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unique_local(),
            _ => false,
        };
    if url != expected
        || !(url.scheme() == "https" || development_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Managed models require the configured USA-Zero origin and transport".into());
    }
    Ok(url)
}

impl ManagedModelBroker {
    pub fn start(origin: Url) -> Result<Self, String> {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Unable to bind managed model broker")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Unable to configure model broker")?;
        let base_url = format!(
            "http://127.0.0.1:{}",
            listener
                .local_addr()
                .map_err(|_| "Model broker address unavailable")?
                .port()
        );
        let state = Arc::new(BrokerState {
            origin,
            credentials: Mutex::new(HashMap::new()),
            protected_key_hashes: Mutex::new(HashSet::new()),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|_| "Unable to initialize managed model transport")?,
        });
        let (stop, stopped) = oneshot::channel();
        let child_state = state.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "Unable to initialize model broker runtime")?;
        let thread = thread::Builder::new()
            .name("zeroagent-model-broker".into())
            .spawn(move || {
                runtime.block_on(async {
                    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                        return;
                    };
                    let routes = Router::new().fallback(forward).with_state(child_state);
                    tokio::select! {
                        _ = async { let _ = axum::serve(listener, routes).await; } => {},
                        _ = stopped => {},
                    }
                });
                // Dropping the runtime also cancels in-flight upstream requests and SSE streams.
            })
            .map_err(|_| "Unable to start managed model broker")?;
        Ok(Self {
            state,
            base_url,
            stop: Some(stop),
            thread: Some(thread),
        })
    }

    pub fn replace(&self, input: Vec<ManagedCredential>) -> Result<Vec<ManagedBinding>, String> {
        if input.len() > 128 {
            return Err("Too many managed providers".into());
        }
        let mut credentials = self
            .state
            .credentials
            .lock()
            .map_err(|_| "Managed credential lock failed")?;
        let mut next = HashMap::new();
        let mut bindings = Vec::new();
        for item in input {
            let suffix = item.provider_id.strip_prefix("relay-key-").unwrap_or("");
            if suffix.is_empty()
                || !suffix.bytes().all(|byte| byte.is_ascii_digit())
                || item.api_key.trim().is_empty()
                || item.api_key.len() > 2048
                || item.api_key.chars().any(char::is_control)
                || bindings
                    .iter()
                    .any(|binding: &ManagedBinding| binding.provider_id == item.provider_id)
            {
                return Err("Invalid managed provider credential".into());
            }
            let capability = credentials
                .iter()
                .find(|(_, value)| value.provider_id == item.provider_id)
                .map(|(token, _)| token.clone())
                .unwrap_or_else(|| format!("za-model-{}", uuid::Uuid::new_v4()));
            bindings.push(ManagedBinding {
                provider_id: item.provider_id.clone(),
                base_url: self.base_url.clone(),
                api_key: capability.clone(),
            });
            next.insert(
                capability,
                Credential {
                    provider_id: item.provider_id,
                    key: item.api_key,
                },
            );
        }
        // Retain only hashes of retired credentials, so a renamed custom provider cannot put a
        // previously managed key into a backup after rotation/revocation in this process.
        self.state
            .protected_key_hashes
            .lock()
            .map_err(|_| "Protected credential lock failed")?
            .extend(next.iter().flat_map(|(capability, credential)| {
                [
                    protected_key_hash(capability),
                    protected_key_hash(&credential.key),
                ]
            }));
        // Atomic replacement revokes removed/expired keys. Raw values are never serialized.
        *credentials = next;
        Ok(bindings)
    }

    pub fn verify_portable_value(&self, value: &serde_json::Value) -> Result<(), String> {
        self.portable_guard().verify(value)
    }

    pub(crate) fn binding(&self, provider_id: &str) -> Result<Option<ManagedBinding>, String> {
        let credentials = self
            .state
            .credentials
            .lock()
            .map_err(|_| "Managed credential lock failed")?;
        Ok(credentials
            .iter()
            .find(|(_, credential)| credential.provider_id == provider_id)
            .map(|(capability, _)| ManagedBinding {
                provider_id: provider_id.to_owned(),
                base_url: self.base_url.clone(),
                api_key: capability.clone(),
            }))
    }

    pub(crate) fn portable_guard(&self) -> PortableSecretGuard {
        PortableSecretGuard {
            state: self.state.clone(),
        }
    }
}

impl PortableSecretGuard {
    pub(crate) fn verify(&self, value: &serde_json::Value) -> Result<(), String> {
        let credentials = self
            .state
            .credentials
            .lock()
            .map_err(|_| "Managed credential lock failed")?;
        let hashes = self
            .state
            .protected_key_hashes
            .lock()
            .map_err(|_| "Protected credential lock failed")?;
        fn contains(
            value: &serde_json::Value,
            credentials: &HashMap<String, Credential>,
            hashes: &HashSet<String>,
        ) -> bool {
            let protected = |text: &str| {
                let text = text.trim();
                credentials
                    .values()
                    .any(|credential| text.contains(&credential.key))
                    || credentials
                        .keys()
                        .any(|capability| text.contains(capability))
                    || hashes.contains(&protected_key_hash(text))
                    || text.split_once(' ').is_some_and(|(scheme, token)| {
                        scheme.eq_ignore_ascii_case("bearer")
                            && hashes.contains(&protected_key_hash(token))
                    })
            };
            match value {
                serde_json::Value::String(text) => protected(text),
                serde_json::Value::Array(items) => {
                    items.iter().any(|item| contains(item, credentials, hashes))
                }
                serde_json::Value::Object(items) => items
                    .iter()
                    .any(|(key, value)| protected(key) || contains(value, credentials, hashes)),
                _ => false,
            }
        }
        if contains(value, &credentials, &hashes) {
            return Err(
                "备份包含受保护的托管密钥，请在账户密钥页面完成二次认证后管理该密钥".into(),
            );
        }
        Ok(())
    }
}

fn protected_key_hash(key: &str) -> String {
    Sha256::digest(key.trim().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Drop for ManagedModelBroker {
    fn drop(&mut self) {
        if let Ok(mut credentials) = self.state.credentials.lock() {
            credentials.clear();
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn allowed_route(method: &Method, path: &str) -> bool {
    if method == Method::GET {
        return matches!(path, "/v1/models" | "/v1beta/models");
    }
    if method != Method::POST {
        return false;
    }
    if matches!(
        path,
        "/v1/chat/completions"
            | "/v1/responses"
            | "/v1/messages"
            | "/v1/messages/count_tokens"
            | "/v1/images/generations"
            | "/v1/images/edits"
    ) {
        return true;
    }
    let Some(model) = path.strip_prefix("/v1beta/models/") else {
        return false;
    };
    [":generateContent", ":streamGenerateContent", ":countTokens"]
        .iter()
        .any(|suffix| {
            model.strip_suffix(suffix).is_some_and(|name| {
                !name.is_empty()
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            })
        })
}

fn canonical_model_path(path: &str) -> String {
    // K-brain treats an explicitly configured OpenAI base URL as the API root and appends
    // /chat/completions (without /v1). USA-Zero's public API uses the /v1 prefix.
    match path {
        "/chat/completions"
        | "/responses"
        | "/messages"
        | "/messages/count_tokens"
        | "/models"
        | "/images/generations"
        | "/images/edits" => {
            format!("/v1{path}")
        }
        _ => path.to_string(),
    }
}

async fn forward(State(state): State<Arc<BrokerState>>, request: Request) -> Response {
    // A capability is usable only for model operations, never USA-Zero account/admin APIs.
    // Browser origins have no direct access; the native K-brain HTTP client has no Origin header.
    let model_path = canonical_model_path(request.uri().path());
    if request.headers().contains_key("origin") || !allowed_route(request.method(), &model_path) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let query: Vec<(String, String)> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let token = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            request
                .headers()
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .or_else(|| {
            request
                .headers()
                .get("x-goog-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .or_else(|| {
            query
                .iter()
                .find(|(key, _)| key == "key")
                .map(|(_, value)| value.as_str())
        });
    let credential = token.and_then(|token| state.credentials.lock().ok()?.get(token).cloned());
    let Some(credential) = credential else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if query
        .iter()
        .any(|(name, _)| !matches!(name.as_str(), "key" | "alt" | "stream"))
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut target = state.origin.clone();
    target.set_path(&model_path);
    for (name, value) in query.iter().filter(|(name, _)| name != "key") {
        target.query_pairs_mut().append_pair(name, value);
    }
    let mut upstream = state
        .client
        .request(request.method().clone(), target)
        .header("authorization", format!("Bearer {}", credential.key));
    if request.headers().contains_key("x-api-key") {
        upstream = upstream.header("x-api-key", &credential.key);
    }
    if request.headers().contains_key("x-goog-api-key")
        || query.iter().any(|(name, _)| name == "key")
    {
        upstream = upstream.header("x-goog-api-key", &credential.key);
    }
    for name in [
        "content-type",
        "accept",
        "anthropic-version",
        "anthropic-beta",
        "openai-beta",
        "x-session-id",
    ] {
        if let Some(value) = request.headers().get(name) {
            upstream = upstream.header(name, value);
        }
    }
    let body = match to_bytes(request.into_body(), 64 * 1024 * 1024).await {
        Ok(body) => body,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let response = match upstream.body(body).send().await {
        Ok(response) => response,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                "USA-Zero model transport unavailable",
            )
                .into_response()
        }
    };
    if !response.status().is_success() {
        // Never echo upstream diagnostics or redirect locations that might contain a credential.
        return (response.status(), "USA-Zero model request rejected").into_response();
    }
    let mut output = Response::builder().status(response.status());
    if let Some(content_type) = response.headers().get("content-type") {
        output = output.header("content-type", content_type);
    }
    output
        .header("cache-control", "no-store")
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_provider_projects_transport_and_preserves_model_configuration() {
        let binding = ManagedBinding {
            provider_id: "relay-key-7".into(),
            base_url: "http://127.0.0.1:27".into(),
            api_key: "za-model-capability".into(),
        };
        let models = serde_json::json!([{"id":"custom/kimi-k2","displayName":"My model","contextWindow":131072,"maxOutputToken":8192,"inputModalities":["text","image"],"promptCacheHintMode":"none","limitsSource":"user"}]);
        let mut value = serde_json::json!({"id":"relay-key-7","api":"openai-completions","baseUrl":"https://external.invalid","apiKey":"other-key","clearApiKey":true,"modelsUrl":"https://external.invalid/models","isFullUrl":true,"customHeaders":[{"key":"Authorization","value":"external"}],"useSystemProxy":true,"usageQuery":{"enabled":true,"url":"https://external.invalid"},"models":models,"activeModels":[],"modelOrder":["custom/kimi-k2"]});
        constrain_managed_provider(value.as_object_mut().unwrap(), &binding).unwrap();
        assert_eq!(value["baseUrl"], binding.base_url);
        assert_eq!(value["apiKey"], binding.api_key);
        assert_eq!(value["modelsUrl"], "");
        assert_eq!(value["isFullUrl"], false);
        assert_eq!(value["customHeaders"], serde_json::json!([]));
        assert_eq!(value["useSystemProxy"], false);
        assert_eq!(value["usageQuery"]["enabled"], false);
        assert!(value.get("clearApiKey").is_none());
        assert_eq!(value["models"], models);
        assert_eq!(value["activeModels"], serde_json::json!([]));
        assert_eq!(value["modelOrder"], serde_json::json!(["custom/kimi-k2"]));
        assert_eq!(value["api"], "openai-completions");
    }

    #[test]
    fn managed_provider_rejects_foreign_identity_and_unsupported_protocol() {
        let binding = ManagedBinding {
            provider_id: "relay-key-7".into(),
            base_url: "http://127.0.0.1:27".into(),
            api_key: "za-model-capability".into(),
        };
        for input in [
            serde_json::json!({"id":"external","api":"openai-completions"}),
            serde_json::json!({"id":"relay-key-7","api":"custom-http"}),
        ] {
            assert!(
                constrain_managed_provider(&mut input.as_object().unwrap().clone(), &binding)
                    .is_err()
            );
        }
    }

    #[test]
    fn portable_backups_reject_credential_aliases_after_rotation_revocation_and_shutdown() {
        let broker = ManagedModelBroker::start(Url::parse("https://usa0.top").unwrap()).unwrap();
        let bindings = broker
            .replace(vec![
                ManagedCredential {
                    provider_id: "relay-key-1".into(),
                    api_key: "managed-secret-original".into(),
                },
                ManagedCredential {
                    provider_id: "relay-key-2".into(),
                    api_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                        .into(),
                },
            ])
            .unwrap();
        let guard = broker.portable_guard();
        assert!(guard
            .verify(&serde_json::json!({"id":"renamed-custom","apiKey":"managed-secret-original"}))
            .is_err());
        assert!(guard
            .verify(&serde_json::json!({"apiKey":bindings[0].api_key}))
            .is_err());
        broker
            .replace(vec![ManagedCredential {
                provider_id: "relay-key-1".into(),
                api_key: "managed-secret-rotated".into(),
            }])
            .unwrap();
        broker.replace(vec![]).unwrap();
        drop(broker);
        assert!(guard
            .verify(&serde_json::json!({"apiKey":bindings[0].api_key}))
            .is_err());
        for key in [
            "managed-secret-original",
            "managed-secret-rotated",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ] {
            let error = guard
                .verify(&serde_json::json!({"usageQuery":{"accessToken":key}}))
                .unwrap_err();
            assert!(!error.contains(key));
            assert!(guard
                .verify(&serde_json::json!({"manifest":{"sha256":key}}))
                .is_err());
            assert!(guard
                .verify(&serde_json::json!({"headers":{"Authorization":format!("bearer {key}")}}))
                .is_err());
        }
        assert!(guard
            .verify(&serde_json::json!({"apiKey":"user-owned-custom-secret"}))
            .is_ok());
    }
    #[test]
    fn routes_cannot_access_account_apis_or_encoded_paths() {
        for path in [
            "/api/v1/keys",
            "/v1/../api/v1/keys",
            "/v1/messages/../../api",
            "/v1beta/models/%2e%2e:generateContent",
            "/v1/responses/anything",
        ] {
            assert!(!allowed_route(&Method::POST, path));
        }
        assert!(allowed_route(&Method::POST, "/v1/responses"));
        assert!(allowed_route(
            &Method::POST,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent"
        ));
        assert!(!allowed_route(&Method::DELETE, "/v1/models"));
    }
    #[test]
    fn configured_origin_rejects_redirect_hosts_credentials_and_insecure_transport() {
        let configured = option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top");
        assert!(configured_origin(configured).is_ok());
        for value in [
            "http://usa0.top",
            "https://usa0.top.attacker.invalid",
            "https://secret@usa0.top",
            "https://usa0.top/api",
            "https://usa0.top/?key=x",
        ] {
            assert!(configured_origin(value).is_err());
        }
    }

    #[test]
    fn configured_origin_allows_only_exact_private_http_in_debug_builds() {
        for origin in [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://172.16.0.121:5173",
            "http://10.0.0.2:5173",
            "http://192.168.1.2:5173",
            "http://[::1]:5173",
            "http://[fd00::1]:5173",
        ] {
            assert!(configured_origin_for_build(origin, origin, true).is_ok());
            assert!(configured_origin_for_build(origin, origin, false).is_err());
        }
        for origin in [
            "http://usa0.top",
            "http://8.8.8.8:5173",
            "http://dev.example:5173",
        ] {
            assert!(configured_origin_for_build(origin, origin, true).is_err());
        }
        let configured = "http://172.16.0.121:5173";
        for input in [
            "http://172.16.0.122:5173",
            "http://172.16.0.121:8080",
            "http://user@172.16.0.121:5173",
            "http://172.16.0.121:5173/api",
            "http://172.16.0.121:5173/?key=value",
            "http://172.16.0.121:5173/#fragment",
        ] {
            assert!(configured_origin_for_build(input, configured, true).is_err());
        }
        assert!(configured_origin_for_build("https://usa0.top", "https://usa0.top", false).is_ok());
    }

    #[tokio::test]
    async fn image_operations_stay_on_the_bound_platform_and_reject_other_routes() {
        let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let captured = seen.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let app = Router::new().fallback(move |request: Request| {
                let captured = captured.clone();
                async move {
                    captured.lock().unwrap().push((
                        request.uri().path().to_owned(),
                        request.headers()["authorization"]
                            .to_str()
                            .unwrap()
                            .to_owned(),
                    ));
                    StatusCode::OK
                }
            });
            axum::serve(listener, app).await.unwrap();
        });
        let broker = ManagedModelBroker::start(origin).unwrap();
        let binding = broker
            .replace(vec![ManagedCredential {
                provider_id: "relay-key-77".into(),
                api_key: "synthetic-image-key".into(),
            }])
            .unwrap()
            .remove(0);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for path in [
            "/images/generations",
            "/v1/images/generations",
            "/images/edits",
            "/v1/images/edits",
        ] {
            let response = client
                .post(format!("{}{path}", binding.base_url))
                .bearer_auth(&binding.api_key)
                .body("{}")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
        }
        for path in [
            "/v1/images/jobs",
            "/v1/images/variations",
            "/v1/images/%65dits",
            "/api/v1/keys",
        ] {
            let response = client
                .post(format!("{}{path}", binding.base_url))
                .bearer_auth(&binding.api_key)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
        assert_eq!(
            client
                .get(format!("{}/v1/images/generations", binding.base_url))
                .bearer_auth(&binding.api_key)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 4);
        assert!(calls.iter().all(|(path, key)| {
            matches!(path.as_str(), "/v1/images/generations" | "/v1/images/edits")
                && key == "Bearer synthetic-image-key"
        }));
        server.abort();
    }

    #[tokio::test]
    async fn capabilities_forward_models_rotate_keys_revoke_and_never_expose_secrets() {
        let seen = Arc::new(Mutex::new(Vec::<(String, String, bool)>::new()));
        let captured = seen.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let upstream = tokio::spawn(async move {
            let app = Router::new().fallback(move |request: Request| {
                let captured = captured.clone();
                async move {
                    let auth = request
                        .headers()
                        .get("authorization")
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_string();
                    captured.lock().unwrap().push((
                        request.uri().to_string(),
                        auth.clone(),
                        request.headers().contains_key("cookie"),
                    ));
                    if request.uri().path() == "/v1/messages" {
                        return (StatusCode::UNAUTHORIZED, format!("bad key {auth}"))
                            .into_response();
                    }
                    if request.uri().path() == "/v1/responses" {
                        return (
                            [("content-type", "text/event-stream")],
                            "data: {\"ok\":true}\n\n",
                        )
                            .into_response();
                    }
                    (
                        [("content-type", "application/json")],
                        "{\"data\":[{\"id\":\"fixture-model\"}]}",
                    )
                        .into_response()
                }
            });
            axum::serve(listener, app).await.unwrap();
        });
        let broker = ManagedModelBroker::start(origin).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let bindings = broker
            .replace(vec![ManagedCredential {
                provider_id: "relay-key-7".into(),
                api_key: "raw-secret-a".into(),
            }])
            .unwrap();
        let binding = &bindings[0];
        assert!(!serde_json::to_string(&bindings)
            .unwrap()
            .contains("raw-secret"));
        let models = client
            .get(format!("{}/v1/models", binding.base_url))
            .bearer_auth(&binding.api_key)
            .header("cookie", "private=must-not-forward")
            .send()
            .await
            .unwrap();
        assert!(models.text().await.unwrap().contains("fixture-model"));
        let streamed = client
            .post(format!("{}/v1/responses", binding.base_url))
            .bearer_auth(&binding.api_key)
            .json(&serde_json::json!({"stream":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(streamed.headers()["content-type"], "text/event-stream");
        assert!(streamed.text().await.unwrap().contains("data:"));
        assert_eq!(
            client
                .post(format!("{}/api/v1/keys", binding.base_url))
                .bearer_auth(&binding.api_key)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{}/v1/models", binding.base_url))
                .bearer_auth(&binding.api_key)
                .header("origin", "https://evil.invalid")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let rotated = broker
            .replace(vec![ManagedCredential {
                provider_id: "relay-key-7".into(),
                api_key: "raw-secret-b".into(),
            }])
            .unwrap();
        assert_eq!(rotated[0].api_key, binding.api_key);
        let error = client
            .post(format!("{}/v1/messages", binding.base_url))
            .bearer_auth(&binding.api_key)
            .send()
            .await
            .unwrap();
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
        assert!(!error.text().await.unwrap().contains("raw-secret"));
        let google = client
            .post(format!(
                "{}/v1beta/models/gemini-fixture:generateContent?key={}",
                binding.base_url, binding.api_key
            ))
            .send()
            .await
            .unwrap();
        assert!(google.status().is_success());
        assert!(seen.lock().unwrap().iter().all(|(_, _, cookie)| !cookie));
        assert_eq!(seen.lock().unwrap()[0].1, "Bearer raw-secret-a");
        assert_eq!(seen.lock().unwrap()[2].1, "Bearer raw-secret-b");
        assert!(!seen.lock().unwrap()[3].0.contains("key="));
        broker.replace(vec![]).unwrap();
        assert_eq!(
            client
                .get(format!("{}/v1/models", binding.base_url))
                .bearer_auth(&binding.api_key)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let base = binding.base_url.clone();
        drop(broker);
        assert!(client
            .get(format!("{base}/v1/models"))
            .send()
            .await
            .is_err());
        upstream.abort();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn locked_backend_uses_broker_for_models_and_secrets_only_return_capabilities() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured = seen.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let fixture = tokio::spawn(async move {
            let app = Router::new().fallback(move |request: Request| {
                let captured = captured.clone();
                async move {
                    captured.lock().unwrap().push(request.headers()["authorization"].to_str().unwrap().to_string());
                    let path = request.uri().path().to_string();
                    let body = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
                    let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    if path.contains(":generateContent") {
                        return axum::Json(serde_json::json!({"candidates":[{"content":{"role":"model","parts":[{"text":"broker-model-ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}));
                    }
                    assert_eq!(request["model"], "fixture-model");
                    if path == "/v1/responses" {
                        return axum::Json(serde_json::json!({"id":"resp-fixture","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"broker-model-ok"}]}],"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}));
                    }
                    if path == "/v1/messages" {
                        return axum::Json(serde_json::json!({"id":"msg-fixture","type":"message","role":"assistant","content":[{"type":"text","text":"broker-model-ok"}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":2}}));
                    }
                    axum::Json(serde_json::json!({"choices":[{"message":{"role":"assistant","content":"broker-model-ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}))
                }
            });
            axum::serve(listener, app).await.unwrap();
        });
        let broker = ManagedModelBroker::start(origin).unwrap();
        let bindings = broker
            .replace(
                (1..=4)
                    .map(|id| ManagedCredential {
                        provider_id: format!("relay-key-{id}"),
                        api_key: "raw-usa-secret-never-in-kbrain".into(),
                    })
                    .collect(),
            )
            .unwrap();
        let binding = &bindings[0];
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("backend");
        std::fs::create_dir_all(&data).unwrap();
        let apis = [
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
            "google-generative-ai",
        ];
        let providers: serde_json::Map<String, serde_json::Value> = bindings.iter().zip(apis).map(|(binding, api)| {
            (binding.provider_id.clone(), serde_json::json!({"api":api,"apiKey":binding.api_key,"baseUrl":binding.base_url,"models":[{"id":"fixture-model","contextWindow":32768,"maxTokens":128}]}))
        }).collect();
        std::fs::write(
            data.join("config.json"),
            serde_json::to_vec(
                &serde_json::json!({"defaultModel":"fixture-model","providers":providers}),
            )
            .unwrap(),
        )
        .unwrap();
        // This is the checksum-verified release artifact prepared by prepare-kbrain.mjs.
        let binary = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/k-brain-x86_64-pc-windows-msvc.exe");
        assert!(
            binary.is_file(),
            "prepare the locked Windows ZeroAgent engine artifact before running this acceptance test"
        );
        let data_copy = data.clone();
        let manager = tokio::task::spawn_blocking(move || {
            super::super::kbrain_backend::KBrainBackendManager::start_with_binary_and_timeout(
                binary,
                data_copy,
                super::super::kbrain_backend::STARTUP_TIMEOUT,
            )
        })
        .await
        .unwrap()
        .unwrap();
        let connection = manager.connection();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        for binding in &bindings {
            let response = client
                .post(format!("{}/v1/text/generate", connection.base_url))
                .bearer_auth(&connection.token)
                .json(&serde_json::json!({
                "model":{"provider":binding.provider_id,"model":"fixture-model"},
                    "messages":[{"role":"user","content":[{"type":"text","text":"fixture"}]}]
                }))
                .send()
                .await
                .unwrap();
            let status = response.status();
            let body = response.text().await.unwrap();
            assert!(
                status.is_success(),
                "model execution failed ({status}): {body}"
            );
            assert!(body.contains("broker-model-ok"));
        }
        assert_eq!(seen.lock().unwrap().len(), 4);
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .all(|auth| auth == "Bearer raw-usa-secret-never-in-kbrain"));
        let secrets = client
            .post(format!(
                "{}/v1/settings/providers/relay-key-1/secrets",
                connection.base_url
            ))
            .bearer_auth(&connection.token)
            .json(&serde_json::json!({"confirm":true}))
            .send()
            .await
            .unwrap();
        assert!(secrets.status().is_success());
        let secrets: serde_json::Value = secrets.json().await.unwrap();
        assert_eq!(secrets["apiKey"], binding.api_key);
        let settings = client
            .get(format!("{}/v1/settings", connection.base_url))
            .bearer_auth(&connection.token)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(!settings.contains("raw-usa-secret"));
        assert!(!std::fs::read_to_string(data.join("config.json"))
            .unwrap()
            .contains("raw-usa-secret"));
        manager.shutdown();
        drop(broker);
        fixture.abort();
    }
}
