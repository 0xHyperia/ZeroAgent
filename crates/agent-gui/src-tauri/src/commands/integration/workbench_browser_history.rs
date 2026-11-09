use super::{
    browser_cdp, page_url, take_pwstr, BrowserEvent, DevToolsProtocolEventReceivedEventHandler, Rc,
    Tab, PWSTR,
};
use serde::{Deserialize, Serialize};
use wry::WebViewExtWindows;

const MAX_ENTRIES: usize = 20;

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistory {
    entries: Vec<String>,
    index: Option<usize>,
}

fn safe_url(value: &str) -> Option<String> {
    let url = page_url(value)?;
    if url.as_str().len() > 2048 || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    Some(url.to_string())
}

pub(super) struct Timeline {
    history: BrowserHistory,
    traversal: Option<isize>,
    requested: Option<(String, Option<usize>)>,
    document_get: Option<String>,
    main_frame: Option<String>,
    restored: bool,
}

impl Timeline {
    pub(super) fn new(history: Option<BrowserHistory>) -> Self {
        let history = history
            .filter(|history| {
                history.entries.len() <= MAX_ENTRIES
                    && history
                        .entries
                        .iter()
                        .all(|url| safe_url(url).as_deref() == Some(url))
                    && history
                        .index
                        .is_none_or(|index| index < history.entries.len())
            })
            .unwrap_or_default();
        Self {
            restored: !history.entries.is_empty(),
            history,
            traversal: None,
            requested: None,
            document_get: None,
            main_frame: None,
        }
    }

    pub(super) fn initial_url(&self, fallback: &str) -> String {
        if self.restored {
            self.history
                .index
                .map(|index| self.history.entries[index].clone())
                .unwrap_or_default()
        } else {
            fallback.to_owned()
        }
    }

    pub(super) fn request(&mut self, url: &str, index: Option<usize>) {
        self.requested = safe_url(url).map(|url| (url, index));
        self.traversal = None;
        self.document_get = None;
    }

    pub(super) fn initial_request(&mut self, url: &str) {
        self.request(url, self.history.index);
    }

    pub(super) fn target(&self, step: isize) -> Option<(usize, String)> {
        let index = match self.history.index {
            Some(index) => index.checked_add_signed(step)?,
            None if step < 0 => self.history.entries.len().checked_sub(1)?,
            None => return None,
        };
        Some((index, self.history.entries.get(index)?.clone()))
    }

    pub(super) fn use_durable_traversal(&self) -> bool {
        self.restored && self.history.index.is_some()
    }

    pub(super) fn navigate_saved(&mut self, url: &str, index: usize) {
        self.restored = true;
        self.request(url, Some(index));
    }

    pub(super) fn native_step(&mut self, step: isize) {
        self.requested = None;
        self.document_get = None;
        self.traversal = Some(step);
    }

    fn finish(&mut self, url: &str, success: bool) {
        // A newly created WebView2 can finish its bootstrap about:blank after
        // the host has already queued the first durable navigation.
        if url.is_empty() {
            return;
        }
        let requested = self.requested.take();
        let traversing = self.traversal.take();
        let document_get = self.document_get.take();
        let Some(url) = success.then(|| safe_url(url)).flatten() else {
            self.history.index = None;
            return;
        };
        if let Some((_, Some(index))) = requested.as_ref().filter(|(target, _)| target == &url) {
            self.history.index = Some(*index);
            return;
        }
        if let Some((index, target)) = traversing.and_then(|step| self.target(step)) {
            if target == url {
                self.history.index = Some(index);
                return;
            }
        }
        if document_get.as_ref() != Some(&url)
            && requested.as_ref().map(|(url, _)| url) != Some(&url)
        {
            self.history.index = None;
            return;
        }
        if let Some(index) = self.history.index {
            self.history.entries.truncate(index + 1);
        }
        if self.history.entries.last() != Some(&url) {
            self.history.entries.push(url);
            if self.history.entries.len() > MAX_ENTRIES {
                self.history.entries.remove(0);
            }
        }
        self.history.index = self.history.entries.len().checked_sub(1);
    }

    pub(super) fn event(&self) -> BrowserEvent {
        BrowserEvent::History {
            history: self.history.clone(),
            durable_traversal: self.use_durable_traversal(),
        }
    }
}

pub(super) fn publish(tab: &Tab, url: &str, success: bool) {
    if page_url(url).is_some_and(|url| tab.loopback.borrow().ephemeral(&url)) {
        return;
    }
    let mut timeline = tab.timeline.borrow_mut();
    timeline.finish(url, success);
    let _ = tab.events.send(timeline.event());
}

pub(super) fn observe(tab: &Rc<Tab>) -> windows_core::Result<()> {
    let view = tab.view.webview();
    let receiver = unsafe {
        view.GetDevToolsProtocolEventReceiver(&windows_core::HSTRING::from(
            "Network.requestWillBeSent",
        ))?
    };
    let weak = Rc::downgrade(tab);
    let mut token = 0;
    unsafe {
        receiver.add_DevToolsProtocolEventReceived(
            &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let (Some(tab), Some(args)) = (weak.upgrade(), args) else {
                    return Ok(());
                };
                let mut json = PWSTR::null();
                args.ParameterObjectAsJson(&mut json)?;
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(&take_pwstr(json)) {
                    let mut timeline = tab.timeline.borrow_mut();
                    if event["type"] == "Document"
                        && timeline
                            .main_frame
                            .as_deref()
                            .is_some_and(|frame| event["frameId"] == frame)
                    {
                        timeline.document_get = if event["request"]["method"] == "GET" {
                            event["request"]["url"].as_str().and_then(safe_url)
                        } else {
                            None
                        };
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    let weak = Rc::downgrade(tab);
    browser_cdp(
        &view,
        "Page.getFrameTree",
        &serde_json::json!({}),
        move |result| {
            if let (Some(tab), Some(result)) = (weak.upgrade(), result) {
                tab.timeline.borrow_mut().main_frame = result["frameTree"]["frame"]["id"]
                    .as_str()
                    .map(str::to_owned);
            }
        },
    )?;
    browser_cdp(
        &view,
        "Network.enable",
        &serde_json::json!({"maxPostDataSize":0}),
        |_| {},
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_excludes_unsafe_or_unverified_addresses_and_does_not_replay() {
        let mut timeline = Timeline::new(None);
        let first = "https://example.test/first";
        let second = "https://example.test/second";
        timeline.request(first, None);
        timeline.finish("", true);
        timeline.finish(first, true);
        timeline.request(second, None);
        timeline.finish(second, true);
        timeline.native_step(-1);
        timeline.finish(first, true);
        assert_eq!(timeline.target(1), Some((1, second.to_owned())));
        let restored = Timeline::new(Some(timeline.history.clone()));
        assert_eq!(restored.initial_url(""), first);
        assert!(restored.use_durable_traversal());
        timeline.finish("https://example.test/post", true);
        assert_eq!(timeline.history.index, None);
        assert_eq!(timeline.history.entries, [first, second]);
        for unsafe_url in [
            "https://example.test/?token=secret",
            "https://example.test/#secret",
            "https://name:secret@example.test/",
            "file:///C:/secret",
        ] {
            assert!(safe_url(unsafe_url).is_none());
        }
    }
}
