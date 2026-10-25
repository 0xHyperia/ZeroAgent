//! MCP OAuth 命令（docs/design/mcp-oauth.md §5）。
//!
//! 三条命令都只搬运状态与元数据，token 本体永不过前端边界：
//! - `mcp_oauth_authorize`：交互授权（弹系统浏览器，阻塞至回调/超时），只由
//!   MCP Hub 的 Connect 手势触发。
//! - `mcp_oauth_status`：授权状态查询（server 卡片徽章）。
//! - `mcp_oauth_clear`：断开授权/删除 server 时清理 keychain 条目。

use super::mcp::{run_blocking, McpServerConfig};
use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};
use crate::services::mcp_oauth::{self, OauthStatusInfo};
use std::sync::Arc;
use tauri_plugin_opener::OpenerExt;

struct OwnedOperation {
    store: mcp_oauth::store::TokenStore,
    state: Arc<KBrainBackendState>,
    connection: KBrainBackendConnection,
}

impl OwnedOperation {
    fn capture(state: &Arc<KBrainBackendState>, server_id: &str) -> Result<Self, String> {
        let store = state.capture_mcp_oauth_store(server_id)?;
        let connection = state
            .running_connection()
            .ok_or("当前空间的执行后端尚未就绪")?;
        let operation = Self {
            store,
            connection,
            state: Arc::clone(state),
        };
        operation.validate()?;
        Ok(operation)
    }

    fn validate(&self) -> Result<(), String> {
        if !self.state.allows_profile_commands()
            || !self.state.running_connection().is_some_and(|current| {
                current.storage_id == self.connection.storage_id
                    && current.token == self.connection.token
                    && current.base_url == self.connection.base_url
            })
        {
            return Err("USA_ZERO_PROFILE_AUTH_REQUIRED".into());
        }
        self.store.ensure_current_profile()
    }
}

fn oauth_server_of(server: &McpServerConfig) -> Result<mcp_oauth::OauthServer, String> {
    if !matches!(
        server.transport.as_deref().unwrap_or("stdio").trim(),
        "http" | "sse"
    ) {
        return Err("仅 http/sse transport 支持 OAuth".to_string());
    }
    server
        .oauth_server()
        .ok_or_else(|| "MCP server 缺少 url，无法执行 OAuth".to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_authorize(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<KBrainBackendState>>,
    server: McpServerConfig,
) -> Result<OauthStatusInfo, String> {
    let target = oauth_server_of(&server)?;
    let transport = server
        .transport
        .as_deref()
        .unwrap_or("stdio")
        .trim()
        .to_owned();
    let operation = OwnedOperation::capture(&state, &target.id)?;
    // 授权流阻塞数分钟（等浏览器回调），必须 offload；浏览器打开经 opener 插件
    // 走系统默认浏览器。
    run_blocking("mcp_oauth_authorize", move || {
        operation.validate()?;
        let binding = crate::commands::settings::CanonicalMcpOauthBinding::capture(
            operation.connection.clone(),
            Arc::clone(&operation.state),
            &operation.store,
            &target,
            &transport,
        )?;
        mcp_oauth::authorize(
            &operation.store,
            binding.server(),
            &|url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|e| format!("打开系统浏览器失败：{e}"))
            },
            &binding,
        )
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_status(
    state: tauri::State<'_, Arc<KBrainBackendState>>,
    server: McpServerConfig,
) -> Result<OauthStatusInfo, String> {
    let target = oauth_server_of(&server)?;
    let transport = server
        .transport
        .as_deref()
        .unwrap_or("stdio")
        .trim()
        .to_owned();
    let operation = OwnedOperation::capture(&state, &target.id)?;
    run_blocking("mcp_oauth_status", move || {
        operation.validate()?;
        let binding = crate::commands::settings::CanonicalMcpOauthBinding::capture(
            operation.connection.clone(),
            Arc::clone(&operation.state),
            &operation.store,
            &target,
            &transport,
        )?;
        let status = binding.status(&operation.store)?;
        operation.validate()?;
        Ok(status)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_clear(
    state: tauri::State<'_, Arc<KBrainBackendState>>,
    server_id: String,
) -> Result<(), String> {
    let operation = OwnedOperation::capture(&state, &server_id)?;
    let configuration = operation.state.configuration_coordinator()?;
    run_blocking("mcp_oauth_clear", move || {
        let id = server_id.trim().to_string();
        if id.is_empty() {
            return Err("server_id 不能为空".to_string());
        }
        operation.validate()?;
        let _guard = configuration.blocking_lock();
        operation.validate()?;
        mcp_oauth::clear(&operation.store)
    })
    .await
}
