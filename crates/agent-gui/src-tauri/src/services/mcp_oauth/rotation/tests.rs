use super::*;
use crate::services::mcp_oauth::scoped_tests::Fixture;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};

fn seed(root: &std::path::Path, fixture: &Fixture, expired: bool) -> TokenStore {
    let store = TokenStore::for_profile(root.to_owned(), "same-server", true).unwrap();
    let mut record = fixture.record();
    record.target_binding = Some("bound-target".into());
    if !expired {
        record.expires_at_ms = super::super::store::now_ms() + 3_600_000;
    }
    store.save(&record, &store.snapshot().unwrap()).unwrap();
    store
}
fn old_hash() -> String {
    Sha256::digest(b"fixture-old-access")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn call(
    recovery: &RotationRecovery,
    store: &TokenStore,
    fixture: &Fixture,
    previous: &str,
) -> Result<TokenRecord, String> {
    recovery.credential(
        store,
        &fixture.target().url,
        "bound-target",
        7,
        previous,
        &|| Ok(()),
    )
}

#[test]
fn retained_rotation_retries_storage_before_another_grant_and_owns_the_store_revision() {
    for proactive in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mcp-oauth-tokens.json");
        let broken = path.clone();
        let grants = Arc::new(AtomicUsize::new(0));
        let count = grants.clone();
        let fixture = Fixture::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            fs::write(&broken, b"damaged fixture file").unwrap();
        });
        let store = seed(root.path(), &fixture, proactive);
        let before = fs::read(&path).unwrap();
        let recovery = RotationRecovery::new();
        let previous = if proactive { String::new() } else { old_hash() };
        assert_eq!(
            call(&recovery, &store, &fixture, &previous).unwrap_err(),
            SAVE_PENDING
        );
        assert!(store.snapshot().is_err());
        assert_eq!(
            call(&recovery, &store, &fixture, &previous).unwrap_err(),
            SAVE_PENDING
        );
        assert_eq!(grants.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read(&path).unwrap(), b"damaged fixture file");
        // All ordinary call handles can disappear. The retained proof must keep
        // the original revision state alive instead of resetting a Weak entry.
        drop(store);
        fs::write(&path, &before).unwrap();
        let store = TokenStore::for_profile(root.path().to_owned(), "same-server", true).unwrap();
        let fresh = call(&recovery, &store, &fixture, &previous).unwrap();
        assert_eq!(fresh.access_token, "fixture-new-access");
        assert_eq!(fresh.refresh_token.as_deref(), Some("fixture-new-refresh"));
        assert_eq!(store.snapshot().unwrap().record, Some(fresh.clone()));
        assert_eq!(call(&recovery, &store, &fixture, &previous).unwrap(), fresh);
        assert_eq!(grants.load(Ordering::SeqCst), 1);
        assert!(recovery.state.lock().unwrap().slots.is_empty());
    }
}

#[test]
fn retained_rotation_is_superseded_by_clear_new_authorization_or_a_new_saved_record() {
    for action in ["clear", "authorize", "replace"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mcp-oauth-tokens.json");
        let broken = path.clone();
        let grants = Arc::new(AtomicUsize::new(0));
        let count = grants.clone();
        let fixture = Fixture::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            fs::write(&broken, b"broken").unwrap();
        });
        let store = seed(root.path(), &fixture, true);
        let before = fs::read(&path).unwrap();
        let recovery = RotationRecovery::new();
        assert_eq!(
            call(&recovery, &store, &fixture, "").unwrap_err(),
            SAVE_PENDING
        );
        fs::write(&path, before).unwrap();
        match action {
            "clear" => store.delete().unwrap(),
            "authorize" => {
                store.begin_authorization().unwrap();
            }
            _ => {
                let baseline = store.snapshot().unwrap();
                let mut newer = baseline.record.as_ref().unwrap().clone();
                newer.access_token = "new-authorization".into();
                store.save(&newer, &baseline).unwrap();
            }
        }
        let after = store.snapshot().unwrap().record;
        assert_eq!(
            call(&recovery, &store, &fixture, "").unwrap_err(),
            "MCP_OAUTH_OPERATION_SUPERSEDED"
        );
        assert_eq!(store.snapshot().unwrap().record, after);
        assert_eq!(grants.load(Ordering::SeqCst), 1);
        assert!(recovery.state.lock().unwrap().slots.is_empty());
    }
}

#[test]
fn retained_rotation_cannot_resume_after_target_operation_or_runtime_revocation() {
    for action in ["target", "operation", "runtime", "owner"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mcp-oauth-tokens.json");
        let broken = path.clone();
        let fixture = Fixture::new(move || fs::write(&broken, b"broken").unwrap());
        let store = seed(root.path(), &fixture, true);
        let before = fs::read(&path).unwrap();
        let recovery = RotationRecovery::new();
        assert_eq!(
            call(&recovery, &store, &fixture, "").unwrap_err(),
            SAVE_PENDING
        );
        fs::write(&path, before).unwrap();
        if action == "runtime" {
            recovery.revoke();
        }
        let result = recovery.credential(
            &store,
            &fixture.target().url,
            if action == "target" {
                "other-target"
            } else {
                "bound-target"
            },
            if action == "operation" { 8 } else { 7 },
            "",
            &|| {
                if action == "owner" {
                    Err(AUTH_REQUIRED_MARKER.into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(
            store.snapshot().unwrap().record.unwrap().access_token,
            "fixture-old-access"
        );
        assert!(recovery.state.lock().unwrap().slots.is_empty());
    }
}

#[test]
fn retained_rotation_capacity_rejects_before_consuming_a_grant() {
    for entry_limit in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let grants = Arc::new(AtomicUsize::new(0));
        let count = grants.clone();
        let fixture = Fixture::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let store = seed(root.path(), &fixture, true);
        let mut recovery = RotationRecovery::new();
        if entry_limit {
            recovery.max_entries = 0
        } else {
            recovery.max_bytes = 1
        };
        assert_eq!(call(&recovery, &store, &fixture, "").unwrap_err(), CAPACITY);
        assert_eq!(grants.load(Ordering::SeqCst), 0);
        assert_eq!(
            store.snapshot().unwrap().record.unwrap().access_token,
            "fixture-old-access"
        );
    }
}

#[test]
fn retained_rotation_waiting_requests_reuse_one_saved_rotation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mcp-oauth-tokens.json");
    let broken = path.clone();
    let grants = Arc::new(AtomicUsize::new(0));
    let count = grants.clone();
    let fixture = Fixture::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        fs::write(&broken, b"broken").unwrap();
    });
    let store = seed(root.path(), &fixture, true);
    let before = fs::read(&path).unwrap();
    let recovery = RotationRecovery::new();
    assert_eq!(
        call(&recovery, &store, &fixture, "").unwrap_err(),
        SAVE_PENDING
    );
    fs::write(&path, before).unwrap();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let run = || {
            barrier.wait();
            call(&recovery, &store, &fixture, "").unwrap().access_token
        };
        let a = scope.spawn(run);
        let b = scope.spawn(run);
        assert_eq!(a.join().unwrap(), "fixture-new-access");
        assert_eq!(b.join().unwrap(), "fixture-new-access");
    });
    assert_eq!(grants.load(Ordering::SeqCst), 1);
}

#[test]
fn retained_rotation_revocation_during_a_real_grant_never_commits_it() {
    for revoke_runtime in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let live = Arc::new(AtomicBool::new(true));
        let ended = live.clone();
        let recovery = Arc::new(RotationRecovery::new());
        let ending = recovery.clone();
        let fixture = Fixture::new(move || {
            if revoke_runtime {
                ending.revoke()
            } else {
                ended.store(false, Ordering::SeqCst)
            }
        });
        let store = seed(root.path(), &fixture, true);
        let before = store.snapshot().unwrap().record;
        assert!(recovery
            .credential(
                &store,
                &fixture.target().url,
                "bound-target",
                7,
                "",
                &|| if live.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(AUTH_REQUIRED_MARKER.into())
                }
            )
            .is_err());
        assert_eq!(store.snapshot().unwrap().record, before);
        assert!(recovery.state.lock().unwrap().slots.is_empty());
    }
}

#[test]
fn retained_rotation_finishes_a_pending_save_even_when_the_fresh_record_is_already_readable() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mcp-oauth-tokens.json");
    let broken = path.clone();
    let grants = Arc::new(AtomicUsize::new(0));
    let count = grants.clone();
    let fixture = Fixture::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        fs::write(&broken, b"broken").unwrap();
    });
    let store = seed(root.path(), &fixture, true);
    let recovery = RotationRecovery::new();
    assert_eq!(
        call(&recovery, &store, &fixture, "").unwrap_err(),
        SAVE_PENDING
    );
    let fresh = recovery
        .state
        .lock()
        .unwrap()
        .slots
        .get(store.identity())
        .unwrap()
        .pending
        .as_ref()
        .unwrap()
        .record
        .clone();
    fs::write(
        &path,
        serde_json::to_vec(&HashMap::from([("same-server", &fresh)])).unwrap(),
    )
    .unwrap();
    let readable = store.snapshot().unwrap();
    assert_eq!(readable.record, Some(fresh.clone()));
    assert_eq!(call(&recovery, &store, &fixture, "").unwrap(), fresh);
    // A no-op return of the readable record would leave this old snapshot valid.
    assert!(store.save(&fresh, &readable).is_err());
    assert_eq!(grants.load(Ordering::SeqCst), 1);
}

#[test]
fn retained_rotation_does_not_evict_an_earlier_failed_grant_to_admit_another_server() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mcp-oauth-tokens.json");
    let broken = path.clone();
    let grants = Arc::new(AtomicUsize::new(0));
    let count = grants.clone();
    let fixture = Fixture::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        fs::write(&broken, b"broken").unwrap();
    });
    let store = seed(root.path(), &fixture, true);
    let before = fs::read(&path).unwrap();
    let mut recovery = RotationRecovery::new();
    recovery.max_entries = 1;
    assert_eq!(
        call(&recovery, &store, &fixture, "").unwrap_err(),
        SAVE_PENDING
    );
    fs::write(&path, before).unwrap();
    let other = TokenStore::for_profile(root.path().to_owned(), "another-server", true).unwrap();
    let mut other_record = fixture.record();
    other_record.target_binding = Some("bound-target".into());
    other
        .save(&other_record, &other.snapshot().unwrap())
        .unwrap();
    assert_eq!(call(&recovery, &other, &fixture, "").unwrap_err(), CAPACITY);
    assert_eq!(grants.load(Ordering::SeqCst), 1);
    assert_eq!(recovery.retained_count(), 1);
    assert_eq!(
        call(&recovery, &store, &fixture, "").unwrap().access_token,
        "fixture-new-access"
    );
    assert_eq!(other.snapshot().unwrap().record, Some(other_record));
    assert_eq!(grants.load(Ordering::SeqCst), 1);
}

#[test]
fn retained_rotation_revocation_does_not_wait_for_a_blocked_version_check() {
    let root = tempfile::tempdir().unwrap();
    let fixture = Fixture::new(|| {});
    let store = seed(root.path(), &fixture, true);
    let baseline = store.snapshot().unwrap();
    let mut fresh = baseline.record.as_ref().unwrap().clone();
    fresh.access_token = "rotated-before-storage-failure".into();
    fs::write(root.path().join("mcp-oauth-tokens.json"), b"broken").unwrap();
    let mut retry = store
        .save_refresh(&fresh, &baseline)
        .unwrap_err()
        .retry
        .unwrap();
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let checking = entered.clone();
    let waiting = release.clone();
    retry.set_check_hook(Arc::new(move || {
        checking.wait();
        waiting.wait();
    }));
    let recovery = Arc::new(RotationRecovery::new());
    let retaining = recovery.clone();
    let identity = store.identity().to_owned();
    std::thread::scope(|scope| {
        let pending = scope.spawn(move || {
            retaining
                .reserve(
                    &identity,
                    Stamp {
                        revision: 7,
                        digest: "bound-target".into(),
                    },
                    &fresh,
                )
                .unwrap()
                .retain(fresh, retry)
        });
        entered.wait();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let ending = recovery.clone();
        let revoking = scope.spawn(move || {
            ending.revoke();
            done_tx.send(()).unwrap();
        });
        let completed = done_rx.recv_timeout(std::time::Duration::from_secs(1));
        // Release and join even when the bounded assertion fails, so the test
        // reports the regression without leaving blocked threads behind.
        release.wait();
        let result = pending.join().unwrap();
        revoking.join().unwrap();
        assert!(
            completed.is_ok(),
            "host revocation waited for a profile version check"
        );
        assert!(result.is_err());
    });
    assert_eq!(recovery.retained_count(), 0);
}
