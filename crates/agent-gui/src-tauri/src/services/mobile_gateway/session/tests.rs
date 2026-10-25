use super::*;

fn signed_in() -> MobileGatewaySession {
    let mut session = MobileGatewaySession::default();
    session.restore(
        "https://agent.usa0.top".into(),
        "cookie-a".into(),
        Some(1),
        BTreeMap::new(),
    );
    session
}

fn accept(
    session: &mut MobileGatewaySession,
    owner: &RequestOwner,
    path: &str,
    cookie: Option<&str>,
    body: &str,
    cache_key: Option<&str>,
) -> Result<MobileGatewayResponse, String> {
    session.accept_response(
        owner,
        path,
        200,
        BTreeMap::new(),
        &cookie
            .into_iter()
            .map(|value| format!("zeroagent_session={value}; HttpOnly; Secure"))
            .collect::<Vec<_>>(),
        body.into(),
        cache_key,
    )
}

#[test]
fn logout_rejects_late_http_and_multipart_commit_before_any_state_mutation() {
    for cache_key in [Some("GET /api/chats"), None] {
        let mut session = signed_in();
        let old = session.owner().unwrap();
        session.logout();
        assert!(accept(
            &mut session,
            &old,
            "/api/auth/me",
            Some("cookie-a"),
            r#"{"user":{"id":1}}"#,
            cache_key
        )
        .is_err());
        assert!(session.session_id.is_empty());
        assert_eq!(session.user_id, None);
        assert!(session.cache.is_empty());
    }
}

#[test]
fn late_a_data_cannot_poison_b_cache_or_restore_a_cookie() {
    let mut session = signed_in();
    let a = session.owner().unwrap();
    session.logout();
    let login = session.owner().unwrap();
    accept(
        &mut session,
        &login,
        "/api/auth/login",
        Some("cookie-b"),
        r#"{"user":{"id":2}}"#,
        None,
    )
    .unwrap();
    let b = session.owner().unwrap();
    accept(
        &mut session,
        &b,
        "/api/chats",
        None,
        "B private history",
        Some("GET /api/chats"),
    )
    .unwrap();
    assert!(accept(
        &mut session,
        &a,
        "/api/chats",
        None,
        "A private history",
        Some("GET /api/chats")
    )
    .is_err());
    assert!(accept(
        &mut session,
        &a,
        "/api/auth/me",
        Some("cookie-a"),
        r#"{"user":{"id":1}}"#,
        None
    )
    .is_err());
    assert_eq!(session.session_id, "cookie-b");
    assert_eq!(session.user_id, Some(2));
    assert_eq!(
        session.cached(&b, "GET /api/chats").unwrap().unwrap().body,
        "B private history"
    );
    // This is also the transport-error fallback: it must not read the new owner's cache.
    assert!(session.cached(&a, "GET /api/chats").is_err());
}

#[test]
fn cookie_or_authenticated_user_rotation_invalidates_all_pending_owners() {
    for (cookie, body) in [
        (Some("cookie-rotated"), r#"{"user":{"id":1}}"#),
        (None, r#"{"user":{"id":2}}"#),
    ] {
        let mut session = signed_in();
        let old = session.owner().unwrap();
        accept(&mut session, &old, "/api/auth/me", cookie, body, None).unwrap();
        assert!(!old.is_live());
        assert!(session.require_owner(&old).is_err());
        assert!(session.owner().unwrap().is_live());
    }
}

#[test]
fn cookies_are_native_only_for_fresh_cached_restored_and_directly_serialized_responses() {
    let headers = BTreeMap::from([
        (
            "Set-Cookie".into(),
            "zeroagent_session=secret; HttpOnly".into(),
        ),
        ("sEt-CoOkIe2".into(), "second-secret".into()),
        ("content-type".into(), "application/json".into()),
    ]);
    let legacy = MobileGatewayResponse {
        status: 200,
        headers: headers.clone(),
        body: "{}".into(),
        cached: false,
    };
    let json = serde_json::to_string(&legacy).unwrap();
    assert!(!json.contains("secret"));
    assert!(json.contains("content-type"));
    let mut session = signed_in();
    let owner = session.owner().unwrap();
    let response = session
        .accept_response(
            &owner,
            "/api/chats",
            200,
            headers.clone(),
            &[],
            "{}".into(),
            Some("GET /api/chats"),
        )
        .unwrap();
    assert_eq!(response.headers.len(), 1);
    assert_eq!(
        session
            .cached(&owner, "GET /api/chats")
            .unwrap()
            .unwrap()
            .headers
            .len(),
        1
    );
    session.restore(
        "https://agent.usa0.top".into(),
        "cookie-a".into(),
        Some(1),
        BTreeMap::from([("GET /api/chats".into(), legacy)]),
    );
    let owner = session.owner().unwrap();
    assert_eq!(
        session
            .cached(&owner, "GET /api/chats")
            .unwrap()
            .unwrap()
            .headers
            .len(),
        1
    );
}

#[test]
fn native_cookie_capture_still_works_without_exposing_the_header() {
    let mut session = signed_in();
    let owner = session.owner().unwrap();
    let result = session
        .accept_response(
            &owner,
            "/api/auth/me",
            200,
            BTreeMap::from([(
                "set-cookie".into(),
                "zeroagent_session=rotated; HttpOnly".into(),
            )]),
            &["zeroagent_session=rotated; HttpOnly".into()],
            r#"{"user":{"id":1}}"#.into(),
            None,
        )
        .unwrap();
    assert_eq!(session.session_id, "rotated");
    assert!(result.headers.is_empty());
    assert!(!serde_json::to_string(&result).unwrap().contains("rotated"));
}

#[test]
fn a_late_socket_handshake_cannot_register_after_logout_or_new_login() {
    let mut session = signed_in();
    let owner = session.owner().unwrap();
    let mut sockets = SocketRegistry::default();
    session.logout();
    assert!(sockets
        .insert(&session, owner.clone(), "wire".into(), "old")
        .is_err());
    let login = session.owner().unwrap();
    accept(
        &mut session,
        &login,
        "/api/auth/login",
        Some("cookie-b"),
        r#"{"user":{"id":2}}"#,
        None,
    )
    .unwrap();
    assert!(sockets
        .insert(&session, owner, "wire".into(), "old")
        .is_err());
}

#[test]
fn socket_send_and_events_require_current_owner_and_connection_instance() {
    let mut session = signed_in();
    let owner = session.owner().unwrap();
    let mut sockets = SocketRegistry::default();
    let (old, _) = sockets
        .insert(&session, owner.clone(), "same-id".into(), "first")
        .unwrap();
    let (new, previous) = sockets
        .insert(&session, owner, "same-id".into(), "second")
        .unwrap();
    assert_eq!(previous, Some("first"));
    assert!(!sockets.is_current(&session, "same-id", old));
    assert!(sockets.is_current(&session, "same-id", new));
    assert!(sockets.remove_current("same-id", old).is_none());
    assert_eq!(*sockets.get(&session, "same-id").unwrap(), "second");
    session.logout();
    assert!(!sockets.is_current(&session, "same-id", new));
    assert!(sockets.get(&session, "same-id").is_err());
}

#[tokio::test]
async fn logout_cancels_a_relay_even_while_its_write_is_blocked() {
    let mut session = signed_in();
    let owner = session.owner().unwrap();
    let (_cancel, cancelled) = oneshot::channel();
    let (started, ready) = oneshot::channel();
    let task = tokio::spawn(run_owned(owner, cancelled, async move {
        started.send(()).unwrap();
        std::future::pending::<()>().await;
    }));
    ready.await.unwrap();
    session.logout();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn replacing_or_closing_a_socket_cancels_its_blocked_relay() {
    let session = signed_in();
    let (cancel, cancelled) = oneshot::channel();
    let (started, ready) = oneshot::channel();
    let task = tokio::spawn(run_owned(session.owner().unwrap(), cancelled, async move {
        started.send(()).unwrap();
        std::future::pending::<()>().await;
    }));
    ready.await.unwrap();
    cancel.send(()).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn invalidated_owner_does_not_begin_network_work() {
    let mut session = signed_in();
    let owner = session.owner().unwrap();
    session.logout();
    let (_cancel, cancelled) = oneshot::channel();
    let result = run_owned(owner, cancelled, async {
        panic!("retired owner started relay")
    })
    .await;
    assert!(result.is_none());
}
