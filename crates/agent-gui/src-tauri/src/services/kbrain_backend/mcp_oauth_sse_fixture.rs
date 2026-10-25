/// A real legacy MCP endpoint: one persistent GET and separately authorized POSTs.
/// Every accepted socket and handler belongs to this fixture and is joined on drop.
struct OAuthSseMcpEndpoint {
    url: String,
    denied: Arc<std::sync::atomic::AtomicUsize>,
    calls: Arc<std::sync::atomic::AtomicUsize>,
    gets: Arc<std::sync::atomic::AtomicUsize>,
    active_gets: Arc<std::sync::atomic::AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

struct OAuthSseSession {
    writer: std::net::TcpStream,
    initial_bearer: String,
}

impl OAuthSseMcpEndpoint {
    fn start() -> Self {
        Self::start_mode(None)
    }

    fn start_mode(message_url_override: Option<bool>) -> Self {
        Self::start_modes(message_url_override, None)
    }

    fn start_implicit(late: bool) -> Self {
        Self::start_modes(None, Some(late))
    }

    fn start_modes(message_url_override: Option<bool>, implicit: Option<bool>) -> Self {
        use std::io::Write;
        use std::sync::atomic::AtomicUsize;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let suffix = if implicit.is_some() {
            "/prefix/sse?channel=one"
        } else {
            "/sse"
        };
        let url = format!("http://{}{suffix}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let denied = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let gets = Arc::new(AtomicUsize::new(0));
        let active_gets = Arc::new(AtomicUsize::new(0));
        let sessions = Arc::new(Mutex::new(std::collections::HashMap::<
            usize,
            OAuthSseSession,
        >::new()));
        let (stopped, rejected, called, opened, active) = (
            stop.clone(),
            denied.clone(),
            calls.clone(),
            gets.clone(),
            active_gets.clone(),
        );
        let worker = thread::spawn(move || {
            let mut handlers = Vec::new();
            while !stopped.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("SSE fixture accept: {error}"),
                };
                let (stopped, rejected, called, opened, active, sessions) = (
                    stopped.clone(),
                    rejected.clone(),
                    called.clone(),
                    opened.clone(),
                    active.clone(),
                    sessions.clone(),
                );
                handlers.push(thread::spawn(move || {
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 { return; }
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap().to_owned();
                    let target = parts.next().unwrap().to_owned();
                    let mut length = 0;
                    let mut bearer = String::new();
                    loop {
                        line.clear();
                        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                        if line == "\r\n" { break; }
                        let (name, value) = line.split_once(':').unwrap();
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                        if name.eq_ignore_ascii_case("authorization") {
                            bearer = value.trim().to_owned();
                        }
                    }
                    assert!(length < 128 * 1024);
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    drop(reader);
                    if method == "GET" && target == suffix {
                        assert!(bearer == "Bearer fixture-old-access" || bearer == "Bearer fixture-new-access");
                        let id = opened.fetch_add(1, Ordering::SeqCst) + 1;
                        stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
                        sessions.lock().unwrap().insert(id, OAuthSseSession {
                            writer: stream.try_clone().unwrap(),
                            initial_bearer: bearer.trim_start_matches("Bearer ").to_owned(),
                        });
                        active.fetch_add(1, Ordering::SeqCst);
                        // Register before publishing: the Go reader can POST as
                        // soon as the endpoint event reaches its persistent GET.
                        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").unwrap();
                        if implicit.is_some() {
                            write!(stream,": ready without endpoint\n\n").unwrap();
                        } else { match message_url_override {
                            None => write!(stream,"event: endpoint\ndata: /messages?session={id}\n\n").unwrap(),
                            Some(false) => write!(stream,": ready without endpoint\n\n").unwrap(),
                            Some(true) => write!(stream,"event: endpoint\ndata: /conflicting-endpoint\n\n").unwrap(),
                        } }
                        stream.flush().unwrap();
                        let mut byte = [0];
                        while !stopped.load(Ordering::SeqCst) {
                            match stream.read(&mut byte) {
                                Ok(0) => break,
                                Ok(_) => panic!("unexpected bytes on the persistent GET"),
                                Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {},
                                Err(_) => break,
                            }
                        }
                        sessions.lock().unwrap().remove(&id);
                        active.fetch_sub(1, Ordering::SeqCst);
                        return;
                    }
                    assert_eq!(method, "POST");
                    let id = if message_url_override.is_some() {
                        assert_eq!(target,"/configured-messages?channel=one");
                        *sessions.lock().unwrap().keys().max().expect("configured POST needs a live GET")
                    } else if let Some(late) = implicit {
                        if target == "/prefix/message?channel=one" {
                            *sessions.lock().unwrap().keys().max().expect("inferred POST needs a live GET")
                        } else {
                            assert!(late, "missing endpoint mode must use inferred path");
                            target.strip_prefix("/late-messages?channel=one&session=").unwrap().parse::<usize>().unwrap()
                        }
                    }else{target.strip_prefix("/messages?session=").unwrap().parse::<usize>().unwrap()};
                    if bearer != "Bearer fixture-new-access" {
                        rejected.fetch_add(1, Ordering::SeqCst);
                        write!(stream, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                        return;
                    }
                    let input: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    let mut sessions = sessions.lock().unwrap();
                    let session = sessions.get_mut(&id).expect("POST must belong to a live GET");
                    if implicit == Some(true) && input["method"] == "tools/list" {
                        write!(session.writer,"event: endpoint\ndata: /late-messages?channel=one&session={id}\n\n").unwrap();
                        session.writer.flush().unwrap();
                    }
                    if implicit == Some(true) && input["method"] == "tools/call" {
                        assert_eq!(target, format!("/late-messages?channel=one&session={id}"));
                    }
                    let result = match input["method"].as_str().unwrap_or("") {
                        "initialize" => serde_json::json!({"protocolVersion":input["params"]["protocolVersion"],"serverInfo":{"name":"native-legacy-sse-fixture","version":"1"},"capabilities":{"tools":{}}}),
                        "tools/list" => serde_json::json!({"tools":[{"name":"echo","description":"controlled SSE echo","inputSchema":{"type":"object","properties":{}}}]}),
                        "tools/call" => {
                            called.fetch_add(1, Ordering::SeqCst);
                            serde_json::json!({"content":[{"type":"text","text":format!("native-flow-ok {} fixture-new-access", session.initial_bearer)}],"isError":false})
                        },
                        _ => serde_json::json!({}),
                    };
                    if input.get("id").is_some() {
                        let output = serde_json::json!({"jsonrpc":"2.0","id":input["id"],"result":result});
                        write!(session.writer, "event: message\ndata: {output}\n\n").unwrap();
                        session.writer.flush().unwrap();
                    }
                    write!(stream, "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                }));
            }
            for session in sessions.lock().unwrap().values() {
                let _ = session.writer.shutdown(std::net::Shutdown::Both);
            }
            for handler in handlers {
                if let Err(error) = handler.join() {
                    std::panic::resume_unwind(error);
                }
            }
        });
        Self {
            url,
            denied,
            calls,
            gets,
            active_gets,
            stop,
            worker: Some(worker),
        }
    }

    fn wait_for_active_gets(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.active_gets.load(Ordering::SeqCst) != expected {
            assert!(
                Instant::now() < deadline,
                "legacy GET lifecycle did not settle"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for OAuthSseMcpEndpoint {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            if let Err(error) = worker.join() {
                if !thread::panicking() {
                    std::panic::resume_unwind(error);
                }
            }
        }
    }
}
