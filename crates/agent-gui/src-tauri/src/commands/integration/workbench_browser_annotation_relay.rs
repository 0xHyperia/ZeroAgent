use super::{browser_error, page_url, window_host, BrowserEvent, Tab, WebviewWindow, TABS};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationInput {
    png: String,
    url: String,
    text: String,
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    target: Option<String>,
    site_label: Option<String>,
    site_metadata: Option<String>,
    selected_text: Option<String>,
    site_control_changes: Option<String>,
}

impl BrowserAnnotationInput {
    fn valid(&self) -> bool {
        let in_view = |number: f64| (0.0..=1.0).contains(&number);
        let valid_bounds = match (self.width, self.height) {
            (None, None) => true,
            (Some(width), Some(height)) => {
                width > 0.0 && height > 0.0 && in_view(self.x + width) && in_view(self.y + height)
            }
            _ => false,
        };
        self.png.len() <= 16 * 1024 * 1024
            && self.png.starts_with("iVBORw0KGgo")
            && page_url(&self.url).is_some()
            && !self.text.trim().is_empty()
            && self.text.len() <= 12_000
            && self.target.as_ref().is_none_or(|value| value.len() <= 1024)
            && self
                .site_label
                .as_ref()
                .is_none_or(|value| value.len() <= 512)
            && self
                .site_metadata
                .as_ref()
                .is_none_or(|value| value.len() <= 3072)
            && self
                .selected_text
                .as_ref()
                .is_none_or(|value| value.len() <= 6144)
            && self
                .site_control_changes
                .as_ref()
                .is_none_or(|value| value.len() <= 8192)
            && in_view(self.x)
            && in_view(self.y)
            && valid_bounds
    }
}

pub(super) struct Pending {
    id: Uuid,
    reply: oneshot::Sender<Result<(), String>>,
}

pub(super) fn submit(
    window: &WebviewWindow,
    id: Uuid,
    annotations: Vec<BrowserAnnotationInput>,
    reply: oneshot::Sender<Result<(), String>>,
) {
    let tab = TABS.with_borrow(|tabs| tabs.get(&id).cloned());
    let Some(tab) =
        tab.filter(|tab| tab.detached_ready.get() && window_host::is_window_for(window, id, tab))
    else {
        let _ = reply.send(Err("The original browser tab is unavailable".into()));
        return;
    };
    if tab.pending_annotations.borrow().is_some() {
        let _ = reply.send(Err("Annotations are already being added".into()));
        return;
    }
    let request_id = Uuid::new_v4();
    tab.pending_annotations.replace(Some(Pending {
        id: request_id,
        reply,
    }));
    if tab
        .events
        .main
        .send(BrowserEvent::SubmitAnnotations {
            request_id,
            annotations,
        })
        .is_err()
    {
        settle(
            &tab,
            request_id,
            Some("The original conversation is unavailable".into()),
        );
    }
}

pub(super) fn settle(tab: &Tab, id: Uuid, error: Option<String>) {
    let mut pending = tab.pending_annotations.borrow_mut();
    if pending.as_ref().is_none_or(|pending| pending.id != id) {
        return;
    }
    if let Some(pending) = pending.take() {
        let result = error.map(|error| error.chars().take(240).collect());
        let _ = pending.reply.send(result.map_or(Ok(()), Err));
    }
}

#[tauri::command]
pub async fn workbench_browser_submit_annotations(
    window: WebviewWindow,
    id: Uuid,
    annotations: Vec<BrowserAnnotationInput>,
) -> Result<(), String> {
    if window.label() != window_host::window_label(id)
        || annotations.is_empty()
        || annotations.len() > 8
        || !annotations.iter().all(BrowserAnnotationInput::valid)
        || annotations
            .iter()
            .map(|annotation| annotation.png.len())
            .sum::<usize>()
            > 48 * 1024 * 1024
    {
        return Err("Invalid browser annotation batch".into());
    }
    let (reply, receive) = oneshot::channel();
    let caller = window.clone();
    window
        .run_on_main_thread(move || submit(&caller, id, annotations, reply))
        .map_err(browser_error)?;
    receive.await.map_err(browser_error)?
}
