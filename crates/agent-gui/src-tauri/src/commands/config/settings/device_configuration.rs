pub(crate) const DEVICE_SETTINGS_PROTOCOL: &str = "zeroagent.settings-sync.v1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceSettingsCommit {
    protocol: &'static str,
    configuration_revision: String,
    ui_preferences_revision: String,
    pub snapshot: Option<Value>,
    pub warning: Option<String>,
}

fn device_provider(provider: &Value) -> Result<Value, String> {
    let mut provider = expect_object(provider.clone(), "服务商配置")?;
    let api = provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-responses");
    let kind = match api {
        "anthropic-messages" => "claude_code",
        "google-generative-ai" => "gemini",
        _ => "codex",
    };
    provider.entry("type").or_insert(json!(kind));
    provider.entry("apiKey").or_insert(json!(""));
    if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            if let Some(object) = model.as_object_mut() {
                if !object.contains_key("maxOutputToken") {
                    if let Some(value) = object.get("maxOutputTokens").cloned() {
                        object.insert("maxOutputToken".into(), value);
                    }
                }
            }
        }
    }
    Ok(Value::Object(provider))
}

impl ProfileBackupBackend {
    fn device_snapshot_with_documents(
        &self,
        conn: &mut Connection,
        documents: &CanonicalBackendDocuments,
    ) -> Result<Value, String> {
        let transaction = conn.transaction().map_err(|_| "无法读取设备配置快照")?;
        let mut snapshot = load_gateway_native_preferences(&transaction)?;
        // Never use old SQLite providers/MCP/templates as the executable configuration.
        snapshot["customProviders"] = json!(documents.settings["providers"]
            .as_array()
            .ok_or("服务商配置无效")?
            .iter()
            .map(device_provider)
            .collect::<Result<Vec<_>, _>>()?);
        snapshot["selectedModel"] = match (
            documents.settings["defaultProvider"].as_str(),
            documents.settings["defaultModel"].as_str(),
        ) {
            (Some(provider), Some(model)) if !provider.is_empty() && !model.is_empty() => {
                json!({"customProviderId":provider,"model":model})
            }
            _ => Value::Null,
        };
        snapshot["mcp"] = documents.mcp["settings"].clone();
        snapshot["agents"] = documents.prompts["globalTemplates"].clone();
        snapshot["aiApproval"] = documents.settings["aiApproval"].clone();
        snapshot["computer"] = documents.settings["computer"].clone();
        if let Some(enabled) = documents.settings["memory"]["enabled"].as_bool() {
            snapshot["kbrainMemory"] = json!({ "enabled": enabled });
        }
        if let Some(organizer) = crate::services::gateway::kbrain_memory::organizer_from_settings(&documents.settings) {
            snapshot["kbrainMemoryOrganizer"] = organizer;
        }
        if let Some(search) = documents.settings.get("webSearch").filter(|value| value.is_object()) {
            snapshot["kbrainWebSearch"] = search.clone();
        }
        if let Some(projects) = documents.prompts["projectPrompts"].as_object() {
            let system = snapshot["system"].as_object_mut().ok_or("系统设置无效")?;
            let resources = system
                .entry("workspaceResourceSettings")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("项目设置无效")?;
            for project in projects.values() {
                let workdir = project["workdir"]
                    .as_str()
                    .filter(|path| !path.trim().is_empty())
                    .ok_or("项目提示词缺少目录")?;
                // Refresh the canonical identity and the client's source alias
                // (e.g. macOS /var), so neither entry retains a stale prompt.
                for path in std::iter::once(workdir).chain(
                    project["sourceWorkdir"]
                        .as_str()
                        .filter(|path| !path.trim().is_empty()),
                ) {
                    let entry = resources
                        .entry(normalize_project_path_key(path))
                        .or_insert_with(|| json!({}));
                    entry["projectPrompt"] = project["prompt"].clone();
                    entry["projectPromptStrategy"] = project["strategy"].clone();
                }
            }
        }
        let ui = load_ui_preferences(&transaction)?;
        if let Some(preferences) = ui
            .ui_preferences
            .and_then(|value| value.as_object().cloned())
        {
            for field in ["customSettings", "chatRuntimeControls", "theme", "locale"] {
                if let Some(value) = preferences.get(field) {
                    snapshot[field] = value.clone();
                }
            }
        }
        snapshot["skills"] = documents.skills["settings"].clone();
        snapshot["settingsSyncProtocol"] = json!(DEVICE_SETTINGS_PROTOCOL);
        snapshot["configurationRevision"] =
            json!(self.revision_locked(&native_configuration_revision(&transaction)?, documents)?);
        snapshot["uiPreferencesRevision"] = json!(ui.ui_revision);
        transaction.commit().map_err(|_| "无法完成设备配置读取")?;
        let snapshot = redact_gateway_settings_sync_payload(snapshot)?;
        if let Some(state) = &self.state {
            state.verify_portable_backup(&snapshot)?;
        }
        self.ensure_owner()?;
        Ok(snapshot)
    }

    fn device_snapshot_locked(&self, conn: &mut Connection) -> Result<Value, String> {
        let documents = self.documents_locked()?;
        self.device_snapshot_with_documents(conn, &documents)
    }

    fn device_outbound_locked(
        &self,
        conn: &mut Connection,
        mut snapshot: Value,
    ) -> Result<Value, String> {
        let documents = self.documents_locked()?;
        let transaction = conn.transaction().map_err(|_| "无法读取设备广播配置")?;
        if snapshot["settingsSyncProtocol"].as_str() != Some(DEVICE_SETTINGS_PROTOCOL)
            || snapshot["configurationRevision"].as_str()
                != Some(
                    self.revision_locked(
                        &native_configuration_revision(&transaction)?,
                        &documents,
                    )?
                    .as_str(),
                )
        {
            return Err("设备广播配置已过期，请重新读取当前空间".into());
        }
        if snapshot["uiPreferencesRevision"].as_str()
            != Some(load_ui_preferences(&transaction)?.ui_revision.as_str())
        {
            return Err("设备界面偏好已更新，请重新读取当前空间".into());
        }
        snapshot
            .as_object_mut()
            .ok_or("设备广播配置无效")?
            .remove(STT_SECRET_SYNC_FIELD);
        if let Some(raw) = load_stt_raw(&transaction)? {
            if let Some(state) = &self.state {
                state.verify_portable_backup(&raw)?;
            }
            snapshot[STT_SECRET_SYNC_FIELD] = raw;
        }
        transaction
            .commit()
            .map_err(|_| "无法完成设备广播配置读取")?;
        self.ensure_owner()?;
        Ok(snapshot)
    }

    fn save_device_locked(
        &self,
        conn: &mut Connection,
        input: Value,
    ) -> Result<DeviceSettingsCommit, String> {
        let input = expect_object(input, "设备配置更新")?;
        if serde_json::to_vec(&input)
            .map_err(|_| "设备配置格式无效")?
            .len()
            > 16 * 1024 * 1024
        {
            return Err("设备配置内容过大".into());
        }
        if input
            .get(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD)
            .is_some_and(|value| !value.is_string())
        {
            return Err("代理密码更新必须是字符串".into());
        }
        let expected = input
            .get("configurationRevision")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("za-config-v1-"))
            .ok_or("ZEROAGENT_CONFIGURATION_VERSION_REQUIRED")?;
        if input.get("settingsSyncProtocol").and_then(Value::as_str)
            != Some(DEVICE_SETTINGS_PROTOCOL)
        {
            return Err("ZEROAGENT_CONFIGURATION_VERSION_REQUIRED".into());
        }
        for key in input.keys() {
            if ![
                "settingsSyncProtocol",
                "configurationRevision",
                "uiPreferencesRevision",
                "nativeConfigurationRevision",
                "system",
                "customProviders",
                "selectedModel",
                "mcp",
                "agents",
                "sshPatch",
                "sshSecretUpdates",
                "stt",
                "sttSecretUpdate",
                "systemProxyPasswordUpdate",
                "providerApiKeyUpdates",
                "providerUsageQuerySecretUpdates",
                "memory",
                "modelFailover",
                "skills",
                "customSettings",
                "chatRuntimeControls",
                "theme",
                "locale",
                "aiApproval",
                "computer",
                "kbrainMemory",
                "kbrainMemoryOrganizer",
                "kbrainWebSearch",
                "remote",
                "automationCron",
                "automationHooks",
                "hooks",
                "cron",
            ]
            .contains(&key.as_str())
            {
                return Err("设备配置更新包含不支持的字段".into());
            }
        }
        if let Some(state) = &self.state {
            state.verify_portable_backup(&Value::Object(input.clone()))?;
        }
        let documents = self.documents_locked()?;
        let current = self.device_snapshot_with_documents(conn, &documents)?;
        if current["configurationRevision"].as_str() != Some(expected) {
            return Err("ZEROAGENT_CONFIGURATION_CHANGED".into());
        }
        let mut changes = Map::new();
        for field in [
            "memory",
            "modelFailover",
            "sshPatch",
            "sshSecretUpdates",
            "stt",
        ] {
            if let Some(value) = input.get(field) {
                changes.insert(field.into(), value.clone());
            }
        }
        if let Some(value) = input.get(STT_SECRET_UPDATE_FIELD) {
            changes.insert("stt".into(), value.clone());
        }
        let mut projects = Vec::new();
        if let Some(value) = input.get("system") {
            let mut system = expect_object(value.clone(), "设备系统设置")?;
            // The active desktop project and proxy password are local private state.
            let private = load_system(conn)?.unwrap_or_else(|| json!({}));
            if let Some(active) = private.get("activeWorkspaceProjectId") {
                system.insert("activeWorkspaceProjectId".into(), active.clone());
            }
            if let Some(proxy) = system.get_mut("systemProxy") {
                let proxy = proxy.as_object_mut().ok_or("系统代理配置无效")?;
                let password = input
                    .get(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD)
                    .and_then(Value::as_str)
                    .or_else(|| {
                        proxy
                            .get("password")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                    })
                    .unwrap_or_else(|| {
                        if proxy.get("passwordConfigured").and_then(Value::as_bool) == Some(false) {
                            ""
                        } else {
                            private["systemProxy"]["password"].as_str().unwrap_or("")
                        }
                    })
                    .to_owned();
                proxy.insert("password".into(), json!(password));
            } else if input.contains_key(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD) {
                return Err("代理密码更新缺少代理配置".into());
            }
            if let Some(resources) = system.get_mut("workspaceResourceSettings") {
                for (path, entry) in resources.as_object_mut().ok_or("项目设置无效")? {
                    let entry = entry.as_object_mut().ok_or("项目设置无效")?;
                    let prompt = entry.remove("projectPrompt");
                    let strategy = entry.remove("projectPromptStrategy");
                    if prompt.is_some() || strategy.is_some() {
                        let prompt = prompt.unwrap_or_else(|| json!(""));
                        let strategy = strategy.unwrap_or_else(|| json!("append"));
                        let before = &current["system"]["workspaceResourceSettings"]
                            [normalize_project_path_key(path)];
                        if before["projectPrompt"].as_str().unwrap_or("")
                            != prompt.as_str().ok_or("项目提示词无效")?
                            || before["projectPromptStrategy"].as_str().unwrap_or("append")
                                != strategy.as_str().ok_or("项目提示词策略无效")?
                        {
                            projects.push(CanonicalProjectChange {
                                workdir: path.clone(),
                                prompt: prompt.as_str().unwrap().into(),
                                strategy: strategy.as_str().unwrap().into(),
                            });
                        }
                    }
                }
            }
            changes.insert("system".into(), Value::Object(system));
        } else if input.contains_key(SYSTEM_PROXY_PASSWORD_UPDATE_FIELD) {
            return Err("代理密码更新必须绑定系统配置".into());
        }
        let preferences = load_ui_preferences(conn)?;
        let mut ui = Map::new();
        for field in ["skills", "chatRuntimeControls", "theme", "locale"] {
            if let Some(value) = input.get(field) {
                ui.insert(field.into(), value.clone());
            }
        }
        if let Some(incoming) = input.get("customSettings") {
            ui.insert(
                "customSettings".into(),
                merge_device_custom_settings(
                    preferences
                        .ui_preferences
                        .as_ref()
                        .and_then(|v| v.get("customSettings")),
                    incoming,
                )?,
            );
        }
        if !ui.is_empty() {
            changes.insert("uiPreferences".into(), json!({"expectedRevision":input.get("uiPreferencesRevision").and_then(Value::as_str).unwrap_or(""),"changes":ui}));
        }
        let settings = device_backend_settings(&input, &documents.settings)?;
        let mcp = input.get("mcp").cloned();
        let saved = self.save_canonical_locked(
            conn,
            CanonicalConfigurationUpdate {
                expected_revision: expected.into(),
                native_changes: Value::Object(changes),
                settings,
                mcp,
                templates: input.get("agents").cloned(),
                projects,
                skills: input.get("skills").cloned(),
            },
            &default_project_workdir()?,
        )?;
        let mut warning = saved.warning;
        let snapshot = match self.device_snapshot_with_documents(conn, &saved.backend) {
            Ok(snapshot) => Some(snapshot),
            Err(_) => {
                warning = Some("配置已保存，当前快照暂不可用，请重新读取设置".into());
                None
            }
        };
        Ok(DeviceSettingsCommit {
            protocol: DEVICE_SETTINGS_PROTOCOL,
            configuration_revision: saved.configuration_revision,
            ui_preferences_revision: saved.ui_revision.unwrap_or(preferences.ui_revision),
            snapshot,
            warning,
        })
    }
}

fn merge_device_custom_settings(
    previous: Option<&Value>,
    incoming: &Value,
) -> Result<Value, String> {
    let mut merged = previous
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let incoming = incoming.as_object().ok_or("界面设置必须是对象")?;
    for (key, value) in incoming {
        if [
            "chatSidebar",
            "interfaceFontFamily",
            "chatFontFamily",
            "codeFontFamily",
            "chatTranscript",
            "fontScale",
        ]
        .contains(&key.as_str())
        {
            continue;
        }
        if key == "rightDock" {
            let mut dock = merged
                .get(key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut projects = dock
                .get("projects")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (path, candidate) in value
                .get("projects")
                .and_then(Value::as_object)
                .ok_or("侧栏项目设置无效")?
            {
                let old = projects.get(path);
                let order = |value: &Value| {
                    (
                        value["stateVersion"].as_u64().unwrap_or(0),
                        value["writerId"].as_str().unwrap_or("").to_owned(),
                    )
                };
                let mut winner = old
                    .filter(|old| order(old) >= order(candidate))
                    .unwrap_or(candidate)
                    .clone();
                for field in ["openVersion", "stateVersion", "lastUsedAt"] {
                    winner[field] = json!(old
                        .and_then(|v| v[field].as_u64())
                        .unwrap_or(0)
                        .max(candidate[field].as_u64().unwrap_or(0)));
                }
                projects.insert(path.clone(), winner);
            }
            dock.insert("projects".into(), Value::Object(projects));
            merged.insert(key.clone(), Value::Object(dock));
        } else {
            merged.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(merged))
}

fn device_backend_settings(
    input: &Map<String, Value>,
    previous: &Value,
) -> Result<Option<Value>, String> {
    let mut settings = Map::new();
    if let Some(memory) = input.get("kbrainMemory") {
        let enabled = memory["enabled"]
            .as_bool()
            .ok_or("kbrainMemory must be an object with boolean enabled")?;
        settings.insert("memory".into(), json!({ "enabled": enabled }));
    }
    if let Some(organizer) = input.get("kbrainMemoryOrganizer") {
        let mut update = json!({ "kbrainMemoryOrganizer": organizer });
        if let Some(organizer) = crate::services::gateway::kbrain_memory::take_organizer_update(&mut update)? {
            settings.insert("memoryOrganizer".into(), organizer);
        }
    }
    if let Some(search) = input.get("kbrainWebSearch") {
        if !search.is_object() || !previous["webSearch"].is_object() {
            return Err("当前设备无法更新联网搜索设置".into());
        }
        settings.insert("webSearch".into(), search.clone());
    }
    for field in ["aiApproval", "computer"] {
        if let Some(value) = input.get(field) {
            settings.insert(field.into(), value.clone());
        }
    }
    if let Some(providers) = input.get("customProviders") {
        let mut providers = expect_array(providers.clone(), "服务商更新")?;
        let mut ids = HashSet::new();
        for provider in &mut providers {
            let provider = provider.as_object_mut().ok_or("服务商配置无效")?;
            let id = extract_non_empty_string(provider, "id", "服务商配置")?;
            if !ids.insert(id.clone()) {
                return Err("服务商 ID 重复".into());
            }
            if input
                .get(PROVIDER_API_KEY_UPDATES_FIELD)
                .and_then(|v| v.get(&id))
                .is_some()
            {
                return Err("托管模型密钥由当前账户管理".into());
            }
            let api = match provider.get("type").and_then(Value::as_str) {
                Some("claude_code") => "anthropic-messages",
                Some("gemini") => "google-generative-ai",
                _ if provider.get("requestFormat").and_then(Value::as_str)
                    == Some("openai-completions") =>
                {
                    "openai-completions"
                }
                _ => "openai-responses",
            };
            provider.insert("api".into(), json!(api));
            if let Some(usage) = input
                .get(PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD)
                .and_then(|v| v.get(&id))
                .and_then(Value::as_object)
            {
                let target = provider
                    .entry("usageQuery")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or("用量配置无效")?;
                for (key, value) in usage {
                    target.insert(key.clone(), value.clone());
                }
            }
            if provider
                .get("apiKey")
                .and_then(Value::as_str)
                .is_some_and(str::is_empty)
            {
                provider.remove("apiKey");
            }
        }
        settings.insert(
            "deleteProviders".into(),
            json!(previous["providers"]
                .as_array()
                .ok_or("服务商快照无效")?
                .iter()
                .filter_map(|provider| provider["id"].as_str())
                .filter(|id| !ids.contains(*id))
                .collect::<Vec<_>>()),
        );
        settings.insert("providers".into(), json!(providers));
    } else if input.contains_key(PROVIDER_API_KEY_UPDATES_FIELD)
        || input.contains_key(PROVIDER_USAGE_QUERY_SECRET_UPDATES_FIELD)
    {
        return Err("服务商凭据更新缺少服务商配置".into());
    }
    if let Some(selected) = input.get("selectedModel") {
        if !selected.is_null()
            && (!selected["customProviderId"].is_string() || !selected["model"].is_string())
        {
            return Err("模型选择无效".into());
        }
        if !selected.is_null()
            && (selected["customProviderId"]
                .as_str()
                .is_none_or(str::is_empty)
                || selected["model"].as_str().is_none_or(str::is_empty))
        {
            return Err("模型选择必须绑定服务商与模型".into());
        }
        settings.insert(
            "defaultProvider".into(),
            json!(selected["customProviderId"].as_str().unwrap_or("")),
        );
        settings.insert(
            "defaultModel".into(),
            json!(selected["model"].as_str().unwrap_or("")),
        );
    }
    Ok((!settings.is_empty()).then_some(Value::Object(settings)))
}

// Capture the profile before yielding to a blocking worker. Looking up the
// active profile inside that worker could serve a later account to an old RPC.
struct DeviceConfigurationContext {
    connection: crate::services::kbrain_backend::KBrainBackendConnection,
    state: Arc<crate::services::kbrain_backend::KBrainBackendState>,
    settings_root: PathBuf,
}

impl DeviceConfigurationContext {
    fn capture(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        let state = app
            .try_state::<Arc<crate::services::kbrain_backend::KBrainBackendState>>()
            .ok_or("当前空间的执行后端尚未就绪")?;
        if !state.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let connection = state
            .running_connection()
            .ok_or("当前空间的执行后端尚未就绪")?;
        let settings_root = config_dir()?;
        if !state.allows_profile_commands()
            || !state.running_connection().is_some_and(|current| {
                current.token == connection.token && current.storage_id == connection.storage_id
            })
        {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        Ok(Self {
            connection,
            state: Arc::clone(state.inner()),
            settings_root,
        })
    }

    fn client(self) -> Result<ProfileBackupBackend, String> {
        let client =
            ProfileBackupBackend::new(self.connection, Some(self.state), self.settings_root)?;
        client.ensure_owner()?;
        Ok(client)
    }
}

pub(crate) async fn load_device_configuration(app: tauri::AppHandle) -> Result<Value, String> {
    let context = DeviceConfigurationContext::capture(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = context.client()?;
        let _guard = client.configuration.blocking_lock();
        client.ensure_owner()?;
        let mut conn = open_profile_db(client.settings_root.join(DB_FILENAME))?;
        client.device_snapshot_locked(&mut conn)
    })
    .await
    .map_err(|_| "设备设置读取任务失败")?
}

pub(crate) async fn prepare_device_configuration_outbound(
    app: tauri::AppHandle,
    snapshot: Value,
) -> Result<Value, String> {
    let context = DeviceConfigurationContext::capture(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = context.client()?;
        let _guard = client.configuration.blocking_lock();
        client.ensure_owner()?;
        let mut conn = open_profile_db(client.settings_root.join(DB_FILENAME))?;
        client.device_outbound_locked(&mut conn, snapshot)
    })
    .await
    .map_err(|_| "设备广播准备任务失败")?
}

pub(crate) async fn save_device_configuration(
    app: tauri::AppHandle,
    input: Value,
) -> Result<DeviceSettingsCommit, String> {
    use tauri::Manager;
    let context = DeviceConfigurationContext::capture(&app)?;
    #[cfg(desktop)]
    {
        let mut ids = input
            .get("customProviders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|provider| provider.get("id").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if let Some(id) = input
            .get("selectedModel")
            .and_then(|model| model.get("customProviderId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            if !ids.iter().any(|provider| provider == id) {
                ids.push(id.to_string());
            }
        }
        context.state.ensure_managed_provider_bindings(&ids).await?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = context.client()?;
        let _guard = client.configuration.blocking_lock();
        client.ensure_owner()?;
        let mut conn = open_profile_db(client.settings_root.join(DB_FILENAME))?;
        let system_changed = input.get("system").is_some();
        let mut saved = client.save_device_locked(&mut conn, input)?;
        if system_changed {
            let revision = crate::services::system_proxy::revision();
            if refresh_system_proxy_state(&conn).is_err() {
                saved.warning = Some("配置已保存，系统代理暂未刷新".into());
            } else if crate::services::system_proxy::revision() != revision {
                if let Some(state) = &client.state {
                    state.push_proxy_setting_locked();
                }
            }
            invalidate_default_tz_cache();
            if let Some(scheduler) = app.try_state::<Arc<AutomationScheduler>>() {
                scheduler.request_reload();
            }
        }
        Ok(saved)
    })
    .await
    .map_err(|_| "设备设置提交任务失败")?
}
