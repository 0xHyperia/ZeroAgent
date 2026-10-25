use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

/// Real loopback discovery/token endpoints. Tests never open a browser or OS credential store.
pub(crate) struct Fixture {
    origin: String,
    tokens: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Fixture {
    pub(crate) fn new(on_token: impl Fn() + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let base = origin.clone();
        let tokens = Arc::new(AtomicUsize::new(0));
        let token_count = tokens.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let (stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                };
                // Windows accepted sockets can inherit the listener's nonblocking
                // mode. Protocol reads below deliberately use bounded blocking I/O.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap().to_owned();
                let mut length = 0;
                loop {
                    line.clear();
                    assert_ne!(
                        reader.read_line(&mut line).unwrap(),
                        0,
                        "incomplete request headers"
                    );
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                assert!(length < 64 * 1024);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let mut status = "200 OK";
                let mut challenge = String::new();
                let json = match path.as_str() {
                    "/mcp" => {
                        status = "401 Unauthorized";
                        challenge = format!("WWW-Authenticate: Bearer resource_metadata=\"{base}/prm\"\r\n");
                        serde_json::json!({})
                    }
                    "/prm" => serde_json::json!({"resource":format!("{base}/mcp"),"authorization_servers":[base],"scopes_supported":["read"]}),
                    "/.well-known/oauth-authorization-server" => serde_json::json!({"issuer":base,
                        "authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),
                        "code_challenge_methods_supported":["S256"]}),
                    "/token" => {
                        assert!(String::from_utf8(body).unwrap().contains("grant_type="));
                        token_count.fetch_add(1, Ordering::SeqCst);
                        on_token();
                        serde_json::json!({"access_token":"fixture-new-access","refresh_token":"fixture-new-refresh",
                            "token_type":"Bearer","expires_in":3600,"scope":"read"})
                    }
                    _ => panic!("unexpected fixture path"),
                }.to_string();
                write!(reader.get_mut(), "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{challenge}\r\n{json}", json.len()).unwrap();
            }
        });
        Self {
            origin,
            tokens,
            stop,
            worker: Some(worker),
        }
    }

    pub(crate) fn target(&self) -> OauthServer {
        OauthServer {
            id: "same-server".into(),
            url: format!("{}/mcp", self.origin),
            scope_override: Some("read".into()),
            static_client_id: Some("fixture-client".into()),
        }
    }

    pub(crate) fn record(&self) -> TokenRecord {
        TokenRecord {
            version: 1,
            server_url: format!("{}/mcp", self.origin),
            target_binding: None,
            issuer: self.origin.clone(),
            authorization_endpoint: format!("{}/authorize", self.origin),
            token_endpoint: format!("{}/token", self.origin),
            registration_endpoint: None,
            client_id: "fixture-client".into(),
            client_secret: None,
            token_endpoint_auth_method: "none".into(),
            scope: Some("read".into()),
            resource: format!("{}/mcp", self.origin),
            access_token: "fixture-old-access".into(),
            refresh_token: Some("fixture-old-refresh".into()),
            expires_at_ms: 1,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Err(failure) = self.worker.take().unwrap().join() {
            // Preserve the worker failure when it is the only panic. During an
            // existing assertion failure, a second panic would abort the entire
            // process and hide the original failing test from the harness.
            if !std::thread::panicking() {
                std::panic::resume_unwind(failure);
            }
        }
    }
}

pub(crate) fn callback(url: &str) -> Result<(), String> {
    let url = url::Url::parse(url).unwrap();
    let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
    let mut callback = url::Url::parse(&pairs["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &pairs["state"])
        .append_pair("code", "fixture-code");
    // Connect and send without waiting for the response; authorize starts accepting after open_url returns.
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", callback.port().unwrap())).unwrap();
    write!(
        stream,
        "GET {}?{} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        callback.path(),
        callback.query().unwrap()
    )
    .unwrap();
    Ok(())
}

#[test]
fn authorization_rechecks_owner_after_exchange_and_preserves_both_profiles() {
    let live = Arc::new(AtomicBool::new(true));
    let ended = live.clone();
    let fixture = Fixture::new(move || {
        ended.store(false, Ordering::SeqCst);
    });
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let store_a = TokenStore::for_profile(a.path().to_owned(), "same-server", true).unwrap();
    let store_b = TokenStore::for_profile(b.path().to_owned(), "same-server", true).unwrap();
    let old = fixture.record();
    store_a.save(&old, &store_a.snapshot().unwrap()).unwrap();
    store_b.save(&old, &store_b.snapshot().unwrap()).unwrap();
    let result = authorize(&store_a, &fixture.target(), &callback, &|| {
        if live.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("owner ended".into())
        }
    });
    assert_eq!(result.unwrap_err(), "owner ended");
    assert_eq!(fixture.tokens.load(Ordering::SeqCst), 1);
    assert_eq!(store_a.snapshot().unwrap().record, Some(old.clone()));
    assert_eq!(store_b.snapshot().unwrap().record, Some(old));
}

#[test]
fn authorization_status_has_no_tokens_and_reports_its_own_storage() {
    let fixture = Fixture::new(|| {});
    let dir = tempfile::tempdir().unwrap();
    let store = TokenStore::for_profile(dir.path().to_owned(), "same-server", true).unwrap();
    let result = authorize(&store, &fixture.target(), &callback, &|| Ok(())).unwrap();
    assert_eq!(result.state, "authorized");
    assert_eq!(result.storage, "file");
    let public = serde_json::to_string(&result).unwrap();
    assert!(!public.contains("fixture-new-access"));
    assert!(!public.contains("fixture-new-refresh"));
    assert_eq!(
        store.snapshot().unwrap().record.unwrap().access_token,
        "fixture-new-access"
    );
}

#[test]
fn clear_during_real_refresh_does_not_restore_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let store = TokenStore::for_profile(dir.path().to_owned(), "same-server", true).unwrap();
    let clearing = store.clone();
    let fixture = Fixture::new(move || {
        clearing.delete().unwrap();
    });
    let stale = fixture.record();
    store.save(&stale, &store.snapshot().unwrap()).unwrap();
    assert_eq!(
        refresh_record(&store, &stale, &|| Ok(())).unwrap_err(),
        "MCP_OAUTH_OPERATION_SUPERSEDED"
    );
    assert!(store.snapshot().unwrap().record.is_none());
    assert_eq!(fixture.tokens.load(Ordering::SeqCst), 1);
}

#[test]
fn refresh_rechecks_owner_before_persisting_rotated_tokens() {
    let live = Arc::new(AtomicBool::new(true));
    let ended = live.clone();
    let fixture = Fixture::new(move || {
        ended.store(false, Ordering::SeqCst);
    });
    let dir = tempfile::tempdir().unwrap();
    let store = TokenStore::for_profile(dir.path().to_owned(), "same-server", true).unwrap();
    let stale = fixture.record();
    store.save(&stale, &store.snapshot().unwrap()).unwrap();
    let result = refresh_record(&store, &stale, &|| {
        if live.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("owner ended".into())
        }
    });
    assert_eq!(result.unwrap_err(), "owner ended");
    assert_eq!(fixture.tokens.load(Ordering::SeqCst), 1);
    assert_eq!(store.snapshot().unwrap().record, Some(stale));
}

#[test]
fn concurrent_refreshes_share_one_grant_and_use_rotated_token() {
    let fixture = Fixture::new(|| {});
    let dir = tempfile::tempdir().unwrap();
    let store = TokenStore::for_profile(dir.path().to_owned(), "same-server", true).unwrap();
    let stale = fixture.record();
    store.save(&stale, &store.snapshot().unwrap()).unwrap();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let run = || {
            barrier.wait();
            refresh_record(&store, &stale, &|| Ok(())).unwrap()
        };
        let left = scope.spawn(run);
        let right = scope.spawn(run);
        assert_eq!(left.join().unwrap().access_token, "fixture-new-access");
        assert_eq!(right.join().unwrap().access_token, "fixture-new-access");
    });
    assert_eq!(fixture.tokens.load(Ordering::SeqCst), 1);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .record
            .unwrap()
            .refresh_token
            .as_deref(),
        Some("fixture-new-refresh")
    );
}

#[test]
fn same_server_in_other_profile_has_separate_slots_suspects_and_refresh_lock() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let a = TokenStore::for_profile(a.path().to_owned(), "same-server", true).unwrap();
    let b = TokenStore::for_profile(b.path().to_owned(), "same-server", true).unwrap();
    let _a = AuthorizeSlot::acquire(a.identity()).unwrap();
    let _b = AuthorizeSlot::acquire(b.identity()).unwrap();
    assert!(AuthorizeSlot::acquire(a.identity()).is_err());
    mark_client_suspect(a.identity());
    assert!(is_client_suspect(a.identity()));
    assert!(!is_client_suspect(b.identity()));
    clear_client_suspect(a.identity());
    assert!(!Arc::ptr_eq(
        &refresh_lock_for(a.identity()),
        &refresh_lock_for(b.identity())
    ));
}
