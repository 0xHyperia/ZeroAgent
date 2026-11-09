use std::{
    cell::RefCell,
    fs,
    io::Write,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};
use tempfile::TempDir;
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;
use webview2_com::{
    take_pwstr, BrowserExtensionEnableCompletedHandler, BrowserExtensionRemoveCompletedHandler,
    LaunchingExternalUriSchemeEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2BrowserExtension, ICoreWebView2BrowserExtensionList, ICoreWebView2Profile7,
        ICoreWebView2_13, ICoreWebView2_18, COREWEBVIEW2_PERMISSION_STATE_DENY,
    },
    NavigationCompletedEventHandler, PermissionRequestedEventHandler,
    ProfileAddBrowserExtensionCompletedHandler, ProfileGetBrowserExtensionsCompletedHandler,
};
use windows_core::{Interface, BOOL, HSTRING, PWSTR};
use wry::{
    NewWindowResponse, Rect, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows,
};

use super::{browser_error, window_host, BrowserBounds, Tab, TABS};
use crate::services::kbrain_backend::KBrainBackendState;

#[path = "workbench_browser_store.rs"]
mod store;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ExtensionRequest {
    List,
    Install,
    InstallStore {
        token: Uuid,
    },
    CancelStore {
        token: Uuid,
    },
    OpenPopup {
        token: Uuid,
        extension: String,
        bounds: BrowserBounds,
    },
    ResizePopup {
        token: Uuid,
        bounds: BrowserBounds,
    },
    ClosePopup {
        token: Uuid,
    },
    Enable {
        extension: String,
        enabled: bool,
    },
    Remove {
        extension: String,
    },
}

#[derive(Serialize)]
pub struct ExtensionSummary {
    id: String,
    name: String,
    enabled: bool,
    #[serde(rename = "canOpenPopup")]
    can_open_popup: bool,
}

#[derive(Default)]
pub(super) struct TabSurface {
    store_review: Option<PendingStore>,
    popup_token: Option<Uuid>,
    popup: Option<WebView>,
}

struct PendingStore {
    token: Uuid,
    expires: Instant,
    package: store::StorePackage,
}

#[derive(Serialize)]
pub struct StoreReview {
    token: Uuid,
    #[serde(flatten)]
    manifest: store::StoreManifest,
}

#[derive(Default, Deserialize, Serialize)]
struct CatalogEntry {
    popup: Option<String>,
    managed_folder: Option<String>,
}

struct InstallSource {
    path: PathBuf,
    popup: Option<String>,
    store: Option<(String, TempDir)>,
}

pub(super) fn clear_tab_surface(tab: &Tab) {
    *tab.extension_surface.borrow_mut() = TabSurface::default();
}

fn catalog_path(profile: &Path, id: &str) -> PathBuf {
    profile.join("extension-catalog").join(format!("{id}.json"))
}

fn catalog_entry(profile: &Path, id: &str) -> Option<CatalogEntry> {
    if !store::extension_id(id) {
        return None;
    }
    let path = catalog_path(profile, id);
    if fs::metadata(&path).ok()?.len() > 8 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_catalog(profile: &Path, id: &str, entry: &CatalogEntry) -> Result<(), String> {
    let path = catalog_path(profile, id);
    let parent = path.parent().ok_or("Invalid extension catalog directory")?;
    fs::create_dir_all(parent).map_err(browser_error)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(browser_error)?;
    file.write_all(&serde_json::to_vec(entry).map_err(browser_error)?)
        .map_err(browser_error)?;
    file.persist(path).map_err(browser_error)?;
    Ok(())
}

fn remove_managed(profile: &Path, entry: Option<CatalogEntry>) {
    if let Some(folder) = entry.and_then(|entry| entry.managed_folder) {
        if folder
            .strip_prefix("store-extension-")
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        {
            let _ = fs::remove_dir_all(profile.join(folder));
        }
    }
}

fn popup_url(id: &str, path: &str) -> Option<Url> {
    if !store::extension_id(id) {
        return None;
    }
    // Check catalog entries again before passing them to the native browser.
    let manifest = serde_json::json!({"action": {"default_popup": path}});
    let path = store::popup_path(&manifest)?;
    let mut url = Url::parse(&format!("chrome-extension://{id}/")).ok()?;
    url.path_segments_mut()
        .ok()?
        .clear()
        .extend(path.split('/'));
    Some(url)
}

fn create_popup(
    window: &WebviewWindow,
    tab: &Tab,
    extension: &str,
    url: &Url,
    bounds: Rect,
    completion: &Completion,
) -> Result<(), String> {
    let extension = extension.to_string();
    let popup = WebViewBuilder::new()
        .with_environment(tab.view.environment())
        .with_bounds(bounds)
        .with_visible(false)
        .with_focused(false)
        .with_devtools(false)
        .with_navigation_handler(move |uri| {
            uri == "about:blank"
                || Url::parse(&uri).is_ok_and(|url| {
                    url.scheme() == "chrome-extension"
                        && url.host_str() == Some(&extension)
                        && url.port().is_none()
                        && url.username().is_empty()
                        && url.password().is_none()
                })
        })
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .build_as_child(window)
        .map_err(browser_error)?;
    let native = popup.webview();
    let result = completion.clone();
    unsafe {
        let settings = native.Settings().map_err(browser_error)?;
        settings
            .SetIsWebMessageEnabled(false)
            .map_err(browser_error)?;
        settings
            .SetAreHostObjectsAllowed(false)
            .map_err(browser_error)?;
        settings
            .SetIsStatusBarEnabled(false)
            .map_err(browser_error)?;
        let mut token = 0;
        native
            .add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(browser_error)?;
        if let Ok(native) = native.cast::<ICoreWebView2_18>() {
            native
                .add_LaunchingExternalUriScheme(
                    &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            args.SetCancel(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(browser_error)?;
        }
        native
            .add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                    let mut success = BOOL::default();
                    if let Some(args) = args {
                        args.IsSuccess(&mut success)?;
                    }
                    finish(
                        &result,
                        if success.as_bool() {
                            Ok(Vec::new())
                        } else {
                            Err("This extension popup could not load in WebView2".into())
                        },
                    );
                    Ok(())
                })),
                &mut token,
            )
            .map_err(browser_error)?;
    }
    popup.load_url(url.as_str()).map_err(browser_error)?;
    popup.set_visible(true).map_err(browser_error)?;
    tab.extension_surface.borrow_mut().popup = Some(popup);
    Ok(())
}

fn popup_bounds(window: &WebviewWindow, bounds: BrowserBounds) -> Result<Rect, String> {
    let parent = window.inner_size().map_err(browser_error)?;
    BrowserBounds {
        width: bounds.width.min(1600),
        height: bounds.height.min(1400),
        ..bounds
    }
    .checked_rect(parent)
    .ok_or_else(|| "The browser extension popup has no space".into())
}

fn dispatch_popup(
    profile: &ICoreWebView2Profile7,
    window: WebviewWindow,
    id: Uuid,
    owner: Option<String>,
    token: Uuid,
    extension: String,
    bounds: BrowserBounds,
    completion: &Completion,
) -> Result<(), String> {
    let result = completion.clone();
    let callback =
        ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |status, list| {
            let opened = (|| {
                let list = status
                    .and_then(|_| list_items(list))
                    .map_err(browser_error)?;
                let tab = browser_tab(&window, id, &owner)?;
                if tab.extension_surface.borrow().popup_token != Some(token) {
                    return Err("The browser extension popup closed".into());
                }
                if !list.iter().any(|value| {
                    extension_info(value).is_ok_and(|info| info.id == extension && info.enabled)
                }) {
                    return Err("This browser extension is disabled or was removed".into());
                }
                let path = catalog_entry(&tab.profile_dir, &extension)
                    .and_then(|entry| entry.popup)
                    .ok_or("This extension does not declare an action popup")?;
                let url =
                    popup_url(&extension, &path).ok_or("Invalid browser extension popup path")?;
                let rect = popup_bounds(&window, bounds)?;
                create_popup(&window, &tab, &extension, &url, rect, &result)
            })();
            if let Err(error) = opened {
                finish(&result, Err(error));
            }
            Ok(())
        }));
    unsafe { profile.GetBrowserExtensions(&callback) }.map_err(browser_error)
}

type Completion = Rc<RefCell<Option<oneshot::Sender<Result<Vec<ExtensionSummary>, String>>>>>;

fn finish(completion: &Completion, result: Result<Vec<ExtensionSummary>, String>) {
    if let Some(send) = completion.borrow_mut().take() {
        let _ = send.send(result);
    }
}

pub(super) fn browser_tab(
    window: &WebviewWindow,
    id: Uuid,
    expected_owner: &Option<String>,
) -> Result<Rc<Tab>, String> {
    browser_tab_with_cleanup(window, id, expected_owner, false)
}

pub(super) fn browser_tab_with_cleanup(
    window: &WebviewWindow,
    id: Uuid,
    expected_owner: &Option<String>,
    allow_workspace_cleanup: bool,
) -> Result<Rc<Tab>, String> {
    let backend = window.state::<Arc<KBrainBackendState>>();
    let (_, owner) = backend.workbench_browser_profile()?;
    let tab = TABS
        .with_borrow(|tabs| tabs.get(&id).cloned())
        .ok_or("This browser tab has closed")?;
    let owned_window = if tab.detached_ready.get() {
        window_host::is_window_for(window, id, &tab)
            || allow_workspace_cleanup && window.label() == crate::MAIN_WINDOW_LABEL
    } else {
        window.label() == crate::MAIN_WINDOW_LABEL
    };
    if &owner != expected_owner || tab.account_handle != owner || !owned_window {
        return Err("This window does not own the browser tab".into());
    }
    Ok(tab)
}

fn extension_info(
    extension: &ICoreWebView2BrowserExtension,
) -> windows_core::Result<ExtensionSummary> {
    unsafe {
        let mut id = PWSTR::null();
        let mut name = PWSTR::null();
        let mut enabled = BOOL::default();
        extension.Id(&mut id)?;
        let id = take_pwstr(id);
        extension.Name(&mut name)?;
        let name = take_pwstr(name).chars().take(120).collect();
        extension.IsEnabled(&mut enabled)?;
        Ok(ExtensionSummary {
            id,
            name,
            enabled: enabled.as_bool(),
            can_open_popup: false,
        })
    }
}

fn list_items(
    list: Option<ICoreWebView2BrowserExtensionList>,
) -> windows_core::Result<Vec<ICoreWebView2BrowserExtension>> {
    let Some(list) = list else {
        return Ok(Vec::new());
    };
    let mut count = 0;
    unsafe {
        list.Count(&mut count)?;
        (0..count)
            .map(|index| list.GetValueAtIndex(index))
            .collect()
    }
}

fn update_extension(
    request: ExtensionRequest,
    list: Vec<ICoreWebView2BrowserExtension>,
    profile_dir: &Path,
    completion: &Completion,
) -> Result<(), String> {
    if matches!(request, ExtensionRequest::List) {
        let mut extensions = list
            .iter()
            .map(extension_info)
            .collect::<windows_core::Result<Vec<_>>>()
            .map_err(browser_error)?;
        for item in &mut extensions {
            item.can_open_popup = item.enabled
                && catalog_entry(profile_dir, &item.id)
                    .and_then(|entry| entry.popup)
                    .is_some();
        }
        extensions.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        finish(completion, Ok(extensions));
        return Ok(());
    }
    let (id, enabled) = match request {
        ExtensionRequest::Enable { extension, enabled } => (extension, Some(enabled)),
        ExtensionRequest::Remove { extension } => (extension, None),
        _ => return Err("Unsupported extension action".into()),
    };
    let extension = list
        .into_iter()
        .find(|value| extension_info(value).is_ok_and(|item| item.id == id))
        .ok_or("The browser extension is no longer installed")?;
    let result = completion.clone();
    if let Some(enabled) = enabled {
        let callback = BrowserExtensionEnableCompletedHandler::create(Box::new(move |status| {
            finish(&result, status.map(|_| Vec::new()).map_err(browser_error));
            Ok(())
        }));
        unsafe { extension.Enable(enabled, &callback) }.map_err(browser_error)?;
    } else {
        let profile_dir = profile_dir.to_path_buf();
        let callback = BrowserExtensionRemoveCompletedHandler::create(Box::new(move |status| {
            if status.is_ok() && store::extension_id(&id) {
                remove_managed(&profile_dir, catalog_entry(&profile_dir, &id));
                let _ = fs::remove_file(catalog_path(&profile_dir, &id));
            }
            finish(&result, status.map(|_| Vec::new()).map_err(browser_error));
            Ok(())
        }));
        unsafe { extension.Remove(&callback) }.map_err(browser_error)?;
    }
    Ok(())
}

fn dispatch(
    window: &WebviewWindow,
    id: Uuid,
    owner: Option<String>,
    request: ExtensionRequest,
    install_source: Option<InstallSource>,
    completion: &Completion,
) -> Result<(), String> {
    let cleanup = matches!(
        request,
        ExtensionRequest::CancelStore { .. } | ExtensionRequest::ClosePopup { .. }
    );
    let tab = browser_tab_with_cleanup(window, id, &owner, cleanup)?;
    let install_source = match request {
        ExtensionRequest::InstallStore { token } => {
            let review = {
                let mut surface = tab.extension_surface.borrow_mut();
                if surface
                    .store_review
                    .as_ref()
                    .is_none_or(|review| review.token != token)
                {
                    return Err("The Chrome Web Store installation review has expired".into());
                }
                surface.store_review.take().expect("matching review")
            };
            let package = review.package;
            if review.expires <= Instant::now()
                || store::store_extension_id(&tab.state.borrow().url).as_deref()
                    != Some(&package.manifest.id)
            {
                return Err("The Chrome Web Store page changed before installation".into());
            }
            Some(InstallSource {
                path: package.directory.path().to_path_buf(),
                popup: package.popup,
                store: Some((package.manifest.id, package.directory)),
            })
        }
        ExtensionRequest::CancelStore { token } => {
            let mut surface = tab.extension_surface.borrow_mut();
            if surface
                .store_review
                .as_ref()
                .is_some_and(|review| review.token == token)
            {
                surface.store_review = None;
            }
            finish(completion, Ok(Vec::new()));
            return Ok(());
        }
        ExtensionRequest::ClosePopup { token } => {
            let mut surface = tab.extension_surface.borrow_mut();
            if surface.popup_token == Some(token) {
                surface.popup_token = None;
                surface.popup = None;
            }
            finish(completion, Ok(Vec::new()));
            return Ok(());
        }
        ExtensionRequest::ResizePopup { token, bounds } => {
            let surface = tab.extension_surface.borrow();
            if surface.popup_token == Some(token) {
                if let Some(popup) = surface.popup.as_ref() {
                    popup
                        .set_bounds(popup_bounds(window, bounds)?)
                        .map_err(browser_error)?;
                }
            }
            finish(completion, Ok(Vec::new()));
            return Ok(());
        }
        ExtensionRequest::OpenPopup { ref extension, .. } if !store::extension_id(extension) => {
            return Err("Invalid browser extension identifier".into());
        }
        _ => install_source,
    };
    let view: ICoreWebView2_13 = tab.view.webview().cast().map_err(browser_error)?;
    let profile: ICoreWebView2Profile7 = unsafe { view.Profile() }
        .and_then(|profile| profile.cast())
        .map_err(|_| "This WebView2 runtime does not support browser extensions")?;
    let window = window.clone();
    if let ExtensionRequest::OpenPopup {
        token,
        extension,
        bounds,
    } = request
    {
        {
            let mut surface = tab.extension_surface.borrow_mut();
            surface.popup_token = Some(token);
            surface.popup = None;
        }
        return dispatch_popup(
            &profile, window, id, owner, token, extension, bounds, completion,
        );
    }
    dispatch_profile(
        &profile,
        tab.profile_dir.clone(),
        request,
        install_source,
        move || browser_tab(&window, id, &owner).map(|_| ()),
        completion,
    )
}

fn dispatch_profile(
    profile: &ICoreWebView2Profile7,
    profile_dir: PathBuf,
    request: ExtensionRequest,
    install_source: Option<InstallSource>,
    validate: impl FnOnce() -> Result<(), String> + 'static,
    completion: &Completion,
) -> Result<(), String> {
    let result = completion.clone();
    if let Some(source) = install_source {
        let path = crate::runtime::platform::strip_windows_verbatim_prefix(source.path);
        let callback = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(
            move |status, extension| {
                let added = status.map_err(browser_error).and_then(|_| {
                    let extension =
                        extension.ok_or("WebView2 did not return the installed extension")?;
                    let info = extension_info(&extension).map_err(browser_error)?;
                    let previous = catalog_entry(&profile_dir, &info.id);
                    let record = if let Some((id, folder)) = source.store.as_ref() {
                        (id == &info.id).then(|| CatalogEntry {
                            popup: source.popup.clone(),
                            managed_folder: folder
                                .path()
                                .file_name()
                                .and_then(|name| name.to_str())
                                .map(str::to_string),
                        })
                    } else {
                        Some(CatalogEntry {
                            popup: source.popup.clone(),
                            managed_folder: None,
                        })
                    };
                    let saved = record
                        .ok_or("WebView2 changed the verified extension identity".into())
                        .and_then(|record| {
                            if !store::extension_id(&info.id) {
                                return Err(
                                    "WebView2 returned an invalid extension identity".into()
                                );
                            }
                            write_catalog(&profile_dir, &info.id, &record)
                        });
                    if let Err(error) = saved {
                        let cleanup =
                            BrowserExtensionRemoveCompletedHandler::create(Box::new(|_| Ok(())));
                        let _ = unsafe { extension.Remove(&cleanup) };
                        return Err(error);
                    }
                    if let Some((_, folder)) = source.store {
                        let _ = folder.keep();
                    }
                    remove_managed(&profile_dir, previous);
                    Ok(Vec::new())
                });
                finish(&result, added);
                Ok(())
            },
        ));
        unsafe { profile.AddBrowserExtension(&HSTRING::from(path.as_os_str()), &callback) }
            .map_err(browser_error)?;
    } else {
        let callback =
            ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |status, list| {
                let response = status
                    .and_then(|_| list_items(list))
                    .map_err(browser_error)
                    .and_then(|list| {
                        validate()?;
                        update_extension(request, list, &profile_dir, &result)
                    });
                if let Err(error) = response {
                    finish(&result, Err(error));
                }
                Ok(())
            }));
        unsafe { profile.GetBrowserExtensions(&callback) }.map_err(browser_error)?;
    }
    Ok(())
}

fn unpacked_extension_path(path: &Path) -> Result<PathBuf, String> {
    const REPARSE_POINT: u32 = 0x400;
    let directory = fs::symlink_metadata(path).map_err(browser_error)?;
    if !directory.is_dir() || directory.file_attributes() & REPARSE_POINT != 0 {
        return Err("Select an unpacked extension directory".into());
    }
    let manifest_path = path.join("manifest.json");
    let manifest_file =
        fs::symlink_metadata(&manifest_path).map_err(|_| "The folder has no manifest.json")?;
    if !manifest_file.is_file()
        || manifest_file.len() > 256 * 1024
        || manifest_file.file_attributes() & REPARSE_POINT != 0
    {
        return Err("The browser extension manifest is invalid".into());
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).map_err(browser_error)?)
            .map_err(|_| "The browser extension manifest is invalid")?;
    if !matches!(manifest["manifest_version"].as_u64(), Some(2 | 3))
        || manifest["name"]
            .as_str()
            .is_none_or(|name| name.trim().is_empty())
        || manifest["version"]
            .as_str()
            .is_none_or(|version| version.trim().is_empty())
    {
        return Err("The browser extension manifest is invalid".into());
    }
    fs::canonicalize(path).map_err(browser_error)
}

#[tauri::command]
pub async fn workbench_browser_extensions(
    window: WebviewWindow,
    id: Uuid,
    request: ExtensionRequest,
) -> Result<Vec<ExtensionSummary>, String> {
    let backend = window.state::<Arc<KBrainBackendState>>();
    let (_, owner) = backend.workbench_browser_profile()?;
    let install_source = if matches!(request, ExtensionRequest::Install) {
        let (send, receive) = oneshot::channel();
        let source = window.clone();
        let expected = owner.clone();
        window
            .run_on_main_thread(move || {
                let _ = send.send(browser_tab(&source, id, &expected).map(|_| ()));
            })
            .map_err(browser_error)?;
        receive.await.map_err(browser_error)??;
        let Some(folder) = rfd::AsyncFileDialog::new().pick_folder().await else {
            return Ok(Vec::new());
        };
        let path = unpacked_extension_path(folder.path())?;
        let popup = fs::read(path.join("manifest.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .as_ref()
            .and_then(store::popup_path);
        Some(InstallSource {
            path,
            popup,
            store: None,
        })
    } else {
        None
    };
    let (send, receive) = oneshot::channel();
    let source = window.clone();
    let expected = owner.clone();
    window
        .run_on_main_thread(move || {
            let completion = Rc::new(RefCell::new(Some(send)));
            if let Err(error) =
                dispatch(&source, id, expected, request, install_source, &completion)
            {
                finish(&completion, Err(error));
            }
        })
        .map_err(browser_error)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(12), receive)
        .await
        .map_err(|_| "Browser extension operation timed out")?
        .map_err(browser_error)?;
    if backend.workbench_browser_profile()?.1 != owner {
        return Err("The browser account changed".into());
    }
    result
}

async fn on_browser_tab<T: Send + 'static>(
    window: &WebviewWindow,
    id: Uuid,
    owner: Option<String>,
    action: impl FnOnce(&Tab) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = oneshot::channel();
    let source = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = send.send(browser_tab(&source, id, &owner).and_then(|tab| action(&tab)));
        })
        .map_err(browser_error)?;
    receive.await.map_err(browser_error)?
}

#[tauri::command]
pub async fn workbench_browser_prepare_store_extension(
    window: WebviewWindow,
    id: Uuid,
) -> Result<StoreReview, String> {
    static DOWNLOADS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _permit = DOWNLOADS
        .try_acquire()
        .map_err(|_| "Other extensions are already being prepared")?;
    let backend = window.state::<Arc<KBrainBackendState>>();
    let (_, owner) = backend.workbench_browser_profile()?;
    let (extension, version, profile) = on_browser_tab(&window, id, owner.clone(), |tab| {
        let extension = store::store_extension_id(&tab.state.borrow().url)
            .ok_or("Open a Chrome Web Store extension detail page first")?;
        let mut version = PWSTR::null();
        unsafe { tab.view.environment().BrowserVersionString(&mut version) }
            .map_err(browser_error)?;
        let version = take_pwstr(version)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        Ok((extension, version, tab.profile_dir.clone()))
    })
    .await?;
    let data = store::fetch(&extension, &version).await?;
    let package = tokio::task::spawn_blocking(move || store::prepare(data, extension, profile))
        .await
        .map_err(browser_error)??;
    let token = Uuid::new_v4();
    let expires = Instant::now() + Duration::from_secs(120);
    let review = on_browser_tab(&window, id, owner.clone(), move |tab| {
        if store::store_extension_id(&tab.state.borrow().url).as_deref()
            != Some(&package.manifest.id)
        {
            return Err("The Chrome Web Store page changed before review".into());
        }
        let manifest = package.manifest.clone();
        tab.extension_surface.borrow_mut().store_review = Some(PendingStore {
            token,
            expires,
            package,
        });
        Ok(StoreReview { token, manifest })
    })
    .await?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        let source = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(tab) = browser_tab_with_cleanup(&source, id, &owner, true) {
                let mut surface = tab.extension_surface.borrow_mut();
                if surface
                    .store_review
                    .as_ref()
                    .is_some_and(|review| review.token == token)
                {
                    surface.store_review = None;
                }
            }
        });
    });
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_folder_requires_a_bounded_chromium_manifest() {
        let folder = tempfile::tempdir().unwrap();
        assert!(unpacked_extension_path(folder.path()).is_err());
        let path = folder.path().join("manifest.json");
        fs::write(
            &path,
            r#"{"name":"Fixture","manifest_version":3,"version":"1"}"#,
        )
        .unwrap();
        assert_eq!(
            unpacked_extension_path(folder.path()).unwrap(),
            fs::canonicalize(folder.path()).unwrap()
        );
        fs::write(
            &path,
            r#"{"name":"Fixture","manifest_version":1,"version":"1"}"#,
        )
        .unwrap();
        assert!(unpacked_extension_path(folder.path()).is_err());
        fs::write(path, vec![b' '; 256 * 1024 + 1]).unwrap();
        assert!(unpacked_extension_path(folder.path()).is_err());
    }

    #[test]
    #[ignore = "requires the Windows WebView2 Runtime"]
    fn unpacked_extension_lifecycle_uses_the_isolated_webview2_profile() {
        use std::{
            thread,
            time::{Duration, Instant},
        };
        use tauri::{ipc::Channel, WebviewUrl, WebviewWindowBuilder};
        use url::Url;

        let scratch = tempfile::tempdir().unwrap();
        let folder = scratch.path().join("extension");
        fs::create_dir(&folder).unwrap();
        fs::write(
            folder.join("manifest.json"),
            r#"{"name":"ZeroAgent fixture","manifest_version":3,"version":"1.0","action":{"default_popup":"popup.html"}}"#,
        )
        .unwrap();
        fs::write(
            folder.join("popup.html"),
            "<!doctype html><script src=popup.js></script>",
        )
        .unwrap();
        fs::write(
            folder.join("popup.js"),
            "document.title = `Fixture ${chrome.runtime.id}`",
        )
        .unwrap();
        let folder = unpacked_extension_path(&folder).unwrap();
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
        let id = Uuid::new_v4();
        super::super::open_tab(
            &window,
            id,
            "",
            scratch.path().join("guest"),
            None,
            Channel::new(|_| Ok(())),
            super::super::DOCUMENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst),
            None,
            None,
        )
        .unwrap();
        let tab = TABS.with_borrow(|tabs| tabs.get(&id).cloned()).unwrap();
        let view: ICoreWebView2_13 = tab.view.webview().cast().unwrap();
        let profile: ICoreWebView2Profile7 = unsafe { view.Profile() }.unwrap().cast().unwrap();

        let wait =
            |app: &mut tauri::App,
             mut receive: oneshot::Receiver<Result<Vec<ExtensionSummary>, String>>| {
                let deadline = Instant::now() + Duration::from_secs(8);
                loop {
                    #[allow(deprecated)]
                    app.run_iteration(|_, _| {});
                    if let Ok(value) = receive.try_recv() {
                        break value.unwrap();
                    }
                    assert!(
                        Instant::now() < deadline,
                        "WebView2 extension callback timed out"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
            };
        let operation = |app: &mut tauri::App, request, install_source| {
            let (send, receive) = oneshot::channel();
            let completion = Rc::new(RefCell::new(Some(send)));
            dispatch_profile(
                &profile,
                tab.profile_dir.clone(),
                request,
                install_source,
                || Ok(()),
                &completion,
            )
            .unwrap();
            wait(app, receive)
        };
        let baseline = operation(&mut app, ExtensionRequest::List, None);
        let fixture_name = "ZeroAgent fixture";
        assert!(baseline.iter().all(|item| item.name != fixture_name));
        operation(
            &mut app,
            ExtensionRequest::Install,
            Some(InstallSource {
                path: folder,
                popup: Some("popup.html".into()),
                store: None,
            }),
        );
        let installed = operation(&mut app, ExtensionRequest::List, None)
            .into_iter()
            .find(|item| item.name == fixture_name)
            .expect("fixture extension installed in the guest profile");
        assert!(installed.enabled && installed.can_open_popup);
        let extension = installed.id;
        let (send, receive) = oneshot::channel();
        let completion = Rc::new(RefCell::new(Some(send)));
        let target = popup_url(&extension, "popup.html").unwrap();
        create_popup(
            &window,
            &tab,
            &extension,
            &target,
            Rect::default(),
            &completion,
        )
        .unwrap();
        wait(&mut app, receive);
        let popup = tab
            .extension_surface
            .borrow()
            .popup
            .as_ref()
            .unwrap()
            .webview();
        let mut title = PWSTR::null();
        unsafe { popup.DocumentTitle(&mut title) }.unwrap();
        assert_eq!(take_pwstr(title), format!("Fixture {extension}"));
        clear_tab_surface(&tab);
        operation(
            &mut app,
            ExtensionRequest::Enable {
                extension: extension.clone(),
                enabled: false,
            },
            None,
        );
        assert!(operation(&mut app, ExtensionRequest::List, None)
            .iter()
            .any(|item| item.id == extension && !item.enabled));
        operation(
            &mut app,
            ExtensionRequest::Enable {
                extension: extension.clone(),
                enabled: true,
            },
            None,
        );
        assert!(operation(&mut app, ExtensionRequest::List, None)
            .iter()
            .any(|item| item.id == extension && item.enabled));
        operation(
            &mut app,
            ExtensionRequest::Remove {
                extension: extension.clone(),
            },
            None,
        );
        let remaining = operation(&mut app, ExtensionRequest::List, None);
        assert!(remaining.iter().all(|item| item.id != extension));
        assert!(baseline
            .iter()
            .all(|existing| remaining.iter().any(|item| item.id == existing.id)));
        super::super::close_all();
    }
}
