use std::{io, net::Ipv4Addr, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};

use super::{AccountSessionState, RemoteBridge, RemoteGatewayState, COOKIE, COOKIE_NAME};

pub(crate) const LOCAL_COOKIE: &str = "za_private_forward";
const CHUNK: usize = 64 * 1024;
const MAX_HEADER: usize = 32 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;

pub(crate) struct GatewayForward {
    pub port: u16,
    pub host: String,
    pub token: String,
    stopped: watch::Sender<bool>,
    connection: watch::Receiver<bool>,
}

impl GatewayForward {
    pub(crate) fn is_active(&self) -> bool {
        !*self.stopped.borrow() && !*self.connection.borrow()
    }
}

impl Drop for GatewayForward {
    fn drop(&mut self) {
        self.stopped.send_replace(true);
    }
}

pub(crate) async fn open(
    state: &AccountSessionState,
    remote: &RemoteGatewayState,
    owner: &str,
    bridge_id: &str,
    port: u16,
) -> Result<GatewayForward, String> {
    state.require_current(owner).await?;
    let bridge = remote.bridge(owner, bridge_id).await?;
    if bridge.selection["scope"] != "device" || port < 1024 {
        return Err("A current device selection and an HTTP loopback port are required".into());
    }
    let mut target =
        super::super::gateway::gateway_url(&bridge.origin, "/api/desktop/device-loopback")?;
    let scheme = if target.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    target
        .set_scheme(scheme)
        .map_err(|_| "Invalid device transport")?;
    target
        .query_pairs_mut()
        .append_pair("port", &port.to_string());
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Unable to open a private local listener")?;
    let local_port = listener
        .local_addr()
        .map_err(|_| "Invalid private listener")?
        .port();
    let host = format!("za-{}.localhost", uuid::Uuid::new_v4().simple());
    let token = uuid::Uuid::new_v4().simple().to_string();
    let (stopped, stop) = watch::channel(false);
    let connection = bridge.closed.subscribe();
    let config = Arc::new(RelayConfig {
        target,
        bridge,
        remote_port: port,
        authority: format!("{host}:{local_port}"),
        token: token.clone(),
    });
    tokio::spawn(serve(listener, config, stop, connection.clone()));
    Ok(GatewayForward {
        port: local_port,
        host,
        token,
        stopped,
        connection,
    })
}

struct RelayConfig {
    target: url::Url,
    bridge: Arc<RemoteBridge>,
    authority: String,
    token: String,
    remote_port: u16,
}

async fn serve(
    listener: TcpListener,
    config: Arc<RelayConfig>,
    mut stop: watch::Receiver<bool>,
    mut connection: watch::Receiver<bool>,
) {
    let permits = Arc::new(Semaphore::new(24));
    while !*stop.borrow() && !*connection.borrow() {
        let accepted = tokio::select! {
            _ = stop.changed() => break,
            _ = connection.changed() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((socket, _)) = accepted else { break };
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let (config, mut stop, mut connection) = (config.clone(), stop.clone(), connection.clone());
        tokio::spawn(async move {
            let _permit = permit;
            if *stop.borrow() || *connection.borrow() {
                return;
            }
            tokio::select! {
                _ = stop.changed() => {}
                _ = connection.changed() => {}
                _ = relay(socket, &config) => {}
            }
        });
    }
}

// `remaining` is unlimited only after a WebSocket upgrade request. A
// keep-alive HTTP socket must never relay a second, unsanitized request.
struct PrivateRequest {
    wire: Vec<u8>,
    remaining: Option<usize>,
}

fn clean_request(
    header: &str,
    authority: &str,
    token: &str,
    remote_port: u16,
) -> Option<PrivateRequest> {
    let mut lines = header.trim_end_matches("\r\n").split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?;
    let path = parts.next()?;
    if !matches!(
        method,
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) || !path.starts_with('/')
        || path.starts_with("//")
        || path.bytes().any(|byte| byte <= b' ' || byte == 0x7f)
        || parts.next()? != "HTTP/1.1"
        || parts.next().is_some()
    {
        return None;
    }
    let mut output = format!("{request_line}\r\n");
    let mut authenticated = false;
    let mut host = false;
    let mut websocket = false;
    let mut same_origin = false;
    let mut content_length = None;
    let local_origin = format!("http://{authority}");
    let remote_origin = format!("http://127.0.0.1:{remote_port}");
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value
                .bytes()
                .any(|byte| byte < 0x20 && byte != b'\t' || byte == 0x7f)
        {
            return None;
        }
        match name.to_ascii_lowercase().as_str() {
            "host" => {
                if host || value != authority {
                    return None;
                }
                host = true;
                output.push_str(&format!("Host: 127.0.0.1:{remote_port}\r\n"));
            }
            "cookie" => {
                let mut others = Vec::new();
                for part in value
                    .split(';')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                {
                    if let Some(secret) = part.strip_prefix("za_private_forward=") {
                        if authenticated || secret != token {
                            return None;
                        }
                        authenticated = true;
                    } else {
                        others.push(part);
                    }
                }
                if !others.is_empty() {
                    output.push_str(&format!("Cookie: {}\r\n", others.join("; ")));
                }
            }
            "origin" => {
                if same_origin || value != local_origin {
                    return None;
                }
                same_origin = true;
                output.push_str(&format!("Origin: {remote_origin}\r\n"));
            }
            "referer" => {
                if let Some(path) = value
                    .strip_prefix(&local_origin)
                    .filter(|path| path.starts_with('/'))
                {
                    output.push_str(&format!("Referer: {remote_origin}{path}\r\n"));
                }
            }
            "upgrade" if value.eq_ignore_ascii_case("websocket") => {
                websocket = true;
                output.push_str("Upgrade: websocket\r\n");
            }
            "upgrade" | "connection" | "proxy-authorization" | "proxy-connection" => {}
            "content-length" => {
                let size: usize = value.parse().ok()?;
                if content_length.is_some() || size > MAX_BODY {
                    return None;
                }
                content_length = Some(size);
                output.push_str(&format!("Content-Length: {size}\r\n"));
            }
            "transfer-encoding" => return None,
            "sec-fetch-site" if value == "cross-site" => return None,
            _ => {
                output.push_str(line);
                output.push_str("\r\n");
            }
        }
    }
    let content_length = content_length.unwrap_or(0);
    if !authenticated || !host || websocket && (!same_origin || content_length != 0) {
        return None;
    }
    output.push_str(if websocket {
        "Connection: Upgrade\r\n\r\n"
    } else {
        "Connection: close\r\n\r\n"
    });
    Some(PrivateRequest {
        wire: output.into_bytes(),
        remaining: (!websocket).then_some(content_length),
    })
}

async fn read_request(socket: &mut TcpStream, config: &RelayConfig) -> Option<PrivateRequest> {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    while request.len() < MAX_HEADER {
        let read = socket.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        request.extend_from_slice(&buffer[..read]);
        if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
            if end > MAX_HEADER {
                return None;
            }
            let header = std::str::from_utf8(&request[..end]).ok()?;
            let mut clean =
                clean_request(header, &config.authority, &config.token, config.remote_port)?;
            let received = &request[end + 4..];
            let consumed = received.len().min(clean.remaining.unwrap_or(usize::MAX));
            clean.wire.extend_from_slice(&received[..consumed]);
            if let Some(remaining) = &mut clean.remaining {
                *remaining -= consumed;
            }
            return Some(clean);
        }
    }
    None
}

async fn relay(mut socket: TcpStream, config: &RelayConfig) -> Result<(), io::Error> {
    let request =
        tokio::time::timeout(Duration::from_secs(4), read_request(&mut socket, config)).await;
    let Ok(Some(PrivateRequest {
        wire: first,
        mut remaining,
    })) = request
    else {
        socket
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    };
    let failure = || io::Error::other("Private Gateway connection unavailable");
    let mut request = config
        .target
        .as_str()
        .into_client_request()
        .map_err(|_| failure())?;
    request.headers_mut().insert(
        COOKIE,
        format!("{COOKIE_NAME}={}", config.bridge.cookie)
            .parse()
            .map_err(|_| failure())?,
    );
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", config.bridge.credential)
            .parse()
            .map_err(|_| failure())?,
    );
    let limits = WebSocketConfig::default()
        .max_message_size(Some(CHUNK))
        .max_frame_size(Some(CHUNK));
    let connection = tokio::time::timeout(
        Duration::from_secs(42),
        connect_async_with_config(request, Some(limits), true),
    )
    .await;
    let Ok(Ok((mut channel, _))) = connection else {
        let body =
            b"Remote port unavailable. Check the selected device and approve its local prompt.";
        let response = format!("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        socket.write_all(response.as_bytes()).await?;
        socket.write_all(body).await?;
        return Ok(());
    };
    channel
        .send(Message::Binary(first.into()))
        .await
        .map_err(|_| failure())?;
    let mut buffer = vec![0; CHUNK];
    let mut writing = true;
    loop {
        let capacity = remaining.unwrap_or(CHUNK).min(CHUNK);
        tokio::select! {
            size = socket.read(&mut buffer[..capacity]), if writing && capacity > 0 => {
                let size = size?;
                writing = size > 0;
                if let Some(remaining) = &mut remaining {
                    if size == 0 { break; }
                    *remaining -= size;
                }
                channel.send(Message::Binary(buffer[..size].to_vec().into())).await.map_err(|_| failure())?;
            }
            message = channel.next() => match message {
                Some(Ok(Message::Binary(data))) if !data.is_empty() => socket.write_all(&data).await?,
                Some(Ok(Message::Ping(_)|Message::Pong(_))) => {}
                _ => break,
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_request_strips_capability_and_rejects_other_origins() {
        let host = "za-test.localhost:51472";
        let headers = format!("GET /ws HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nUpgrade: websocket\r\nCookie: app=123; {LOCAL_COOKIE}=secret");
        let cleaned =
            String::from_utf8(clean_request(&headers, host, "secret", 5173).unwrap().wire).unwrap();
        assert!(!cleaned.contains("secret"));
        assert!(cleaned.contains("Cookie: app=123"));
        assert!(cleaned.contains("Origin: http://127.0.0.1:5173"));
        assert!(cleaned.contains("Connection: Upgrade"));
        assert!(clean_request(&headers.replace("secret", "wrong"), host, "secret", 5173).is_none());
        assert!(clean_request(
            &headers.replace(
                &format!("Origin: http://{host}"),
                "Origin: https://foreign.test"
            ),
            host,
            "secret",
            5173
        )
        .is_none());
    }

    #[tokio::test]
    async fn native_private_relay_round_trips_http_through_authenticated_gateway() {
        let gateway = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let gw_url = url::Url::parse(&format!(
            "ws://{}/api/desktop/device-loopback?port=5173",
            gateway.local_addr().unwrap()
        ))
        .unwrap();
        let device = tokio::spawn(async move {
            let (tcp, _) = gateway.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                tcp,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(
                        request.headers()["cookie"],
                        "zeroagent_session=fixture-cookie"
                    );
                    assert_eq!(request.headers()["authorization"], "Bearer fixture-lease");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let Message::Binary(data) = ws.next().await.unwrap().unwrap() else {
                panic!("expected binary request")
            };
            let data = String::from_utf8(data.to_vec()).unwrap();
            assert!(data.starts_with("GET /fixture HTTP/1.1\r\nHost: 127.0.0.1:5173\r\n"));
            assert!(data.contains("Cookie: test=page-cookie"));
            assert!(!data.contains("nonce-fixture") && !data.contains("fixture-lease"));
            ws.send(Message::Binary(
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"
                    .to_vec()
                    .into(),
            ))
            .await
            .unwrap();
            ws.close(None).await.unwrap();
        });
        let local = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let local_addr = local.local_addr().unwrap();
        let authority = format!("za-test.localhost:{}", local_addr.port());
        let (closed, _) = watch::channel(false);
        let config = RelayConfig {
            target: gw_url,
            bridge: Arc::new(RemoteBridge {
                owner: "owner".into(),
                origin: url::Url::parse("http://localhost").unwrap(),
                device_id: "device".into(),
                cookie: "fixture-cookie".into(),
                selection: serde_json::Value::Null,
                credential: "fixture-lease".into(),
                closed,
            }),
            authority: authority.clone(),
            remote_port: 5173,
            token: "nonce-fixture".into(),
        };
        let forwarder = tokio::spawn(async move {
            let (socket, _) = local.accept().await.unwrap();
            relay(socket, &config).await.unwrap();
        });
        let mut browser = TcpStream::connect(local_addr).await.unwrap();
        browser.write_all(format!("GET /fixture HTTP/1.1\r\nHost: {authority}\r\nCookie: {LOCAL_COOKIE}=nonce-fixture; test=page-cookie\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(4), browser.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.ends_with(b"\r\n\r\nOK"));
        device.await.unwrap();
        forwarder.await.unwrap();
    }
}
