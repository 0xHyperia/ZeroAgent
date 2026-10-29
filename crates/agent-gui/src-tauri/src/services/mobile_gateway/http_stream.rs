//! Bounded, pull-driven mobile HTTP transport. Credentials stay with the native owner.
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use super::{MobileGatewaySession, RequestOwner, SocketRegistry};

pub const STREAM_CHUNK_BYTES: usize = 32 * 1024;
pub const STREAM_BUFFER_CHUNKS: usize = 4;
const MAX_STREAMS: usize = 8;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HttpStreamItem {
    Headers {
        status: u16,
        #[serde(serialize_with = "super::serialize_public_headers")]
        headers: BTreeMap<String, String>,
    },
    Chunk {
        data: String,
    },
}

pub type StreamResult = Result<HttpStreamItem, String>;

pub struct HttpStreamChannels {
    receiver: Arc<AsyncMutex<mpsc::Receiver<StreamResult>>>,
    cancel: oneshot::Sender<()>,
    activity: Arc<Mutex<Instant>>,
}

pub type HttpStreams = Arc<Mutex<SocketRegistry<HttpStreamChannels>>>;

pub struct RegisteredStream {
    pub id: String,
    pub instance: u64,
    pub sender: mpsc::Sender<StreamResult>,
    pub cancelled: oneshot::Receiver<()>,
    pub activity: Arc<Mutex<Instant>>,
}

pub fn register(
    session: &MobileGatewaySession,
    streams: &mut SocketRegistry<HttpStreamChannels>,
    owner: RequestOwner,
) -> Result<RegisteredStream, String> {
    session.require_owner(&owner)?;
    // Finished responses can retain unread chunks. Reclaim abandoned handles on new opens.
    let expired = streams
        .entries
        .iter()
        .filter_map(|(id, entry)| {
            let stale = !entry.owner.is_live()
                || entry
                    .value
                    .activity
                    .lock()
                    .map(|last_read| last_read.elapsed() >= STREAM_IDLE_TIMEOUT)
                    .unwrap_or(true);
            stale.then(|| id.clone())
        })
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(channels) = streams.remove(&id) {
            let _ = channels.cancel.send(());
        }
    }
    if streams.entries.len() >= MAX_STREAMS {
        return Err("Too many active Gateway streams".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel(STREAM_BUFFER_CHUNKS);
    let (cancel, cancelled) = oneshot::channel();
    let activity = Arc::new(Mutex::new(Instant::now()));
    let (instance, _) = streams.insert(
        session,
        owner,
        id.clone(),
        HttpStreamChannels {
            receiver: Arc::new(AsyncMutex::new(receiver)),
            cancel,
            activity: Arc::clone(&activity),
        },
    )?;
    Ok(RegisteredStream {
        id,
        instance,
        sender,
        cancelled,
        activity,
    })
}

pub fn close(
    session: &MobileGatewaySession,
    streams: &mut SocketRegistry<HttpStreamChannels>,
    id: &str,
) -> Result<(), String> {
    if let Some(entry) = streams.entries.get(id) {
        session.require_owner(&entry.owner)?;
    }
    if let Some(channels) = streams.remove(id) {
        let _ = channels.cancel.send(());
    }
    Ok(())
}

pub fn close_all(streams: &mut SocketRegistry<HttpStreamChannels>) {
    for channels in streams.drain() {
        let _ = channels.cancel.send(());
    }
}

pub async fn read(
    session: &Mutex<MobileGatewaySession>,
    streams: &Mutex<SocketRegistry<HttpStreamChannels>>,
    id: &str,
) -> Result<Option<HttpStreamItem>, String> {
    let (owner, receiver, activity, instance) = {
        let session = session
            .lock()
            .map_err(|_| "Gateway session is unavailable")?;
        let streams = streams
            .lock()
            .map_err(|_| "Gateway streams are unavailable")?;
        let entry = streams.entries.get(id).ok_or("Gateway stream is closed")?;
        session.require_owner(&entry.owner)?;
        (
            entry.owner.clone(),
            Arc::clone(&entry.value.receiver),
            Arc::clone(&entry.value.activity),
            entry.instance,
        )
    };
    *activity
        .lock()
        .map_err(|_| "Gateway stream is unavailable")? = Instant::now();
    let result = tokio::select! {
        biased;
        _ = owner.invalidated() => return Err("Gateway account session changed".into()),
        result = async { receiver.lock().await.recv().await } => result,
    };
    // A result already queued before logout must not reach the next account.
    let session = session
        .lock()
        .map_err(|_| "Gateway session is unavailable")?;
    let mut streams = streams
        .lock()
        .map_err(|_| "Gateway streams are unavailable")?;
    if !streams.is_current(&session, id, instance) {
        return Err("Gateway account session changed or stream is closed".into());
    }
    *activity
        .lock()
        .map_err(|_| "Gateway stream is unavailable")? = Instant::now();
    if result.is_none() || result.as_ref().is_some_and(Result::is_err) {
        if let Some(channels) = streams.remove_current(id, instance) {
            let _ = channels.cancel.send(());
        }
    }
    result.transpose()
}

async fn idle_expired(activity: Arc<Mutex<Instant>>, timeout: Duration) {
    loop {
        let elapsed = match activity.lock() {
            Ok(last_read) => last_read.elapsed(),
            Err(_) => return,
        };
        if elapsed >= timeout {
            return;
        }
        tokio::time::sleep(timeout - elapsed).await;
    }
}

pub async fn run_owned<T>(
    owner: RequestOwner,
    cancelled: oneshot::Receiver<()>,
    activity: Arc<Mutex<Instant>>,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    run_with_idle_timeout(owner, cancelled, activity, STREAM_IDLE_TIMEOUT, work).await
}

async fn run_with_idle_timeout<T>(
    owner: RequestOwner,
    cancelled: oneshot::Receiver<()>,
    activity: Arc<Mutex<Instant>>,
    timeout: Duration,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        _ = idle_expired(activity, timeout) => None,
        result = super::run_owned(owner, cancelled, work) => result,
    }
}

pub async fn forward_response(
    response: reqwest::Response,
    sender: &mpsc::Sender<StreamResult>,
) -> Result<(), String> {
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| "Gateway stream was interrupted")?;
        for bytes in chunk.chunks(STREAM_CHUNK_BYTES) {
            sender
                .send(Ok(HttpStreamItem::Chunk {
                    data: BASE64.encode(bytes),
                }))
                .await
                .map_err(|_| "Gateway stream consumer closed")?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "http_stream/tests.rs"]
mod tests;
