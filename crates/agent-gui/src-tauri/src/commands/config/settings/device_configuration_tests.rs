#[test]
fn device_configuration_persists_complete_batch_before_returning_a_public_receipt() {
    let root = tempfile::tempdir().unwrap();
    let workdir = root.path().join("workspace");
    fs::create_dir_all(&workdir).unwrap();
    #[cfg(unix)]
    let workdir = {
        let alias = root.path().join("workspace-alias");
        std::os::unix::fs::symlink(&workdir, &alias).unwrap();
        alias
    };
    let path = workdir.to_string_lossy().to_string();
    let path_key = normalize_project_path_key(&path);
    let manager = start(&root.path().join("backend"));
    let backend = snapshot_backend(&manager, &root.path().join("settings"));
    let _guard = backend.configuration.blocking_lock();
    let mut conn = native_db();
    save_system(&mut conn,json!({"workdir":path,"workspaceProjects":[
        {"id":"removed","name":"Removed","path":path},{"id":"kept","name":"Kept","path":root.path().to_string_lossy()}],
        "systemProxy":{"enabled":true,"scheme":"http","host":"127.0.0.1","port":9,"username":"fixture","password":"old-proxy-secret"}
    })).unwrap();
    conn.execute("INSERT INTO workspace_root_grants(grant_id,project_id,project_path_key,alias,display_path,canonical_path,access_mode,created_at,updated_at) VALUES('grant','removed',?1,'fixture',?1,?1,'read',1,1)",[&path_key]).unwrap();
    apply_ui_preferences(&conn,UiPreferencesUpdate {expected_revision:load_ui_preferences(&conn).unwrap().ui_revision,
        changes:json!({"theme":"light","customSettings":{"interfaceFontFamily":"Local Font","rightDock":{"width":777,"projects":{}}}})}).unwrap();
    save_stt(&mut conn,json!({"provider":"aliyun_dashscope","providers":{"aliyun_dashscope":{
        "id":"aliyun_dashscope","websocketUrl":"wss://example.com/stt","model":"fixture","apiKey":"old-stt-secret"}}})).unwrap();
    // Obsolete SQL records must not become the current device configuration.
    save_mcp(&mut conn,json!({"servers":[{"id":"obsolete","transport":"stdio","command":"node","env":{"TOKEN":"obsolete-private-value"}}],"selected":[]})).unwrap();
    backend.request(reqwest::Method::PUT,"/v1/mcp",Some(&json!({"servers":[
        {"id":"stdio","transport":"stdio","command":"node","args":[],"enabled":false,"env":{"TOKEN":"mcp-private-value"}},
        {"id":"http","transport":"http","url":"https://example.invalid/mcp","enabled":false,"headers":{"Authorization":"mcp-private-header"}}
    ],"selected":[]}))).unwrap();
    backend
        .request(
            reqwest::Method::PUT,
            "/v1/prompts/project",
            Some(&json!({"workdir":path,"prompt":"Before project","strategy":"append"})),
        )
        .unwrap();
    let before = backend.device_snapshot_locked(&mut conn).unwrap();
    assert_eq!(before["settingsSyncProtocol"], DEVICE_SETTINGS_PROTOCOL);
    assert_eq!(before["theme"], "light");
    assert_eq!(
        before["system"]["workspaceResourceSettings"][&path_key]["projectPrompt"],
        "Before project"
    );
    assert_eq!(
        before["mcp"]["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|server| server["id"] == "stdio")
            .unwrap()["env"]["TOKEN"],
        ""
    );
    assert!(!before.to_string().contains("obsolete-private-value"));
    let remote_before = load_remote_settings(&conn).unwrap();
    let mut system = before["system"].clone();
    system["workspaceProjects"] =
        json!([{"id":"kept","name":"Kept","path":root.path().to_string_lossy()}]);
    system["workspaceResourceSettings"][&path_key]["projectPrompt"] = json!("After project");
    system["workspaceResourceSettings"][&path_key]["projectPromptStrategy"] = json!("replace");
    let mut mcp = before["mcp"].clone();
    mcp["servers"][0]["description"] = json!("Edited metadata");
    let request = json!({"settingsSyncProtocol":DEVICE_SETTINGS_PROTOCOL,"configurationRevision":before["configurationRevision"],
        "uiPreferencesRevision":before["uiPreferencesRevision"],"theme":"dark","system":system,"systemProxyPasswordUpdate":"new-proxy-secret",
        "mcp":mcp,"agents":[{"id":"global","name":"Global","prompt":"Global instructions","enabled":true}],
        "memory":{"enabled":true},"skills":{"enabled":false,"selected":[]},
        "customSettings":{"interfaceFontFamily":"Remote Font","rightDock":{"width":222,"projects":{}}},
        "sshPatch":{"hostChanges":[{"id":"fixture-host","before":null,"after":{"id":"fixture-host","name":"Fixture","host":"host.invalid","port":22,"username":"fixture","authType":"password"}}]},
        "sshSecretUpdates":{"fixture-host":{"password":"new-ssh-secret"}},
        "sttSecretUpdate":{"provider":"aliyun_dashscope","providers":{"aliyun_dashscope":{"id":"aliyun_dashscope","websocketUrl":"wss://example.com/stt","model":"fixture","apiKey":"new-stt-secret"}}},
        "remote":{"enableWebTerminal":!remote_before.enable_web_terminal},"automationCron":{"revision":0,"tasks":[]}});
    let saved = backend.save_device_locked(&mut conn, request).unwrap();
    let receipt = serde_json::to_string(&saved).unwrap();
    for secret in [
        "new-proxy-secret",
        "new-ssh-secret",
        "new-stt-secret",
        "mcp-private-value",
        "mcp-private-header",
        "obsolete-private-value",
    ] {
        assert!(
            !receipt.contains(secret),
            "private value escaped device receipt"
        );
    }
    let current = saved.snapshot.unwrap();
    assert_ne!(
        current["configurationRevision"],
        before["configurationRevision"]
    );
    assert_eq!(current["theme"], "dark");
    assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
    assert_eq!(
        load_ui_preferences(&conn).unwrap().ui_preferences.unwrap()["customSettings"]
            ["interfaceFontFamily"],
        "Local Font"
    );
    assert_eq!(current["customSettings"]["rightDock"]["width"], 777);
    assert_eq!(
        load_system(&conn).unwrap().unwrap()["systemProxy"]["password"],
        "new-proxy-secret"
    );
    assert_eq!(
        load_ssh_or_empty(&conn).unwrap()["hosts"][0]["password"],
        "new-ssh-secret"
    );
    assert_eq!(
        load_stt_secret(&conn, "aliyun_dashscope", "apiKey").unwrap(),
        "new-stt-secret"
    );
    assert_eq!(current["agents"][0]["prompt"], "Global instructions");
    assert_eq!(current["skills"]["enabled"], false);
    assert_eq!(
        current["system"]["workspaceResourceSettings"][&path_key]["projectPrompt"],
        "After project"
    );
    assert_eq!(
        load_remote_settings(&conn).unwrap().enable_web_terminal,
        remote_before.enable_web_terminal
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM workspace_root_grants WHERE project_id='removed'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        backend
            .private_mcp_locked(
                &backend
                    .request(reqwest::Method::GET, "/v1/mcp", None)
                    .unwrap()
            )
            .unwrap()["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|server| server["id"] == "stdio")
            .unwrap()["env"]["TOKEN"],
        "mcp-private-value"
    );

    assert!(backend
        .save_device_locked(
            &mut conn,
            json!({"settingsSyncProtocol":DEVICE_SETTINGS_PROTOCOL,
        "configurationRevision":before["configurationRevision"],"memory":{"enabled":false}} )
        )
        .err()
        .unwrap()
        .contains("ZEROAGENT_CONFIGURATION_CHANGED"));
    let missing = backend
        .save_device_locked(&mut conn, json!({"memory":{"enabled":false}}))
        .err()
        .unwrap();
    assert!(missing.contains("VERSION_REQUIRED"));
    // UI changes can commit independently after the read, without changing the Go revision.
    apply_ui_preferences(
        &conn,
        UiPreferencesUpdate {
            expected_revision: current["uiPreferencesRevision"].as_str().unwrap().into(),
            changes: json!({"theme":"light"}),
        },
    )
    .unwrap();
    assert!(backend.save_device_locked(&mut conn,json!({"settingsSyncProtocol":DEVICE_SETTINGS_PROTOCOL,
        "configurationRevision":current["configurationRevision"],"uiPreferencesRevision":current["uiPreferencesRevision"],
        "memory":{"enabled":false},"theme":"dark"})).err().unwrap().contains(UI_PREFERENCES_CHANGED));
    assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);

    let before_failure = backend.device_snapshot_locked(&mut conn).unwrap();
    let mut failed_system = before_failure["system"].clone();
    let failed_path = path.clone();
    #[cfg(unix)]
    let failed_path = {
        let alias = root.path().join("another-workspace-alias");
        std::os::unix::fs::symlink(&workdir, &alias).unwrap();
        alias.to_string_lossy().to_string()
    };
    failed_system["workspaceResourceSettings"][normalize_project_path_key(&failed_path)] =
        json!({"projectPrompt":"Project edit must roll back","projectPromptStrategy":"replace"});
    conn.execute_batch("CREATE TRIGGER fail_device_ui BEFORE INSERT ON native_ui_preferences BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(backend.save_device_locked(&mut conn,json!({"settingsSyncProtocol":DEVICE_SETTINGS_PROTOCOL,
        "configurationRevision":before_failure["configurationRevision"],"uiPreferencesRevision":before_failure["uiPreferencesRevision"],
        "memory":{"enabled":false},"theme":"dark","system":failed_system,"skills":{"enabled":true,"selected":[]},
        "agents":[{"id":"failed","name":"Failed","prompt":"Must roll back","enabled":true}]})).is_err());
    assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
    assert_eq!(
        load_ui_preferences(&conn).unwrap().ui_preferences.unwrap()["theme"],
        "light"
    );
    let after_failure = backend.device_snapshot_locked(&mut conn).unwrap();
    assert_eq!(after_failure["agents"][0]["id"], "global");
    assert_eq!(after_failure["skills"]["enabled"], false);
    assert_eq!(
        after_failure["system"]["workspaceResourceSettings"][&path_key]["projectPrompt"],
        "After project",
        "a late Native failure must restore the existing prompt through its source alias"
    );
    let restored_prompts = backend.documents_locked().unwrap().prompts;
    let restored_project = restored_prompts["projectPrompts"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert_eq!(
        normalize_project_path_key(restored_project["sourceWorkdir"].as_str().unwrap()),
        path_key
    );
    let canonical_key =
        normalize_project_path_key(&fs::canonicalize(&workdir).unwrap().to_string_lossy());
    assert_eq!(
        after_failure["system"]["workspaceResourceSettings"][canonical_key]["projectPrompt"],
        "After project"
    );
    let outbound = backend
        .device_outbound_locked(&mut conn, after_failure.clone())
        .unwrap();
    assert_eq!(
        outbound[STT_SECRET_SYNC_FIELD]["providers"]["aliyun_dashscope"]["apiKey"],
        "new-stt-secret"
    );
    assert!(!redact_gateway_settings_sync_payload(outbound)
        .unwrap()
        .to_string()
        .contains("new-stt-secret"));
    let mut other_scope = native_db();
    save_stt(&mut other_scope,json!({"provider":"aliyun_dashscope","providers":{"aliyun_dashscope":{
        "id":"aliyun_dashscope","websocketUrl":"wss://example.com/stt","model":"fixture","apiKey":"other-profile-stt"}}})).unwrap();
    assert!(
        backend
            .device_outbound_locked(&mut other_scope, after_failure)
            .is_err(),
        "a stale snapshot must not receive another profile's private STT sidecar"
    );
    manager.shutdown();
}

#[test]
fn device_configuration_projects_preserve_source_alias_and_canonical_fallback() {
    let root = tempfile::tempdir().unwrap();
    let manager = start(&root.path().join("backend"));
    let backend = snapshot_backend(&manager, &root.path().join("settings"));
    let _guard = backend.configuration.blocking_lock();
    let mut conn = native_db();
    let alias = "/client/workspace-alias";
    save_system(
        &mut conn,
        json!({"workspaceProjects":[{"id":"canonical","name":"Canonical","path":"/canonical/workspace"}],
            "workspaceResourceSettings":{"/canonical/workspace":{"projectPrompt":"Stale instructions","projectPromptStrategy":"replace"}}}),
    )
    .unwrap();
    let mut documents = backend.documents_locked().unwrap();
    // The actual Go response distinguishes its filesystem identity from the path
    // retained for the client. Mapping it must not require that alias to exist now.
    documents.prompts["projectPrompts"] = json!({
        "aliased":{"workdir":"/canonical/workspace","sourceWorkdir":alias,"prompt":"Alias instructions","strategy":"append"},
        "canonical":{"workdir":"/canonical/second","prompt":"Canonical instructions","strategy":"replace"}
    });
    let snapshot = backend
        .device_snapshot_with_documents(&mut conn, &documents)
        .unwrap();
    let resources = &snapshot["system"]["workspaceResourceSettings"];
    assert_eq!(resources[alias]["projectPrompt"], "Alias instructions");
    assert_eq!(
        resources["/canonical/workspace"]["projectPrompt"],
        "Alias instructions"
    );
    assert_eq!(
        resources["/canonical/workspace"]["projectPromptStrategy"],
        "append"
    );
    assert_eq!(
        resources["/canonical/second"]["projectPrompt"],
        "Canonical instructions"
    );
    assert_eq!(
        resources["/canonical/second"]["projectPromptStrategy"],
        "replace"
    );
    manager.shutdown();
}
#[test]
fn device_memory_switch_uses_the_canonical_revision_and_preserves_native_memory() {
    let root = tempfile::tempdir().unwrap();
    let manager = start(&root.path().join("backend"));
    let backend = snapshot_backend(&manager, &root.path().join("settings"));
    let _guard = backend.configuration.blocking_lock();
    let mut conn = native_db();
    let native_memory = load_memory(&conn).unwrap();
    let before = backend.device_snapshot_locked(&mut conn).unwrap();
    assert_eq!(before["kbrainMemory"]["enabled"], true);
    let update = |snapshot: &Value, enabled: Value| json!({
        "settingsSyncProtocol": DEVICE_SETTINGS_PROTOCOL,
        "configurationRevision": snapshot["configurationRevision"],
        "uiPreferencesRevision": snapshot["uiPreferencesRevision"],
        "kbrainMemory": {"enabled": enabled}
    });
    let saved = backend
        .save_device_locked(&mut conn, update(&before, json!(false)))
        .unwrap()
        .snapshot
        .unwrap();
    assert_eq!(saved["kbrainMemory"]["enabled"], false);
    assert_eq!(load_memory(&conn).unwrap(), native_memory);
    assert!(backend
        .save_device_locked(&mut conn, update(&before, json!(true)))
        .err()
        .unwrap()
        .contains("ZEROAGENT_CONFIGURATION_CHANGED"));
    assert!(backend
        .save_device_locked(&mut conn, update(&saved, json!("yes")))
        .is_err());
    conn.execute_batch("CREATE TRIGGER fail_memory_ui BEFORE INSERT ON native_ui_preferences BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    let mut failed_update = update(&saved, json!(true));
    failed_update["theme"] = json!("dark");
    assert!(backend.save_device_locked(&mut conn, failed_update).is_err());
    assert_eq!(
        backend.device_snapshot_locked(&mut conn).unwrap()["kbrainMemory"]["enabled"],
        false
    );
    manager.shutdown();
    let restarted = start(&root.path().join("backend"));
    let restored = snapshot_backend(&restarted, &root.path().join("settings"));
    assert_eq!(
        restored.device_snapshot_locked(&mut conn).unwrap()["kbrainMemory"]["enabled"],
        false
    );
    restarted.shutdown();
}
