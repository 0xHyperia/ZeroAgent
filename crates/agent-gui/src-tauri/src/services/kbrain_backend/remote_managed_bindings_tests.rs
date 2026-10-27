#[test]
#[ignore = "requires an explicit prepared Go backend artifact; account/key requests use an owned local HTTP fixture"]
fn remote_managed_key_registration_keeps_existing_bindings_and_rejects_other_owners() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let account = crate::services::account_session::tests::Fixture::new().await;
        let owner = account.login("a", false).await;
        let live = account.state.profile_liveness(Some(&owner.session_handle)).await.unwrap();
        let state = Arc::new(KBrainBackendState::with_account_sessions(account.state.clone()));
        *state.profile.lock().unwrap() = BackendProfile::from_account_scope(Some(&owner.account_scope)).unwrap();
        state.profile_initialized.store(true, Ordering::SeqCst);
        state.account_bound.store(true, Ordering::SeqCst);
        state.account_live.store(true, Ordering::SeqCst);
        *state.bound_session.lock().unwrap() = Some(owner.session_handle.clone());
        *state.profile_liveness.lock().unwrap() = Some(live);
        let binary = PathBuf::from(std::env::var_os(TEST_BINARY_ENV).expect("explicit prepared Go backend"));
        let root = test_dir();
        let backend_root = root.path().join("account-runtime");
        let start_state = state.clone();
        let connection = tauri::async_runtime::spawn_blocking(move || start_state.ensure_started_with_binary(binary, backend_root)).await.unwrap().unwrap();
        state.ensure_managed_provider_bindings(&["relay-key-11".into()]).await.unwrap();
        let first = state.model_broker.lock().unwrap().as_ref().unwrap().binding("relay-key-11").unwrap().unwrap();
        assert!(state.prepare_provider_models("relay-key-13", serde_json::json!({"type":"codex","api":"openai-responses"})).is_err());
        account.enable_extra_active_key();
        state.ensure_managed_provider_bindings(&["relay-key-13".into()]).await.unwrap();
        let retained = state.model_broker.lock().unwrap().as_ref().unwrap().binding("relay-key-11").unwrap().unwrap();
        assert_eq!(first.api_key, retained.api_key, "a new key must preserve the old capability");
        let discovered = state.prepare_provider_models("relay-key-13", serde_json::json!({"type":"codex","api":"openai-responses"})).unwrap();
        assert!(discovered["apiKey"].as_str().unwrap().starts_with("za-model-"));
        assert!(!serde_json::to_string(&discovered).unwrap().contains("sk-extra-a"));
        let configured = state.prepare_configuration_settings(serde_json::json!({
            "providers":[
                {"id":"relay-key-11","api":"openai-responses","models":[{"id":"old-model"}],"activeModels":["old-model"]},
                {"id":"relay-key-13","api":"openai-responses","models":[{"id":"new-model"}],"activeModels":["new-model"]}
            ],"defaultProvider":"relay-key-13","defaultModel":"new-model"
        })).unwrap();
        let check_connection = connection.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let client = Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().unwrap();
            let response = client.put(format!("{}/v1/settings", check_connection.base_url))
                .bearer_auth(&check_connection.token).json(&configured).send().unwrap();
            assert!(response.status().is_success());
            let saved: serde_json::Value = client.get(format!("{}/v1/settings", check_connection.base_url))
                .bearer_auth(&check_connection.token).send().unwrap().json().unwrap();
            assert_eq!(saved["defaultProvider"], "relay-key-13");
            assert!(saved["providers"].as_array().unwrap().iter().any(|provider| provider["id"] == "relay-key-11"));
            assert!(saved["providers"].as_array().unwrap().iter().any(|provider| provider["id"] == "relay-key-13"));
        }).await.unwrap();
        assert!(state.ensure_managed_provider_bindings(&["relay-key-12".into()]).await.is_err(), "disabled keys must not be registered");
        assert!(state.ensure_managed_provider_bindings(&["relay-key-999".into()]).await.is_err(), "foreign keys must not be registered");
        assert_eq!(state.model_broker.lock().unwrap().as_ref().unwrap().binding("relay-key-11").unwrap().unwrap().api_key, first.api_key);
        let next_owner = account.login("b", false).await;
        assert_ne!(next_owner.session_handle, owner.session_handle);
        assert!(state.ensure_managed_provider_bindings(&["relay-key-21".into()]).await.is_err(), "a retired device profile cannot import the replacement account's key");
        state.shutdown();
    });
}
