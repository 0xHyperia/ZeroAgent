use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn signed_in() -> Arc<Mutex<MobileGatewaySession>> {
    let mut session = MobileGatewaySession::default();
    session.restore(
        "https://agent.usa0.top".into(),
        "fixture-cookie".into(),
        Some(700127),
        BTreeMap::new(),
    );
    Arc::new(Mutex::new(session))
}

fn streams() -> HttpStreams {
    Arc::new(Mutex::new(SocketRegistry::default()))
}

fn open(
    session: &Mutex<MobileGatewaySession>,
    streams: &Mutex<SocketRegistry<HttpStreamChannels>>,
) -> RegisteredStream {
    let session = session.lock().unwrap();
    register(
        &session,
        &mut streams.lock().unwrap(),
        session.owner().unwrap(),
    )
    .unwrap()
}

#[test]
fn registrations_are_bounded_and_have_native_random_handles() {
    let session = signed_in();
    let streams = streams();
    let mut ids = std::collections::HashSet::new();
    let mut registrations = Vec::new();
    for _ in 0..MAX_STREAMS {
        let stream = open(&session, &streams);
        assert!(stream.instance > 0);
        assert!(uuid::Uuid::parse_str(&stream.id).is_ok());
        assert!(ids.insert(stream.id.clone()));
        registrations.push(stream);
    }
    let session = session.lock().unwrap();
    assert!(register(
        &session,
        &mut streams.lock().unwrap(),
        session.owner().unwrap()
    )
    .is_err());
    close(&session, &mut streams.lock().unwrap(), &registrations[0].id).unwrap();
    assert!(register(
        &session,
        &mut streams.lock().unwrap(),
        session.owner().unwrap()
    )
    .is_ok());
}

#[tokio::test]
async fn an_abandoned_stream_expires_even_when_its_network_read_never_finishes() {
    let session = signed_in();
    let streams = streams();
    let registration = open(&session, &streams);
    let owner = session.lock().unwrap().owner().unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        run_with_idle_timeout(
            owner,
            registration.cancelled,
            registration.activity,
            Duration::from_millis(10),
            std::future::pending::<()>(),
        ),
    )
    .await
    .unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn reading_renews_activity_and_new_opens_reclaim_expired_handles() {
    let session = signed_in();
    let streams = streams();
    let active = open(&session, &streams);
    *active.activity.lock().unwrap() = Instant::now() - STREAM_IDLE_TIMEOUT;
    active
        .sender
        .send(Ok(HttpStreamItem::Chunk {
            data: "YQ==".into(),
        }))
        .await
        .unwrap();
    read(&session, &streams, &active.id).await.unwrap();
    assert!(active.activity.lock().unwrap().elapsed() < Duration::from_secs(1));
    let mut registrations = Vec::new();
    for _ in 1..MAX_STREAMS {
        registrations.push(open(&session, &streams));
    }
    *active.activity.lock().unwrap() = Instant::now() - STREAM_IDLE_TIMEOUT;
    let _replacement = open(&session, &streams);
    assert!(!streams.lock().unwrap().entries.contains_key(&active.id));
    assert!(active.cancelled.await.is_ok());
    close_all(&mut streams.lock().unwrap());
    assert!(streams.lock().unwrap().entries.is_empty());
}

#[tokio::test]
async fn backpressure_bounds_the_native_ipc_queue() {
    let session = signed_in();
    let streams = streams();
    let registration = open(&session, &streams);
    for _ in 0..STREAM_BUFFER_CHUNKS {
        registration
            .sender
            .send(Ok(HttpStreamItem::Chunk {
                data: "YQ==".into(),
            }))
            .await
            .unwrap();
    }
    assert!(matches!(
        registration.sender.try_send(Ok(HttpStreamItem::Chunk {
            data: "Yg==".into()
        })),
        Err(mpsc::error::TrySendError::Full(_))
    ));
    assert!(matches!(
        read(&session, &streams, &registration.id).await.unwrap(),
        Some(HttpStreamItem::Chunk { .. })
    ));
    registration
        .sender
        .try_send(Ok(HttpStreamItem::Chunk {
            data: "Yg==".into(),
        }))
        .unwrap();
}

#[tokio::test]
async fn logout_rejects_buffered_bytes_and_wakes_pending_reads() {
    let session = signed_in();
    let streams = streams();
    let buffered = open(&session, &streams);
    buffered
        .sender
        .send(Ok(HttpStreamItem::Chunk {
            data: "cHJpdmF0ZQ==".into(),
        }))
        .await
        .unwrap();
    let pending = open(&session, &streams);
    let pending_id = pending.id.clone();
    let read_session = Arc::clone(&session);
    let read_streams = Arc::clone(&streams);
    let task = tokio::spawn(async move { read(&read_session, &read_streams, &pending_id).await });
    tokio::task::yield_now().await;
    session.lock().unwrap().logout();
    assert!(read(&session, &streams, &buffered.id).await.is_err());
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}

#[tokio::test]
async fn closing_a_stream_cancels_its_network_work_and_eof_releases_capacity() {
    let session = signed_in();
    let streams = streams();
    let registration = open(&session, &streams);
    let owner = session.lock().unwrap().owner().unwrap();
    let id = registration.id;
    let task = tokio::spawn(super::super::run_owned(
        owner,
        registration.cancelled,
        std::future::pending::<()>(),
    ));
    close(&session.lock().unwrap(), &mut streams.lock().unwrap(), &id).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    let registration = open(&session, &streams);
    drop(registration.sender);
    assert!(read(&session, &streams, &registration.id)
        .await
        .unwrap()
        .is_none());
    assert!(!streams
        .lock()
        .unwrap()
        .entries
        .contains_key(&registration.id));
}

#[test]
fn stream_headers_never_serialize_session_cookies() {
    let item = HttpStreamItem::Headers {
        status: 200,
        headers: BTreeMap::from([
            ("Set-Cookie".into(), "fixture-secret".into()),
            ("content-type".into(), "text/event-stream".into()),
        ]),
    };
    let json = serde_json::to_string(&item).unwrap();
    assert!(!json.contains("fixture-secret"));
    assert!(json.contains("text/event-stream"));
}

#[tokio::test]
async fn a_real_chunked_http_body_is_delivered_before_eof_without_changing_bytes() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (finish, wait) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        let _ = socket.read(&mut request).await.unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream\r\n\r\n2\r\n\xe4\xbd\r\n").await.unwrap();
        wait.await.unwrap();
        socket
            .write_all(b"4\r\n\xa0!\r\n\r\n0\r\n\r\n")
            .await
            .unwrap();
    });
    let response = reqwest::Client::new()
        .get(format!("http://{addr}"))
        .send()
        .await
        .unwrap();
    let session = signed_in();
    let streams = streams();
    let registration = open(&session, &streams);
    let sender = registration.sender;
    let forwarder = tokio::spawn(async move { forward_response(response, &sender).await });
    let first = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        read(&session, &streams, &registration.id),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    let HttpStreamItem::Chunk { data } = first else {
        panic!("expected first body chunk")
    };
    let mut bytes = BASE64.decode(data).unwrap();
    assert_eq!(bytes, [0xe4, 0xbd]);
    finish.send(()).unwrap();
    while let Some(item) = read(&session, &streams, &registration.id).await.unwrap() {
        let HttpStreamItem::Chunk { data } = item else {
            panic!("unexpected headers")
        };
        let chunk = BASE64.decode(data).unwrap();
        assert!(chunk.len() <= STREAM_CHUNK_BYTES);
        bytes.extend(chunk);
    }
    assert_eq!(bytes, "你!\r\n".as_bytes());
    forwarder.await.unwrap().unwrap();
    server.await.unwrap();
}
