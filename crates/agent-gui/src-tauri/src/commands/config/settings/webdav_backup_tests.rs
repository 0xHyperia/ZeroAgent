mod webdav_backup_tests {
    use super::*;
    use axum::{
        extract::{OriginalUri, State},
        http::StatusCode,
        routing::get,
        Router,
    };

    #[derive(Default)]
    struct RemoteFixture {
        files: HashMap<String, (StatusCode, Vec<u8>)>,
        requests: Vec<String>,
    }

    async fn fixture_get(
        State(state): State<Arc<Mutex<RemoteFixture>>>,
        OriginalUri(uri): OriginalUri,
    ) -> (StatusCode, Vec<u8>) {
        let mut state = state.lock().unwrap();
        state.requests.push(uri.path().to_string());
        state
            .files
            .get(uri.path())
            .cloned()
            .unwrap_or((StatusCode::NOT_FOUND, Vec::new()))
    }

    fn remote_document() -> (String, Vec<u8>) {
        let snapshot = BackupSnapshot {
            agents: Some(
                json!([{"id":"fixture","name":"Fixture","prompt":"Backup text","enabled":true}]),
            ),
            ..Default::default()
        };
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest).unwrap();
        let remote = BackupRemoteManifest {
            manifest,
            size: document.len(),
            sha256: backup_sha256_hex(document.as_bytes()),
        };
        (document, serde_json::to_vec(&remote).unwrap())
    }

    #[tokio::test]
    async fn remote_backups_read_only_current_layout_and_verify_reviewed_bytes() {
        let state = Arc::new(Mutex::new(RemoteFixture::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = BackupSyncConfig {
            url: format!("http://{}", listener.local_addr().unwrap()),
            username: "fixture".into(),
            password: "fixture-only".into(),
            ..Default::default()
        };
        let server = Router::new()
            .fallback(get(fixture_get))
            .with_state(state.clone());
        let server_task = tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        let credentials = backup_credentials(&config).unwrap();
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("account-a/settings");
        let (document, manifest) = remote_document();
        let reviewed = backup_import_fingerprint(&target, &backup_sha256_hex(document.as_bytes()));
        let current_manifest = "/zeroagent/v3/default/manifest.json";
        let current_config = "/zeroagent/v3/default/config.json";
        let legacy_manifest = "/zeroagent/v1/default/manifest.json";
        let legacy_config = "/zeroagent/v1/default/config.json";
        {
            let mut state = state.lock().unwrap();
            for path in [current_manifest, legacy_manifest] {
                state
                    .files
                    .insert(path.into(), (StatusCode::OK, manifest.clone()));
            }
            for path in [current_config, legacy_config] {
                state
                    .files
                    .insert(path.into(), (StatusCode::OK, document.as_bytes().to_vec()));
            }
        }
        assert_eq!(
            read_reviewed_remote_backup(&config, &credentials, &target, &reviewed)
                .await
                .unwrap(),
            document
        );
        assert_eq!(
            state.lock().unwrap().requests,
            [current_manifest, current_config]
        );
        {
            let mut state = state.lock().unwrap();
            state.requests.clear();
            state.files.remove(current_manifest);
        }
        assert!(read_backup_remote_manifest(&config, &credentials)
            .await
            .unwrap()
            .is_none());
        assert_eq!(state.lock().unwrap().requests, [current_manifest]);
        for (status, body) in [
            (StatusCode::OK, b"{invalid-manifest-secret".to_vec()),
            (StatusCode::SERVICE_UNAVAILABLE, Vec::new()),
        ] {
            {
                let mut state = state.lock().unwrap();
                state.requests.clear();
                state.files.insert(current_manifest.into(), (status, body));
            }
            let error = read_reviewed_remote_backup(&config, &credentials, &target, &reviewed)
                .await
                .unwrap_err();
            assert!(!error.contains("invalid-manifest-secret"));
            assert_eq!(state.lock().unwrap().requests, [current_manifest]);
        }
        {
            let mut state = state.lock().unwrap();
            state
                .files
                .insert(current_manifest.into(), (StatusCode::OK, manifest));
            state.requests.clear();
        }
        assert!(read_reviewed_remote_backup(
            &config,
            &credentials,
            &root.path().join("account-b/settings"),
            &reviewed
        )
        .await
        .unwrap_err()
        .contains("已变化"));
        assert_eq!(state.lock().unwrap().requests, [current_manifest]);
        let mut changed: Value =
            serde_json::from_slice(&state.lock().unwrap().files[current_manifest].1).unwrap();
        changed["sha256"] = json!(backup_sha256_hex(b"changed remote"));
        {
            let mut state = state.lock().unwrap();
            state.requests.clear();
            state.files.insert(
                current_manifest.into(),
                (StatusCode::OK, serde_json::to_vec(&changed).unwrap()),
            );
        }
        assert!(
            read_reviewed_remote_backup(&config, &credentials, &target, &reviewed)
                .await
                .unwrap_err()
                .contains("已变化")
        );
        assert_eq!(state.lock().unwrap().requests, [current_manifest]);
        let changed_review =
            backup_import_fingerprint(&target, changed["sha256"].as_str().unwrap());
        assert!(
            read_reviewed_remote_backup(&config, &credentials, &target, &changed_review)
                .await
                .unwrap_err()
                .contains("校验和")
        );
        server_task.abort();
        let _ = server_task.await;
    }

    #[test]
    fn an_old_upload_cannot_mark_a_new_destination_as_synced() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let old = BackupSyncConfig {
            url: "https://old.example.test/dav".into(),
            username: "fixture".into(),
            password: "old-password".into(),
            ..Default::default()
        };
        let mut current = old.clone();
        current.url = "https://new.example.test/dav".into();
        current.password = "new-password".into();
        persist_backup_sync_config(&conn, &current).unwrap();
        record_backup_sync_success(&mut conn, &old, Some("old-snapshot".into())).unwrap();
        record_backup_sync_error(&mut conn, &old, "old target is unreachable").unwrap();
        let actual = load_backup_sync_config(&conn).unwrap();
        assert_eq!(actual.url, current.url);
        assert_eq!(actual.password, current.password);
        assert!(actual.last_uploaded_snapshot_hash.is_none());
        assert!(actual.last_sync_at.is_none());
        assert!(actual.last_error.is_none());
        record_backup_sync_error(&mut conn, &current, "current transfer failed").unwrap();
        assert_eq!(
            load_backup_sync_config(&conn)
                .unwrap()
                .last_error
                .as_deref(),
            Some("current transfer failed")
        );
        record_backup_sync_success(&mut conn, &current, Some("new-snapshot".into())).unwrap();
        let actual = load_backup_sync_config(&conn).unwrap();
        assert_eq!(
            actual.last_uploaded_snapshot_hash.as_deref(),
            Some("new-snapshot")
        );
        assert!(actual.last_sync_at.is_some());
        assert!(actual.last_error.is_none());
    }

    #[test]
    fn malformed_remote_digests_cannot_reflect_secrets_through_the_preview() {
        let (_, manifest) = remote_document();
        let manifest: Value = serde_json::from_slice(&manifest).unwrap();
        for bad in [
            json!("private-key-in-hash"),
            json!("a".repeat(63)),
            json!("z".repeat(64)),
            json!({"value":"private-key-in-hash"}),
        ] {
            let mut invalid = manifest.clone();
            invalid["sha256"] = bad;
            let error =
                parse_backup_remote_manifest(&serde_json::to_vec(&invalid).unwrap()).unwrap_err();
            assert!(!error.contains("private-key-in-hash"));
        }
        for size in [0, WEBDAV_CONFIG_MAX_BYTES + 1] {
            let mut invalid = manifest.clone();
            invalid["size"] = json!(size);
            assert!(parse_backup_remote_manifest(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
    }
}
