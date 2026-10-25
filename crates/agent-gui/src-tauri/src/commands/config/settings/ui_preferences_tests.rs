mod ui_preferences_tests {
    use super::*;

    fn update(conn: &Connection, changes: Value) -> UiPreferencesUpdate {
        UiPreferencesUpdate {
            expected_revision: load_ui_preferences(conn).unwrap().ui_revision,
            changes,
        }
    }

    #[test]
    fn ui_preferences_survive_reopen_and_do_not_advance_configuration_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.sqlite");
        let conn = Connection::open(&path).unwrap();
        initialize_schema(&conn).unwrap();
        let native_before = native_configuration_revision(&conn).unwrap();
        let ui_before = load_ui_preferences(&conn).unwrap().ui_revision;
        apply_ui_preferences(
            &conn,
            update(&conn, json!({"theme":"dark","locale":"zh-CN"})),
        )
        .unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        initialize_schema(&conn).unwrap();
        let current = load_ui_preferences(&conn).unwrap();
        assert_ne!(ui_before, current.ui_revision);
        assert_eq!(current.ui_preferences.unwrap()["theme"], "dark");
        assert_eq!(native_before, native_configuration_revision(&conn).unwrap());
        let isolated = Connection::open_in_memory().unwrap();
        initialize_schema(&isolated).unwrap();
        assert!(load_ui_preferences(&isolated)
            .unwrap()
            .ui_preferences
            .is_none());
        assert_ne!(
            current.ui_revision,
            load_ui_preferences(&isolated).unwrap().ui_revision
        );
    }

    #[test]
    fn stale_ui_writer_and_backend_fields_are_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let stale = update(&conn, json!({"theme":"light"}));
        apply_ui_preferences(&conn, update(&conn, json!({"theme":"dark"}))).unwrap();
        assert_eq!(
            apply_ui_preferences(&conn, stale).err().unwrap(),
            UI_PREFERENCES_CHANGED
        );
        for invalid in [
            json!({"selectedModel":{"model":"archived"}}),
            json!({"remote":{}}),
            json!({"theme":"invalid"}),
            json!({"customSettings":[]}),
            json!({"closeWindowBehavior":"quit"}),
        ] {
            assert!(apply_ui_preferences(&conn, update(&conn, invalid)).is_err());
        }
        assert_eq!(
            load_ui_preferences(&conn).unwrap().ui_preferences.unwrap()["theme"],
            "dark"
        );
    }

    #[test]
    fn mixed_commit_checks_ui_writers_after_prepare_and_rolls_back_every_domain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.sqlite");
        let mut conn = Connection::open(&path).unwrap();
        initialize_schema(&conn).unwrap();
        let native_before = native_configuration_revision(&conn).unwrap();
        let mixed = NativeConfigurationUpdate {
            expected_revision: native_before.clone(),
            changes: json!({
                "memory":{"enabled":true}, "uiPreferences":{
                    "expectedRevision":load_ui_preferences(&conn).unwrap().ui_revision,"changes":{"theme":"light"}}
            }),
        };
        let prepared = prepare_native_configuration(&mut conn, mixed, "/fixture").unwrap();
        let other = Connection::open(&path).unwrap();
        apply_ui_preferences(&other, update(&other, json!({"theme":"dark"}))).unwrap();
        assert_eq!(
            commit_native_configuration(&mut conn, prepared)
                .err()
                .unwrap(),
            UI_PREFERENCES_CHANGED
        );
        assert!(load_memory(&conn).unwrap().is_none());
        assert_eq!(native_before, native_configuration_revision(&conn).unwrap());
        assert_eq!(
            load_ui_preferences(&conn).unwrap().ui_preferences.unwrap()["theme"],
            "dark"
        );

        let mixed = NativeConfigurationUpdate {
            expected_revision: native_before,
            changes: json!({
                "memory":{"enabled":true}, "uiPreferences":{
                    "expectedRevision":load_ui_preferences(&conn).unwrap().ui_revision,"changes":{"theme":"light"}}
            }),
        };
        let prepared = prepare_native_configuration(&mut conn, mixed, "/fixture").unwrap();
        conn.execute_batch("CREATE TRIGGER fail_ui BEFORE INSERT ON native_ui_preferences BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(commit_native_configuration(&mut conn, prepared).is_err());
        assert!(load_memory(&conn).unwrap().is_none());
        assert_eq!(
            load_ui_preferences(&conn).unwrap().ui_preferences.unwrap()["theme"],
            "dark"
        );
    }

    #[test]
    fn mixed_ui_and_native_update_returns_both_committed_versions() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        let native_before = native_configuration_revision(&conn).unwrap();
        let ui_before = load_ui_preferences(&conn).unwrap().ui_revision;
        let mixed = NativeConfigurationUpdate {
            expected_revision: native_before.clone(),
            changes: json!({
                "memory":{"enabled":true},"uiPreferences":{"expectedRevision":ui_before,"changes":{"theme":"dark"}}
            }),
        };
        let saved = apply_native_configuration(&mut conn, mixed, "/fixture").unwrap();
        assert_ne!(saved.native_revision, native_before);
        assert_ne!(saved.ui_revision.unwrap(), ui_before);
        assert_eq!(saved.ui_preferences.unwrap()["theme"], "dark");
        assert_eq!(load_memory(&conn).unwrap().unwrap()["enabled"], true);
    }
}
