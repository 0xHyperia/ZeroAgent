use super::*;
use std::io::{BufRead, BufReader, Read, Write};

fn response<T>(
    status: u16,
    body: String,
    call: impl FnOnce(&reqwest::blocking::Client, &str) -> Result<T, String>,
) -> Result<T, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        let mut length = 0;
        loop {
            line.clear();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            if let Some(raw) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = raw.trim().parse::<usize>().unwrap();
            }
        }
        assert!(length < 65536);
        reader.read_exact(&mut vec![0; length]).unwrap();
        let oversized = body.len() > 1024 * 1024;
        let written=write!(stream,"HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        if !oversized {
            written.unwrap();
        }
    });
    let client = http_client().unwrap();
    let result = call(&client, &url);
    worker.join().unwrap();
    result
}

fn refresh(client: &reqwest::blocking::Client, url: &str) -> Result<flow::TokenResponse, String> {
    flow::refresh_grant(
        client,
        &format!("{url}/token?endpoint-secret=private-endpoint"),
        &flow::ClientCredentials {
            client_id: "fixture-client",
            client_secret: Some("private-client-secret"),
            auth_method: "client_secret_post",
        },
        "private-refresh-token",
        "https://mcp.invalid/mcp",
    )
}

#[test]
fn token_error_whitelists_code_and_never_echoes_as_description_or_endpoint() {
    let result=response(400,serde_json::json!({"error":"invalid_grant","error_description":"private-client-secret private-refresh-token"}).to_string(),refresh);
    let error = result.unwrap_err();
    assert!(error.contains("invalid_grant"));
    for secret in [
        "private-client-secret",
        "private-refresh-token",
        "private-endpoint",
    ] {
        assert!(!error.contains(secret));
    }
    let error = response(
        400,
        serde_json::json!({"error":"private-client-secret"}).to_string(),
        refresh,
    )
    .unwrap_err();
    assert!(error.contains("oauth_error"));
    assert!(!error.contains("private-client-secret"));
}

#[test]
fn token_malformed_and_unsupported_type_errors_do_not_echo_response_values() {
    let error = response(200, "{private-client-secret".into(), refresh).unwrap_err();
    assert_eq!(error, "解析 token 响应失败");
    let error=response(200,serde_json::json!({"access_token":"private-access-token","token_type":"private-client-secret"}).to_string(),refresh).unwrap_err();
    assert_eq!(error, "不支持的 token_type（仅支持 Bearer）");
}

#[test]
fn registration_errors_never_return_raw_body_or_endpoint() {
    for status in [400, 200] {
        let error = response(status, "{private-client-secret".into(), |client, url| {
            register::dynamic_register(
                client,
                &format!("{url}/register?private-endpoint"),
                "http://127.0.0.1:1/callback",
                None,
            )
        })
        .unwrap_err();
        assert!(!error.contains("private-client-secret"));
        assert!(!error.contains("private-endpoint"));
        assert!(if status == 400 {
            error.contains("HTTP 400")
        } else {
            error == "解析动态注册响应失败"
        });
    }
}

#[test]
fn oauth_response_limit_rejects_oversized_token_and_registration_bodies() {
    let oversized = "x".repeat(1024 * 1024 + 1);
    assert_eq!(
        response(200, oversized.clone(), refresh).unwrap_err(),
        "OAuth 响应超过大小上限"
    );
    let error = response(200, oversized, |client, url| {
        register::dynamic_register(
            client,
            &format!("{url}/register"),
            "http://127.0.0.1:1/callback",
            None,
        )
    })
    .unwrap_err();
    assert_eq!(error, "OAuth 响应超过大小上限");
}
