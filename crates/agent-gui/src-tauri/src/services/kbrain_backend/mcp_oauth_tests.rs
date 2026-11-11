struct OAuthMcpEndpoint {
    url: String,
    denied: Arc<std::sync::atomic::AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl OAuthMcpEndpoint {
    fn start() -> Self {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let denied = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let denied_requests = denied.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("MCP accept: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => continue,
                    Ok(_) => {}
                    // Reload cancels an in-flight Go connection. An accepted
                    // socket with no request is closed at the original deadline.
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                        ) =>
                    {
                        continue
                    }
                    Err(error) => panic!("MCP request line: {error}"),
                }
                let method = line.split_whitespace().next().unwrap().to_owned();
                let mut length = 0;
                let mut authorization = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    if line == "\r\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(raw) = lower.strip_prefix("content-length:") {
                        length = raw.trim().parse::<usize>().unwrap();
                    }
                    if lower.starts_with("authorization:") {
                        authorization = line.split_once(':').unwrap().1.trim().to_owned();
                    }
                }
                assert!(length < 128 * 1024);
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                drop(reader);
                let (status, body) = if authorization != "Bearer fixture-new-access" {
                    denied_requests.fetch_add(1, Ordering::SeqCst);
                    ("401 Unauthorized", String::new())
                } else if method == "DELETE" {
                    ("200 OK", String::new())
                } else {
                    let input: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    let result = match input["method"].as_str().unwrap_or("") {
                        "initialize" => {
                            serde_json::json!({"protocolVersion":input["params"]["protocolVersion"],"serverInfo":{"name":"native-oauth-fixture","version":"1"},"capabilities":{"tools":{}}})
                        }
                        "tools/list" => {
                            serde_json::json!({"tools":[{"name":"echo","description":"controlled echo","inputSchema":{"type":"object","properties":{}}}]})
                        }
                        "tools/call" => {
                            serde_json::json!({"content":[{"type":"text","text":"native-flow-ok fixture-new-access"}],"isError":false})
                        }
                        _ => serde_json::json!({}),
                    };
                    if input.get("id").is_none() {
                        ("202 Accepted", String::new())
                    } else {
                        (
                            "200 OK",
                            serde_json::json!({"jsonrpc":"2.0","id":input["id"],"result":result})
                                .to_string(),
                        )
                    }
                };
                let _=write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            }
        });
        Self {
            url,
            denied,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for OAuthMcpEndpoint {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            if let Err(error) = worker.join() {
                if !thread::panicking() {
                    std::panic::resume_unwind(error);
                }
            }
        }
    }
}

#[test]
#[ignore = "requires the explicitly built, hash-verified ZeroAgent adapted sidecar"]
fn native_mcp_adapted_sidecar_runs_owned_401_refresh_and_redacts_tool_output() {
    exercise_native_mcp_adapted_sidecar(false, false, false);
}

#[test]
#[ignore = "requires the explicitly built, hash-verified ZeroAgent adapted sidecar"]
fn native_mcp_adapted_sidecar_refreshes_expired_credentials_and_reuses_them_after_restart() {
    exercise_native_mcp_adapted_sidecar(true, false, false);
}

#[test]
#[ignore = "requires the explicitly built, hash-verified ZeroAgent adapted sidecar"]
fn native_mcp_adapted_sidecar_legacy_sse_refreshes_posts_preserves_history_and_closes_gets() {
    exercise_native_mcp_adapted_sidecar(false, true, false);
}

#[test]
#[ignore = "requires the explicitly built, hash-verified ZeroAgent adapted sidecar"]
fn native_mcp_adapted_sidecar_recovers_a_failed_rotation_save_without_another_grant() {
    exercise_native_mcp_adapted_sidecar(false, false, true);
}

fn wait_for_owned_mcp(http: &Client, connection: &KBrainBackendConnection) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status: serde_json::Value = http
            .get(format!("{}/v1/mcp", connection.base_url))
            .bearer_auth(&connection.token)
            .send()
            .unwrap()
            .json()
            .unwrap();
        if status["statuses"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == "secured" && entry["status"] == "ready")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "MCP did not become ready: {status}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn exercise_native_mcp_adapted_sidecar(
    initially_expired: bool,
    legacy_sse: bool,
    storage_fault: bool,
) {
    exercise_native_mcp_adapted_sidecar_mode(initially_expired, legacy_sse, storage_fault, None)
}

fn exercise_native_mcp_adapted_sidecar_mode(
    initially_expired: bool,
    legacy_sse: bool,
    storage_fault: bool,
    message_url_override: Option<bool>,
) {
    exercise_native_mcp_adapted_sidecar_modes(
        initially_expired,
        legacy_sse,
        storage_fault,
        message_url_override,
        None,
    )
}

fn exercise_native_mcp_adapted_sidecar_modes(
    initially_expired: bool,
    legacy_sse: bool,
    storage_fault: bool,
    message_url_override: Option<bool>,
    implicit: Option<bool>,
) {
    use crate::services::mcp_oauth::{scoped_tests::Fixture, store::TokenStore};
    use std::sync::atomic::AtomicUsize;
    let binary = PathBuf::from(
        std::env::var_os("ZEROAGENT_MCP_ADAPTED_TEST_BINARY")
            .expect("explicit adapted test binary"),
    );
    assert!(binary.is_absolute() && binary.is_file());
    let artifact: serde_json::Value = serde_json::from_slice(
        &std::fs::read(binary.parent().unwrap().join("kbrain-artifact.json"))
            .expect("adapted artifact receipt"),
    )
    .unwrap();
    assert_eq!(artifact["origin"], "zeroagent-patched-source");
    let lock: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../scripts/release/kbrain.lock.json"
    )))
    .unwrap();
    assert_eq!(artifact["sourceRevision"], lock["sourceRevision"]);
    assert_eq!(artifact["protocol"], PROTOCOL_VERSION);
    let hash = Sha256::digest(std::fs::read(&binary).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(
        artifact["platforms"][env!("ZEROAGENT_TARGET_TRIPLE")]["sha256"]["backend"],
        hash
    );
    let manifest = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../patches/kbrain/manifest.json"
    ))
    .unwrap();
    let manifest_hash = Sha256::digest(manifest)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(
        artifact["zeroagentPatchSet"]["manifestSha256"],
        manifest_hash
    );
    let count = Arc::new(AtomicUsize::new(0));
    let grants = count.clone();
    let fault_path = Arc::new(Mutex::new(None::<PathBuf>));
    let failing_path = fault_path.clone();
    let oauth = Fixture::new(move || {
        grants.fetch_add(1, Ordering::SeqCst);
        if let Some(path) = failing_path.lock().unwrap().take() {
            std::fs::write(path, b"controlled rotation persistence fault").unwrap();
        }
    });
    let http_endpoint = (!legacy_sse).then(OAuthMcpEndpoint::start);
    let sse_endpoint = legacy_sse.then(|| {
        if let Some(late) = implicit {
            OAuthSseMcpEndpoint::start_implicit(late)
        } else if message_url_override.is_some() {
            OAuthSseMcpEndpoint::start_mode(message_url_override)
        } else {
            OAuthSseMcpEndpoint::start()
        }
    });
    let (mcp_url, mcp_denied) = if let Some(endpoint) = &sse_endpoint {
        (&endpoint.url, &endpoint.denied)
    } else {
        let endpoint = http_endpoint.as_ref().unwrap();
        (&endpoint.url, &endpoint.denied)
    };
    let transport = if legacy_sse { "sse" } else { "http" };
    let expected_output = if legacy_sse {
        "native-flow-ok [redacted] [redacted]"
    } else {
        "native-flow-ok [redacted]"
    };
    let root = test_dir();
    let backend = root.path().join("backend");
    let settings = root.path().join("settings");
    std::fs::create_dir_all(&backend).unwrap();
    std::fs::create_dir_all(&settings).unwrap();
    std::fs::write(backend.join("config.json"),serde_json::to_vec(&serde_json::json!({"defaultModel":"fixture-model","providers":{"fixture":{"api":"openai-completions","baseUrl":"http://127.0.0.1:9","apiKey":"fixture-only","models":[{"id":"fixture-model","contextWindow":32768,"maxTokens":1024}]}}})).unwrap()).unwrap();
    let mut target = serde_json::json!({"id":"secured","transport":transport,"url":mcp_url,"scope":"read","clientId":"fixture-client","credentialRef":"native-owned-ref","headers":{}});
    let mut server = serde_json::json!({"id":"secured","enabled":true,"transport":transport,"url":mcp_url,"auth":{"type":"oauth","scope":"read","clientId":"fixture-client","credentialRef":"native-owned-ref"},"policy":{"echo":"allow"}});
    if message_url_override.is_some() {
        target["messageUrl"] = serde_json::json!("/configured-messages?channel=one");
        server["messageUrl"] = target["messageUrl"].clone();
    }
    std::fs::write(
        backend.join("config.json.live-mcp.json"),
        serde_json::to_vec(&serde_json::json!({"servers":[server]})).unwrap(),
    )
    .unwrap();
    let storage_id = backend_storage_id(&backend).unwrap();
    let (_, digest) = crate::commands::settings::verify_mcp_credential_target_file(
        &backend,
        &storage_id,
        &target,
    )
    .unwrap();
    let store = TokenStore::for_profile(settings.clone(), "secured", true).unwrap();
    let mut record = oauth.record();
    record.server_url = mcp_url.clone();
    record.resource = mcp_url.clone();
    record.target_binding = Some(digest);
    let now = crate::services::mcp_oauth::store::now_ms();
    record.expires_at_ms = if initially_expired {
        now.saturating_sub(1)
    } else {
        now + 3_600_000
    };
    store.save(&record, &store.snapshot().unwrap()).unwrap();
    let token_path = settings.join("mcp-oauth-tokens.json");
    let previous_file = std::fs::read(&token_path).unwrap();
    if storage_fault {
        *fault_path.lock().unwrap() = Some(token_path.clone());
    }
    let live = Arc::new(AtomicBool::new(true));
    let manager = KBrainBackendManager::start(
        binary.clone(),
        backend.clone(),
        None,
        STARTUP_TIMEOUT,
        &|| false,
        Some(McpCredentialOwner {
            settings_root: settings.clone(),
            profile_live: live.clone(),
            #[cfg(desktop)]
            device_skills: None,
        }),
        None,
    )
    .unwrap();
    let connection = manager.connection();
    let http = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    if storage_fault {
        let deadline = Instant::now() + Duration::from_secs(10);
        while count.load(Ordering::SeqCst) == 0 {
            assert!(
                Instant::now() < deadline,
                "Go never requested the initial Native refresh"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let (endpoint, capability) = {
            let credentials = manager.mcp_credentials.lock().unwrap();
            let credentials = credentials.as_ref().unwrap();
            (
                credentials.endpoint().to_owned(),
                credentials.capability().to_owned(),
            )
        };
        let previous_hash = Sha256::digest(b"fixture-old-access")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let denied = http.post(endpoint).bearer_auth(capability)
            .json(&serde_json::json!({"protocol":crate::services::mcp_oauth::broker::PROTOCOL,"target":target,"previousTokenHash":previous_hash}))
            .send().unwrap();
        assert_eq!(denied.status().as_u16(), 401);
        let body = denied.text().unwrap();
        assert!(!body.contains("fixture-new-access") && !body.contains("fixture-new-refresh"));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read(&token_path).unwrap(),
            b"controlled rotation persistence fault"
        );
        std::fs::write(&token_path, previous_file).unwrap();
        let reloaded = http
            .post(format!("{}/v1/mcp/reload", connection.base_url))
            .bearer_auth(&connection.token)
            .send()
            .unwrap();
        assert!(
            reloaded.status().is_success(),
            "Go failed to reload the saved MCP target"
        );
    }
    wait_for_owned_mcp(&http, &connection);
    if message_url_override.is_some() {
        let status: serde_json::Value = http
            .get(format!("{}/v1/mcp", connection.base_url))
            .bearer_auth(&connection.token)
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(
            status["settings"]["servers"][0]["messageUrl"],
            "/configured-messages?channel=one"
        );
    }
    let result: serde_json::Value = http
        .post(format!("{}/v1/mcp/tools/call", connection.base_url))
        .bearer_auth(&connection.token)
        .json(&serde_json::json!({"name":"mcp__secured__echo","arguments":{},"cwd":root.path()}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(result["failed"], false);
    assert_eq!(result["output"], expected_output);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        mcp_denied.load(Ordering::SeqCst),
        usize::from(!initially_expired)
    );
    if let Some(sse) = &sse_endpoint {
        sse.wait_for_active_gets(1);
        assert_eq!(sse.gets.load(Ordering::SeqCst), 1);
        assert_eq!(sse.calls.load(Ordering::SeqCst), 1);
    }
    let rotated = store.snapshot().unwrap().record.unwrap();
    assert_eq!(rotated.access_token, "fixture-new-access");
    for file in ["config.json", "config.json.live-mcp.json"] {
        let saved = std::fs::read_to_string(backend.join(file)).unwrap();
        assert!(!saved.contains("fixture-new-access"));
        assert!(!saved.contains("fixture-new-refresh"));
    }
    // A fresh host capability and sidecar process must reuse the saved Native
    // credential bound to this stable storage identity, without another grant.
    manager.shutdown();
    if let Some(sse) = &sse_endpoint {
        sse.wait_for_active_gets(0);
    }
    let manager = KBrainBackendManager::start(
        binary,
        backend.clone(),
        None,
        STARTUP_TIMEOUT,
        &|| false,
        Some(McpCredentialOwner {
            settings_root: settings,
            profile_live: live.clone(),
            #[cfg(desktop)]
            device_skills: None,
        }),
        None,
    )
    .unwrap();
    let connection = manager.connection();
    wait_for_owned_mcp(&http, &connection);
    let reused: serde_json::Value = http
        .post(format!("{}/v1/mcp/tools/call", connection.base_url))
        .bearer_auth(&connection.token)
        .json(&serde_json::json!({"name":"mcp__secured__echo","arguments":{},"cwd":root.path()}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(reused["failed"], false);
    assert_eq!(reused["output"], expected_output);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        mcp_denied.load(Ordering::SeqCst),
        usize::from(!initially_expired)
    );
    if let Some(sse) = &sse_endpoint {
        sse.wait_for_active_gets(1);
        assert_eq!(sse.gets.load(Ordering::SeqCst), 2);
        assert_eq!(sse.calls.load(Ordering::SeqCst), 2);
    }
    store.delete().unwrap();
    let denied: serde_json::Value = http
        .post(format!("{}/v1/mcp/tools/call", connection.base_url))
        .bearer_auth(&connection.token)
        .json(&serde_json::json!({"name":"mcp__secured__echo","arguments":{},"cwd":root.path()}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(denied["failed"], true);
    assert!(!denied.to_string().contains("fixture-new-access"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    if let Some(sse) = &sse_endpoint {
        assert_eq!(
            sse.calls.load(Ordering::SeqCst),
            2,
            "cleared credentials forwarded an SSE tool call"
        );
    }
    // Restore valid credentials, then terminate the child without invoking any
    // manager liveness/shutdown method. The stdout reader must revoke the host.
    store.save(&rotated, &store.snapshot().unwrap()).unwrap();
    let (host_endpoint, host_capability) = {
        let host = manager.mcp_credentials.lock().unwrap();
        let host = host.as_ref().unwrap();
        (host.endpoint().to_owned(), host.capability().to_owned())
    };
    let credential_request = || {
        http.post(&host_endpoint).bearer_auth(&host_capability)
        .json(&serde_json::json!({"protocol":crate::services::mcp_oauth::broker::PROTOCOL,"target":target})).send()
    };
    assert!(credential_request().unwrap().status().is_success());
    {
        let mut process = manager.process.lock().unwrap();
        let process = process.as_mut().unwrap();
        process.child.kill().unwrap();
        process.child.wait().unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match credential_request() {
            Err(_) => break,
            Ok(response) if !response.status().is_success() => break,
            Ok(_) => {}
        }
        assert!(
            Instant::now() < deadline,
            "exited sidecar retained MCP capability"
        );
        thread::sleep(Duration::from_millis(5));
    }
    live.store(false, Ordering::SeqCst);
    manager.shutdown();
    assert!(!manager.is_running());
    if let Some(sse) = &sse_endpoint {
        sse.wait_for_active_gets(0);
    }
}
