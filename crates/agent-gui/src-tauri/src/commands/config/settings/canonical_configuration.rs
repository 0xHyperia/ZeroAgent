/// Public configuration documents from one read under the profile gate. Runtime
/// statuses and rendered instruction files are not part of the saved-config version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalBackendDocuments {
    pub settings: Value,
    pub mcp: Value,
    pub prompts: Value,
    pub skills: Value,
    #[serde(skip)]
    mcp_private_digest: String,
}

impl CanonicalBackendDocuments {
    fn material(&self, native_revision: &str) -> Value {
        json!({
            "nativeRevision": native_revision,
            "settings": self.settings,
            "mcp": self.mcp.get("settings").unwrap_or(&self.mcp),
            "mcpPrivateDigest": self.mcp_private_digest,
            "skills": self.skills,
            "prompts": {
                "revision": self.prompts.get("revision"),
                "globalTemplates": self.prompts.get("globalTemplates"),
                "projectPrompts": self.prompts.get("projectPrompts"),
            }
        })
    }
}

fn read_private_backend_json_at(root: &Path, name: &str) -> Result<Option<Value>, String> {
    use std::io::Read;
    let path = root.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取当前空间的私有配置".into()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > BACKUP_MAX_FILE_BYTES
        || !path
            .canonicalize()
            .map_err(|_| "无法定位私有配置")?
            .starts_with(root.canonicalize().map_err(|_| "无法定位配置空间")?)
    {
        return Err("私有配置文件不属于当前空间".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法读取私有配置")?
        .take(BACKUP_MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取私有配置")?;
    if bytes.len() as u64 > BACKUP_MAX_FILE_BYTES {
        return Err("私有配置超过大小上限".into());
    }
    if name == "config.json" {
        parse_kbrain_private_jsonc(&bytes).map(Some)
    } else {
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "私有配置格式无效".into())
    }
}

impl ProfileBackupBackend {
    fn documents_locked(&self) -> Result<CanonicalBackendDocuments, String> {
        let mut documents = CanonicalBackendDocuments {
            settings: self.request(reqwest::Method::GET, "/v1/settings", None)?,
            mcp: self.request(reqwest::Method::GET, "/v1/mcp", None)?,
            prompts: self.request(reqwest::Method::GET, "/v1/prompts", None)?,
            skills: {
                let document = self.request(reqwest::Method::GET, "/v1/skills", None)?;
                json!({"revision":document["revision"],"settings":document["settings"]})
            },
            mcp_private_digest: String::new(),
        };
        if !documents
            .settings
            .get("providers")
            .is_some_and(Value::is_array)
            || !documents.mcp.get("settings").is_some_and(Value::is_object)
            || !documents
                .prompts
                .get("globalTemplates")
                .is_some_and(Value::is_array)
            || documents
                .prompts
                .get("revision")
                .and_then(Value::as_u64)
                .is_none()
            || !documents
                .prompts
                .get("projectPrompts")
                .is_some_and(Value::is_object)
        {
            return Err("规范配置后端返回了无效文档".into());
        }
        let private_mcp = self.private_mcp_locked(&documents.mcp)?;
        documents.mcp_private_digest =
            backup_sha256_hex(&serde_json::to_vec(&private_mcp).map_err(|_| "无法校验 MCP 配置")?);
        documents.mcp["settings"] = public_mcp_with_presence(&private_mcp)?;
        // These are public documents. A reflected runtime/account credential is
        // an error, never a reason to return the private bearer through this IPC.
        if let Some(state) = &self.state {
            state.verify_portable_backup(
                &serde_json::to_value(&documents).map_err(|_| "无法校验配置文档")?,
            )?;
        }
        Ok(documents)
    }

    fn revision_locked(
        &self,
        native_revision: &str,
        documents: &CanonicalBackendDocuments,
    ) -> Result<String, String> {
        self.configuration
            .version(&documents.material(native_revision))
    }

    fn private_backend_json(&self, name: &str) -> Result<Option<Value>, String> {
        let Some(root) = &self.backend_root else {
            return Ok(None);
        };
        read_private_backend_json_at(root, name)
    }

    fn private_mcp_locked(&self, public: &Value) -> Result<Value, String> {
        let public = public.get("settings").ok_or("MCP 配置格式无效")?;
        if let Some(private) = self.private_backend_json("config.json.live-mcp.json")? {
            // GET intentionally removes env/headers/credentialRef. A failed Go
            // replacement can leave disk and runtime different; never call that
            // mixture a consistent snapshot or silently erase its private fields.
            if strip_mcp_private_fields(&private)? != strip_mcp_private_fields(public)? {
                return Err("MCP 运行状态与私有配置不一致，请重启客户端后核对".into());
            }
            return Ok(private);
        }
        let mut private = public.clone();
        let legacy = self
            .private_backend_json("config.json")?
            .unwrap_or_else(|| json!({}));
        if !legacy.is_object() {
            return Err("私有配置格式无效".into());
        }
        let configs = legacy
            .get("mcp")
            .or_else(|| legacy.get("mcpServers"))
            .or_else(|| legacy.get("mcp_servers"))
            .and_then(Value::as_object);
        if let Some(servers) = private.get_mut("servers").and_then(Value::as_array_mut) {
            for server in servers {
                let id = server.get("id").and_then(Value::as_str).unwrap_or("");
                let matching = configs
                    .map(|configs| {
                        configs
                            .iter()
                            .filter(|(key, _)| key.trim() == id)
                            .map(|(_, value)| value)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if matching.len() > 1 {
                    return Err("旧版 MCP 服务标识重复，请重启客户端后核对".into());
                }
                if let Some(config) = matching.first() {
                    let remote = config
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(|url| !url.is_empty());
                    let command = config.get("command").and_then(Value::as_array);
                    let target = json!({"transport":if remote {"http"} else {"stdio"},
                        "url":config.get("url"),"cwd":config.get("cwd"),
                        "command":if remote {None} else {command.and_then(|args|args.first())},
                        "args":if remote {Vec::<Value>::new()} else {command.map(|args|args.iter().skip(1).cloned().collect()).unwrap_or_default()}});
                    if mcp_target_identity(&target) != mcp_target_identity(server) {
                        return Err("MCP 运行目标与私有配置不一致，请重启客户端后核对".into());
                    }
                    for field in ["env", "headers"] {
                        if let Some(value) = config.get(field) {
                            if !value
                                .as_object()
                                .is_some_and(|values| values.values().all(Value::is_string))
                            {
                                return Err("旧版 MCP 私有配置格式无效".into());
                            }
                            server[field] = value.clone();
                        }
                    }
                } else if self.backend_root.is_some() {
                    return Err("MCP 私有配置缺失，请重启客户端后核对".into());
                }
            }
        }
        Ok(private)
    }
}

// Match the pinned Go config reader: comments and trailing commas are allowed,
// but JSON strings (including URLs and escaped quotes) must remain unchanged.
fn parse_kbrain_private_jsonc(bytes: &[u8]) -> Result<Value, String> {
    let invalid = || "私有配置格式无效".to_string();
    let mut json = bytes.to_vec();
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        if in_string {
            match bytes[index] {
                b'\\' => index += 1,
                b'"' => in_string = false,
                _ => {}
            }
            index += 1;
            continue;
        }
        if bytes[index] == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if bytes[index..].starts_with(b"//") || bytes[index..].starts_with(b"/*") {
            let start = index;
            if bytes[index..].starts_with(b"//") {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            } else {
                index += 2;
                while index + 1 < bytes.len() && &bytes[index..index + 2] != b"*/" {
                    index += 1;
                }
                if index + 1 >= bytes.len() {
                    return Err(invalid());
                }
                index += 2;
            }
            for byte in &mut json[start..index] {
                if *byte != b'\n' {
                    *byte = b' ';
                }
            }
        } else {
            index += 1;
        }
    }
    if in_string {
        return Err(invalid());
    }
    index = 0;
    while index < json.len() {
        if in_string {
            match json[index] {
                b'\\' => index += 1,
                b'"' => in_string = false,
                _ => {}
            }
        } else if json[index] == b'"' {
            in_string = true;
        } else if json[index] == b',' {
            let mut next = index + 1;
            while next < json.len() && matches!(json[next], b' ' | b'\t' | b'\r' | b'\n') {
                next += 1;
            }
            if next < json.len() && matches!(json[next], b'}' | b']') {
                json[index] = b' ';
            }
        }
        index += 1;
    }
    serde_json::from_slice(&json).map_err(|_| invalid())
}

fn strip_mcp_private_fields(settings: &Value) -> Result<Value, String> {
    let mut value = settings.clone();
    let servers = value
        .get_mut("servers")
        .and_then(Value::as_array_mut)
        .ok_or("MCP 服务列表无效")?;
    for server in servers {
        let object = server.as_object_mut().ok_or("MCP 服务配置无效")?;
        for field in ["env", "headers", "envConfigured", "headersConfigured"] {
            object.remove(field);
        }
        if let Some(auth) = object.get_mut("auth").and_then(Value::as_object_mut) {
            auth.remove("credentialRef");
        }
    }
    Ok(value)
}

fn public_mcp_with_presence(private: &Value) -> Result<Value, String> {
    let mut public = private.clone();
    let servers = public
        .get_mut("servers")
        .and_then(Value::as_array_mut)
        .ok_or("MCP 服务列表无效")?;
    for server in servers {
        for field in ["env", "headers"] {
            if let Some(values) = server.get_mut(field).and_then(Value::as_object_mut) {
                let configured = values.keys().cloned().collect::<Vec<_>>();
                for value in values.values_mut() {
                    *value = json!("");
                }
                server[format!("{field}Configured")] = json!(configured);
            }
        }
        if let Some(auth) = server.get_mut("auth").and_then(Value::as_object_mut) {
            auth.remove("credentialRef");
        }
    }
    Ok(public)
}

fn merge_mcp_private_fields(current: &Value, incoming: Value) -> Result<Value, String> {
    let mut incoming = incoming;
    let old = current
        .get("servers")
        .and_then(Value::as_array)
        .ok_or("MCP 服务列表无效")?;
    let servers = incoming
        .get_mut("servers")
        .and_then(Value::as_array_mut)
        .ok_or("MCP 服务列表无效")?;
    for server in servers {
        let previous = old.iter().find(|item| item.get("id") == server.get("id"));
        let same_target =
            previous.is_none_or(|old| mcp_target_identity(old) == mcp_target_identity(server));
        // These Go-owned constraints have no editor in the current desktop form.
        if same_target {
            for field in ["workspaceRoots", "policy"] {
                if server.get(field).is_none() {
                    if let Some(saved) = previous.and_then(|old| old.get(field)) {
                        server[field] = saved.clone();
                    }
                }
            }
        }
        for field in ["env", "headers"] {
            if let Some(values) = server.get_mut(field).and_then(Value::as_object_mut) {
                for (key, value) in values {
                    if value.as_str() == Some("") {
                        if let Some(saved) = previous
                            .and_then(|old| old.get(field))
                            .and_then(|old| old.get(key))
                        {
                            if !same_target {
                                return Err(
                                    "MCP 目标已更改，请重新填写私有配置或移除对应变量".into()
                                );
                            }
                            *value = saved.clone();
                        } else {
                            return Err("MCP 私有值缺失，请重新填写或移除空白变量".into());
                        }
                    }
                }
            } else if let Some(saved) = previous.and_then(|old| old.get(field)) {
                if !same_target && saved.as_object().is_some_and(|fields| !fields.is_empty()) {
                    return Err("MCP 目标已更改，请重新填写私有配置或移除对应变量".into());
                }
                server[field] = saved.clone();
            }
            server
                .as_object_mut()
                .ok_or("MCP 服务配置无效")?
                .remove(&format!("{field}Configured"));
        }
        if let Some(auth) = server.get_mut("auth").and_then(Value::as_object_mut) {
            if auth
                .get("credentialRef")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                if let Some(saved) = previous
                    .and_then(|old| old.get("auth"))
                    .filter(|old| {
                        same_target
                            && ["type", "clientId", "scope"].iter().all(|field| {
                                old.get(*field).and_then(Value::as_str).unwrap_or("")
                                    == auth.get(*field).and_then(Value::as_str).unwrap_or("")
                            })
                    })
                    .and_then(|old| old.get("credentialRef"))
                {
                    auth.insert("credentialRef".into(), saved.clone());
                }
            }
        }
    }
    Ok(incoming)
}

fn mcp_target_identity(server: &Value) -> Value {
    let text = |field: &str| {
        server
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
    };
    json!({"transport":text("transport"),"url":text("url"),"messageUrl":if text("transport")=="sse"{text("messageUrl")}else{""},"command":text("command"),"cwd":text("cwd"),
        "args":server.get("args").cloned().unwrap_or_else(||json!([]))})
}

fn empty_configuration_changes() -> Value {
    json!({})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalConfigurationUpdate {
    expected_revision: String,
    #[serde(default = "empty_configuration_changes")]
    native_changes: Value,
    settings: Option<Value>,
    mcp: Option<Value>,
    templates: Option<Value>,
    skills: Option<Value>,
    #[serde(default)]
    projects: Vec<CanonicalProjectChange>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalProjectChange {
    workdir: String,
    prompt: String,
    strategy: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalConfigurationResult {
    configuration_revision: String,
    native_revision: String,
    ui_revision: Option<String>,
    ui_preferences: Option<Value>,
    backend: CanonicalBackendDocuments,
    ssh: Option<Value>,
    stt: Option<Value>,
    warning: Option<String>,
}

// This type is private and deliberately has no Debug/Serialize implementation.
// Its only disk representation is an owner-private recovery file, never an export.
struct CanonicalBackendRollback {
    documents: CanonicalBackendDocuments,
    providers: Option<Vec<Value>>,
    mcp: Value,
}

#[derive(Default)]
struct CanonicalAttempts {
    skills: bool,
    settings: bool,
    mcp: bool,
    templates: bool,
    projects: Vec<String>,
}

impl ProfileBackupBackend {
    fn capture_canonical_rollback(
        &self,
        documents: CanonicalBackendDocuments,
        settings_changed: bool,
    ) -> Result<CanonicalBackendRollback, String> {
        let providers = if settings_changed {
            let mut providers = Vec::new();
            for value in documents.settings["providers"]
                .as_array()
                .ok_or("服务商配置无效")?
            {
                let mut provider = value.clone();
                let id = provider
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("服务商缺少 ID")?;
                let secrets = self.request(
                    reqwest::Method::POST,
                    &format!("/v1/settings/providers/{}/secrets", urlencoding::encode(id)),
                    Some(&json!({"confirm":true})),
                )?;
                provider["apiKey"] = secrets.get("apiKey").cloned().unwrap_or(json!(""));
                if let Some(usage) = secrets.get("usageQuery").and_then(Value::as_object) {
                    if !provider.get("usageQuery").is_some_and(Value::is_object) {
                        provider["usageQuery"] = json!({});
                    }
                    for key in ["apiKey", "accessToken", "secretAccessKey"] {
                        if let Some(secret) = usage.get(key) {
                            provider["usageQuery"][key] = secret.clone();
                        }
                    }
                }
                providers.push(portable_provider_update(&provider)?);
            }
            Some(providers)
        } else {
            None
        };
        let mcp = self.private_mcp_locked(&documents.mcp)?;
        Ok(CanonicalBackendRollback {
            documents,
            providers,
            mcp,
        })
    }

    fn write_canonical_recovery(
        &self,
        before: &CanonicalBackendRollback,
    ) -> Result<PathBuf, String> {
        let directory = self.settings_root.join("configuration-recovery");
        fs::create_dir_all(&directory).map_err(|_| "无法创建私有恢复目录")?;
        let path = directory.join(format!("before-{}-{}.json", now_ms(), Uuid::new_v4()));
        let value = json!({"format":"zeroagent-private-configuration-v1","storageId":self.connection.storage_id,
            "settings":before.documents.settings,"providers":before.providers,"mcp":before.mcp,"prompts":before.documents.prompts,"skills":before.documents.skills});
        let bytes = serde_json::to_vec(&value).map_err(|_| "无法保存私有恢复副本")?;
        write_private_backup(&path, &bytes)?;
        retain_canonical_recovery(&directory, &path)?;
        Ok(path)
    }

    fn compensate_canonical(
        &self,
        before: &CanonicalBackendRollback,
        attempts: &CanonicalAttempts,
    ) -> Result<(), String> {
        if attempts.skills {
            self.request(
                reqwest::Method::PUT,
                "/v1/skills/settings",
                Some(&before.documents.skills["settings"]),
            )?;
        }
        for workdir in attempts.projects.iter().rev() {
            let saved = before
                .documents
                .prompts
                .get("projectPrompts")
                .and_then(Value::as_object)
                .and_then(|projects| {
                    projects.values().find(|project| {
                        project
                            .get("workdir")
                            .and_then(Value::as_str)
                            .is_some_and(|path| {
                                normalize_project_path_key(path)
                                    == normalize_project_path_key(workdir)
                            })
                    })
                });
            self.request(reqwest::Method::PUT,"/v1/prompts/project",Some(&json!({"workdir":workdir,
                "prompt":saved.and_then(|p|p.get("prompt")).and_then(Value::as_str).unwrap_or(""),
                "strategy":saved.and_then(|p|p.get("strategy")).and_then(Value::as_str).unwrap_or("append")})))?;
        }
        if attempts.templates {
            let current = self.request(reqwest::Method::GET, "/v1/prompts", None)?;
            self.request(reqwest::Method::PUT,"/v1/prompts/templates",Some(&json!({"templates":before.documents.prompts["globalTemplates"],"baseRevision":current["revision"]})))?;
        }
        if attempts.mcp {
            self.request(reqwest::Method::PUT, "/v1/mcp", Some(&before.mcp))?;
        }
        if attempts.settings {
            let current = self.request(reqwest::Method::GET, "/v1/settings", None)?;
            let providers = before.providers.as_ref().ok_or("缺少服务商恢复副本")?;
            let ids: HashSet<&str> = providers
                .iter()
                .filter_map(|p| p.get("id").and_then(Value::as_str))
                .collect();
            let deleted = current["providers"]
                .as_array()
                .ok_or("服务商配置无效")?
                .iter()
                .filter_map(|p| p.get("id").and_then(Value::as_str))
                .filter(|id| !ids.contains(id))
                .collect::<Vec<_>>();
            self.request(reqwest::Method::PUT,"/v1/settings",Some(&json!({"providers":providers,"deleteProviders":deleted,
                "defaultProvider":before.documents.settings["defaultProvider"],"defaultModel":before.documents.settings["defaultModel"],
                "aiApproval":before.documents.settings.get("aiApproval"),"computer":before.documents.settings.get("computer")})))?;
        }
        Ok(())
    }

    fn save_canonical_locked(
        &self,
        conn: &mut Connection,
        mut update: CanonicalConfigurationUpdate,
        default_workdir: &str,
    ) -> Result<CanonicalConfigurationResult, String> {
        self.configuration.ensure_consistent()?;
        if update.expected_revision.len() > 256
            || !update.expected_revision.starts_with("za-config-v1-")
        {
            return Err("ZEROAGENT_CONFIGURATION_VERSION_REQUIRED".into());
        }
        let before_docs = self.documents_locked()?;
        let native_revision = native_configuration_revision(conn)?;
        if self.revision_locked(&native_revision, &before_docs)? != update.expected_revision {
            return Err("ZEROAGENT_CONFIGURATION_CHANGED".into());
        }
        let prepared = prepare_native_configuration(
            conn,
            NativeConfigurationUpdate {
                expected_revision: native_revision,
                changes: update.native_changes.clone(),
            },
            default_workdir,
        )?;
        if let Some(state) = &self.state {
            state.verify_portable_backup(&update.native_changes)?;
            if let Some(settings) = update.settings.take() {
                update.settings = Some(state.prepare_configuration_settings(settings)?);
            }
            state.verify_portable_backup(
                &json!({"mcp":update.mcp,"templates":update.templates,"projects":update.projects,"skills":update.skills}),
            )?;
        }
        if update.projects.len() > 256 {
            return Err("项目提示词更新数量过多".into());
        }
        let mut workdirs = HashSet::new();
        for project in &update.projects {
            if !matches!(project.strategy.as_str(), "append" | "replace")
                || project.prompt.len() > 1024 * 1024
            {
                return Err("项目提示词格式无效".into());
            }
            let canonical =
                fs::canonicalize(&project.workdir).map_err(|_| "项目目录不存在，请先核对工作区")?;
            if !canonical.is_dir() || !workdirs.insert(canonical) {
                return Err("项目目录无效或重复".into());
            }
        }
        let backend_changed = update.settings.is_some()
            || update.skills.is_some()
            || update.mcp.is_some()
            || update.templates.is_some()
            || !update.projects.is_empty();
        let before =
            self.capture_canonical_rollback(before_docs.clone(), update.settings.is_some())?;
        if let Some(mcp) = update.mcp.take() {
            update.mcp = Some(merge_mcp_private_fields(&before.mcp, mcp)?);
        }
        let recovery = if backend_changed {
            Some(self.write_canonical_recovery(&before)?)
        } else {
            None
        };
        let mut attempts = CanonicalAttempts::default();
        let apply = (|| {
            if let Some(skills) = &update.skills {
                if !skills.is_object() || skills.get("workdir").is_some() {
                    return Err("全局技能配置无效".into());
                }
                attempts.skills = true;
                self.request(reqwest::Method::PUT, "/v1/skills/settings", Some(skills))?;
            }
            if let Some(settings) = &update.settings {
                attempts.settings = true;
                self.request(reqwest::Method::PUT, "/v1/settings", Some(settings))?;
            }
            if let Some(mcp) = &update.mcp {
                attempts.mcp = true;
                self.request(reqwest::Method::PUT, "/v1/mcp", Some(mcp))?;
            }
            if let Some(templates) = &update.templates {
                attempts.templates = true;
                let current = self.request(reqwest::Method::GET, "/v1/prompts", None)?;
                self.request(
                    reqwest::Method::PUT,
                    "/v1/prompts/templates",
                    Some(&json!({"templates":templates,"baseRevision":current["revision"]})),
                )?;
            }
            for project in &update.projects {
                attempts.projects.push(project.workdir.clone());
                self.request(
                    reqwest::Method::PUT,
                    "/v1/prompts/project",
                    Some(&serde_json::to_value(project).map_err(|_| "项目提示词格式无效")?),
                )?;
            }
            // Read acknowledgements and backend normalization before the final
            // atomic SQLite commit. No HTTP read can fail after that commit.
            let after = if backend_changed {
                self.documents_locked()?
            } else {
                before_docs
            };
            let result = commit_native_configuration(conn, prepared)?;
            Ok::<_, String>((after, result))
        })();
        match apply {
            Ok((documents, native)) => Ok(CanonicalConfigurationResult {
                configuration_revision: self
                    .revision_locked(&native.native_revision, &documents)?,
                native_revision: native.native_revision,
                ui_revision: native.ui_revision,
                ui_preferences: native.ui_preferences,
                backend: documents,
                ssh: native.ssh,
                stt: native.stt,
                warning: native.warning,
            }),
            Err(error) => {
                let path = recovery
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default();
                if self.configuration.ensure_consistent().is_err() {
                    return Err(format!("配置更改可能已部分保存，已保留私有恢复副本：{path}。请重启客户端并核对当前配置"));
                }
                if backend_changed && self.compensate_canonical(&before, &attempts).is_err() {
                    self.configuration.uncertain_commit();
                    return Err(format!("配置保存与回退未完成，已保留私有恢复副本：{path}。请重启客户端并核对当前配置"));
                }
                Err(format!("配置未保存，已恢复更改前配置：{error}"))
            }
        }
    }
}

#[tauri::command]
pub async fn settings_save_canonical_batch(
    update: CanonicalConfigurationUpdate,
    automation_scheduler: tauri::State<'_, Arc<AutomationScheduler>>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    kbrain_backend: tauri::State<'_, Arc<crate::services::kbrain_backend::KBrainBackendState>>,
) -> Result<CanonicalConfigurationResult, String> {
    let backend = Arc::clone(kbrain_backend.inner());
    let system_changed = update.native_changes.get("system").is_some();
    let remote_changed = update.native_changes.get("remote").is_some();
    let stt_changed = update.native_changes.get("stt").is_some();
    let (mut result, remote, configuration_guard) =
        tauri::async_runtime::spawn_blocking(move || {
            if !backend.allows_profile_commands() {
                return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
            }
            let mut conn = open_db()?;
            let client = ProfileBackupBackend::new(
                backend.running_connection().ok_or("当前配置后端尚未就绪")?,
                Some(Arc::clone(&backend)),
                config_dir()?,
            )?;
            let guard = client.configuration.blocking_lock();
            if !backend.allows_profile_commands() {
                return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
            }
            let mut result =
                client.save_canonical_locked(&mut conn, update, &default_project_workdir()?)?;
            if system_changed {
                let revision = crate::services::system_proxy::revision();
                if refresh_system_proxy_state(&conn).is_err() {
                    result.warning = Some("配置已保存，系统代理暂未刷新，请重试连接".into());
                } else if crate::services::system_proxy::revision() != revision {
                    backend.push_proxy_setting_locked();
                }
            }
            let remote = if remote_changed {
                match load_remote_settings(&conn) {
                    Ok(remote) => Some(remote),
                    Err(_) => {
                        result.warning = Some("配置已保存，设备连接暂未刷新，请重试连接".into());
                        None
                    }
                }
            } else {
                None
            };
            Ok::<_, String>((result, remote, guard))
        })
        .await
        .map_err(|_| "配置保存任务失败")??;
    if system_changed {
        invalidate_default_tz_cache();
        automation_scheduler.request_reload();
    }
    if let Some(mut remote) = remote {
        remote.token.clear();
        match crate::services::device_credentials::load_device_credential() {
            Ok(Some(credential)) => {
                remote.agent_id = credential.effective_agent_id().to_owned();
                remote.token = credential.effective_token().to_owned();
            }
            Ok(None) => {}
            Err(_) => {
                result.warning = Some("配置已保存，设备凭据暂不可用，请重试连接".into());
                return Ok(result);
            }
        }
        if gateway_controller.apply_config(remote).is_err() {
            result.warning = Some("配置已保存，设备连接未能立即更新，请重试连接".into());
        }
    }
    drop(configuration_guard);
    if stt_changed {
        let _ = gateway_controller.publish_current_settings_sync().await;
    }
    Ok(result)
}

// Keep the most recent private recovery points, including the file for this write.
fn retain_canonical_recovery(directory: &Path, current: &Path) -> Result<(), String> {
    let mut older = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| "无法读取私有恢复目录")? {
        let entry = entry.map_err(|_| "无法读取私有恢复目录")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "无法核对私有恢复副本")?;
        if entry.path() != current
            && name.starts_with("before-")
            && name.ends_with(".json")
            && metadata.is_file()
            && !metadata.file_type().is_symlink()
        {
            older.push((
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                entry.path(),
            ));
        }
    }
    older.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in older.into_iter().skip(19) {
        fs::remove_file(path).map_err(|_| "无法整理私有恢复副本")?;
    }
    Ok(())
}
