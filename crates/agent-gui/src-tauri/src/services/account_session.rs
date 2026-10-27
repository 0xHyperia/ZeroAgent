//! Native OAuth ownership. Public summaries never contain bearer/refresh credentials.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex};
use url::Url;

use super::managed_model_broker::configured_origin;

const AUTH_REQUIRED: &str = "USA_ZERO_PROFILE_AUTH_REQUIRED";
const TRANSPORT_ERROR: &str = "USA-Zero account service is unavailable";
const RESPONSE_ERROR: &str = "Invalid USA-Zero account response";
const SESSION_CHANGED: &str = "USA-Zero account session changed";
const MAX_BODY: usize = 1024 * 1024;
const REFRESH_SKEW_MS: u64 = 60_000;
const CLIENT_ID: &str = "zeroagent-desktop";

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AuthKind {
    Oauth,
    Password,
}

// No Debug and no public serialization API: only the platform vault receives these fields.
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct StoredTokens {
    pub(crate) access_token: String,
    pub(crate) refresh_token: Option<String>,
    pub(crate) expires_at_ms: u64,
    pub(crate) auth_kind: AuthKind,
}

#[derive(Deserialize, Serialize)]
struct StoredSession {
    version: u8,
    origin: String,
    user_id: u64,
    tokens: StoredTokens,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSessionSummary {
    pub session_handle: String,
    pub user: Value,
    pub expires_at_ms: u64,
    pub auth_kind: &'static str,
    pub account_scope: String,
}

#[derive(Clone)]
struct Session {
    public: AccountSessionSummary,
    tokens: StoredTokens,
    // A rotated credential must survive transient verification/vault failures in memory.
    // It is never usable by a consumer until identity verification and persistence succeed.
    pending_refresh: Option<StoredTokens>,
    protected_keys: Vec<String>,
}

#[derive(Clone)]
struct PendingRestore {
    user_id: u64,
    tokens: StoredTokens,
}

struct Core {
    authorization_epoch: u64,
    initialized: bool,
    session: Option<Session>,
    failed_logout: Option<Session>,
    pending_restore: Option<PendingRestore>,
    profile_liveness: Arc<AtomicBool>,
}

impl Default for Core {
    fn default() -> Self {
        Self {
            authorization_epoch: 0,
            initialized: false,
            session: None,
            failed_logout: None,
            pending_restore: None,
            profile_liveness: Arc::new(AtomicBool::new(true)),
        }
    }
}

#[derive(Clone)]
pub(crate) struct SessionEnded {
    pub handle: String,
    pub persistent_cleared: bool,
}

trait SessionStore: Send + Sync {
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, value: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

struct PlatformStore {
    account: String,
}
impl PlatformStore {
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new("ZeroAgent OAuth account session", &self.account)
            .map_err(|_| "Unable to open the platform account vault".into())
    }
}
impl SessionStore for PlatformStore {
    fn load(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Unable to read the platform account vault".into()),
        }
    }
    fn save(&self, value: &str) -> Result<(), String> {
        self.entry()?
            .set_password(value)
            .map_err(|_| "Unable to save the platform account vault".into())
    }
    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Unable to clear the platform account vault".into()),
        }
    }
}

pub struct AccountSessionState {
    origin: Url,
    client: Client,
    core: Mutex<Core>,
    refresh: Mutex<()>,
    exchange: Mutex<()>,
    ended: broadcast::Sender<SessionEnded>,
    store: Arc<dyn SessionStore>,
}

impl AccountSessionState {
    /// Fixed by the Native constructor, never supplied by the renderer.
    pub(crate) fn trusted_origin(&self) -> &Url {
        &self.origin
    }

    pub fn new() -> Result<Self, String> {
        let origin = configured_origin(
            option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top"),
        )?;
        let store = Arc::new(PlatformStore {
            account: vault_account(&origin)?,
        });
        Self::with_store(origin, store)
    }

    fn with_store(origin: Url, store: Arc<dyn SessionStore>) -> Result<Self, String> {
        Ok(Self {
            origin,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| TRANSPORT_ERROR)?,
            core: Mutex::new(Core::default()),
            refresh: Mutex::new(()),
            exchange: Mutex::new(()),
            ended: broadcast::channel(16).0,
            store,
        })
    }

    /// Starting a later authorization invalidates an earlier authorization response, while
    /// leaving a currently authenticated account usable until a replacement is verified.
    pub(crate) async fn begin_authorization(&self) -> u64 {
        let mut core = self.core.lock().await;
        core.authorization_epoch = core.authorization_epoch.wrapping_add(1);
        let ticket = core.authorization_epoch;
        let obsolete = core.pending_restore.take();
        drop(core);
        if let Some(obsolete) = obsolete {
            self.revoke_tokens(&obsolete.tokens).await;
        }
        ticket
    }

    /// Serialize code exchanges, not the user's browser interaction. Otherwise a late
    /// exchange for an obsolete request can replace the server's new installation session.
    pub(crate) async fn authorization_exchange(
        &self,
        ticket: u64,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        let guard = self.exchange.lock().await;
        if self.core.lock().await.authorization_epoch != ticket {
            return Err(SESSION_CHANGED.into());
        }
        Ok(guard)
    }

    pub(crate) async fn profile_liveness(
        &self,
        expected: Option<&str>,
    ) -> Result<Arc<AtomicBool>, String> {
        let core = self.core.lock().await;
        if core.failed_logout.is_some()
            || core.pending_restore.is_some()
            || core
                .session
                .as_ref()
                .map(|session| session.public.session_handle.as_str())
                != expected
        {
            return Err(SESSION_CHANGED.into());
        }
        Ok(core.profile_liveness.clone())
    }

    // Called by synchronous native config operations. A concurrent vault commit must fail
    // closed rather than block a runtime thread or inspect another session's credentials.
    pub(crate) fn verify_portable_value(
        &self,
        expected_handle: Option<&str>,
        value: &Value,
    ) -> Result<(), String> {
        let (secrets, live, protected_count) = {
            let core = self
                .core
                .try_lock()
                .map_err(|_| "账号状态正在变更，请稍后重试配置操作".to_string())?;
            if core.failed_logout.is_some() || !core.profile_liveness.load(Ordering::SeqCst) {
                return Err(SESSION_CHANGED.into());
            }
            let session = match (expected_handle, core.session.as_ref()) {
                (None, None) if core.initialized => None,
                (Some(handle), Some(session)) if session.public.session_handle == handle => {
                    Some(session)
                }
                _ => return Err(SESSION_CHANGED.into()),
            };
            let mut secrets = Vec::new();
            let mut count = 0;
            if let Some(session) = session {
                count = session.protected_keys.len();
                secrets.extend(session.protected_keys.iter().cloned());
                secrets.push(session.tokens.access_token.clone());
                if let Some(refresh) = &session.tokens.refresh_token {
                    secrets.push(refresh.clone());
                }
            }
            (secrets, core.profile_liveness.clone(), count)
        };
        // Scan outside the session mutex so even a large config cannot delay logout.
        fn contains(value: &Value, secrets: &[String]) -> bool {
            let protected = |text: &str| {
                secrets
                    .iter()
                    .any(|secret| !secret.is_empty() && text.contains(secret))
            };
            match value {
                Value::String(text) => protected(text),
                Value::Array(items) => items.iter().any(|item| contains(item, secrets)),
                Value::Object(items) => items
                    .iter()
                    .any(|(key, value)| protected(key) || contains(value, secrets)),
                _ => false,
            }
        }
        if contains(value, &secrets) {
            return Err("配置包含受保护的 USA-Zero 凭据，请移除该引用后重试".into());
        }
        if !live.load(Ordering::SeqCst) {
            return Err(SESSION_CHANGED.into());
        }
        let core = self
            .core
            .try_lock()
            .map_err(|_| "账号状态正在变更，请稍后重试配置操作".to_string())?;
        if core.failed_logout.is_some()
            || !Arc::ptr_eq(&core.profile_liveness, &live)
            || core
                .session
                .as_ref()
                .map(|s| s.public.session_handle.as_str())
                != expected_handle
        {
            return Err(SESSION_CHANGED.into());
        }
        if core.session.as_ref().map_or(0, |s| s.protected_keys.len()) != protected_count {
            return Err("账号凭据在操作期间变化，请重试配置操作".into());
        }
        Ok(())
    }

    pub(crate) fn subscribe_ended(&self) -> broadcast::Receiver<SessionEnded> {
        self.ended.subscribe()
    }

    pub(crate) async fn exchange_authorization_code(
        &self,
        ticket: u64,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<AccountSessionSummary, String> {
        let redirect = Url::parse(redirect_uri).map_err(|_| RESPONSE_ERROR)?;
        if code.is_empty()
            || code.len() > 4096
            || code.chars().any(char::is_control)
            || !(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
            || redirect.scheme() != "http"
            || redirect.host_str() != Some("127.0.0.1")
            || redirect.port().is_none_or(|port| port == 0)
            || redirect.path() != "/oauth/callback"
            || !redirect.username().is_empty()
            || redirect.password().is_some()
            || redirect.query().is_some()
            || redirect.fragment().is_some()
        {
            return Err(RESPONSE_ERROR.into());
        }
        let _exchange = self.authorization_exchange(ticket).await?;
        let response = self
            .client
            .post(
                self.origin
                    .join("api/v1/app-auth/token")
                    .map_err(|_| RESPONSE_ERROR)?,
            )
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", CLIENT_ID),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("code_verifier", verifier),
            ])
            .send()
            .await
            .map_err(|_| TRANSPORT_ERROR)?;
        if !response.status().is_success() {
            return Err("USA-Zero authorization code exchange failed".into());
        }
        let value = response_json(response).await?;
        let tokens = match parse_tokens(&value, AuthKind::Oauth, None) {
            Ok(tokens) => tokens,
            Err(error) => {
                if let Some(tokens) = cleanup_tokens(&value, AuthKind::Oauth) {
                    self.revoke_tokens(&tokens).await;
                }
                return Err(error);
            }
        };
        let result = self.install(ticket, tokens.clone()).await;
        if result.is_err() {
            self.revoke_tokens(&tokens).await;
        }
        result
    }

    pub(crate) async fn install(
        &self,
        ticket: u64,
        tokens: StoredTokens,
    ) -> Result<AccountSessionSummary, String> {
        self.install_for_user(ticket, tokens, None).await
    }

    async fn install_for_user(
        &self,
        ticket: u64,
        tokens: StoredTokens,
        expected_user: Option<u64>,
    ) -> Result<AccountSessionSummary, String> {
        validate_token(&tokens.access_token)?;
        if let Some(refresh) = &tokens.refresh_token {
            validate_token(refresh)?;
        }
        let user = self.current_user(&tokens).await?;
        if expected_user
            .is_some_and(|expected| user.get("id").and_then(Value::as_u64) != Some(expected))
        {
            return Err("Stored USA-Zero session account mismatch".into());
        }
        let public = self.summary(&tokens, user)?;
        let encoded = serde_json::to_string(&StoredSession {
            version: 1,
            origin: self.origin.origin().ascii_serialization(),
            user_id: public.user["id"].as_u64().ok_or(RESPONSE_ERROR)?,
            tokens: tokens.clone(),
        })
        .map_err(|_| RESPONSE_ERROR)?;
        // Logout must not wait for the HTTP verification above. Only the short vault commit
        // shares this lock, so no old response can save credentials after logout or switch.
        let mut core = self.core.lock().await;
        if core.authorization_epoch != ticket {
            drop(core);
            self.revoke_tokens(&tokens).await;
            return Err(SESSION_CHANGED.into());
        }
        save_to_vault(self.store.clone(), encoded).await?;
        core.initialized = true;
        core.failed_logout = None;
        core.profile_liveness.store(false, Ordering::SeqCst);
        core.profile_liveness = Arc::new(AtomicBool::new(true));
        let old = core.session.replace(Session {
            public: public.clone(),
            tokens: tokens.clone(),
            pending_refresh: None,
            protected_keys: Vec::new(),
        });
        let restored = core.pending_restore.take();
        if let Some(old) = old.as_ref() {
            let _ = self.ended.send(SessionEnded {
                handle: old.public.session_handle.clone(),
                persistent_cleared: true,
            });
        }
        drop(core);
        if let Some(old) = old {
            self.revoke_session_tokens(&old, Some(&tokens)).await;
        }
        if let Some(restored) = restored {
            if !same_credentials(&restored.tokens, &tokens) {
                self.revoke_tokens(&restored.tokens).await;
            }
        }
        self.require_current(&public.session_handle).await?;
        Ok(public)
    }

    pub async fn bootstrap(&self) -> Result<Option<AccountSessionSummary>, String> {
        let current = {
            let core = self.core.lock().await;
            if core.failed_logout.is_some() {
                return Err(
                    "Unable to persist account logout; retry after unlocking the system vault"
                        .into(),
                );
            }
            (core.session.clone(), core.initialized)
        };
        if let Some(session) = current.0 {
            return self
                .verified_current(&session.public.session_handle)
                .await
                .map(Some);
        }
        if current.1 {
            return Ok(None);
        }
        let _refresh = self.refresh.lock().await;
        let current = {
            let core = self.core.lock().await;
            if core.failed_logout.is_some() {
                return Err(
                    "Unable to persist account logout; retry after unlocking the system vault"
                        .into(),
                );
            }
            (core.session.clone(), core.initialized)
        };
        if let Some(session) = current.0 {
            drop(_refresh);
            return self
                .verified_current(&session.public.session_handle)
                .await
                .map(Some);
        }
        if current.1 {
            return Ok(None);
        }
        let pending = {
            let core = self.core.lock().await;
            core.pending_restore
                .clone()
                .map(|pending| (core.authorization_epoch, pending))
        };
        let (ticket, user_id, previous, already_rotated) = if let Some((ticket, pending)) = pending
        {
            (ticket, pending.user_id, pending.tokens, true)
        } else {
            let ticket = self.begin_authorization().await;
            let store = self.store.clone();
            let raw = tokio::task::spawn_blocking(move || store.load())
                .await
                .map_err(|_| "Platform account vault task failed")??;
            let Some(raw) = raw else {
                let mut core = self.core.lock().await;
                if core.authorization_epoch != ticket {
                    return Err(SESSION_CHANGED.into());
                }
                core.initialized = true;
                return Ok(None);
            };
            let record: StoredSession =
                serde_json::from_str(&raw).map_err(|_| "Invalid stored account session")?;
            if record.version != 1 || record.origin != self.origin.origin().ascii_serialization() {
                return Err("Stored account session origin or version mismatch".into());
            }
            (ticket, record.user_id, record.tokens, false)
        };
        let refreshed = token_needs_refresh(&previous);
        let tokens = if refreshed {
            match self.refresh_tokens(&previous).await {
                Ok(tokens) => tokens,
                Err(error) if error == AUTH_REQUIRED => {
                    self.clear_restore(ticket).await?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        } else {
            previous
        };
        if refreshed || already_rotated {
            let mut core = self.core.lock().await;
            if core.authorization_epoch != ticket || core.session.is_some() {
                drop(core);
                self.revoke_tokens(&tokens).await;
                return Err(SESSION_CHANGED.into());
            }
            core.pending_restore = Some(PendingRestore {
                user_id,
                tokens: tokens.clone(),
            });
        }
        match self.install_for_user(ticket, tokens, Some(user_id)).await {
            Ok(public) => Ok(Some(public)),
            Err(error)
                if error == AUTH_REQUIRED
                    || error == "Stored USA-Zero session account mismatch" =>
            {
                self.clear_restore(ticket).await?;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    async fn clear_restore(&self, ticket: u64) -> Result<(), String> {
        let mut core = self.core.lock().await;
        if core.authorization_epoch != ticket || core.session.is_some() {
            return Err(SESSION_CHANGED.into());
        }
        // Retain the pending candidate on a failed clear, so retry never reloads an
        // already-consumed refresh credential and a new login can still revoke it.
        clear_vault(self.store.clone()).await?;
        let pending = core.pending_restore.take();
        core.initialized = true;
        core.authorization_epoch = core.authorization_epoch.wrapping_add(1);
        drop(core);
        if let Some(pending) = pending {
            self.revoke_tokens(&pending.tokens).await;
        }
        Ok(())
    }

    async fn snapshot(&self, handle: &str) -> Result<Session, String> {
        self.core
            .lock()
            .await
            .session
            .as_ref()
            .filter(|session| session.public.session_handle == handle)
            .cloned()
            .ok_or_else(|| SESSION_CHANGED.into())
    }

    pub(crate) async fn require_current(&self, handle: &str) -> Result<(), String> {
        self.snapshot(handle).await.map(|_| ())
    }

    pub(crate) async fn active_handle(&self) -> Option<String> {
        self.core
            .lock()
            .await
            .session
            .as_ref()
            .map(|session| session.public.session_handle.clone())
    }

    /// Raw access is crate-only. No Tauri command returns this result to the renderer.
    pub(crate) async fn access(
        &self,
        handle: &str,
        force_refresh: bool,
    ) -> Result<StoredTokens, String> {
        let snapshot = self.snapshot(handle).await?;
        if snapshot.pending_refresh.is_none()
            && !force_refresh
            && !token_needs_refresh(&snapshot.tokens)
        {
            return Ok(snapshot.tokens);
        }
        let _refresh = self.refresh.lock().await;
        let current = self.snapshot(handle).await?;
        // Another waiting consumer may have already completed this refresh.
        if current.pending_refresh.is_none()
            && (snapshot.pending_refresh.is_some()
                || !same_credentials(&current.tokens, &snapshot.tokens)
                || current.tokens.expires_at_ms != snapshot.tokens.expires_at_ms
                || (!force_refresh && !token_needs_refresh(&current.tokens)))
        {
            return Ok(current.tokens);
        }
        let previous = current.pending_refresh.as_ref().unwrap_or(&current.tokens);
        let tokens = if current.pending_refresh.is_some() && !token_needs_refresh(previous) {
            previous.clone()
        } else {
            match self.refresh_tokens(previous).await {
                Ok(tokens) => tokens,
                Err(error) if error == AUTH_REQUIRED => {
                    self.clear_if_current(handle).await?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        };
        {
            let mut core = self.core.lock().await;
            let Some(session) = core
                .session
                .as_mut()
                .filter(|session| session.public.session_handle == handle)
            else {
                drop(core);
                self.revoke_tokens(&tokens).await;
                return Err(SESSION_CHANGED.into());
            };
            // Stage before another HTTP request: a temporary /me failure must not lose
            // the new refresh credential after its predecessor has been consumed.
            for token in [
                Some(current.tokens.access_token.as_str()),
                current.tokens.refresh_token.as_deref(),
                Some(previous.access_token.as_str()),
                previous.refresh_token.as_deref(),
                Some(tokens.access_token.as_str()),
                tokens.refresh_token.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                if !session.protected_keys.iter().any(|known| known == token) {
                    session.protected_keys.push(token.to_string());
                }
            }
            session.pending_refresh = Some(tokens.clone());
        }
        let user = match self.current_user(&tokens).await {
            Ok(user) => user,
            Err(error) if error == AUTH_REQUIRED => {
                self.clear_if_current(handle).await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        if user.get("id") != current.public.user.get("id") {
            self.clear_if_current(handle).await?;
            return Err("USA-Zero refreshed session account mismatch".into());
        }
        let encoded = serde_json::to_string(&StoredSession {
            version: 1,
            origin: self.origin.origin().ascii_serialization(),
            user_id: current.public.user["id"].as_u64().ok_or(RESPONSE_ERROR)?,
            tokens: tokens.clone(),
        })
        .map_err(|_| RESPONSE_ERROR)?;
        let mut core = self.core.lock().await;
        let Some(session) = core
            .session
            .as_mut()
            .filter(|session| session.public.session_handle == handle)
        else {
            drop(core);
            self.revoke_tokens(&tokens).await;
            return Err(SESSION_CHANGED.into());
        };
        save_to_vault(self.store.clone(), encoded).await?;
        session.tokens = tokens.clone();
        session.pending_refresh = None;
        session.public.user = user;
        session.public.expires_at_ms = tokens.expires_at_ms;
        Ok(tokens)
    }

    pub async fn verified_current(&self, handle: &str) -> Result<AccountSessionSummary, String> {
        let tokens = self.access(handle, false).await?;
        let user = match self.current_user(&tokens).await {
            Ok(user) => user,
            Err(error) if error == AUTH_REQUIRED => {
                self.clear_if_current(handle).await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let mut core = self.core.lock().await;
        let session = core
            .session
            .as_mut()
            .filter(|session| session.public.session_handle == handle)
            .ok_or(SESSION_CHANGED)?;
        let id = user
            .get("id")
            .and_then(Value::as_u64)
            .ok_or(RESPONSE_ERROR)?;
        if session.public.user.get("id").and_then(Value::as_u64) != Some(id) {
            return Err("USA-Zero session account mismatch".into());
        }
        session.public.user = user;
        Ok(session.public.clone())
    }

    /// An old renderer's logout/rejected request may not revoke or erase the current account.
    pub async fn clear_if_current(&self, handle: &str) -> Result<bool, String> {
        self.clear_owner(handle).await
    }

    async fn clear_owner(&self, handle: &str) -> Result<bool, String> {
        let mut core = self.core.lock().await;
        let owner = core
            .session
            .as_ref()
            .filter(|session| session.public.session_handle == handle)
            .or_else(|| {
                if core.session.is_none() {
                    core.failed_logout
                        .as_ref()
                        .filter(|session| session.public.session_handle == handle)
                } else {
                    None
                }
            })
            .cloned();
        let Some(owner) = owner else {
            return Ok(false);
        };
        core.authorization_epoch = core.authorization_epoch.wrapping_add(1);
        core.initialized = true;
        core.session = None;
        core.profile_liveness.store(false, Ordering::SeqCst);
        let _ = self.ended.send(SessionEnded {
            handle: handle.to_string(),
            persistent_cleared: false,
        });
        let result = clear_vault(self.store.clone()).await;
        core.failed_logout = if result.is_err() {
            Some(owner.clone())
        } else {
            None
        };
        if result.is_ok() {
            core.profile_liveness = Arc::new(AtomicBool::new(true));
        }
        drop(core);
        // Capture the owner inside the clear boundary, rather than before it: a
        // concurrent refresh may have staged/committed newer credentials meanwhile.
        self.revoke_session_tokens(&owner, None).await;
        if result.is_ok() {
            let _ = self.ended.send(SessionEnded {
                handle: handle.to_string(),
                persistent_cleared: true,
            });
        }
        result?;
        Ok(true)
    }

    pub async fn logout(&self, handle: &str) -> Result<(), String> {
        if self.clear_owner(handle).await? {
            Ok(())
        } else {
            Err(SESSION_CHANGED.into())
        }
    }

    async fn revoke_session_tokens(&self, session: &Session, preserve: Option<&StoredTokens>) {
        let revoke = |tokens: &StoredTokens| {
            preserve.is_none_or(|current| !same_credentials(current, tokens))
        };
        let committed = async {
            if revoke(&session.tokens) {
                self.revoke_tokens(&session.tokens).await;
            }
        };
        let pending = async {
            if let Some(tokens) = &session.pending_refresh {
                if !same_credentials(tokens, &session.tokens) && revoke(tokens) {
                    self.revoke_tokens(tokens).await;
                }
            }
        };
        tokio::join!(committed, pending);
    }

    async fn revoke_tokens(&self, tokens: &StoredTokens) {
        match tokens.auth_kind {
            AuthKind::Oauth => {
                let Ok(url) = self.origin.join("api/v1/app-auth/revoke") else {
                    return;
                };
                let access = self
                    .client
                    .post(url.clone())
                    .form(&[
                        ("token", tokens.access_token.as_str()),
                        ("token_type_hint", "access_token"),
                        ("client_id", CLIENT_ID),
                    ])
                    .send();
                let refresh = async {
                    if let Some(token) = tokens.refresh_token.as_deref() {
                        let _ = self
                            .client
                            .post(url)
                            .form(&[
                                ("token", token),
                                ("token_type_hint", "refresh_token"),
                                ("client_id", CLIENT_ID),
                            ])
                            .send()
                            .await;
                    }
                };
                // A consumed refresh token may no longer be found by /revoke. The access
                // token still identifies its session family; late refreshes are revoked too.
                let _ = tokio::join!(access, refresh);
            }
            AuthKind::Password => {
                if let (Ok(url), Some(token)) = (
                    self.origin.join("api/v1/auth/logout"),
                    tokens.refresh_token.as_deref(),
                ) {
                    let _ = self
                        .client
                        .post(url)
                        .json(&json!({"refresh_token":token}))
                        .send()
                        .await;
                }
            }
        }
    }

    async fn current_user(&self, tokens: &StoredTokens) -> Result<Value, String> {
        let path = match tokens.auth_kind {
            AuthKind::Oauth => "api/v1/app/me",
            AuthKind::Password => "api/v1/auth/me",
        };
        let response = self
            .client
            .get(self.origin.join(path).map_err(|_| RESPONSE_ERROR)?)
            .bearer_auth(&tokens.access_token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| TRANSPORT_ERROR)?;
        let value = response_json(response).await?;
        let success = match tokens.auth_kind {
            AuthKind::Oauth => value.get("success").and_then(Value::as_bool) == Some(true),
            AuthKind::Password => value.get("code").and_then(Value::as_i64) == Some(0),
        };
        let user = value.get("data").ok_or(RESPONSE_ERROR)?;
        if !success
            || user.get("status").and_then(Value::as_str) != Some("active")
            || !user
                .get("id")
                .and_then(Value::as_u64)
                .is_some_and(|id| id > 0 && id <= 9_007_199_254_740_991)
        {
            return Err(RESPONSE_ERROR.into());
        }
        // Deliberately omit arbitrary response properties, including token/key aliases.
        let mut public = serde_json::Map::new();
        for key in [
            "id",
            "email",
            "username",
            "role",
            "balance",
            "frozen_balance",
            "concurrency",
            "status",
            "created_at",
            "total_recharged",
            "avatar_url",
            "email_bound",
        ] {
            if let Some(value) = user.get(key) {
                let valid_shape = match key {
                    "id" | "concurrency" => value.as_u64().is_some(),
                    "balance" | "frozen_balance" | "total_recharged" => value.is_number(),
                    "email_bound" => value.is_boolean(),
                    "avatar_url" => value.is_string() || value.is_null(),
                    _ => value.is_string(),
                };
                if !valid_shape {
                    continue;
                }
                let value = if value.as_str().is_some_and(|value| {
                    value.contains(&tokens.access_token)
                        || tokens
                            .refresh_token
                            .as_deref()
                            .is_some_and(|refresh| value.contains(refresh))
                }) {
                    Value::String("Protected value".into())
                } else {
                    value.clone()
                };
                public.insert(key.to_string(), value);
            }
        }
        Ok(Value::Object(public))
    }

    fn summary(&self, tokens: &StoredTokens, user: Value) -> Result<AccountSessionSummary, String> {
        let id = user
            .get("id")
            .and_then(Value::as_u64)
            .ok_or(RESPONSE_ERROR)?;
        Ok(AccountSessionSummary {
            session_handle: format!(
                "za-session-{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            user,
            expires_at_ms: tokens.expires_at_ms,
            auth_kind: match tokens.auth_kind {
                AuthKind::Oauth => "oauth",
                AuthKind::Password => "password",
            },
            account_scope: format!("{}|user:{id}", self.origin.origin().ascii_serialization()),
        })
    }

    async fn refresh_tokens(&self, previous: &StoredTokens) -> Result<StoredTokens, String> {
        let refresh = previous
            .refresh_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .ok_or(AUTH_REQUIRED)?;
        let path = match previous.auth_kind {
            AuthKind::Oauth => "api/v1/app-auth/token",
            AuthKind::Password => "api/v1/auth/refresh",
        };
        let request = self
            .client
            .post(self.origin.join(path).map_err(|_| RESPONSE_ERROR)?);
        let request = match previous.auth_kind {
            AuthKind::Oauth => request.form(&[
                ("grant_type", "refresh_token"),
                ("client_id", CLIENT_ID),
                ("refresh_token", refresh),
            ]),
            AuthKind::Password => request.json(&json!({"refresh_token":refresh})),
        };
        let response = request.send().await.map_err(|_| TRANSPORT_ERROR)?;
        // Both supported refresh APIs use 400/401 for an invalid/revoked refresh credential.
        if matches!(
            response.status(),
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(AUTH_REQUIRED.into());
        }
        let value = response_json(response).await?;
        let tokens = match previous.auth_kind {
            AuthKind::Oauth => &value,
            AuthKind::Password => {
                if value.get("code").and_then(Value::as_i64) != Some(0) {
                    return Err(RESPONSE_ERROR.into());
                }
                value.get("data").ok_or(RESPONSE_ERROR)?
            }
        };
        parse_tokens(tokens, previous.auth_kind.clone(), Some(refresh))
    }
}

fn parse_tokens(
    tokens: &Value,
    kind: AuthKind,
    fallback_refresh: Option<&str>,
) -> Result<StoredTokens, String> {
    if matches!(kind, AuthKind::Oauth)
        && (!tokens
            .get("token_type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.eq_ignore_ascii_case("Bearer"))
            || !tokens
                .get("scope")
                .and_then(Value::as_str)
                .is_some_and(|scope| scope.split_ascii_whitespace().any(|s| s == "profile:read")))
    {
        return Err(RESPONSE_ERROR.into());
    }
    let access = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or(RESPONSE_ERROR)?;
    validate_token(access)?;
    let expires = tokens
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .ok_or(RESPONSE_ERROR)?;
    let next_refresh = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .or(fallback_refresh);
    if let Some(token) = next_refresh {
        validate_token(token)?;
    }
    Ok(StoredTokens {
        access_token: access.into(),
        refresh_token: next_refresh.map(str::to_string),
        expires_at_ms: now_ms()
            .checked_add(expires.checked_mul(1000).ok_or(RESPONSE_ERROR)?)
            .ok_or(RESPONSE_ERROR)?,
        auth_kind: kind,
    })
}

fn vault_account(origin: &Url) -> Result<String, String> {
    let base = origin.origin().ascii_serialization();
    if !cfg!(debug_assertions) {
        return Ok(base);
    }
    // Dev builds intentionally skip the release single-instance plugin. Never let an
    // integration worktree's debug login overwrite the installed product's session.
    let executable =
        std::env::current_exe().map_err(|_| "Unable to scope the development account vault")?;
    let directory = executable
        .parent()
        .ok_or("Unable to scope the development account vault")?;
    let hash = Sha256::digest(directory.as_os_str().to_string_lossy().as_bytes());
    let hash = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{base}|development:{hash}"))
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 16 * 1024
        || !token.bytes().all(|byte| (33..=126).contains(&byte))
    {
        return Err(RESPONSE_ERROR.into());
    }
    Ok(())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
// A failed fresh exchange/password proof may still have created server credentials.
// These values are only used for revocation, never installation or renderer responses.
fn cleanup_tokens(value: &Value, auth_kind: AuthKind) -> Option<StoredTokens> {
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| validate_token(token).is_ok())
        .unwrap_or("")
        .to_string();
    let refresh_token = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| validate_token(token).is_ok())
        .map(str::to_string);
    if access_token.is_empty() && refresh_token.is_none() {
        return None;
    }
    Some(StoredTokens {
        access_token,
        refresh_token,
        expires_at_ms: 0,
        auth_kind,
    })
}

fn same_credentials(first: &StoredTokens, second: &StoredTokens) -> bool {
    first.auth_kind == second.auth_kind
        && first.access_token == second.access_token
        && first.refresh_token == second.refresh_token
}

fn token_needs_refresh(tokens: &StoredTokens) -> bool {
    tokens.expires_at_ms <= now_ms().saturating_add(REFRESH_SKEW_MS)
}

async fn save_to_vault(store: Arc<dyn SessionStore>, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || store.save(&value))
        .await
        .map_err(|_| "Platform account vault task failed")?
}
async fn clear_vault(store: Arc<dyn SessionStore>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || store.clear())
        .await
        .map_err(|_| "Platform account vault task failed")?
}
async fn response_json(mut response: reqwest::Response) -> Result<Value, String> {
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(AUTH_REQUIRED.into());
    }
    if !response.status().is_success() {
        return Err(TRANSPORT_ERROR.into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY as u64)
    {
        return Err(RESPONSE_ERROR.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| TRANSPORT_ERROR)? {
        if chunk.len() > MAX_BODY.saturating_sub(bytes.len()) {
            return Err(RESPONSE_ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| RESPONSE_ERROR.into())
}

#[cfg(test)]
pub(crate) mod tests;

pub mod api;
pub mod desktop_remote;
pub mod gateway;
