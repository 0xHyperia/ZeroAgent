use std::{sync::Arc, time::Duration};

use serde_json::json;
use tokio::sync::watch;

use super::{ServerState, READ_TERMINAL, TUNNEL_MANAGER};
use crate::commands::settings::RemoteSettingsPayload;
use crate::services::kbrain_backend::KBrainBackendConnection;

const PATH: &str = "/v1/host-bridge";

/// The registration dies with its manager. The listener independently checks the
/// account and process on every call, so no delayed HTTP request can reauthorize it.
pub(super) async fn follow(
    state: Arc<ServerState>,
    connection: KBrainBackendConnection,
    mut settings: watch::Receiver<RemoteSettingsPayload>,
    initial_attempt: std::sync::mpsc::SyncSender<()>,
) {
    let Ok(http) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
    else {
        return;
    };
    let mut registered = None;
    let mut initial_attempt = Some(initial_attempt);
    loop {
        if !(state.is_live)() {
            return;
        }
        let enable_tunnels = {
            let settings = settings.borrow_and_update();
            settings.enabled && settings.enable_web_tunnels
        };
        if registered != Some(enable_tunnels) {
            let mut tools = vec![READ_TERMINAL];
            if enable_tunnels {
                tools.push(TUNNEL_MANAGER);
            }
            let response = http
                .put(format!("{}{PATH}", connection.base_url))
                .bearer_auth(&connection.token)
                .json(&json!({
                    "url": format!("http://127.0.0.1:{}", state.endpoint.port),
                    "token": &state.endpoint.token,
                    "host": "zeroagent-desktop",
                    "tools": tools,
                }))
                .send()
                .await;
            if response.is_ok_and(|response| response.status().is_success()) {
                registered = Some(enable_tunnels);
            }
        }
        if let Some(initial_attempt) = initial_attempt.take() {
            let _ = initial_attempt.try_send(());
        }
        tokio::select! {
            changed = settings.changed() => if changed.is_err() { return },
            _ = tokio::time::sleep(Duration::from_secs(2)), if registered != Some(enable_tunnels) => {},
        }
    }
}
