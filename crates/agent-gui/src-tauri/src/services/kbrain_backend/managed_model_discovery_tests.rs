// Exercises both public Native discovery entrypoints through the real prepared Go sidecar.
struct ManagedCatalogFixture {
    origin: url::Url,
    seen: Arc<Mutex<Vec<(String, bool)>>>,
    stopped: Arc<AtomicBool>,
    uncertain_image: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl ManagedCatalogFixture {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin =
            url::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let uncertain_image = Arc::new(AtomicBool::new(false));
        let fail_image = uncertain_image.clone();
        let worker = thread::spawn(move || {
            use std::io::Write;
            while !stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("catalog accept failed: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                let mut owned_key = false;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("authorization") {
                            owned_key = value.trim() == "Bearer synthetic-owned-key";
                        }
                    }
                }
                drop(reader);
                captured.lock().unwrap().push((path.clone(), owned_key));
                let uncertain =
                    path == "/v1/images/generations" && fail_image.load(Ordering::SeqCst);
                let status = if uncertain {
                    "500 Internal Server Error"
                } else {
                    "200 OK"
                };
                let body = if uncertain {
                    r#"{"error":{"code":"synthetic_uncertain_result"}}"#.to_owned()
                } else if path == "/v1/images/generations" {
                    use base64::Engine as _;
                    let image = base64::engine::general_purpose::STANDARD.encode(include_bytes!(
                        concat!(env!("CARGO_MANIFEST_DIR"), "/icons/128x128.png")
                    ));
                    serde_json::json!({"data":[{"b64_json":image}]}).to_string()
                } else {
                    r#"{"data":[{"id":"native-managed-model"}]}"#.to_owned()
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        Self {
            origin,
            seen,
            stopped,
            uncertain_image,
            worker: Some(worker),
        }
    }
}

#[test]
#[ignore = "requires an explicit prepared Go backend artifact; all image requests use an owned local fixture"]
fn native_managed_image_job_crosses_facade_and_broker_without_replaying_provider_work() {
    let binary =
        PathBuf::from(std::env::var_os(TEST_BINARY_ENV).expect("explicit prepared Go backend"));
    let provider = ManagedCatalogFixture::start();
    let broker = ManagedModelBroker::start(provider.origin.clone()).unwrap();
    let binding = broker
        .replace(vec![ManagedCredential {
            provider_id: "relay-key-7".into(),
            api_key: "synthetic-owned-key".into(),
        }])
        .unwrap()
        .remove(0);
    let state = Arc::new(KBrainBackendState::default());
    state.profile_initialized.store(true, Ordering::SeqCst);
    *state.model_broker.lock().unwrap() = Some(broker);
    let temp = test_dir();
    let private = state
        .ensure_started_with_binary(binary, temp.path().join("backend"))
        .unwrap();
    let facade = BackendFacade::start(private.clone(), Arc::new(AtomicBool::new(true))).unwrap();
    let public = facade.connection();
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let configured = client.put(format!("{}/v1/settings", private.base_url))
        .bearer_auth(&private.token)
        .json(&serde_json::json!({"providers":[{
            "id":"relay-key-7","api":"openai-responses","baseUrl":binding.base_url,"apiKey":binding.api_key,
            "models":[{"id":"gpt-image-2","imageAdapter":"enabled","contextWindow":128000,"maxOutputTokens":8192}],
            "activeModels":["gpt-image-2"]
        }]})).send().unwrap();
    assert!(
        configured.status().is_success(),
        "isolated provider registration"
    );
    let targets: serde_json::Value = client
        .get(format!("{}/v1/image/targets", public.base_url))
        .bearer_auth(&public.token)
        .send()
        .unwrap()
        .json()
        .unwrap();
    let target = targets["items"]
        .as_array()
        .unwrap_or_else(|| panic!("image target response: {targets}"))
        .iter()
        .find(|target| target["remoteId"] == "gpt-image-2")
        .expect("managed image target");
    let project: serde_json::Value = client
        .post(format!("{}/v1/image/projects", public.base_url))
        .bearer_auth(&public.token)
        .json(&serde_json::json!({"title":"Owned image fixture"}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    let request = serde_json::json!({"projectId":project["project"]["id"],"targetId":target["id"],
        "prompt":"synthetic local fixture","operation":"generate","count":1,"parameters":{},"inputs":[]});
    let key = uuid::Uuid::new_v4().to_string();
    let submit = || {
        client
            .post(format!("{}/v1/image/jobs", public.base_url))
            .bearer_auth(&public.token)
            .header("Idempotency-Key", &key)
            .json(&request)
            .send()
            .unwrap()
    };
    let accepted = submit();
    assert!(
        accepted.status().is_success(),
        "image job must reach the backend"
    );
    let accepted: serde_json::Value = accepted.json().unwrap();
    let id = accepted["job"]["id"].as_str().unwrap();
    let replayed: serde_json::Value = submit().json().unwrap();
    assert_eq!(replayed["replayed"], true);
    assert_eq!(replayed["job"]["id"], id);
    let deadline = Instant::now() + Duration::from_secs(10);
    let completed = loop {
        let snapshot: serde_json::Value = client
            .get(format!("{}/v1/image/jobs/{id}", public.base_url))
            .bearer_auth(&public.token)
            .send()
            .unwrap()
            .json()
            .unwrap();
        if snapshot["job"]["status"] == "succeeded" {
            break snapshot;
        }
        assert_ne!(
            snapshot["job"]["status"], "failed",
            "synthetic job: {snapshot}"
        );
        assert!(
            Instant::now() < deadline,
            "synthetic image job timed out: {snapshot}"
        );
        thread::sleep(Duration::from_millis(25));
    };
    let asset = completed["job"]["assetIds"][0].as_str().unwrap();
    let image = client
        .get(format!(
            "{}/v1/image/assets/{asset}/content?variant=original",
            public.base_url
        ))
        .bearer_auth(&public.token)
        .send()
        .unwrap()
        .bytes()
        .unwrap();
    assert_eq!(
        image.as_ref(),
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/128x128.png"))
    );

    // An ambiguous provider failure is terminal locally, but retains its uncertainty.
    // Removing that history must neither replay provider work nor remove another job.
    provider.uncertain_image.store(true, Ordering::SeqCst);
    let unknown_key = uuid::Uuid::new_v4().to_string();
    let unknown_request = || {
        client
            .post(format!("{}/v1/image/jobs", public.base_url))
            .bearer_auth(&public.token)
            .header("Idempotency-Key", &unknown_key)
            .json(&request)
            .send()
            .unwrap()
    };
    let unknown: serde_json::Value = unknown_request().json().unwrap();
    let unknown_id = unknown["job"]["id"].as_str().unwrap();
    let unknown_url = format!("{}/v1/image/jobs/{unknown_id}", public.base_url);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot: serde_json::Value = client
            .get(&unknown_url)
            .bearer_auth(&public.token)
            .send()
            .unwrap()
            .json()
            .unwrap();
        if snapshot["job"]["status"] == "result_unknown" {
            assert_eq!(snapshot["job"]["assetIds"].as_array().unwrap().len(), 0);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "unknown result timed out: {snapshot}"
        );
        thread::sleep(Duration::from_millis(25));
    }
    loop {
        let deleted = client
            .delete(&unknown_url)
            .bearer_auth(&public.token)
            .send()
            .unwrap();
        if deleted.status().is_success() {
            break;
        }
        assert_eq!(deleted.status(), reqwest::StatusCode::CONFLICT);
        assert!(
            Instant::now() < deadline,
            "unknown history stayed busy after worker exit"
        );
        thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(
        client
            .get(&unknown_url)
            .bearer_auth(&public.token)
            .send()
            .unwrap()
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    assert_eq!(
        unknown_request().status(),
        reqwest::StatusCode::NOT_FOUND,
        "deleted receipt must not create new work"
    );
    let mut history_url = url::Url::parse(&format!("{}/v1/image/jobs", public.base_url)).unwrap();
    history_url
        .query_pairs_mut()
        .append_pair("projectId", project["project"]["id"].as_str().unwrap());
    let history: serde_json::Value = client
        .get(history_url)
        .bearer_auth(&public.token)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert_eq!(history["items"][0]["id"], id);
    let seen = provider.seen.lock().unwrap();
    assert_eq!(
        seen.iter()
            .filter(|(path, _)| path == "/v1/images/generations")
            .count(),
        2
    );
    assert!(seen.iter().all(|(_, owned)| *owned));
    drop(seen);
    drop(facade);
    state.shutdown();
}
impl Drop for ManagedCatalogFixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
struct DiscoveryConfigurationFixture(Arc<KBrainBackendState>);
impl crate::services::backend_facade::ConfigurationHttpService for DiscoveryConfigurationFixture {
    fn request(
        &self,
        _: crate::services::backend_facade::ConfigurationHttpRequest,
    ) -> crate::services::backend_facade::ConfigurationHttpResponse {
        panic!("catalog discovery must not enter configuration mutation");
    }
    fn prepare_provider_models(
        &self,
        id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.0.prepare_provider_models(id, input)
    }
}
#[test]
#[ignore = "requires an explicit prepared Go backend artifact"]
fn native_managed_model_discovery_entries_ignore_external_overrides_and_require_current_binding() {
    let binary =
        PathBuf::from(std::env::var_os(TEST_BINARY_ENV).expect("explicit prepared Go backend"));
    assert!(binary.is_absolute() && binary.is_file());
    let catalog = ManagedCatalogFixture::start();
    let foreign = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    foreign.set_nonblocking(true).unwrap();
    let foreign_url = format!("http://{}", foreign.local_addr().unwrap());
    let state = Arc::new(KBrainBackendState::default());
    state.profile_initialized.store(true, Ordering::SeqCst);
    let broker = ManagedModelBroker::start(catalog.origin.clone()).unwrap();
    broker
        .replace(vec![ManagedCredential {
            provider_id: "relay-key-7".into(),
            api_key: "synthetic-owned-key".into(),
        }])
        .unwrap();
    *state.model_broker.lock().unwrap() = Some(broker);
    let temp = test_dir();
    let private = state
        .ensure_started_with_binary(binary, temp.path().join("backend"))
        .unwrap();
    let facade = BackendFacade::start_with_configuration(
        private.clone(),
        Arc::new(AtomicBool::new(true)),
        Arc::new(DiscoveryConfigurationFixture(state.clone())),
    )
    .unwrap();
    let public = facade.connection();
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let hostile = serde_json::json!({"providerId":"unrelated", "type":"codex", "api":"openai-responses", "baseUrl":foreign_url,"apiKey":"synthetic-injected-key","modelsUrl":format!("{foreign_url}/capture"),"isFullUrl":true,"customHeaders":[{"key":"Authorization","value":"synthetic-injected-key"}],"useSystemProxy":true});
    let response = client
        .post(format!(
            "{}/v1/settings/providers/relay-key-7/models",
            public.base_url
        ))
        .bearer_auth(&public.token)
        .json(&hostile)
        .send()
        .unwrap();
    assert!(
        response.status().is_success(),
        "Native facade discovery failed"
    );
    assert!(response.text().unwrap().contains("native-managed-model"));
    let remote = crate::services::gateway_bridge::managed_provider_models_body(
        &state,
        crate::services::gateway::proto::ProviderModelsRequest {
            provider_id: "relay-key-7".into(),
            provider_type: "codex".into(),
            request_format: "openai-responses".into(),
            base_url: foreign_url.clone(),
            models_url: format!("{foreign_url}/capture"),
            api_key: "synthetic-injected-key".into(),
            use_system_proxy: true,
            is_full_url: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let response = runtime
        .block_on(crate::services::gateway_bridge::kbrain_provider_models(
            &private, remote,
        ))
        .unwrap();
    assert!(response.to_string().contains("native-managed-model"));
    for id in [
        "external",
        "relay-key-7%2fforeign",
        "relay-key-7%252fforeign",
    ] {
        let response = client
            .post(format!(
                "{}/v1/settings/providers/{id}/models",
                public.base_url
            ))
            .bearer_auth(&public.token)
            .json(&hostile)
            .send()
            .unwrap();
        assert_eq!(
            response.status().as_u16(),
            403,
            "unknown or encoded provider identity must fail"
        );
    }
    assert!(
        crate::services::gateway_bridge::managed_provider_models_body(
            &state,
            crate::services::gateway::proto::ProviderModelsRequest {
                provider_id: "external".into(),
                provider_type: "codex".into(),
                ..Default::default()
            }
        )
        .is_err()
    );
    state
        .model_broker
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .replace(vec![])
        .unwrap();
    let response = client
        .post(format!(
            "{}/v1/settings/providers/relay-key-7/models",
            public.base_url
        ))
        .bearer_auth(&public.token)
        .json(&hostile)
        .send()
        .unwrap();
    assert_eq!(
        response.status().as_u16(),
        403,
        "revoked bindings cannot reuse a stored key"
    );
    assert!(
        crate::services::gateway_bridge::managed_provider_models_body(
            &state,
            crate::services::gateway::proto::ProviderModelsRequest {
                provider_id: "relay-key-7".into(),
                provider_type: "codex".into(),
                ..Default::default()
            }
        )
        .is_err()
    );
    let seen = catalog.seen.lock().unwrap();
    assert_eq!(
        seen.len(),
        2,
        "only the two authorized entrypoints reach the owned catalog"
    );
    assert!(
        seen.iter()
            .all(|(path, owned)| path == "/v1/models" && *owned),
        "requests must use the fixed catalog and Native-owned key"
    );
    assert!(
        matches!(foreign.accept(),Err(error) if error.kind()==io::ErrorKind::WouldBlock),
        "the caller-controlled endpoint must never receive a connection"
    );
    drop(seen);
    drop(facade);
    state.shutdown();
}
