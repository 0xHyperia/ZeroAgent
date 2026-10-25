mod native_batch_tests {
    use super::*;

    fn fixture() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        ensure_remote_agent_id(&mut conn).unwrap();
        conn
    }

    fn update(conn: &Connection, changes: Value) -> NativeConfigurationUpdate {
        NativeConfigurationUpdate {
            expected_revision: native_configuration_revision(conn).unwrap(),
            changes,
        }
    }

    #[test]
    fn batch_commits_multiple_domains_and_preserves_untouched_private_rows() {
        let mut conn = fixture();
        save_stt(&mut conn, json!({"provider":"aliyun_dashscope","providers":{"aliyun_dashscope":{
            "id":"aliyun_dashscope","websocketUrl":"wss://example.com/stt","model":"model","apiKey":"private-stt-key"
        }}})).unwrap();
        let command = update(
            &conn,
            json!({"memory":{"enabled":true},"modelFailover":{"enabled":false}}),
        );
        let before = command.expected_revision.clone();
        let result = apply_native_configuration(&mut conn, command, "/fixture").unwrap();
        assert_ne!(result.native_revision, before);
        assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
        assert_eq!(
            load_model_failover(&conn).unwrap().unwrap()["enabled"],
            false
        );
        assert_eq!(
            load_stt_secret(&conn, "aliyun_dashscope", "apiKey").unwrap(),
            "private-stt-key"
        );
    }

    #[test]
    fn ssh_patch_batch_preserves_private_password_and_project_associations() {
        let mut conn = fixture();
        save_ssh(&mut conn, json!({
            "hosts":[{"id":"prod","name":"Before","host":"fixture.example.com","username":"deploy","authType":"password","password":"private-ssh-password"}],
            "projectHostAssociations":{"/repo":["prod"]}
        })).unwrap();
        let public = redact_ssh_settings(load_ssh_or_empty(&conn).unwrap()).unwrap();
        let before = public["hosts"][0].clone();
        let mut after = before.clone();
        after["name"] = json!("After");
        let command = update(
            &conn,
            json!({
                "sshPatch":{"hostChanges":[{"id":"prod","before":before,"after":after}]},
                "memory":{"enabled":true}
            }),
        );
        let result = apply_native_configuration(&mut conn, command, "/fixture").unwrap();
        let public = result.ssh.unwrap();
        assert_eq!(public["hosts"][0]["name"], "After");
        assert!(public["hosts"][0].get("password").is_none());
        assert_eq!(public["hosts"][0]["passwordConfigured"], true);
        assert_eq!(public["projectHostAssociations"]["/repo"], json!(["prod"]));
        assert!(!public.to_string().contains("private-ssh-password"));
        assert_eq!(
            load_ssh_or_empty(&conn).unwrap()["hosts"][0]["password"],
            "private-ssh-password"
        );
        assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
    }

    #[test]
    fn stale_snapshot_and_missing_version_never_mutate_database() {
        let mut conn = fixture();
        let stale = update(&conn, json!({"memory":{"value":"stale"}}));
        save_memory(&mut conn, json!({"value":"other-window"})).unwrap();
        let version = native_configuration_revision(&conn).unwrap();
        assert_eq!(
            apply_native_configuration(&mut conn, stale, "/fixture")
                .err()
                .unwrap(),
            NATIVE_CONFIGURATION_CHANGED
        );
        let missing = NativeConfigurationUpdate {
            expected_revision: String::new(),
            changes: json!({"memory":{}}),
        };
        assert!(apply_native_configuration(&mut conn, missing, "/fixture").is_err());
        assert_eq!(
            load_memory(&conn).unwrap().unwrap()["value"],
            "other-window"
        );
        assert_eq!(native_configuration_revision(&conn).unwrap(), version);
    }

    #[test]
    fn second_connection_write_between_prepare_and_commit_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.sqlite");
        let mut conn = Connection::open(&path).unwrap();
        initialize_schema(&conn).unwrap();
        let command = update(&conn, json!({"memory":{"value":"stale"}}));
        let prepared = prepare_native_configuration(&mut conn, command, "/fixture").unwrap();
        let mut other = Connection::open(&path).unwrap();
        save_memory(&mut other, json!({"value":"private-writer"})).unwrap();
        assert_eq!(
            commit_native_configuration(&mut conn, prepared)
                .err()
                .unwrap(),
            NATIVE_CONFIGURATION_CHANGED
        );
        assert_eq!(
            load_memory(&conn).unwrap().unwrap()["value"],
            "private-writer"
        );
    }

    #[test]
    fn late_sql_failure_rolls_back_all_domains_and_revision() {
        let mut conn = fixture();
        save_memory(&mut conn, json!({"value":"before"})).unwrap();
        let command = update(
            &conn,
            json!({"memory":{"value":"after"},"modelFailover":{"enabled":true}}),
        );
        let before = command.expected_revision.clone();
        let prepared = prepare_native_configuration(&mut conn, command, "/fixture").unwrap();
        conn.execute_batch("CREATE TRIGGER fail_batch BEFORE INSERT ON model_failover_settings BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(commit_native_configuration(&mut conn, prepared).is_err());
        assert_eq!(load_memory(&conn).unwrap().unwrap()["value"], "before");
        assert!(load_model_failover(&conn).unwrap().is_none());
        assert_eq!(native_configuration_revision(&conn).unwrap(), before);
    }

    #[test]
    fn unknown_or_invalid_late_domain_does_not_partially_apply() {
        let mut conn = fixture();
        for changes in [
            json!({"memory":{"value":"after"},"stt":{"provider":"tencent_cloud","providers":{}}}),
            json!({"memory":{"value":"after"},"providers":[]}),
            json!({"sshSecretUpdates":{"host":{"password":"secret"}}}),
        ] {
            let command = update(&conn, changes);
            let before = command.expected_revision.clone();
            assert!(apply_native_configuration(&mut conn, command, "/fixture").is_err());
            assert!(load_memory(&conn).unwrap().is_none());
            assert_eq!(native_configuration_revision(&conn).unwrap(), before);
        }
    }

    #[test]
    fn stt_masked_edit_preserves_secret_and_returns_redacted_new_revision() {
        let mut conn = fixture();
        save_stt(&mut conn,json!({"provider":"aliyun_dashscope","providers":{"aliyun_dashscope":{
            "id":"aliyun_dashscope","websocketUrl":"wss://example.com/stt","model":"model","apiKey":"private-stt-key"
        }}})).unwrap();
        let mut stt = load_stt_redacted(&conn).unwrap().unwrap();
        stt["enabled"] = json!(true);
        stt["nativeConfigurationRevision"] = json!(native_configuration_revision(&conn).unwrap());
        let command = update(&conn, json!({"stt":stt}));
        let result = apply_native_configuration(&mut conn, command, "/fixture").unwrap();
        let public = result.stt.unwrap();
        assert_eq!(public["providers"]["aliyun_dashscope"]["configured"], true);
        assert_eq!(public["providers"]["aliyun_dashscope"]["apiKey"], "");
        assert!(public.get("nativeConfigurationRevision").is_none());
        assert_eq!(
            load_stt_secret(&conn, "aliyun_dashscope", "apiKey").unwrap(),
            "private-stt-key"
        );
    }

    #[test]
    fn revision_is_scoped_persistent_and_ignores_operational_tables() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.sqlite");
        let conn = Connection::open(&path).unwrap();
        initialize_schema(&conn).unwrap();
        let before = native_configuration_revision(&conn).unwrap();
        conn.execute("INSERT INTO backup_sync_settings(config_id,payload_json,updated_at) VALUES('fixture','true',0)",[]).unwrap();
        assert_eq!(native_configuration_revision(&conn).unwrap(), before);
        drop(conn);
        let conn = Connection::open(path).unwrap();
        initialize_schema(&conn).unwrap();
        assert_eq!(native_configuration_revision(&conn).unwrap(), before);
        assert_ne!(native_configuration_revision(&fixture()).unwrap(), before);
    }

    #[test]
    fn private_writers_and_aba_changes_invalidate_earlier_revision() {
        let mut conn = fixture();
        save_memory(&mut conn, json!({"value":"A"})).unwrap();
        let first = native_configuration_revision(&conn).unwrap();
        save_memory(&mut conn, json!({"value":"B"})).unwrap();
        save_memory(&mut conn, json!({"value":"A"})).unwrap();
        assert_ne!(native_configuration_revision(&conn).unwrap(), first);
        let before = native_configuration_revision(&conn).unwrap();
        save_system_with_default_workdir(
            &mut conn,
            json!({"workdir":"/fixture","executionMode":"tools"}),
            "/fixture",
        )
        .unwrap();
        assert_ne!(native_configuration_revision(&conn).unwrap(), before);
    }
}
