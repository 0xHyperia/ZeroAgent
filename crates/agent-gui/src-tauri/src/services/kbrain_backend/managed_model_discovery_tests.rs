// Exercises both public Native discovery entrypoints through the real prepared Go sidecar.
struct ManagedCatalogFixture {
    origin: url::Url,
    seen: Arc<Mutex<Vec<(String, bool)>>>,
    stopped: Arc<AtomicBool>,
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
                captured.lock().unwrap().push((path, owned_key));
                let body = r#"{"data":[{"id":"native-managed-model"}]}"#;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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
            worker: Some(worker),
        }
    }
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
