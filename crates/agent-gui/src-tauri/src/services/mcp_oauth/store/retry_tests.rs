#[test]
fn failed_save_issues_a_locked_revision_proof_bound_to_the_exact_rotated_record() {
    let root = tempfile::tempdir().unwrap();
    let store = TokenStore::for_profile(root.path().to_owned(), "server", true).unwrap();
    let old = sample_record();
    store.save(&old, &store.snapshot().unwrap()).unwrap();
    let baseline = store.snapshot().unwrap();
    let path = root.path().join(FILE_STORE_NAME);
    let before = fs::read(&path).unwrap();
    fs::write(&path, b"damaged fixture").unwrap();
    let mut next = old;
    next.access_token = "rotated-access".into();
    next.refresh_token = Some("rotated-refresh".into());
    let failure = store.save_refresh(&next, &baseline).unwrap_err();
    assert_eq!(failure.stage, SaveStage::NotWritten);
    let proof = failure.retry.unwrap();
    assert!(proof.is_current());
    let foreign_root = tempfile::tempdir().unwrap();
    let foreign = TokenStore::for_profile(foreign_root.path().to_owned(), "server", true).unwrap();
    assert!(foreign
        .retry_refresh(&next, &proof)
        .unwrap_err()
        .retry
        .is_none());
    let different_storage =
        TokenStore::for_profile(root.path().to_owned(), "server", false).unwrap();
    assert!(different_storage
        .retry_refresh(&next, &proof)
        .unwrap_err()
        .retry
        .is_none());
    let mut other = next.clone();
    other.access_token = "unrelated-record".into();
    let rejected = store.retry_refresh(&other, &proof).unwrap_err();
    assert!(rejected.retry.is_none());
    assert!(proof.is_current());
    fs::write(&path, before).unwrap();
    assert_eq!(store.retry_refresh(&next, &proof).unwrap(), "file");
    assert!(!proof.is_current());
    assert_eq!(store.snapshot().unwrap().record, Some(next));
}

#[test]
fn failed_save_proof_distinguishes_vault_cleanup_and_ambiguous_write_failures() {
    for vault_acknowledged in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let store = TokenStore::for_profile(root.path().to_owned(), "server", true).unwrap();
        let old = sample_record();
        store.save(&old, &store.snapshot().unwrap()).unwrap();
        let baseline = store.snapshot().unwrap();
        let path = root.path().join(FILE_STORE_NAME);
        let before = fs::read(&path).unwrap();
        let mut next = old;
        next.access_token = "partially-saved-rotation".into();
        let vault = Mutex::new(None);
        let failure = store
            .save_checked(&next, baseline.revision, &baseline.identity, || {
                // The OS API boundary is deterministic here; file operations, CAS,
                // cleanup and retry are the actual production implementation.
                *vault.lock().unwrap() = Some(next.clone());
                fs::remove_file(&path).unwrap();
                fs::create_dir(&path).unwrap();
                if vault_acknowledged {
                    Ok(())
                } else {
                    Err("ambiguous vault write".into())
                }
            })
            .unwrap_err();
        assert_eq!(
            failure.stage,
            if vault_acknowledged {
                SaveStage::VaultWritten
            } else {
                SaveStage::PossiblyWritten
            }
        );
        let proof = failure.retry.unwrap();
        assert!(proof.is_current());
        let (readable, storage) = store
            .load_uncached(Ok(vault.lock().unwrap().clone()))
            .unwrap();
        assert_eq!(storage, "keychain");
        assert_eq!(readable, Some(next.clone()));
        // Repair only this test's empty fault directory, never a user path.
        fs::remove_dir(&path).unwrap();
        fs::write(&path, before).unwrap();
        assert_eq!(
            store.retry_checked(&next, &proof, || Ok(())).unwrap(),
            "keychain"
        );
        assert!(!path.exists());
        assert_eq!(store.snapshot().unwrap().record, Some(next));
    }
}

#[test]
fn superseded_save_never_mints_a_retry_permission_for_some_later_revision() {
    let root = tempfile::tempdir().unwrap();
    let store = TokenStore::for_profile(root.path().to_owned(), "server", true).unwrap();
    let stale = store.snapshot().unwrap();
    let mut newer = sample_record();
    newer.access_token = "new-authorization".into();
    store.save(&newer, &stale).unwrap();
    let rejected = store.save_refresh(&sample_record(), &stale).unwrap_err();
    assert!(rejected.retry.is_none());
    assert_eq!(rejected.message, "MCP_OAUTH_OPERATION_SUPERSEDED");
    assert_eq!(store.snapshot().unwrap().record, Some(newer));
}
