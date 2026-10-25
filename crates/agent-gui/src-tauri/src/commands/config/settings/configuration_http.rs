use crate::services::backend_facade::{
    ConfigurationHttpRequest, ConfigurationHttpResponse, ConfigurationHttpService,
};
use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};
use std::sync::Weak;

pub(crate) struct ProfileConfigurationHttp {
    backend: Option<Weak<KBrainBackendState>>,
    connection: KBrainBackendConnection,
    backend_root: PathBuf,
    settings_root: PathBuf,
}

pub(crate) fn configuration_http_service(
    backend: Weak<KBrainBackendState>,
    connection: KBrainBackendConnection,
    backend_root: PathBuf,
) -> Result<Arc<dyn ConfigurationHttpService>, String> {
    Ok(Arc::new(ProfileConfigurationHttp {
        backend: Some(backend),
        connection,
        backend_root,
        settings_root: config_dir()?,
    }))
}

fn http_configuration_error(status: u16, error: impl Into<String>) -> ConfigurationHttpResponse {
    ConfigurationHttpResponse {
        status,
        body: Some(json!({"error":error.into()})),
        etag: None,
    }
}

fn configuration_http_resource(path: &str) -> Option<&'static str> {
    if path == "/v1/configuration" {
        Some("configuration")
    } else if path == "/v1/settings" || path.starts_with("/v1/settings/") {
        Some("settings")
    } else if path == "/v1/mcp" || path.starts_with("/v1/mcp/") {
        Some("mcp")
    } else if matches!(path, "/v1/skills" | "/v1/skills/settings") {
        Some("skills")
    } else if path == "/v1/prompts" || path.starts_with("/v1/prompts/") {
        Some("prompts")
    } else {
        None
    }
}

fn configuration_http_etag(
    client: &ProfileBackupBackend,
    resource: &str,
    revision: &str,
) -> Result<String, String> {
    client
        .configuration
        .version(&json!({"httpResource":resource,"configurationRevision":revision}))
        .map(|version| format!("\"{version}\""))
}

impl ConfigurationHttpService for ProfileConfigurationHttp {
    fn prepare_provider_models(&self, provider_id: &str, input: Value) -> Result<Value, String> {
        self.backend
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or("USA_ZERO_PROFILE_AUTH_REQUIRED")?
            .prepare_provider_models(provider_id, input)
    }

    fn request(&self, request: ConfigurationHttpRequest) -> ConfigurationHttpResponse {
        match self.request_inner(request) {
            Ok(response) => response,
            Err((status, error)) => http_configuration_error(status, error),
        }
    }
}

impl ProfileConfigurationHttp {
    // This endpoint writes one atomic Go skills document. Its workspace settings must
    // not be mistaken for the global skills domain of a composite Native batch.
    fn skills_request_locked(
        client: &ProfileBackupBackend,
        conn: &mut Connection,
        revision: &str,
        request: ConfigurationHttpRequest,
        uri: &url::Url,
    ) -> Result<ConfigurationHttpResponse, (u16, String)> {
        let read = matches!(request.method.as_str(), "GET" | "HEAD");
        if (read && uri.path() != "/v1/skills")
            || (!read && (request.method != "PUT" || uri.path() != "/v1/skills/settings"))
        {
            return Err((405, "技能资源不支持此操作".into()));
        }
        let body = request.body.unwrap_or_else(|| json!({}));
        let workdir = if read {
            uri.query_pairs()
                .find(|(key, _)| key == "workdir")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default()
        } else {
            body.as_object().ok_or((400, "技能配置必须是对象".into()))?;
            body.get("workdir")
                .map(|value| value.as_str().ok_or((400, "技能工作区必须是字符串".into())))
                .transpose()?
                .unwrap_or("")
                .to_owned()
        };
        let path = if workdir.is_empty() {
            "/v1/skills".to_owned()
        } else {
            format!(
                "/v1/skills?{}",
                url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("workdir", &workdir)
                    .finish()
            )
        };
        let document = client
            .request(reqwest::Method::GET, &path, None)
            .map_err(|error| (configuration_backend_error_status(&error), error))?;
        let valid_document =
            |value: &Value| value["revision"].is_u64() && value["settings"].is_object();
        if !valid_document(&document) {
            return Err((500, "技能后端返回了无效文档".into()));
        }
        if let Some(state) = &client.state {
            state
                .verify_portable_backup(&document)
                .map_err(|error| (500, error))?;
            if !read {
                state
                    .verify_portable_backup(&body)
                    .map_err(|error| (400, error))?;
            }
        }
        let etag_for = |revision: &str, document: &Value| {
            client
                .configuration
                .version(&json!({
                    "httpResource":"skills", "workdir":workdir,
                    "configurationRevision":revision, "document":document,
                }))
                .map(|version| format!("\"{version}\""))
        };
        let etag = etag_for(revision, &document).map_err(|error| (500, error))?;
        if read {
            let unchanged = request.if_none_match.as_deref() == Some(etag.as_str());
            return Ok(ConfigurationHttpResponse {
                status: if unchanged { 304 } else { 200 },
                body: if unchanged { None } else { Some(document) },
                etag: Some(etag),
            });
        }
        if request.if_match.as_deref() != Some(etag.as_str()) {
            return Err((412, "ZEROAGENT_CONFIGURATION_CHANGED".into()));
        }
        // Effective workspace settings cannot distinguish an absent override from
        // a custom selection equal to the global list. Keep the actual owned file.
        let backend_root = client
            .backend_root
            .as_ref()
            .ok_or((503, "技能配置目录尚未就绪".into()))?;
        let backend_root =
            fs::canonicalize(backend_root).map_err(|_| (500, "无法核对技能配置目录".into()))?;
        let skills_root = fs::canonicalize(backend_root.join("skills"))
            .map_err(|_| (500, "无法核对技能目录".into()))?;
        let reported_root = document["rootDir"]
            .as_str()
            .ok_or((500, "技能文档缺少目录".into()))?;
        let reported_root =
            fs::canonicalize(reported_root).map_err(|_| (500, "无法核对技能文档目录".into()))?;
        if !skills_root.starts_with(&backend_root) || reported_root != skills_root {
            return Err((403, "技能目录不属于当前配置空间".into()));
        }
        let source_directory = skills_root
            .parent()
            .filter(|path| path.starts_with(&backend_root))
            .ok_or((403, "技能设置文件不属于当前配置空间".into()))?;
        let source = source_directory.join("skills-settings.json");
        let raw_settings = match fs::symlink_metadata(&source) {
            Ok(metadata) => {
                use std::io::Read;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > BACKUP_MAX_FILE_BYTES
                {
                    return Err((500, "技能设置文件无效".into()));
                }
                let mut bytes = Vec::new();
                fs::File::open(&source)
                    .map_err(|_| (500, "无法打开技能设置文件".into()))?
                    .take(BACKUP_MAX_FILE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| (500, "无法读取技能设置文件".into()))?;
                if bytes.len() as u64 > BACKUP_MAX_FILE_BYTES {
                    return Err((500, "技能设置文件超过大小上限".into()));
                }
                let raw: Value =
                    serde_json::from_slice(&bytes).map_err(|_| (500, "技能设置文件无效".into()))?;
                if raw["revision"] != document["revision"] {
                    return Err((412, "ZEROAGENT_CONFIGURATION_CHANGED".into()));
                }
                json!({"exists":true,"document":raw})
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if document["revision"] != json!(0) {
                    return Err((412, "ZEROAGENT_CONFIGURATION_CHANGED".into()));
                }
                json!({"exists":false})
            }
            Err(_) => return Err((500, "无法核对技能设置文件".into())),
        };
        let directory = client.settings_root.join("configuration-recovery");
        fs::create_dir_all(&directory).map_err(|_| (500, "无法创建私有恢复目录".into()))?;
        let recovery = directory.join(format!("before-{}-{}.json", now_ms(), Uuid::new_v4()));
        let before = json!({"format":"zeroagent-private-skills-v1", "storageId":client.connection.storage_id,
            "workdir":workdir, "revision":document["revision"], "effectiveSettings":document["settings"], "rawSettingsFile":raw_settings,
            "sourceRelativePath":source.strip_prefix(&backend_root).map_err(|_| (403, "技能设置文件不属于当前配置空间".into()))?.to_string_lossy()});
        write_private_backup(
            &recovery,
            &serde_json::to_vec(&before).map_err(|_| (500, "无法序列化技能恢复副本".into()))?,
        )
        .map_err(|error| (500, error))?;
        retain_canonical_recovery(&directory, &recovery).map_err(|error| (500, error))?;
        let mut saved = client
            .request(reqwest::Method::PUT, "/v1/skills/settings", Some(&body))
            .map_err(|error| {
                let status = if client.configuration.ensure_consistent().is_err() {
                    503
                } else {
                    configuration_backend_error_status(&error)
                };
                (status, error)
            })?;
        if !valid_document(&saved) {
            client.configuration.uncertain_commit();
            return Err((503, "技能保存回执无效，请重启客户端并核对当前配置".into()));
        }
        if let Some(state) = &client.state {
            if state.verify_portable_backup(&saved).is_err() {
                client.configuration.uncertain_commit();
                return Err((
                    503,
                    "技能保存回执无法核对，请重启客户端并检查当前配置".into(),
                ));
            }
        }
        let after = (|| {
            let current = client.request(reqwest::Method::GET, &path, None)?;
            if !valid_document(&current) {
                return Err("技能文档无效".into());
            }
            if let Some(state) = &client.state {
                state.verify_portable_backup(&current)?;
            }
            let documents = client.documents_locked()?;
            let native = native_configuration_revision(conn)?;
            let revision = client.revision_locked(&native, &documents)?;
            let etag = etag_for(&revision, &current)?;
            Ok::<_, String>((etag, current))
        })();
        let etag = match after {
            Ok((etag, current)) => {
                saved = current;
                Some(etag)
            }
            Err(_) => {
                // The write was acknowledged. Do not misreport a failed refresh as a
                // rejected save, or lend the old version to the next edit.
                saved["warning"] = json!("技能配置已保存，当前版本暂未刷新，请重新读取后继续编辑");
                None
            }
        };
        Ok(ConfigurationHttpResponse {
            status: 200,
            body: Some(saved),
            etag,
        })
    }
    fn request_inner(
        &self,
        request: ConfigurationHttpRequest,
    ) -> Result<ConfigurationHttpResponse, (u16, String)> {
        let uri = url::Url::parse(&format!("http://native{}", request.uri))
            .map_err(|_| (400, "配置请求地址无效".into()))?;
        let path = uri.path();
        let resource = configuration_http_resource(path).ok_or((404, "配置资源不存在".into()))?;
        let read = matches!(request.method.as_str(), "GET" | "HEAD");
        if !read && request.if_match.is_none() {
            return Err((428, "ZEROAGENT_CONFIGURATION_VERSION_REQUIRED".into()));
        }
        let state = match &self.backend {
            Some(backend) => Some(
                backend
                    .upgrade()
                    .ok_or((401, "USA_ZERO_PROFILE_AUTH_REQUIRED".into()))?,
            ),
            None => None,
        };
        let mut client =
            ProfileBackupBackend::new(self.connection.clone(), state, self.settings_root.clone())
                .map_err(|error| (500, error))?;
        client.backend_root = Some(self.backend_root.clone());
        let _guard = client.configuration.blocking_lock();
        client.ensure_owner().map_err(|error| (401, error))?;
        client
            .configuration
            .ensure_consistent()
            .map_err(|error| (503, error))?;
        let mut conn =
            open_profile_db(self.settings_root.join(DB_FILENAME)).map_err(|error| (500, error))?;
        let documents = client.documents_locked().map_err(|error| (500, error))?;
        let snapshot = conn
            .transaction()
            .map_err(|_| (500, "无法读取配置版本".into()))?;
        let native_revision =
            native_configuration_revision(&snapshot).map_err(|error| (500, error))?;
        snapshot
            .commit()
            .map_err(|_| (500, "无法完成配置版本读取".into()))?;
        let revision = client
            .revision_locked(&native_revision, &documents)
            .map_err(|error| (500, error))?;
        if resource == "skills" {
            return Self::skills_request_locked(&client, &mut conn, &revision, request, &uri);
        }
        let etag =
            configuration_http_etag(&client, resource, &revision).map_err(|error| (500, error))?;
        if read {
            // Only the root documents contain the complete editable resource. A markdown
            // template listing must not lend its version to an unrelated global-template edit.
            let root = matches!(
                path,
                "/v1/configuration" | "/v1/settings" | "/v1/mcp" | "/v1/prompts"
            );
            if root && request.if_none_match.as_deref() == Some(etag.as_str()) {
                return Ok(ConfigurationHttpResponse {
                    status: 304,
                    body: None,
                    etag: Some(etag),
                });
            }
            let value = match (path, uri.query()) {
                ("/v1/configuration", _) => serde_json::to_value(&documents)
                    .map_err(|_| (500, "无法序列化配置文档".into()))?,
                ("/v1/settings", _) => documents.settings,
                ("/v1/mcp", _) => documents.mcp,
                ("/v1/prompts", None) => documents.prompts,
                _ => client
                    .request(reqwest::Method::GET, &request.uri, None)
                    .map_err(|error| (configuration_backend_error_status(&error), error))?,
            };
            if let Some(state) = &client.state {
                state
                    .verify_portable_backup(&value)
                    .map_err(|error| (500, error))?;
            }
            return Ok(ConfigurationHttpResponse {
                status: 200,
                body: Some(value),
                etag: root.then_some(etag),
            });
        }
        if request.if_match.as_deref() != Some(etag.as_str()) {
            return Err((412, "ZEROAGENT_CONFIGURATION_CHANGED".into()));
        }
        let mut update = CanonicalConfigurationUpdate {
            skills: None,
            expected_revision: revision,
            native_changes: json!({}),
            settings: None,
            mcp: None,
            templates: None,
            projects: Vec::new(),
        };
        let body = request.body.unwrap_or_else(|| json!({}));
        let mut status = 200;
        match (request.method.as_str(), path) {
            ("PUT", "/v1/configuration") => {
                let input = body.as_object().ok_or((400, "配置更新必须是对象".into()))?;
                if input.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "settings" | "mcp" | "templates" | "projects" | "skills"
                    )
                }) {
                    return Err((400, "HTTP 配置更新包含不支持的字段".into()));
                }
                update.settings = input.get("settings").cloned();
                update.mcp = input.get("mcp").cloned();
                update.templates = input.get("templates").cloned();
                update.skills = input.get("skills").cloned();
                update.projects = input
                    .get("projects")
                    .map(|projects| {
                        serde_json::from_value(projects.clone())
                            .map_err(|_| (400, "项目提示词更新格式无效".into()))
                    })
                    .transpose()?
                    .unwrap_or_default();
            }
            ("PUT", "/v1/settings") => update.settings = Some(body.clone()),
            ("PUT", "/v1/mcp") => update.mcp = Some(body.clone()),
            ("POST", "/v1/mcp/reload") => {
                update.mcp = Some(
                    client
                        .private_mcp_locked(&documents.mcp)
                        .map_err(|error| (500, error))?,
                )
            }
            ("PUT", "/v1/prompts/templates") => {
                check_http_prompt_revision(&body, &documents.prompts)?;
                update.templates = Some(
                    body.get("templates")
                        .cloned()
                        .ok_or((400, "缺少提示词模板列表".into()))?,
                );
            }
            ("POST", "/v1/prompts/templates") => {
                let mut templates = documents.prompts["globalTemplates"]
                    .as_array()
                    .cloned()
                    .ok_or((500, "提示词快照无效".into()))?;
                let mut template = body
                    .as_object()
                    .cloned()
                    .ok_or((400, "提示词模板必须是对象".into()))?;
                let id = template
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or((422, "提示词模板缺少 ID".into()))?;
                if templates.iter().any(|template| template["id"] == id) {
                    return Err((409, "提示词模板已存在".into()));
                }
                if template.get("enabled").and_then(Value::as_bool) == Some(true) {
                    for existing in &mut templates {
                        existing["enabled"] = json!(false);
                    }
                }
                templates.push(Value::Object(template));
                update.templates = Some(json!(templates));
                status = 201;
            }
            ("PATCH" | "DELETE", path)
                if path
                    .strip_prefix("/v1/prompts/templates/")
                    .is_some_and(|id| !id.is_empty() && !id.contains('/')) =>
            {
                let id = path.strip_prefix("/v1/prompts/templates/").unwrap();
                let mut templates = documents.prompts["globalTemplates"]
                    .as_array()
                    .cloned()
                    .ok_or((500, "提示词快照无效".into()))?;
                let position = templates
                    .iter()
                    .position(|template| template["id"] == id)
                    .ok_or((404, "提示词模板不存在".into()))?;
                if request.method == "DELETE" {
                    templates.remove(position);
                } else {
                    check_http_prompt_revision(&body, &documents.prompts)?;
                    let patch = body
                        .as_object()
                        .ok_or((400, "提示词修改必须是对象".into()))?;
                    for field in ["name", "description", "prompt", "enabled"] {
                        if let Some(value) = patch.get(field).filter(|value| !value.is_null()) {
                            templates[position][field] = value.clone();
                        }
                    }
                    if patch.get("enabled").and_then(Value::as_bool) == Some(true) {
                        for (index, existing) in templates.iter_mut().enumerate() {
                            if index != position {
                                existing["enabled"] = json!(false);
                            }
                        }
                    }
                }
                update.templates = Some(json!(templates));
            }
            ("PUT", "/v1/prompts/project") => {
                let workdir = body
                    .get("workdir")
                    .and_then(Value::as_str)
                    .ok_or((400, "缺少项目目录".into()))?
                    .to_owned();
                let prompt = body
                    .get("prompt")
                    .map(|value| value.as_str().ok_or((400, "项目提示词必须是字符串".into())))
                    .transpose()?
                    .unwrap_or("")
                    .to_owned();
                let strategy = body
                    .get("strategy")
                    .map(|value| value.as_str().ok_or((400, "项目提示词策略无效".into())))
                    .transpose()?
                    .filter(|s| !s.is_empty())
                    .unwrap_or("append")
                    .to_owned();
                update.projects.push(CanonicalProjectChange {
                    workdir,
                    prompt,
                    strategy,
                });
            }
            _ => return Err((405, "配置资源不支持此操作".into())),
        }
        let result = client
            .save_canonical_locked(
                &mut conn,
                update,
                &default_project_workdir().map_err(|error| (500, error))?,
            )
            .map_err(|error| {
                let status = if error.contains("ZEROAGENT_CONFIGURATION_CHANGED") {
                    412
                } else if client.configuration.ensure_consistent().is_err() {
                    503
                } else {
                    configuration_backend_error_status(&error)
                };
                (status, error)
            })?;
        let etag = configuration_http_etag(&client, resource, &result.configuration_revision)
            .map_err(|error| (500, error))?;
        let value = match resource {
            "configuration" => serde_json::to_value(&result.backend)
                .map_err(|_| (500, "无法序列化配置文档".into()))?,
            "settings" => result.backend.settings,
            "mcp" => result.backend.mcp,
            _ if path == "/v1/prompts/project" => {
                json!({"version":"kbrain.agent.v1","revision":result.backend.prompts["revision"],"prompt":body.get("prompt").and_then(Value::as_str).unwrap_or(""),"strategy":body.get("strategy").and_then(Value::as_str).filter(|value|!value.is_empty()).unwrap_or("append")})
            }
            _ => {
                json!({"version":"kbrain.agent.v1","revision":result.backend.prompts["revision"],"templates":result.backend.prompts["globalTemplates"]})
            }
        };
        Ok(ConfigurationHttpResponse {
            status,
            body: Some(value),
            etag: Some(etag),
        })
    }
}

fn check_http_prompt_revision(body: &Value, prompts: &Value) -> Result<(), (u16, String)> {
    if let Some(revision) = body
        .get("baseRevision")
        .filter(|revision| !revision.is_null())
    {
        if revision.as_u64().is_none() {
            return Err((400, "提示词版本格式无效".into()));
        }
        if revision != &prompts["revision"] {
            return Err((409, "提示词版本已更新".into()));
        }
    }
    Ok(())
}

fn configuration_backend_error_status(error: &str) -> u16 {
    if error == "USA_ZERO_PROFILE_AUTH_REQUIRED" {
        return 401;
    }
    for code in [400, 401, 403, 404, 409, 412, 422, 503] {
        if error.contains(&format!("（{code}）")) {
            return code;
        }
    }
    400
}
