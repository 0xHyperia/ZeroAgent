// WebDAV 同步编排：设置存取 + 上传/下载命令。
//
// 分层：本文件只做编排与校验，所有 HTTP 细节在 `services/webdav.rs`。
// 快照的采集/校验/应用复用 `backup_snapshot.rs`，与本地导入导出同一套代码路径。

/// 远端布局的版本目录。协议或 schema 不兼容演进时换目录，
/// 让新旧版本客户端各读各的，而不是互相写坏同一份文件。
const WEBDAV_LAYOUT_DIR: &str = "v3";
/// manifest 体积上限：它只有几百字节，1 MiB 已是极宽松的上界。
const WEBDAV_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
/// config 体积上限，与本地导入的上限保持一致。
const WEBDAV_CONFIG_MAX_BYTES: usize = 16 * 1024 * 1024;
const WEBDAV_MANIFEST_FILENAME: &str = "manifest.json";
const WEBDAV_CONFIG_FILENAME: &str = "config.json";
const WEBDAV_DEFAULT_PROFILE: &str = "default";
const WEBDAV_DEFAULT_REMOTE_DIR: &str = "zeroagent";

/// 同步配置。
///
/// 存于独立表 `backup_sync_settings`，**不进配置快照** —— 它是设备级的，
/// 若随快照流转会让 A 机器的凭据覆盖 B 机器，形成循环。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// 远端根目录，相对于 url。
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    /// 同一账号下的多套配置隔离（如 work / personal）。
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    /// 自动同步开关（**仅自动上传，不会自动下载**）。
    #[serde(default)]
    pub auto_sync: bool,
    /// 最近一次同步成功的时间（毫秒）。
    #[serde(default)]
    pub last_sync_at: Option<i64>,
    /// Stable content digest, excluding volatile manifest fields. Kept only in this profile.
    #[serde(default)]
    pub last_uploaded_snapshot_hash: Option<String>,
    /// 最近一次**自动**同步的失败原因。
    ///
    /// 只记录自动路径：手动同步的成败由命令返回值当场反馈，用户就在屏幕前，
    /// 不需要留痕。自动同步发生在后台，用户多半不在设置页，错误只存在于前端
    /// state 的话页面一卸载就丢了，用户永远不知道自己的配置早就没在同步。
    ///
    /// 等价于 cc-switch 的 `last_error` + `last_error_source == "auto"`：
    /// 我们只在自动入口写这个字段，来源信息因此隐含在「字段有值」里。
    #[serde(default)]
    pub last_error: Option<String>,
}

fn default_backup_remote_dir() -> String {
    WEBDAV_DEFAULT_REMOTE_DIR.to_string()
}

fn default_backup_profile() -> String {
    WEBDAV_DEFAULT_PROFILE.to_string()
}

impl Default for BackupSyncConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_dir: default_backup_remote_dir(),
            profile: default_backup_profile(),
            auto_sync: false,
            last_sync_at: None,
            last_uploaded_snapshot_hash: None,
            last_error: None,
        }
    }
}

/// 保存请求。password 与 passwordTouched 分离是为了让 UI 能展示掩码占位符
/// 而不必把真密码回传前端 —— 用户没动密码框时，后端沿用库里的旧值。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigRequest {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub password_touched: bool,
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    #[serde(default)]
    pub auto_sync: bool,
}

/// 回传前端的配置视图：**不含密码**，只告知是否已设置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigView {
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub remote_dir: String,
    pub profile: String,
    pub auto_sync: bool,
    pub last_sync_at: Option<i64>,
    /// 最近一次自动同步的失败原因；成功或从未失败为 None。
    pub last_error: Option<String>,
}

/// 远端备份的摘要，供上传/下载前的确认对话框展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRemoteInfo {
    pub manifest: BackupManifest,
    pub size: usize,
    pub sha256: String,
    pub fingerprint: String,
}

/// 远端 manifest：在导出 manifest 的基础上多带 config.json 的大小与摘要，
/// 用于下载后校验完整性（PUT 可能被中断，留下截断的 config.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupRemoteManifest {
    #[serde(flatten)]
    manifest: BackupManifest,
    #[serde(default)]
    size: usize,
    #[serde(default)]
    sha256: String,
}

impl From<BackupSyncConfig> for BackupSyncConfigView {
    fn from(config: BackupSyncConfig) -> Self {
        Self {
            url: config.url,
            username: config.username,
            has_password: !config.password.is_empty(),
            remote_dir: config.remote_dir,
            profile: config.profile,
            auto_sync: config.auto_sync,
            last_sync_at: config.last_sync_at,
            last_error: config.last_error,
        }
    }
}

/// 串行化所有远端读写。
///
/// 上传是「PUT config → PUT manifest」两步，并发执行会让两个文件来自不同快照，
/// 下载侧的 sha256 校验就会失败。
fn backup_sync_mutex() -> &'static tokio::sync::Mutex<()> {
    static MUTEX: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    MUTEX.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 清洗一段远端路径：去首尾斜杠，并丢弃 `.` / `..` 段。
///
/// `join_url` 是逐段 percent-encode，而 `.` 与 `..` 都不在转义集里，会原样留在
/// URL 路径里由服务器按相对路径解析。用户在「远端目录」里填 `../../etc`，
/// 请求就会打到 WebDAV 根目录之外 —— 上传时那是把全部明文 API key PUT 到
/// 非预期路径，下载时是从非预期路径读回来当配置应用。
fn sanitize_remote_path(raw: &str) -> String {
    raw.split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_backup_sync_config(mut config: BackupSyncConfig) -> BackupSyncConfig {
    config.url = config.url.trim().trim_end_matches('/').to_string();
    config.username = config.username.trim().to_string();
    config.remote_dir = sanitize_remote_path(&config.remote_dir);
    if config.remote_dir.is_empty() {
        config.remote_dir = default_backup_remote_dir();
    }
    config.profile = sanitize_remote_path(&config.profile);
    if config.profile.is_empty() {
        config.profile = default_backup_profile();
    }
    config
}

pub(crate) fn load_backup_sync_config(conn: &Connection) -> Result<BackupSyncConfig, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {BACKUP_SYNC_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {BACKUP_SYNC_SETTINGS_TABLE} 失败：{e}"))?;

    let Some(raw) = payload_json else {
        return Ok(BackupSyncConfig::default());
    };
    let value = parse_json(&raw, BACKUP_SYNC_SETTINGS_TABLE)?;
    let config = serde_json::from_value::<BackupSyncConfig>(value)
        .map_err(|e| format!("解析同步配置失败：{e}"))?;
    Ok(normalize_backup_sync_config(config))
}

fn persist_backup_sync_config(conn: &Connection, config: &BackupSyncConfig) -> Result<(), String> {
    let payload = serde_json::to_value(config)
        .map_err(|e| format!("序列化 {BACKUP_SYNC_SETTINGS_TABLE} 失败：{e}"))?;
    conn.execute(
        &format!(
            "INSERT INTO {BACKUP_SYNC_SETTINGS_TABLE} (config_id, payload_json, updated_at)
             VALUES ('default', ?1, ?2)
             ON CONFLICT(config_id) DO UPDATE SET
               payload_json = excluded.payload_json,
               updated_at = excluded.updated_at"
        ),
        params![
            serialize_json(&payload, BACKUP_SYNC_SETTINGS_TABLE)?,
            now_ms()
        ],
    )
    .map_err(|e| format!("写入 {BACKUP_SYNC_SETTINGS_TABLE} 失败：{e}"))?;
    Ok(())
}

/// 把保存请求解析成完整配置：密码未被触碰时回填库中旧值。
///
/// 这是 cc-switch 踩过的真实坑 —— UI 给密码框填掩码占位符后原样提交，
/// 会把占位符当成新密码写库，用户下次同步就认证失败。
pub(crate) fn resolve_backup_sync_config(
    request: BackupSyncConfigRequest,
    persisted: &BackupSyncConfig,
) -> BackupSyncConfig {
    let password = if request.password_touched {
        request.password
    } else {
        persisted.password.clone()
    };
    let mut config = normalize_backup_sync_config(BackupSyncConfig {
        url: request.url,
        username: request.username,
        password,
        remote_dir: request.remote_dir,
        profile: request.profile,
        auto_sync: request.auto_sync,
        // 保存配置不改变同步时间。
        last_sync_at: persisted.last_sync_at,
        last_uploaded_snapshot_hash: persisted.last_uploaded_snapshot_hash.clone(),
        // 但要清掉旧的自动同步错误：用户刚改过配置，那条错误说的是改之前的状态，
        // 继续挂着会让人以为新配置也是坏的。下次自动同步会重新写入真实结果。
        last_error: None,
    });
    if config.url != persisted.url
        || config.username != persisted.username
        || config.password != persisted.password
        || config.remote_dir != persisted.remote_dir
        || config.profile != persisted.profile
        || (config.auto_sync && !persisted.auto_sync)
    {
        config.last_uploaded_snapshot_hash = None;
    }
    config
}

/// 远端目录的分段：`{remote_dir}/v2/{profile}/`。
///
/// 版本段夹在中间而不是最外层，这样用户在 WebDAV 客户端里看到的是一个
/// 干净的 `zeroagent/` 顶层目录，内部再按版本和 profile 分。
fn backup_remote_segments(config: &BackupSyncConfig) -> Vec<&str> {
    vec![
        config.remote_dir.as_str(),
        WEBDAV_LAYOUT_DIR,
        config.profile.as_str(),
    ]
}

fn backup_remote_file_segments<'a>(
    config: &'a BackupSyncConfig,
    filename: &'a str,
) -> Vec<&'a str> {
    let mut segments = backup_remote_segments(config);
    segments.push(filename);
    segments
}

fn backup_remote_file_at_layout<'a>(
    config: &'a BackupSyncConfig,
    layout: &'a str,
    filename: &'a str,
) -> Vec<&'a str> {
    vec![
        config.remote_dir.as_str(),
        layout,
        config.profile.as_str(),
        filename,
    ]
}

async fn read_backup_remote_manifest(
    config: &BackupSyncConfig,
    credentials: &crate::services::webdav::WebdavCredentials,
) -> Result<Option<(BackupRemoteManifest, &'static str)>, String> {
    crate::services::webdav::get_bytes(
        credentials,
        &backup_remote_file_segments(config, WEBDAV_MANIFEST_FILENAME),
        WEBDAV_MANIFEST_MAX_BYTES,
        "远端备份元信息",
    )
    .await?
    .map(|body| Ok((parse_backup_remote_manifest(&body)?, WEBDAV_LAYOUT_DIR)))
    .transpose()
}

async fn read_reviewed_remote_backup(
    config: &BackupSyncConfig,
    credentials: &crate::services::webdav::WebdavCredentials,
    settings_root: &Path,
    fingerprint: &str,
) -> Result<String, String> {
    let Some((remote, layout)) = read_backup_remote_manifest(config, credentials).await? else {
        return Err("远端还没有备份，请先在任一设备上传一次".into());
    };
    verify_backup_fingerprint(settings_root, &remote.sha256, fingerprint)?;
    let body = crate::services::webdav::get_bytes(
        credentials,
        &backup_remote_file_at_layout(config, layout, WEBDAV_CONFIG_FILENAME),
        WEBDAV_CONFIG_MAX_BYTES,
        "远端配置",
    )
    .await?
    .ok_or("远端元信息存在但配置文件缺失，请从源设备重新上传一次")?;
    verify_backup_payload(&body, remote.size, &remote.sha256)?;
    String::from_utf8(body).map_err(|_| "远端配置不是合法的 UTF-8 文本".into())
}

fn backup_sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn backup_import_fingerprint(settings_root: &Path, content_hash: &str) -> String {
    let mut bytes = settings_root.as_os_str().as_encoded_bytes().to_vec();
    bytes.push(0);
    bytes.extend_from_slice(content_hash.as_bytes());
    backup_sha256_hex(&bytes)
}

fn verify_backup_fingerprint(
    settings_root: &Path,
    content_hash: &str,
    expected: &str,
) -> Result<(), String> {
    if backup_import_fingerprint(settings_root, content_hash) != expected {
        return Err("备份内容或当前空间已变化，请重新预览后恢复".into());
    }
    Ok(())
}

struct PreparedBackupUpload {
    document: String,
    manifest: BackupManifest,
    content_hash: String,
}

fn prepare_backup_upload(
    conn: &Connection,
    backend: &ProfileBackupBackend,
    config: &BackupSyncConfig,
    skip_unchanged: bool,
) -> Result<Option<PreparedBackupUpload>, String> {
    if skip_unchanged && !config.auto_sync {
        return Ok(None);
    }
    let snapshot = backend.collect(conn)?;
    let content_hash =
        backup_sha256_hex(&serde_json::to_vec(&snapshot).map_err(|_| "无法计算配置摘要")?);
    if skip_unchanged
        && config.last_uploaded_snapshot_hash.as_deref() == Some(content_hash.as_str())
        && config.last_error.is_none()
    {
        return Ok(None);
    }
    let manifest = build_backup_manifest(&snapshot);
    let document = serialize_backup_document(&snapshot, &manifest)?;
    Ok(Some(PreparedBackupUpload {
        document,
        manifest,
        content_hash,
    }))
}

fn backup_credentials(
    config: &BackupSyncConfig,
) -> Result<crate::services::webdav::WebdavCredentials, String> {
    if config.url.is_empty() {
        return Err("请先填写 WebDAV 服务器地址".to_string());
    }
    if config.username.is_empty() {
        return Err("请先填写 WebDAV 用户名".to_string());
    }
    if config.password.is_empty() {
        return Err("请先填写 WebDAV 密码".to_string());
    }
    Ok(crate::services::webdav::WebdavCredentials {
        base_url: config.url.clone(),
        username: config.username.clone(),
        password: config.password.clone(),
    })
}

/// 校验下载到的 config 与 manifest 声明的大小/摘要一致。
///
/// PUT 可能被中断，留下截断的 config.json；没有这道校验就会把残缺配置
/// 当成合法快照写进本地库。
///
/// 缺字段一律当作损坏处理，**不跳过校验**。曾经这里对 size==0 / sha256=="" 放行，
/// 理由是「兼容旧版本写的 manifest」—— 但 `v1/` 布局是随本功能一起引入的，
/// 不存在写过无摘要 manifest 的历史版本。真正会命中这条分支的只有异常数据：
/// 截断的 PUT、被别的客户端改写过的 manifest。放行等于让它们绕过完整性检查
/// 直接落进本地库。
pub(crate) fn verify_backup_payload(
    body: &[u8],
    expected_size: usize,
    expected_sha256: &str,
) -> Result<(), String> {
    if expected_size == 0 || expected_sha256.is_empty() {
        return Err(
            "远端备份元信息缺少大小或校验和，无法确认配置完整，请从源设备重新上传一次".to_string(),
        );
    }
    if body.len() != expected_size {
        return Err(format!(
            "远端配置大小校验失败：期望 {expected_size} 字节，实际 {} 字节。远端文件可能未上传完整，请从源设备重新上传",
            body.len()
        ));
    }
    let actual = backup_sha256_hex(body);
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err("远端配置校验和不匹配，文件可能已损坏，请从源设备重新上传".to_string());
    }
    Ok(())
}

fn load_backup_sync_config_from_db() -> Result<BackupSyncConfig, String> {
    let conn = open_db()?;
    load_backup_sync_config(&conn)
}

/// 记录一次同步成功：写入时间戳并清掉遗留的自动同步错误横幅。
fn record_backup_sync_success(
    conn: &mut Connection,
    expected: &BackupSyncConfig,
    snapshot_hash: Option<String>,
) -> Result<i64, String> {
    let timestamp = now_ms();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "无法更新同步状态")?;
    let mut config = load_backup_sync_config(&tx)?;
    // Network I/O can outlive an edit in Settings. Never mark a new destination as uploaded or
    // overwrite its credentials with the configuration captured by an earlier operation.
    if config.url != expected.url
        || config.username != expected.username
        || config.password != expected.password
        || config.remote_dir != expected.remote_dir
        || config.profile != expected.profile
    {
        return Ok(timestamp);
    }
    config.last_sync_at = Some(timestamp);
    config.last_uploaded_snapshot_hash = snapshot_hash;
    // 手动同步成功同样清错误：既然这条链路现在是通的，那条旧错误已经过期。
    config.last_error = None;
    persist_backup_sync_config(&tx, &config)?;
    tx.commit().map_err(|_| "无法保存同步状态")?;
    Ok(timestamp)
}

fn touch_backup_last_sync_at(
    expected: &BackupSyncConfig,
    snapshot_hash: Option<String>,
) -> Result<i64, String> {
    record_backup_sync_success(&mut open_db()?, expected, snapshot_hash)
}

/// 记录一次**自动**同步失败。
///
/// 尽力而为：写库本身失败时只能放弃 —— 调用方已经处在错误路径上，
/// 再抛一个错误没有任何人能处理，反而会盖掉真正的失败原因。
fn record_backup_sync_error(
    conn: &mut Connection,
    expected: &BackupSyncConfig,
    message: &str,
) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "无法更新同步状态")?;
    let mut config = load_backup_sync_config(&tx)?;
    if config.url != expected.url
        || config.username != expected.username
        || config.password != expected.password
        || config.remote_dir != expected.remote_dir
        || config.profile != expected.profile
    {
        return Ok(());
    }
    config.last_error = Some(message.to_string());
    persist_backup_sync_config(&tx, &config)?;
    tx.commit().map_err(|_| "无法保存同步状态".into())
}

fn record_backup_auto_sync_error(expected: &BackupSyncConfig, message: &str) {
    let Ok(mut conn) = open_db() else { return };
    let _ = record_backup_sync_error(&mut conn, expected, message);
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn settings_backup_load_sync_config() -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(load_backup_sync_config_from_db()?.into()))
        .await
        .map_err(|e| format!("settings_backup_load_sync_config join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_backup_save_sync_config(
    config: BackupSyncConfigRequest,
) -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "无法保存同步设置")?;
        let persisted = load_backup_sync_config(&tx)?;
        let resolved = resolve_backup_sync_config(config, &persisted);
        persist_backup_sync_config(&tx, &resolved)?;
        tx.commit().map_err(|_| "无法提交同步设置")?;
        Ok(resolved.into())
    })
    .await
    .map_err(|e| format!("settings_backup_save_sync_config join 失败：{e}"))?
}

/// 测试连接。用库里已保存的配置，因此前端须先保存再测试。
#[tauri::command]
pub async fn settings_backup_test_sync_connection() -> Result<(), String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_test_sync_connection join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;
    crate::services::webdav::test_connection(&creds).await
}

/// 拉取远端摘要。远端还没有备份时返回 None。
#[tauri::command]
pub async fn settings_backup_fetch_remote_info(
    app: tauri::AppHandle,
) -> Result<Option<BackupRemoteInfo>, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_fetch_remote_info join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;
    let _guard = backup_sync_mutex().lock().await;

    let Some((remote, _layout)) = read_backup_remote_manifest(&config, &creds).await? else {
        return Ok(None);
    };

    verify_backup_preview(&app, None, &remote.manifest, Some(&remote.sha256))?;
    Ok(Some(BackupRemoteInfo {
        fingerprint: backup_import_fingerprint(&config_dir()?, &remote.sha256),
        manifest: remote.manifest,
        size: remote.size,
        sha256: remote.sha256,
    }))
}

pub(crate) fn parse_backup_remote_manifest(body: &[u8]) -> Result<BackupRemoteManifest, String> {
    let text =
        std::str::from_utf8(body).map_err(|_| "远端备份元信息不是合法的 UTF-8 文本".to_string())?;
    let remote = serde_json::from_str::<BackupRemoteManifest>(text)
        .map_err(|_| "解析远端备份元信息失败：数据格式无效")?;
    validate_backup_manifest(&remote.manifest)?;
    if remote.size == 0
        || remote.size > WEBDAV_CONFIG_MAX_BYTES
        || remote.sha256.len() != 64
        || !remote.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("远端备份元信息的大小或校验和无效".into());
    }
    Ok(remote)
}

/// 上传：采集 → 建目录 → **先 PUT config 再 PUT manifest**。
///
/// 顺序是有意的。manifest 是「这份备份可用」的信号，最后写入，
/// 中途失败时远端留下的是旧 manifest + 新 config，下载侧的 sha256 校验
/// 会拦下这个不一致，而不会当成合法数据应用。
///
/// **锁必须在采集之前获取。** 反过来（先采集后加锁）会开一个窗口：一次手动
/// 下载可以整个挤在采集与 PUT 之间完成，于是这次上传把下载前的旧快照盖回远端，
/// 用户刚拉下来的远端配置被自己的机器悄悄覆盖。抑制守卫挡不住这种情况 ——
/// 它只阻止下载期间新产生的标脏，管不了一个已经采完快照、正停在锁上的上传。
async fn upload_backup_snapshot(
    app: &tauri::AppHandle,
    skip_unchanged: bool,
) -> Result<Option<i64>, String> {
    let _guard = backup_sync_mutex().lock().await;

    let app = app.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let config = load_backup_sync_config(&conn)?;
        let backend = ProfileBackupBackend::from_app(&app)?;
        Ok::<_, String>(
            prepare_backup_upload(&conn, &backend, &config, skip_unchanged)?
                .map(|prepared| (config, prepared)),
        )
    })
    .await
    .map_err(|e| format!("settings_backup_upload join 失败：{e}"))??;
    let Some((
        config,
        PreparedBackupUpload {
            document,
            manifest,
            content_hash,
        },
    )) = prepared
    else {
        return Ok(None);
    };

    let creds = backup_credentials(&config)?;

    let body = document.into_bytes();
    let remote_manifest = BackupRemoteManifest {
        manifest,
        size: body.len(),
        sha256: backup_sha256_hex(&body),
    };
    let manifest_body = serde_json::to_vec_pretty(&remote_manifest)
        .map_err(|e| format!("序列化远端备份元信息失败：{e}"))?;

    crate::services::webdav::ensure_remote_dirs(&creds, &backup_remote_segments(&config)).await?;
    crate::services::webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
        body,
        "application/json",
    )
    .await?;
    crate::services::webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
        manifest_body,
        "application/json",
    )
    .await?;

    tauri::async_runtime::spawn_blocking(move || {
        touch_backup_last_sync_at(&config, Some(content_hash))
    })
    .await
    .map_err(|e| format!("settings_backup_upload join 失败：{e}"))?
    .map(Some)
}

#[tauri::command]
pub async fn settings_backup_upload(app: tauri::AppHandle) -> Result<i64, String> {
    upload_backup_snapshot(&app, false)
        .await?
        .ok_or_else(|| "配置上传未执行".to_string())
}

/// 自动同步的上传入口。
///
/// 与手动上传有两点不同：
/// 1. 没开开关或凭据不全就静默跳过 —— 自动路径不该因为用户没配 WebDAV 就反复弹错误。
/// 2. 失败会落库（`last_error`）。用户此刻多半不在设置页，只靠事件推送的话
///    页面一卸载错误就没了，配置早已停止同步而用户毫不知情。
pub(crate) async fn auto_upload_backup_snapshot(
    app: &tauri::AppHandle,
) -> Result<Option<i64>, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("auto_upload_backup_snapshot join 失败：{e}"))??;
    if !config.auto_sync || backup_credentials(&config).is_err() {
        return Ok(None);
    }
    match upload_backup_snapshot(app, true).await {
        Ok(timestamp) => Ok(timestamp),
        Err(error) => {
            let message = error.clone();
            // 落库放到 blocking 线程，避免在异步上下文里做同步 SQLite IO。
            let _ = tauri::async_runtime::spawn_blocking(move || {
                record_backup_auto_sync_error(&config, &message);
            })
            .await;
            Err(error)
        }
    }
}

/// 下载：拉 manifest → 拉 config → 校验 size+sha256 → 应用快照。
///
/// **全程持有全局锁**，应用快照也在锁内。应用要跨多个配置域分别写库，
/// 中间态是不自洽的；若此时自动上传拿到锁开始采集快照，传上去的
/// 就是半旧半新的配置。抑制守卫在锁内获取、随 blocking 任务一同释放，
/// 顺序与 cc-switch 的 `run_with_webdav_lock` 一致。
#[tauri::command]
pub async fn settings_backup_download(
    app: tauri::AppHandle,
    fingerprint: String,
) -> Result<BackupApplyOutcome, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_download join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;

    let _guard = backup_sync_mutex().lock().await;

    let document =
        read_reviewed_remote_backup(&config, &creds, &config_dir()?, &fingerprint).await?;

    tauri::async_runtime::spawn_blocking(move || {
        // 应用快照会走各域的 save_*，它们都会标脏。
        // 不抑制就会把刚拉下来的远端数据原样推回去。
        let _suppression = crate::services::webdav_auto_sync::suppress();
        let (snapshot, manifest) = parse_backup_document(&document)?;
        let mut conn = open_db()?;
        let backend = ProfileBackupBackend::from_app(&app)?;
        let _configuration_guard = backend.configuration.blocking_lock();
        let outcome = apply_profile_backup_locked(
            &mut conn,
            &backend,
            snapshot,
            BackupSource {
                schema_version: manifest.schema_version,
                fingerprint,
            },
        )?;
        // 时间戳写失败**不能**推翻已经落库的还原。快照此刻已经 commit，
        // 这里再返回 Err 会让前端走 catch 分支：还原提示变成错误提示，
        // 且负责重载前端 store 的 `syncStateAfterRestore` 不会执行 ——
        // 内存里仍是还原前的旧配置，下次编辑任一域就把它整个写回库，
        // 用户看到的是「还原报错了，配置也确实没变」，而库已经被改了。
        // last_sync_at 只是展示用的元信息，丢一次远不如丢掉还原结果严重。
        let content_hash = backend
            .collect_locked(&conn)
            .ok()
            .and_then(|snapshot| serde_json::to_vec(&snapshot).ok())
            .map(|bytes| backup_sha256_hex(&bytes));
        let _ = touch_backup_last_sync_at(&config, content_hash);
        Ok(outcome)
    })
    .await
    .map_err(|e| format!("settings_backup_download join 失败：{e}"))?
}
