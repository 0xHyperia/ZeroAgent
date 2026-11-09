use super::{browser_cdp, site_annotations, BrowserEvent, Tab};
use serde_json::{json, Value};
use std::rc::Rc;
use wry::WebViewExtWindows;

const SELECT: &str = include_str!("workbench_browser_selection.js");
const SITE_PREVIEW: &str = include_str!("workbench_browser_site_preview.js");

pub(super) fn stop(tab: &Rc<Tab>) {
    if !tab.selecting_region.replace(false) {
        return;
    }
    tab.annotation_version
        .set(tab.annotation_version.get().wrapping_add(1));
    if let Some(context_id) = tab.selection_context.take() {
        let _ = browser_cdp(
            &tab.view.webview(),
            "Runtime.evaluate",
            &json!({"contextId":context_id,"expression":"globalThis.__zaStopSelection?.()"}),
            |_| {},
        );
    }
}

fn selection_result(data: Value, granted: bool) -> Option<BrowserEvent> {
    let selection = data.get("result")?.get("value")?;
    if selection.is_null() {
        return Some(BrowserEvent::AnnotationStopped);
    }
    let unit = |name: &str| {
        selection
            .get(name)?
            .as_f64()
            .filter(|value| (0.0..=1.0).contains(value))
    };
    let (x, y) = (unit("x")?, unit("y")?);
    let context = site_annotations::AnnotationContext::from_selection(selection, granted);
    if let (Some(width), Some(height)) = (unit("width"), unit("height")) {
        if width <= 0.0 || height <= 0.0 || x + width > 1.000_001 || y + height > 1.000_001 {
            return None;
        }
        return Some(BrowserEvent::AnnotationRegion {
            x,
            y,
            width,
            height,
            context,
        });
    }
    let target = selection
        .get("target")?
        .as_str()?
        .chars()
        .take(256)
        .collect();
    Some(BrowserEvent::AnnotationTarget {
        x,
        y,
        target,
        context,
    })
}

fn finish(tab: &Rc<Tab>, result: Option<BrowserEvent>) {
    tab.selection_context.set(None);
    tab.selecting_region.set(false);
    let _ = tab
        .events
        .send(result.unwrap_or(BrowserEvent::AnnotationUnavailable));
}

pub(super) fn start(tab: &Rc<Tab>) -> windows_core::Result<()> {
    stop(tab);
    site_annotations::reset_preview(tab);
    if tab.visible.get() {
        let _ = tab.view.focus();
    }
    let version = tab.annotation_version.get().wrapping_add(1);
    tab.annotation_version.set(version);
    tab.selecting_region.set(true);
    let grant = site_annotations::current_grant(tab);
    if grant.is_some() {
        site_annotations::install_api(tab);
    }
    let weak = Rc::downgrade(tab);
    let result = browser_cdp(
        &tab.view.webview(),
        "Page.getFrameTree",
        &json!({}),
        move |data| {
            let Some(tab) = weak
                .upgrade()
                .filter(|tab| tab.annotation_version.get() == version)
            else {
                return;
            };
            let Some(frame) = data
                .as_ref()
                .and_then(|data| data["frameTree"]["frame"]["id"].as_str())
            else {
                finish(&tab, None);
                return;
            };
            let weak = Rc::downgrade(&tab);
            if browser_cdp(
            &tab.view.webview(),
            "Page.createIsolatedWorld",
            &json!({"frameId":frame,"worldName":"zeroagent-workspace-selection"}),
            move |data| {
                let Some(tab) = weak.upgrade().filter(|tab| tab.annotation_version.get() == version) else {
                    return;
                };
                let Some(context) = data.and_then(|data| data["executionContextId"].as_i64()) else {
                    finish(&tab, None);
                    return;
                };
                tab.selection_context.set(Some(context));
                let expression = format!("{SELECT}({}, {SITE_PREVIEW})", grant.is_some());
                let weak = Rc::downgrade(&tab);
                if browser_cdp(
                    &tab.view.webview(),
                    "Runtime.evaluate",
                    &json!({"contextId":context,"expression":expression,"awaitPromise":true,"returnByValue":true}),
                    move |result| {
                        if let Some(tab) = weak.upgrade().filter(|tab| tab.annotation_version.get() == version) {
                            let current = site_annotations::current_grant(&tab);
                            let allowed = grant.is_some() && grant == current;
                            if let Some(result) = result.as_ref() {
                                site_annotations::bind_preview(&tab, context, allowed, result);
                            }
                            finish(&tab, result.and_then(|data| selection_result(data, allowed)));
                        }
                    },
                ).is_err() {
                    finish(&tab, None);
                }
            },
        ).is_err() {
            finish(&tab, None);
        }
        },
    );
    if result.is_err() {
        finish(tab, None);
    }
    result
}
