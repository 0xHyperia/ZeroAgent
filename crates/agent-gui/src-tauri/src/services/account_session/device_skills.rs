//! A fixed-origin, profile-bound read for an explicit K-brain skill reference.
use super::{gateway, AccountSessionState};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};

pub(crate) const DEVICE_SKILL_PATH: &str = "/api/web-chat/extensions/device-snapshot";
pub(crate) const PROTOCOL: &str = "zeroagent.device-skill-snapshot.v1";
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeviceSkillReference {
    package_id: String,
    revision: u32,
    name: String,
}

impl DeviceSkillReference {
    pub(crate) fn valid(&self) -> bool {
        fn valid_slug(value: &str) -> bool {
            value.len() <= 64
                && value.split('-').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                })
        }
        valid_slug(&self.package_id)
            && valid_slug(&self.name)
            && (1..=999_999_999).contains(&self.revision)
    }
}

pub(crate) struct DeviceSkillAccount {
    session: Arc<AccountSessionState>,
    handle: String,
}

impl DeviceSkillAccount {
    pub(crate) fn new(session: Arc<AccountSessionState>, handle: String) -> Self {
        Self { session, handle }
    }

    pub(crate) async fn resolve(
        &self,
        references: &[DeviceSkillReference],
    ) -> Result<Vec<u8>, StatusCode> {
        let origin = gateway::configured_gateway_origin().map_err(|_| StatusCode::BAD_GATEWAY)?;
        self.resolve_at(&origin, references).await
    }

    async fn resolve_at(
        &self,
        origin: &url::Url,
        references: &[DeviceSkillReference],
    ) -> Result<Vec<u8>, StatusCode> {
        let url =
            gateway::gateway_url(origin, DEVICE_SKILL_PATH).map_err(|_| StatusCode::BAD_GATEWAY)?;
        for force_refresh in [false, true] {
            let tokens = self
                .session
                .access(&self.handle, force_refresh)
                .await
                .map_err(|_| StatusCode::UNAUTHORIZED)?;
            let mut response = self
                .session
                .client
                .post(url.clone())
                .bearer_auth(&tokens.access_token)
                .json(&serde_json::json!({"references": references}))
                .timeout(Duration::from_secs(8))
                .send()
                .await
                .map_err(|_| StatusCode::BAD_GATEWAY)?;
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED && !force_refresh {
                continue;
            }
            if !status.is_success() {
                return Err(match status {
                    StatusCode::UNAUTHORIZED
                    | StatusCode::FORBIDDEN
                    | StatusCode::NOT_FOUND
                    | StatusCode::CONFLICT
                    | StatusCode::UNPROCESSABLE_ENTITY
                    | StatusCode::PAYLOAD_TOO_LARGE => status,
                    _ => StatusCode::BAD_GATEWAY,
                });
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| StatusCode::BAD_GATEWAY)?
            {
                if body.len() + chunk.len() > MAX_SNAPSHOT_BYTES {
                    return Err(StatusCode::PAYLOAD_TOO_LARGE);
                }
                body.extend_from_slice(&chunk);
            }
            self.session
                .require_current(&self.handle)
                .await
                .map_err(|_| StatusCode::UNAUTHORIZED)?;
            return Ok(body);
        }
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Json, http::HeaderMap, routing::post, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    #[tokio::test]
    async fn device_skill_response_is_bound_to_the_native_session() {
        let platform = super::super::tests::Fixture::new().await;
        let user = platform.login("a", false).await;
        let account = Arc::new(DeviceSkillAccount::new(
            platform.state.clone(),
            user.session_handle,
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        let reached = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let gateway = Router::new().route(
            DEVICE_SKILL_PATH,
            post({
                let (calls, reached, release) = (calls.clone(), reached.clone(), release.clone());
                move |headers: HeaderMap, Json(value): Json<serde_json::Value>| {
                    let (calls, reached, release) =
                        (calls.clone(), reached.clone(), release.clone());
                    async move {
                        assert_eq!(headers["authorization"], "Bearer access-a");
                        assert_eq!(value["references"][0]["revision"], 2);
                        if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                            reached.notify_one();
                            release.notified().await;
                        }
                        Json(serde_json::json!({"skills": ["fixture"]}))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin =
            url::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
        let reference = || DeviceSkillReference {
            package_id: "review-package".into(),
            revision: 2,
            name: "review".into(),
        };
        let result = account.resolve_at(&origin, &[reference()]).await.unwrap();
        assert!(std::str::from_utf8(&result).unwrap().contains("fixture"));
        let pending = tokio::spawn({
            let account = account.clone();
            let origin = origin.clone();
            async move { account.resolve_at(&origin, &[reference()]).await }
        });
        reached.notified().await;
        let _ = platform.login("b", false).await;
        release.notify_one();
        assert_eq!(pending.await.unwrap(), Err(StatusCode::UNAUTHORIZED));
        assert_eq!(
            account.resolve_at(&origin, &[reference()]).await,
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }
}
