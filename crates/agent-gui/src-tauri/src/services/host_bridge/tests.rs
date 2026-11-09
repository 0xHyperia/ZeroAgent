use super::*;
use crate::services::tunnel::TunnelStatusPayload;
use std::sync::atomic::{AtomicBool, Ordering};

#[tokio::test]
async fn old_bearer_is_rejected_when_the_owner_revokes_its_session() {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let lease = Arc::new(AtomicBool::new(true));
    let current = Arc::clone(&lease);
    let state = Arc::new(ServerState {
        endpoint: HostBridgeEndpoint {
            port,
            token: "old-bridge-secret".into(),
        },
        is_live: Arc::new(move || current.load(Ordering::SeqCst)),
        terminals: Arc::new(TerminalSessionRegistry::default()),
        gateway: Weak::new(),
        protected_ports: [0; 2],
    });
    let app = Router::new()
        .route("/v1/host/{command}", any(handle_command))
        .with_state(state);
    let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("http://127.0.0.1:{port}/v1/host/terminal_read_tail");
    let request = || {
        client
            .post(&url)
            .bearer_auth("old-bridge-secret")
            .body("{}")
    };

    let invalid_arguments = request().send().await.unwrap();
    assert_eq!(invalid_arguments.status(), StatusCode::OK);
    assert_eq!(
        invalid_arguments.json::<Value>().await.unwrap()["error"]["code"],
        "invalid_arguments"
    );
    assert_eq!(
        request()
            .header(header::ORIGIN, "https://example.test")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request()
            .header(header::HOST, "rebound.test")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client.post(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    lease.store(false, Ordering::SeqCst);
    let revoked = request().send().await.unwrap();
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        revoked.json::<Value>().await.unwrap()["error"]["code"],
        "revoked"
    );
    server.abort();
}

#[test]
fn tunnel_snapshot_hides_other_workspaces_and_native_ports_are_never_targets() {
    let mut snapshot = TunnelStatePayload::offline_empty();
    for (id, project) in [
        ("owned", "/project"),
        ("other", "/project-2"),
        ("global", ""),
    ] {
        snapshot.tunnels.push(TunnelStatusPayload {
            id: id.into(),
            project_path_key: project.into(),
            slug: String::new(),
            name: String::new(),
            target_url: "http://localhost:5174".into(),
            public_path: String::new(),
            created_at: 0,
            expires_at: 0,
            active_connections: 0,
            local: None,
        });
    }
    let result = scoped_tunnels(snapshot, "/project");
    assert_eq!(
        result
            .tunnels
            .iter()
            .map(|tunnel| tunnel.id.as_str())
            .collect::<Vec<_>>(),
        ["owned"]
    );
    for host in ["localhost", "127.0.0.1", "192.0.2.42", "[::ffff:127.0.0.1]"] {
        assert!(is_protected_target(&format!("http://{host}:1234/"), [1234]));
    }
    assert!(!is_protected_target("http://localhost:5174/", [1234]));
}

#[test]
fn tunnel_public_base_never_includes_gateway_credentials() {
    assert_eq!(
        gateway_public_base_url(
            "wss://local-user:local-password@gateway.example.test/agent/?token=private#private",
            15052,
        ),
        "https://gateway.example.test:15052/agent"
    );
}
