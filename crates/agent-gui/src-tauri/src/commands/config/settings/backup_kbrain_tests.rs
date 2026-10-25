mod canonical_backup_tests {
    use super::*;
    use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendManager};
    include!("device_configuration_tests.rs");
    include!("skills_http_tests.rs");
    include!("mcp_oauth_binding_tests.rs");

    fn binary() -> PathBuf {
        if let Some(path) = std::env::var_os("LIVEAGENT_KBRAIN_BINARY") {
            return PathBuf::from(path);
        }
        let triple = if cfg!(target_os = "windows") {
            "x86_64-pc-windows-msvc.exe"
        } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else if cfg!(target_os = "macos") {
            "x86_64-apple-darwin"
        } else {
            "x86_64-unknown-linux-gnu"
        };
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("k-brain-{triple}"))
    }

    fn provider(id: &str, key: &str) -> Value {
        json!({"id":id,"name":"Fixture","type":"codex","api":"openai-completions","baseUrl":"http://127.0.0.1:9",
            "apiKey":key,"models":[{"id":"fixture-model","contextWindow":32768,"maxOutputToken":1024}]})
    }

    fn start(root: &Path) -> Arc<KBrainBackendManager> {
        // Production starts one owned backend under KBrainBackendState::start_lock.
        // Keep unrelated backup fixtures from racing heavyweight executable startup;
        // explicit startup/cancellation concurrency remains covered in the host tests.
        static STARTUP: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _startup = STARTUP
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        fs::create_dir_all(root).unwrap();
        let config = root.join("config.json");
        if !config.exists() {
            fs::write(&config, serde_json::to_vec(&json!({"defaultModel":"fixture-model","providers":{
                "fixture":{"api":"openai-completions","baseUrl":"http://127.0.0.1:9","apiKey":"custom-backup-secret","models":[{"id":"fixture-model","contextWindow":32768,"maxTokens":1024}]},
                "relay-key-9":{"api":"openai-completions","baseUrl":"http://127.0.0.1:9","apiKey":"managed-must-never-enter-backup","models":[{"id":"managed-model","contextWindow":32768,"maxTokens":1024}]}
            }})).unwrap()).unwrap();
        }
        let trace_started = std::time::Instant::now();
        let trace_enabled = std::env::var_os("ZEROAGENT_TEST_BACKEND_TRACE").is_some();
        let root_hash = backup_sha256_hex(root.to_string_lossy().as_bytes());
        if trace_enabled {
            eprintln!(
                "backend-start-trace root_hash={} stage=start",
                &root_hash[..12]
            );
        }
        let result = KBrainBackendManager::start_with_binary_and_timeout(
            binary(),
            root.to_path_buf(),
            crate::services::kbrain_backend::STARTUP_TIMEOUT,
        );
        if trace_enabled {
            eprintln!(
                "backend-start-trace root_hash={} stage=end elapsed_ms={} success={}",
                &root_hash[..12],
                trace_started.elapsed().as_millis(),
                result.is_ok()
            );
        }
        result.unwrap()
    }

    fn native_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn
    }

    fn snapshot_backend(manager: &KBrainBackendManager, root: &Path) -> ProfileBackupBackend {
        let mut backend =
            ProfileBackupBackend::new(manager.connection(), None, root.to_path_buf()).unwrap();
        backend.backend_root = Some(manager.configuration_root());
        backend
    }

    fn source(backend: &ProfileBackupBackend, snapshot: &BackupSnapshot) -> BackupSource {
        BackupSource {
            schema_version: BACKUP_SCHEMA_VERSION,
            fingerprint: backup_import_fingerprint(
                &backend.settings_root,
                &backup_sha256_hex(&serde_json::to_vec(snapshot).unwrap()),
            ),
        }
    }

    #[test]
    fn canonical_backup_roundtrip_keeps_account_models_and_survives_restart() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("account-a");
        let settings = root.path().join("native-a");
        let manager = start(&data);
        let backend = snapshot_backend(&manager, &settings);
        let mut conn = native_db();
        let account = backend
            .request(reqwest::Method::GET, "/v1/settings", None)
            .unwrap();
        save_providers(
            &mut conn,
            json!([{"id":"sqlite-stale","apiKey":"stale-key"}]),
        )
        .unwrap();
        save_stt(&mut conn,json!({"provider":"aliyun_dashscope","allowIncomplete":true,"providers":{"aliyun_dashscope":{"id":"aliyun_dashscope","apiKey":"native-stt-secret"}}})).unwrap();
        backend.request(reqwest::Method::PUT,"/v1/prompts/templates",Some(&json!({"templates":[{"id":"prompt","name":"Canonical","prompt":"Original prompt","enabled":true}]}))).unwrap();
        backend.request(reqwest::Method::PUT,"/v1/mcp",Some(&json!({"servers":[{"id":"mcp","transport":"stdio","command":"node","enabled":false}],"selected":[]}))).unwrap();
        let snapshot = backend.collect(&conn).unwrap();
        assert!(snapshot.providers.is_none());
        assert!(snapshot.selected_model.is_none());
        let text = serialize_backup_document(&snapshot, &build_backup_manifest(&snapshot)).unwrap();
        assert!(text.contains("native-stt-secret"));
        for forbidden in [
            "stale-key",
            "custom-backup-secret",
            "managed-must-never-enter-backup",
            "relay-key-9",
            "selectedModel",
            "\"providers\": [",
        ] {
            assert!(!text.contains(forbidden), "{forbidden}");
        }
        backend
            .request(
                reqwest::Method::PUT,
                "/v1/prompts/templates",
                Some(&json!({"templates":[]})),
            )
            .unwrap();
        let origin = source(&backend, &snapshot);
        let outcome = apply_profile_backup(&mut conn, &backend, snapshot, origin).unwrap();
        assert_eq!(outcome.applied.providers, 0);
        let recovery = outcome.backup_path.unwrap();
        assert!(Path::new(&recovery).starts_with(&settings));
        assert!(!fs::read_to_string(&recovery)
            .unwrap()
            .contains("managed-must-never-enter-backup"));
        let after = backend
            .request(reqwest::Method::GET, "/v1/settings", None)
            .unwrap();
        for key in ["providers", "defaultProvider", "defaultModel"] {
            assert_eq!(account[key], after[key]);
        }
        assert_eq!(
            backend.collect(&conn).unwrap().agents.unwrap()[0]["prompt"],
            "Original prompt"
        );
        assert_eq!(
            load_providers(&conn).unwrap().unwrap()[0]["apiKey"],
            "stale-key",
            "old cached data stays untouched"
        );
        manager.shutdown();
        let restarted = start(&data);
        let reopened = snapshot_backend(&restarted, &settings)
            .collect(&conn)
            .unwrap();
        assert_eq!(reopened.agents.unwrap()[0]["prompt"], "Original prompt");
        assert!(reopened.providers.is_none());
        restarted.shutdown();
    }

    #[test]
    fn canonical_backup_failure_restores_acknowledged_domains_and_keeps_rollback_file() {
        let root = tempfile::tempdir().unwrap();
        let manager = start(&root.path().join("backend"));
        let settings = root.path().join("settings");
        let backend = snapshot_backend(&manager, &settings);
        let mut conn = native_db();
        backend.request(reqwest::Method::PUT, "/v1/prompts/templates", Some(&json!({"templates":[{"id":"before","name":"Before","prompt":"Preserve me","enabled":true}]}))).unwrap();
        let before = backend.collect(&conn).unwrap();
        let mut broken = before.clone();
        broken.agents = Some(json!([]));
        broken.mcp = Some(
            json!({"servers":[{"id":"broken","transport":"unsupported","enabled":true}],"selected":["broken"]}),
        );
        let origin = source(&backend, &broken);
        let error = apply_profile_backup(&mut conn, &backend, broken, origin).unwrap_err();
        assert!(error.contains("已恢复导入前配置"), "{error}");
        assert!(!error.contains("partially-applied-key"));
        let after = backend.collect(&conn).unwrap();
        assert!(after.providers.is_none());
        assert_eq!(after.agents, before.agents);
        assert!(fs::read_dir(settings.join(BACKUP_DIRNAME))
            .unwrap()
            .next()
            .is_some());
        assert!(!settings.join("migrations").exists());
        manager.shutdown();
    }

    #[test]
    fn canonical_backup_rejects_provider_and_model_injection_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let manager = start(&root.path().join("backend"));
        let backend = snapshot_backend(&manager, &root.path().join("settings"));
        let mut conn = native_db();
        let before = backend
            .request(reqwest::Method::GET, "/v1/settings", None)
            .unwrap();
        for snapshot in [
            BackupSnapshot {
                providers: Some(json!([provider("injected", "untrusted-key")])),
                ..Default::default()
            },
            BackupSnapshot {
                providers: Some(json!([])),
                ..Default::default()
            },
            BackupSnapshot {
                selected_model: Some(
                    json!({"customProviderId":"injected","model":"fixture-model"}),
                ),
                ..Default::default()
            },
        ] {
            let error = apply_profile_backup(
                &mut conn,
                &backend,
                snapshot.clone(),
                source(&backend, &snapshot),
            )
            .unwrap_err();
            assert!(error.contains("当前 USA-Zero 账户"));
            assert!(!error.contains("untrusted-key"));
            assert!(
                serialize_backup_document(&snapshot, &build_backup_manifest(&snapshot)).is_err()
            );
            let after = backend
                .request(reqwest::Method::GET, "/v1/settings", None)
                .unwrap();
            for key in ["providers", "defaultProvider", "defaultModel"] {
                assert_eq!(before[key], after[key]);
            }
        }
        assert!(!backend.settings_root.join(BACKUP_DIRNAME).exists());
        manager.shutdown();
    }

    #[test]
    fn canonical_upload_hash_tracks_backup_domains_and_ignores_account_provider_rotation() {
        let root = tempfile::tempdir().unwrap();
        let manager = start(&root.path().join("backend"));
        let backend = snapshot_backend(&manager, &root.path().join("settings"));
        let conn = native_db();
        let mut config = BackupSyncConfig {
            auto_sync: true,
            ..Default::default()
        };
        let first = prepare_backup_upload(&conn, &backend, &config, true)
            .unwrap()
            .unwrap();
        config.last_uploaded_snapshot_hash = Some(first.content_hash.clone());
        assert!(prepare_backup_upload(&conn, &backend, &config, true)
            .unwrap()
            .is_none());
        let manual = prepare_backup_upload(&conn, &backend, &config, false)
            .unwrap()
            .unwrap();
        assert_eq!(manual.content_hash, first.content_hash);
        assert_eq!(
            parse_backup_document(&manual.document).unwrap().0.providers,
            parse_backup_document(&first.document).unwrap().0.providers
        );
        backend.request(reqwest::Method::PUT, "/v1/prompts/templates", Some(&json!({"templates":[{"id":"direct","name":"Direct backend edit","prompt":"Outside WebView","enabled":true}]}))).unwrap();
        let edited = prepare_backup_upload(&conn, &backend, &config, true)
            .unwrap()
            .unwrap();
        assert_ne!(edited.content_hash, first.content_hash);
        config.last_uploaded_snapshot_hash = Some(edited.content_hash.clone());
        backend
            .request(
                reqwest::Method::PUT,
                "/v1/settings",
                Some(&json!({"providers":[provider("fixture","rotated-custom-key")]})),
            )
            .unwrap();
        assert!(prepare_backup_upload(&conn, &backend, &config, true)
            .unwrap()
            .is_none());
        config.last_error = Some("previous transfer failed".into());
        assert!(prepare_backup_upload(&conn, &backend, &config, true)
            .unwrap()
            .is_some());
        config.auto_sync = false;
        assert!(prepare_backup_upload(&conn, &backend, &config, true)
            .unwrap()
            .is_none());
        manager.shutdown();
    }

    #[test]
    fn canonical_backup_rejects_nonlocal_connections() {
        for base_url in [
            "https://127.0.0.1:443",
            "http://localhost:1234",
            "http://example.test:1234",
            "http://127.0.0.1:1234/other",
        ] {
            assert!(ProfileBackupBackend::new(
                KBrainBackendConnection {
                    base_url: base_url.into(),
                    token: "fixture".into(),
                    protocol_version: "kbrain.agent.v1".into(),
                    storage_id: "fixture".into()
                },
                None,
                PathBuf::from("fixture")
            )
            .is_err());
        }
    }

    #[test]
    fn canonical_backup_rejects_managed_secrets_hidden_in_custom_records_after_shutdown() {
        use crate::services::managed_model_broker::{ManagedCredential, ManagedModelBroker};
        let root = tempfile::tempdir().unwrap();
        let manager = start(&root.path().join("backend"));
        let mut backend = snapshot_backend(&manager, &root.path().join("settings"));
        let broker =
            ManagedModelBroker::start(url::Url::parse("https://usa0.top").unwrap()).unwrap();
        let bindings = broker
            .replace(vec![ManagedCredential {
                provider_id: "relay-key-9".into(),
                api_key: "managed-must-never-enter-backup".into(),
            }])
            .unwrap();
        backend.secret_guard = Some(broker.portable_guard());
        backend
            .request(
                reqwest::Method::PUT,
                "/v1/settings",
                Some(&json!({"providers":[provider("fixture", &bindings[0].api_key)]})),
            )
            .unwrap();
        backend.request(reqwest::Method::PUT,"/v1/mcp",Some(&json!({"servers":[{"id":"protected","transport":"stdio","command":"node","enabled":false,"env":{"TOKEN":bindings[0].api_key}}],"selected":[]}))).unwrap();
        assert!(
            backend.collect(&native_db()).is_err(),
            "model capabilities must not become portable MCP values"
        );
        backend
            .request(
                reqwest::Method::PUT,
                "/v1/settings",
                Some(
                    &json!({"providers":[provider("fixture", "managed-must-never-enter-backup")]}),
                ),
            )
            .unwrap();
        backend.request(reqwest::Method::PUT,"/v1/mcp",Some(&json!({"servers":[{"id":"protected","transport":"stdio","command":"node","enabled":false,"env":{"TOKEN":"managed-must-never-enter-backup"}}],"selected":[]}))).unwrap();
        drop(broker);
        let error = backend.collect(&native_db()).unwrap_err();
        assert!(error.contains("受保护的托管密钥"));
        assert!(!error.contains("managed-must-never-enter-backup"));
        assert!(!backend.settings_root.join(BACKUP_DIRNAME).exists());
        manager.shutdown();
    }
    #[test]
    fn canonical_configuration_batch_versions_all_domains_and_restores_private_mcp_on_late_failure()
    {
        let root = tempfile::tempdir().unwrap();
        let workdir = root.path().join("project");
        fs::create_dir_all(&workdir).unwrap();
        let manager = start(&root.path().join("backend"));
        let backend = snapshot_backend(&manager, &root.path().join("settings"));
        let _guard = backend.configuration.blocking_lock();
        let mut conn = native_db();
        backend.request(reqwest::Method::PUT, "/v1/mcp", Some(&json!({"servers":[{
            "id":"private-mcp","transport":"stdio","command":"node","enabled":false,
            "env":{"TOKEN":"original-private-mcp-secret"},"headers":{"Authorization":"private-header"}
        }],"selected":[]}))).unwrap();
        let before = backend.documents_locked().unwrap();
        let public = serde_json::to_string(&before).unwrap();
        assert!(!public.contains("original-private-mcp-secret"));
        assert!(!public.contains("private-header"));
        assert_eq!(before.mcp["settings"]["servers"][0]["env"]["TOKEN"], "");
        assert_eq!(
            before.mcp["settings"]["servers"][0]["envConfigured"],
            json!(["TOKEN"])
        );
        let version = backend
            .revision_locked(&native_configuration_revision(&conn).unwrap(), &before)
            .unwrap();
        let mut mcp = before.mcp["settings"].clone();
        mcp["servers"][0]["description"] = json!("Updated description");
        let update = serde_json::from_value(json!({"expectedRevision":version,
            "nativeChanges":{"memory":{"enabled":true}},
            "settings":{"providers":[provider("fixture","updated-provider-secret")]},
            "mcp":mcp,
            "templates":[{"id":"canonical","name":"Canonical","prompt":"New global prompt","enabled":true}],
            "projects":[{"workdir":workdir,"prompt":"Project instructions","strategy":"replace"}]
        })).unwrap();
        let saved = backend
            .save_canonical_locked(&mut conn, update, "")
            .unwrap();
        assert_ne!(saved.configuration_revision, version);
        assert_eq!(
            saved.backend.prompts["globalTemplates"][0]["prompt"],
            "New global prompt"
        );
        assert!(saved.backend.prompts["projectPrompts"]
            .as_object()
            .unwrap()
            .values()
            .any(|project| project["prompt"] == "Project instructions"));
        assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
        let private = backend.private_mcp_locked(&saved.backend.mcp).unwrap();
        assert_eq!(
            private["servers"][0]["env"]["TOKEN"],
            "original-private-mcp-secret"
        );
        assert_eq!(
            private["servers"][0]["headers"]["Authorization"],
            "private-header"
        );
        let stale = serde_json::from_value(
            json!({"expectedRevision":version,"nativeChanges":{"memory":{"enabled":false}}}),
        )
        .unwrap();
        assert_eq!(
            backend
                .save_canonical_locked(&mut conn, stale, "")
                .err()
                .unwrap(),
            "ZEROAGENT_CONFIGURATION_CHANGED"
        );
        // MCP succeeds, then invalid templates fail. SQLite must remain unchanged;
        // compensation must restore the private fields hidden in the public GET.
        let mut changed_mcp = saved.backend.mcp["settings"].clone();
        changed_mcp["servers"][0]["env"]["TOKEN"] = json!("replacement-secret");
        changed_mcp["servers"][0]["headers"] = json!({});
        let failure = serde_json::from_value(json!({"expectedRevision":saved.configuration_revision,
            "nativeChanges":{"memory":{"enabled":false}},"settings":{"providers":[provider("fixture","should-be-undone")]},"mcp":changed_mcp,"templates":[{"id":"","name":"Invalid"}]
        })).unwrap();
        let error = backend
            .save_canonical_locked(&mut conn, failure, "")
            .err()
            .unwrap();
        assert!(error.contains("已恢复更改前配置"), "{error}");
        assert!(!error.contains("replacement-secret"));
        assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
        let after = backend.documents_locked().unwrap();
        assert_eq!(backend.private_mcp_locked(&after.mcp).unwrap(), private);
        let restored_key = backend
            .request(
                reqwest::Method::POST,
                "/v1/settings/providers/fixture/secrets",
                Some(&json!({"confirm":true})),
            )
            .unwrap();
        assert_eq!(restored_key["apiKey"], "updated-provider-secret");
        assert_eq!(
            after.prompts["globalTemplates"],
            saved.backend.prompts["globalTemplates"]
        );
        let export = backend.collect_locked(&conn).unwrap();
        let text = serde_json::to_string(&export).unwrap();
        assert!(text.contains("original-private-mcp-secret"));
        assert!(text.contains("private-header"));
        assert!(
            !text.contains("Project instructions"),
            "Portable backups omit machine-specific project prompts"
        );
        drop(_guard);
        manager.shutdown();
    }

    #[test]
    fn canonical_configuration_private_mcp_edits_clear_keys_and_require_new_values_for_new_targets()
    {
        let private = json!({"servers":[{"id":"m","transport":"http","url":"https://a.invalid/mcp",
            "env":{"TOKEN":"private-value"},"headers":{"Authorization":"private-header"},
            "auth":{"type":"oauth","clientId":"client","scope":"read","credentialRef":"private-ref"},"workspaceRoots":["/private-project"],"policy":{"dangerous_tool":"deny"}}],"selected":[]});
        let mut public = public_mcp_with_presence(&private).unwrap();
        assert!(!serde_json::to_string(&public)
            .unwrap()
            .contains("private-value"));
        public["servers"][0]["description"] = json!("metadata edit");
        public["servers"][0]
            .as_object_mut()
            .unwrap()
            .remove("workspaceRoots");
        public["servers"][0]
            .as_object_mut()
            .unwrap()
            .remove("policy");
        let merged = merge_mcp_private_fields(&private, public.clone()).unwrap();
        assert_eq!(
            merged["servers"][0]["workspaceRoots"],
            json!(["/private-project"])
        );
        assert_eq!(
            merged["servers"][0]["policy"],
            json!({"dangerous_tool":"deny"})
        );
        assert_eq!(merged["servers"][0]["env"]["TOKEN"], "private-value");
        assert_eq!(merged["servers"][0]["auth"]["credentialRef"], "private-ref");
        public["servers"][0]["env"] = json!({});
        public["servers"][0]["headers"] = json!({});
        let cleared = merge_mcp_private_fields(&private, public.clone()).unwrap();
        assert_eq!(cleared["servers"][0]["env"], json!({}));
        public["servers"][0]["url"] = json!("https://b.invalid/mcp");
        let switched = merge_mcp_private_fields(&private, public).unwrap();
        assert!(switched["servers"][0]["auth"]
            .get("credentialRef")
            .is_none());
        let mut reused = public_mcp_with_presence(&private).unwrap();
        reused["servers"][0]["url"] = json!("https://b.invalid/mcp");
        assert!(merge_mcp_private_fields(&private, reused).is_err());
        let renamed = json!({"servers":[{"id":"new-id","transport":"http","url":"https://a.invalid/mcp","env":{"TOKEN":""}}]});
        assert!(merge_mcp_private_fields(&private, renamed)
            .unwrap_err()
            .contains("私有值缺失"));
    }
    #[test]
    fn canonical_configuration_lost_mutation_response_blocks_followup_reads_and_writes() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes).unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{").unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let backend = ProfileBackupBackend::new(
            KBrainBackendConnection {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "private-token".into(),
                protocol_version: "kbrain.agent.v1".into(),
                storage_id: Uuid::new_v4().to_string(),
            },
            None,
            root.path().to_path_buf(),
        )
        .unwrap();
        let _guard = backend.configuration.blocking_lock();
        assert!(backend
            .request(reqwest::Method::PUT, "/v1/settings", Some(&json!({})))
            .is_err());
        worker.join().unwrap();
        assert!(backend.configuration.ensure_consistent().is_err());
        let error = backend
            .request(reqwest::Method::GET, "/v1/settings", None)
            .unwrap_err();
        assert!(error.contains("重启客户端"));
        assert!(!error.contains("private-token"));
    }

    #[test]
    fn canonical_configuration_private_jsonc_matches_backend_comments_and_trailing_commas() {
        let input = br#"// backend-generated header
        {"mcpServers":{"m":{"env":{"TOKEN":"https://a.invalid/*keep*/?v=//secret",},},},
         "escaped":"quote: \" // keep", /* comment */ "list":[1,2,],}
        "#;
        let parsed = parse_kbrain_private_jsonc(input).unwrap();
        assert_eq!(
            parsed["mcpServers"]["m"]["env"]["TOKEN"],
            "https://a.invalid/*keep*/?v=//secret"
        );
        assert_eq!(parsed["escaped"], "quote: \" // keep");
        assert_eq!(parsed["list"], json!([1, 2]));
        for invalid in [
            b"{/* never closed".as_slice(),
            br#"{"key":"never closed}"#,
            b"{unquoted:1}",
            b"[1,,]",
        ] {
            assert_eq!(
                parse_kbrain_private_jsonc(invalid).unwrap_err(),
                "私有配置格式无效"
            );
        }
    }

    #[test]
    fn canonical_configuration_reads_legacy_mcp_private_fields_and_rejects_target_mismatch() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("config.json"),
            br#"// backend config
          {"mcp":{"legacy":{"command":["node","server.js"],"env":{"TOKEN":"legacy-private"},
          "headers":{"Authorization":"legacy-header"},},},}"#,
        )
        .unwrap();
        let mut backend = ProfileBackupBackend::new(
            KBrainBackendConnection {
                base_url: "http://127.0.0.1:9".into(),
                token: "fixture".into(),
                protocol_version: "kbrain.agent.v1".into(),
                storage_id: Uuid::new_v4().to_string(),
            },
            None,
            root.path().join("settings"),
        )
        .unwrap();
        backend.backend_root = Some(root.path().to_path_buf());
        let mut public = json!({"settings":{"servers":[{"id":"legacy","transport":"stdio","command":"node","args":["server.js"]}]}});
        let private = backend.private_mcp_locked(&public).unwrap();
        assert_eq!(private["servers"][0]["env"]["TOKEN"], "legacy-private");
        assert_eq!(
            private["servers"][0]["headers"]["Authorization"],
            "legacy-header"
        );
        let hidden = public_mcp_with_presence(&private).unwrap();
        assert!(!serde_json::to_string(&hidden)
            .unwrap()
            .contains("legacy-private"));
        public["settings"]["servers"][0]["args"] = json!(["other.js"]);
        assert!(backend
            .private_mcp_locked(&public)
            .unwrap_err()
            .contains("运行目标"));
    }

    #[test]
    fn canonical_http_requires_read_versions_preserves_private_mcp_and_detects_native_and_private_changes(
    ) {
        let root = tempfile::tempdir().unwrap();
        let settings = root.path().join("settings");
        fs::create_dir_all(&settings).unwrap();
        let manager = start(&root.path().join("backend"));
        let private = snapshot_backend(&manager, &settings);
        private.request(reqwest::Method::PUT,"/v1/mcp",Some(&json!({"servers":[{"id":"m","transport":"stdio","command":"node","enabled":false,"env":{"TOKEN":"http-private-value"},"policy":{"unsafe":"deny"}}],"selected":[]}))).unwrap();
        let service = Arc::new(ProfileConfigurationHttp {
            backend: None,
            connection: manager.connection(),
            backend_root: manager.configuration_root(),
            settings_root: settings.clone(),
        });
        let facade = crate::services::backend_facade::BackendFacade::start_with_configuration(
            manager.connection(),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
            service,
        )
        .unwrap();
        let public = facade.connection();
        let http = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();
        let get = |path: &str| {
            http.get(format!("{}{path}", public.base_url))
                .bearer_auth(&public.token)
                .send()
                .unwrap()
        };
        let settings_response = get("/v1/settings");
        assert_eq!(settings_response.status(), 200);
        let settings_etag = settings_response.headers()["etag"]
            .to_str()
            .unwrap()
            .to_owned();
        let read = get("/v1/mcp");
        let etag = read.headers()["etag"].to_str().unwrap().to_owned();
        let doc: Value = read.json().unwrap();
        assert_eq!(
            doc["settings"]["servers"][0]["envConfigured"],
            json!(["TOKEN"])
        );
        assert!(!serde_json::to_string(&doc)
            .unwrap()
            .contains("http-private-value"));
        let mut edit = doc["settings"].clone();
        edit["servers"][0]["description"] = json!("HTTP metadata edit");
        edit["servers"][0].as_object_mut().unwrap().remove("policy");
        let put = |tag: Option<&str>| {
            let request = http
                .put(format!("{}/v1/mcp", public.base_url))
                .bearer_auth(&public.token)
                .json(&edit);
            match tag {
                Some(tag) => request.header("if-match", tag),
                None => request,
            }
            .send()
            .unwrap()
        };
        assert_eq!(put(None).status(), 428);
        assert_eq!(
            put(Some(&settings_etag)).status(),
            412,
            "a settings read cannot lend a version to MCP"
        );
        assert_eq!(get("/v1/mcp").headers()["etag"], etag);
        let saved = put(Some(&etag));
        assert_eq!(saved.status(), 200);
        let current_etag = saved.headers()["etag"].to_str().unwrap().to_owned();
        assert_ne!(current_etag, etag);
        assert_eq!(put(Some(&etag)).status(), 412);
        let raw = private
            .private_mcp_locked(&get("/v1/mcp").json().unwrap())
            .unwrap();
        assert_eq!(raw["servers"][0]["env"]["TOKEN"], "http-private-value");
        assert_eq!(raw["servers"][0]["policy"], json!({"unsafe":"deny"}));
        let mut conn = open_profile_db(settings.join(DB_FILENAME)).unwrap();
        save_memory(&mut conn, json!({"enabled":true})).unwrap();
        assert_eq!(
            put(Some(&current_etag)).status(),
            412,
            "SQL changes invalidate the actual global snapshot"
        );
        let read = get("/v1/mcp");
        let current_etag = read.headers()["etag"].to_str().unwrap().to_owned();
        let file = manager
            .configuration_root()
            .join("config.json.live-mcp.json");
        let mut changed: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        changed["servers"][0]["env"]["TOKEN"] = json!("rotated-private-value");
        fs::write(&file, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert_eq!(
            put(Some(&current_etag)).status(),
            412,
            "hidden fields are part of the version"
        );
        let response = get("/v1/mcp");
        let etag = response.headers()["etag"].to_str().unwrap().to_owned();
        assert_eq!(
            http.get(format!("{}/v1/mcp", public.base_url))
                .bearer_auth(&public.token)
                .header("if-none-match", &etag)
                .send()
                .unwrap()
                .status(),
            304
        );
        let head = http
            .head(format!("{}/v1/mcp", public.base_url))
            .bearer_auth(&public.token)
            .send()
            .unwrap();
        assert_eq!(head.headers()["etag"], etag);
        assert!(head.bytes().unwrap().is_empty());
        let prompt = get("/v1/prompts");
        let prompt_etag = prompt.headers()["etag"].to_str().unwrap().to_owned();
        let created=http.post(format!("{}/v1/prompts/templates",public.base_url)).bearer_auth(&public.token).header("if-match",prompt_etag).json(&json!({"id":"http-template","name":"HTTP template","prompt":"Read-bound instructions","enabled":true})).send().unwrap();
        assert_eq!(created.status(), 201);
        let next_etag = created.headers()["etag"].to_str().unwrap().to_owned();
        let patched = http
            .patch(format!(
                "{}/v1/prompts/templates/http-template",
                public.base_url
            ))
            .bearer_auth(&public.token)
            .header("if-match", next_etag)
            .json(&json!({"prompt":"Edited instructions"}))
            .send()
            .unwrap();
        assert_eq!(patched.status(), 200);
        let patch_etag = patched.headers()["etag"].to_str().unwrap().to_owned();
        assert_eq!(
            patched.json::<Value>().unwrap()["templates"][0]["prompt"],
            "Edited instructions"
        );
        let second=http.post(format!("{}/v1/prompts/templates",public.base_url)).bearer_auth(&public.token).header("if-match",patch_etag).json(&json!({"id":"http-z-template","name":"Second","prompt":"Second prompt","enabled":true})).send().unwrap();
        assert_eq!(second.status(), 201);
        let second_etag = second.headers()["etag"].to_str().unwrap().to_owned();
        let second: Value = second.json().unwrap();
        assert_eq!(second["templates"][0]["enabled"], false);
        assert_eq!(second["templates"][1]["enabled"], true);
        let switched=http.patch(format!("{}/v1/prompts/templates/http-template",public.base_url)).bearer_auth(&public.token).header("if-match",second_etag).json(&json!({"name":null,"description":null,"prompt":null,"enabled":true,"baseRevision":null})).send().unwrap();
        assert_eq!(switched.status(), 200);
        let switched: Value = switched.json().unwrap();
        assert_eq!(switched["templates"][0]["name"], "HTTP template");
        assert_eq!(switched["templates"][0]["prompt"], "Edited instructions");
        assert_eq!(switched["templates"][0]["enabled"], true);
        assert_eq!(switched["templates"][1]["enabled"], false);
        assert!(
            get("/v1/prompts/templates").headers().get("etag").is_none(),
            "a markdown listing is not a read of editable global templates"
        );
        let snapshot = get("/v1/configuration");
        assert_eq!(
            snapshot.headers()["x-zeroagent-configuration"],
            "zeroagent.configuration.v1"
        );
        let version = snapshot.headers()["etag"].to_str().unwrap().to_owned();
        let snapshot: Value = snapshot.json().unwrap();
        assert!(
            snapshot.get("settings").is_some()
                && snapshot.get("mcp").is_some()
                && snapshot.get("prompts").is_some()
        );
        let mut mcp = snapshot["mcp"]["settings"].clone();
        mcp["servers"][0]["description"] = json!("Composite HTTP edit");
        let mut templates = snapshot["prompts"]["globalTemplates"].clone();
        templates[0]["prompt"] = json!("Composite instructions");
        let updated = http
            .put(format!("{}/v1/configuration", public.base_url))
            .bearer_auth(&public.token)
            .header("if-match", &version)
            .json(&json!({"mcp":mcp,"templates":templates}))
            .send()
            .unwrap();
        assert_eq!(updated.status(), 200);
        let version = updated.headers()["etag"].to_str().unwrap().to_owned();
        let updated: Value = updated.json().unwrap();
        assert_eq!(
            updated["prompts"]["globalTemplates"][0]["prompt"],
            "Composite instructions"
        );
        let rejected = http
            .put(format!("{}/v1/configuration", public.base_url))
            .bearer_auth(&public.token)
            .header("if-match", version)
            .json(&json!({"nativeChanges":{"memory":{"enabled":false}}}))
            .send()
            .unwrap();
        assert_eq!(
            rejected.status(),
            400,
            "the public Go configuration API cannot update Native preferences"
        );
        assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
        drop(facade);
        manager.shutdown();
    }
}
