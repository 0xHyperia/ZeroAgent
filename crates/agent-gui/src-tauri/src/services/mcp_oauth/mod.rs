//! MCP OAuth 2.1 服务（docs/design/mcp-oauth.md，roadmap P1-③）。
//!
//! 分层：
//! - `discovery` 发现链（RFC 9728/8414 + 旧规范 fallback）
//! - `register` RFC 7591 动态注册
//! - `flow` PKCE/loopback/token 端点机械件
//! - `store` keychain 存储 + 文件降级 + 进程内缓存
//!
//! 本模块编排两条路径：
//! 1. **交互授权**（`authorize`）——仅由显式用户手势触发（MCP Hub Connect），
//!    弹系统浏览器；同 server 进程内互斥。
//! 2. **运行时供 token**（`ensure_bearer` / `refresh_after_unauthorized`）——
//!    transport 每请求取 Bearer，将过期主动刷新、401 被动刷新；绝不弹浏览器。

pub(crate) mod broker;
pub mod discovery;
#[cfg(test)]
mod error_tests;
pub mod flow;
pub mod register;
mod rotation;
#[cfg(test)]
pub(crate) mod scoped_tests;
pub mod store;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use store::{TokenRecord, TokenStore};

/// 稳定标记：错误信息含它即「需要用户去 MCP Hub 完成授权」，前端据此引导。
pub const AUTH_REQUIRED_MARKER: &str = "MCP_OAUTH_AUTHORIZATION_REQUIRED";

const MAX_OAUTH_RESPONSE_BYTES: usize = 1024 * 1024;

fn read_oauth_response(response: reqwest::blocking::Response) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    response
        .take(MAX_OAUTH_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取 OAuth 响应失败")?;
    if bytes.len() > MAX_OAUTH_RESPONSE_BYTES {
        return Err("OAuth 响应超过大小上限".into());
    }
    String::from_utf8(bytes).map_err(|_| "OAuth 响应编码无效".into())
}

fn safe_oauth_error(value: &str) -> &'static str {
    match value {
        "invalid_request" => "invalid_request",
        "invalid_client" => "invalid_client",
        "invalid_grant" => "invalid_grant",
        "invalid_scope" => "invalid_scope",
        "unauthorized_client" => "unauthorized_client",
        "unsupported_grant_type" => "unsupported_grant_type",
        "access_denied" => "access_denied",
        "server_error" => "server_error",
        "temporarily_unavailable" => "temporarily_unavailable",
        _ => "oauth_error",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OauthServer {
    pub id: String,
    pub url: String,
    /// 配置里的 scope 覆盖（优先于 PRM scopes_supported）。
    pub scope_override: Option<String>,
    /// 静态 client_id（企业 AS 场景；配置后跳过动态注册）。
    pub static_client_id: Option<String>,
}

/// The configured Native owner can make the final target check and credential
/// persistence one operation under its configuration gate. Mechanical fixtures and
/// legacy callers use the simple validator implementation.
pub(crate) trait CredentialOwner {
    fn validate(&self) -> Result<(), String>;
    fn persist(
        &self,
        store: &TokenStore,
        record: &TokenRecord,
        baseline: &store::Snapshot,
    ) -> Result<&'static str, String> {
        self.validate()?;
        store.save(record, baseline)
    }
}

impl<F: Fn() -> Result<(), String>> CredentialOwner for F {
    fn validate(&self) -> Result<(), String> {
        self()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatusInfo {
    /// "none" | "authorized" | "expired"（expired 且 refreshable 时运行时会自愈）。
    pub state: String,
    pub refreshable: bool,
    /// "keychain" | "file" | "unknown"
    pub storage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

pub(crate) fn none_status() -> OauthStatusInfo {
    OauthStatusInfo {
        state: "none".to_string(),
        refreshable: false,
        storage: "unknown".to_string(),
        expires_at_ms: None,
        issuer: None,
        scope: None,
    }
}

fn status_of(record: &TokenRecord, storage: &str) -> OauthStatusInfo {
    let now = store::now_ms();
    // AS metadata/token responses are untrusted. Even a valid public field must
    // not reflect a token or client secret through the status IPC.
    let safe_metadata = |value: &str| {
        [
            Some(record.access_token.as_str()),
            record.refresh_token.as_deref(),
            record.client_secret.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|secret| !secret.is_empty())
        .all(|secret| !value.contains(secret))
    };
    OauthStatusInfo {
        state: if record.is_expired(now) {
            "expired".to_string()
        } else {
            "authorized".to_string()
        },
        refreshable: record.refresh_token.is_some(),
        storage: storage.to_string(),
        expires_at_ms: (record.expires_at_ms != 0).then_some(record.expires_at_ms),
        issuer: safe_metadata(&record.issuer).then(|| record.issuer.clone()),
        scope: record
            .scope
            .as_ref()
            .filter(|scope| safe_metadata(scope))
            .cloned(),
    }
}

/// 读取记录并校验其 server_url 与当前配置一致；不一致视作无 token（防串用）。
fn load_matching(store: &TokenStore, url: &str) -> Option<TokenRecord> {
    let record = store.snapshot().ok()?.record?;
    let canonical = discovery::canonical_resource(url).ok()?;
    (record.server_url == canonical).then_some(record)
}

pub fn status(server: &OauthServer) -> OauthStatusInfo {
    TokenStore::capture(&server.id)
        .and_then(|store| status_in(&store, server))
        .unwrap_or_else(|_| none_status())
}

pub(crate) fn status_in(
    store: &TokenStore,
    server: &OauthServer,
) -> Result<OauthStatusInfo, String> {
    let snapshot = store.snapshot()?;
    let canonical = discovery::canonical_resource(&server.url)?;
    Ok(
        match snapshot
            .record
            .filter(|record| record.server_url == canonical)
        {
            Some(record) => status_of(&record, snapshot.storage),
            None => none_status(),
        },
    )
}

/// 卸载 server / 用户断开授权时调用：清 keychain 与文件降级条目。
pub(crate) fn clear(store: &TokenStore) -> Result<(), String> {
    clear_client_suspect(store.identity());
    store.delete()
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    // 出站纪律：与 MCP transport 同走应用代理，代理配置异常 fail fast。
    crate::services::system_proxy::blocking_client_builder()
        .map_err(|_| "创建 OAuth HTTP client 失败")?
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "创建 OAuth HTTP client 失败".into())
}

// ---- 交互授权（进程内同 server 互斥） ----

fn authorize_guard() -> &'static Mutex<HashSet<String>> {
    static GUARD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(HashSet::new()))
}

struct AuthorizeSlot(String);

impl AuthorizeSlot {
    fn acquire(server_id: &str) -> Result<Self, String> {
        let mut guard = authorize_guard()
            .lock()
            .map_err(|_| "授权互斥锁失败".to_string())?;
        if !guard.insert(server_id.to_string()) {
            return Err(format!(
                "server `{server_id}` 的授权正在进行中，请先完成或等待超时"
            ));
        }
        Ok(Self(server_id.to_string()))
    }
}

impl Drop for AuthorizeSlot {
    fn drop(&mut self) {
        if let Ok(mut guard) = authorize_guard().lock() {
            guard.remove(&self.0);
        }
    }
}

/// 浏览器阶段/换码失败过的存量 client（server id 集合，进程内）。命中的
/// server 下次授权跳过复用、直接动态重注册自愈；keychain 记录原样保留——
/// 授权失败可能只是超时/用户关页，存量 token/refresh_token 运行时仍有效，
/// 不能因一次未完成的 Reauthorize 就销毁可用凭据。
fn suspect_clients() -> &'static Mutex<HashSet<String>> {
    static SUSPECTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SUSPECTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_client_suspect(server_id: &str) -> bool {
    suspect_clients()
        .lock()
        .map(|set| set.contains(server_id))
        .unwrap_or(false)
}

fn mark_client_suspect(server_id: &str) {
    if let Ok(mut set) = suspect_clients().lock() {
        set.insert(server_id.to_string());
    }
}

fn clear_client_suspect(server_id: &str) {
    if let Ok(mut set) = suspect_clients().lock() {
        set.remove(server_id);
    }
}

/// 完整交互授权流（阻塞数分钟，必须在 spawn_blocking 里跑）。
/// `open_url` 由命令层注入（tauri-plugin-opener），保持服务层无 Tauri 依赖。
pub(crate) fn authorize(
    store: &TokenStore,
    server: &OauthServer,
    open_url: &dyn Fn(&str) -> Result<(), String>,
    owner: &dyn CredentialOwner,
) -> Result<OauthStatusInfo, String> {
    let server_id = server.id.trim();
    if server_id.is_empty() {
        return Err("server id 不能为空".to_string());
    }
    owner.validate()?;
    let identity = store.identity();
    let _slot = AuthorizeSlot::acquire(identity)?;
    let baseline = store.begin_authorization()?;

    let client = http_client()?;
    let discovered = discovery::discover(&client, &server.url)?;

    // 先绑端口再定 redirect_uri，动态注册才能带上准确的回调地址。
    let loopback = flow::Loopback::bind()?;
    let redirect_uri = loopback.redirect_uri();

    // client 凭据：静态配置 > keychain 存量注册（issuer 一致才复用）> 动态注册。
    // 上次授权失败过的存量 client 视作可疑，跳过复用直接重注册。
    let canonical = discovery::canonical_resource(&server.url)?;
    let stored = baseline
        .record
        .as_ref()
        .filter(|record| record.server_url == canonical);
    let reused_stored_client = !is_client_suspect(identity)
        && stored.as_ref().is_some_and(|record| {
            record.issuer == discovered.issuer && !record.client_id.is_empty()
        });
    let (client_id, client_secret, auth_method) = if let Some(static_id) = server
        .static_client_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        (static_id.to_string(), None, "none".to_string())
    } else if let (true, Some(record)) = (reused_stored_client, stored.as_ref()) {
        (
            record.client_id.clone(),
            record.client_secret.clone(),
            record.token_endpoint_auth_method.clone(),
        )
    } else {
        let endpoint = discovered.registration_endpoint.as_deref().ok_or_else(|| {
            "授权服务器未开放动态注册，请在 server 配置里填写 OAuth Client ID".to_string()
        })?;
        let registered = register::dynamic_register(
            &client,
            endpoint,
            &redirect_uri,
            server.scope_override.as_deref(),
        )?;
        (
            registered.client_id,
            registered.client_secret,
            registered.token_endpoint_auth_method,
        )
    };

    let scope = server
        .scope_override
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            (!discovered.scopes_supported.is_empty()).then(|| discovered.scopes_supported.join(" "))
        });

    let pkce = flow::new_pkce()?;
    let state = flow::random_b64url(32)?;
    let authorize_url = flow::build_authorize_url(
        &discovered.authorization_endpoint,
        &client_id,
        &redirect_uri,
        &state,
        &pkce.challenge,
        &discovered.resource,
        scope.as_deref(),
    )?;
    if !flow::is_safe_browser_url(&authorize_url) {
        return Err("拒绝打开不安全的授权 URL".into());
    }
    owner.validate()?;
    open_url(&authorize_url)?;

    let code = match loopback.wait_for_code(&state, flow::AUTHORIZE_TIMEOUT) {
        Ok(code) => code,
        Err(error) => {
            // 失败原因无法区分「AS 作废了复用的 client」与超时/用户关页等无关
            // 故障，只标记 client 可疑（下次授权重注册），存量 token 保留。
            if reused_stored_client && server.static_client_id.is_none() {
                mark_client_suspect(identity);
            }
            return Err(error);
        }
    };

    owner.validate()?;
    let credentials = flow::ClientCredentials {
        client_id: &client_id,
        client_secret: client_secret.as_deref(),
        auth_method: &auth_method,
    };
    let tokens = flow::exchange_code(
        &client,
        &discovered.token_endpoint,
        &credentials,
        &code,
        &pkce.verifier,
        &redirect_uri,
        &discovered.resource,
    )
    .map_err(|error| {
        // 换码被拒（如 invalid_client）同样只标记，等下次授权走重注册。
        if reused_stored_client && server.static_client_id.is_none() {
            mark_client_suspect(identity);
        }
        error
    })?;

    let now = store::now_ms();
    let record = TokenRecord {
        version: 1,
        server_url: discovered.resource.clone(),
        target_binding: None,
        issuer: discovered.issuer.clone(),
        authorization_endpoint: discovered.authorization_endpoint.clone(),
        token_endpoint: discovered.token_endpoint.clone(),
        registration_endpoint: discovered.registration_endpoint.clone(),
        client_id,
        client_secret,
        token_endpoint_auth_method: auth_method,
        scope: tokens.scope.clone().or(scope),
        resource: discovered.resource.clone(),
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at_ms: tokens
            .expires_in
            .map(|secs| now.saturating_add(secs.saturating_mul(1000)))
            .unwrap_or(0),
    };
    let storage = owner.persist(store, &record, &baseline)?;
    clear_client_suspect(identity);
    Ok(status_of(&record, storage))
}

// ---- 运行时 token 供给 ----

fn refresh_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn refresh_lock_for(server_id: &str) -> Arc<Mutex<()>> {
    let mut locks = match refresh_locks().lock() {
        Ok(locks) => locks,
        Err(poisoned) => poisoned.into_inner(),
    };
    locks
        .entry(server_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// 刷新并落盘；单飞：并发到达的请求拿锁后重读，若别人刚刷完直接复用。
fn refresh_record(
    store: &TokenStore,
    stale: &TokenRecord,
    owner: &dyn CredentialOwner,
) -> Result<TokenRecord, String> {
    let lock = refresh_lock_for(store.identity());
    let _guard = lock.lock().map_err(|_| "刷新互斥锁失败".to_string())?;
    owner.validate()?;
    let baseline = store.snapshot()?;

    if let Some(current) = baseline
        .record
        .as_ref()
        .filter(|current| current.server_url == stale.server_url)
    {
        if current.access_token != stale.access_token && !current.is_expiring(store::now_ms()) {
            return Ok(current.clone());
        }
        let next = request_refreshed_record(current)?;
        owner.persist(store, &next, &baseline)?;
        Ok(next)
    } else {
        Err("token 记录已不存在，需重新授权".to_string())
    }
}

fn request_refreshed_record(current: &TokenRecord) -> Result<TokenRecord, String> {
    let refresh_token = current
        .refresh_token
        .as_deref()
        .ok_or("无 refresh_token，需重新授权")?;
    let client = http_client()?;
    let credentials = flow::ClientCredentials {
        client_id: &current.client_id,
        client_secret: current.client_secret.as_deref(),
        auth_method: &current.token_endpoint_auth_method,
    };
    let tokens = flow::refresh_grant(
        &client,
        &current.token_endpoint,
        &credentials,
        refresh_token,
        &current.resource,
    )?;
    let mut next = current.clone();
    next.access_token = tokens.access_token;
    if let Some(rotated) = tokens.refresh_token {
        next.refresh_token = Some(rotated);
    }
    if let Some(scope) = tokens.scope {
        next.scope = Some(scope);
    }
    next.expires_at_ms = tokens
        .expires_in
        .map(|secs| store::now_ms().saturating_add(secs.saturating_mul(1000)))
        .unwrap_or(0);
    Ok(next)
}

/// transport 每请求取 Bearer：无记录/URL 不符返回 None（请求裸发，401 走被动
/// 路径）；将过期且可刷新时主动刷新，刷新失败仍返回旧 token 兜底尝试。
pub fn ensure_bearer(server_id: &str, url: &str) -> Option<String> {
    let store = TokenStore::capture(server_id).ok()?;
    let record = load_matching(&store, url)?;
    if record.is_expiring(store::now_ms()) && record.refresh_token.is_some() {
        match refresh_record(&store, &record, &|| store.ensure_current_profile()) {
            Ok(next) => {
                store.ensure_current_profile().ok()?;
                return Some(next.access_token);
            }
            Err(error) => {
                eprintln!("[MCP OAuth] server `{server_id}` 主动刷新失败，回退旧 token：{error}");
            }
        }
    }
    store.ensure_current_profile().ok()?;
    // A concurrent clear or a newer authorization may have superseded the failed refresh.
    // Never resurrect the pre-refresh token from the local variable.
    Some(load_matching(&store, url)?.access_token)
}

/// 401 被动刷新：成功返回新 Bearer；不可行（无记录/无 refresh_token/刷新被拒）
/// 返回 Err——调用方应转成带 [`AUTH_REQUIRED_MARKER`] 的用户可见错误。
pub fn refresh_after_unauthorized(server_id: &str, url: &str) -> Result<String, String> {
    let store = TokenStore::capture(server_id)?;
    let record = load_matching(&store, url)
        .ok_or_else(|| "尚未完成 OAuth 授权（无 token 记录）".to_string())?;
    let refreshed = refresh_record(&store, &record, &|| store.ensure_current_profile())?;
    Ok(refreshed.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_slot_blocks_concurrent_same_server() {
        let slot = AuthorizeSlot::acquire("dup-server").expect("first");
        let second = AuthorizeSlot::acquire("dup-server");
        assert!(second.is_err(), "同 server 并发授权必须被拒");
        assert!(
            AuthorizeSlot::acquire("other-server").is_ok(),
            "不同 server 不受影响"
        );
        drop(slot);
        assert!(
            AuthorizeSlot::acquire("dup-server").is_ok(),
            "释放后可再授权"
        );
    }

    #[test]
    fn suspect_marking_skips_reuse_without_touching_other_servers() {
        assert!(!is_client_suspect("suspect-a"));
        mark_client_suspect("suspect-a");
        assert!(is_client_suspect("suspect-a"), "标记后下次授权应跳过复用");
        assert!(!is_client_suspect("suspect-b"), "标记只影响该 server");
        clear_client_suspect("suspect-a");
        assert!(!is_client_suspect("suspect-a"), "授权成功/clear 后解除标记");
        // 重复 clear 幂等。
        clear_client_suspect("suspect-a");
        assert!(!is_client_suspect("suspect-a"));
    }

    #[test]
    fn status_maps_expiry_and_refreshability() {
        let now = store::now_ms();
        let mut record = TokenRecord {
            version: 1,
            server_url: "https://mcp.example.com/mcp".to_string(),
            target_binding: None,
            issuer: "https://auth.example.com".to_string(),
            authorization_endpoint: "https://auth.example.com/authorize".to_string(),
            token_endpoint: "https://auth.example.com/token".to_string(),
            registration_endpoint: None,
            client_id: "c".to_string(),
            client_secret: None,
            token_endpoint_auth_method: "none".to_string(),
            scope: Some("s".to_string()),
            resource: "https://mcp.example.com/mcp".to_string(),
            access_token: "at".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_at_ms: now + 3_600_000,
        };
        let live = status_of(&record, "file");
        assert_eq!(live.state, "authorized");
        assert!(live.refreshable);
        assert_eq!(live.expires_at_ms, Some(record.expires_at_ms));

        record.expires_at_ms = 1;
        record.refresh_token = None;
        let dead = status_of(&record, "file");
        assert_eq!(dead.state, "expired");
        assert!(!dead.refreshable);
    }

    #[test]
    fn status_metadata_cannot_reflect_tokens_or_client_secret() {
        let fixture = scoped_tests::Fixture::new(|| {});
        for secret in [
            "fixture-old-access",
            "fixture-old-refresh",
            "private-client-secret",
        ] {
            let mut record = fixture.record();
            record.client_secret = Some("private-client-secret".into());
            record.issuer = format!("https://issuer.invalid/?echo={secret}");
            record.scope = Some(format!("read {secret}"));
            let status = status_of(&record, "file");
            assert!(status.issuer.is_none());
            assert!(status.scope.is_none());
            assert!(!serde_json::to_string(&status).unwrap().contains(secret));
        }
    }
}
