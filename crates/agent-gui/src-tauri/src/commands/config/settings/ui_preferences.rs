// Presentation preferences have their own read version. They remain writable when
// a backend configuration batch fails or its result needs recovery.
const UI_PREFERENCES_TABLE: &str = "native_ui_preferences";
const UI_PREFERENCES_CHANGED: &str = "ZEROAGENT_UI_PREFERENCES_CHANGED";

fn ensure_ui_preferences_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_ui_preferences (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        scope_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>=0),
        payload_json TEXT
    );",
    )
    .map_err(|_| "无法初始化界面偏好")?;
    conn.execute(
        "INSERT OR IGNORE INTO native_ui_preferences(singleton,scope_id,revision) VALUES(1,?1,0)",
        [Uuid::new_v4().to_string()],
    )
    .map_err(|_| "无法初始化界面偏好版本")?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesSnapshot {
    ui_revision: String,
    ui_preferences: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPreferencesUpdate {
    expected_revision: String,
    changes: Value,
}

fn load_ui_preferences(conn: &Connection) -> Result<UiPreferencesSnapshot, String> {
    let (scope, revision, payload): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT scope_id,revision,payload_json FROM native_ui_preferences WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "无法读取界面偏好")?;
    Ok(UiPreferencesSnapshot {
        ui_revision: format!("za-ui-v1-{scope}-{revision}"),
        ui_preferences: payload
            .map(|raw| serde_json::from_str(&raw).map_err(|_| "界面偏好格式无效".to_string()))
            .transpose()?,
    })
}

fn validate_ui_preferences_update(update: &UiPreferencesUpdate) -> Result<(), String> {
    if update.expected_revision.len() > 128 || !update.expected_revision.starts_with("za-ui-v1-") {
        return Err("ZEROAGENT_UI_PREFERENCES_VERSION_REQUIRED".into());
    }
    let changes = update.changes.as_object().ok_or("界面偏好必须是对象")?;
    if serde_json::to_vec(&update.changes)
        .map_err(|_| "界面偏好格式无效")?
        .len()
        > 1024 * 1024
    {
        return Err("界面偏好内容过大".into());
    }
    for (key, value) in changes {
        let valid = match key.as_str() {
            "theme" => value
                .as_str()
                .is_some_and(|v| ["light", "dark", "system"].contains(&v)),
            "locale" => value.is_string(),
            "closeWindowBehavior" => value
                .as_str()
                .is_some_and(|v| ["minimize", "exit"].contains(&v)),
            "skills"
            | "chatRuntimeControls"
            | "customSettings"
            | "updates"
            | "retryErrorSettings" => value.is_object(),
            _ => false,
        };
        if !valid {
            return Err("界面偏好包含不支持的字段或值".into());
        }
    }
    Ok(())
}

// The caller owns the SQL transaction. This also supports an atomic device update
// that stages UI preferences alongside the other Native domains.
fn apply_ui_preferences(
    conn: &Connection,
    update: UiPreferencesUpdate,
) -> Result<UiPreferencesSnapshot, String> {
    validate_ui_preferences_update(&update)?;
    let before = load_ui_preferences(conn)?;
    if before.ui_revision != update.expected_revision {
        return Err(UI_PREFERENCES_CHANGED.into());
    }
    let mut preferences = before.ui_preferences.unwrap_or_else(|| json!({}));
    let target = preferences.as_object_mut().ok_or("界面偏好格式无效")?;
    for (key, value) in update.changes.as_object().ok_or("界面偏好必须是对象")? {
        target.insert(key.clone(), value.clone());
    }
    if serde_json::to_vec(&preferences)
        .map_err(|_| "界面偏好格式无效")?
        .len()
        > 1024 * 1024
    {
        return Err("界面偏好内容过大".into());
    }
    conn.execute(
        "UPDATE native_ui_preferences SET payload_json=?1,revision=revision+1 WHERE singleton=1",
        [serde_json::to_string(&preferences).map_err(|_| "界面偏好格式无效")?],
    )
    .map_err(|_| "无法保存界面偏好")?;
    load_ui_preferences(conn)
}

#[tauri::command]
pub async fn settings_save_ui_preferences(
    update: UiPreferencesUpdate,
    kbrain_backend: tauri::State<'_, Arc<crate::services::kbrain_backend::KBrainBackendState>>,
) -> Result<UiPreferencesSnapshot, String> {
    let backend = Arc::clone(kbrain_backend.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if !backend.allows_profile_commands() {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        backend.verify_portable_backup(&update.changes)?;
        let root = config_dir()?;
        let mut conn = open_profile_db(root.join(DB_FILENAME))?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "界面偏好正在保存，请稍后重试")?;
        let result = apply_ui_preferences(&transaction, update)?;
        if !backend.allows_profile_commands() || config_dir()? != root {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        transaction.commit().map_err(|_| "无法提交界面偏好")?;
        Ok(result)
    })
    .await
    .map_err(|_| "界面偏好保存任务失败")?
}

#[cfg(test)]
include!("ui_preferences_tests.rs");
