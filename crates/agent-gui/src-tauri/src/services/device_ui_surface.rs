use super::*;
use sha2::{Digest, Sha256};

const INVALID: &str = "DEVICE_UI_SURFACE_INVALID";
const UNAVAILABLE: &str = "DEVICE_UI_SURFACE_UNAVAILABLE";
const DOCUMENT_LIMIT: u64 = 1024 * 1024;
const HISTORY_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SurfaceAction {
    History,
    Preview,
    Panel,
    Mcp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SurfaceRequest {
    pub(crate) action: SurfaceAction,
    pub(crate) workdir: Option<String>,
    pub(crate) resource_id: Option<String>,
    pub(crate) plugin_id: Option<String>,
    pub(crate) plugin_version: Option<String>,
}

fn token(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn array(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn clean_panel_segment(value: &str) -> bool {
    !matches!(value, "" | "." | "..")
        && value.len() <= 255
        && value.trim() == value
        && !value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '%' | '?' | '#' | '\\' | ':'))
}

fn project_mcp_result(raw: &Value) -> Option<Value> {
    if let Some(structured) = raw.get("structuredContent") {
        return Some(structured.clone());
    }
    let text: Vec<_> = array(&raw["content"])
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    (!text.is_empty()).then(|| json!(text))
}

fn panel_path(list: &Value, id: &str, version: &str, panel: &str) -> Option<String> {
    let plugin = array(&list["plugins"]).find(|plugin| {
        plugin["id"] == id
            && plugin["version"].as_str().unwrap_or_default() == version
            && plugin["enabled"].as_bool() == Some(true)
    })?;
    let entry = array(&plugin["contributes"]["ui"]).find(|entry| entry["id"] == panel)?;
    let path = entry["url"].as_str()?;
    let mut parts = path.strip_prefix("/v1/plugin-assets/")?.split('/');
    if !lower_hex(parts.next()?, 32) || parts.next()? != id {
        return None;
    }
    let asset: Vec<_> = parts.collect();
    if asset.is_empty()
        || asset.iter().any(|part| !clean_panel_segment(part))
        || !matches!(
            Path::new(asset.last()?)
                .extension()?
                .to_str()?
                .to_ascii_lowercase()
                .as_str(),
            "htm" | "html"
        )
    {
        return None;
    }
    Some(path.to_owned())
}

impl DevicePluginsBackend<'_> {
    fn surface_get(
        &self,
        path: &str,
        query: &[(&str, &str)],
        mime: &str,
        limit: u64,
    ) -> Result<String, String> {
        self.check_scope()?;
        let mut url = reqwest::Url::parse(&format!(
            "{}{}",
            self.connection.base_url.trim_end_matches('/'),
            path
        ))
        .map_err(|_| UNAVAILABLE)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.connection.token)
            .send()
            .map_err(|_| UNAVAILABLE)?;
        self.check_scope()?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|header| header.to_str().ok())
            .and_then(|value| value.split(';').next());
        if !response.status().is_success() || content_type != Some(mime) {
            return Err(UNAVAILABLE.into());
        }
        let mut bytes = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| UNAVAILABLE)?;
        self.check_scope()?;
        if bytes.len() as u64 > limit {
            return Err("DEVICE_UI_SURFACE_TOO_LARGE".into());
        }
        String::from_utf8(bytes).map_err(|_| INVALID.into())
    }

    fn surface_json(
        &self,
        path: &str,
        query: &[(&str, &str)],
        limit: u64,
    ) -> Result<Value, String> {
        serde_json::from_str(&self.surface_get(path, query, "application/json", limit)?)
            .map_err(|_| INVALID.into())
    }

    fn surface_workspace(&self, requested: Option<&str>) -> Result<Option<PathBuf>, String> {
        if requested.is_none_or(str::is_empty) {
            return if self.owner.is_some() {
                Err(INVALID_WORKSPACE.into())
            } else {
                Ok(None)
            };
        }
        self.state
            .with_current_backend_profile(&self.connection, || {
                let roots = crate::commands::settings::device_plugin_workspace_paths()?;
                resolve_workspace(requested.unwrap_or_default(), &roots).map(Some)
            })
    }

    fn check_session_workspace(
        &self,
        workdir: Option<&Path>,
        history: &Value,
        session_id: &str,
    ) -> Result<(), String> {
        if history["session"]["id"].as_str() != Some(session_id) {
            return Err(UNAVAILABLE.into());
        }
        if let Some(root) = workdir {
            let cwd = history["session"]["cwd"]
                .as_str()
                .and_then(|cwd| directory(Path::new(cwd)));
            if cwd.as_ref().is_none_or(|path| path != root) {
                return Err(INVALID_WORKSPACE.into());
            }
        }
        Ok(())
    }

    fn read_surface(
        &self,
        request: SurfaceRequest,
        session_id: Option<String>,
    ) -> Result<Value, String> {
        self.check_scope()?;
        let workspace = self.surface_workspace(request.workdir.as_deref())?;
        let id = request.resource_id.as_deref().unwrap_or_default();
        let document = match request.action {
            SurfaceAction::Panel => {
                let plugin = plugin_id(request.plugin_id.as_deref())?;
                let version = request.plugin_version.as_deref().unwrap_or_default();
                if session_id.is_some() || !token(id, 128) || version.len() > 128 {
                    return Err(INVALID.into());
                }
                let scope = workspace
                    .as_deref()
                    .map(wire_path)
                    .transpose()?
                    .unwrap_or_default();
                let resolve = || {
                    self.list(&scope, None)?
                        .and_then(|list| panel_path(&list, plugin, version, id))
                        .ok_or_else(|| UNAVAILABLE.to_owned())
                };
                let path = resolve()?;
                let html = self.surface_get(&path, &[], "text/html", DOCUMENT_LIMIT)?;
                if resolve()? != path {
                    return Err(UNAVAILABLE.into());
                }
                json!({ "html": html })
            }
            action => {
                if request.plugin_id.is_some() || request.plugin_version.is_some() {
                    return Err(INVALID.into());
                }
                let session_id = session_id
                    .as_deref()
                    .filter(|id| token(id, 128) && !id.contains(':'))
                    .ok_or(UNAVAILABLE)?;
                let session = format!("/v1/sessions/{session_id}");
                let history_path = format!("{session}/history");
                let history = self.surface_json(
                    &history_path,
                    &[(
                        "max_messages",
                        if action == SurfaceAction::History {
                            "100"
                        } else {
                            "1"
                        },
                    )],
                    HISTORY_LIMIT,
                )?;
                self.check_session_workspace(workspace.as_deref(), &history, session_id)?;
                let result = match action {
                    SurfaceAction::History if id.is_empty() => {
                        let previews = self
                            .surface_json(&format!("{session}/previews"), &[], DOCUMENT_LIMIT)
                            .unwrap_or(Value::Null);
                        let previews: Vec<_> = array(&previews["previews"])
                            .filter_map(|item| {
                                let id = item["preview_id"].as_str()?.to_owned();
                                if !lower_hex(&id, 16) || item["source"] != "file" {
                                    return None;
                                }
                                let title: String = item["title"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .chars()
                                    .take(255)
                                    .collect();
                                let call =
                                    item["tool_call_id"].as_str().filter(|id| token(id, 256))?;
                                Some(json!({ "id": id, "title": title, "toolCallId": call }))
                            })
                            .collect();
                        let mcp: Vec<_> = array(&history["session"]["messages"])
                            .flat_map(|message| array(&message["tool_calls"]))
                            .filter(|call| {
                                call["ui_resource"]["result_stored"].as_bool() == Some(true)
                            })
                            .filter_map(|call| call["id"].as_str().filter(|id| token(id, 256)))
                            .collect();
                        json!({ "previews": previews, "mcp": mcp })
                    }
                    SurfaceAction::Preview if lower_hex(id, 16) => {
                        let html = self.surface_get(
                            &format!("{session}/previews/{id}"),
                            &[],
                            "text/html",
                            DOCUMENT_LIMIT,
                        )?;
                        json!({ "html": html })
                    }
                    SurfaceAction::Mcp if token(id, 256) => {
                        let hash = Sha256::digest(format!("mcp-result\0{id}").as_bytes());
                        let hash: String = hash[..16]
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect();
                        let raw = self.surface_json(
                            &format!("{session}/mcp-ui/results/{hash}"),
                            &[],
                            DOCUMENT_LIMIT,
                        )?;
                        let uri = raw["uri"]
                            .as_str()
                            .filter(|uri| uri.starts_with("ui://") && uri.len() <= 2048)
                            .ok_or(INVALID)?;
                        let server = raw["server_id"]
                            .as_str()
                            .filter(|server| token(server, 256))
                            .ok_or(INVALID)?;
                        if raw["tool_call_id"].as_str() != Some(id) {
                            return Err(INVALID.into());
                        }
                        // A disabled/untrusted MCP server cannot replay its stored result.
                        let html = self.surface_get(
                            &format!("{session}/mcp-ui"),
                            &[("server", server), ("uri", uri)],
                            "text/html",
                            DOCUMENT_LIMIT,
                        )?;
                        let result = project_mcp_result(&raw["result"]);
                        json!({ "html": html, "result": result })
                    }
                    _ => return Err(INVALID.into()),
                };
                if self.owner.is_some() {
                    let current =
                        self.surface_json(&history_path, &[("max_messages", "1")], HISTORY_LIMIT)?;
                    self.check_session_workspace(workspace.as_deref(), &current, session_id)?;
                }
                result
            }
        };
        self.check_scope()?;
        if self.surface_workspace(request.workdir.as_deref())? != workspace {
            return Err(INVALID_WORKSPACE.into());
        }
        Ok(document)
    }
}

pub(crate) async fn run_surface(
    state: Arc<KBrainBackendState>,
    connection: KBrainBackendConnection,
    owner: Option<i64>,
    request: SurfaceRequest,
    session_id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| UNAVAILABLE)?;
        DevicePluginsBackend {
            state: &state,
            connection,
            owner,
            client,
        }
        .read_surface(request, session_id)
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn device_ui_surface_operation(
    kbrain_backend: tauri::State<'_, Arc<KBrainBackendState>>,
    request: SurfaceRequest,
    backend_session_id: Option<String>,
) -> Result<Value, String> {
    let connection = kbrain_backend.running_connection().ok_or(UNAVAILABLE)?;
    run_surface(
        Arc::clone(kbrain_backend.inner()),
        connection,
        None,
        request,
        backend_session_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_enabled_version_can_resolve_its_html_panel() {
        let path = "/v1/plugin-assets/0123456789abcdef0123456789abcdef/plugin/view/index.html";
        let mut list = json!({ "plugins": [{
            "id":"plugin", "version":"1", "enabled":true,
            "contributes": { "ui": [{ "id":"panel", "url":path }] }
        }]});
        assert_eq!(
            panel_path(&list, "plugin", "1", "panel").as_deref(),
            Some(path)
        );
        assert!(panel_path(&list, "plugin", "2", "panel").is_none());
        list["plugins"][0]["contributes"]["ui"][0]["url"] =
            json!("/v1/plugin-assets/0123456789abcdef0123456789abcdef/plugin/%2e%2e/index.html");
        assert!(panel_path(&list, "plugin", "1", "panel").is_none());
    }

    #[test]
    fn mcp_replay_projects_result_content_without_private_metadata() {
        let raw =
            json!({ "structuredContent": {"message": "saved"}, "_meta": {"private": "data"} });
        assert_eq!(project_mcp_result(&raw), Some(json!({"message": "saved"})));
    }
}
