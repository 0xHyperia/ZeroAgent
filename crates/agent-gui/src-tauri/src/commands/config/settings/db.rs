fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

static SCHEMA_INITIALIZED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static SCHEMA_INITIALIZE_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE_CONFIG_PROFILE: Mutex<crate::services::backend_profile::BackendProfile> =
    Mutex::new(crate::services::backend_profile::BackendProfile::Local);

pub(crate) fn set_active_config_profile(
    profile: crate::services::backend_profile::BackendProfile,
) -> Result<(), String> {
    *ACTIVE_CONFIG_PROFILE
        .lock()
        .map_err(|_| "Settings profile lock failed")? = profile;
    Ok(())
}

pub(crate) fn config_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("ZEROAGENT_CONFIG_DIR") {
        let root = PathBuf::from(path);
        if !root.is_absolute() {
            return Err("ZEROAGENT_CONFIG_DIR 必须是绝对路径".into());
        }
        let profile = ACTIVE_CONFIG_PROFILE
            .lock()
            .map_err(|_| "Settings profile lock failed")?;
        let dir = profile.settings_dir(&root);
        fs::create_dir_all(&dir).map_err(|e| format!("创建开发配置目录失败：{e}"))?;
        return Ok(dir);
    }
    let home =
        crate::runtime::data_home::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let data_root = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    let profile = ACTIVE_CONFIG_PROFILE
        .lock()
        .map_err(|_| "Settings profile lock failed")?;
    // The legacy root is an explicit migration source, never an account's default settings.
    let dir = profile.settings_dir(&data_root);
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    Ok(dir)
}

fn default_project_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join(DEFAULT_PROJECT_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建默认工作目录失败：{e}"))?;
    Ok(dir)
}

fn default_project_workdir() -> Result<String, String> {
    Ok(default_project_dir()?.to_string_lossy().into_owned())
}

pub(crate) fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS provider_settings (
            provider_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS system_settings (
            setting_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_settings (
            server_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_prompt_templates (
            template_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            prompt TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_settings (
            host_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            password TEXT NOT NULL,
            password_configured INTEGER NOT NULL DEFAULT 0,
            private_key TEXT NOT NULL,
            private_key_path TEXT NOT NULL,
            private_key_configured INTEGER NOT NULL DEFAULT 0,
            private_key_passphrase TEXT NOT NULL DEFAULT '',
            private_key_passphrase_configured INTEGER NOT NULL DEFAULT 0,
            proxy_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_project_host_associations (
            project_path_key TEXT PRIMARY KEY,
            host_ids_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ssh_known_hosts (
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            key_type TEXT NOT NULL,
            key_base64 TEXT NOT NULL,
            fingerprint_sha256 TEXT NOT NULL,
            trusted_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (host, port)
        );
        CREATE TABLE IF NOT EXISTS remote_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_failover_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stt_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        -- WebDAV 同步配置。独立成表是刻意的：见 mod.rs 上 BACKUP_SYNC_SETTINGS_TABLE 的注释。
        CREATE TABLE IF NOT EXISTS backup_sync_settings (
            config_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tunnel_settings (
            tunnel_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_root_grants (
            grant_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            project_path_key TEXT NOT NULL,
            alias TEXT NOT NULL,
            display_path TEXT NOT NULL,
            canonical_path TEXT NOT NULL,
            access_mode TEXT NOT NULL CHECK (access_mode IN ('read', 'write')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (project_id, alias),
            UNIQUE (project_id, canonical_path)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_root_grants_project
            ON workspace_root_grants (project_id);
        -- 'agent' 登录方式已移除，遗留配置回退为密码登录（与前端 normalize 的未知值兜底一致）
        UPDATE ssh_settings SET auth_type = 'password' WHERE auth_type = 'agent';
        ",
    )
    .map_err(|e| format!("初始化设置表失败：{e}"))?;
    ensure_native_configuration_revision(conn)?;
    ensure_ui_preferences_schema(conn)?;
    Ok(())
}

pub(crate) fn config_db_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(DB_FILENAME))
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let db_path = config_db_path()?;
    open_profile_db(db_path)
}

fn open_profile_db(db_path: PathBuf) -> Result<Connection, String> {
    let mut conn = Connection::open(&db_path).map_err(|e| format!("打开设置数据库失败：{e}"))?;
    secure_profile_db_file(&db_path)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 SQLite busy_timeout 失败：{e}"))?;
    let initialized = SCHEMA_INITIALIZED.get_or_init(|| Mutex::new(HashSet::new()));
    if !initialized
        .lock()
        .map_err(|_| "Settings schema lock failed")?
        .contains(&db_path)
    {
        let _guard = SCHEMA_INITIALIZE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !initialized
            .lock()
            .map_err(|_| "Settings schema lock failed")?
            .contains(&db_path)
        {
            initialize_schema(&conn)?;
            ensure_remote_agent_id(&mut conn)?;
            initialized
                .lock()
                .map_err(|_| "Settings schema lock failed")?
                .insert(db_path);
        }
    }
    Ok(conn)
}

pub(crate) fn secure_profile_db_file(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法保护当前配置数据库".to_string())?;
        for suffix in ["-wal", "-shm"] {
            let mut auxiliary = path.as_os_str().to_os_string();
            auxiliary.push(suffix);
            match fs::set_permissions(PathBuf::from(auxiliary), fs::Permissions::from_mode(0o600)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("无法保护当前配置数据库辅助文件".to_string()),
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod profile_database_tests {
    use super::*;

    #[test]
    fn each_profile_initializes_its_own_schema_and_preserves_other_accounts() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("account-a.db");
        let b = root.path().join("account-b.db");
        let first = open_profile_db(a.clone()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&a).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        first.execute("INSERT INTO system_settings(setting_key,payload_json,updated_at) VALUES ('workdir', ?1, 1)", ["\"account-a-only\""]).unwrap();
        drop(first);
        let second = open_profile_db(b).unwrap();
        let count: i64 = second
            .query_row("SELECT COUNT(*) FROM system_settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let first = open_profile_db(a).unwrap();
        let value: String = first
            .query_row(
                "SELECT payload_json FROM system_settings WHERE setting_key='workdir'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(value.contains("account-a-only"));
    }
}
