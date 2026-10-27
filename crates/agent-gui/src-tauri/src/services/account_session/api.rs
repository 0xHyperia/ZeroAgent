use super::*;
use std::collections::HashSet;
use tauri::{Manager, State};

use crate::services::managed_model_broker::ManagedCredential;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountHttpRequest {
    pub session_handle: Option<String>,
    pub path: String,
    pub method: String,
    pub body: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountHttpResponse {
    pub status: u16,
    pub body: Value,
}

// Raw keys are crate-only and never implement Serialize or Debug.
pub(crate) struct AccountKey {
    pub id: u64,
    pub value: String,
    pub row: Value,
}

fn route_allowed(method: &str, path: &str, authenticated: bool) -> bool {
    if !authenticated {
        return matches!(
            (method, path),
            ("GET", "/api/v1/settings/public") | ("POST", "/api/v1/auth/send-verify-code")
        );
    }
    matches!(
        (method, path),
        (
            "GET",
            "/api/v1/app/me"
                | "/api/v1/auth/me"
                | "/api/v1/user/profile"
                | "/api/v1/app/usage"
                | "/api/v1/usage/dashboard/stats"
                | "/api/v1/app/groups"
                | "/api/v1/groups/available"
                | "/api/v1/app/subscriptions"
                | "/api/v1/subscriptions"
        ) | ("PATCH", "/api/v1/app/me")
            | ("PUT", "/api/v1/user")
    )
}

fn relative_url(origin: &Url, path: &str) -> Result<Url, String> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path.split('?').next().is_some_and(|path| {
            path.contains('%') || path.split('/').any(|p| p == "." || p == "..")
        })
    {
        return Err("Account endpoint is not allowed".into());
    }
    let url = origin
        .join(path)
        .map_err(|_| "Account endpoint is not allowed")?;
    if url.origin() != origin.origin() {
        return Err("Account endpoint is not allowed".into());
    }
    Ok(url)
}

async fn bounded_json(response: reqwest::Response) -> Result<AccountHttpResponse, String> {
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Ok(AccountHttpResponse {
            status,
            body: json!({"code":1,"success":false,"message":"USA-Zero request failed","error":{"message":"USA-Zero request failed"}}),
        });
    }
    Ok(AccountHttpResponse {
        status,
        body: response_json(response).await?,
    })
}

impl AccountSessionState {
    async fn raw_account_request(
        &self,
        handle: &str,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<AccountHttpResponse, String> {
        let url = relative_url(&self.origin, path)?;
        let method =
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid account method")?;
        let initial = self.access(handle, false).await?;
        let mut tokens = initial.clone();
        for attempt in 0..2 {
            self.require_current(handle).await?;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .bearer_auth(&tokens.access_token)
                .header("Accept", "application/json");
            if let Some(body) = body {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|_| TRANSPORT_ERROR)?;
            self.require_current(handle).await?;
            if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                let current = self.access(handle, false).await?;
                tokens = if current.access_token != tokens.access_token {
                    current
                } else {
                    self.access(handle, true).await?
                };
                continue;
            }
            if response.status() == StatusCode::UNAUTHORIZED {
                self.clear_if_current(handle).await?;
                return Err(AUTH_REQUIRED.into());
            }
            let response = bounded_json(response).await?;
            self.require_current(handle).await?;
            return Ok(response);
        }
        Err(AUTH_REQUIRED.into())
    }

    pub(crate) async fn raw_keys(&self, handle: &str) -> Result<Vec<AccountKey>, String> {
        let session = self.snapshot(handle).await?;
        let app = matches!(session.tokens.auth_kind, AuthKind::Oauth);
        let mut rows = Vec::new();
        let mut ids = HashSet::new();
        for page in 1..=100 {
            let path = format!(
                "/api/v1/{}?page={page}&page_size=100",
                if app { "app/keys" } else { "keys" }
            );
            let response = self.raw_account_request(handle, "GET", &path, None).await?;
            if response.status == 403 {
                return Err("USA_ZERO_ACCOUNT_SCOPE_REQUIRED".into());
            }
            if response.status != 200 {
                return Err(TRANSPORT_ERROR.into());
            }
            let success = if app {
                response.body.get("success").and_then(Value::as_bool) == Some(true)
            } else {
                response.body.get("code").and_then(Value::as_i64) == Some(0)
            };
            if !success {
                return Err(RESPONSE_ERROR.into());
            }
            let data = response.body.get("data").ok_or(RESPONSE_ERROR)?;
            let items = data
                .get("items")
                .and_then(Value::as_array)
                .ok_or(RESPONSE_ERROR)?;
            if items.len() > 100 {
                return Err(RESPONSE_ERROR.into());
            }
            for row in items {
                let id = row
                    .get("id")
                    .and_then(Value::as_u64)
                    .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
                    .ok_or(RESPONSE_ERROR)?;
                let value = row
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or(RESPONSE_ERROR)?;
                validate_token(value)?;
                if !ids.insert(id) {
                    return Err("USA-Zero key list changed; retry".into());
                }
                rows.push(AccountKey {
                    id,
                    value: value.into(),
                    row: row.clone(),
                });
            }
            let total = data
                .get("total")
                .and_then(Value::as_u64)
                .ok_or(RESPONSE_ERROR)?;
            if rows.len() as u64 >= total || items.len() < 100 {
                let mut core = self.core.lock().await;
                let session = core
                    .session
                    .as_mut()
                    .filter(|s| s.public.session_handle == handle)
                    .ok_or(SESSION_CHANGED)?;
                for key in &rows {
                    if !session.protected_keys.contains(&key.value) {
                        session.protected_keys.push(key.value.clone());
                    }
                }
                return Ok(rows);
            }
        }
        Err("USA-Zero key list exceeds the supported size".into())
    }

    pub(crate) async fn redact(&self, handle: &str, value: &mut Value) -> Result<(), String> {
        let session = self.snapshot(handle).await?;
        let mut secrets = session.protected_keys;
        secrets.push(session.tokens.access_token);
        if let Some(token) = session.tokens.refresh_token {
            secrets.push(token);
        }
        fn walk(value: &mut Value, secrets: &[String]) {
            match value {
                Value::String(text)
                    if secrets
                        .iter()
                        .any(|secret| !secret.is_empty() && text.contains(secret)) =>
                {
                    *text = "Protected value".into();
                }
                Value::Array(items) => {
                    for item in items {
                        walk(item, secrets);
                    }
                }
                Value::Object(map) => {
                    let mut clean = serde_json::Map::new();
                    for (key, mut value) in std::mem::take(map) {
                        let key = if secrets
                            .iter()
                            .any(|secret| !secret.is_empty() && key.contains(secret))
                        {
                            "protected".into()
                        } else {
                            key
                        };
                        walk(&mut value, secrets);
                        clean.insert(key, value);
                    }
                    *map = clean;
                }
                _ => {}
            }
        }
        walk(value, &secrets);
        self.require_current(handle).await
    }

    pub(crate) async fn public_summary(
        &self,
        handle: &str,
    ) -> Result<AccountSessionSummary, String> {
        let mut summary = self.verified_current(handle).await?;
        match self.raw_keys(handle).await {
            Ok(_) => {}
            Err(error) if error == "USA_ZERO_ACCOUNT_SCOPE_REQUIRED" => {
                self.clear_if_current(handle).await?;
                return Err(AUTH_REQUIRED.into());
            }
            Err(error) => return Err(error),
        }
        self.redact(handle, &mut summary.user).await?;
        Ok(summary)
    }

    pub(crate) async fn managed_credentials(
        &self,
        handle: &str,
        provider_ids: Vec<String>,
    ) -> Result<Vec<ManagedCredential>, String> {
        let keys = self.raw_keys(handle).await?;
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for provider in provider_ids {
            let id = provider
                .strip_prefix("relay-key-")
                .and_then(|id| id.parse::<u64>().ok())
                .filter(|id| *id > 0)
                .ok_or("Invalid managed key ID")?;
            if provider != format!("relay-key-{id}") || !seen.insert(id) {
                return Err("Invalid managed key ID".into());
            }
            let key = keys
                .iter()
                .find(|key| key.id == id)
                .ok_or("Managed key is not owned by the current account")?;
            if key.row.get("status").and_then(Value::as_str) != Some("active")
                || key.row.get("group_id").and_then(Value::as_u64).is_none()
            {
                return Err("Managed key is not active".into());
            }
            result.push(ManagedCredential {
                provider_id: provider,
                api_key: key.value.clone(),
            });
        }
        self.require_current(handle).await?;
        Ok(result)
    }

    pub(crate) async fn all_active_managed_credentials(
        &self,
        handle: &str,
    ) -> Result<Vec<ManagedCredential>, String> {
        let credentials = self
            .raw_keys(handle)
            .await?
            .into_iter()
            .filter(|key| {
                key.row.get("status").and_then(Value::as_str) == Some("active")
                    && key.row.get("group_id").and_then(Value::as_u64).is_some()
            })
            .map(|key| ManagedCredential {
                provider_id: format!("relay-key-{}", key.id),
                api_key: key.value,
            })
            .collect::<Vec<_>>();
        self.require_current(handle).await?;
        Ok(credentials)
    }

    pub async fn http(&self, request: AccountHttpRequest) -> Result<AccountHttpResponse, String> {
        let url = relative_url(&self.origin, &request.path)?;
        let method = request.method.to_ascii_uppercase();
        if request.body.as_ref().is_some_and(|body| {
            serde_json::to_vec(body).map_or(true, |bytes| bytes.len() > MAX_BODY)
        }) {
            return Err("Account request is too large".into());
        }
        let Some(handle) = request.session_handle.as_deref() else {
            if !route_allowed(&method, url.path(), false) {
                return Err("Account endpoint requires OAuth".into());
            }
            let mut outgoing = self.client.request(
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| RESPONSE_ERROR)?,
                url,
            );
            if let Some(body) = request.body {
                outgoing = outgoing.json(&body);
            }
            return bounded_json(outgoing.send().await.map_err(|_| TRANSPORT_ERROR)?).await;
        };
        if method == "GET" && matches!(url.path(), "/api/v1/app/keys" | "/api/v1/keys") {
            let keys = self.raw_keys(handle).await?;
            let mut items = Vec::new();
            for key in keys {
                items.push(masked_key(&key.row)?);
            }
            let data = json!({"total":items.len(),"items":items});
            let app = matches!(
                self.snapshot(handle).await?.tokens.auth_kind,
                AuthKind::Oauth
            );
            let mut body = if app {
                json!({"success":true,"data":data})
            } else {
                json!({"code":0,"data":data})
            };
            self.redact(handle, &mut body).await?;
            return Ok(AccountHttpResponse { status: 200, body });
        }
        let group = url
            .path()
            .strip_prefix("/api/v1/app/groups/")
            .and_then(|suffix| suffix.strip_suffix("/keys"))
            .and_then(|id| id.parse::<u64>().ok())
            .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991);
        if method == "POST" && (group.is_some() || url.path() == "/api/v1/keys") {
            let input = request
                .body
                .as_ref()
                .and_then(Value::as_object)
                .ok_or("Invalid key creation request")?;
            let name = input
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty() && name.len() <= 100)
                .ok_or("Invalid key name")?;
            let id = group
                .or_else(|| input.get("group_id").and_then(Value::as_u64))
                .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
                .ok_or("Invalid group ID")?;
            if input
                .keys()
                .any(|key| key != "name" && (group.is_some() || key != "group_id"))
            {
                return Err("Invalid key creation request".into());
            }
            let app = matches!(
                self.snapshot(handle).await?.tokens.auth_kind,
                AuthKind::Oauth
            );
            let (path, body) = if app {
                (
                    format!("/api/v1/app/groups/{id}/keys"),
                    json!({"name":name.trim()}),
                )
            } else {
                (
                    "/api/v1/keys".into(),
                    json!({"name":name.trim(),"group_id":id}),
                )
            };
            let mut response = self
                .raw_account_request(handle, "POST", &path, Some(&body))
                .await?;
            if (200..300).contains(&response.status) {
                let data = response.body.get("data").ok_or(RESPONSE_ERROR)?;
                let secret = data
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or(RESPONSE_ERROR)?;
                validate_token(secret)?;
                {
                    let mut core = self.core.lock().await;
                    let session = core
                        .session
                        .as_mut()
                        .filter(|s| s.public.session_handle == handle)
                        .ok_or(SESSION_CHANGED)?;
                    session.protected_keys.push(secret.into());
                }
                response.body["data"] = masked_key(data)?;
                self.redact(handle, &mut response.body).await?;
            }
            return Ok(response);
        }
        let legacy_security = matches!(
            self.snapshot(handle).await?.tokens.auth_kind,
            AuthKind::Password
        ) && matches!(
            (method.as_str(), url.path()),
            (
                "POST",
                "/api/v1/user/account-bindings/email/send-code"
                    | "/api/v1/user/account-bindings/email"
            ) | ("PUT", "/api/v1/user/password")
        );
        if !legacy_security && !route_allowed(&method, url.path(), true) {
            return Err(
                "Account endpoint is not allowed; manage account security on USA-Zero".into(),
            );
        }
        if method == "GET"
            && matches!(
                url.path(),
                "/api/v1/app/me" | "/api/v1/auth/me" | "/api/v1/user/profile"
            )
        {
            let summary = self.public_summary(handle).await?;
            let app = summary.auth_kind == "oauth";
            return Ok(AccountHttpResponse {
                status: 200,
                body: if app {
                    json!({"success":true,"data":summary.user})
                } else {
                    json!({"code":0,"data":summary.user})
                },
            });
        }
        self.raw_keys(handle).await?;
        let mut response = self
            .raw_account_request(handle, &method, &request.path, request.body.as_ref())
            .await?;
        self.redact(handle, &mut response.body).await?;
        Ok(response)
    }

    pub(crate) async fn reveal_key(
        &self,
        handle: &str,
        id: u64,
        password: &str,
    ) -> Result<String, String> {
        if id == 0 || password.is_empty() || password.len() > 4096 {
            return Err("Password verification is required".into());
        }
        let public = self.verified_current(handle).await?;
        let email = public
            .user
            .get("email")
            .and_then(Value::as_str)
            .filter(|email| !email.is_empty())
            .ok_or("Bind an email and password on USA-Zero first")?;
        let keys = self.raw_keys(handle).await?;
        if !keys.iter().any(|key| key.id == id) {
            return Err("Key is not owned by the current account".into());
        }
        let response = self
            .client
            .post(
                self.origin
                    .join("api/v1/auth/login")
                    .map_err(|_| RESPONSE_ERROR)?,
            )
            .json(&json!({"email":email,"password":password}))
            .send()
            .await
            .map_err(|_| TRANSPORT_ERROR)?;
        if !response.status().is_success() {
            return Err("USA-Zero password verification failed".into());
        }
        let response = response_json(response).await?;
        let data = response
            .get("data")
            .filter(|_| response.get("code").and_then(Value::as_i64) == Some(0))
            .ok_or("USA-Zero password verification failed")?;
        let cleanup = cleanup_tokens(data, AuthKind::Password);
        let result: Result<String, String> = async {
            self.require_current(handle).await?;
            {
                let mut core = self.core.lock().await;
                let session = core
                    .session
                    .as_mut()
                    .filter(|session| session.public.session_handle == handle)
                    .ok_or(SESSION_CHANGED)?;
                for field in ["access_token", "refresh_token", "temp_token"] {
                    if let Some(token) = data
                        .get(field)
                        .and_then(Value::as_str)
                        .filter(|token| validate_token(token).is_ok())
                    {
                        if !session.protected_keys.iter().any(|known| known == token) {
                            session.protected_keys.push(token.into());
                        }
                    }
                }
            }
            let full = data
                .get("access_token")
                .and_then(Value::as_str)
                .is_some_and(|token| !token.is_empty())
                && data.get("user").and_then(|user| user.get("id")) == public.user.get("id");
            let challenge = data.get("requires_2fa").and_then(Value::as_bool) == Some(true)
                && data
                    .get("temp_token")
                    .and_then(Value::as_str)
                    .is_some_and(|token| !token.is_empty());
            if !full && !challenge {
                return Err("USA-Zero password verification failed".into());
            }
            let current = self.verified_current(handle).await?;
            if current.user.get("id") != public.user.get("id") {
                return Err(SESSION_CHANGED.into());
            }
            let keys = self.raw_keys(handle).await?;
            let key = keys
                .into_iter()
                .find(|key| key.id == id)
                .ok_or("Key is no longer available")?;
            self.require_current(handle).await?;
            Ok(key.value)
        }
        .await;
        if let Some(tokens) = cleanup {
            self.revoke_tokens(&tokens).await;
        }
        match result {
            Ok(key) => {
                self.require_current(handle).await?;
                Ok(key)
            }
            Err(error) => Err(error),
        }
    }
}

fn masked_key(row: &Value) -> Result<Value, String> {
    let object = row.as_object().ok_or(RESPONSE_ERROR)?;
    let mut result = serde_json::Map::new();
    for field in [
        "id",
        "name",
        "group_id",
        "status",
        "quota",
        "quota_used",
        "created_at",
        "group",
    ] {
        if let Some(value) = object.get(field) {
            result.insert(field.into(), value.clone());
        }
    }
    result.insert("key".into(), Value::String("••••••••".into()));
    result.insert("key_masked".into(), Value::Bool(true));
    Ok(Value::Object(result))
}

#[tauri::command]
pub async fn account_session_bootstrap(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
) -> Result<Option<AccountSessionSummary>, String> {
    match state.bootstrap().await? {
        Some(public) => {
            guard_viewer(&app, state.inner(), &public.session_handle).await?;
            state.public_summary(&public.session_handle).await.map(Some)
        }
        None => Ok(None),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyAccountSession {
    access_token: String,
    refresh_token: Option<String>,
    expires_at_ms: u64,
    auth_kind: AuthKind,
}

#[tauri::command]
pub async fn account_session_import_legacy(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    legacy: LegacyAccountSession,
) -> Result<AccountSessionSummary, String> {
    if state.core.lock().await.session.is_some() {
        return Err("A native account session is already active".into());
    }
    let ticket = state.begin_authorization().await;
    let mut tokens = StoredTokens {
        access_token: legacy.access_token,
        refresh_token: legacy.refresh_token,
        expires_at_ms: legacy.expires_at_ms,
        auth_kind: legacy.auth_kind,
    };
    if tokens.access_token.is_empty() {
        tokens = state.refresh_tokens(&tokens).await?;
    }
    let public = state.install(ticket, tokens).await?;
    guard_viewer(&app, state.inner(), &public.session_handle).await?;
    state.public_summary(&public.session_handle).await
}

#[tauri::command]
pub async fn account_session_current(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    session_handle: String,
    force_refresh: Option<bool>,
) -> Result<AccountSessionSummary, String> {
    guard_viewer(&app, state.inner(), &session_handle).await?;
    state
        .access(&session_handle, force_refresh.unwrap_or(false))
        .await?;
    state.public_summary(&session_handle).await
}

#[tauri::command]
pub async fn account_session_http(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    request: AccountHttpRequest,
) -> Result<AccountHttpResponse, String> {
    if let Some(handle) = request.session_handle.as_deref() {
        guard_viewer(&app, state.inner(), handle).await?;
    }
    state.http(request).await
}

#[tauri::command]
pub async fn account_session_logout(
    state: State<'_, Arc<AccountSessionState>>,
    session_handle: String,
) -> Result<(), String> {
    state.logout(&session_handle).await
}

#[tauri::command]
pub async fn account_session_reveal_key(
    app: tauri::AppHandle,
    state: State<'_, Arc<AccountSessionState>>,
    session_handle: String,
    key_id: u64,
    password: String,
) -> Result<String, String> {
    guard_viewer(&app, state.inner(), &session_handle).await?;
    state.reveal_key(&session_handle, key_id, &password).await
}

pub(crate) async fn guard_viewer(
    app: &tauri::AppHandle,
    state: &AccountSessionState,
    handle: &str,
) -> Result<(), String> {
    let core = state.core.lock().await;
    if !core
        .session
        .as_ref()
        .is_some_and(|session| session.public.session_handle == handle)
    {
        return Err(SESSION_CHANGED.into());
    }
    app.state::<Arc<crate::services::kbrain_backend::KBrainBackendState>>()
        .guard_account_viewer(app, handle)
}
