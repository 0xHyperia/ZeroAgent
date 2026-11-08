use super::*;
use crate::services::mcp_oauth::{scoped_tests::Fixture, store::TokenRecord};
use std::{fs, sync::atomic::AtomicUsize};
include!("rotation_tests.rs");
include!("retired_extensions_tests.rs");

struct TestProfile {
    _root: tempfile::TempDir,
    backend: PathBuf,
    settings: PathBuf,
    storage_id: String,
    target: Value,
    store: TokenStore,
    digest: String,
}
impl TestProfile {
    fn new(fixture: &Fixture) -> Self {
        let root = tempfile::tempdir().unwrap();
        let backend = root.path().join("backend");
        let settings = root.path().join("settings");
        let storage_id = format!("fixture-profile-{}", uuid::Uuid::new_v4());
        fs::create_dir_all(&backend).unwrap();
        fs::create_dir_all(&settings).unwrap();
        let server = fixture.target();
        let target = json!({"id":server.id,"url":server.url,"transport":"http","scope":server.scope_override,"clientId":server.static_client_id,
            "credentialRef":"private-host-ref","headers":{}});
        let config = json!({"servers":[{"id":server.id,"url":server.url,"transport":"http","enabled":true,
            "auth":{"type":"oauth","scope":server.scope_override,"clientId":server.static_client_id,"credentialRef":"private-host-ref"}}]});
        fs::write(
            backend.join("config.json.live-mcp.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let (_, digest) = crate::commands::settings::verify_mcp_credential_target_file(
            &backend,
            &storage_id,
            &target,
        )
        .unwrap();
        let store = TokenStore::for_profile(settings.clone(), &server.id, true).unwrap();
        Self {
            _root: root,
            backend,
            settings,
            storage_id,
            target,
            store,
            digest,
        }
    }
    fn seed(&self, mut record: TokenRecord) {
        record.target_binding = Some(self.digest.clone());
        record.expires_at_ms = super::super::store::now_ms() + 3_600_000;
        self.store
            .save(&record, &self.store.snapshot().unwrap())
            .unwrap();
    }
    fn host(&self, live: Arc<AtomicBool>) -> NativeCredentialBroker {
        NativeCredentialBroker::start(
            self.backend.clone(),
            self.settings.clone(),
            self.storage_id.clone(),
            live,
            true,
            #[cfg(desktop)]
            None,
        )
        .unwrap()
    }
}
fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}
fn request(
    client: &reqwest::blocking::Client,
    host: &NativeCredentialBroker,
    target: &Value,
    previous: &str,
) -> reqwest::blocking::Response {
    client
        .post(host.endpoint())
        .bearer_auth(host.capability())
        .json(&json!({"protocol":PROTOCOL,"target":target,"previousTokenHash":previous}))
        .send()
        .unwrap()
}

#[test]
fn broker_requires_distinct_capability_and_bound_private_target_without_gate_reentry() {
    let fixture = Fixture::new(|| {});
    let profile = TestProfile::new(&fixture);
    profile.seed(fixture.record());
    let live = Arc::new(AtomicBool::new(true));
    let mut host = profile.host(live.clone());
    let http = client();
    for authorization in [None, Some("za-backend-is-not-a-host-capability")] {
        let mut sent = http
            .post(host.endpoint())
            .json(&json!({"protocol":PROTOCOL,"target":profile.target}));
        if let Some(token) = authorization {
            sent = sent.bearer_auth(token);
        }
        let denied = sent.send().unwrap();
        assert_eq!(denied.status().as_u16(), 401);
        assert!(!denied.text().unwrap().contains("fixture-old-access"));
    }
    assert_eq!(
        http.post(host.endpoint())
            .bearer_auth(host.capability())
            .header("origin", "https://untrusted.invalid")
            .json(&json!({"protocol":PROTOCOL,"target":profile.target}))
            .send()
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    let coordinator =
        crate::services::configuration_coordinator::ConfigurationCoordinator::for_profile(
            &profile.storage_id,
        )
        .unwrap();
    let _configuration_guard = coordinator.blocking_lock();
    let allowed: Value = request(&http, &host, &profile.target, "").json().unwrap();
    assert_eq!(allowed["accessToken"], "fixture-old-access");
    drop(_configuration_guard);
    let mut wrong = profile.target.clone();
    wrong["credentialRef"] = json!("another-private-ref");
    assert_eq!(request(&http, &host, &wrong, "").status().as_u16(), 401);
    let mut unbound = fixture.record();
    unbound.target_binding = None;
    profile
        .store
        .save(&unbound, &profile.store.snapshot().unwrap())
        .unwrap();
    assert_eq!(
        request(&http, &host, &profile.target, "").status().as_u16(),
        401
    );
    let mut foreign = fixture.record();
    foreign.target_binding = Some(
        crate::commands::settings::verify_mcp_credential_target_file(
            &profile.backend,
            "other-profile",
            &profile.target,
        )
        .unwrap()
        .1,
    );
    profile
        .store
        .save(&foreign, &profile.store.snapshot().unwrap())
        .unwrap();
    assert_eq!(
        request(&http, &host, &profile.target, "").status().as_u16(),
        401
    );
    profile.seed(fixture.record());
    live.store(false, Ordering::SeqCst);
    assert_eq!(
        request(&http, &host, &profile.target, "").status().as_u16(),
        401
    );
    host.stop();
}

#[test]
fn broker_process_guard_revokes_listener_without_manager_polling() {
    let fixture = Fixture::new(|| {});
    let profile = TestProfile::new(&fixture);
    profile.seed(fixture.record());
    let host = profile.host(Arc::new(AtomicBool::new(true)));
    let guard = host.process_guard();
    let http = client();
    assert_eq!(
        request(&http, &host, &profile.target, "").status().as_u16(),
        200
    );
    drop(guard);
    assert!(!host.running.load(Ordering::SeqCst));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match http
            .post(host.endpoint())
            .bearer_auth(host.capability())
            .json(&json!({"protocol":PROTOCOL,"target":profile.target}))
            .send()
        {
            Err(_) => break,
            Ok(response) => assert!(!response.status().is_success()),
        }
        assert!(
            std::time::Instant::now() < deadline,
            "revoked listener did not close"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn broker_401_digest_refreshes_once_and_parallel_stale_requests_reuse_rotated_token() {
    let grants = Arc::new(AtomicUsize::new(0));
    let count = grants.clone();
    let fixture = Fixture::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    });
    let profile = TestProfile::new(&fixture);
    profile.seed(fixture.record());
    let host = profile.host(Arc::new(AtomicBool::new(true)));
    let http = client();
    let previous = Sha256::digest(b"fixture-old-access")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let run = || {
            barrier.wait();
            let response = request(&http, &host, &profile.target, &previous);
            assert_eq!(response.status().as_u16(), 200);
            response.json::<Value>().unwrap()
        };
        let first = scope.spawn(run);
        let second = scope.spawn(run);
        assert_eq!(first.join().unwrap()["accessToken"], "fixture-new-access");
        assert_eq!(second.join().unwrap()["accessToken"], "fixture-new-access");
    });
    assert_eq!(grants.load(Ordering::SeqCst), 1);
    assert_eq!(
        request(&http, &host, &profile.target, &previous)
            .status()
            .as_u16(),
        200
    );
    assert_eq!(grants.load(Ordering::SeqCst), 1);
    profile.store.delete().unwrap();
    assert_eq!(
        request(&http, &host, &profile.target, "").status().as_u16(),
        401
    );
}

#[test]
fn broker_owner_revoked_during_refresh_cannot_persist_or_return_rotated_credentials() {
    let live = Arc::new(AtomicBool::new(true));
    let ended = live.clone();
    let fixture = Fixture::new(move || {
        ended.store(false, Ordering::SeqCst);
    });
    let profile = TestProfile::new(&fixture);
    profile.seed(fixture.record());
    let before = profile.store.snapshot().unwrap().record;
    let host = profile.host(live);
    let previous = Sha256::digest(b"fixture-old-access")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let denied = request(&client(), &host, &profile.target, &previous);
    assert_eq!(denied.status().as_u16(), 401);
    let body = denied.text().unwrap();
    assert!(!body.contains("fixture-new-access"));
    assert!(!body.contains("fixture-new-refresh"));
    assert_eq!(profile.store.snapshot().unwrap().record, before);
}
