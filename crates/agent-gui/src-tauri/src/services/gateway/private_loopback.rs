use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
};

use super::{
    connection::send_agent_envelope_to, now_unix_seconds, proto, GatewayController,
    GatewayOutboundSender,
};
use crate::services::kbrain_backend::KBrainBackendState;
use proto::TunnelFrameKind as Kind;

const CHUNK: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct DeviceLoopback {
    streams: Mutex<HashMap<String, mpsc::Sender<proto::TunnelFrame>>>,
    grant: tokio::sync::Mutex<Option<(u16, Instant, GatewayOutboundSender, bool)>>,
}

fn target_port(target: &str) -> Option<u16> {
    let port = target.strip_prefix("http://127.0.0.1:")?;
    let number: u16 = port.parse().ok()?;
    (number >= 1024 && port == number.to_string()).then_some(number)
}

impl DeviceLoopback {
    pub(super) fn handle(
        &self,
        controller: &Arc<GatewayController>,
        frame: proto::TunnelFrame,
    ) -> Result<(), String> {
        let id = frame.stream_id.clone();
        if !id
            .strip_prefix("private-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            return Ok(());
        }
        let mut streams = self
            .streams
            .lock()
            .map_err(|_| "Private stream unavailable")?;
        match frame.kind() {
            Kind::PrivateOpen => {
                let sender = controller.current_outbound_sender()?;
                if streams.len() >= 24 || streams.contains_key(&id) {
                    return Ok(());
                }
                let (tx, rx) = mpsc::channel(16);
                streams.insert(id.clone(), tx);
                let controller = controller.clone();
                tauri::async_runtime::spawn(async move {
                    run(controller, sender, id, frame.target_url, rx).await;
                });
            }
            Kind::Cancel => {
                streams.remove(&id);
            }
            Kind::PrivateData | Kind::PrivateEnd => {
                if frame.body.len() > CHUNK
                    || streams
                        .get(&id)
                        .is_some_and(|tx| tx.try_send(frame).is_err())
                {
                    streams.remove(&id);
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn approve(&self, port: u16, sender: &GatewayOutboundSender) -> bool {
        let mut grant = self.grant.lock().await;
        if let Some((approved_port, until, channel, decision)) = grant.as_ref() {
            if *approved_port == port && *until > Instant::now() && sender.is_same(channel) {
                return *decision;
            }
        }
        let choice = rfd::AsyncMessageDialog::new()
            .set_title("ZeroAgent")
            .set_description(format!("允许当前已授权的桌面会话私下访问这台电脑的回环端口 {port}？\nAllow this authorized desktop to privately open loopback port {port}?"))
            .set_buttons(rfd::MessageButtons::YesNo)
            .set_level(rfd::MessageLevel::Warning)
            .show().await;
        let allowed = choice == rfd::MessageDialogResult::Yes;
        let ttl = if allowed { 300 } else { 20 };
        *grant = Some((
            port,
            Instant::now() + Duration::from_secs(ttl),
            sender.clone(),
            allowed,
        ));
        allowed
    }
}

fn protected(controller: &GatewayController, port: u16) -> bool {
    let Some(backend) = controller.app_handle.try_state::<Arc<KBrainBackendState>>() else {
        return true;
    };
    let internal = backend.running_connection().map(|value| value.base_url);
    let facade = backend
        .subscribe_connection()
        .borrow()
        .as_ref()
        .map(|value| value.base_url.clone());
    internal.into_iter().chain(facade).any(|base| {
        url::Url::parse(&base)
            .ok()
            .and_then(|url| url.port_or_known_default())
            == Some(port)
    })
}

async fn run(
    controller: Arc<GatewayController>,
    sender: GatewayOutboundSender,
    id: String,
    target: String,
    mut frames: mpsc::Receiver<proto::TunnelFrame>,
) {
    let result = async {
        let port = target_port(&target).filter(|port| !protected(&controller, *port)).ok_or(())?;
        let allowed = tokio::select! {
            result = controller.private_loopback.approve(port, &sender) => result,
            _ = frames.recv() => return Err(()),
            _ = sender.closed() => return Err(()),
        };
        if !allowed || protected(&controller, port) { return Err(()); }
        let mut socket = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)))
            .await.map_err(|_| ())?.map_err(|_| ())?;
        send(&sender, &id, Kind::PrivateReady, vec![]).await?;
        let mut buffer = vec![0; CHUNK];
        loop {
            tokio::select! {
                _ = sender.closed() => break,
                data = socket.read(&mut buffer) => {
                    let size = data.map_err(|_| ())?;
                    if size == 0 {
                        send(&sender, &id, Kind::PrivateEnd, vec![]).await?;
                        break;
                    }
                    send(&sender, &id, Kind::PrivateData, buffer[..size].to_vec()).await?;
                }
                frame = frames.recv() => {
                    let Some(frame) = frame else { break };
                    let write = async {
                        if frame.kind() == Kind::PrivateEnd { socket.shutdown().await }
                        else { socket.write_all(&frame.body).await }
                    };
                    tokio::time::timeout(Duration::from_secs(8), write).await.map_err(|_| ())?.map_err(|_| ())?;
                }
            }
        }
        Ok(())
    }.await;
    if result.is_err() {
        let _ = send(&sender, &id, Kind::Error, vec![]).await;
    }
    if let Ok(mut streams) = controller.private_loopback.streams.lock() {
        streams.remove(&id);
    }
}

async fn send(
    sender: &GatewayOutboundSender,
    id: &str,
    kind: Kind,
    body: Vec<u8>,
) -> Result<(), ()> {
    tokio::time::timeout(
        Duration::from_secs(8),
        send_agent_envelope_to(
            sender.clone(),
            proto::AgentEnvelope {
                request_id: id.into(),
                timestamp: now_unix_seconds(),
                payload: Some(proto::agent_envelope::Payload::TunnelFrame(
                    proto::TunnelFrame {
                        stream_id: id.into(),
                        kind: kind as i32,
                        body,
                        ..Default::default()
                    },
                )),
            },
        ),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    #[test]
    fn device_private_forward_dials_only_canonical_numeric_loopback() {
        assert_eq!(super::target_port("http://127.0.0.1:5173"), Some(5173));
        for input in [
            "https://127.0.0.1:5173",
            "http://127.0.0.1:5173/",
            "http://[::1]:5173",
            "http://localhost:5173",
            "http://127.0.0.1:22",
            "http://192.168.1.3:5173",
        ] {
            assert_eq!(super::target_port(input), None);
        }
    }
}
