#[test]
fn gateway_skills_bridge_preserves_canonical_read_versions_and_profile_revocation() {
    use crate::services::gateway_bridge::kbrain_skill_manage;
    use std::sync::atomic::{AtomicBool, Ordering};

    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    fs::create_dir_all(&settings).unwrap();
    let workspace = root.path().join("project a & b");
    fs::create_dir_all(&workspace).unwrap();
    let manager = start(&root.path().join("backend"));
    let service = Arc::new(ProfileConfigurationHttp {
        backend: None,
        connection: manager.connection(),
        backend_root: manager.configuration_root(),
        settings_root: settings.clone(),
    });
    let live = Arc::new(AtomicBool::new(true));
    let facade = crate::services::backend_facade::BackendFacade::start_with_configuration(
        manager.connection(),
        live.clone(),
        service,
    )
    .unwrap();
    let public = facade.connection();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let global = kbrain_skill_manage(&public, json!({"action":"list"}))
            .await
            .unwrap();
        let global_version = global["configurationVersion"].as_str().unwrap();
        assert!(global_version.starts_with('"') && global_version.ends_with('"'));
        assert_eq!(
            global["configurationProtocol"],
            "zeroagent.configuration.v1"
        );
        assert!(global["skills"].is_array());
        assert!(global["settings"]["enabled"].is_boolean());

        let missing = kbrain_skill_manage(
            &public,
            json!({"action":"settings","enabled":false,"selected":[]}),
        )
        .await
        .unwrap_err();
        assert!(
            missing.contains("VERSION_REQUIRED") && missing.contains("428"),
            "{missing}"
        );

        let workdir = workspace.to_str().unwrap();
        let scoped = kbrain_skill_manage(&public, json!({"action":"list","workdir":workdir}))
            .await
            .unwrap();
        let scoped_version = scoped["configurationVersion"].as_str().unwrap();
        assert_ne!(scoped_version, global_version);
        let edit = |version: &str| {
            json!({"action":"settings","workdir":workdir,
            "enabled":true,"selected":[],"mode":"custom","skillNames":["gateway-skill"],
            "configurationVersion":version})
        };
        let wrong_scope = kbrain_skill_manage(&public, edit(global_version))
            .await
            .unwrap_err();
        assert!(
            wrong_scope.contains("CONFIGURATION_CHANGED") && wrong_scope.contains("412"),
            "{wrong_scope}"
        );
        let saved = kbrain_skill_manage(&public, edit(scoped_version))
            .await
            .unwrap();
        assert_eq!(saved["settings"]["mode"], "custom");
        assert!(saved["settings"]["selected"]
            .as_array()
            .unwrap()
            .contains(&json!("gateway-skill")));
        assert_ne!(
            saved["configurationVersion"],
            scoped["configurationVersion"]
        );
        let stale = kbrain_skill_manage(&public, edit(scoped_version))
            .await
            .unwrap_err();
        assert!(
            stale.contains("CONFIGURATION_CHANGED") && stale.contains("412"),
            "{stale}"
        );
        let reread = kbrain_skill_manage(&public, json!({"action":"list","workdir":workdir}))
            .await
            .unwrap();
        assert_eq!(
            saved, reread,
            "the returned version belongs to the committed document"
        );

        // Unknown management actions are rejected by Go, not an obsolete Native whitelist.
        let unknown = kbrain_skill_manage(&public, json!({"action":"not-a-skill-action"}))
            .await
            .unwrap_err();
        assert!(unknown.contains("HTTP 4"), "{unknown}");
        live.store(false, Ordering::SeqCst);
        let revoked = kbrain_skill_manage(&public, json!({"action":"list"}))
            .await
            .unwrap_err();
        assert!(revoked.contains("401"), "{revoked}");
    });
    drop(runtime);
    // Metadata belongs to the RPC receipt, never the Go settings document.
    let raw: Value = serde_json::from_slice(
        &fs::read(manager.configuration_root().join("skills-settings.json")).unwrap(),
    )
    .unwrap();
    assert!(raw.get("action").is_none());
    assert!(raw.get("configurationVersion").is_none());
}

#[tokio::test]
async fn gateway_skills_bridge_rejects_invalid_envelopes_before_transport() {
    use crate::services::gateway_bridge::kbrain_skill_manage;
    use crate::services::kbrain_backend::PublicBackendConnection;
    let unavailable = PublicBackendConnection {
        base_url: "http://127.0.0.1:1".into(),
        token: "unused-synthetic-test".into(),
        protocol_version: "test".into(),
        storage_id: "test".into(),
    };
    for (payload, expected) in [
        (Value::Null, "must be an object"),
        (json!({}), "action is required"),
        (
            json!({"action":"list","workdir":123}),
            "workdir must be a string",
        ),
        (
            json!({"action":"settings","configurationVersion":123}),
            "configurationVersion must be a string",
        ),
    ] {
        let error = kbrain_skill_manage(&unavailable, payload)
            .await
            .unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("request failed"), "{error}");
    }
}
