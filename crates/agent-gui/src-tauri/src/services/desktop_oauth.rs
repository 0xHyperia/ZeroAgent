use std::collections::HashMap;

use super::account_session::{AccountSessionState, AccountSessionSummary};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use super::managed_model_broker::configured_origin;

const OAUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const RESPONSE_ERROR: &str = "USA-Zero 返回了无效授权响应";

#[derive(Deserialize)]
struct AuthorizationRequestResponse {
    request_id: String,
}

#[cfg(test)]
#[derive(Deserialize, Serialize)]
struct OAuthTokens {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: i64,
    scope: String,
}

pub type DesktopOAuthResult = AccountSessionSummary;

#[tauri::command]
pub async fn desktop_oauth_login(
    app: AppHandle,
    account: State<'_, Arc<AccountSessionState>>,
    relay_origin: String,
    installation_id: String,
) -> Result<DesktopOAuthResult, String> {
    let origin = normalize_origin(&relay_origin)?;
    let authorization_ticket = account.begin_authorization().await;
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
    let client = oauth_client(HTTP_TIMEOUT)?;

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
    if !response.status().is_success() {
        return Err("无法创建 USA-Zero 授权请求".into());
    }
    let response_body = read_response_body(response).await?;
    let authorization: AuthorizationRequestResponse = serde_json::from_slice(&response_body)
        .map_err(|_| "usa0.top 返回了无效授权响应".to_string())?;
    // This is the registered USA-Zero authorization route. Never open a response-supplied URL.
    let authorize_url = authorization_url(&origin, &authorization.request_id)?;
    app.opener()
        .open_url(authorize_url, None::<&str>)
        .map_err(|_| "无法打开 USA-Zero 授权页面".to_string())?;

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
            "认证授权失败".into()
        });
    }
    let code = callback
        .get("code")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "授权回调缺少 code".to_string())?;
    let session = account
        .exchange_authorization_code(authorization_ticket, code, &redirect_uri, &verifier)
        .await?;
    super::account_session::api::guard_viewer(&app, account.inner(), &session.session_handle)
        .await?;
    account.public_summary(&session.session_handle).await
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
    let url = configured_origin(raw.trim())?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn oauth_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(timeout)
        .build()
        .map_err(|_| "无法初始化 USA-Zero 授权连接".to_string())
}

async fn read_response_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(RESPONSE_ERROR.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| RESPONSE_ERROR)? {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
            return Err(RESPONSE_ERROR.into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn authorization_url(origin: &str, request_id: &str) -> Result<String, String> {
    if request_id.is_empty() || request_id.len() > 1024 || request_id.chars().any(char::is_control)
    {
        return Err(RESPONSE_ERROR.into());
    }
    let mut url = Url::parse(&format!("{origin}/oauth/authorize")).map_err(|_| RESPONSE_ERROR)?;
    url.query_pairs_mut().append_pair("request_id", request_id);
    Ok(url.into())
}

#[cfg(test)]
fn validate_tokens(tokens: &OAuthTokens) -> Result<(), String> {
    let valid_token = |token: &str| {
        !token.is_empty()
            && token.len() <= 16 * 1024
            && token.bytes().all(|byte| (33..=126).contains(&byte))
    };
    if !valid_token(&tokens.access_token)
        || tokens
            .refresh_token
            .as_deref()
            .is_some_and(|token| !valid_token(token))
        || !tokens.token_type.eq_ignore_ascii_case("Bearer")
        || tokens.expires_in <= 0
        || !tokens
            .scope
            .split_ascii_whitespace()
            .any(|scope| scope == "profile:read")
    {
        return Err("USA-Zero 返回了无效令牌".into());
    }
    Ok(())
}

#[cfg(test)]
fn validate_user(user: &Value) -> Result<(), String> {
    if !user
        .get("id")
        .and_then(Value::as_u64)
        .is_some_and(|id| id > 0 && id <= 9_007_199_254_740_991)
        || user.get("status").and_then(Value::as_str) != Some("active")
    {
        return Err("USA-Zero 返回了无效账户资料".into());
    }
    Ok(())
}

fn random_opaque() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_origin_is_the_configured_https_root_only() {
        let expected = option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top");
        assert_eq!(
            normalize_origin(expected).unwrap(),
            expected.trim_end_matches('/')
        );
        for raw in [
            "http://usa0.top",
            "https://other.invalid",
            "https://usa0.top/api",
            "https://user@usa0.top",
            "https://usa0.top?x=1",
            "https://usa0.top/#fragment",
        ] {
            assert!(normalize_origin(raw).is_err());
        }
    }

    #[test]
    fn authorization_page_uses_fixed_route_and_encoded_request_id() {
        let origin = normalize_origin(
            option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top"),
        )
        .unwrap();
        let response: AuthorizationRequestResponse = serde_json::from_value(json!({
            "request_id":"request&redirect_uri=https://other.invalid/#x",
            "authorization_uri":"https://other.invalid/phishing",
        }))
        .unwrap();
        let url = Url::parse(&authorization_url(&origin, &response.request_id).unwrap()).unwrap();
        assert_eq!(url.origin(), Url::parse(&origin).unwrap().origin());
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(url.fragment(), None);
        assert_eq!(
            url.query_pairs().into_owned().collect::<Vec<_>>(),
            [("request_id".to_string(), response.request_id)]
        );
        for id in [String::new(), "x".repeat(1025), "request\r\n".into()] {
            assert_eq!(authorization_url(&origin, &id).unwrap_err(), RESPONSE_ERROR);
        }
    }

    #[test]
    fn tokens_and_current_user_must_be_valid_before_installing_a_session() {
        let valid = json!({"access_token":"opaque-access", "refresh_token":"opaque-refresh", "token_type":"Bearer", "expires_in":600, "scope":"profile:read offline_access"});
        validate_tokens(&serde_json::from_value::<OAuthTokens>(valid.clone()).unwrap()).unwrap();
        for (field, value) in [
            ("access_token", json!("")),
            ("access_token", json!("header\r\ninjection")),
            ("refresh_token", json!("")),
            ("token_type", json!("Basic")),
            ("expires_in", json!(0)),
            ("scope", json!("keys:read")),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(validate_tokens(&serde_json::from_value(invalid).unwrap()).is_err());
        }
        validate_user(&json!({"id":42,"status":"active"})).unwrap();
        for user in [
            Value::Null,
            json!({"id":0,"status":"active"}),
            json!({"id":42,"status":"disabled"}),
            json!({"id":9007199254740992u64,"status":"active"}),
            json!({"id":"42","status":"active"}),
        ] {
            assert!(validate_user(&user).is_err());
        }
    }

    async fn response_fixture(
        status: &str,
        headers: &str,
        body: Vec<u8>,
        content_length: bool,
        stall: bool,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let status = status.to_string();
        let headers = headers.to_string();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.ends_with(b"\r\n\r\n") {
                let size = socket.read(&mut buffer).await.unwrap();
                if size == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..size]);
            }
            let length = if content_length {
                format!("Content-Length: {}\r\n", body.len())
            } else {
                String::new()
            };
            let response =
                format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}{length}\r\n");
            if socket.write_all(response.as_bytes()).await.is_err() {
                return;
            }
            if stall {
                let _ = socket.write_all(&body[..body.len().min(1)]).await;
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            } else {
                let _ = socket.write_all(&body).await;
            }
        });
        (origin, task)
    }

    #[tokio::test]
    async fn oauth_http_transport_rejects_redirects() {
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let (origin, task) = response_fixture(
            "302 Found",
            &format!("Location: http://{}/leak\r\n", target.local_addr().unwrap()),
            vec![],
            true,
            false,
        )
        .await;
        let response = oauth_client(HTTP_TIMEOUT)
            .unwrap()
            .get(origin)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        task.await.unwrap();
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test]
    async fn oauth_response_limit_applies_with_and_without_content_length() {
        for framed in [true, false] {
            let (origin, task) = response_fixture(
                "200 OK",
                "",
                vec![b'x'; MAX_RESPONSE_BYTES + 1],
                framed,
                false,
            )
            .await;
            let response = oauth_client(HTTP_TIMEOUT)
                .unwrap()
                .get(origin)
                .send()
                .await
                .unwrap();
            assert_eq!(
                read_response_body(response).await.unwrap_err(),
                RESPONSE_ERROR
            );
            task.await.unwrap();
        }
        let (origin, task) =
            response_fixture("200 OK", "", b"{\"success\":true}".to_vec(), true, false).await;
        let response = oauth_client(HTTP_TIMEOUT)
            .unwrap()
            .get(origin)
            .send()
            .await
            .unwrap();
        assert_eq!(
            read_response_body(response).await.unwrap(),
            b"{\"success\":true}"
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn oauth_http_deadline_includes_the_response_body() {
        let (origin, task) = response_fixture("200 OK", "", vec![b'x'; 1000], true, true).await;
        let response = oauth_client(std::time::Duration::from_millis(250))
            .unwrap()
            .get(origin)
            .send()
            .await
            .unwrap();
        assert_eq!(
            read_response_body(response).await.unwrap_err(),
            RESPONSE_ERROR
        );
        task.await.unwrap();
    }
}
