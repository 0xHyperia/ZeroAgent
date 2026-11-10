//! The workbench browser is an independent WebView2 child, with no Tauri webview,
//! initialization scripts, custom protocol, or page-to-host message handler.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use uuid::Uuid;
use webview2_com::{
    take_pwstr, CallDevToolsProtocolMethodCompletedHandler,
    DevToolsProtocolEventReceivedEventHandler, DocumentTitleChangedEventHandler,
    DownloadStartingEventHandler, FaviconChangedEventHandler,
    FindActiveMatchIndexChangedEventHandler, FindMatchCountChangedEventHandler,
    FindStartCompletedHandler, GetFaviconCompletedHandler, HistoryChangedEventHandler,
    LaunchingExternalUriSchemeEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Environment15, ICoreWebView2Settings3, ICoreWebView2Settings4,
        ICoreWebView2_15, ICoreWebView2_16, ICoreWebView2_18, ICoreWebView2_22, ICoreWebView2_28,
        ICoreWebView2_4, ICoreWebView2_9, COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,
        COREWEBVIEW2_PERMISSION_STATE_DENY, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
        COREWEBVIEW2_WEB_ERROR_STATUS, COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    },
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler, SourceChangedEventHandler,
    WebResourceRequestedEventHandler,
};
use windows_core::{Interface, BOOL, PWSTR};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT};
use wry::{
    dpi::{PhysicalPosition, PhysicalSize},
    Rect, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows,
};

use crate::services::kbrain_backend::KBrainBackendState;

#[path = "workbench_browser_history.rs"]
mod history;
#[path = "workbench_browser_window.rs"]
mod window_host;
pub use history::BrowserHistory;

const MAX_TABS: usize = 32;
static DOCUMENT_EPOCH: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static TABS: RefCell<HashMap<Uuid, Rc<Tab>>> = RefCell::new(HashMap::new());
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl BrowserBounds {
    fn checked_rect(self, parent: PhysicalSize<u32>) -> Option<Rect> {
        let x = u32::try_from(self.x).ok()?;
        let y = u32::try_from(self.y).ok()?;
        let width = self.width.min(parent.width.saturating_sub(x));
        let height = self.height.min(parent.height.saturating_sub(y));
        (width > 0 && height > 0).then_some(Rect {
            position: PhysicalPosition::new(self.x, self.y).into(),
            size: PhysicalSize::new(width, height).into(),
        })
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
pub struct BrowserViewport {
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserColorScheme {
    Light,
    Dark,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserChromeLocale {
    En,
    Zh,
}

impl BrowserViewport {
    fn valid(self) -> bool {
        (240..=4096).contains(&self.width)
            && (160..=4096).contains(&self.height)
            && self.scale > 0.0
            && self.scale <= 1.0
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrowserAction {
    Layout {
        bounds: Option<BrowserBounds>,
        viewport: Option<BrowserViewport>,
        site_preview_token: Option<Uuid>,
        version: u32,
    },
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Stop,
    Reload,
    Zoom {
        factor: f64,
    },
    Theme {
        scheme: BrowserColorScheme,
    },
    Find {
        text: String,
    },
    FindNext {
        backwards: bool,
    },
    StopFind,
    Print,
    Downloads,
    Detach {
        locale: BrowserChromeLocale,
        scheme: BrowserColorScheme,
    },
    ReturnToWorkspace,
    OpenExternal,
    SelectRegion {
        enabled: bool,
    },
    SiteAnnotations {
        origin: String,
        enabled: Option<bool>,
    },
    PreviewSiteAnnotation {
        token: Uuid,
        revision: u32,
        values: Vec<site_annotations::PreviewChange>,
        original: bool,
    },
    CloseSiteAnnotation {
        token: Uuid,
    },
    SettleDetachedAnnotations {
        request_id: Uuid,
        error: Option<String>,
    },
    Screenshot {
        to_clipboard: bool,
    },
    Close,
}

#[derive(Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    url: String,
    title: String,
    favicon_data_url: Option<String>,
    loading: bool,
    load_failed: bool,
    can_go_back: bool,
    can_go_forward: bool,
    has_downloads: bool,
    find_count: i32,
    find_index: i32,
    ssh_loopback: bool,
    gateway_display: Option<String>,
    ephemeral_address: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserEvent {
    State {
        state: BrowserState,
    },
    OpenTab {
        url: String,
        foreground: bool,
        detached: bool,
    },
    Screenshot {
        png: String,
    },
    Copied,
    CaptureFailed,
    ViewportUnavailable,
    AnnotationTarget {
        x: f64,
        y: f64,
        target: String,
        #[serde(flatten)]
        context: site_annotations::AnnotationContext,
    },
    AnnotationRegion {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        #[serde(flatten)]
        context: site_annotations::AnnotationContext,
    },
    AnnotationStopped,
    AnnotationUnavailable,
    SiteAnnotations {
        origin: String,
        enabled: bool,
    },
    SiteAnnotationPreview {
        token: Uuid,
        revision: u32,
        png: Option<String>,
    },
    SiteAnnotationPreviewClosed {
        token: Uuid,
    },
    SubmitAnnotations {
        #[serde(rename = "requestId")]
        request_id: Uuid,
        annotations: Vec<annotation_relay::BrowserAnnotationInput>,
    },
    WindowState {
        detached: bool,
    },
    WindowUnavailable,
    History {
        history: BrowserHistory,
        #[serde(rename = "durableTraversal")]
        durable_traversal: bool,
    },
}

#[derive(Clone)]
struct BrowserChannels {
    main: Channel<BrowserEvent>,
    detached: Arc<Mutex<Option<Channel<BrowserEvent>>>>,
}

impl BrowserChannels {
    fn send(&self, event: BrowserEvent) -> tauri::Result<()> {
        if let Some(detached) = self.detached.lock().ok().and_then(|entry| entry.clone()) {
            if let BrowserEvent::OpenTab {
                url, foreground, ..
            } = &event
            {
                return self.main.send(BrowserEvent::OpenTab {
                    url: url.clone(),
                    foreground: *foreground,
                    detached: true,
                });
            }
            if matches!(
                event,
                BrowserEvent::State { .. } | BrowserEvent::History { .. }
            ) {
                let _ = self.main.send(event.clone());
            }
            return detached.send(event);
        }
        self.main.send(event)
    }
}

struct Tab {
    view: WebView,
    profile_dir: PathBuf,
    extension_surface: RefCell<extensions::TabSurface>,
    account_handle: Option<String>,
    project_path_key: Option<String>,
    loopback: Rc<RefCell<loopback::Loopback>>,
    loopback_guard: Cell<bool>,
    visible: Cell<bool>,
    site_preview_parked: Cell<bool>,
    layout_version: Cell<u32>,
    viewport: Cell<Option<BrowserViewport>>,
    selecting_region: Cell<bool>,
    selection_context: Cell<Option<i64>>,
    annotation_version: Cell<u64>,
    site_annotation_preview: RefCell<Option<site_annotations::PreviewAnchor>>,
    navigation_id: Cell<Option<u64>>,
    pending_annotations: RefCell<Option<annotation_relay::Pending>>,
    state: Rc<RefCell<BrowserState>>,
    events: BrowserChannels,
    detached: RefCell<Option<WebviewWindow>>,
    detached_ready: Cell<bool>,
    detached_attempt: Cell<u32>,
    detached_starting: Cell<bool>,
    detached_layout_version: Cell<u32>,
    timeline: RefCell<history::Timeline>,
}

#[path = "workbench_browser_annotation.rs"]
mod annotation;

impl Drop for Tab {
    fn drop(&mut self) {
        self.loopback.borrow_mut().retire();
    }
}
#[path = "workbench_browser_annotation_relay.rs"]
pub mod annotation_relay;
#[path = "workbench_browser_extensions.rs"]
pub mod extensions;
#[path = "workbench_browser_loopback.rs"]
pub mod loopback;
#[path = "workbench_browser_site_annotations.rs"]
mod site_annotations;

fn page_url(input: &str) -> Option<Url> {
    if input.len() > 16_384 {
        return None;
    }
    let url = Url::parse(input).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

fn publish_state(
    view: &ICoreWebView2,
    state: &RefCell<BrowserState>,
    events: &BrowserChannels,
    loopback: &RefCell<loopback::Loopback>,
    update: impl FnOnce(&mut BrowserState),
) -> windows_core::Result<()> {
    let mut can_go_back = BOOL::default();
    let mut can_go_forward = BOOL::default();
    let mut url = PWSTR::null();
    let mut title = PWSTR::null();
    let (url, title) = unsafe {
        view.CanGoBack(&mut can_go_back)?;
        view.CanGoForward(&mut can_go_forward)?;
        view.Source(&mut url)?;
        let url = take_pwstr(url);
        view.DocumentTitle(&mut title)?;
        (url, take_pwstr(title))
    };
    let mut last = state.borrow_mut();
    let mut next = last.clone();
    next.can_go_back = can_go_back.as_bool();
    next.can_go_forward = can_go_forward.as_bool();
    let url = page_url(&url);
    let loopback = loopback.borrow();
    next.ssh_loopback = loopback.active();
    next.gateway_display = url.as_ref().and_then(|url| loopback.gateway_display(url));
    next.ephemeral_address = url.as_ref().is_some_and(|url| loopback.ephemeral(url));
    if url.as_ref().map(Url::origin) != page_url(&last.url).as_ref().map(Url::origin) {
        next.favicon_data_url = None;
    }
    next.url = url.map_or_else(String::new, |url| url.to_string());
    next.title = title.chars().take(512).collect();
    update(&mut next);
    if *last != next {
        *last = next.clone();
        let _ = events.send(BrowserEvent::State { state: next });
    }
    Ok(())
}

fn observe_favicon(tab: &Rc<Tab>, view: &ICoreWebView2) -> windows_core::Result<()> {
    let Ok(favicon_view) = view.cast::<ICoreWebView2_15>() else {
        return Ok(());
    };
    let tab = Rc::downgrade(tab);
    let generation = Rc::new(Cell::new(0_u64));
    let mut token = 0;
    unsafe {
        favicon_view.add_FaviconChanged(
            &FaviconChangedEventHandler::create(Box::new(move |sender, _| {
                let (Some(tab), Some(view)) = (tab.upgrade(), sender) else {
                    return Ok(());
                };
                let favicon_view = view.cast::<ICoreWebView2_15>()?;
                let mut source = PWSTR::null();
                view.Source(&mut source)?;
                let source = take_pwstr(source);
                let Some(url) = page_url(&source) else {
                    return Ok(());
                };
                if tab.loopback.borrow().ephemeral(&url) {
                    return Ok(());
                }
                let request = generation.get().wrapping_add(1);
                generation.set(request);
                let generation = Rc::clone(&generation);
                let tab = Rc::downgrade(&tab);
                let handler =
                    GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
                        let Some(tab) = tab.upgrade().filter(|_| generation.get() == request)
                        else {
                            return Ok(());
                        };
                        let mut current = PWSTR::null();
                        view.Source(&mut current)?;
                        if take_pwstr(current) != source {
                            return Ok(());
                        }
                        let icon = result.ok().and_then(|_| stream).and_then(|stream| {
                            const MAX_ICON_BYTES: usize = 64 * 1024;
                            let mut png = vec![0_u8; MAX_ICON_BYTES + 1];
                            let mut length = 0;
                            stream
                                .Read(png.as_mut_ptr().cast(), png.len() as u32, Some(&mut length))
                                .ok()
                                .ok()?;
                            let length = length as usize;
                            (length <= MAX_ICON_BYTES
                                && png[..length].starts_with(b"\x89PNG\r\n\x1a\n"))
                            .then(|| {
                                format!(
                                    "data:image/png;base64,{}",
                                    base64::engine::general_purpose::STANDARD
                                        .encode(&png[..length])
                                )
                            })
                        });
                        publish_state(&view, &tab.state, &tab.events, &tab.loopback, |state| {
                            state.favicon_data_url = icon;
                        })
                    }));
                favicon_view.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &handler)
            })),
            &mut token,
        )
    }
}

fn browser_cdp(
    view: &ICoreWebView2,
    method: &str,
    parameters: &serde_json::Value,
    complete: impl FnOnce(Option<serde_json::Value>) + 'static,
) -> windows_core::Result<()> {
    let callback =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            complete(result.ok().and_then(|()| serde_json::from_str(&json).ok()));
            Ok(())
        }));
    unsafe {
        view.CallDevToolsProtocolMethod(
            &windows_core::HSTRING::from(method),
            &windows_core::HSTRING::from(parameters.to_string()),
            &callback,
        )
    }
}

fn register_browser_events(tab: &Rc<Tab>) -> windows_core::Result<()> {
    let view = tab.view.webview();
    let mut token = 0;
    // WebView2 callbacks and commands both execute on the parent UI thread.
    unsafe {
        let settings = view.Settings()?;
        settings.SetIsWebMessageEnabled(false)?;
        settings.SetAreHostObjectsAllowed(false)?;
        settings.SetAreDevToolsEnabled(false)?;
        settings.SetIsStatusBarEnabled(false)?;
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
            settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
        }
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings4>() {
            settings.SetIsPasswordAutosaveEnabled(false)?;
            settings.SetIsGeneralAutofillEnabled(false)?;
        }
        view.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        if let Ok(view) = view.cast::<ICoreWebView2_18>() {
            view.add_LaunchingExternalUriScheme(
                &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        // Wry denies new windows by default. Our separate handler only informs the
        // trusted tab strip of user-initiated links and never exposes an opener.
        let events = tab.events.clone();
        let weak_tab = Rc::downgrade(tab);
        view.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    args.SetHandled(true)?;
                    let mut user_initiated = BOOL::default();
                    args.IsUserInitiated(&mut user_initiated)?;
                    if user_initiated.as_bool() {
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        if let Some(url) = page_url(&take_pwstr(uri)) {
                            if weak_tab.upgrade().is_some_and(|tab| {
                                let scope = tab.loopback.borrow();
                                scope.ephemeral(&url)
                                    || scope.active() && loopback::loopback_host(&url).is_some()
                            }) {
                                return Ok(());
                            }
                            let background = GetKeyState(VK_CONTROL as i32) < 0
                                && GetKeyState(VK_SHIFT as i32) >= 0;
                            let _ = events.send(BrowserEvent::OpenTab {
                                url: url.to_string(),
                                foreground: !background,
                                detached: false,
                            });
                        }
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;

        if let Ok(requests) = view.cast::<ICoreWebView2_22>() {
            let weak_tab = Rc::downgrade(tab);
            requests.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &windows_core::HSTRING::from("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?;
            view.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    let (Some(tab), Some(args)) = (weak_tab.upgrade(), args) else {
                        return Ok(());
                    };
                    if !tab.loopback.borrow().guard_needed() {
                        return Ok(());
                    }
                    let mut uri = PWSTR::null();
                    args.Request()?.Uri(&mut uri)?;
                    if Url::parse(&take_pwstr(uri))
                        .is_ok_and(|url| !tab.loopback.borrow().permits(&url))
                    {
                        let response = tab.view.environment().CreateWebResourceResponse(
                            None,
                            403,
                            &windows_core::HSTRING::from("Loopback access denied"),
                            &windows_core::HSTRING::from("Cache-Control: no-store"),
                        )?;
                        args.SetResponse(&response)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            tab.loopback_guard.set(true);
        }

        let state = Rc::clone(&tab.state);
        let loopback = Rc::clone(&tab.loopback);
        let events = tab.events.clone();
        let weak_tab = Rc::downgrade(tab);
        view.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |sender, args| {
                if let (Some(view), Some(args)) = (sender, args) {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    if uri != "about:blank" && page_url(&uri).is_none() {
                        args.SetCancel(true)?;
                        return Ok(());
                    }
                    if let Some(tab) = weak_tab.upgrade() {
                        if page_url(&uri).is_some_and(|url| !tab.loopback.borrow().permits(&url)) {
                            args.SetCancel(true)?;
                            return Ok(());
                        }
                        tab.loopback
                            .borrow_mut()
                            .close_gateway_on_navigation(page_url(&uri).as_ref());
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        tab.navigation_id.set(Some(id));
                        extensions::clear_tab_surface(&tab);
                        site_annotations::reset_preview(&tab);
                        if tab.selecting_region.get() {
                            annotation::stop(&tab);
                            let _ = tab.events.send(BrowserEvent::AnnotationStopped);
                        } else {
                            tab.annotation_version
                                .set(tab.annotation_version.get().wrapping_add(1));
                        }
                    }
                    publish_state(&view, &state, &events, &loopback, |state| {
                        state.loading = true;
                        state.load_failed = false;
                    })?;
                }
                Ok(())
            })),
            &mut token,
        )?;

        let state = Rc::clone(&tab.state);
        let loopback = Rc::clone(&tab.loopback);
        let events = tab.events.clone();
        let weak_tab = Rc::downgrade(tab);
        view.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                if let (Some(view), Some(args)) = (sender, args) {
                    let Some(tab) = weak_tab.upgrade() else {
                        return Ok(());
                    };
                    let mut id = 0;
                    args.NavigationId(&mut id)?;
                    if tab.navigation_id.get() != Some(id) {
                        return Ok(());
                    }
                    tab.navigation_id.set(None);
                    let mut success = BOOL::default();
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.IsSuccess(&mut success)?;
                    args.WebErrorStatus(&mut status)?;
                    if status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                        publish_state(&view, &state, &events, &loopback, |state| {
                            state.loading = false;
                            state.load_failed = !success.as_bool();
                        })?;
                        history::publish(&tab, &state.borrow().url, success.as_bool());
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;

        macro_rules! observe {
            ($add:ident, $handler:ident) => {{
                let state = Rc::clone(&tab.state);
                let loopback = Rc::clone(&tab.loopback);
                let events = tab.events.clone();
                view.$add(
                    &$handler::create(Box::new(move |sender, _| {
                        if let Some(view) = sender {
                            publish_state(&view, &state, &events, &loopback, |_| {})?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
            }};
        }
        observe!(add_SourceChanged, SourceChangedEventHandler);
        observe!(add_HistoryChanged, HistoryChangedEventHandler);
        observe!(add_DocumentTitleChanged, DocumentTitleChangedEventHandler);
        // The guest supplies icon bytes. The application renderer never fetches a site URL for a tab icon.
        let _ = observe_favicon(tab, &view);
        if let Ok(downloads) = view.cast::<ICoreWebView2_4>() {
            let state = Rc::clone(&tab.state);
            let loopback = Rc::clone(&tab.loopback);
            let events = tab.events.clone();
            // WebView2 owns the download UI and destination. No downloaded path
            // or content crosses into the ZeroAgent host.
            downloads.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |view, _| {
                    if let Some(view) = view {
                        publish_state(&view, &state, &events, &loopback, |state| {
                            state.has_downloads = true
                        })?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        if let Ok(find) = view.cast::<ICoreWebView2_28>().and_then(|view| view.Find()) {
            macro_rules! observe_find {
                ($add:ident, $handler:ident) => {{
                    let state = Rc::clone(&tab.state);
                    let events = tab.events.clone();
                    find.$add(
                        &$handler::create(Box::new(move |find, _| {
                            if let Some(find) = find {
                                let mut state = state.borrow_mut();
                                find.ActiveMatchIndex(&mut state.find_index)?;
                                find.MatchCount(&mut state.find_count)?;
                                let _ = events.send(BrowserEvent::State {
                                    state: state.clone(),
                                });
                            }
                            Ok(())
                        })),
                        &mut token,
                    )?;
                }};
            }
            observe_find!(
                add_ActiveMatchIndexChanged,
                FindActiveMatchIndexChangedEventHandler
            );
            observe_find!(add_MatchCountChanged, FindMatchCountChangedEventHandler);
        }
    }
    Ok(())
}

fn browser_error(_: impl std::fmt::Display) -> String {
    "The embedded browser could not complete this action".into()
}

fn open_tab(
    window: &WebviewWindow,
    id: Uuid,
    url: &str,
    profile_dir: PathBuf,
    account_handle: Option<String>,
    events: Channel<BrowserEvent>,
    epoch: u64,
    saved_history: Option<BrowserHistory>,
    project_path_key: Option<String>,
) -> Result<(), String> {
    if DOCUMENT_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("The browser workspace has changed".into());
    }
    if TABS.with_borrow(|tabs| tabs.contains_key(&id) || tabs.len() >= MAX_TABS) {
        return Err("Too many browser tabs are open".into());
    }
    let timeline = history::Timeline::new(saved_history);
    let initial = timeline.initial_url(url);
    let url = if initial.is_empty() {
        None
    } else {
        Some(page_url(&initial).ok_or("Only HTTP and HTTPS pages can be opened")?)
    };
    let mut context = WebContext::new(Some(profile_dir.clone()));
    let view = WebViewBuilder::new_with_web_context(&mut context)
        .with_browser_extensions_enabled(true)
        .with_visible(false)
        .with_focused(false)
        .with_devtools(false)
        .with_bounds(Rect::default())
        .build_as_child(window)
        .map_err(browser_error)?;
    let tab = Rc::new(Tab {
        view,
        profile_dir,
        extension_surface: RefCell::new(extensions::TabSurface::default()),
        account_handle,
        project_path_key,
        loopback: Rc::new(RefCell::new(loopback::Loopback::default())),
        loopback_guard: Cell::new(false),
        visible: Cell::new(false),
        site_preview_parked: Cell::new(false),
        layout_version: Cell::new(0),
        viewport: Cell::new(None),
        selecting_region: Cell::new(false),
        selection_context: Cell::new(None),
        annotation_version: Cell::new(0),
        site_annotation_preview: RefCell::new(None),
        navigation_id: Cell::new(None),
        pending_annotations: RefCell::new(None),
        state: Rc::new(RefCell::new(BrowserState {
            find_index: -1,
            ..BrowserState::default()
        })),
        events: BrowserChannels {
            main: events,
            detached: Arc::new(Mutex::new(None)),
        },
        detached: RefCell::new(None),
        detached_ready: Cell::new(false),
        detached_attempt: Cell::new(0),
        detached_starting: Cell::new(false),
        detached_layout_version: Cell::new(0),
        timeline: RefCell::new(timeline),
    });
    register_browser_events(&tab).map_err(browser_error)?;
    let _ = history::observe(&tab);
    let _ = tab.events.send(tab.timeline.borrow().event());
    if let Some(url) = url {
        tab.timeline.borrow_mut().initial_request(url.as_str());
        tab.view.load_url(url.as_str()).map_err(browser_error)?;
    }
    if DOCUMENT_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("The browser workspace has changed".into());
    }
    TABS.with_borrow_mut(|tabs| tabs.insert(id, tab));
    Ok(())
}

fn step_history(tab: &Tab, step: isize) -> Result<(), String> {
    let native = tab.view.webview();
    let mut native_available = BOOL::default();
    unsafe {
        if step < 0 {
            native.CanGoBack(&mut native_available)
        } else {
            native.CanGoForward(&mut native_available)
        }
    }
    .map_err(browser_error)?;
    let mut timeline = tab.timeline.borrow_mut();
    if native_available.as_bool() && !timeline.use_durable_traversal() {
        timeline.native_step(step);
        drop(timeline);
        unsafe {
            if step < 0 {
                native.GoBack()
            } else {
                native.GoForward()
            }
        }
        .map_err(browser_error)?;
    } else if let Some((index, url)) = timeline.target(step) {
        timeline.navigate_saved(&url, index);
        drop(timeline);
        tab.view.load_url(&url).map_err(browser_error)?;
    }
    Ok(())
}

fn update_tab(window: &WebviewWindow, id: Uuid, action: BrowserAction) -> Result<(), String> {
    let is_workspace = window.label() == crate::MAIN_WINDOW_LABEL;
    if matches!(action, BrowserAction::Close) {
        if !is_workspace {
            return Err("Close this browser through its workspace tab".into());
        }
        if let Some(tab) = TABS.with_borrow_mut(|tabs| tabs.remove(&id)) {
            window_host::retire(tab);
        }
        return Ok(());
    }
    let tab = TABS
        .with_borrow(|tabs| tabs.get(&id).cloned())
        .ok_or("This browser tab has closed")?;
    let is_detached = tab.detached_ready.get();
    if !is_workspace && (!is_detached || !window_host::is_window_for(window, id, &tab)) {
        return Err("This window does not own the browser tab".into());
    }
    if let BrowserAction::SettleDetachedAnnotations { request_id, error } = action {
        if !is_workspace {
            return Err("Only the workspace can settle annotations".into());
        }
        annotation_relay::settle(&tab, request_id, error);
        return Ok(());
    }
    if is_detached
        && is_workspace
        && !matches!(
            action,
            BrowserAction::Detach { .. } | BrowserAction::ReturnToWorkspace
        )
    {
        return Ok(());
    }
    let native = tab.view.webview();
    match action {
        BrowserAction::Layout {
            bounds,
            viewport,
            site_preview_token,
            version,
        } => {
            let layout_version = if is_workspace {
                &tab.layout_version
            } else {
                &tab.detached_layout_version
            };
            if version <= layout_version.get() {
                return Ok(());
            }
            if viewport.is_some_and(|viewport| !viewport.valid()) {
                return Err("Invalid browser viewport".into());
            }
            if viewport != tab.viewport.get() {
                let (method, params) = match viewport {
                    Some(viewport) => (
                        "Emulation.setDeviceMetricsOverride",
                        serde_json::json!({
                            "width": viewport.width,
                            "height": viewport.height,
                            "deviceScaleFactor": 1,
                            "mobile": false,
                            "scale": viewport.scale,
                        })
                        .to_string(),
                    ),
                    None => ("Emulation.clearDeviceMetricsOverride", "{}".into()),
                };
                let weak_tab = Rc::downgrade(&tab);
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, _| {
                        if result.is_err() {
                            if let Some(tab) = weak_tab
                                .upgrade()
                                .filter(|tab| tab.viewport.get() == viewport)
                            {
                                let _ = tab.events.send(BrowserEvent::ViewportUnavailable);
                            }
                        }
                        Ok(())
                    },
                ));
                unsafe {
                    native.CallDevToolsProtocolMethod(
                        &windows_core::HSTRING::from(method),
                        &windows_core::HSTRING::from(params),
                        &callback,
                    )
                }
                .map_err(browser_error)?;
                tab.viewport.set(viewport);
            }
            let parent = window.inner_size().map_err(browser_error)?;
            let bounds = bounds.and_then(|bounds| bounds.checked_rect(parent));
            if let Some(bounds) = bounds {
                tab.view.set_bounds(bounds).map_err(browser_error)?;
            }
            let parked = bounds.is_none()
                && (tab.visible.get() || tab.site_preview_parked.get())
                && site_preview_token.is_some_and(|token| site_annotations::can_park(&tab, token));
            if parked && !tab.site_preview_parked.get() {
                // WebView2 suspends rendering when hidden. The child remains clipped by its
                // parent while parked, so its native surface cannot cover the annotation editor.
                let mut bounds = tab.view.bounds().map_err(browser_error)?;
                let width = bounds.size.to_physical::<i32>(1.0).width;
                bounds.position = PhysicalPosition::new(-width, 0).into();
                tab.view.set_bounds(bounds).map_err(browser_error)?;
            }
            let controller_visible = bounds.is_some() || parked;
            if controller_visible != (tab.visible.get() || tab.site_preview_parked.get()) {
                tab.view
                    .set_visible(controller_visible)
                    .map_err(browser_error)?;
            }
            tab.visible.set(bounds.is_some());
            tab.site_preview_parked.set(parked);
            layout_version.set(version);
        }
        BrowserAction::Navigate { url } => {
            let url = page_url(&url).ok_or("Only HTTP and HTTPS pages can be opened")?;
            if !tab.loopback.borrow().permits(&url) {
                return Err("Choose the SSH loopback address again".into());
            }
            tab.timeline.borrow_mut().request(url.as_str(), None);
            tab.view.load_url(url.as_str()).map_err(browser_error)?;
        }
        BrowserAction::Back => step_history(&tab, -1)?,
        BrowserAction::Forward => step_history(&tab, 1)?,
        BrowserAction::Stop => {
            unsafe { native.Stop() }.map_err(browser_error)?;
            publish_state(&native, &tab.state, &tab.events, &tab.loopback, |state| {
                state.loading = false
            })
            .map_err(browser_error)?;
        }
        BrowserAction::Reload => tab.view.reload().map_err(browser_error)?,
        BrowserAction::Zoom { factor } => {
            if !(0.25..=3.0).contains(&factor) {
                return Err("Invalid browser zoom".into());
            }
            tab.view.zoom(factor).map_err(browser_error)?;
        }
        BrowserAction::Theme { scheme } => {
            let value = match scheme {
                BrowserColorScheme::Light => "light",
                BrowserColorScheme::Dark => "dark",
            };
            browser_cdp(
                &native,
                "Emulation.setEmulatedMedia",
                &serde_json::json!({
                    "features": [{"name": "prefers-color-scheme", "value": value}]
                }),
                |_| {},
            )
            .map_err(browser_error)?;
        }
        BrowserAction::Find { text } => unsafe {
            let find = native
                .cast::<ICoreWebView2_28>()
                .and_then(|view| view.Find())
                .map_err(browser_error)?;
            if text.is_empty() {
                find.Stop().map_err(browser_error)?;
            } else {
                let options = tab
                    .view
                    .environment()
                    .cast::<ICoreWebView2Environment15>()
                    .and_then(|environment| environment.CreateFindOptions())
                    .map_err(browser_error)?;
                let term = windows_core::HSTRING::from(text.chars().take(1024).collect::<String>());
                options.SetFindTerm(&term).map_err(browser_error)?;
                find.Start(
                    &options,
                    &FindStartCompletedHandler::create(Box::new(|_| Ok(()))),
                )
                .map_err(browser_error)?;
            }
        },
        BrowserAction::FindNext { backwards } => unsafe {
            let find = native
                .cast::<ICoreWebView2_28>()
                .and_then(|view| view.Find())
                .map_err(browser_error)?;
            if backwards {
                find.FindPrevious()
            } else {
                find.FindNext()
            }
            .map_err(browser_error)?;
        },
        BrowserAction::StopFind => unsafe {
            native
                .cast::<ICoreWebView2_28>()
                .and_then(|view| view.Find())
                .and_then(|find| find.Stop())
                .map_err(browser_error)?;
        },
        BrowserAction::Print => unsafe {
            native
                .cast::<ICoreWebView2_16>()
                .and_then(|view| view.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER))
                .map_err(browser_error)?;
        },
        BrowserAction::Downloads => unsafe {
            let downloads = native.cast::<ICoreWebView2_9>().map_err(browser_error)?;
            let mut open = BOOL::default();
            downloads
                .IsDefaultDownloadDialogOpen(&mut open)
                .map_err(browser_error)?;
            if open.as_bool() {
                downloads.CloseDefaultDownloadDialog()
            } else {
                downloads.OpenDefaultDownloadDialog()
            }
            .map_err(browser_error)?;
        },
        BrowserAction::Detach { locale, scheme } if is_workspace => {
            window_host::detach(window, id, &tab, locale, scheme)?
        }
        BrowserAction::Detach { .. } => return Err("This browser is already in a window".into()),
        BrowserAction::ReturnToWorkspace => window_host::return_to_workspace(window, &tab)?,
        BrowserAction::OpenExternal => {
            let url = page_url(&tab.state.borrow().url).ok_or("No browser page is open")?;
            if tab.loopback.borrow().ephemeral(&url) {
                return Err("This SSH address belongs to the browser tab".into());
            }
            window
                .app_handle()
                .opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(browser_error)?;
        }
        BrowserAction::SiteAnnotations { origin, enabled } => {
            site_annotations::update(&tab, &origin, enabled)?
        }
        BrowserAction::PreviewSiteAnnotation {
            token,
            revision,
            values,
            original,
        } => site_annotations::preview(&tab, token, revision, values, original)?,
        BrowserAction::CloseSiteAnnotation { token } => {
            site_annotations::close_preview(&tab, token)
        }
        BrowserAction::SelectRegion { enabled } => {
            if enabled {
                annotation::start(&tab).map_err(browser_error)?;
            } else {
                annotation::stop(&tab);
            }
        }
        BrowserAction::Screenshot { to_clipboard } => {
            let epoch = DOCUMENT_EPOCH.load(Ordering::SeqCst);
            let selection_version = tab.annotation_version.get();
            let weak_tab = Rc::downgrade(&tab);
            let events = tab.events.clone();
            let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |result, json| {
                    if DOCUMENT_EPOCH.load(Ordering::SeqCst) != epoch
                        || weak_tab
                            .upgrade()
                            .is_none_or(|tab| tab.annotation_version.get() != selection_version)
                    {
                        return Ok(());
                    }
                    let png = result
                        .ok()
                        .and_then(|()| serde_json::from_str::<serde_json::Value>(&json).ok())
                        .and_then(|response| {
                            response
                                .get("data")
                                .and_then(|data| data.as_str())
                                .map(str::to_owned)
                        })
                        .filter(|data| data.len() <= 16 * 1024 * 1024);
                    match (png, to_clipboard) {
                        (Some(png), true) => {
                            let events = events.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                let outcome = base64::engine::general_purpose::STANDARD
                                    .decode(png)
                                    .ok()
                                    .and_then(|bytes| {
                                        image::load_from_memory_with_format(
                                            &bytes,
                                            image::ImageFormat::Png,
                                        )
                                        .ok()
                                    })
                                    .and_then(|image| {
                                        if DOCUMENT_EPOCH.load(Ordering::SeqCst) != epoch {
                                            return None;
                                        }
                                        let rgba = image.into_rgba8();
                                        let (width, height) = rgba.dimensions();
                                        arboard::Clipboard::new()
                                            .ok()?
                                            .set_image(arboard::ImageData {
                                                width: width as usize,
                                                height: height as usize,
                                                bytes: rgba.into_raw().into(),
                                            })
                                            .ok()
                                    });
                                let _ = events.send(if outcome.is_some() {
                                    BrowserEvent::Copied
                                } else {
                                    BrowserEvent::CaptureFailed
                                });
                            });
                        }
                        (Some(png), false) => {
                            let _ = events.send(BrowserEvent::Screenshot { png });
                        }
                        (None, _) => {
                            let _ = events.send(BrowserEvent::CaptureFailed);
                        }
                    }
                    Ok(())
                },
            ));
            unsafe {
                native.CallDevToolsProtocolMethod(
                    &windows_core::HSTRING::from("Page.captureScreenshot"),
                    &windows_core::HSTRING::from(
                        r#"{"format":"png","captureBeyondViewport":false}"#,
                    ),
                    &callback,
                )
            }
            .map_err(browser_error)?;
        }
        BrowserAction::Close => unreachable!("handled before tab lookup"),
        BrowserAction::SettleDetachedAnnotations { .. } => {
            unreachable!("handled before browser actions")
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn workbench_browser_open(
    window: WebviewWindow,
    id: Uuid,
    url: String,
    events: Channel<BrowserEvent>,
    history: Option<BrowserHistory>,
    project_path_key: Option<String>,
) -> Result<(), String> {
    if window.label() != crate::MAIN_WINDOW_LABEL {
        return Err("The browser is only available in the main workspace".into());
    }
    let epoch = DOCUMENT_EPOCH.load(Ordering::SeqCst);
    let backend = window.state::<Arc<KBrainBackendState>>();
    let (profile, handle) = backend.workbench_browser_profile()?;
    let app_data = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(browser_error)?;
    let directory = profile
        .backend_dir(&app_data)
        .with_file_name("workbench-browser");
    let (send, receive) = tokio::sync::oneshot::channel();
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = send.send(open_tab(
                &owner,
                id,
                &url,
                directory,
                handle,
                events,
                epoch,
                history,
                project_path_key,
            ));
        })
        .map_err(browser_error)?;
    receive.await.map_err(browser_error)?
}

#[tauri::command]
pub async fn workbench_browser(
    window: WebviewWindow,
    id: Uuid,
    request: BrowserAction,
) -> Result<(), String> {
    if window.label() != crate::MAIN_WINDOW_LABEL && window.label() != window_host::window_label(id)
    {
        return Err("The browser is only available in the main workspace".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = send.send(update_tab(&owner, id, request));
        })
        .map_err(browser_error)?;
    receive.await.map_err(browser_error)?
}

#[tauri::command]
pub async fn workbench_browser_connect(
    window: WebviewWindow,
    id: Uuid,
    events: Channel<BrowserEvent>,
) -> Result<(), String> {
    if window.label() != window_host::window_label(id) {
        return Err("This window does not own the browser tab".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = send.send(window_host::connect(&owner, id, events));
        })
        .map_err(browser_error)?;
    receive.await.map_err(browser_error)?
}

pub(crate) fn close_all() {
    DOCUMENT_EPOCH.fetch_add(1, Ordering::SeqCst);
    let tabs = TABS.with_borrow_mut(std::mem::take);
    site_annotations::release_all();
    for tab in tabs.into_values() {
        window_host::retire(tab);
    }
}

pub(crate) fn close_for_account(app: &tauri::AppHandle, handle: String) {
    DOCUMENT_EPOCH.fetch_add(1, Ordering::SeqCst);
    let _ = app.run_on_main_thread(move || {
        site_annotations::release_account(&handle);
        let retired = TABS.with_borrow_mut(|tabs| {
            let ids: Vec<_> = tabs
                .iter()
                .filter_map(|(id, tab)| {
                    (tab.account_handle.as_ref() == Some(&handle)).then_some(*id)
                })
                .collect();
            ids.into_iter()
                .filter_map(|id| tabs.remove(&id))
                .collect::<Vec<_>>()
        });
        for tab in retired {
            window_host::retire(tab);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires the Windows WebView2 Runtime"]
    fn hidden_webview2_guest_navigates_and_keeps_host_ipc_disabled() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::mpsc,
            thread,
            time::{Duration, Instant},
        };
        use tauri::{ipc::InvokeResponseBody, WebviewUrl, WebviewWindowBuilder};

        let fixture = TcpListener::bind("127.0.0.1:0").unwrap();
        fixture.set_nonblocking(true).unwrap();
        let base = format!("http://{}", fixture.local_addr().unwrap());
        let (stop, server_stopped) = mpsc::channel();
        let server = thread::spawn(move || loop {
            if !matches!(server_stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                break;
            }
            let Ok((mut client, _)) = fixture.accept() else {
                thread::sleep(Duration::from_millis(10));
                continue;
            };
            client
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = [0; 8192];
            let Ok(size) = client.read(&mut request) else {
                continue;
            };
            let second = String::from_utf8_lossy(&request[..size]).starts_with("GET /second ");
            let title = if second { "Second" } else { "First" };
            let page = format!("<!doctype html><title>{title}</title><script>if(window.__TAURI__ || window.__TAURI_INTERNALS__) document.title='host IPC leaked';</script><button id='fixture' class='primary control' style='position:absolute;left:20px;top:20px;width:100px;height:40px'>Fixture</button><a href='/second'>Second</a>");
            let _ = write!(client, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", page.len(), page);
        });

        let scratch = tempfile::tempdir().unwrap();
        let mut app = tauri::Builder::<tauri::Wry>::default()
            .any_thread()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = WebviewWindowBuilder::new(
            &app,
            "main",
            WebviewUrl::External(Url::parse("about:blank").unwrap()),
        )
        .visible(false)
        .data_directory(scratch.path().join("host"))
        .build()
        .unwrap();
        let (send, receive) = mpsc::channel();
        let events = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let _ = send.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        let id = Uuid::new_v4();
        let first = format!("{base}/first");
        let second = format!("{base}/second");
        open_tab(
            &window,
            id,
            "",
            scratch.path().join("guest"),
            Some("fixture-owner".into()),
            events.clone(),
            DOCUMENT_EPOCH.load(Ordering::SeqCst),
            None,
            None,
        )
        .unwrap();
        let tab = TABS.with_borrow(|tabs| tabs.get(&id).cloned()).unwrap();
        let mut enabled = BOOL::default();
        unsafe {
            tab.view
                .webview()
                .Settings()
                .unwrap()
                .IsWebMessageEnabled(&mut enabled)
                .unwrap();
        }
        assert!(!enabled.as_bool());
        drop(tab);

        update_tab(
            &window,
            id,
            BrowserAction::Navigate { url: first.clone() },
        )
        .unwrap();

        let mut wait_for = |url: &str, title: &str, can_go_back: bool, can_go_forward: bool| {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                #[allow(deprecated)]
                app.run_iteration(|_, _| {});
                for event in receive.try_iter() {
                    let state = &event["state"];
                    if state["url"] == url
                        && state["title"] == title
                        && state["loading"] == false
                        && state["canGoBack"] == can_go_back
                        && state["canGoForward"] == can_go_forward
                    {
                        return;
                    }
                }
                assert!(Instant::now() < deadline, "waiting for {url} ({title})");
                thread::sleep(Duration::from_millis(10));
            }
        };
        wait_for(&first, "First", false, false);
        update_tab(
            &window,
            id,
            BrowserAction::Navigate {
                url: second.clone(),
            },
        )
        .unwrap();
        wait_for(&second, "Second", true, false);
        update_tab(&window, id, BrowserAction::Back).unwrap();
        wait_for(&first, "First", false, true);

        let tab = TABS.with_borrow(|tabs| tabs.get(&id).cloned()).unwrap();
        let native = tab.view.webview();
        let cdp =
            |app: &mut tauri::App<tauri::Wry>, method: &str, parameters: &serde_json::Value| {
                let (send, receive) = mpsc::channel();
                browser_cdp(&native, method, parameters, move |result| {
                    let _ = send.send(result);
                })
                .unwrap();
                let deadline = Instant::now() + Duration::from_secs(8);
                loop {
                    #[allow(deprecated)]
                    app.run_iteration(|_, _| {});
                    if let Ok(result) = receive.try_recv() {
                        return result.unwrap_or_else(|| panic!("{method} failed"));
                    }
                    assert!(Instant::now() < deadline, "waiting for {method}");
                    thread::sleep(Duration::from_millis(10));
                }
            };
        let metrics = serde_json::json!({});
        let normal = cdp(&mut app, "Page.getLayoutMetrics", &metrics);
        update_tab(
            &window,
            id,
            BrowserAction::Layout {
                bounds: Some(BrowserBounds {
                    x: 0,
                    y: 0,
                    width: 215,
                    height: 466,
                }),
                viewport: Some(BrowserViewport {
                    width: 430,
                    height: 932,
                    scale: 0.5,
                }),
                site_preview_token: None,
                version: 1,
            },
        )
        .unwrap();
        let device = cdp(&mut app, "Page.getLayoutMetrics", &metrics);
        assert_eq!(device["cssLayoutViewport"]["clientWidth"], 430);
        assert_eq!(device["cssLayoutViewport"]["clientHeight"], 932);
        update_tab(
            &window,
            id,
            BrowserAction::Layout {
                bounds: None,
                viewport: None,
                site_preview_token: None,
                version: 2,
            },
        )
        .unwrap();
        let restored = cdp(&mut app, "Page.getLayoutMetrics", &metrics);
        assert_ne!(restored["cssLayoutViewport"], device["cssLayoutViewport"]);
        assert_ne!(normal["cssLayoutViewport"], device["cssLayoutViewport"]);

        update_tab(
            &window,
            id,
            BrowserAction::Layout {
                bounds: Some(BrowserBounds {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 400,
                }),
                viewport: None,
                site_preview_token: None,
                version: 3,
            },
        )
        .unwrap();
        let start_selection = |app: &mut tauri::App<tauri::Wry>| {
            update_tab(&window, id, BrowserAction::SelectRegion { enabled: true }).unwrap();
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                cdp(app, "Page.getLayoutMetrics", &metrics);
                if let Some(context) = tab.selection_context.get() {
                    let ready = cdp(
                        app,
                        "Runtime.evaluate",
                        &serde_json::json!({
                            "contextId": context, "expression":"typeof globalThis.__zaStopSelection", "returnByValue":true
                        }),
                    );
                    if ready["result"]["value"] == "function" {
                        return;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "waiting for the isolated selection world"
                );
                thread::sleep(Duration::from_millis(10));
            }
        };
        let wait_for_selection = |app: &mut tauri::App<tauri::Wry>, kind: &str| {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                #[allow(deprecated)]
                app.run_iteration(|_, _| {});
                if let Some(event) = receive.try_iter().find(|event| event["kind"] == kind) {
                    return event;
                }
                assert!(Instant::now() < deadline, "waiting for {kind}");
                thread::sleep(Duration::from_millis(10));
            }
        };
        start_selection(&mut app);
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mousePressed","x":65,"y":40,"button":"left","buttons":1,"clickCount":1}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mouseReleased","x":65,"y":40,"button":"left","buttons":0,"clickCount":1}),
        );
        let point = wait_for_selection(&mut app, "annotationTarget");
        assert_eq!(point["target"], "button#fixture.primary.control");
        assert!(point["x"].as_f64().is_some_and(|x| x > 0.0 && x < 1.0));
        assert_eq!(point["localStylePreview"], true);
        let style_token = Uuid::parse_str(point["sitePreviewToken"].as_str().unwrap()).unwrap();
        update_tab(
            &window,
            id,
            BrowserAction::PreviewSiteAnnotation {
                token: style_token,
                revision: 1,
                values: serde_json::from_value(
                    serde_json::json!([{"callback":"opacity","value":0.55}]),
                )
                .unwrap(),
                original: false,
            },
        )
        .unwrap();
        assert!(wait_for_selection(&mut app, "siteAnnotationPreview")["png"].is_string());
        let opacity = serde_json::json!({"expression":"getComputedStyle(document.querySelector('#fixture')).opacity","returnByValue":true});
        assert_eq!(
            cdp(&mut app, "Runtime.evaluate", &opacity)["result"]["value"],
            "0.55"
        );
        update_tab(
            &window,
            id,
            BrowserAction::CloseSiteAnnotation { token: style_token },
        )
        .unwrap();
        assert_eq!(
            cdp(&mut app, "Runtime.evaluate", &opacity)["result"]["value"],
            "1"
        );
        cdp(
            &mut app,
            "Runtime.evaluate",
            &serde_json::json!({"expression": "const chart=document.querySelector('#fixture'); chart.setAttribute('oai-annotatable', 'Fixture chart'); chart.setAttribute('oai-annotation-metadata', JSON.stringify({kind:'chart'}));"}),
        );
        assert!(update_tab(
            &window,
            id,
            BrowserAction::SiteAnnotations {
                origin: "https://other.example".into(),
                enabled: Some(true)
            }
        )
        .is_err());
        update_tab(
            &window,
            id,
            BrowserAction::SiteAnnotations {
                origin: base.clone(),
                enabled: Some(true),
            },
        )
        .unwrap();
        cdp(
            &mut app,
            "Runtime.evaluate",
            &serde_json::json!({"expression":"document.oai.annotation.registerControls({targets:[document.querySelector('#fixture')], controls:[{type:'toggle',callback:'visibility',label:'Visible',defaultValue:true}]});"}),
        );
        start_selection(&mut app);
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mousePressed","x":65,"y":40,"button":"left","buttons":1,"clickCount":1}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mouseReleased","x":65,"y":40,"button":"left","buttons":0,"clickCount":1}),
        );
        let site_point = wait_for_selection(&mut app, "annotationTarget");
        assert_eq!(site_point["siteLabel"], "Fixture chart");
        assert_eq!(site_point["siteMetadata"], "{\"kind\":\"chart\"}");
        assert!(site_point["siteControls"]
            .as_str()
            .is_some_and(|controls| controls.contains("visibility")));
        let preview_token =
            Uuid::parse_str(site_point["sitePreviewToken"].as_str().unwrap()).unwrap();
        cdp(
            &mut app,
            "Runtime.evaluate",
            &serde_json::json!({"expression":"document.querySelector('#fixture').addEventListener('oaiannotationcontrolchange', (event) => { event.target.dataset.action=event.detail.action; event.target.dataset.value=String(event.detail.value); });"}),
        );
        let controls = || {
            serde_json::from_value(serde_json::json!([{"callback":"visibility","value":false}]))
                .unwrap()
        };
        update_tab(
            &window,
            id,
            BrowserAction::Layout {
                bounds: None,
                viewport: None,
                site_preview_token: Some(preview_token),
                version: 4,
            },
        )
        .unwrap();
        for (revision, original, expected) in [
            (1, false, "preview:false"),
            (2, true, "preview-original:true"),
        ] {
            update_tab(
                &window,
                id,
                BrowserAction::PreviewSiteAnnotation {
                    token: preview_token,
                    revision,
                    values: controls(),
                    original,
                },
            )
            .unwrap();
            let preview = wait_for_selection(&mut app, "siteAnnotationPreview");
            assert_eq!(preview["revision"], revision);
            assert!(preview["png"]
                .as_str()
                .is_some_and(|png| png.starts_with("iVBORw0KGgo")));
            assert_eq!(
                cdp(
                    &mut app,
                    "Runtime.evaluate",
                    &serde_json::json!({"expression":"document.querySelector('#fixture').dataset.action+':'+document.querySelector('#fixture').dataset.value","returnByValue":true})
                )["result"]["value"],
                expected
            );
        }
        update_tab(
            &window,
            id,
            BrowserAction::CloseSiteAnnotation {
                token: preview_token,
            },
        )
        .unwrap();
        assert_eq!(
            cdp(
                &mut app,
                "Runtime.evaluate",
                &serde_json::json!({"expression":"document.querySelector('#fixture').dataset.action+':'+document.querySelector('#fixture').dataset.value","returnByValue":true})
            )["result"]["value"],
            "reset:true"
        );
        update_tab(
            &window,
            id,
            BrowserAction::Layout {
                bounds: Some(BrowserBounds {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 400,
                }),
                viewport: None,
                site_preview_token: None,
                version: 5,
            },
        )
        .unwrap();
        start_selection(&mut app);
        cdp(
            &mut app,
            "Runtime.evaluate",
            &serde_json::json!({"expression":"document.querySelector('#fixture').onclick = (event) => document.oai.annotation.request(event.currentTarget, {initialComment: 'Site suggestion'});"}),
        );
        cdp(
            &mut app,
            "Input.dispatchKeyEvent",
            &serde_json::json!({"type":"keyDown","key":" ","code":"Space","windowsVirtualKeyCode":32}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mousePressed","x":65,"y":40,"button":"left","buttons":1,"clickCount":1}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mouseReleased","x":65,"y":40,"button":"left","buttons":0,"clickCount":1}),
        );
        let site_request = wait_for_selection(&mut app, "annotationTarget");
        assert_eq!(site_request["siteSuggestedComment"], "Site suggestion");
        cdp(
            &mut app,
            "Input.dispatchKeyEvent",
            &serde_json::json!({"type":"keyUp","key":" ","code":"Space","windowsVirtualKeyCode":32}),
        );
        cdp(
            &mut app,
            "Runtime.evaluate",
            &serde_json::json!({"expression":r#"(() => {
            const canvas = document.querySelector('#fixture');
            const respond = (message) => canvas.dispatchEvent(new CustomEvent('codex:annotation-surface-response', {bubbles:true,detail:JSON.stringify({registrationId:'chart',...message})}));
            document.addEventListener('codex:annotation-surface-request', (event) => {
                const request = JSON.parse(event.detail);
                if (request.type === 'list') respond({type:'registered',customRendering:true});
                if (request.type === 'render' && event.target === canvas) {
                    canvas.dataset.hovered = request.hoveredId || '';
                    canvas.dataset.selected = request.selectedId || '';
                }
                if (request.type === 'hit-test' && event.target === canvas) {
                    const {x,y,width,height} = canvas.getBoundingClientRect();
                    respond({type:'result',requestId:request.requestId,hit:{id:'bar-1',name:'First chart bar',rect:{x,y,width,height},metadata:{series:'A'}}});
                }
            });
        })()"#}),
        );
        start_selection(&mut app);
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mousePressed","x":65,"y":40,"button":"left","buttons":1,"clickCount":1}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mouseReleased","x":65,"y":40,"button":"left","buttons":0,"clickCount":1}),
        );
        let surface = wait_for_selection(&mut app, "annotationRegion");
        assert_eq!(surface["siteLabel"], "First chart bar");
        assert_eq!(surface["siteMetadata"], "{\"series\":\"A\"}");
        assert_eq!(surface["siteCustomRender"], true);
        assert_eq!(
            cdp(
                &mut app,
                "Runtime.evaluate",
                &serde_json::json!({"expression":"document.querySelector('#fixture').dataset.selected","returnByValue":true})
            )["result"]["value"],
            "bar-1"
        );
        update_tab(
            &window,
            id,
            BrowserAction::SiteAnnotations {
                origin: base.clone(),
                enabled: Some(false),
            },
        )
        .unwrap();
        assert!(site_annotations::current_grant(&tab).is_none());
        assert_eq!(
            cdp(
                &mut app,
                "Runtime.evaluate",
                &serde_json::json!({"expression":"document.querySelector('#fixture').dataset.selected","returnByValue":true})
            )["result"]["value"],
            ""
        );

        start_selection(&mut app);
        cdp(
            &mut app,
            "Runtime.evaluate",
            &serde_json::json!({"expression":"globalThis.fixtureClicks=0;document.querySelector('#fixture').onclick=()=>globalThis.fixtureClicks++"}),
        );
        cdp(
            &mut app,
            "Input.dispatchKeyEvent",
            &serde_json::json!({"type":"keyDown","key":" ","code":"Space","windowsVirtualKeyCode":32}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mousePressed","x":65,"y":40,"button":"left","buttons":1,"clickCount":1}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mouseReleased","x":65,"y":40,"button":"left","buttons":0,"clickCount":1}),
        );
        assert_eq!(
            cdp(
                &mut app,
                "Runtime.evaluate",
                &serde_json::json!({"expression":"globalThis.fixtureClicks", "returnByValue":true})
            )["result"]["value"],
            1
        );
        cdp(
            &mut app,
            "Input.dispatchKeyEvent",
            &serde_json::json!({"type":"keyUp","key":" ","code":"Space","windowsVirtualKeyCode":32}),
        );
        // CDP pointer positions are CSS pixels. The native child was sized in
        // physical pixels and can run under any desktop DPI setting.
        let viewport = cdp(
            &mut app,
            "Runtime.evaluate",
            &serde_json::json!({"expression":"[innerWidth,innerHeight]", "returnByValue":true}),
        );
        let width = viewport["result"]["value"][0].as_f64().unwrap();
        let height = viewport["result"]["value"][1].as_f64().unwrap();
        let (start_x, start_y, end_x, end_y) =
            (width * 0.2, height * 0.25, width * 0.65, height * 0.75);
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mousePressed","x":start_x,"y":start_y,"button":"left","buttons":1,"clickCount":1}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mouseMoved","x":end_x,"y":end_y,"button":"left","buttons":1}),
        );
        cdp(
            &mut app,
            "Input.dispatchMouseEvent",
            &serde_json::json!({"type":"mouseReleased","x":end_x,"y":end_y,"button":"left","buttons":0,"clickCount":1}),
        );
        let region = wait_for_selection(&mut app, "annotationRegion");
        for (field, expected) in [("x", 0.2), ("y", 0.25), ("width", 0.45), ("height", 0.5)] {
            let actual = region[field].as_f64().unwrap();
            assert!((actual - expected).abs() < 0.02, "{field} in {region}");
        }
        let BrowserEvent::History {
            history: saved_history,
            ..
        } = tab.timeline.borrow().event()
        else {
            panic!("history snapshot")
        };
        assert_eq!(
            serde_json::to_value(&saved_history).unwrap(),
            serde_json::json!({"entries":[first, second], "index":0})
        );
        let child = {
            let mut child = Default::default();
            unsafe { tab.view.controller().ParentWindow(&mut child).unwrap() };
            child
        };
        let app_parent = window.hwnd().unwrap().0;
        let browser_parent =
            || unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetParent(child.0) };
        let wait_for_window = |app: &mut tauri::App<tauri::Wry>, tab: &Tab| {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                #[allow(deprecated)]
                app.run_iteration(|_, _| {});
                if let Some(window) = tab.detached.borrow().clone() {
                    return window;
                }
                assert!(
                    Instant::now() < deadline,
                    "waiting for separate browser chrome"
                );
                thread::sleep(Duration::from_millis(10));
            }
        };
        assert_eq!(browser_parent(), app_parent);
        update_tab(
            &window,
            id,
            BrowserAction::Detach {
                locale: BrowserChromeLocale::En,
                scheme: BrowserColorScheme::Light,
            },
        )
        .unwrap();
        let floating = wait_for_window(&mut app, &tab);
        assert_eq!(browser_parent(), app_parent);
        assert!(window_host::connect(&window, id, events.clone()).is_err());
        window_host::connect(&floating, id, Channel::new(|_| Ok(()))).unwrap();
        let annotation_payload = || {
            serde_json::from_value::<annotation_relay::BrowserAnnotationInput>(serde_json::json!({
                "png":"iVBORw0KGgo=", "url": first, "text":"Fixture note", "x":0.25, "y":0.5
            }))
            .unwrap()
        };
        for error in [Some("The original conversation changed".to_owned()), None] {
            let (reply, mut outcome) = tokio::sync::oneshot::channel();
            annotation_relay::submit(&floating, id, vec![annotation_payload()], reply);
            let batch = receive
                .try_iter()
                .find(|event| event["kind"] == "submitAnnotations")
                .unwrap();
            let request_id = Uuid::parse_str(batch["requestId"].as_str().unwrap()).unwrap();
            assert_eq!(batch["annotations"][0]["text"], "Fixture note");
            assert!(outcome.try_recv().is_err());
            assert!(update_tab(
                &floating,
                id,
                BrowserAction::SettleDetachedAnnotations {
                    request_id,
                    error: None
                }
            )
            .is_err());
            assert!(update_tab(&floating, id, BrowserAction::ReturnToWorkspace).is_err());
            update_tab(
                &window,
                id,
                BrowserAction::SettleDetachedAnnotations {
                    request_id,
                    error: error.clone(),
                },
            )
            .unwrap();
            assert_eq!(outcome.try_recv().unwrap(), error.map_or(Ok(()), Err));
        }
        assert_eq!(browser_parent(), floating.hwnd().unwrap().0);
        assert_eq!(
            cdp(
                &mut app,
                "Runtime.evaluate",
                &serde_json::json!({"expression":"globalThis.fixtureClicks", "returnByValue":true})
            )["result"]["value"],
            1
        );
        assert!(update_tab(&floating, Uuid::new_v4(), BrowserAction::ReturnToWorkspace).is_err());
        update_tab(&floating, id, BrowserAction::ReturnToWorkspace).unwrap();
        assert_eq!(browser_parent(), app_parent);
        assert_eq!(
            cdp(
                &mut app,
                "Runtime.evaluate",
                &serde_json::json!({"expression":"globalThis.fixtureClicks", "returnByValue":true})
            )["result"]["value"],
            1
        );
        drop(tab);
        assert!(update_tab(
            &window,
            id,
            BrowserAction::Navigate {
                url: "file:///private".into()
            }
        )
        .is_err());
        update_tab(&window, id, BrowserAction::Close).unwrap();
        let restored_id = Uuid::new_v4();
        open_tab(
            &window,
            restored_id,
            "",
            scratch.path().join("guest-restored"),
            Some("fixture-owner".into()),
            events,
            DOCUMENT_EPOCH.load(Ordering::SeqCst),
            Some(saved_history),
            None,
        )
        .unwrap();
        let restored = TABS
            .with_borrow(|tabs| tabs.get(&restored_id).cloned())
            .unwrap();
        let wait_for_url = |app: &mut tauri::App<tauri::Wry>, url: &str| {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                #[allow(deprecated)]
                app.run_iteration(|_, _| {});
                let state = restored.state.borrow();
                if !state.loading && state.url == url {
                    break;
                }
                assert!(Instant::now() < deadline, "waiting for restored URL {url}");
                thread::sleep(Duration::from_millis(10));
            }
        };
        wait_for_url(&mut app, &first);
        update_tab(&window, restored_id, BrowserAction::Forward).unwrap();
        wait_for_url(&mut app, &second);
        update_tab(&window, restored_id, BrowserAction::Back).unwrap();
        wait_for_url(&mut app, &first);
        update_tab(
            &window,
            restored_id,
            BrowserAction::Detach {
                locale: BrowserChromeLocale::En,
                scheme: BrowserColorScheme::Light,
            },
        )
        .unwrap();
        let _ = wait_for_window(&mut app, &restored);
        let floating_label = window_host::window_label(restored_id);
        drop(restored);
        close_for_account(app.handle(), "different-owner".into());
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        assert!(app.get_webview_window(&floating_label).is_some());
        close_for_account(app.handle(), "fixture-owner".into());
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        assert!(TABS.with_borrow(|tabs| tabs.is_empty()));
        let _ = stop.send(());
        server.join().unwrap();
    }

    #[test]
    fn only_http_pages_without_url_credentials_are_accepted() {
        for url in ["https://example.com/", "http://127.0.0.1:8123/path"] {
            assert!(page_url(url).is_some());
        }
        for url in [
            "file:///C:/private",
            "javascript:alert(1)",
            "data:text/html,test",
            "tauri://localhost",
            "https://user:secret@example.com",
        ] {
            assert!(page_url(url).is_none(), "{url}");
        }
    }

    #[test]
    fn guest_bounds_are_clipped_to_parent_client_area() {
        let parent = PhysicalSize::new(800, 600);
        let rect = BrowserBounds {
            x: 600,
            y: 20,
            width: 400,
            height: 610,
        }
        .checked_rect(parent)
        .unwrap();
        assert_eq!(rect.size, PhysicalSize::new(200, 580).into());
        assert!(BrowserBounds {
            x: 850,
            y: 20,
            width: 400,
            height: 610
        }
        .checked_rect(parent)
        .is_none());
    }
}
