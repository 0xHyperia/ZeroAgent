use super::{annotation, browser_cdp, browser_error, page_url, BrowserEvent, Tab, TABS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{cell::RefCell, collections::HashSet, rc::Rc};
use uuid::Uuid;
use wry::WebViewExtWindows;

const SITE_API: &str = include_str!("workbench_browser_site_annotation_api.js");

pub(super) fn install_api(tab: &Tab) {
    let _ = browser_cdp(
        &tab.view.webview(),
        "Runtime.evaluate",
        &serde_json::json!({"expression":SITE_API}),
        |_| {},
    );
}

thread_local! {
    static GRANTS: RefCell<HashSet<(Option<String>, String)>> = RefCell::new(HashSet::new());
}

fn origin(url: &str) -> Option<String> {
    let url = page_url(url)?;
    let host = url.host_str()?;
    if url.scheme() != "https" && !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

pub(super) fn current_grant(tab: &Tab) -> Option<String> {
    let state = tab.state.borrow();
    if state.loading || state.load_failed {
        return None;
    }
    let origin = origin(&state.url)?;
    GRANTS
        .with_borrow(|grants| grants.contains(&(tab.account_handle.clone(), origin.clone())))
        .then_some(origin)
}

pub(super) fn update(
    tab: &Tab,
    requested_origin: &str,
    enabled: Option<bool>,
) -> Result<(), String> {
    let state = tab.state.borrow();
    let Some(origin) = origin(&state.url)
        .filter(|origin| origin == requested_origin && !state.loading && !state.load_failed)
    else {
        return Err("Website annotation features are unavailable for this page".into());
    };
    drop(state);
    if let Some(enabled) = enabled {
        let key = (tab.account_handle.clone(), origin.clone());
        GRANTS.with_borrow_mut(|grants| {
            if enabled {
                if grants.len() >= 256 && !grants.contains(&key) {
                    return Err("Too many website annotation permissions".into());
                }
                grants.insert(key);
            } else {
                grants.remove(&key);
            }
            Ok::<(), String>(())
        })?;
        if enabled {
            install_api(tab);
        } else {
            let affected = TABS.with_borrow(|tabs| {
                tabs.values()
                    .filter(|other| other.account_handle == tab.account_handle)
                    .cloned()
                    .collect::<Vec<_>>()
            });
            for other in affected {
                if self::origin(&other.state.borrow().url).as_ref() == Some(&origin) {
                    reset_preview(&other);
                    if other.selecting_region.get() {
                        annotation::stop(&other);
                        let _ = other.events.send(BrowserEvent::AnnotationStopped);
                    }
                }
            }
        }
    }
    let _ = tab.events.send(BrowserEvent::SiteAnnotations {
        enabled: current_grant(tab).is_some(),
        origin,
    });
    Ok(())
}

pub(super) fn release_account(handle: &str) {
    GRANTS.with_borrow_mut(|grants| grants.retain(|(owner, _)| owner.as_deref() != Some(handle)));
}

pub(super) fn release_all() {
    GRANTS.with_borrow_mut(HashSet::clear);
}

pub(super) struct PreviewAnchor {
    token: Uuid,
    context: i64,
    url: String,
    needs_site_grant: bool,
    revision: u32,
}

impl PreviewAnchor {
    fn available(&self, tab: &Tab, token: Uuid) -> bool {
        let state = tab.state.borrow();
        self.token == token
            && self.url == state.url
            && !state.loading
            && !state.load_failed
            && (!self.needs_site_grant || current_grant(tab).is_some())
    }
}

pub(super) fn bind_preview(tab: &Tab, context: i64, granted: bool, result: &Value) {
    let selection = &result["result"]["value"];
    let needs_site_grant = selection["localStylePreview"] != true;
    if needs_site_grant && !granted {
        return;
    }
    let token = selection["sitePreviewToken"]
        .as_str()
        .and_then(|token| Uuid::parse_str(token).ok());
    if let Some(token) = token {
        tab.site_annotation_preview.replace(Some(PreviewAnchor {
            token,
            context,
            url: tab.state.borrow().url.clone(),
            needs_site_grant,
            revision: 0,
        }));
    }
}

pub(super) fn reset_preview(tab: &Tab) {
    if let Some(anchor) = tab.site_annotation_preview.borrow_mut().take() {
        if tab.site_preview_parked.get() && tab.view.set_visible(false).is_ok() {
            tab.site_preview_parked.set(false);
        }
        let _ = browser_cdp(
            &tab.view.webview(),
            "Runtime.evaluate",
            &serde_json::json!({"contextId":anchor.context, "expression":format!("globalThis.__zaSiteAnnotationPreview?.close('{}')", anchor.token)}),
            |_| {},
        );
        let _ = tab.events.send(BrowserEvent::SiteAnnotationPreviewClosed {
            token: anchor.token,
        });
    }
}

pub(super) fn can_park(tab: &Tab, token: Uuid) -> bool {
    tab.site_annotation_preview
        .borrow()
        .as_ref()
        .is_some_and(|anchor| anchor.available(tab, token))
}

pub(super) fn close_preview(tab: &Tab, token: Uuid) {
    if tab
        .site_annotation_preview
        .borrow()
        .as_ref()
        .is_some_and(|anchor| anchor.token == token)
    {
        reset_preview(tab);
    }
}

#[derive(Deserialize, Serialize)]
pub struct PreviewChange {
    callback: String,
    value: Value,
}

impl PreviewChange {
    fn valid(&self) -> bool {
        let mut bytes = self.callback.bytes();
        self.callback.len() <= 80
            && bytes
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic())
            && bytes.all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-')
            })
            && match &self.value {
                Value::Bool(_) => true,
                Value::String(text) => text.len() <= 2048 && !text.chars().any(char::is_control),
                Value::Number(number) => number
                    .as_f64()
                    .is_some_and(|number| number.abs() <= 10_000.0),
                _ => false,
            }
    }
}

pub(super) fn preview(
    tab: &Rc<Tab>,
    token: Uuid,
    revision: u32,
    values: Vec<PreviewChange>,
    original: bool,
) -> Result<(), String> {
    if values.len() > 12 || !values.iter().all(PreviewChange::valid) {
        return Err("Invalid website annotation control values".into());
    }
    let context = {
        let mut saved = tab.site_annotation_preview.borrow_mut();
        let anchor = saved
            .as_mut()
            .filter(|anchor| anchor.available(tab, token))
            .ok_or("The website annotation selection is unavailable")?;
        if revision <= anchor.revision {
            return Ok(());
        }
        anchor.revision = revision;
        anchor.context
    };
    let args =
        serde_json::to_string(&(token, revision, values, original)).map_err(browser_error)?;
    let expression = format!("globalThis.__zaSiteAnnotationPreview?.apply(...{args})");
    let weak = Rc::downgrade(tab);
    browser_cdp(&tab.view.webview(), "Runtime.evaluate", &serde_json::json!({"contextId":context, "expression":expression, "awaitPromise":true, "returnByValue":true}), move |result| {
        let Some(tab) = weak.upgrade().filter(|tab| is_current(tab, token, revision)) else { return; };
        if result.is_none_or(|result| result["result"]["value"] != true) {
            let _ = tab.events.send(BrowserEvent::SiteAnnotationPreview { token, revision, png: None });
            return;
        }
        let weak = Rc::downgrade(&tab);
        if browser_cdp(&tab.view.webview(), "Page.captureScreenshot", &serde_json::json!({"format":"png", "fromSurface":true, "captureBeyondViewport":false}), move |result| {
            if let Some(tab) = weak.upgrade().filter(|tab| is_current(tab, token, revision)) {
                let png = result.as_ref().and_then(|result| result["data"].as_str()).filter(|data| data.len() <= 16 * 1024 * 1024).map(str::to_owned);
                let _ = tab.events.send(BrowserEvent::SiteAnnotationPreview { token, revision, png });
            }
        }).is_err() {
            let _ = tab.events.send(BrowserEvent::SiteAnnotationPreview { token, revision, png: None });
        }
    }).map_err(browser_error)
}

fn is_current(tab: &Tab, token: Uuid, revision: u32) -> bool {
    tab.site_annotation_preview
        .borrow()
        .as_ref()
        .is_some_and(|anchor| anchor.revision == revision && anchor.available(tab, token))
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    site_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_metadata: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_suggested_comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_controls: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_preview_token: Option<Uuid>,
    #[serde(skip_serializing_if = "is_false")]
    site_custom_render: bool,
    #[serde(skip_serializing_if = "is_false")]
    local_style_preview: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl AnnotationContext {
    pub(super) fn from_selection(value: &Value, granted: bool) -> Self {
        let local_style_preview = value["localStylePreview"] == true;
        if !granted && !local_style_preview {
            return Self::default();
        }
        let read = |key, max| -> Option<String> {
            if !granted {
                return None;
            }
            let value: String = value
                .get(key)?
                .as_str()?
                .chars()
                .filter(|character| !character.is_control() || *character == '\n')
                .take(max)
                .collect();
            let value = value.trim().to_owned();
            (!value.is_empty()).then_some(value)
        };
        Self {
            site_label: read("siteLabel", 120),
            site_metadata: read("siteMetadata", 700),
            selected_text: read("selectedText", 1400),
            site_suggested_comment: read("siteSuggestedComment", 1200),
            site_controls: value
                .get("siteControls")
                .and_then(Value::as_str)
                .filter(|text| text.len() <= 8192)
                .map(str::to_owned),
            site_preview_token: value
                .get("sitePreviewToken")
                .and_then(Value::as_str)
                .and_then(|token| Uuid::parse_str(token).ok()),
            site_custom_render: granted && value["siteCustomRender"] == true,
            local_style_preview,
        }
    }
}
