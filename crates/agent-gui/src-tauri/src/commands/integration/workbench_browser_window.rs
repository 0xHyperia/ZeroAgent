use super::{
    annotation, browser_error, BrowserChromeLocale, BrowserColorScheme, BrowserEvent, Channel, Rc,
    Tab, Uuid, WebviewWindow, TABS,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use wry::WebViewExtWindows;

const WINDOW_PREFIX: &str = "workbench-browser-";

pub(super) fn window_label(id: Uuid) -> String {
    format!("{WINDOW_PREFIX}{id}")
}

pub(super) fn is_window_for(window: &WebviewWindow, id: Uuid, tab: &Tab) -> bool {
    window.label() == window_label(id)
        && tab
            .detached
            .borrow()
            .as_ref()
            .is_some_and(|owner| owner.label() == window.label())
}

pub(super) fn detach(
    owner: &WebviewWindow,
    id: Uuid,
    tab: &Rc<Tab>,
    locale: BrowserChromeLocale,
    scheme: BrowserColorScheme,
) -> Result<(), String> {
    if let Some(window) = tab.detached.borrow().as_ref() {
        if !tab.detached_ready.get() {
            return Ok(());
        }
        window.show().map_err(browser_error)?;
        return window.set_focus().map_err(browser_error);
    }
    if tab.detached_starting.get() {
        return Ok(());
    }
    let trusted = owner.url().map_err(browser_error)?;
    let locale = match locale {
        BrowserChromeLocale::En => "en-US",
        BrowserChromeLocale::Zh => "zh-CN",
    };
    let dark = matches!(scheme, BrowserColorScheme::Dark);
    let attempt = tab.detached_attempt.get().wrapping_add(1);
    tab.detached_attempt.set(attempt);
    tab.detached_starting.set(true);
    let app = owner.app_handle().clone();
    let window_app = app.clone();
    // Building a Tauri WebView2 window from a UI event callback can deadlock the
    // COM creation callback. Only the trusted chrome is created off-thread.
    tauri::async_runtime::spawn_blocking(move || {
        let created = WebviewWindowBuilder::new(
            &window_app,
            window_label(id),
            WebviewUrl::App("index.html".into()),
        )
        .title("ZeroAgent")
        .inner_size(1120.0, 780.0)
        .min_inner_size(360.0, 300.0)
        .visible(false)
        .initialization_script(format!(
            "window.__ZEROAGENT_BROWSER_APPEARANCE__ = {{ locale: '{locale}', dark: {dark} }};"
        ))
        .on_navigation(move |url| {
            url.scheme() == trusted.scheme()
                && url.host_str() == trusted.host_str()
                && url.port_or_known_default() == trusted.port_or_known_default()
                && matches!(url.path(), "/" | "/index.html")
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .build();
        let orphan = created.as_ref().ok().cloned();
        if window_app
            .run_on_main_thread(move || finish_detach(id, attempt, created))
            .is_err()
        {
            if let Some(window) = orphan {
                let _ = window.destroy();
            }
        }
    });
    if !cfg!(test) {
        expire_attempt(app, id, attempt);
    }
    Ok(())
}

fn finish_detach(id: Uuid, attempt: u32, created: tauri::Result<WebviewWindow>) {
    let tab = TABS
        .with_borrow(|tabs| tabs.get(&id).cloned())
        .filter(|tab| {
            tab.detached_attempt.get() == attempt && tab.detached_starting.replace(false)
        });
    let window = match (tab, created) {
        (Some(tab), Ok(window)) => {
            tab.detached.replace(Some(window.clone()));
            window
        }
        (None, Ok(window)) => {
            let _ = window.destroy();
            return;
        }
        (Some(tab), Err(_)) => {
            let _ = tab.events.main.send(BrowserEvent::WindowUnavailable);
            return;
        }
        (None, Err(_)) => return,
    };
    let listener_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let caller = listener_window.clone();
            let _ = listener_window.run_on_main_thread(move || {
                if let Some(tab) = TABS.with_borrow(|tabs| tabs.get(&id).cloned()) {
                    let _ = return_to_workspace(&caller, &tab);
                } else {
                    let _ = caller.destroy();
                }
            });
        }
    });
}

fn expire_attempt(app: AppHandle, id: Uuid, attempt: u32) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        let _ = app.run_on_main_thread(move || {
            if let Some(tab) = TABS
                .with_borrow(|tabs| tabs.get(&id).cloned())
                .filter(|tab| !tab.detached_ready.get() && tab.detached_attempt.get() == attempt)
            {
                let pending = tab.detached_starting.replace(false);
                let window = tab.detached.borrow_mut().take();
                if pending || window.is_some() {
                    if let Some(window) = window {
                        let _ = window.destroy();
                    }
                    let _ = tab.events.main.send(BrowserEvent::WindowUnavailable);
                }
            }
        });
    });
}

pub(super) fn connect(
    window: &WebviewWindow,
    id: Uuid,
    events: Channel<BrowserEvent>,
) -> Result<(), String> {
    let tab = TABS
        .with_borrow(|tabs| tabs.get(&id).cloned())
        .ok_or("This browser tab has closed")?;
    if !is_window_for(window, id, &tab) {
        if tab.detached_starting.get() {
            return Err("The browser window is still opening".into());
        }
        return Err("This window does not own the browser tab".into());
    }
    tab.detached_layout_version.set(0);
    events
        .send(BrowserEvent::State {
            state: tab.state.borrow().clone(),
        })
        .map_err(browser_error)?;
    let _ = events.send(tab.timeline.borrow().event());
    let first_connection = !tab.detached_ready.get();
    if first_connection {
        annotation::stop(&tab);
        super::site_annotations::reset_preview(&tab);
        let hwnd = window.hwnd().map_err(browser_error)?;
        let visible = tab.visible.get();
        tab.view.set_visible(false).map_err(browser_error)?;
        if let Err(error) = tab.view.reparent(hwnd.0 as isize) {
            let _ = tab.view.set_visible(visible);
            return Err(browser_error(error));
        }
        tab.visible.set(false);
        tab.detached_ready.set(true);
    }
    *tab.events.detached.lock().map_err(browser_error)? = Some(events);
    if first_connection {
        let _ = tab
            .events
            .main
            .send(BrowserEvent::WindowState { detached: true });
        if !cfg!(test) {
            if let Err(error) = window.show().and_then(|()| window.set_focus()) {
                let _ = return_to_workspace(window, &tab);
                return Err(browser_error(error));
            }
        }
    }
    Ok(())
}

pub(super) fn return_to_workspace(caller: &WebviewWindow, tab: &Tab) -> Result<(), String> {
    if tab.pending_annotations.borrow().is_some() {
        return Err("Annotations are still being added".into());
    }
    super::site_annotations::reset_preview(tab);
    tab.detached_starting.set(false);
    let Some(window) = tab.detached.borrow().clone() else {
        return Ok(());
    };
    if !tab.detached_ready.get() {
        tab.detached.replace(None);
        let _ = window.destroy();
        return Ok(());
    }
    let owner = caller
        .app_handle()
        .get_webview_window(crate::MAIN_WINDOW_LABEL)
        .ok_or("The browser workspace has closed")?;
    let hwnd = owner.hwnd().map_err(browser_error)?;
    tab.view.set_visible(false).map_err(browser_error)?;
    tab.visible.set(false);
    tab.view.reparent(hwnd.0 as isize).map_err(browser_error)?;
    tab.detached_ready.set(false);
    tab.detached.replace(None);
    *tab.events.detached.lock().map_err(browser_error)? = None;
    let _ = tab
        .events
        .main
        .send(BrowserEvent::WindowState { detached: false });
    let _ = window.destroy();
    if !cfg!(test) {
        let _ = owner.show();
        let _ = owner.set_focus();
    }
    Ok(())
}

pub(super) fn retire(tab: Rc<Tab>) {
    super::site_annotations::reset_preview(&tab);
    let detached = tab.detached.borrow_mut().take();
    drop(tab);
    if let Some(window) = detached {
        let _ = window.destroy();
    }
}
