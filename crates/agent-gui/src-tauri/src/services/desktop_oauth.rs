use std::collections::HashMap;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

const OAUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

#[derive(Deserialize)]
struct AuthorizationRequestResponse {
    request_id: String,
    authorization_uri: Option<String>,
}

#[derive(Deserialize)]
struct OAuthErrorResponse {
    error: String,
    error_description: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct OAuthTokens {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: i64,
    scope: String,
}

#[derive(Deserialize)]
struct AppEnvelope {
    success: bool,
    message: String,
    data: Option<Value>,
}

#[derive(Serialize)]
pub struct DesktopOAuthResult {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: i64,
    scope: String,
    auth_kind: &'static str,
    oauth_client_id: &'static str,
    user: Value,
}

#[tauri::command]
pub async fn desktop_oauth_login(
    app: AppHandle,
    relay_origin: String,
    installation_id: String,
) -> Result<DesktopOAuthResult, String> {
    let origin = normalize_origin(&relay_origin)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");
    let state = random_opaque();
    let verifier = format!("{}{}", random_opaque(), random_opaque());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{origin}/api/v1/app-auth/authorize/requests"))
        .json(&json!({
            "response_type": "code",
            "client_id": "zeroagent-desktop",
            "redirect_uri": redirect_uri,
            "scope": "profile:read profile:write usage:read groups:read keys:read keys:write subscriptions:read execution:authorize offline_access",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
		"device_name": "ZeroAgent Desktop",
		"platform": std::env::consts::OS,
		"installation_id": installation_id,
	}))
        .send().await.map_err(|_| "usa0.top 暂时不可用".to_string())?;
    let status = response.status();
    let response_body = response
        .bytes()
        .await
        .map_err(|_| "usa0.top 返回了无效授权响应".to_string())?;
    if !status.is_success() {
        let oauth_error = serde_json::from_slice::<OAuthErrorResponse>(&response_body).ok();
        return Err(oauth_error
            .as_ref()
            .and_then(|error| error.error_description.as_deref())
            .filter(|message| !message.is_empty())
            .map(str::to_owned)
            .or_else(|| oauth_error.map(|error| error.error))
            .unwrap_or_else(|| "无法创建授权请求".to_string()));
    }
    let authorization: AuthorizationRequestResponse = serde_json::from_slice(&response_body)
        .map_err(|_| "usa0.top 返回了无效授权响应".to_string())?;
    if authorization.request_id.trim().is_empty() {
        return Err("授权响应缺少 request_id".to_string());
    }
    let authorize_url = match authorization.authorization_uri {
        Some(uri) if uri.starts_with('/') => format!("{origin}{uri}"),
        Some(uri) if uri.starts_with("https://") || uri.starts_with("http://") => uri,
        _ => format!(
            "{origin}/oauth/authorize?request_id={}",
            url::form_urlencoded::byte_serialize(authorization.request_id.as_bytes())
                .collect::<String>()
        ),
    };
    app.opener()
        .open_url(authorize_url, None::<&str>)
        .map_err(|error| error.to_string())?;

    let callback = tokio::time::timeout(OAUTH_TIMEOUT, receive_callback(listener))
        .await
        .map_err(|_| "授权已超时，请重试".to_string())??;
    if callback.get("state").map(String::as_str) != Some(state.as_str()) {
        return Err("授权 state 不匹配".into());
    }
    if let Some(error) = callback.get("error") {
        return Err(if error == "access_denied" {
            "已取消认证授权".into()
        } else {
            format!("认证授权失败：{error}")
        });
    }
    let code = callback
        .get("code")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "授权回调缺少 code".to_string())?;
    let tokens_response = client
        .post(format!("{origin}/api/v1/app-auth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", "zeroagent-desktop"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "usa0.top 换码服务不可用".to_string())?;
    if !tokens_response.status().is_success() {
        return Err("授权码换取令牌失败".into());
    }
    let tokens: OAuthTokens = tokens_response
        .json()
        .await
        .map_err(|_| "usa0.top 返回了无效令牌".to_string())?;
    let me_response = client
        .get(format!("{origin}/api/v1/app/me"))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|_| "无法读取授权账户".to_string())?;
    let me: AppEnvelope = me_response
        .json()
        .await
        .map_err(|_| "usa0.top 返回了无效账户资料".to_string())?;
    if !me.success {
        return Err(if me.message.is_empty() {
            "无法读取授权账户".into()
        } else {
            me.message
        });
    }
    let mut user = me.data.unwrap_or(Value::Null);
    if let Some(object) = user.as_object_mut() {
        object.insert("auth_kind".into(), Value::String("oauth".into()));
    }
    Ok(DesktopOAuthResult {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        auth_kind: "oauth",
        oauth_client_id: "zeroagent-desktop",
        user,
    })
}

async fn receive_callback(listener: TcpListener) -> Result<HashMap<String, String>, String> {
    let (mut stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; 16 * 1024];
    let size = stream
        .read(&mut buffer)
        .await
        .map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "授权回调请求无效".to_string())?;
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "授权回调地址无效".to_string())?;
    if url.path() != "/oauth/callback" {
        return Err("授权回调路径无效".into());
    }
    let params = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let body = "<!doctype html><meta charset=utf-8><title>ZeroAgent</title><p>认证已完成，可以关闭此页面并返回 ZeroAgent。</p>";
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    Ok(params)
}

fn normalize_origin(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "USA-Zero 服务地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("USA-Zero 服务地址无效".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn random_opaque() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
