#[tauri::command]
pub async fn settings_load_all(
    kbrain_backend: tauri::State<'_, Arc<crate::services::kbrain_backend::KBrainBackendState>>,
) -> Result<SettingsLoadResponse, String> {
    let backend = Arc::clone(kbrain_backend.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if !backend.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let mut conn = open_db()?;
        let lock = backend.configuration_coordinator()?;
        let _guard = lock.blocking_lock();
        lock.ensure_consistent()?;
        if !backend.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        let client = ProfileBackupBackend::new(
            backend.running_connection().ok_or("当前配置后端尚未就绪")?,
            Some(Arc::clone(&backend)),
            config_dir()?,
        )?;
        let documents = client.documents_locked()?;
        let default_workdir = default_project_workdir()?;
        let snapshot = conn.transaction().map_err(|_| "无法读取一致配置快照")?;
        let mut remote = serde_json::to_value(load_remote_settings(&snapshot)?)
            .map_err(|e| format!("序列化 remote settings 失败：{e}"))?;
        if let serde_json::Value::Object(settings) = &mut remote {
            settings.insert(
                "token".to_string(),
                serde_json::Value::String(String::new()),
            );
        }
        let native_revision = native_configuration_revision(&snapshot)?;
        let ui = load_ui_preferences(&snapshot)?;
        let response = SettingsLoadResponse {
            ui_revision: ui.ui_revision,
            ui_preferences: ui.ui_preferences,
            configuration_revision: client.revision_locked(&native_revision, &documents)?,
            native_revision,
            backend: documents,
            providers: None,
            system: Some(load_system_with_defaults(&snapshot, &default_workdir)?),
            // Go-owned domains are returned only in the canonical public documents.
            // Old SQLite MCP payloads can contain private values and are migration-only.
            mcp: None,
            agents: None,
            ssh: load_ssh(&snapshot)?,
            remote: Some(remote),
            stt: load_stt_redacted(&snapshot)?,
            memory: load_memory(&snapshot)?,
            model_failover: load_model_failover(&snapshot)?,
            default_workdir,
        };
        snapshot.commit().map_err(|_| "无法完成一致配置读取")?;
        backend.verify_portable_backup(
            &serde_json::to_value(&response).map_err(|_| "无法校验配置快照")?,
        )?;
        if !backend.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        Ok(response)
    })
    .await
    .map_err(|e| format!("settings_load_all join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_providers(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_providers(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_providers join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_system(
    payload: Value,
    automation_scheduler: tauri::State<'_, Arc<AutomationScheduler>>,
    kbrain_backend: tauri::State<'_, Arc<crate::services::kbrain_backend::KBrainBackendState>>,
) -> Result<(), String> {
    let kbrain_backend = Arc::clone(kbrain_backend.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_system(&mut conn, payload)?;
        // 保存成功后刷新全局代理状态，让 shell env 注入与出网代理即时生效。
        let proxy_revision = crate::services::system_proxy::revision();
        refresh_system_proxy_state(&conn)?;
        // 代理真实变化时推给运行中的 K-brain（best effort，失败只记日志）。
        if crate::services::system_proxy::revision() != proxy_revision {
            kbrain_backend.push_proxy_setting();
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("settings_save_system join 失败：{e}"))??;
    // Bash cron tasks execute in the system workdir; reschedule so the new
    // workdir takes effect without an app restart.
    // 默认时区可能已变:先让缓存失效,记忆等高频调用方立即读到新时区。
    invalidate_default_tz_cache();
    automation_scheduler.request_reload();
    Ok(())
}

#[tauri::command]
pub async fn settings_save_mcp(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_mcp(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_mcp join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_remote(
    payload: Value,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let normalized = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_remote(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_remote join 失败：{e}"))??;
    let mut normalized = normalized;
    normalized.token.clear();
    if let Some(credential) = crate::services::device_credentials::load_device_credential()? {
        normalized.agent_id = credential.effective_agent_id().to_string();
        normalized.token = credential.effective_token().to_string();
    }
    gateway_controller.apply_config(normalized)
}

#[tauri::command]
pub async fn settings_save_memory(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_memory(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_memory join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_model_failover(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_model_failover(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_model_failover join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_stt(
    payload: Value,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<Value, String> {
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_stt(&mut conn, payload)?;
        load_stt_redacted(&conn).map(|value| value.unwrap_or_else(|| json!({})))
    })
    .await
    .map_err(|e| format!("settings_save_stt join failed: {e}"))??;
    if let Err(error) = gateway_controller.publish_current_settings_sync().await {
        eprintln!("publish STT settings sync failed: {error}");
    }
    Ok(saved)
}

#[tauri::command]
pub async fn settings_reveal_stt_secret(provider: String, field: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        load_stt_secret(&conn, &provider, &field)
    })
    .await
    .map_err(|e| format!("settings_reveal_stt_secret join failed: {e}"))?
}

#[tauri::command]
pub async fn settings_save_agents(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_agents(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_agents join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_save_ssh(payload: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_ssh(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_ssh join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_apply_ssh_patch(payload: Value) -> Result<SshPatchApplyResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        apply_ssh_patch_with_conn(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_apply_ssh_patch join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_reset_ssh_known_host(
    host: String,
    port: u16,
) -> Result<SshKnownHostResetResponse, String> {
    tauri::async_runtime::spawn_blocking(move || reset_ssh_known_host_everywhere(&host, port))
        .await
        .map_err(|e| format!("settings_reset_ssh_known_host join 失败：{e}"))?
}

/// Forgets a host key in the desktop terminal's known hosts and in K-brain's known_hosts
/// (SSHManager), so the next connection from either asks again.
pub(crate) fn reset_ssh_known_host_everywhere(
    host: &str,
    port: u16,
) -> Result<SshKnownHostResetResponse, String> {
    let deleted = reset_runtime_ssh_known_host(host, port)?;
    let kbrain_removed = match crate::services::kbrain_ssh_sync::forget_host_keys(host, port) {
        Ok(removed) => removed,
        Err(error) => {
            eprintln!("forget K-brain SSH host keys failed: {error}");
            0
        }
    };
    Ok(SshKnownHostResetResponse {
        deleted: deleted + kbrain_removed,
        kbrain_removed,
    })
}

/// K-brain's view of Settings > SSH after pushing the desktop's hosts: each host's
/// credential state and the host keys SSHManager saved. Never starts K-brain.
#[tauri::command]
pub async fn settings_kbrain_ssh_state() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(connection) = crate::services::kbrain_ssh_sync::running_connection() else {
            return crate::services::kbrain_ssh_sync::public_state(Ok(Default::default()), false);
        };
        crate::services::kbrain_ssh_sync::public_state(
            crate::services::kbrain_ssh_sync::sync_running(&connection),
            true,
        )
    })
    .await
    .map_err(|e| format!("settings_kbrain_ssh_state join failed: {e}"))
}
