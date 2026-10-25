//! RFC 7591 动态客户端注册（docs/design/mcp-oauth.md §3）。
//!
//! 托管 MCP server 普遍开放 DCR；注册为公共客户端
//! （`token_endpoint_auth_method: "none"`），AS 若坚持发 secret 则按其返回的
//! auth method 使用。注册结果随 TokenRecord 同存 keychain。

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub token_endpoint_auth_method: String,
}

#[derive(Debug, Deserialize)]
struct RegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

pub fn dynamic_register(
    client: &Client,
    registration_endpoint: &str,
    redirect_uri: &str,
    scope: Option<&str>,
) -> Result<RegisteredClient, String> {
    let mut body = json!({
        "client_name": "ZeroAgent",
        "client_uri": "https://github.com/USA-Zero/ZeroAgent",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if let Some(scope) = scope.map(str::trim).filter(|s| !s.is_empty()) {
        body["scope"] = json!(scope);
    }

    let resp = client
        .post(registration_endpoint)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .map_err(|_| "动态注册请求失败")?;

    let status = resp.status();
    let text = super::read_oauth_response(resp)?;
    if !status.is_success() {
        return Err(format!("动态注册被拒绝（HTTP {}）", status.as_u16()));
    }

    let parsed: RegistrationResponse =
        serde_json::from_str(&text).map_err(|_| "解析动态注册响应失败")?;
    let client_id = parsed.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("动态注册响应缺少 client_id".to_string());
    }

    Ok(RegisteredClient {
        client_id,
        client_secret: parsed.client_secret.filter(|s| !s.trim().is_empty()),
        token_endpoint_auth_method: parsed
            .token_endpoint_auth_method
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "none".to_string()),
    })
}
