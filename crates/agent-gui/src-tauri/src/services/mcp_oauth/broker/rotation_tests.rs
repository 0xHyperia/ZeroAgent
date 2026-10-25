fn corrupting_fixture() -> (Fixture, Arc<Mutex<Option<PathBuf>>>, Arc<AtomicUsize>) {
    let path = Arc::new(Mutex::new(None::<PathBuf>));
    let fault = path.clone();
    let grants = Arc::new(AtomicUsize::new(0));
    let count = grants.clone();
    let fixture = Fixture::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        fs::write(
            fault.lock().unwrap().as_ref().unwrap(),
            b"controlled storage fault",
        )
        .unwrap();
    });
    (fixture, path, grants)
}
fn previous_access_hash() -> String {
    Sha256::digest(b"fixture-old-access")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn broker_retries_failed_storage_before_returning_a_rotation_or_consuming_another_grant() {
    let (fixture, fault, grants) = corrupting_fixture();
    let profile = TestProfile::new(&fixture);
    let path = profile.settings.join("mcp-oauth-tokens.json");
    *fault.lock().unwrap() = Some(path.clone());
    profile.seed(fixture.record());
    let before = fs::read(&path).unwrap();
    let host = profile.host(Arc::new(AtomicBool::new(true)));
    let http = client();
    let previous = previous_access_hash();
    for _ in 0..2 {
        let response = request(&http, &host, &profile.target, &previous);
        assert_eq!(response.status().as_u16(), 401);
        let body = response.text().unwrap();
        assert!(!body.contains("fixture-new-access"));
        assert!(!body.contains("fixture-new-refresh"));
    }
    assert_eq!(grants.load(Ordering::SeqCst), 1);
    assert_eq!(host.recovery.retained_count(), 1);
    fs::write(&path, before).unwrap();
    let response = request(&http, &host, &profile.target, &previous);
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.json::<Value>().unwrap()["accessToken"],
        "fixture-new-access"
    );
    assert_eq!(
        profile
            .store
            .snapshot()
            .unwrap()
            .record
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("fixture-new-refresh")
    );
    assert_eq!(grants.load(Ordering::SeqCst), 1);
    assert_eq!(host.recovery.retained_count(), 0);
}

#[test]
fn broker_pending_rotation_does_not_survive_native_clear_or_new_authorization() {
    for clear in [true, false] {
        let (fixture, fault, grants) = corrupting_fixture();
        let profile = TestProfile::new(&fixture);
        let path = profile.settings.join("mcp-oauth-tokens.json");
        *fault.lock().unwrap() = Some(path.clone());
        profile.seed(fixture.record());
        let before = fs::read(&path).unwrap();
        let host = profile.host(Arc::new(AtomicBool::new(true)));
        let http = client();
        let previous = previous_access_hash();
        assert_eq!(
            request(&http, &host, &profile.target, &previous)
                .status()
                .as_u16(),
            401
        );
        fs::write(&path, before).unwrap();
        if clear {
            profile.store.delete().unwrap()
        } else {
            profile.store.begin_authorization().unwrap();
        }
        assert_eq!(
            request(&http, &host, &profile.target, &previous)
                .status()
                .as_u16(),
            401
        );
        assert_eq!(host.recovery.retained_count(), 0);
        assert_eq!(grants.load(Ordering::SeqCst), 1);
        if clear {
            assert!(profile.store.snapshot().unwrap().record.is_none())
        } else {
            let mut newer = fixture.record();
            newer.access_token = "new-authorization-access".into();
            profile.seed(newer);
            assert_eq!(
                request(&http, &host, &profile.target, &previous)
                    .json::<Value>()
                    .unwrap()["accessToken"],
                "new-authorization-access"
            );
            assert_eq!(grants.load(Ordering::SeqCst), 1);
        }
    }
}

#[test]
fn broker_pending_rotation_is_dropped_on_profile_revocation_and_process_exit() {
    for profile_ended in [true, false] {
        let (fixture, fault, grants) = corrupting_fixture();
        let profile = TestProfile::new(&fixture);
        let path = profile.settings.join("mcp-oauth-tokens.json");
        *fault.lock().unwrap() = Some(path.clone());
        profile.seed(fixture.record());
        let live = Arc::new(AtomicBool::new(true));
        let mut host = profile.host(live.clone());
        assert_eq!(
            request(&client(), &host, &profile.target, &previous_access_hash())
                .status()
                .as_u16(),
            401
        );
        assert_eq!(host.recovery.retained_count(), 1);
        if profile_ended {
            live.store(false, Ordering::SeqCst);
            assert_eq!(
                request(&client(), &host, &profile.target, "")
                    .status()
                    .as_u16(),
                401
            )
        } else {
            drop(host.process_guard());
        }
        assert_eq!(host.recovery.retained_count(), 0);
        assert_eq!(grants.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read(&path).unwrap(), b"controlled storage fault");
        host.stop();
    }
}

#[test]
fn broker_pending_rotation_rejects_a_native_mcp_edit_back_to_the_same_target() {
    let (fixture, fault, grants) = corrupting_fixture();
    let profile = TestProfile::new(&fixture);
    let path = profile.settings.join("mcp-oauth-tokens.json");
    *fault.lock().unwrap() = Some(path.clone());
    profile.seed(fixture.record());
    let before = fs::read(&path).unwrap();
    let host = profile.host(Arc::new(AtomicBool::new(true)));
    let http = client();
    assert_eq!(
        request(&http, &host, &profile.target, &previous_access_hash())
            .status()
            .as_u16(),
        401
    );
    fs::write(&path, before).unwrap();
    let coordinator =
        crate::services::configuration_coordinator::ConfigurationCoordinator::for_profile(
            &profile.storage_id,
        )
        .unwrap();
    coordinator.mcp_changed();
    coordinator.mcp_changed();
    assert_eq!(
        request(&http, &host, &profile.target, &previous_access_hash())
            .status()
            .as_u16(),
        401
    );
    assert_eq!(host.recovery.retained_count(), 0);
    assert_eq!(grants.load(Ordering::SeqCst), 1);
    assert_eq!(
        profile
            .store
            .snapshot()
            .unwrap()
            .record
            .unwrap()
            .access_token,
        "fixture-old-access"
    );
}
