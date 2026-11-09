use std::{cell::RefCell, collections::HashSet, sync::Arc};

use serde::Deserialize;
use tauri::{Manager, WebviewWindow};
use tokio::sync::oneshot;
use url::{Host, Url};
use uuid::Uuid;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_2, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
};
use windows_core::{Interface, HSTRING};
use wry::WebViewExtWindows;

use crate::{
    runtime::terminal::{SshLocalForwardRecord, TerminalSessionRegistry},
    services::account_session::{
        desktop_remote::{
            loopback::{self as gateway, GatewayForward, LOCAL_COOKIE},
            RemoteGatewayState,
        },
        AccountSessionState,
    },
    services::kbrain_backend::KBrainBackendState,
};

use super::{
    browser_error,
    extensions::{browser_tab, browser_tab_with_cleanup},
    page_url, publish_state,
};

thread_local! {
    static USED_BROWSER_PORTS: RefCell<HashSet<u16>> = RefCell::new(HashSet::new());
}

pub(super) fn loopback_host(url: &Url) -> Option<String> {
    match url.host()? {
        Host::Domain(host)
            if host.trim_end_matches('.') == "localhost"
                || host.trim_end_matches('.').ends_with(".localhost") =>
        {
            Some("127.0.0.1".into())
        }
        Host::Ipv4(host) if host.is_loopback() => Some(host.to_string()),
        Host::Ipv6(host) if host.is_loopback() => Some(host.to_string()),
        Host::Ipv6(host) if host.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback()) => {
            host.to_ipv4_mapped().map(|ip| ip.to_string())
        }
        _ => None,
    }
}

fn remote_target(input: &str) -> Result<(Url, String, u16), String> {
    let url = page_url(input).ok_or("Enter an HTTP or HTTPS loopback address")?;
    let host = loopback_host(&url).ok_or("Enter an HTTP or HTTPS loopback address")?;
    let port = url
        .port_or_known_default()
        .filter(|port| *port > 0)
        .ok_or("Invalid loopback port")?;
    Ok((url, host, port))
}

fn forward_url(mut url: Url, port: u16) -> Result<Url, String> {
    url.set_host(Some("127.0.0.1"))
        .map_err(|_| "Invalid local forward host")?;
    url.set_port(Some(port))
        .map_err(|_| "Invalid local forward port")?;
    Ok(url)
}

struct OwnedForward {
    registry: Arc<TerminalSessionRegistry>,
    record: SshLocalForwardRecord,
}

impl OwnedForward {
    fn is_active(&self) -> bool {
        self.registry
            .ssh_local_forward_list(
                Some(self.record.session_id.clone()),
                Some(self.record.project_path_key.clone()),
            )
            .is_ok_and(|snapshot| {
                snapshot.forwards.iter().any(|record| {
                    record.id == self.record.id
                        && record.local_port == self.record.local_port
                        && record.status == "active"
                })
            })
    }
}

impl Drop for OwnedForward {
    fn drop(&mut self) {
        let registry = self.registry.clone();
        let id = self.record.id.clone();
        let session = self.record.session_id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = registry.ssh_local_forward_stop(id, Some(session)).await;
        });
    }
}

#[derive(Default)]
pub(super) struct Loopback {
    active: Option<OwnedForward>,
    gateway: Option<(GatewayForward, Url)>,
    known_ports: HashSet<u16>,
    operation: u64,
}

impl Loopback {
    pub(super) fn active(&self) -> bool {
        self.active.is_some()
    }

    pub(super) fn retire(&mut self) {
        self.operation = self.operation.wrapping_add(1);
        self.active.take();
        self.gateway.take();
    }

    pub(super) fn gateway_display(&self, url: &Url) -> Option<String> {
        let (forward, origin) = self.gateway.as_ref()?;
        if url.host_str() != Some(forward.host.as_str()) || url.port() != Some(forward.port) {
            return None;
        }
        let mut display = origin.clone();
        display.set_path(url.path());
        display.set_query(url.query());
        display.set_fragment(url.fragment());
        Some(display.to_string())
    }

    pub(super) fn close_gateway_on_navigation(&mut self, url: Option<&Url>) {
        if self.gateway.is_some() && !url.is_some_and(|url| self.gateway_display(url).is_some()) {
            self.gateway.take();
        }
    }

    pub(super) fn permits(&self, url: &Url) -> bool {
        if loopback_host(url).is_none() {
            return true;
        }
        let Some(port) = url.port_or_known_default() else {
            return false;
        };
        if let Some((gateway, _)) = &self.gateway {
            return url.host_str() == Some(gateway.host.as_str())
                && port == gateway.port
                && gateway.is_active();
        }
        if let Some(forward) = &self.active {
            return url.host_str() == Some("127.0.0.1")
                && port == forward.record.local_port
                && forward.is_active();
        }
        !self.known_port(port)
    }

    fn known_port(&self, port: u16) -> bool {
        self.known_ports.contains(&port)
            || USED_BROWSER_PORTS.with_borrow(|ports| ports.contains(&port))
    }

    pub(super) fn guard_needed(&self) -> bool {
        self.active.is_some()
            || self.gateway.is_some()
            || USED_BROWSER_PORTS.with_borrow(|ports| !ports.is_empty())
    }

    pub(super) fn ephemeral(&self, url: &Url) -> bool {
        loopback_host(url).is_some()
            && url
                .port_or_known_default()
                .is_some_and(|port| self.known_port(port))
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoopbackRequest {
    Open { session_id: String, url: String },
    OpenGateway { bridge_id: String, url: String },
    Close,
}

#[tauri::command]
pub async fn workbench_browser_loopback(
    window: WebviewWindow,
    id: Uuid,
    request: LoopbackRequest,
) -> Result<(), String> {
    let request = match request {
        LoopbackRequest::OpenGateway { bridge_id, url } => {
            return open_gateway(window, id, bridge_id, url).await
        }
        request => request,
    };
    let backend = window.state::<Arc<KBrainBackendState>>();
    let (_, owner) = backend.workbench_browser_profile()?;
    let registry = window
        .state::<Arc<TerminalSessionRegistry>>()
        .inner()
        .clone();
    let source = window.clone();
    let captured_owner = owner.clone();
    let (send, receive) = oneshot::channel();
    let target = match &request {
        LoopbackRequest::Open { session_id, url } => {
            let (url, host, port) = remote_target(url)?;
            Some((session_id.clone(), url, host, port))
        }
        LoopbackRequest::Close => None,
        LoopbackRequest::OpenGateway { .. } => unreachable!(),
    };
    let candidate = target
        .as_ref()
        .map(|(session, _, host, port)| (session.clone(), host.clone(), *port));
    window
        .run_on_main_thread(move || {
            let result =
                browser_tab_with_cleanup(&source, id, &captured_owner, candidate.is_none())
                    .and_then(|tab| {
                        let mut loopback = tab.loopback.borrow_mut();
                        loopback.operation = loopback.operation.wrapping_add(1);
                        if let Some((session, host, port)) = candidate {
                            if !tab.loopback_guard.get() {
                                return Err(
                                    "This WebView2 runtime does not support scoped SSH navigation"
                                        .into(),
                                );
                            }
                            let project = tab
                                .project_path_key
                                .clone()
                                .filter(|key| !key.is_empty())
                                .ok_or("An active workspace is required for SSH navigation")?;
                            let reuse = loopback
                                .active
                                .as_ref()
                                .filter(|forward| {
                                    forward.record.session_id == session
                                        && forward.record.remote_host == host
                                        && forward.record.remote_port == port
                                        && forward.is_active()
                                })
                                .map(|forward| forward.record.local_port);
                            Ok((loopback.operation, project, reuse))
                        } else {
                            let stopped = loopback.active.take().is_some()
                                | loopback.gateway.take().is_some();
                            drop(loopback);
                            if stopped {
                                tab.view.load_url("about:blank").map_err(browser_error)?;
                                publish_state(
                                    &tab.view.webview(),
                                    &tab.state,
                                    &tab.events,
                                    &tab.loopback,
                                    |_| {},
                                )
                                .map_err(browser_error)?;
                            }
                            Ok((0, String::new(), None))
                        }
                    });
            let _ = send.send(result);
        })
        .map_err(browser_error)?;
    let (operation, project, reuse) = receive.await.map_err(browser_error)??;
    let Some((session, url, host, port)) = target else {
        return Ok(());
    };
    let created = if reuse.is_none() {
        let response = registry
            .ssh_local_forward_start(session, Some(project), host, u32::from(port), None)
            .await?;
        Some(OwnedForward {
            registry,
            record: response.forward,
        })
    } else {
        None
    };
    if backend.workbench_browser_profile()?.1 != owner {
        return Err("The browser account changed".into());
    }
    let local_port = reuse
        .or_else(|| created.as_ref().map(|forward| forward.record.local_port))
        .ok_or("The SSH forward is not active")?;
    let local = forward_url(url, local_port)?;
    let (send, receive) = oneshot::channel();
    let source = window.clone();
    window
        .run_on_main_thread(move || {
            let result = browser_tab(&source, id, &owner).and_then(|tab| {
                let mut loopback = tab.loopback.borrow_mut();
                if loopback.operation != operation {
                    return Err("The browser navigation changed".into());
                }
                let previous = created.map(|forward| {
                    loopback.known_ports.insert(local_port);
                    USED_BROWSER_PORTS.with_borrow_mut(|ports| ports.insert(local_port));
                    loopback.active.replace(forward)
                });
                if !loopback.permits(&local) {
                    if let Some(previous) = previous {
                        loopback.active = previous;
                    }
                    return Err("The SSH forward is not active".into());
                }
                drop(loopback);
                if let Err(error) = tab.view.load_url(local.as_str()) {
                    if let Some(previous) = previous {
                        tab.loopback.borrow_mut().active = previous;
                    }
                    return Err(browser_error(error));
                }
                publish_state(
                    &tab.view.webview(),
                    &tab.state,
                    &tab.events,
                    &tab.loopback,
                    |_| {},
                )
                .map_err(browser_error)
            });
            let _ = send.send(result);
        })
        .map_err(browser_error)?;
    receive.await.map_err(browser_error)?
}

async fn open_gateway(
    window: WebviewWindow,
    id: Uuid,
    bridge_id: String,
    url: String,
) -> Result<(), String> {
    let (original, host, port) = remote_target(&url)?;
    if original.scheme() != "http" || host != "127.0.0.1" {
        return Err("The selected device accepts HTTP addresses on IPv4 loopback".into());
    }
    let backend = window.state::<Arc<KBrainBackendState>>();
    let (_, owner) = backend.workbench_browser_profile()?;
    let account = owner
        .clone()
        .ok_or("A signed-in device selection is required")?;
    let (send, receive) = oneshot::channel();
    let source = window.clone();
    let captured = owner.clone();
    window
        .run_on_main_thread(move || {
            let result = browser_tab(&source, id, &captured).and_then(|tab| {
                if !tab.loopback_guard.get() {
                    return Err("This WebView2 runtime does not support scoped loopback".into());
                }
                let mut state = tab.loopback.borrow_mut();
                state.operation = state.operation.wrapping_add(1);
                Ok(state.operation)
            });
            let _ = send.send(result);
        })
        .map_err(browser_error)?;
    let operation = receive.await.map_err(browser_error)??;
    let account_state = window.state::<Arc<AccountSessionState>>();
    let remote = window.state::<Arc<RemoteGatewayState>>();
    let forward = gateway::open(
        account_state.inner(),
        remote.inner(),
        &account,
        &bridge_id,
        port,
    )
    .await?;
    let mut local = original.clone();
    local
        .set_host(Some(&forward.host))
        .map_err(|_| "Invalid private browser address")?;
    local
        .set_port(Some(forward.port))
        .map_err(|_| "Invalid private browser port")?;
    let source = window.clone();
    let (send, receive) = oneshot::channel();
    window
        .run_on_main_thread(move || {
            let result = browser_tab(&source, id, &owner).and_then(|tab| {
                let mut state = tab.loopback.borrow_mut();
                if state.operation != operation || !forward.is_active() {
                    return Err("The device selection or navigation changed".into());
                }
                install_gateway_cookie(&tab.view, &forward.host, &forward.token)?;
                let local_port = forward.port;
                state.known_ports.insert(local_port);
                USED_BROWSER_PORTS.with_borrow_mut(|ports| ports.insert(local_port));
                let previous = state.gateway.replace((forward, original));
                drop(state);
                if let Err(error) = tab.view.load_url(local.as_str()) {
                    tab.loopback.borrow_mut().gateway = previous;
                    return Err(browser_error(error));
                }
                tab.loopback.borrow_mut().active.take();
                publish_state(
                    &tab.view.webview(),
                    &tab.state,
                    &tab.events,
                    &tab.loopback,
                    |_| {},
                )
                .map_err(browser_error)
            });
            let _ = send.send(result);
        })
        .map_err(browser_error)?;
    receive.await.map_err(browser_error)?
}

fn install_gateway_cookie(view: &wry::WebView, host: &str, token: &str) -> Result<(), String> {
    let view: ICoreWebView2_2 = view.webview().cast().map_err(browser_error)?;
    unsafe {
        let manager = view.CookieManager().map_err(browser_error)?;
        let cookie = manager
            .CreateCookie(
                &HSTRING::from(LOCAL_COOKIE),
                &HSTRING::from(token),
                &HSTRING::from(host),
                &HSTRING::from("/"),
            )
            .map_err(browser_error)?;
        cookie.SetIsHttpOnly(true).map_err(browser_error)?;
        cookie
            .SetSameSite(COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT)
            .map_err(browser_error)?;
        manager.AddOrUpdateCookie(&cookie).map_err(browser_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Windows WebView2 Runtime"]
    fn private_loopback_native_browser_sends_origin_scoped_cookie() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::atomic::Ordering,
            thread,
            time::{Duration, Instant},
        };
        use tauri::{ipc::Channel, WebviewUrl, WebviewWindowBuilder};

        let root = tempfile::tempdir().unwrap();
        let host = format!("za-{}.localhost", Uuid::new_v4().simple());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (report, result) = std::sync::mpsc::sync_channel(1);
        let secret = Uuid::new_v4().simple().to_string();
        let expected = format!("{LOCAL_COOKIE}={secret}");
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            let mut buffer = [0; 1024];
            while data.len() < 32768 && !data.windows(4).any(|window| window == b"\r\n\r\n") {
                let size = socket.read(&mut buffer).unwrap();
                if size == 0 {
                    break;
                }
                data.extend_from_slice(&buffer[..size]);
            }
            let verified = String::from_utf8_lossy(&data).lines().any(|line| {
                line.to_ascii_lowercase().starts_with("cookie:") && line.contains(&expected)
            });
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
            let _ = report.send(verified);
        });

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
        .data_directory(root.path().join("host"))
        .build()
        .unwrap();
        let id = Uuid::new_v4();
        super::super::open_tab(
            &window,
            id,
            "",
            root.path().join("guest"),
            None,
            Channel::new(|_| Ok(())),
            super::super::DOCUMENT_EPOCH.load(Ordering::SeqCst),
            None,
            None,
        )
        .unwrap();
        let tab = super::super::TABS
            .with_borrow(|tabs| tabs.get(&id).cloned())
            .unwrap();
        install_gateway_cookie(&tab.view, &host, &secret).unwrap();
        tab.view
            .load_url(&format!("http://{host}:{port}/"))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            #[allow(deprecated)]
            app.run_iteration(|_, _| {});
            if let Ok(received) = result.try_recv() {
                assert!(received, "WebView2 did not authenticate the private origin");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "WebView2 did not reach the private origin"
            );
            thread::sleep(Duration::from_millis(10));
        }
        super::super::close_all();
    }

    #[test]
    fn remote_loopback_only_rewrites_checked_http_addresses() {
        let (url, host, port) = remote_target("http://localhost:4173/a?b=1#c").unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 4173);
        assert_eq!(
            forward_url(url, 61234).unwrap().as_str(),
            "http://127.0.0.1:61234/a?b=1#c"
        );
        for rejected in [
            "https://localhost.example:80",
            "http://172.16.0.2:80",
            "http://u:p@localhost/",
            "file:///etc/hosts",
            "http://localhost:0",
        ] {
            assert!(remote_target(rejected).is_err(), "{rejected}");
        }
        let mut scope = Loopback::default();
        scope.known_ports.insert(61234);
        let stale = Url::parse("http://localhost:61234").unwrap();
        assert!(!scope.permits(&stale));
        assert!(scope.ephemeral(&stale));
        assert!(scope.permits(&Url::parse("http://localhost:4173").unwrap()));
    }
}
