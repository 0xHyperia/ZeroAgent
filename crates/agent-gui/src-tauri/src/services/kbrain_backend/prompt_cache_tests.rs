#[test]
#[ignore = "requires the prepared backend and Node; only disposable profiles and a local synthetic model are used"]
fn native_prompt_cache_settings_reach_brokered_requests_after_restart() {
    assert!(
        std::env::var_os("ZEROAGENT_CONFIG_DIR").is_some(),
        "run with an isolated Native config directory"
    );
    let binary =
        PathBuf::from(std::env::var_os(TEST_BINARY_ENV).expect("explicit prepared Go backend"));
    let root = test_dir();
    let captures = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured = captures.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = url::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let model_url = origin.to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let worker = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let app = axum::Router::new().fallback(move |request: axum::extract::Request| {
                let captured = captured.clone();
                async move {
                    use axum::response::IntoResponse;
                    if request.uri().path() == "/_test/captures" {
                        return axum::Json(captured.lock().unwrap().clone()).into_response();
                    }
                    let responses = request.uri().path().ends_with("/responses");
                    let session = request.headers().get("x-session-id").and_then(|v|v.to_str().ok()).map(str::to_owned);
                    let owned = request.headers().get("authorization").is_some_and(|v|v=="Bearer synthetic-owned-key");
                    let bytes = axum::body::to_bytes(request.into_body(), 1024*1024).await.unwrap();
                    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    captured.lock().unwrap().push(serde_json::json!({"key":body.get("prompt_cache_key"),"retention":body.get("prompt_cache_retention"),"options":body.get("prompt_cache_options"),"session":session,"ownedCredential":owned}));
                    let event = if responses {
                        serde_json::json!({"type":"response.completed","response":{"id":"fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}})
                    } else {
                        serde_json::json!({"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]})
                    };
                    ([("content-type","text/event-stream")], format!("data: {event}\n\ndata: [DONE]\n\n")).into_response()
                }
            });
            axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), app)
                .with_graceful_shutdown(async {let _=stopped.await;}).await.unwrap();
        });
    });
    let mut failures = Vec::new();
    for (account, phase) in [
        ("cache-a", "first"),
        ("cache-a", "reopened"),
        ("cache-b", "isolated"),
    ] {
        let broker = ManagedModelBroker::start(origin.clone()).unwrap();
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
        let profile = BackendProfile::from_account_scope(Some(account)).unwrap();
        let data = profile.backend_dir(root.path());
        let private = state
            .ensure_started_with_binary(binary.clone(), data.clone())
            .unwrap();
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let mut provider = serde_json::json!({"id":"relay-key-7","type":"codex","api":"openai-responses","baseUrl":binding.base_url,"apiKey":binding.api_key});
        if phase != "reopened" {
            provider["models"] = serde_json::json!((0..4).map(|index|serde_json::json!({"id":format!("cache-model-{index}"),"contextWindow":32768,"maxOutputTokens":256})).collect::<Vec<_>>());
        }
        let registered = client
            .put(format!("{}/v1/settings", private.base_url))
            .bearer_auth(&private.token)
            .json(&serde_json::json!({"providers":[provider]}))
            .send()
            .unwrap();
        assert!(registered.status().is_success(), "fixture registration");
        let configuration = crate::commands::settings::configuration_http_service(
            Arc::downgrade(&state),
            private.clone(),
            data,
        )
        .unwrap();
        let facade = BackendFacade::start_with_configuration(
            private,
            Arc::new(AtomicBool::new(true)),
            configuration,
        )
        .unwrap();
        let public = facade.connection();
        let output = std::process::Command::new("node")
            .args([
                "--test",
                "test/providers/fixtures/prompt-cache-runtime-probe.mjs",
            ])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .env("ZEROAGENT_CACHE_PROBE_URL", public.base_url)
            .env("ZEROAGENT_CACHE_PROBE_TOKEN", public.token)
            .env("ZEROAGENT_CACHE_PROBE_MODEL", &model_url)
            .env("ZEROAGENT_CACHE_PROBE_PHASE", phase)
            .output()
            .unwrap();
        drop(facade);
        state.shutdown();
        println!("{}", String::from_utf8_lossy(&output.stdout));
        if !output.status.success() {
            failures.push(format!(
                "{phase}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
            break;
        }
    }
    let _ = stop.send(());
    worker.join().unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
