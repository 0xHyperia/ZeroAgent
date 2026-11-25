//! Device-owned K-brain plugin lifecycle. Account extension packages use their
//! existing Gateway store. Do not forward these operations through the generic
//! renderer facade.
#[path = "device_ui_surface.rs"]
pub(crate) mod surface;

use super::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};
use crate::runtime::project_path::project_path_key;
use reqwest::{blocking::Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const RESPONSE_LIMIT: u64 = 1024 * 1024;
const PROFILE_CHANGED: &str = "DEVICE_PLUGIN_SCOPE_CHANGED";
const INVALID_WORKSPACE: &str = "DEVICE_PLUGIN_WORKSPACE_REQUIRED";
const INVALID_SOURCE: &str = "DEVICE_PLUGIN_SOURCE_OUTSIDE_WORKSPACE";

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DevicePluginAction {
    List,
    Reload,
    Enable,
    Disable,
    Remove,
    Install,
    Trust,
    RevokeTrust,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DevicePluginRequest {
    pub(crate) action: DevicePluginAction,
    pub(crate) workdir: Option<String>,
    pub(crate) plugin_id: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) since: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevicePluginList {
    #[serde(default)]
    available: bool,
    #[serde(default)]
    trust_available: bool,
    #[serde(default, alias = "boundedInstall")]
    install_available: bool,
    #[serde(default)]
    workdir: String,
    #[serde(default)]
    trusted: bool,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    trust_source: Option<String>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    trust_inherited: Option<bool>,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    plugins: Vec<DevicePluginInfo>,
    #[serde(default)]
    errors: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct DevicePluginInfo {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    source: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    contributes: Contributions,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contributions {
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tool_details: Vec<ToolDetail>,
    #[serde(default)]
    hooks: Vec<String>,
    #[serde(default)]
    prompt: bool,
    #[serde(default)]
    ui: Vec<PluginPanel>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolDetail {
    name: String,
    #[serde(default)]
    model_name: String,
    #[serde(default)]
    description: String,
}

#[derive(Serialize, Deserialize)]
struct PluginPanel {
    id: String,
    title: String,
    placement: String,
}

fn directory(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let path = fs::canonicalize(path).ok()?;
    path.is_dir().then_some(path)
}

fn resolve_workspace(requested: &str, workspaces: &[PathBuf]) -> Result<PathBuf, String> {
    let requested = project_path_key(requested);
    workspaces
        .iter()
        .find(|root| {
            root.to_str()
                .is_some_and(|path| project_path_key(path) == requested)
        })
        .and_then(|root| directory(root))
        .ok_or_else(|| INVALID_WORKSPACE.into())
}

fn scoped_source(workspace: &Path, source: &str) -> Result<PathBuf, String> {
    if source.trim().is_empty() {
        return Err(INVALID_SOURCE.into());
    }
    let path = Path::new(source);
    let relative = if path.is_absolute() {
        let visible_root = wire_path(workspace)?;
        // Compare the path identity before opening anything on the device.
        let component_count = Path::new(&visible_root).components().count();
        let prefix: PathBuf = path.components().take(component_count).collect();
        if project_path_key(prefix.to_str().ok_or(INVALID_SOURCE)?)
            != project_path_key(&visible_root)
        {
            return Err(INVALID_SOURCE.into());
        }
        path.components().skip(component_count).collect::<PathBuf>()
    } else {
        path.to_path_buf()
    };
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(INVALID_SOURCE.into());
    }
    let candidate = workspace.join(relative);
    directory(&candidate)
        .filter(|path| path.starts_with(workspace))
        .ok_or_else(|| INVALID_SOURCE.into())
}

fn wire_path(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("DEVICE_PLUGIN_INVALID_PATH")?;
    #[cfg(windows)]
    let value = value
        .strip_prefix(r"\\?\")
        .filter(|path| !path.starts_with(r"UNC\"))
        .unwrap_or(value);
    Ok(value.into())
}

fn plugin_id(value: Option<&str>) -> Result<&str, String> {
    value
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && !matches!(*id, "." | "..")
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        .ok_or_else(|| "DEVICE_PLUGIN_INVALID_ID".into())
}

struct DevicePluginsBackend<'a> {
    state: &'a KBrainBackendState,
    connection: KBrainBackendConnection,
    owner: Option<i64>,
    client: Client,
}

impl DevicePluginsBackend<'_> {
    fn check_scope(&self) -> Result<(), String> {
        if let Some(owner) = self.owner {
            self.state.require_current_device_owner(owner)?;
        }
        self.state
            .with_current_backend_profile(&self.connection, || Ok(()))
            .map_err(|_| PROFILE_CHANGED.into())
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        self.check_scope()?;
        let mut url = reqwest::Url::parse(&format!(
            "{}{}",
            self.connection.base_url.trim_end_matches('/'),
            path
        ))
        .map_err(|_| "DEVICE_PLUGIN_BACKEND_UNAVAILABLE")?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let request = self
            .client
            .request(method, url)
            .bearer_auth(&self.connection.token);
        let request = match body {
            Some(body) => request.json(body),
            None => request,
        };
        let response = request.send().map_err(|_| "DEVICE_PLUGIN_REQUEST_FAILED")?;
        self.check_scope()?;
        if response.status() == StatusCode::NOT_IMPLEMENTED {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("DEVICE_PLUGIN_HTTP_{}", response.status().as_u16()));
        }
        let mut body = Vec::new();
        response
            .take(RESPONSE_LIMIT + 1)
            .read_to_end(&mut body)
            .map_err(|_| "DEVICE_PLUGIN_RESPONSE_FAILED")?;
        self.check_scope()?;
        if body.len() as u64 > RESPONSE_LIMIT {
            return Err("DEVICE_PLUGIN_RESPONSE_TOO_LARGE".into());
        }
        serde_json::from_slice(&body)
            .map(Some)
            .map_err(|_| "DEVICE_PLUGIN_RESPONSE_INVALID".into())
    }

    fn capability(health: &Value, key: &str) -> bool {
        health
            .get("capabilities")
            .and_then(|values| values.get(key))
            .is_some_and(|value| {
                value.as_bool() == Some(true) || value.as_u64().is_some_and(|number| number > 0)
            })
    }

    fn list(&self, workdir: &str, since: Option<u64>) -> Result<Option<Value>, String> {
        let revision = since.map(|revision| revision.to_string());
        let mut query = vec![("workdir", workdir)];
        if let Some(revision) = revision.as_deref() {
            query.extend([("since", revision), ("wait", "15")]);
        }
        self.request(Method::GET, "/v1/plugins", &query, None)
    }

    fn operation(&self, request: DevicePluginRequest) -> Result<Option<DevicePluginList>, String> {
        let remote = self.owner.is_some();
        self.check_scope()?;
        let workdir =
            self.state
                .with_current_backend_profile(&self.connection, || {
                    match request
                        .workdir
                        .as_deref()
                        .filter(|path| !path.trim().is_empty())
                    {
                        Some(workdir) => {
                            let roots = crate::commands::settings::device_plugin_workspace_paths()?;
                            resolve_workspace(workdir, &roots).map(Some)
                        }
                        None if remote
                            || matches!(
                                request.action,
                                DevicePluginAction::Trust | DevicePluginAction::RevokeTrust
                            ) =>
                        {
                            Err(INVALID_WORKSPACE.into())
                        }
                        None => Ok(None),
                    }
                })?;
        let workdir_text = workdir
            .as_deref()
            .map(wire_path)
            .transpose()?
            .unwrap_or_default();
        let health = self
            .request(Method::GET, "/v1/health", &[], None)?
            .ok_or("DEVICE_PLUGIN_BACKEND_UNAVAILABLE")?;
        let trust = Self::capability(&health, "folder_trust");
        if !Self::capability(&health, "plugins") {
            return Ok(Some(DevicePluginList {
                workdir: workdir_text,
                ..DevicePluginList::default()
            }));
        }

        // A remote path must be inside the published workspace. A local install
        // source is obtained from a Native picker, never from renderer input.
        let source = if request.action == DevicePluginAction::Install {
            let bounded_install = self
                .list(&workdir_text, None)?
                .and_then(|list| list.get("boundedInstall").and_then(Value::as_bool));
            if bounded_install != Some(true) {
                return Err("DEVICE_PLUGIN_INSTALL_UNAVAILABLE".into());
            }
            if remote {
                Some(scoped_source(
                    workdir.as_deref().ok_or(INVALID_WORKSPACE)?,
                    request.source_path.as_deref().ok_or(INVALID_SOURCE)?,
                )?)
            } else {
                if request.source_path.is_some() {
                    return Err("DEVICE_PLUGIN_NATIVE_SELECTION_REQUIRED".into());
                }
                let Some(selected) = rfd::FileDialog::new().pick_folder() else {
                    return Ok(None);
                };
                Some(directory(&selected).ok_or("DEVICE_PLUGIN_INVALID_PATH")?)
            }
        } else {
            None
        };
        let coordinator = self.state.configuration_coordinator()?;
        let mut trust_status = None;
        let raw = if request.action == DevicePluginAction::List {
            self.list(&workdir_text, request.since)?
        } else {
            let _guard = coordinator.blocking_lock();
            self.check_scope()?;
            coordinator.ensure_consistent()?;
            self.state
                .with_current_backend_profile(&self.connection, || {
                    if let (Some(workdir), Some(requested)) =
                        (workdir.as_deref(), request.workdir.as_deref())
                    {
                        let roots = crate::commands::settings::device_plugin_workspace_paths()?;
                        if resolve_workspace(requested, &roots)? != workdir {
                            return Err(INVALID_WORKSPACE.into());
                        }
                    }
                    Ok(())
                })?;
            let body = json!({ "workdir": &workdir_text });
            let query = [("workdir", workdir_text.as_str())];
            coordinator.changed();
            match request.action {
                DevicePluginAction::List => unreachable!(),
                DevicePluginAction::Reload => {
                    self.request(Method::POST, "/v1/plugins/reload", &[], Some(&body))?
                }
                DevicePluginAction::Enable
                | DevicePluginAction::Disable
                | DevicePluginAction::Remove => {
                    let id = plugin_id(request.plugin_id.as_deref())?;
                    match request.action {
                        DevicePluginAction::Enable => self.request(
                            Method::POST,
                            &format!("/v1/plugins/{id}/enable"),
                            &[],
                            Some(&body),
                        )?,
                        DevicePluginAction::Disable => self.request(
                            Method::POST,
                            &format!("/v1/plugins/{id}/disable"),
                            &[],
                            Some(&body),
                        )?,
                        _ => self.request(
                            Method::DELETE,
                            &format!("/v1/plugins/{id}"),
                            &query,
                            None,
                        )?,
                    }
                }
                DevicePluginAction::Install => {
                    let path = wire_path(source.as_deref().ok_or(INVALID_SOURCE)?)?;
                    let body = if remote {
                        json!({ "workdir": &workdir_text, "path": path, "sourceRoot": &workdir_text })
                    } else {
                        json!({ "workdir": &workdir_text, "path": path })
                    };
                    self.request(Method::POST, "/v1/plugins/install", &[], Some(&body))?
                }
                DevicePluginAction::Trust | DevicePluginAction::RevokeTrust => {
                    if !trust {
                        return Err("DEVICE_PLUGIN_TRUST_UNAVAILABLE".into());
                    }
                    trust_status = if request.action == DevicePluginAction::Trust {
                        self.request(Method::POST, "/v1/trust", &[], Some(&body))?
                    } else {
                        self.request(Method::DELETE, "/v1/trust", &query, None)?
                    };
                    self.list(&workdir_text, None)?
                }
            }
        };
        self.check_scope()?;
        let Some(raw) = raw else {
            return Ok(Some(DevicePluginList {
                workdir: workdir_text,
                ..DevicePluginList::default()
            }));
        };
        let mut list: DevicePluginList =
            serde_json::from_value(raw).map_err(|_| "DEVICE_PLUGIN_RESPONSE_INVALID")?;
        list.available = true;
        list.trust_available = trust;
        if trust && list.trusted && !workdir_text.is_empty() && request.since.is_none() {
            let status = trust_status.or_else(|| {
                self.request(
                    Method::GET,
                    "/v1/trust",
                    &[("workdir", &workdir_text)],
                    None,
                )
                .ok()
                .flatten()
            });
            let source = status
                .as_ref()
                .filter(|status| {
                    status.get("trusted").and_then(Value::as_bool) == Some(list.trusted)
                })
                .and_then(|status| {
                    let folder = status.get("workdir")?.as_str()?;
                    let source = status.get("source")?.as_str()?;
                    (!source.is_empty()).then_some((folder, source))
                });
            if let Some((folder, source)) = source {
                list.trust_inherited = Some(folder != source);
                // Ancestors of a published project may be outside the remote lease.
                if !remote {
                    list.trust_source = Some(source.to_owned());
                }
            }
        }
        self.check_scope()?;
        list.workdir = workdir_text;
        if remote && !list.errors.is_empty() {
            list.errors = vec!["DEVICE_PLUGIN_LOAD_ERRORS".into()];
        }
        Ok(Some(list))
    }
}

async fn run_operation(
    state: Arc<KBrainBackendState>,
    owner: Option<i64>,
    request: DevicePluginRequest,
) -> Result<Option<DevicePluginList>, String> {
    // Capture before scheduling so a late task cannot pick up another account's backend.
    let connection = state
        .running_connection()
        .ok_or("DEVICE_PLUGIN_BACKEND_UNAVAILABLE")?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(22))
            .build()
            .map_err(|_| "DEVICE_PLUGIN_BACKEND_UNAVAILABLE")?;
        DevicePluginsBackend {
            state: &state,
            connection,
            owner,
            client,
        }
        .operation(request)
    })
    .await
    .map_err(|_| "DEVICE_PLUGIN_REQUEST_FAILED")?
}

#[tauri::command]
pub(crate) async fn device_plugins_operation(
    kbrain_backend: tauri::State<'_, Arc<KBrainBackendState>>,
    request: DevicePluginRequest,
) -> Result<Option<DevicePluginList>, String> {
    run_operation(Arc::clone(kbrain_backend.inner()), None, request).await
}

pub(crate) async fn remote_device_plugins_operation(
    app: &AppHandle,
    owner_id: i64,
    request: DevicePluginRequest,
) -> Result<DevicePluginList, String> {
    let state = app
        .try_state::<Arc<KBrainBackendState>>()
        .ok_or("DEVICE_PLUGIN_BACKEND_UNAVAILABLE")?;
    run_operation(Arc::clone(state.inner()), Some(owner_id), request)
        .await?
        .ok_or_else(|| "DEVICE_PLUGIN_REQUEST_FAILED".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_plugin_paths_require_the_published_root_and_stay_inside_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let plugin = root.join("plugin");
        fs::create_dir_all(&plugin).unwrap();
        let granted = vec![root.clone()];
        let root = resolve_workspace(root.to_str().unwrap(), &granted).unwrap();
        assert_eq!(
            scoped_source(&root, "plugin").unwrap(),
            plugin.canonicalize().unwrap()
        );
        assert!(scoped_source(&root, "..").is_err());
        assert!(resolve_workspace(plugin.to_str().unwrap(), &granted).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path(), root.join("alias")).unwrap();
            assert!(scoped_source(&root, "alias").is_err());
        }
    }

    #[test]
    fn plugin_projection_never_returns_capability_urls_or_on_disk_path() {
        let list: DevicePluginList = serde_json::from_value(json!({
            "boundedInstall": true,
            "plugins": [{
                "id": "local", "source": "user", "path": "sensitive",
                "contributes": { "ui": [{ "id": "panel", "title": "Panel", "placement": "settings", "url": "sensitive" }] }
            }]
        })).unwrap();
        let projected = serde_json::to_value(&list).unwrap();
        assert_eq!(projected["installAvailable"], true);
        assert_eq!(
            projected["plugins"][0]["contributes"]["ui"][0]["title"],
            "Panel"
        );
        assert!(!projected.to_string().contains("sensitive"));
        assert!(!DevicePluginList::default().install_available);
        assert!(plugin_id(Some("../other")).is_err());
    }
}
