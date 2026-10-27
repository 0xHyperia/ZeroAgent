use super::*;
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    response::{IntoResponse, Response},
    Router,
};
use std::sync::{
    atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering},
    Mutex as StdMutex,
};
use tokio::sync::{oneshot, Notify};

#[derive(Default)]
struct MemoryStore {
    data: StdMutex<Option<String>>,
    writes: StdMutex<Vec<Option<String>>>,
    fail_save: AtomicBool,
    fail_clear: AtomicBool,
}
impl SessionStore for MemoryStore {
    fn load(&self) -> Result<Option<String>, String> {
        Ok(self.data.lock().unwrap().clone())
    }
    fn save(&self, value: &str) -> Result<(), String> {
        if self.fail_save.load(Ordering::SeqCst) {
            return Err("fixture vault save failed".into());
        }
        *self.data.lock().unwrap() = Some(value.into());
        self.writes.lock().unwrap().push(Some(value.into()));
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        if self.fail_clear.load(Ordering::SeqCst) {
            return Err("fixture vault clear failed".into());
        }
        *self.data.lock().unwrap() = None;
        self.writes.lock().unwrap().push(None);
        Ok(())
    }
}

#[derive(Default)]
struct HttpState {
    calls: StdMutex<Vec<(String, String, String)>>,
    refresh_count: AtomicUsize,
    key_status: AtomicU16,
    extra_active_key: AtomicBool,
    password_mode: AtomicU16,
    password_gate: StdMutex<Option<oneshot::Receiver<()>>>,
    password_started: Notify,
    me_status: AtomicU16,
    refresh_status: AtomicU16,
    cross_account_refresh: AtomicBool,
    invalid_exchange_scope: AtomicBool,
    reject_reused_refresh: AtomicBool,
    used_refresh: StdMutex<std::collections::HashSet<String>>,
    refresh_gate: StdMutex<Option<oneshot::Receiver<()>>>,
    refresh_started: Notify,
    me_gate: StdMutex<Option<oneshot::Receiver<()>>>,
    me_started: Notify,
}

async fn serve(State(state): State<Arc<HttpState>>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let authorization = request
        .headers()
        .get("authorization")
        .and_then(|x| x.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = to_bytes(request.into_body(), 16 * 1024).await.unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    state
        .calls
        .lock()
        .unwrap()
        .push((path.clone(), authorization.clone(), body.clone()));
    let json_response = |status: u16, value: Value| {
        (StatusCode::from_u16(status).unwrap(), axum::Json(value)).into_response()
    };
    if path.ends_with("/me") {
        let gate = { state.me_gate.lock().unwrap().take() };
        if let Some(gate) = gate {
            state.me_started.notify_one();
            let _ = gate.await;
        }
        let status = state.me_status.load(Ordering::SeqCst);
        if status != 200 {
            return json_response(
                status,
                json!({"error":"private server diagnostic access-a refresh-a"}),
            );
        }
        let token = authorization.strip_prefix("Bearer ").unwrap_or("");
        let id = if token.ends_with("-b") { 8 } else { 7 };
        let data = json!({"id":id,"status":"active","email":format!("user{id}@example.test"),"username":token,"access_token":token,"refresh_token":"private-reflection","balance":{"raw":token},"email_bound":{"raw":token}});
        return if path.contains("/app/") {
            json_response(200, json!({"success":true,"data":data}))
        } else {
            json_response(200, json!({"code":0,"data":data}))
        };
    }
    if path.ends_with("/keys") {
        let status = state.key_status.load(Ordering::SeqCst);
        if status != 200 {
            return json_response(status, json!({"error":"access-a refresh-a"}));
        }
        let owner = if authorization.ends_with("-b") {
            "b"
        } else {
            "a"
        };
        let id = if owner == "b" { 21 } else { 11 };
        let row = json!({"id":id,"key":format!("sk-managed-{owner}"),"name":format!("access-{owner} sk-managed-{owner}"),"status":"active","group_id":3,"group":{"name":format!("sk-inactive-{owner}")}});
        let data = if body.is_empty() {
            let mut items = vec![
                row,
                json!({"id":id+1,"key":format!("sk-inactive-{owner}"),"name":"Archived","status":"disabled","group_id":3}),
            ];
            if state.extra_active_key.load(Ordering::SeqCst) {
                items.push(json!({"id":id+2,"key":format!("sk-extra-{owner}"),"name":"New key","status":"active","group_id":3}));
            }
            json!({"total":items.len(),"items":items})
        } else {
            json!({"id":id+2,"key":format!("sk-created-{owner}"),"name":"Created","status":"active","group_id":3,"group":{"name":format!("sk-created-{owner}")},"raw_alias":format!("sk-created-{owner}")})
        };
        return if path.contains("/app/") {
            json_response(200, json!({"success":true,"data":data}))
        } else {
            json_response(200, json!({"code":0,"data":data}))
        };
    }
    if path.ends_with("/auth/login") {
        let gate = { state.password_gate.lock().unwrap().take() };
        state.password_started.notify_one();
        if let Some(gate) = gate {
            let _ = gate.await;
        }
        let mode = state.password_mode.load(Ordering::SeqCst);
        if mode == 1 {
            return json_response(401, json!({"message":"sk-managed-a"}));
        }
        let data = match mode {
            2 => {
                json!({"access_token":"temporary-password-token","refresh_token":"temporary-refresh","user":{"id":8}})
            }
            3 => json!({"requires_2fa":true,"temp_token":"temporary-challenge"}),
            4 => json!({"requires_2fa":true,"temp_token":""}),
            _ => {
                json!({"access_token":"temporary-password-token","refresh_token":"temporary-refresh","user":{"id":7}})
            }
        };
        return json_response(200, json!({"code":0,"data":data}));
    }
    if path.ends_with("/usage") {
        return json_response(
            200,
            json!({"success":true,"data":{"alias":"prefix sk-managed-a suffix","inactive":"sk-inactive-a","access-a":"refresh-a"}}),
        );
    }
    if path.ends_with("/token") || path.ends_with("/refresh") {
        let refresh_number = state.refresh_count.fetch_add(1, Ordering::SeqCst) + 1;
        let gate = { state.refresh_gate.lock().unwrap().take() };
        state.refresh_started.notify_one();
        if let Some(gate) = gate {
            let _ = gate.await;
        }
        let status = state.refresh_status.load(Ordering::SeqCst);
        if status != 200 {
            return json_response(
                status,
                json!({"error":"private server diagnostic access-a refresh-a"}),
            );
        }
        if state.reject_reused_refresh.load(Ordering::SeqCst) {
            let token = if path.ends_with("/refresh") {
                serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|value| value["refresh_token"].as_str().map(str::to_string))
            } else {
                url::form_urlencoded::parse(body.as_bytes())
                    .find(|(key, _)| key == "refresh_token")
                    .map(|(_, value)| value.into_owned())
            };
            if let Some(token) = token {
                if !state.used_refresh.lock().unwrap().insert(token) {
                    return json_response(401, json!({"error":"refresh already consumed"}));
                }
            }
        }
        let user_b = state.cross_account_refresh.load(Ordering::SeqCst)
            || body.contains("refresh-b")
            || body.contains("code=code-b");
        let name = if user_b { "b" } else { "a" };
        let mut data = json!({"access_token":format!("renewed-{name}"),"refresh_token":format!("rotated-refresh-{name}"),"expires_in":600,"token_type":"Bearer","scope":"profile:read offline_access"});
        if state.reject_reused_refresh.load(Ordering::SeqCst) && refresh_number > 1 {
            data["access_token"] = json!(format!("renewed-{refresh_number}-{name}"));
            data["refresh_token"] = json!(format!("rotated-{refresh_number}-refresh-{name}"));
        }
        if state.invalid_exchange_scope.load(Ordering::SeqCst) {
            data["scope"] = json!("keys:read");
        }
        return if path.ends_with("/refresh") {
            json_response(200, json!({"code":0,"data":data}))
        } else {
            json_response(200, data)
        };
    }
    if path.ends_with("/revoke") || path.ends_with("/logout") {
        return json_response(200, json!({}));
    }
    (StatusCode::NOT_FOUND, Body::empty()).into_response()
}

pub(crate) struct Fixture {
    pub(crate) state: Arc<AccountSessionState>,
    http: Arc<HttpState>,
    store: Arc<MemoryStore>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub(crate) fn enable_extra_active_key(&self) {
        self.http.extra_active_key.store(true, Ordering::SeqCst);
    }

    pub(crate) async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let http = Arc::new(HttpState::default());
        http.me_status.store(200, Ordering::SeqCst);
        http.key_status.store(200, Ordering::SeqCst);
        http.refresh_status.store(200, Ordering::SeqCst);
        let router = Router::new().fallback(serve).with_state(http.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let store = Arc::new(MemoryStore::default());
        let state = Arc::new(AccountSessionState::with_store(origin, store.clone()).unwrap());
        Self {
            state,
            http,
            store,
            server,
        }
    }
    pub(crate) async fn login(&self, user: &str, expired: bool) -> AccountSessionSummary {
        self.login_kind(user, expired, AuthKind::Oauth).await
    }
    async fn login_kind(&self, user: &str, expired: bool, kind: AuthKind) -> AccountSessionSummary {
        let ticket = self.state.begin_authorization().await;
        let mut credentials = tokens(user, expired);
        credentials.auth_kind = kind;
        self.state.install(ticket, credentials).await.unwrap()
    }
    fn seed_restore(&self, kind: AuthKind) {
        let mut credentials = tokens("a", true);
        credentials.auth_kind = kind;
        let record = StoredSession {
            version: 1,
            origin: self.state.origin.origin().ascii_serialization(),
            user_id: 7,
            tokens: credentials,
        };
        *self.store.data.lock().unwrap() = Some(serde_json::to_string(&record).unwrap());
    }
    fn revoked(&self) -> Vec<String> {
        self.http
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(path, _, body)| {
                if path.ends_with("/revoke") {
                    url::form_urlencoded::parse(body.as_bytes())
                        .find(|(key, _)| key == "token")
                        .map(|(_, value)| value.into_owned())
                } else if path.ends_with("/logout") {
                    serde_json::from_str::<Value>(body)
                        .ok()
                        .and_then(|value| value["refresh_token"].as_str().map(str::to_string))
                } else {
                    None
                }
            })
            .collect()
    }
    fn persisted(&self) -> Option<String> {
        self.store.data.lock().unwrap().clone()
    }
    fn gate_refresh(&self) -> oneshot::Sender<()> {
        let (tx, rx) = oneshot::channel();
        *self.http.refresh_gate.lock().unwrap() = Some(rx);
        tx
    }
    fn gate_me(&self) -> oneshot::Sender<()> {
        let (tx, rx) = oneshot::channel();
        *self.http.me_gate.lock().unwrap() = Some(rx);
        tx
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
fn tokens(user: &str, expired: bool) -> StoredTokens {
    StoredTokens {
        access_token: format!("access-{user}"),
        refresh_token: Some(format!("refresh-{user}")),
        expires_at_ms: if expired { 1 } else { now_ms() + 3_600_000 },
        auth_kind: AuthKind::Oauth,
    }
}

#[test]
fn development_vault_is_separate_from_installed_product() {
    let origin =
        configured_origin(option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top"))
            .unwrap();
    let target = vault_account(&origin).unwrap();
    if cfg!(debug_assertions) {
        assert!(target.starts_with(&format!(
            "{}|development:",
            origin.origin().ascii_serialization()
        )));
        assert_ne!(target, origin.origin().ascii_serialization());
    } else {
        assert_eq!(target, origin.origin().ascii_serialization());
    }
    // Constructing the production service does not read or modify the vault.
    AccountSessionState::new().unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn windows_vault_round_trip_uses_a_unique_fixture_entry_and_removes_it() {
    let store = PlatformStore {
        account: format!("fixture-{}", uuid::Uuid::new_v4()),
    };
    struct Cleanup<'a>(&'a PlatformStore);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.clear();
        }
    }
    let _cleanup = Cleanup(&store);
    assert!(store.load().unwrap().is_none());
    store.save("fixture-only-opaque-credentials").unwrap();
    assert_eq!(
        store.load().unwrap().as_deref(),
        Some("fixture-only-opaque-credentials")
    );
    store.clear().unwrap();
    assert!(store.load().unwrap().is_none());
}

#[tokio::test]
async fn obsolete_code_exchange_is_revoked_before_the_new_exchange_starts() {
    let fixture = Fixture::new().await;
    let release = fixture.gate_refresh();
    let old_ticket = fixture.state.begin_authorization().await;
    let state = fixture.state.clone();
    let old = tokio::spawn(async move {
        state
            .exchange_authorization_code(
                old_ticket,
                "code-a",
                "http://127.0.0.1:12345/oauth/callback",
                &"v".repeat(64),
            )
            .await
    });
    fixture.http.refresh_started.notified().await;
    let new_ticket = fixture.state.begin_authorization().await;
    let state = fixture.state.clone();
    let new = tokio::spawn(async move {
        state
            .exchange_authorization_code(
                new_ticket,
                "code-b",
                "http://127.0.0.1:12345/oauth/callback",
                &"v".repeat(64),
            )
            .await
    });
    assert!(fixture.state.exchange.try_lock().is_err());
    release.send(()).unwrap();
    assert_eq!(old.await.unwrap().err().unwrap(), SESSION_CHANGED);
    let public = new.await.unwrap().unwrap();
    assert_eq!(public.user["id"], 8);
    let calls = fixture.http.calls.lock().unwrap();
    let revoke = calls
        .iter()
        .position(|call| call.0.ends_with("/revoke") && call.2.contains("token=renewed-a"))
        .unwrap();
    let exchange = calls
        .iter()
        .position(|call| call.0.ends_with("/token") && call.2.contains("code=code-b"))
        .unwrap();
    assert!(revoke < exchange);
    let form: std::collections::HashMap<_, _> =
        url::form_urlencoded::parse(calls[exchange].2.as_bytes())
            .into_owned()
            .collect();
    assert_eq!(form.get("client_id").unwrap(), CLIENT_ID);
    assert_eq!(
        form.get("redirect_uri").unwrap(),
        "http://127.0.0.1:12345/oauth/callback"
    );
    assert_eq!(form.get("code_verifier").unwrap(), &"v".repeat(64));
    assert!(fixture.persisted().unwrap().contains("renewed-b"));
}

#[tokio::test]
async fn exchange_rejects_unowned_redirects_verifiers_and_superseded_requests_before_http() {
    let fixture = Fixture::new().await;
    let ticket = fixture.state.begin_authorization().await;
    for (redirect, verifier) in [
        ("https://other.invalid/oauth/callback", "v".repeat(64)),
        ("http://127.0.0.1/oauth/callback", "v".repeat(64)),
        ("http://127.0.0.1:12345/other", "v".repeat(64)),
        ("http://127.0.0.1:12345/oauth/callback", "short".into()),
    ] {
        assert_eq!(
            fixture
                .state
                .exchange_authorization_code(ticket, "code", redirect, &verifier)
                .await
                .err()
                .unwrap(),
            RESPONSE_ERROR
        );
    }
    fixture.state.begin_authorization().await;
    assert_eq!(
        fixture
            .state
            .exchange_authorization_code(
                ticket,
                "code",
                "http://127.0.0.1:12345/oauth/callback",
                &"v".repeat(64)
            )
            .await
            .err()
            .unwrap(),
        SESSION_CHANGED
    );
    assert!(fixture.http.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ended_events_identify_only_the_obsolete_handle() {
    let fixture = Fixture::new().await;
    let old = fixture.login("a", false).await;
    let mut events = fixture.state.subscribe_ended();
    let current = fixture.login("b", false).await;
    assert_eq!(events.recv().await.unwrap().handle, old.session_handle);
    assert!(!fixture
        .state
        .clear_if_current(&old.session_handle)
        .await
        .unwrap());
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    fixture.state.logout(&current.session_handle).await.unwrap();
    assert_eq!(events.recv().await.unwrap().handle, current.session_handle);
}

#[tokio::test]
async fn installation_returns_an_opaque_summary_and_only_vault_receives_credentials() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    assert_eq!(public.user["id"], 7);
    assert_eq!(public.user["username"], "Protected value");
    assert!(public.account_scope.ends_with("|user:7"));
    assert!(public.session_handle.starts_with("za-session-"));
    let serialized = serde_json::to_string(&public).unwrap();
    for secret in [
        "access-a",
        "refresh-a",
        "private-reflection",
        "access_token",
        "refresh_token",
    ] {
        assert!(!serialized.contains(secret));
    }
    let persisted = fixture.persisted().unwrap();
    assert!(persisted.contains("access-a") && persisted.contains("refresh-a"));
    assert!(!persisted.contains("session_handle") && !persisted.contains("user7@example.test"));
    assert_eq!(
        fixture
            .state
            .verified_current(&public.session_handle)
            .await
            .unwrap()
            .session_handle,
        public.session_handle
    );
    assert!(fixture
        .state
        .require_current("forged-handle")
        .await
        .is_err());
}

#[tokio::test]
async fn late_authorization_cannot_replace_the_more_recent_account() {
    let fixture = Fixture::new().await;
    let release = fixture.gate_me();
    let old_ticket = fixture.state.begin_authorization().await;
    let state = fixture.state.clone();
    let old = tokio::spawn(async move { state.install(old_ticket, tokens("a", false)).await });
    fixture.http.me_started.notified().await;
    let current = fixture.login("b", false).await;
    release.send(()).unwrap();
    assert_eq!(old.await.unwrap().err().unwrap(), SESSION_CHANGED);
    assert!(fixture
        .state
        .require_current(&current.session_handle)
        .await
        .is_ok());
    assert!(fixture.persisted().unwrap().contains("access-b"));
    assert!(!fixture.persisted().unwrap().contains("access-a"));
}

#[tokio::test]
async fn concurrent_expired_consumers_share_one_refresh_and_keep_the_handle() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", true).await;
    let release = fixture.gate_refresh();
    let state = fixture.state.clone();
    let handle = public.session_handle.clone();
    let consumers = tokio::spawn(async move {
        tokio::join!(state.access(&handle, false), state.access(&handle, false))
    });
    fixture.http.refresh_started.notified().await;
    release.send(()).unwrap();
    let (first, second) = consumers.await.unwrap();
    assert_eq!(first.unwrap().access_token, "renewed-a");
    assert_eq!(second.unwrap().access_token, "renewed-a");
    assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .state
            .snapshot(&public.session_handle)
            .await
            .unwrap()
            .public
            .session_handle,
        public.session_handle
    );
    let saved = fixture.persisted().unwrap();
    assert!(saved.contains("rotated-refresh-a") && !saved.contains("access-a"));
    let calls = fixture.http.calls.lock().unwrap();
    let refresh = calls
        .iter()
        .find(|call| call.0.ends_with("/token"))
        .unwrap();
    let form: std::collections::HashMap<_, _> = url::form_urlencoded::parse(refresh.2.as_bytes())
        .into_owned()
        .collect();
    assert_eq!(form.get("client_id").unwrap(), CLIENT_ID);
    assert_eq!(form.get("refresh_token").unwrap(), "refresh-a");
    assert!(refresh.1.is_empty());
}

#[tokio::test]
async fn logout_during_refresh_cannot_be_undone_by_the_late_token_response() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", true).await;
    let release = fixture.gate_refresh();
    let state = fixture.state.clone();
    let handle = public.session_handle.clone();
    let old = tokio::spawn(async move { state.access(&handle, false).await });
    fixture.http.refresh_started.notified().await;
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.state.logout(&public.session_handle),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(fixture.persisted().is_none());
    release.send(()).unwrap();
    assert_eq!(old.await.unwrap().err().unwrap(), SESSION_CHANGED);
    assert!(fixture.persisted().is_none());
    assert!(fixture.state.bootstrap().await.unwrap().is_none());
    assert!(fixture
        .http
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| call.0.ends_with("/revoke")));
}

#[tokio::test]
async fn old_refresh_and_old_logout_cannot_overwrite_or_remove_account_b() {
    for failed_refresh in [false, true] {
        let fixture = Fixture::new().await;
        let old = fixture.login("a", true).await;
        let release = fixture.gate_refresh();
        if failed_refresh {
            fixture.http.refresh_status.store(401, Ordering::SeqCst);
        }
        let state = fixture.state.clone();
        let handle = old.session_handle.clone();
        let refresh = tokio::spawn(async move { state.access(&handle, false).await });
        fixture.http.refresh_started.notified().await;
        let new = fixture.login("b", false).await;
        let before = fixture.persisted();
        release.send(()).unwrap();
        assert!(refresh.await.unwrap().is_err());
        assert!(!fixture
            .state
            .clear_if_current(&old.session_handle)
            .await
            .unwrap());
        assert!(fixture.state.logout(&old.session_handle).await.is_err());
        assert_eq!(fixture.persisted(), before);
        assert!(fixture
            .state
            .require_current(&new.session_handle)
            .await
            .is_ok());
    }
}

#[tokio::test]
async fn transient_refresh_failure_preserves_session_but_rejection_clears_it() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", true).await;
    let before = fixture.persisted();
    fixture.http.refresh_status.store(503, Ordering::SeqCst);
    assert_eq!(
        fixture
            .state
            .access(&public.session_handle, false)
            .await
            .err()
            .unwrap(),
        TRANSPORT_ERROR
    );
    assert_eq!(fixture.persisted(), before);
    assert!(fixture
        .state
        .require_current(&public.session_handle)
        .await
        .is_ok());
    fixture.http.refresh_status.store(401, Ordering::SeqCst);
    assert_eq!(
        fixture
            .state
            .access(&public.session_handle, false)
            .await
            .err()
            .unwrap(),
        AUTH_REQUIRED
    );
    assert!(fixture
        .state
        .require_current(&public.session_handle)
        .await
        .is_err());
    assert!(fixture.persisted().is_none());
    assert!(fixture.state.bootstrap().await.unwrap().is_none());
}

#[tokio::test]
async fn refresh_must_preserve_the_verified_account_before_persisting_new_tokens() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", true).await;
    fixture
        .http
        .cross_account_refresh
        .store(true, Ordering::SeqCst);
    let error = fixture
        .state
        .access(&public.session_handle, false)
        .await
        .err()
        .unwrap();
    assert_eq!(error, "USA-Zero refreshed session account mismatch");
    assert!(fixture.persisted().is_none());
    assert!(fixture
        .state
        .require_current(&public.session_handle)
        .await
        .is_err());
    assert!(!fixture
        .store
        .writes
        .lock()
        .unwrap()
        .iter()
        .flatten()
        .any(|record| record.contains("renewed-b")));
}

#[tokio::test]
async fn persisted_session_restoration_is_verified_and_single_flight() {
    let fixture = Fixture::new().await;
    let record = StoredSession {
        version: 1,
        origin: fixture.state.origin.origin().ascii_serialization(),
        user_id: 7,
        tokens: tokens("a", true),
    };
    *fixture.store.data.lock().unwrap() = Some(serde_json::to_string(&record).unwrap());
    let first = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(fixture.state.bootstrap(), fixture.state.bootstrap())
    })
    .await
    .unwrap();
    let a = first.0.unwrap().unwrap();
    let b = first.1.unwrap().unwrap();
    assert_eq!(a.session_handle, b.session_handle);
    assert_eq!(a.user["id"], 7);
    assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
    let resumed =
        AccountSessionState::with_store(fixture.state.origin.clone(), fixture.store.clone())
            .unwrap();
    let public = resumed.bootstrap().await.unwrap().unwrap();
    assert_ne!(public.session_handle, a.session_handle);
    assert_eq!(public.account_scope, a.account_scope);
}

#[tokio::test]
async fn restoration_network_errors_preserve_vault_and_never_select_an_offline_session() {
    let fixture = Fixture::new().await;
    let record = StoredSession {
        version: 1,
        origin: fixture.state.origin.origin().ascii_serialization(),
        user_id: 7,
        tokens: tokens("a", false),
    };
    *fixture.store.data.lock().unwrap() = Some(serde_json::to_string(&record).unwrap());
    let before = fixture.persisted();
    fixture.http.me_status.store(503, Ordering::SeqCst);
    assert_eq!(
        fixture.state.bootstrap().await.err().unwrap(),
        TRANSPORT_ERROR
    );
    assert_eq!(fixture.persisted(), before);
    assert!(fixture.state.core.lock().await.session.is_none());
    fixture.http.me_status.store(200, Ordering::SeqCst);
    assert_eq!(
        fixture.state.bootstrap().await.unwrap().unwrap().user["id"],
        7
    );
}

#[tokio::test]
async fn failed_vault_save_keeps_current_account_and_failed_clear_stays_signed_out_in_process() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    let before = fixture.persisted();
    fixture.store.fail_save.store(true, Ordering::SeqCst);
    let ticket = fixture.state.begin_authorization().await;
    assert_eq!(
        fixture
            .state
            .install(ticket, tokens("b", false))
            .await
            .err()
            .unwrap(),
        "fixture vault save failed"
    );
    assert_eq!(fixture.persisted(), before);
    assert!(fixture
        .state
        .require_current(&public.session_handle)
        .await
        .is_ok());
    fixture.store.fail_clear.store(true, Ordering::SeqCst);
    assert_eq!(
        fixture
            .state
            .logout(&public.session_handle)
            .await
            .err()
            .unwrap(),
        "fixture vault clear failed"
    );
    assert!(fixture
        .state
        .require_current(&public.session_handle)
        .await
        .is_err());
    assert!(fixture.state.bootstrap().await.is_err());
    fixture.store.fail_clear.store(false, Ordering::SeqCst);
    fixture.state.logout(&public.session_handle).await.unwrap();
    assert!(fixture.state.bootstrap().await.unwrap().is_none());
    assert!(fixture.persisted().is_none());
    assert!(fixture
        .http
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| call.0.ends_with("/revoke")));
}

fn api_request(
    handle: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> api::AccountHttpRequest {
    api::AccountHttpRequest {
        session_handle: handle.map(str::to_string),
        method: method.into(),
        path: path.into(),
        body,
    }
}

#[tokio::test]
async fn account_api_lists_and_creates_only_masked_keys_and_scrubs_reflected_secrets() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    let handle = &public.session_handle;
    let summary = fixture.state.public_summary(handle).await.unwrap();
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains("access-a"));
    let listed = fixture
        .state
        .http(api_request(Some(handle), "GET", "/api/v1/app/keys", None))
        .await
        .unwrap();
    assert_eq!(listed.body["data"]["items"][0]["key"], "••••••••");
    assert_eq!(listed.body["data"]["items"][0]["key_masked"], true);
    let created = fixture
        .state
        .http(api_request(
            Some(handle),
            "POST",
            "/api/v1/app/groups/3/keys",
            Some(json!({"name":"Created"})),
        ))
        .await
        .unwrap();
    assert_eq!(created.body["data"]["id"], 13);
    assert_eq!(created.body["data"]["key"], "••••••••");
    let usage = fixture
        .state
        .http(api_request(Some(handle), "GET", "/api/v1/app/usage", None))
        .await
        .unwrap();
    for response in [listed, created, usage] {
        let serialized = serde_json::to_string(&response).unwrap();
        for secret in [
            "access-a",
            "refresh-a",
            "sk-managed-a",
            "sk-inactive-a",
            "sk-created-a",
        ] {
            assert!(!serialized.contains(secret));
        }
    }
    let calls = fixture.http.calls.lock().unwrap();
    assert!(calls
        .iter()
        .filter(|(p, _, _)| p.ends_with("/keys") || p.ends_with("/usage"))
        .all(|(_, auth, _)| auth == "Bearer access-a"));
}

#[tokio::test]
async fn account_api_rejects_auth_export_foreign_and_encoded_routes_before_transport() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    let before = fixture.http.calls.lock().unwrap().len();
    for path in [
        "https://foreign.test/api/v1/app/keys",
        "//foreign.test/api/v1/app/keys",
        "/api/v1/app/%6beys",
        "/api/v1/app/../keys",
        "/api/v1/keys/11/reveal",
        "/api/v1/auth/login",
        "/api/v1/secrets",
        "/api/v1/backup",
    ] {
        assert!(
            fixture
                .state
                .http(api_request(Some(&public.session_handle), "GET", path, None))
                .await
                .is_err(),
            "{path}"
        );
    }
    assert!(fixture
        .state
        .http(api_request(
            None,
            "POST",
            "/api/v1/auth/login",
            Some(json!({"email":"user7@example.test","password":"anything"}))
        ))
        .await
        .is_err());
    assert_eq!(fixture.http.calls.lock().unwrap().len(), before);
}

#[tokio::test]
async fn managed_credentials_are_owned_active_and_never_accepted_as_raw_frontend_values() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    let credentials = fixture
        .state
        .managed_credentials(&public.session_handle, vec!["relay-key-11".into()])
        .await
        .unwrap();
    assert_eq!(credentials[0].api_key, "sk-managed-a");
    for ids in [
        vec!["relay-key-21"],
        vec!["relay-key-12"],
        vec!["relay-key-011"],
        vec!["relay-key-11", "relay-key-11"],
        vec!["sk-managed-a"],
    ] {
        assert!(fixture
            .state
            .managed_credentials(
                &public.session_handle,
                ids.into_iter().map(str::to_string).collect()
            )
            .await
            .is_err());
    }
}

#[tokio::test]
async fn key_reveal_requires_native_password_proof_without_replacing_the_oauth_session() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    let before = fixture.persisted();
    for mode in 0..=4 {
        fixture.http.password_mode.store(mode, Ordering::SeqCst);
        let result = fixture
            .state
            .reveal_key(&public.session_handle, 11, " fixture-password ")
            .await;
        if mode == 0 || mode == 3 {
            assert_eq!(result.unwrap(), "sk-managed-a");
        } else {
            assert!(result.is_err());
        }
        assert_eq!(fixture.persisted(), before);
        fixture
            .state
            .require_current(&public.session_handle)
            .await
            .unwrap();
    }
    assert!(fixture
        .state
        .reveal_key(&public.session_handle, 21, "fixture-password")
        .await
        .is_err());
    let calls = fixture.http.calls.lock().unwrap();
    let logins = calls
        .iter()
        .filter(|(path, _, _)| path.ends_with("/auth/login"))
        .collect::<Vec<_>>();
    assert_eq!(logins.len(), 5);
    for (_, auth, body) in logins {
        assert!(auth.is_empty());
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({"email":"user7@example.test","password":" fixture-password "})
        );
    }
}

#[tokio::test]
async fn a_password_response_cannot_reveal_keys_after_the_account_changes() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    let (release, gate) = oneshot::channel();
    *fixture.http.password_gate.lock().unwrap() = Some(gate);
    let state = fixture.state.clone();
    let handle = public.session_handle.clone();
    let reveal =
        tokio::spawn(async move { state.reveal_key(&handle, 11, "fixture-password").await });
    fixture.http.password_started.notified().await;
    let new = fixture.login("b", false).await;
    release.send(()).unwrap();
    assert!(reveal.await.unwrap().is_err());
    fixture
        .state
        .require_current(&new.session_handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn account_key_scope_rejection_revokes_native_access_instead_of_exposing_unmasked_data() {
    let fixture = Fixture::new().await;
    let public = fixture.login("a", false).await;
    fixture.http.key_status.store(403, Ordering::SeqCst);
    assert_eq!(
        fixture
            .state
            .public_summary(&public.session_handle)
            .await
            .err()
            .unwrap(),
        AUTH_REQUIRED
    );
    assert!(fixture.persisted().is_none());
    assert!(fixture
        .state
        .require_current(&public.session_handle)
        .await
        .is_err());
}

#[tokio::test]
async fn profile_startup_leases_are_invalidated_synchronously_before_logout_or_switch_events() {
    let fixture = Fixture::new().await;
    let offline = fixture.state.profile_liveness(None).await.unwrap();
    let a = fixture.login("a", false).await;
    assert!(!offline.load(Ordering::SeqCst));
    assert!(fixture.state.profile_liveness(None).await.is_err());
    let live_a = fixture
        .state
        .profile_liveness(Some(&a.session_handle))
        .await
        .unwrap();
    let b = fixture.login("b", false).await;
    assert!(!live_a.load(Ordering::SeqCst));
    let live_b = fixture
        .state
        .profile_liveness(Some(&b.session_handle))
        .await
        .unwrap();
    fixture.store.fail_clear.store(true, Ordering::SeqCst);
    assert!(fixture.state.logout(&b.session_handle).await.is_err());
    assert!(!live_b.load(Ordering::SeqCst));
    assert!(fixture.state.profile_liveness(None).await.is_err());
    fixture.store.fail_clear.store(false, Ordering::SeqCst);
    fixture.state.logout(&b.session_handle).await.unwrap();
    assert!(fixture
        .state
        .profile_liveness(None)
        .await
        .unwrap()
        .load(Ordering::SeqCst));
}

#[tokio::test]
async fn fresh_exchange_failure_cleans_issued_credentials_without_replacing_the_current_account() {
    for mode in ["vault", "identity", "scope"] {
        let fixture = Fixture::new().await;
        let current = fixture.login("a", false).await;
        let before = fixture.persisted();
        match mode {
            "vault" => fixture.store.fail_save.store(true, Ordering::SeqCst),
            "identity" => fixture.http.me_status.store(503, Ordering::SeqCst),
            _ => fixture
                .http
                .invalid_exchange_scope
                .store(true, Ordering::SeqCst),
        };
        let ticket = fixture.state.begin_authorization().await;
        assert!(fixture
            .state
            .exchange_authorization_code(
                ticket,
                "code-b",
                "http://127.0.0.1:12345/oauth/callback",
                &"v".repeat(64)
            )
            .await
            .is_err());
        assert_eq!(fixture.persisted(), before);
        fixture
            .state
            .require_current(&current.session_handle)
            .await
            .unwrap();
        let calls = fixture.http.calls.lock().unwrap();
        for token in ["renewed-b", "rotated-refresh-b"] {
            assert!(
                calls.iter().any(|call| call.0.ends_with("/revoke")
                    && url::form_urlencoded::parse(call.2.as_bytes())
                        .any(|(key, value)| key == "token" && value == token)),
                "fresh {mode} failure left a credential unrevoked"
            );
        }
        assert!(!calls.iter().any(|call| call.0.ends_with("/revoke")
            && (call.2.contains("token=access-a") || call.2.contains("token=refresh-a"))));
    }
}

#[tokio::test]
async fn password_proof_refresh_credentials_are_revoked_on_success_failure_and_account_change() {
    for mode in [0, 2] {
        let fixture = Fixture::new().await;
        let current = fixture.login("a", false).await;
        let before = fixture.persisted();
        fixture.http.password_mode.store(mode, Ordering::SeqCst);
        let result = fixture
            .state
            .reveal_key(&current.session_handle, 11, "fixture-password")
            .await;
        assert_eq!(result.is_ok(), mode == 0);
        assert_eq!(fixture.persisted(), before);
        fixture
            .state
            .require_current(&current.session_handle)
            .await
            .unwrap();
        let calls = fixture.http.calls.lock().unwrap();
        let logout = calls
            .iter()
            .find(|call| call.0.ends_with("/auth/logout"))
            .expect("temporary password refresh must be revoked");
        assert!(logout.1.is_empty());
        assert_eq!(
            serde_json::from_str::<Value>(&logout.2).unwrap(),
            json!({"refresh_token":"temporary-refresh"})
        );
        assert!(!calls
            .iter()
            .any(|call| call.0.ends_with("/app-auth/revoke")));
    }
    let fixture = Fixture::new().await;
    let a = fixture.login("a", false).await;
    let (release, gate) = oneshot::channel();
    *fixture.http.password_gate.lock().unwrap() = Some(gate);
    let state = fixture.state.clone();
    let handle = a.session_handle;
    let proof =
        tokio::spawn(async move { state.reveal_key(&handle, 11, "fixture-password").await });
    fixture.http.password_started.notified().await;
    let b = fixture.login("b", false).await;
    let before = fixture.persisted();
    release.send(()).unwrap();
    assert!(proof.await.unwrap().is_err());
    assert_eq!(fixture.persisted(), before);
    fixture
        .state
        .require_current(&b.session_handle)
        .await
        .unwrap();
    assert!(fixture
        .http
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| call.0.ends_with("/auth/logout") && call.2.contains("temporary-refresh")));
}

#[tokio::test]
async fn portable_account_guard_protects_inactive_keys_token_history_and_temporary_proof_credentials(
) {
    let fixture = Fixture::new().await;
    let a = fixture.login("a", true).await;
    fixture
        .state
        .public_summary(&a.session_handle)
        .await
        .unwrap();
    fixture
        .state
        .reveal_key(&a.session_handle, 11, "fixture-password")
        .await
        .unwrap();
    for secret in [
        "sk-managed-a",
        "sk-inactive-a",
        "access-a",
        "refresh-a",
        "renewed-a",
        "rotated-refresh-a",
        "temporary-password-token",
        "temporary-refresh",
    ] {
        for value in [
            json!({"nativePrefs":{"aliases":[format!("header prefix {secret} suffix")]}}),
            json!({format!("field-{secret}"):"safe"}),
        ] {
            assert!(
                fixture
                    .state
                    .verify_portable_value(Some(&a.session_handle), &value)
                    .is_err(),
                "protected alias was accepted"
            );
        }
    }
    fixture.state.verify_portable_value(Some(&a.session_handle),&json!({"archivedProviders":[{"id":"custom","apiKey":"own-self-hosted-key","models":["archived-only"]}]})).unwrap();
    assert!(fixture
        .state
        .verify_portable_value(None, &json!({"safe":true}))
        .is_err());
    let held = fixture.state.core.lock().await;
    assert!(fixture
        .state
        .verify_portable_value(Some(&a.session_handle), &json!({"safe":true}))
        .is_err());
    drop(held);
    let b = fixture.login("b", false).await;
    assert!(fixture
        .state
        .verify_portable_value(Some(&a.session_handle), &json!({"safe":true}))
        .is_err());
    fixture
        .state
        .verify_portable_value(Some(&b.session_handle), &json!({"safe":true}))
        .unwrap();
    fixture.state.logout(&b.session_handle).await.unwrap();
    assert!(fixture
        .state
        .verify_portable_value(Some(&b.session_handle), &json!({"safe":true}))
        .is_err());
    fixture
        .state
        .verify_portable_value(None, &json!({"safe":true}))
        .unwrap();
}

#[tokio::test]
async fn rotated_refresh_retries_vault_persistence_without_reusing_a_consumed_credential() {
    for kind in [AuthKind::Oauth, AuthKind::Password] {
        for expired in [false, true] {
            let fixture = Fixture::new().await;
            fixture
                .http
                .reject_reused_refresh
                .store(true, Ordering::SeqCst);
            let public = fixture.login_kind("a", expired, kind.clone()).await;
            let before = fixture.persisted();
            fixture.store.fail_save.store(true, Ordering::SeqCst);
            for force in [!expired, false] {
                assert_eq!(
                    fixture
                        .state
                        .access(&public.session_handle, force)
                        .await
                        .err()
                        .unwrap(),
                    "fixture vault save failed"
                );
                assert_eq!(fixture.persisted(), before);
            }
            assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
            for secret in ["renewed-a", "rotated-refresh-a"] {
                assert!(fixture
                    .state
                    .verify_portable_value(Some(&public.session_handle), &json!({"alias":secret}))
                    .is_err());
            }
            fixture.store.fail_save.store(false, Ordering::SeqCst);
            let (first, second) = tokio::join!(
                fixture.state.access(&public.session_handle, false),
                fixture.state.access(&public.session_handle, true)
            );
            assert_eq!(first.unwrap().access_token, "renewed-a");
            assert_eq!(second.unwrap().access_token, "renewed-a");
            assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
            assert!(fixture.persisted().unwrap().contains("rotated-refresh-a"));
            let resumed = AccountSessionState::with_store(
                fixture.state.origin.clone(),
                fixture.store.clone(),
            )
            .unwrap();
            assert_eq!(resumed.bootstrap().await.unwrap().unwrap().user["id"], 7);
            assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn refresh_identity_transport_failure_retains_the_new_candidate_until_verified() {
    let fixture = Fixture::new().await;
    fixture
        .http
        .reject_reused_refresh
        .store(true, Ordering::SeqCst);
    let public = fixture.login("a", true).await;
    let before = fixture.persisted();
    fixture.http.me_status.store(503, Ordering::SeqCst);
    assert_eq!(
        fixture
            .state
            .access(&public.session_handle, false)
            .await
            .err()
            .unwrap(),
        TRANSPORT_ERROR
    );
    assert_eq!(fixture.persisted(), before);
    fixture.http.me_status.store(200, Ordering::SeqCst);
    assert_eq!(
        fixture
            .state
            .access(&public.session_handle, false)
            .await
            .unwrap()
            .access_token,
        "renewed-a"
    );
    assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
    assert!(fixture.persisted().unwrap().contains("rotated-refresh-a"));
}

#[tokio::test]
async fn restoration_retains_rotated_credentials_across_identity_and_vault_failures() {
    for kind in [AuthKind::Oauth, AuthKind::Password] {
        for fault in ["identity", "vault"] {
            let fixture = Fixture::new().await;
            fixture
                .http
                .reject_reused_refresh
                .store(true, Ordering::SeqCst);
            fixture.seed_restore(kind.clone());
            let before = fixture.persisted();
            if fault == "identity" {
                fixture.http.me_status.store(503, Ordering::SeqCst);
            } else {
                fixture.store.fail_save.store(true, Ordering::SeqCst);
            }
            for _ in 0..2 {
                assert!(fixture.state.bootstrap().await.is_err());
                assert_eq!(fixture.persisted(), before);
                assert!(fixture.state.active_handle().await.is_none());
                assert!(fixture.state.profile_liveness(None).await.is_err());
            }
            assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
            fixture.http.me_status.store(200, Ordering::SeqCst);
            fixture.store.fail_save.store(false, Ordering::SeqCst);
            let (first, second) =
                tokio::join!(fixture.state.bootstrap(), fixture.state.bootstrap());
            let first = first.unwrap().unwrap();
            assert_eq!(first.user["id"], 7);
            assert_eq!(
                second.unwrap().unwrap().session_handle,
                first.session_handle
            );
            assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
            assert!(fixture.persisted().unwrap().contains("rotated-refresh-a"));
            let resumed = AccountSessionState::with_store(
                fixture.state.origin.clone(),
                fixture.store.clone(),
            )
            .unwrap();
            assert_eq!(resumed.bootstrap().await.unwrap().unwrap().user["id"], 7);
            assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn pending_refresh_credentials_are_revoked_on_logout_switch_and_clear_retry() {
    for kind in [AuthKind::Oauth, AuthKind::Password] {
        for action in ["logout", "switch", "failed-clear"] {
            let fixture = Fixture::new().await;
            fixture
                .http
                .reject_reused_refresh
                .store(true, Ordering::SeqCst);
            let public = fixture.login_kind("a", true, kind.clone()).await;
            fixture.store.fail_save.store(true, Ordering::SeqCst);
            assert!(fixture
                .state
                .access(&public.session_handle, false)
                .await
                .is_err());
            fixture.store.fail_save.store(false, Ordering::SeqCst);
            if action == "switch" {
                let current = fixture.login("b", false).await;
                fixture
                    .state
                    .require_current(&current.session_handle)
                    .await
                    .unwrap();
                assert!(fixture.persisted().unwrap().contains("access-b"));
                assert!(!fixture.revoked().iter().any(|token| token.ends_with("-b")));
            } else {
                if action == "failed-clear" {
                    fixture.store.fail_clear.store(true, Ordering::SeqCst);
                    assert!(fixture.state.logout(&public.session_handle).await.is_err());
                    assert!(fixture.state.bootstrap().await.is_err());
                    fixture.store.fail_clear.store(false, Ordering::SeqCst);
                }
                fixture.state.logout(&public.session_handle).await.unwrap();
                assert!(fixture.persisted().is_none());
                assert!(fixture.state.bootstrap().await.unwrap().is_none());
            }
            let revoked = fixture.revoked();
            for token in ["refresh-a", "rotated-refresh-a"] {
                assert!(revoked.iter().any(|value| value == token));
            }
            assert!(fixture
                .state
                .require_current(&public.session_handle)
                .await
                .is_err());
        }
    }
}

#[tokio::test]
async fn logout_or_switch_during_pending_verification_cannot_reinstall_the_old_account() {
    for switch in [false, true] {
        let fixture = Fixture::new().await;
        fixture
            .http
            .reject_reused_refresh
            .store(true, Ordering::SeqCst);
        let public = fixture.login("a", true).await;
        fixture.store.fail_save.store(true, Ordering::SeqCst);
        assert!(fixture
            .state
            .access(&public.session_handle, false)
            .await
            .is_err());
        fixture.store.fail_save.store(false, Ordering::SeqCst);
        let release = fixture.gate_me();
        let state = fixture.state.clone();
        let handle = public.session_handle.clone();
        let retry = tokio::spawn(async move { state.access(&handle, false).await });
        fixture.http.me_started.notified().await;
        let current = if switch {
            Some(fixture.login("b", false).await)
        } else {
            fixture.state.logout(&public.session_handle).await.unwrap();
            None
        };
        let before = fixture.persisted();
        release.send(()).unwrap();
        assert_eq!(retry.await.unwrap().err().unwrap(), SESSION_CHANGED);
        assert_eq!(fixture.persisted(), before);
        if let Some(current) = current {
            fixture
                .state
                .require_current(&current.session_handle)
                .await
                .unwrap();
        } else {
            assert!(fixture.state.bootstrap().await.unwrap().is_none());
        }
        assert!(fixture
            .revoked()
            .iter()
            .any(|token| token == "rotated-refresh-a"));
        assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn reauthentication_revokes_pending_restore_and_its_late_response_cannot_replace_b() {
    let fixture = Fixture::new().await;
    fixture
        .http
        .reject_reused_refresh
        .store(true, Ordering::SeqCst);
    fixture.seed_restore(AuthKind::Oauth);
    fixture.store.fail_save.store(true, Ordering::SeqCst);
    assert!(fixture.state.bootstrap().await.is_err());
    fixture.store.fail_save.store(false, Ordering::SeqCst);
    let release = fixture.gate_me();
    let state = fixture.state.clone();
    let retry = tokio::spawn(async move { state.bootstrap().await });
    fixture.http.me_started.notified().await;
    let current = fixture.login("b", false).await;
    let before = fixture.persisted();
    release.send(()).unwrap();
    assert_eq!(retry.await.unwrap().err().unwrap(), SESSION_CHANGED);
    assert_eq!(fixture.persisted(), before);
    fixture
        .state
        .require_current(&current.session_handle)
        .await
        .unwrap();
    assert!(fixture
        .revoked()
        .iter()
        .any(|token| token == "rotated-refresh-a"));
    assert!(!fixture.revoked().iter().any(|token| token == "access-b"));
    assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn expired_pending_candidates_refresh_from_the_latest_token_in_active_and_restore_paths() {
    for restore in [false, true] {
        let fixture = Fixture::new().await;
        fixture
            .http
            .reject_reused_refresh
            .store(true, Ordering::SeqCst);
        let handle = if restore {
            fixture.seed_restore(AuthKind::Oauth);
            None
        } else {
            Some(fixture.login("a", true).await.session_handle)
        };
        fixture.store.fail_save.store(true, Ordering::SeqCst);
        if let Some(handle) = &handle {
            assert!(fixture.state.access(handle, false).await.is_err());
            fixture
                .state
                .core
                .lock()
                .await
                .session
                .as_mut()
                .unwrap()
                .pending_refresh
                .as_mut()
                .unwrap()
                .expires_at_ms = 1;
        } else {
            assert!(fixture.state.bootstrap().await.is_err());
            fixture
                .state
                .core
                .lock()
                .await
                .pending_restore
                .as_mut()
                .unwrap()
                .tokens
                .expires_at_ms = 1;
        }
        fixture.store.fail_save.store(false, Ordering::SeqCst);
        if let Some(handle) = &handle {
            assert_eq!(
                fixture
                    .state
                    .access(handle, false)
                    .await
                    .unwrap()
                    .access_token,
                "renewed-2-a"
            );
        } else {
            assert_eq!(
                fixture.state.bootstrap().await.unwrap().unwrap().user["id"],
                7
            );
        }
        let sent = fixture
            .http
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.0.ends_with("/token"))
            .map(|call| {
                url::form_urlencoded::parse(call.2.as_bytes())
                    .find(|(key, _)| key == "refresh_token")
                    .unwrap()
                    .1
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(sent, ["refresh-a", "rotated-refresh-a"]);
        assert!(fixture.persisted().unwrap().contains("rotated-2-refresh-a"));
    }
}

#[tokio::test]
async fn rejected_pending_credentials_clear_the_vault_and_never_become_a_session() {
    for restore in [false, true] {
        let fixture = Fixture::new().await;
        fixture
            .http
            .reject_reused_refresh
            .store(true, Ordering::SeqCst);
        let handle = if restore {
            fixture.seed_restore(AuthKind::Oauth);
            None
        } else {
            Some(fixture.login("a", true).await.session_handle)
        };
        fixture.store.fail_save.store(true, Ordering::SeqCst);
        if let Some(handle) = &handle {
            assert!(fixture.state.access(handle, false).await.is_err());
        } else {
            assert!(fixture.state.bootstrap().await.is_err());
        }
        fixture.store.fail_save.store(false, Ordering::SeqCst);
        fixture.http.me_status.store(401, Ordering::SeqCst);
        let error = if let Some(handle) = &handle {
            fixture.state.access(handle, false).await.err().unwrap()
        } else {
            fixture.state.bootstrap().await.err().unwrap()
        };
        assert_eq!(error, AUTH_REQUIRED);
        assert!(fixture.persisted().is_none());
        assert!(fixture.state.bootstrap().await.unwrap().is_none());
        assert_eq!(fixture.http.refresh_count.load(Ordering::SeqCst), 1);
        assert!(fixture
            .revoked()
            .iter()
            .any(|token| token == "rotated-refresh-a"));
    }
}
