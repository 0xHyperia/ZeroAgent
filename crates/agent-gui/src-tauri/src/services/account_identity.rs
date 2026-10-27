//! Profile identity comes from the configured USA-Zero server, never a renderer-supplied scope.
use std::{io::Read, time::Duration};

use reqwest::blocking::Client;
use serde::Deserialize;
use url::Url;

use super::managed_model_broker::configured_origin;

const MAX_IDENTITY_BYTES: u64 = 1024 * 1024;
const MAX_SAFE_USER_ID: u64 = 9_007_199_254_740_991;
const IDENTITY_ERROR: &str = "Unable to verify the USA-Zero account profile";
const AUTH_REQUIRED: &str = "USA_ZERO_PROFILE_AUTH_REQUIRED";

// Deliberately neither Debug nor Serialize: credentials must not enter IPC results or logs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeProfileCredential {
    access_token: String,
    auth_kind: AuthKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AuthKind {
    Oauth,
    // Existing password sessions can migrate; new desktop sign-in continues to use OAuth.
    Password,
}

/// Only this module can construct an account profile. No IPC accepts its scope as authority.
pub(crate) struct VerifiedProfile {
    account_scope: Option<String>,
}

impl VerifiedProfile {
    pub(crate) fn account_scope(&self) -> Option<&str> {
        self.account_scope.as_deref()
    }
}

#[cfg(desktop)]
pub(crate) fn profile_from_native_session(
    session: &super::account_session::AccountSessionSummary,
) -> Result<VerifiedProfile, String> {
    let origin =
        configured_origin(option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top"))?;
    let id = session
        .user
        .get("id")
        .and_then(serde_json::Value::as_u64)
        .filter(|id| *id > 0 && *id <= MAX_SAFE_USER_ID)
        .ok_or(IDENTITY_ERROR)?;
    let scope = format!("{}|user:{id}", origin.origin().ascii_serialization());
    if session.account_scope != scope
        || session
            .user
            .get("status")
            .and_then(serde_json::Value::as_str)
            != Some("active")
    {
        return Err(IDENTITY_ERROR.into());
    }
    Ok(VerifiedProfile {
        account_scope: Some(scope),
    })
}

#[derive(Deserialize)]
struct CurrentUser {
    id: u64,
    status: String,
}

#[derive(Deserialize)]
struct AppEnvelope {
    success: bool,
    data: CurrentUser,
}

#[derive(Deserialize)]
struct PasswordEnvelope {
    code: i64,
    data: CurrentUser,
}

fn identity_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .build()
        .map_err(|_| IDENTITY_ERROR.into())
}

pub(crate) fn verify_profile_credential(
    credential: Option<NativeProfileCredential>,
) -> Result<VerifiedProfile, String> {
    let Some(credential) = credential else {
        return Ok(VerifiedProfile {
            account_scope: None,
        });
    };
    let origin =
        configured_origin(option_env!("ZEROAGENT_USA_ZERO_ORIGIN").unwrap_or("https://usa0.top"))?;
    verify_at_origin(
        &identity_client(Duration::from_secs(10))?,
        &origin,
        credential,
    )
}

fn verify_at_origin(
    client: &Client,
    origin: &Url,
    credential: NativeProfileCredential,
) -> Result<VerifiedProfile, String> {
    if credential.access_token.is_empty()
        || credential.access_token.len() > 16 * 1024
        || !credential
            .access_token
            .bytes()
            .all(|byte| (33..=126).contains(&byte))
    {
        return Err(IDENTITY_ERROR.into());
    }
    let path = match credential.auth_kind {
        AuthKind::Oauth => "api/v1/app/me",
        AuthKind::Password => "api/v1/auth/me",
    };
    let url = origin.join(path).map_err(|_| IDENTITY_ERROR)?;
    let response = client
        .get(url)
        .bearer_auth(&credential.access_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|_| IDENTITY_ERROR)?;
    if matches!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Err(AUTH_REQUIRED.into());
    }
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|size| size > MAX_IDENTITY_BYTES)
    {
        return Err(IDENTITY_ERROR.into());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_IDENTITY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IDENTITY_ERROR)?;
    if bytes.len() as u64 > MAX_IDENTITY_BYTES {
        return Err(IDENTITY_ERROR.into());
    }
    let user = match credential.auth_kind {
        AuthKind::Oauth => {
            let envelope: AppEnvelope =
                serde_json::from_slice(&bytes).map_err(|_| IDENTITY_ERROR)?;
            if !envelope.success {
                return Err(IDENTITY_ERROR.into());
            }
            envelope.data
        }
        AuthKind::Password => {
            let envelope: PasswordEnvelope =
                serde_json::from_slice(&bytes).map_err(|_| IDENTITY_ERROR)?;
            if envelope.code != 0 {
                return Err(IDENTITY_ERROR.into());
            }
            envelope.data
        }
    };
    if user.id == 0 || user.id > MAX_SAFE_USER_ID || user.status != "active" {
        return Err(IDENTITY_ERROR.into());
    }
    Ok(VerifiedProfile {
        account_scope: Some(format!(
            "{}|user:{}",
            origin.origin().ascii_serialization(),
            user.id
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, thread};

    fn credential(kind: AuthKind) -> NativeProfileCredential {
        NativeProfileCredential {
            access_token: "private-fixture-token".into(),
            auth_kind: kind,
        }
    }

    fn fixture(status: &str, headers: &str, body: String) -> (Url, thread::JoinHandle<String>) {
        fixture_framing(status, headers, body, true)
    }

    fn fixture_framing(
        status: &str,
        headers: &str,
        body: String,
        content_length: bool,
    ) -> (Url, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let status = status.to_string();
        let headers = headers.to_string();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                if socket.read(&mut byte).unwrap() == 0 {
                    break;
                }
                request.push(byte[0]);
            }
            let length = if content_length {
                format!("Content-Length: {}\r\n", body.len())
            } else {
                String::new()
            };
            let response =
                format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}{length}\r\n{body}");
            // An oversized response can be rejected as soon as the headers arrive.
            let _ = socket.write_all(response.as_bytes());
            String::from_utf8(request).unwrap()
        });
        (origin, handle)
    }

    #[test]
    fn current_user_response_alone_selects_account_and_legacy_auth_endpoint() {
        for (kind, envelope, endpoint) in [
            (AuthKind::Oauth, "success", "/api/v1/app/me"),
            (AuthKind::Password, "code", "/api/v1/auth/me"),
        ] {
            let value = if envelope == "success" { "true" } else { "0" };
            let (origin, request) = fixture(
                "200 OK",
                "",
                format!(r#"{{"{envelope}":{value},"data":{{"id":42,"status":"active"}}}}"#),
            );
            let verified = verify_at_origin(
                &identity_client(Duration::from_secs(2)).unwrap(),
                &origin,
                credential(kind),
            )
            .unwrap();
            assert_eq!(
                verified.account_scope(),
                Some(format!("{}|user:42", origin.origin().ascii_serialization()).as_str())
            );
            let request = request.join().unwrap().to_lowercase();
            assert!(request.starts_with(&format!("get {endpoint} http/1.1\r\n")));
            assert!(request.contains("authorization: bearer private-fixture-token\r\n"));
            assert!(!request.contains("cookie:") && !request.contains("origin:"));
        }
    }

    #[test]
    fn malformed_inactive_unsafe_or_unverified_users_never_become_offline() {
        for body in [
            r#"{"success":false,"data":{"id":42,"status":"active"}}"#,
            r#"{"success":true,"data":{"id":0,"status":"active"}}"#,
            r#"{"success":true,"data":{"id":-1,"status":"active"}}"#,
            r#"{"success":true,"data":{"id":1.5,"status":"active"}}"#,
            r#"{"success":true,"data":{"id":9007199254740992,"status":"active"}}"#,
            r#"{"success":true,"data":{"id":42,"status":"disabled"}}"#,
            r#"{"success":true,"data":{"id":42}}"#,
            r#"{"code":0,"data":{"id":42,"status":"active"}}"#,
            "private-fixture-token-invalid-json",
        ] {
            let (origin, request) = fixture("200 OK", "", body.into());
            let error = verify_at_origin(
                &identity_client(Duration::from_secs(2)).unwrap(),
                &origin,
                credential(AuthKind::Oauth),
            )
            .err()
            .unwrap();
            assert_eq!(error, IDENTITY_ERROR);
            request.join().unwrap();
        }
        assert_eq!(
            verify_profile_credential(None).unwrap().account_scope(),
            None
        );
    }

    #[test]
    fn unauthorized_redirect_and_oversized_responses_are_not_trusted_or_exposed() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        for (status, headers, body) in [
            (
                "401 Unauthorized",
                "".into(),
                "private-fixture-token".into(),
            ),
            (
                "403 Forbidden",
                "".into(),
                "private-fixture-token-insufficient-scope".into(),
            ),
            (
                "302 Found",
                format!("Location: http://{}/leak\r\n", target.local_addr().unwrap()),
                String::new(),
            ),
            (
                "200 OK",
                "".into(),
                "x".repeat(MAX_IDENTITY_BYTES as usize + 1),
            ),
        ] {
            let (origin, request) = fixture(status, &headers, body);
            let error = verify_at_origin(
                &identity_client(Duration::from_secs(2)).unwrap(),
                &origin,
                credential(AuthKind::Oauth),
            )
            .err()
            .unwrap();
            assert_eq!(
                error,
                if status.starts_with("401") || status.starts_with("403") {
                    AUTH_REQUIRED
                } else {
                    IDENTITY_ERROR
                }
            );
            request.join().unwrap();
        }
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let (origin, request) = fixture_framing(
            "200 OK",
            "",
            "x".repeat(MAX_IDENTITY_BYTES as usize + 1),
            false,
        );
        assert_eq!(
            verify_at_origin(
                &identity_client(Duration::from_secs(2)).unwrap(),
                &origin,
                credential(AuthKind::Oauth)
            )
            .err()
            .unwrap(),
            IDENTITY_ERROR
        );
        request.join().unwrap();
    }

    #[test]
    fn identity_deadline_also_covers_a_stalled_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        listener.set_nonblocking(true).unwrap();
        let client = identity_client(Duration::from_millis(500)).unwrap();
        let (release, held_body) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "identity request never connected"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("identity fixture accept failed: {error}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut bytes = [0; 2048];
            assert!(socket.read(&mut bytes).unwrap() > 0);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n{\"success\":")
                .unwrap();
            // Hold a partial response until verification's own deadline returns.
            held_body.recv_timeout(Duration::from_secs(2)).unwrap();
        });
        let error = verify_at_origin(&client, &origin, credential(AuthKind::Oauth))
            .err()
            .unwrap();
        assert_eq!(error, IDENTITY_ERROR);
        release.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn credential_cannot_supply_scope_origin_or_unknown_auth_kind() {
        for value in [
            serde_json::json!({"accessToken":"token", "authKind":"oauth", "accountScope":"forged"}),
            serde_json::json!({"accessToken":"token", "authKind":"oauth", "origin":"https://other.invalid"}),
            serde_json::json!({"accessToken":"token", "authKind":"other"}),
        ] {
            assert!(serde_json::from_value::<NativeProfileCredential>(value).is_err());
        }
        let origin = Url::parse("http://127.0.0.1:1").unwrap();
        for token in ["", "two tokens", "header\r\ninjection", "非 ASCII"] {
            let input = NativeProfileCredential {
                access_token: token.into(),
                auth_kind: AuthKind::Oauth,
            };
            assert_eq!(
                verify_at_origin(
                    &identity_client(Duration::from_secs(1)).unwrap(),
                    &origin,
                    input
                )
                .err()
                .unwrap(),
                IDENTITY_ERROR
            );
        }
    }
}
