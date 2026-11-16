use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::Manager;
use tokio::sync::mpsc;

use super::{
    connection::send_agent_envelope_to, now_unix_seconds, proto, GatewayController,
    GatewayOutboundSender,
};
use crate::services::kbrain_backend::KBrainBackendState;
use proto::TunnelFrameKind as Kind;

const CHUNK: usize = 64 * 1024;
pub(crate) const IMAGE_UPLOAD_MAX: usize = 21 << 20;
pub(crate) const IMAGE_JSON_MAX: usize = 4 << 20;
const ACCOUNT_HEADER: &str = "x-zeroagent-image-account";

pub(crate) fn remote_image_route(method: &str, path: &str) -> bool {
    let Some(suffix) = path.strip_prefix("/api/image/") else {
        return false;
    };
    let id = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.~".contains(&c))
    };
    let parts: Vec<_> = suffix.split('/').collect();
    match parts.as_slice() {
        ["health" | "identity" | "targets"] => method == "GET",
        ["assets"] => method == "POST",
        ["projects" | "jobs"] => matches!(method, "GET" | "POST"),
        ["projects", value] => id(value) && matches!(method, "GET" | "PATCH" | "DELETE"),
        ["jobs", value] => id(value) && matches!(method, "GET" | "DELETE"),
        ["jobs", value, "events"] => id(value) && method == "GET",
        ["jobs", value, "cancel"] => id(value) && method == "POST",
        ["assets", value, "content"] => id(value) && matches!(method, "GET" | "HEAD"),
        _ => false,
    }
}

pub(crate) fn image_request_header(name: &str) -> bool {
    matches!(
        name,
        "accept" | "content-type" | "idempotency-key" | "last-event-id"
    )
}

#[derive(Default)]
pub(super) struct DeviceImages {
    streams: Mutex<HashMap<String, mpsc::Sender<proto::TunnelFrame>>>,
}

impl DeviceImages {
    pub(super) fn handle(
        &self,
        controller: &Arc<GatewayController>,
        frame: proto::TunnelFrame,
    ) -> Result<(), String> {
        let id = frame.stream_id.clone();
        if !id
            .strip_prefix("image-")
            .is_some_and(|tail| uuid::Uuid::parse_str(tail).is_ok())
        {
            return Ok(());
        }
        let mut streams = self
            .streams
            .lock()
            .map_err(|_| "Device image streams are unavailable")?;
        match frame.kind() {
            Kind::HttpRequestStart => {
                if streams.len() >= 24 || streams.contains_key(&id) {
                    return Ok(());
                }
                let sender = controller.current_outbound_sender()?;
                let (tx, rx) = mpsc::channel(64);
                streams.insert(id.clone(), tx);
                let controller = controller.clone();
                tauri::async_runtime::spawn(async move {
                    let result = serve(&controller, &sender, &id, frame, rx).await;
                    if result.is_err() {
                        let _ = send(
                            &sender,
                            &id,
                            proto::TunnelFrame {
                                kind: Kind::Error as i32,
                                ..Default::default()
                            },
                        )
                        .await;
                    }
                    if let Ok(mut entries) = controller.device_images.streams.lock() {
                        entries.remove(&id);
                    }
                });
            }
            Kind::HttpRequestBody | Kind::HttpRequestEnd => {
                if frame.body.len() > CHUNK
                    || streams
                        .get(&id)
                        .is_some_and(|tx| tx.try_send(frame).is_err())
                {
                    streams.remove(&id);
                }
            }
            Kind::Cancel => {
                streams.remove(&id);
            }
            _ => {}
        }
        Ok(())
    }
}

async fn serve(
    controller: &GatewayController,
    sender: &GatewayOutboundSender,
    id: &str,
    start: proto::TunnelFrame,
    mut frames: mpsc::Receiver<proto::TunnelFrame>,
) -> Result<(), ()> {
    let (path, query) = start.path.split_once('?').unwrap_or((&start.path, ""));
    if !start.target_url.is_empty()
        || path == "/api/image/identity"
        || !remote_image_route(&start.method, path)
    {
        return Err(());
    }
    let mut account = start
        .headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case(ACCOUNT_HEADER));
    let owner = account
        .next()
        .and_then(|header| header.value.parse::<i64>().ok())
        .filter(|id| *id > 0)
        .ok_or(())?;
    if account.next().is_some() {
        return Err(());
    }
    let limit = if path == "/api/image/assets" {
        IMAGE_UPLOAD_MAX
    } else {
        IMAGE_JSON_MAX
    };
    let mut body = Vec::new();
    loop {
        let frame = tokio::select! {
            _ = sender.closed() => return Ok(()),
            frame = frames.recv() => frame,
        };
        let Some(frame) = frame else {
            return Ok(());
        };
        match frame.kind() {
            Kind::HttpRequestEnd => break,
            Kind::HttpRequestBody if body.len() + frame.body.len() <= limit => {
                body.extend(frame.body)
            }
            _ => return Err(()),
        }
    }
    if matches!(start.method.as_str(), "GET" | "HEAD") && !body.is_empty() {
        return Err(());
    }
    let backend = controller
        .app_handle
        .try_state::<Arc<KBrainBackendState>>()
        .ok_or(())?;
    let endpoint = backend.remote_image_connection(owner).map_err(|_| ())?;
    let mut url = reqwest::Url::parse(&endpoint.base_url).map_err(|_| ())?;
    let private_path = if path == "/api/image/health" {
        "/v1/health".to_owned()
    } else {
        format!("/v1{}", path.strip_prefix("/api").ok_or(())?)
    };
    url.set_path(&private_path);
    url.set_query((!query.is_empty()).then_some(query));
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| ())?;
    let method = reqwest::Method::from_bytes(start.method.as_bytes()).map_err(|_| ())?;
    let mut request = client.request(method, url).bearer_auth(endpoint.token);
    for header in &start.headers {
        let name = header.name.to_ascii_lowercase();
        if image_request_header(&name) && header.value.len() <= 4096 {
            request = request.header(name, &header.value);
        }
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    tokio::select! {
        _ = sender.closed() => Ok(()),
        _ = frames.recv() => Ok(()),
        result = stream_response(sender, id, request) => result,
    }
}

async fn stream_response(
    sender: &GatewayOutboundSender,
    id: &str,
    request: reqwest::RequestBuilder,
) -> Result<(), ()> {
    let mut response = request.send().await.map_err(|_| ())?;
    let headers = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| proto::TunnelHeader {
            name: "Content-Type".into(),
            value: value.into(),
        });
    send(
        sender,
        id,
        proto::TunnelFrame {
            kind: Kind::HttpResponseStart as i32,
            status: u32::from(response.status().as_u16()),
            headers: headers.into_iter().collect(),
            ..Default::default()
        },
    )
    .await?;
    while let Some(bytes) = response.chunk().await.map_err(|_| ())? {
        for part in bytes.chunks(CHUNK) {
            send(
                sender,
                id,
                proto::TunnelFrame {
                    kind: Kind::HttpResponseBody as i32,
                    body: part.to_vec(),
                    ..Default::default()
                },
            )
            .await?;
        }
    }
    send(
        sender,
        id,
        proto::TunnelFrame {
            kind: Kind::HttpResponseEnd as i32,
            ..Default::default()
        },
    )
    .await
}

async fn send(
    sender: &GatewayOutboundSender,
    id: &str,
    mut frame: proto::TunnelFrame,
) -> Result<(), ()> {
    frame.stream_id = id.into();
    tokio::time::timeout(
        Duration::from_secs(8),
        send_agent_envelope_to(
            sender.clone(),
            proto::AgentEnvelope {
                request_id: id.into(),
                timestamp: now_unix_seconds(),
                payload: Some(proto::agent_envelope::Payload::TunnelFrame(frame)),
            },
        ),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::remote_image_route;

    #[test]
    fn remote_images_only_allow_device_image_operations() {
        assert!(remote_image_route("GET", "/api/image/jobs/job/events"));
        assert!(remote_image_route("POST", "/api/image/jobs/job/cancel"));
        assert!(remote_image_route("POST", "/api/image/assets"));
        assert!(!remote_image_route("POST", "/api/image/secrets"));
        assert!(!remote_image_route("PATCH", "/api/image/settings"));
        assert!(!remote_image_route("GET", "/api/image/jobs/%2e%2e/events"));
        assert!(!remote_image_route("GET", "/api/image/assets/../content"));
        assert!(!remote_image_route(
            "GET",
            "/api/image/jobs/job/extra/events"
        ));
    }
}
