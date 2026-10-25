use crate::services::mcp_oauth::scoped_tests::{
    callback as oauth_callback, Fixture as OauthFixture,
};
use crate::services::mcp_oauth::store::TokenStore;

fn oauth_settings(target: &native_mcp_oauth::OauthServer) -> Value {
    json!({"servers":[{"id":target.id,"transport":"http","enabled":false,"url":target.url,
        "headers":{"X-Private-Fixture":"private-header-must-not-escape"},
        "auth":{"type":"oauth","clientId":target.static_client_id,"scope":target.scope_override,
            "credentialRef":"private-ref-must-not-escape"}}],"selected":[]})
}

#[test]
fn canonical_mcp_oauth_rejects_nonstandard_message_endpoint_overrides() {
    let target = native_mcp_oauth::OauthServer {
        id: "saved".into(),
        url: "https://mcp.invalid/events".into(),
        scope_override: None,
        static_client_id: None,
    };
    let mut settings = oauth_settings(&target);
    settings["servers"][0]["transport"] = json!("sse");
    let original = mcp_oauth_target(&settings, "saved").unwrap();
    for blank in [Value::Null, json!(""), json!("  ")] {
        settings["servers"][0]["messageUrl"] = blank;
        assert!(mcp_oauth_target(&settings, "saved").unwrap() == original);
    }
    for unsupported in [
        json!("/messages"),
        json!("https://other.invalid/messages"),
        json!(42),
    ] {
        settings["servers"][0]["messageUrl"] = unsupported;
        assert_eq!(
            mcp_oauth_target(&settings, "saved").err().unwrap(),
            MCP_OAUTH_TARGET_CHANGED
        );
    }
}

#[test]
fn canonical_mcp_oauth_rejects_missing_ambiguous_non_remote_and_invalid_private_targets() {
    let target = native_mcp_oauth::OauthServer {
        id: "saved".into(),
        url: "https://mcp.invalid/mcp".into(),
        scope_override: Some("read".into()),
        static_client_id: Some("client".into()),
    };
    let saved = oauth_settings(&target);
    assert!(mcp_oauth_target(&saved, "saved").is_ok());
    assert_eq!(
        mcp_oauth_target(&saved, "not-saved").err().unwrap(),
        MCP_OAUTH_TARGET_CHANGED
    );
    let mut duplicate = saved.clone();
    duplicate["servers"]
        .as_array_mut()
        .unwrap()
        .push(saved["servers"][0].clone());
    assert_eq!(
        mcp_oauth_target(&duplicate, "saved").err().unwrap(),
        MCP_OAUTH_TARGET_CHANGED
    );
    for (pointer, value) in [
        ("/servers/0/transport", json!("stdio")),
        ("/servers/0/transport", json!("HTTP")),
        ("/servers/0/auth/type", json!("none")),
        ("/servers/0/auth/scope", json!(42)),
        (
            "/servers/0/auth/credentialRef",
            json!({"secret":"must-not-escape"}),
        ),
        (
            "/servers/0/headers",
            json!("private-header-must-not-escape"),
        ),
        (
            "/servers/0/url",
            json!("https://must-not-escape:secret@mcp.invalid/mcp"),
        ),
    ] {
        let mut invalid = saved.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            mcp_oauth_target(&invalid, "saved").err().unwrap(),
            MCP_OAUTH_TARGET_CHANGED
        );
    }
    let mut enabled = saved.clone();
    enabled["servers"][0]["enabled"] = json!(true);
    // Activation does not change the credential's recipient. This is a target
    // identity check, not proof of the still-missing Go execution bridge.
    assert!(
        mcp_oauth_target(&saved, "saved").unwrap() == mcp_oauth_target(&enabled, "saved").unwrap()
    );
}

#[test]
fn canonical_mcp_oauth_legacy_sse_keeps_its_transport_in_the_credential_binding() {
    let target = native_mcp_oauth::OauthServer {
        id: "saved".into(),
        url: "https://mcp.invalid/mcp".into(),
        scope_override: Some("read".into()),
        static_client_id: Some("client".into()),
    };
    let mut saved = oauth_settings(&target);
    saved["servers"][0]["enabled"] = json!(true);
    let http = mcp_oauth_target(&saved, "saved").unwrap();
    saved["servers"][0]["transport"] = json!("sse");
    let sse = mcp_oauth_target(&saved, "saved").unwrap();
    assert_eq!(sse.material["transport"], "sse");
    assert!(http != sse);
    assert_ne!(
        mcp_oauth_target_digest("profile", &http).unwrap(),
        mcp_oauth_target_digest("profile", &sse).unwrap()
    );
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("config.json.live-mcp.json"),
        serde_json::to_vec(&saved).unwrap(),
    )
    .unwrap();
    let claim = sse.material.clone();
    assert_eq!(
        verify_mcp_credential_target_file(root.path(), "profile", &claim)
            .unwrap()
            .1,
        mcp_oauth_target_digest("profile", &sse).unwrap()
    );
    assert_eq!(
        verify_mcp_credential_target_file(root.path(), "profile", &http.material).unwrap_err(),
        MCP_OAUTH_TARGET_CHANGED
    );
}

#[test]
fn canonical_mcp_oauth_uses_saved_target_binds_credentials_and_retains_legacy_records() {
    let fixture = OauthFixture::new(|| {});
    let target = fixture.target();
    let root = tempfile::tempdir().unwrap();
    let manager = start(&root.path().join("backend"));
    let settings_root = root.path().join("settings");
    fs::create_dir_all(&settings_root).unwrap();
    let store = TokenStore::for_profile(settings_root.clone(), &target.id, true).unwrap();
    let editor = snapshot_backend(&manager, &settings_root);
    let mut settings = oauth_settings(&target);
    {
        let _guard = editor.configuration.blocking_lock();
        editor
            .request(reqwest::Method::PUT, "/v1/mcp", Some(&settings))
            .unwrap();
    }
    for field in ["url", "scope", "clientId"] {
        let mut stale = target.clone();
        match field {
            "url" => stale.url = "https://untrusted.invalid/mcp".into(),
            "scope" => stale.scope_override = Some("write".into()),
            _ => stale.static_client_id = Some("other-client".into()),
        }
        assert_eq!(
            CanonicalMcpOauthBinding::capture_backend(
                snapshot_backend(&manager, &settings_root),
                &stale,
                "http"
            )
            .err()
            .unwrap(),
            MCP_OAUTH_TARGET_CHANGED
        );
    }
    assert!(CanonicalMcpOauthBinding::capture_backend(
        snapshot_backend(&manager, &settings_root),
        &target,
        "sse"
    )
    .is_err());
    let binding = CanonicalMcpOauthBinding::capture_backend(
        snapshot_backend(&manager, &settings_root),
        &target,
        "http",
    )
    .unwrap();
    let legacy = fixture.record();
    store.save(&legacy, &store.snapshot().unwrap()).unwrap();
    assert_eq!(binding.status(&store).unwrap().state, "none");
    assert_eq!(store.snapshot().unwrap().record, Some(legacy));
    // A non-MCP configuration write does not cancel this authorization.
    {
        let _guard = editor.configuration.blocking_lock();
        editor
            .request(
                reqwest::Method::PUT,
                "/v1/settings",
                Some(&json!({"defaultModel":"fixture-model"})),
            )
            .unwrap();
    }
    binding.validate().unwrap();
    let status =
        native_mcp_oauth::authorize(&store, binding.server(), &oauth_callback, &binding).unwrap();
    assert_eq!(status.state, "authorized");
    let record = store.snapshot().unwrap().record.unwrap();
    assert_eq!(
        record.target_binding.as_deref(),
        Some(binding.digest.as_str())
    );
    assert_eq!(binding.status(&store).unwrap().state, "authorized");
    let public = serde_json::to_string(&status).unwrap();
    for secret in [
        "fixture-new-access",
        "fixture-new-refresh",
        "private-ref-must-not-escape",
        "private-header-must-not-escape",
    ] {
        assert!(!public.contains(secret));
    }
    // Completed credentials survive display metadata edits. Any MCP write still
    // invalidates an authorization that was waiting during that write.
    settings["servers"][0]["description"] = json!("renamed display metadata");
    {
        let _guard = editor.configuration.blocking_lock();
        editor
            .request(reqwest::Method::PUT, "/v1/mcp", Some(&settings))
            .unwrap();
    }
    assert_eq!(binding.validate().unwrap_err(), MCP_OAUTH_TARGET_CHANGED);
    let current = CanonicalMcpOauthBinding::capture_backend(
        snapshot_backend(&manager, &settings_root),
        &target,
        "http",
    )
    .unwrap();
    assert_eq!(current.status(&store).unwrap().state, "authorized");
    // Private reference changes do not appear in public GET, but must invalidate
    // the binding even without an observed Native mutation counter.
    let sidecar = manager
        .configuration_root()
        .join("config.json.live-mcp.json");
    let original = fs::read(&sidecar).unwrap();
    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["servers"][0]["auth"]["credentialRef"] = json!("other-private-ref");
    fs::write(&sidecar, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(current.validate().unwrap_err(), MCP_OAUTH_TARGET_CHANGED);
    let replacement = CanonicalMcpOauthBinding::capture_backend(
        snapshot_backend(&manager, &settings_root),
        &target,
        "http",
    )
    .unwrap();
    assert_eq!(replacement.status(&store).unwrap().state, "none");
    assert_eq!(store.snapshot().unwrap().record, Some(record));
    fs::write(&sidecar, original).unwrap();
    manager.shutdown();
}

#[test]
fn canonical_mcp_oauth_late_exchange_cannot_commit_after_edit_delete_or_target_aba() {
    let root = tempfile::tempdir().unwrap();
    let manager = start(&root.path().join("backend"));
    let settings_root = root.path().join("settings");
    fs::create_dir_all(&settings_root).unwrap();
    let editor = Arc::new(snapshot_backend(&manager, &settings_root));
    let edits = Arc::new(Mutex::new(Vec::<Value>::new()));
    let pending = edits.clone();
    let editing = editor.clone();
    let fixture = OauthFixture::new(move || {
        for edit in std::mem::take(&mut *pending.lock().unwrap()) {
            let _guard = editing.configuration.blocking_lock();
            editing
                .request(reqwest::Method::PUT, "/v1/mcp", Some(&edit))
                .unwrap();
        }
    });
    let target = fixture.target();
    let original = oauth_settings(&target);
    let store = TokenStore::for_profile(settings_root.clone(), &target.id, true).unwrap();
    for action in [
        "url",
        "scope",
        "clientId",
        "credentialRef",
        "headers",
        "delete",
        "ABA",
    ] {
        {
            let _guard = editor.configuration.blocking_lock();
            editor
                .request(reqwest::Method::PUT, "/v1/mcp", Some(&original))
                .unwrap();
        }
        let old = fixture.record();
        store.save(&old, &store.snapshot().unwrap()).unwrap();
        let binding = CanonicalMcpOauthBinding::capture_backend(
            snapshot_backend(&manager, &settings_root),
            &target,
            "http",
        )
        .unwrap();
        let mut changed = original.clone();
        match action {
            "url" | "ABA" => changed["servers"][0]["url"] = json!("https://changed.invalid/mcp"),
            "scope" => changed["servers"][0]["auth"]["scope"] = json!("write"),
            "clientId" => changed["servers"][0]["auth"]["clientId"] = json!("changed-client"),
            "credentialRef" => {
                changed["servers"][0]["auth"]["credentialRef"] = json!("changed-reference")
            }
            "headers" => {
                changed["servers"][0]["headers"] =
                    json!({"X-Private-Fixture":"changed-private-header"})
            }
            _ => changed["servers"] = json!([]),
        }
        edits.lock().unwrap().push(changed);
        if action == "ABA" {
            edits.lock().unwrap().push(original.clone());
        }
        let result =
            native_mcp_oauth::authorize(&store, binding.server(), &oauth_callback, &binding);
        assert_eq!(result.unwrap_err(), MCP_OAUTH_TARGET_CHANGED, "{action}");
        assert_eq!(store.snapshot().unwrap().record, Some(old), "{action}");
    }
    drop(fixture);
    drop(editor);
    manager.shutdown();
}
