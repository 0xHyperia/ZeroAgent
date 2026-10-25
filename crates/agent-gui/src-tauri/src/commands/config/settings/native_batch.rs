// Native preferences have a database-owned revision. Triggers also observe private
// migration/backup writers; a renderer cannot turn an old snapshot into a fresh one.
const NATIVE_CONFIGURATION_CHANGED: &str = "ZEROAGENT_NATIVE_CONFIGURATION_CHANGED";
const NATIVE_CONFIGURATION_TABLES: &[&str] = &[
    SYSTEM_SETTINGS_TABLE,
    SSH_SETTINGS_TABLE,
    SSH_PROJECT_HOST_ASSOCIATIONS_TABLE,
    REMOTE_SETTINGS_TABLE,
    MEMORY_SETTINGS_TABLE,
    MODEL_FAILOVER_SETTINGS_TABLE,
    STT_SETTINGS_TABLE,
];

fn ensure_native_configuration_revision(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_configuration_revision (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        scope_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 0)
    );",
    )
    .map_err(|_| "无法初始化配置版本")?;
    conn.execute("INSERT OR IGNORE INTO native_configuration_revision(singleton,scope_id,revision) VALUES(1,?1,0)", [Uuid::new_v4().to_string()])
        .map_err(|_| "无法初始化配置版本")?;
    for table in NATIVE_CONFIGURATION_TABLES {
        for action in ["INSERT", "UPDATE", "DELETE"] {
            // Names are a fixed native allowlist, never renderer input.
            conn.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS native_revision_{table}_{action}
                AFTER {action} ON {table} BEGIN
                UPDATE native_configuration_revision SET revision=revision+1 WHERE singleton=1;
                END;"
            ))
            .map_err(|_| "无法初始化配置版本跟踪")?;
        }
    }
    Ok(())
}

pub(crate) fn native_configuration_revision(conn: &Connection) -> Result<String, String> {
    let (scope, revision): (String, i64) = conn
        .query_row(
            "SELECT scope_id,revision FROM native_configuration_revision WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "无法读取配置版本")?;
    Ok(format!("za-native-v1-{scope}-{revision}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeConfigurationUpdate {
    expected_revision: String,
    changes: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfigurationResult {
    pub native_revision: String,
    pub ui_revision: Option<String>,
    pub ui_preferences: Option<Value>,
    pub ssh: Option<Value>,
    pub stt: Option<Value>,
    pub warning: Option<String>,
}

// These rows never leave Native and are intentionally neither Debug nor Serialize.
struct NativeConfigurationRows {
    table: &'static str,
    columns: Vec<String>,
    rows: Vec<Vec<rusqlite::types::Value>>,
}

fn capture_native_table(
    conn: &Connection,
    table: &'static str,
) -> Result<NativeConfigurationRows, String> {
    let mut statement = conn
        .prepare(&format!("SELECT * FROM {table}"))
        .map_err(|_| "无法读取配置工作副本")?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let count = columns.len();
    let rows = statement
        .query_map([], |row| {
            (0..count)
                .map(|index| row.get(index))
                .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
        })
        .map_err(|_| "无法读取配置工作副本")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "无法读取配置工作副本")?;
    Ok(NativeConfigurationRows {
        table,
        columns,
        rows,
    })
}

fn replace_native_table(conn: &Connection, data: &NativeConfigurationRows) -> Result<(), String> {
    conn.execute(&format!("DELETE FROM {}", data.table), [])
        .map_err(|_| "无法保存配置工作副本")?;
    let columns = data
        .columns
        .iter()
        .map(|column| format!("\"{}\"", column.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(",");
    let placeholders = (0..data.columns.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let mut insert = conn
        .prepare(&format!(
            "INSERT INTO {} ({columns}) VALUES ({placeholders})",
            data.table
        ))
        .map_err(|_| "无法保存配置工作副本")?;
    for row in &data.rows {
        insert
            .execute(rusqlite::params_from_iter(row.iter()))
            .map_err(|_| "无法保存配置工作副本")?;
    }
    Ok(())
}

fn native_change_tables(changes: &Map<String, Value>) -> Result<Vec<&'static str>, String> {
    let mut tables = Vec::new();
    for key in changes.keys() {
        let names: &[&'static str] = match key.as_str() {
            "system" => &[SYSTEM_SETTINGS_TABLE],
            "sshPatch" | "sshSecretUpdates" => {
                &[SSH_SETTINGS_TABLE, SSH_PROJECT_HOST_ASSOCIATIONS_TABLE]
            }
            "remote" => &[REMOTE_SETTINGS_TABLE],
            "memory" => &[MEMORY_SETTINGS_TABLE],
            "modelFailover" => &[MODEL_FAILOVER_SETTINGS_TABLE],
            "stt" => &[STT_SETTINGS_TABLE],
            "uiPreferences" => &[UI_PREFERENCES_TABLE],
            _ => return Err("配置更新包含不支持的字段".into()),
        };
        for table in names {
            if !tables.contains(table) {
                tables.push(*table);
            }
        }
    }
    if changes.contains_key("sshSecretUpdates") && !changes.contains_key("sshPatch") {
        return Err("SSH 密码更新必须绑定同次 SSH 配置变更".into());
    }
    Ok(tables)
}

fn apply_native_configuration(
    conn: &mut Connection,
    update: NativeConfigurationUpdate,
    default_workdir: &str,
) -> Result<NativeConfigurationResult, String> {
    let prepared = prepare_native_configuration(conn, update, default_workdir)?;
    commit_native_configuration(conn, prepared)
}

struct PreparedNativeConfiguration {
    expected_revision: String,
    expected_ui_revision: Option<String>,
    staged: Vec<NativeConfigurationRows>,
    changes_ssh: bool,
    changes_stt: bool,
}

fn prepare_native_configuration(
    conn: &mut Connection,
    update: NativeConfigurationUpdate,
    default_workdir: &str,
) -> Result<PreparedNativeConfiguration, String> {
    if update.expected_revision.len() > 128
        || !update.expected_revision.starts_with("za-native-v1-")
    {
        return Err("ZEROAGENT_NATIVE_CONFIGURATION_VERSION_REQUIRED".into());
    }
    let changes = expect_object(update.changes, "配置更新")?;
    let touched = native_change_tables(&changes)?;
    let before = conn.transaction().map_err(|_| "无法读取一致配置快照")?;
    if native_configuration_revision(&before)? != update.expected_revision {
        return Err(NATIVE_CONFIGURATION_CHANGED.into());
    }
    let mut original = NATIVE_CONFIGURATION_TABLES
        .iter()
        .map(|table| capture_native_table(&before, table))
        .collect::<Result<Vec<_>, _>>()?;
    let ui_update = changes
        .get("uiPreferences")
        .map(|value| {
            serde_json::from_value::<UiPreferencesUpdate>(value.clone())
                .map_err(|_| "界面偏好更新格式无效".to_string())
        })
        .transpose()?;
    if ui_update.is_some() {
        original.push(capture_native_table(&before, UI_PREFERENCES_TABLE)?);
    }
    before.commit().map_err(|_| "无法读取一致配置快照")?;
    let mut working = Connection::open_in_memory().map_err(|_| "无法创建配置工作副本")?;
    initialize_schema(&working)?;
    for table in &original {
        replace_native_table(&working, table)?;
    }
    let _staging = crate::services::webdav_auto_sync::staging();
    let expected_ui_revision = ui_update
        .as_ref()
        .map(|update| update.expected_revision.clone());
    if let Some(update) = ui_update {
        apply_ui_preferences(&working, update)?;
    }

    if let Some(value) = changes.get("system") {
        save_system_with_default_workdir(&mut working, value.clone(), default_workdir)?;
    }
    if let Some(value) = changes.get("remote") {
        save_remote(&mut working, value.clone())?;
    }
    if let Some(value) = changes.get("memory") {
        save_memory(&mut working, value.clone())?;
    }
    if let Some(value) = changes.get("modelFailover") {
        save_model_failover(&mut working, value.clone())?;
    }
    if let Some(value) = changes.get("stt") {
        let mut value = value.clone();
        if let Some(object) = value.as_object_mut() {
            object.remove("nativeConfigurationRevision");
            object.remove("configurationRevision");
        }
        save_stt(&mut working, value)?;
    }
    if let Some(patch) = changes.get("sshPatch") {
        let mut payload = json!({"sshPatch":patch});
        if let Some(secrets) = changes.get("sshSecretUpdates") {
            payload["sshSecretUpdates"] = secrets.clone();
        }
        let applied = apply_ssh_patch_with_conn(&mut working, payload)?;
        if applied.conflict.is_some() {
            return Err(NATIVE_CONFIGURATION_CHANGED.into());
        }
    }
    let staged = touched
        .iter()
        .map(|table| capture_native_table(&working, table))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PreparedNativeConfiguration {
        expected_revision: update.expected_revision,
        expected_ui_revision,
        staged,
        changes_ssh: changes.contains_key("sshPatch"),
        changes_stt: changes.contains_key("stt"),
    })
}

fn commit_native_configuration(
    conn: &mut Connection,
    prepared: PreparedNativeConfiguration,
) -> Result<NativeConfigurationResult, String> {
    // Validation did not hold the real database's write lock. Recheck after taking it,
    // so even a private writer in another connection/process cannot slip into this gap.
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "当前配置正在写入，请稍后重试")?;
    if native_configuration_revision(&transaction)? != prepared.expected_revision {
        return Err(NATIVE_CONFIGURATION_CHANGED.into());
    }
    if let Some(expected) = &prepared.expected_ui_revision {
        if &load_ui_preferences(&transaction)?.ui_revision != expected {
            return Err(UI_PREFERENCES_CHANGED.into());
        }
    }
    let project_ids = |value: Option<Value>| -> HashSet<String> {
        value
            .and_then(|value| {
                value
                    .get("workspaceProjects")
                    .and_then(Value::as_array)
                    .cloned()
            })
            .unwrap_or_default()
            .iter()
            .filter_map(|project| project.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect()
    };
    let before_projects = if prepared
        .staged
        .iter()
        .any(|table| table.table == SYSTEM_SETTINGS_TABLE)
    {
        Some(project_ids(load_system(&transaction)?))
    } else {
        None
    };
    for table in &prepared.staged {
        replace_native_table(&transaction, table)?;
    }
    if let Some(before) = before_projects {
        let after = project_ids(load_system(&transaction)?);
        for id in before.difference(&after) {
            transaction
                .execute(
                    "DELETE FROM workspace_root_grants WHERE project_id=?1",
                    [id],
                )
                .map_err(|_| "无法撤销已移除项目的目录授权")?;
        }
    }
    let ui = prepared
        .expected_ui_revision
        .as_ref()
        .map(|_| load_ui_preferences(&transaction))
        .transpose()?;
    let result = NativeConfigurationResult {
        native_revision: native_configuration_revision(&transaction)?,
        ui_revision: ui.as_ref().map(|snapshot| snapshot.ui_revision.clone()),
        ui_preferences: ui.and_then(|snapshot| snapshot.ui_preferences),
        ssh: if prepared.changes_ssh {
            Some(redact_ssh_settings(load_ssh_or_empty(&transaction)?)?)
        } else {
            None
        },
        stt: if prepared.changes_stt {
            load_stt_redacted(&transaction)?
        } else {
            None
        },
        warning: None,
    };
    transaction.commit().map_err(|_| "无法提交完整配置更新")?;
    crate::services::webdav_auto_sync::mark_dirty();
    Ok(result)
}

#[tauri::command]
pub async fn settings_save_native_batch(
    update: NativeConfigurationUpdate,
    automation_scheduler: tauri::State<'_, Arc<AutomationScheduler>>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    kbrain_backend: tauri::State<'_, Arc<crate::services::kbrain_backend::KBrainBackendState>>,
) -> Result<NativeConfigurationResult, String> {
    let backend = Arc::clone(kbrain_backend.inner());
    let changes_system = update.changes.get("system").is_some();
    let changes_remote = update.changes.get("remote").is_some();
    let changes_stt = update.changes.get("stt").is_some();
    let (mut result, remote, configuration_guard) =
        tauri::async_runtime::spawn_blocking(move || {
            if !backend.allows_profile_commands() {
                return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
            }
            backend.verify_portable_backup(&update.changes)?;
            let mut conn = open_db()?;
            let lock = backend.configuration_coordinator()?;
            let _guard = lock.blocking_lock();
            lock.ensure_consistent()?;
            if !backend.allows_profile_commands() {
                return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
            }
            let default_workdir = default_project_workdir()?;
            let mut result = apply_native_configuration(&mut conn, update, &default_workdir)?;
            if changes_system {
                let proxy_revision = crate::services::system_proxy::revision();
                if refresh_system_proxy_state(&conn).is_err() {
                    result.warning = Some("配置已保存，系统代理暂未刷新，请重试连接".into());
                } else if crate::services::system_proxy::revision() != proxy_revision {
                    backend.push_proxy_setting_locked();
                }
            }
            let remote = if changes_remote {
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
            Ok::<_, String>((result, remote, _guard))
        })
        .await
        .map_err(|_| "配置保存任务失败")??;
    if changes_system {
        invalidate_default_tz_cache();
        automation_scheduler.request_reload();
    }
    if let Some(mut remote) = remote {
        remote.token.clear();
        match crate::services::device_credentials::load_device_credential() {
            Ok(Some(credential)) => {
                remote.agent_id = credential.effective_agent_id().to_string();
                remote.token = credential.effective_token().to_string();
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
    if changes_stt {
        let _ = gateway_controller.publish_current_settings_sync().await;
    }
    Ok(result)
}

#[cfg(test)]
include!("native_batch_tests.rs");
