// Native configuration backups use the canonical backend for providers/MCP/prompts. SQLite
// remains authoritative only for the portable native preferences, failover and STT domains.
#[derive(Clone)]
struct BackupSource {
    schema_version: u32,
    fingerprint: String,
}

struct ProfileBackupBackend {
    connection: crate::services::kbrain_backend::KBrainBackendConnection,
    client: reqwest::blocking::Client,
    state: Option<Arc<crate::services::kbrain_backend::KBrainBackendState>>,
    settings_root: PathBuf,
    secret_guard: Option<crate::services::managed_model_broker::PortableSecretGuard>,
    configuration: Arc<crate::services::configuration_coordinator::ConfigurationCoordinator>,
    backend_root: Option<PathBuf>,
}

fn verify_backup_preview(
    app: &tauri::AppHandle,
    snapshot: Option<&BackupSnapshot>,
    manifest: &BackupManifest,
    source: Option<&str>,
) -> Result<(), String> {
    use tauri::Manager;
    let snapshot = snapshot
        .map(|snapshot| {
            let mut snapshot = snapshot.clone();
            snapshot.providers = backup_safe_providers(snapshot.providers.take())?;
            Ok::<_, String>(snapshot)
        })
        .transpose()?;
    app.try_state::<Arc<crate::services::kbrain_backend::KBrainBackendState>>()
        .ok_or("当前空间尚未初始化")?
        .verify_portable_backup(&json!({"snapshot":snapshot,"manifest":manifest,"source":source}))
}

#[cfg(test)]
fn trace_configuration_transport(
    method: &str,
    path: &str,
    started: std::time::Instant,
    stage: &str,
    error: Option<&reqwest::Error>,
) {
    if std::env::var_os("ZEROAGENT_TEST_BACKEND_TRACE").is_none() {
        return;
    }
    let resource = if path.starts_with("/v1/settings") {
        "settings"
    } else if path.starts_with("/v1/skills") {
        "skills"
    } else if path.starts_with("/v1/mcp") {
        "mcp"
    } else if path.starts_with("/v1/prompts") {
        "prompts"
    } else {
        "other"
    };
    eprintln!("backend-transport-trace method={} resource={} stage={} elapsed_ms={} timeout={} connect={} body={} decode={}",
        method,resource,stage,started.elapsed().as_millis(),error.is_some_and(reqwest::Error::is_timeout),
        error.is_some_and(reqwest::Error::is_connect),error.is_some_and(reqwest::Error::is_body),error.is_some_and(reqwest::Error::is_decode));
}

impl ProfileBackupBackend {
    fn from_app(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        let state = app
            .try_state::<Arc<crate::services::kbrain_backend::KBrainBackendState>>()
            .ok_or("当前空间的执行后端尚未就绪")?;
        let connection = state
            .running_connection()
            .ok_or("当前空间的执行后端尚未就绪，请稍后重试")?;
        Self::new(connection, Some(Arc::clone(state.inner())), config_dir()?)
    }

    fn new(
        connection: crate::services::kbrain_backend::KBrainBackendConnection,
        state: Option<Arc<crate::services::kbrain_backend::KBrainBackendState>>,
        settings_root: PathBuf,
    ) -> Result<Self, String> {
        let url = url::Url::parse(&connection.base_url).map_err(|_| "无效的本机配置后端")?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("配置备份只接受当前空间的本机执行后端".into());
        }
        let secret_guard = state
            .as_ref()
            .map(|state| state.portable_backup_guard())
            .transpose()?
            .flatten();
        Ok(Self {
            backend_root: state
                .as_ref()
                .map(|state| state.configuration_root())
                .transpose()?,
            configuration:
                crate::services::configuration_coordinator::ConfigurationCoordinator::for_profile(
                    &connection.storage_id,
                )?,
            connection,
            client: reqwest::blocking::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "无法初始化配置备份传输")?,
            state,
            settings_root,
            secret_guard,
        })
    }

    fn ensure_owner(&self) -> Result<(), String> {
        if let Some(state) = &self.state {
            if !state.allows_profile_commands()
                || !state.running_connection().is_some_and(|connection| {
                    connection.storage_id == self.connection.storage_id
                        && connection.token == self.connection.token
                })
            {
                return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
            }
        }
        Ok(())
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        input: Option<&Value>,
    ) -> Result<Value, String> {
        use std::io::Read;
        #[cfg(test)]
        let trace_started = std::time::Instant::now();
        #[cfg(test)]
        let trace_method = method.as_str().to_owned();
        let mutation = matches!(
            method,
            reqwest::Method::PUT | reqwest::Method::PATCH | reqwest::Method::DELETE
        );
        self.configuration.ensure_consistent()?;
        self.ensure_owner()?;
        if mutation {
            self.configuration.changed();
            if path == "/v1/mcp" || path.starts_with("/v1/mcp/") {
                self.configuration.mcp_changed();
            }
        }
        let mut request = self
            .client
            .request(
                method,
                format!("{}{}", self.connection.base_url.trim_end_matches('/'), path),
            )
            .bearer_auth(&self.connection.token);
        if let Some(input) = input {
            request = request.json(input);
        }
        #[cfg(test)]
        trace_configuration_transport(&trace_method, path, trace_started, "send", None);
        let response = request.send().map_err(|_error| {
            #[cfg(test)]
            trace_configuration_transport(
                &trace_method,
                path,
                trace_started,
                "send-error",
                Some(&_error),
            );
            if mutation {
                self.configuration.uncertain_commit();
            }
            "本机配置后端请求失败"
        })?;
        #[cfg(test)]
        trace_configuration_transport(&trace_method, path, trace_started, "headers", None);
        if !response.status().is_success() {
            if mutation && response.status().is_server_error() {
                self.configuration.uncertain_commit();
            }
            // Backend diagnostics can quote an invalid credential. Never forward them into UI/logs.
            return Err(format!(
                "本机配置后端拒绝请求（{}）",
                response.status().as_u16()
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(BACKUP_MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| {
                if mutation {
                    self.configuration.uncertain_commit();
                }
                "读取本机配置失败"
            })?;
        if bytes.len() as u64 > BACKUP_MAX_FILE_BYTES {
            if mutation {
                self.configuration.uncertain_commit();
            }
            return Err("配置超过备份大小上限".into());
        }
        #[cfg(test)]
        trace_configuration_transport(&trace_method, path, trace_started, "body", None);
        self.ensure_owner()?;
        serde_json::from_slice(&bytes).map_err(|_| {
            if mutation {
                self.configuration.uncertain_commit();
            }
            "本机配置后端返回了无效数据".into()
        })
    }

    fn verify_secrets(&self, snapshot: &BackupSnapshot) -> Result<(), String> {
        let value = serde_json::to_value(snapshot).map_err(|_| "无法校验备份")?;
        if let Some(guard) = &self.secret_guard {
            guard.verify(&value)?;
        }
        if let Some(state) = &self.state {
            state.verify_portable_backup(&value)?;
        }
        Ok(())
    }

    fn providers(&self, document: &Value, include_secrets: bool) -> Result<Vec<Value>, String> {
        let providers = document
            .get("providers")
            .and_then(Value::as_array)
            .ok_or("服务商配置格式无效")?;
        let mut result = Vec::new();
        for provider in providers
            .iter()
            .filter(|provider| !is_managed_provider(provider))
        {
            let mut provider = expect_object(provider.clone(), "服务商配置")?;
            let id = extract_non_empty_string(&provider, "id", "服务商配置")?;
            let api = provider
                .get("api")
                .and_then(Value::as_str)
                .unwrap_or("openai-responses")
                .to_string();
            if !provider.contains_key("type") {
                provider.insert(
                    "type".into(),
                    json!(match api.as_str() {
                        "anthropic-messages" => "claude_code",
                        "google-generative-ai" => "gemini",
                        _ => "codex",
                    }),
                );
            }
            if api == "openai-completions" {
                provider.insert("requestFormat".into(), json!("openai-completions"));
            }
            if include_secrets {
                let secrets = self.request(
                    reqwest::Method::POST,
                    &format!(
                        "/v1/settings/providers/{}/secrets",
                        urlencoding::encode(&id)
                    ),
                    Some(&json!({"confirm": true})),
                )?;
                provider.insert(
                    "apiKey".into(),
                    json!(secrets.get("apiKey").and_then(Value::as_str).unwrap_or("")),
                );
                if let Some(usage) = secrets.get("usageQuery").and_then(Value::as_object) {
                    let destination = provider
                        .entry("usageQuery")
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or("服务商用量配置格式无效")?;
                    for key in ["apiKey", "accessToken", "secretAccessKey"] {
                        destination.insert(
                            key.into(),
                            json!(usage.get(key).and_then(Value::as_str).unwrap_or("")),
                        );
                    }
                }
            }
            result.push(Value::Object(provider));
        }
        Ok(result)
    }

    fn collect(&self, conn: &Connection) -> Result<BackupSnapshot, String> {
        let _guard = self.configuration.blocking_lock();
        self.collect_locked(conn)
    }

    fn collect_locked(&self, conn: &Connection) -> Result<BackupSnapshot, String> {
        let prompts = self.request(reqwest::Method::GET, "/v1/prompts", None)?;
        let mcp = self.request(reqwest::Method::GET, "/v1/mcp", None)?;
        let mut mcp_private = self.private_mcp_locked(&mcp)?;
        if let Some(servers) = mcp_private.get_mut("servers").and_then(Value::as_array_mut) {
            for server in servers {
                if let Some(auth) = server.get_mut("auth").and_then(Value::as_object_mut) {
                    auth.remove("credentialRef");
                }
            }
        }
        let mcp_settings = mcp_private.as_object().ok_or("MCP 配置格式无效")?;
        let templates = prompts
            .get("globalTemplates")
            .and_then(Value::as_array)
            .ok_or("提示词配置格式无效")?;
        let native = conn
            .unchecked_transaction()
            .map_err(|_| "无法读取一致备份快照")?;
        let snapshot = BackupSnapshot {
            selected_model: None,
            providers: None,
            mcp: Some(Value::Object(mcp_settings.clone())),
            agents: Some(json!(templates)),
            system: portable_system_subset(load_system(&native)?),
            model_failover: load_model_failover(&native)?,
            stt: load_stt_raw(&native)?,
        };
        native.commit().map_err(|_| "无法完成一致备份快照")?;
        self.verify_secrets(&snapshot)?;
        validate_backup_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    #[cfg(test)]
    fn apply(
        &self,
        conn: &mut Connection,
        snapshot: &BackupSnapshot,
        remap: bool,
    ) -> Result<(), String> {
        let _guard = self.configuration.blocking_lock();
        self.apply_locked(conn, snapshot, remap)
    }

    fn apply_locked(
        &self,
        conn: &mut Connection,
        snapshot: &BackupSnapshot,
        _remap: bool,
    ) -> Result<(), String> {
        validate_portable_backup_domains(snapshot)?;
        self.verify_secrets(snapshot)?;
        validate_backup_snapshot(snapshot)?;
        // Model providers and defaults belong to the active USA-Zero account.
        // Backup restore never mutates the executable provider registry.
        let mut native = snapshot.clone();
        native.agents = None;
        native.mcp = None;
        {
            let _staging = crate::services::webdav_auto_sync::staging();
            let mut validation_db = Connection::open_in_memory().map_err(|e| e.to_string())?;
            initialize_schema(&validation_db)?;
            apply_backup_snapshot_to_db(&mut validation_db, &native)?;
        }
        if let Some(templates) = &snapshot.agents {
            let current = self.request(reqwest::Method::GET, "/v1/prompts", None)?;
            let revision = current
                .get("revision")
                .and_then(Value::as_u64)
                .ok_or("提示词版本无效")?;
            self.request(
                reqwest::Method::PUT,
                "/v1/prompts/templates",
                Some(&json!({"templates":templates,"baseRevision":revision})),
            )?;
        }
        if let Some(mcp) = &snapshot.mcp {
            self.request(reqwest::Method::PUT, "/v1/mcp", Some(mcp))?;
        }
        apply_backup_snapshot_to_db(conn, &native)?;
        Ok(())
    }
}

fn portable_provider_update(provider: &Value) -> Result<Value, String> {
    let mut provider = expect_object(provider.clone(), "备份内容 provider")?;
    extract_non_empty_string(&provider, "id", "备份内容 provider")?;
    if !provider.contains_key("api") {
        let api = match provider
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("codex")
        {
            "claude_code" => "anthropic-messages",
            "gemini" => "google-generative-ai",
            _ if provider.get("requestFormat").and_then(Value::as_str)
                == Some("openai-completions") =>
            {
                "openai-completions"
            }
            _ => "openai-responses",
        };
        provider.insert("api".into(), json!(api));
    }
    if provider
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|key| key.is_empty())
    {
        provider.insert("clearApiKey".into(), json!(true));
    }
    if let Some(usage) = provider
        .get_mut("usageQuery")
        .and_then(Value::as_object_mut)
    {
        // Empty values require clearing the backend's configured flags as well. A masked
        // metadata record deliberately preserves existing secrets when those flags stay true.
        for key in ["apiKey", "accessToken", "secretAccessKey"] {
            if let Some(value) = usage.get(key).and_then(Value::as_str) {
                let configured = !value.trim().is_empty();
                usage.insert(format!("{key}Configured"), json!(configured));
            }
        }
    }
    Ok(Value::Object(provider))
}

fn write_private_backup(path: &Path, document: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("备份文件缺少父目录")?;
    let mut temporary = tempfile::Builder::new()
        .prefix("zeroagent-backup-")
        .tempfile_in(parent)
        .map_err(|_| "无法创建私有备份文件")?;
    temporary
        .write_all(document)
        .map_err(|_| "写入备份文件失败")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "保存备份文件失败")?;
    temporary.persist(path).map_err(|_| "提交备份文件失败")?;
    Ok(())
}

fn write_profile_rollback(
    settings_root: &Path,
    snapshot: &BackupSnapshot,
) -> Result<String, String> {
    let manifest = build_backup_manifest(snapshot);
    let document = serialize_backup_document(snapshot, &manifest)?;
    let directory = settings_root.join(BACKUP_DIRNAME);
    fs::create_dir_all(&directory).map_err(|_| "无法创建当前空间的回滚目录")?;
    let path = directory.join(format!("config-{}-{}.json", now_ms(), Uuid::new_v4()));
    write_private_backup(&path, document.as_bytes())?;
    prune_backups(path.parent().ok_or("备份目录无效")?)?;
    Ok(path.to_string_lossy().into_owned())
}

fn apply_profile_backup(
    conn: &mut Connection,
    backend: &ProfileBackupBackend,
    snapshot: BackupSnapshot,
    source: BackupSource,
) -> Result<BackupApplyOutcome, String> {
    let _guard = backend.configuration.blocking_lock();
    apply_profile_backup_locked(conn, backend, snapshot, source)
}

// Caller holds the profile gate across collection, application and compensation.
fn apply_profile_backup_locked(
    conn: &mut Connection,
    backend: &ProfileBackupBackend,
    snapshot: BackupSnapshot,
    source: BackupSource,
) -> Result<BackupApplyOutcome, String> {
    if source.schema_version != BACKUP_SCHEMA_VERSION {
        return Err("本版本只恢复当前格式备份，不导入旧版配置".into());
    }
    if source.fingerprint.len() != 64
        || !source
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("无效的备份来源指纹".into());
    }
    validate_portable_backup_domains(&snapshot)?;
    validate_backup_snapshot(&snapshot)?;
    backend.verify_secrets(&snapshot)?;
    let before = backend.collect_locked(conn)?;
    // This is recovery from a failed current-format restore, not an old-version rollback.
    let backup_path = write_profile_rollback(&backend.settings_root, &before)?;
    let applied = snapshot_domain_counts(&snapshot);
    if backend.apply_locked(conn, &snapshot, true).is_err() {
        if backend.configuration.ensure_consistent().is_err() {
            return Err(format!(
                "配置更改可能已部分保存，已保留恢复副本：{backup_path}。请重启客户端并核对当前配置"
            ));
        }
        if backend.apply_locked(conn, &before, false).is_err() {
            return Err(format!(
                "配置还原未完成，自动恢复也未完成。请从此备份恢复：{backup_path}"
            ));
        }
        return Err(format!(
            "配置还原失败，已恢复导入前配置。恢复副本：{backup_path}"
        ));
    }
    crate::services::webdav_auto_sync::mark_dirty();
    Ok(BackupApplyOutcome {
        applied,
        backup_path: Some(backup_path),
        warning: None,
    })
}
