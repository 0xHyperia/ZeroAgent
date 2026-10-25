#[test]
fn canonical_http_skills_versions_bind_actual_global_and_workspace_documents() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    fs::create_dir_all(&settings).unwrap();
    let project_a = root.path().join("project a");
    let project_b = root.path().join("project-b");
    fs::create_dir_all(&project_a).unwrap();
    fs::create_dir_all(&project_b).unwrap();
    let manager = start(&root.path().join("backend"));
    let private = snapshot_backend(&manager, &settings);
    let service = Arc::new(ProfileConfigurationHttp {
        backend: None,
        connection: manager.connection(),
        backend_root: manager.configuration_root(),
        settings_root: settings.clone(),
    });
    let facade = crate::services::backend_facade::BackendFacade::start_with_configuration(
        manager.connection(),
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
        service,
    )
    .unwrap();
    let public = facade.connection();
    let http = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let get = |path: &str| {
        http.get(format!("{}{path}", public.base_url))
            .bearer_auth(&public.token)
            .send()
            .unwrap()
    };
    let put = |body: &Value, tag: Option<&str>| {
        let request = http
            .put(format!("{}/v1/skills/settings", public.base_url))
            .bearer_auth(&public.token)
            .json(body);
        if let Some(tag) = tag {
            request.header("if-match", tag)
        } else {
            request
        }
        .send()
        .unwrap()
    };
    let scope_path = |path: &Path| {
        format!(
            "/v1/skills?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("workdir", path.to_str().unwrap())
                .finish()
        )
    };
    let tag = |response: &reqwest::blocking::Response| {
        response.headers()["etag"].to_str().unwrap().to_owned()
    };
    let first = get("/v1/skills");
    assert_eq!(first.status(), 200);
    assert_eq!(
        first.headers()["x-zeroagent-configuration"],
        "zeroagent.configuration.v1"
    );
    let old = tag(&first);
    let global = json!({"enabled":true,"selected":["global-skill"]});
    assert_eq!(put(&global, None).status(), 428);
    assert_eq!(put(&global, Some(&tag(&get("/v1/settings")))).status(), 412);
    assert_eq!(
        put(&global, Some(&tag(&get(&scope_path(&project_a))))).status(),
        412
    );
    let saved = put(&global, Some(&old));
    assert_eq!(saved.status(), 200);
    let committed = tag(&saved);
    let saved_doc: Value = saved.json().unwrap();
    assert!(saved_doc["settings"]["selected"]
        .as_array()
        .unwrap()
        .contains(&json!("global-skill")));
    assert_eq!(
        get("/v1/skills").json::<Value>().unwrap(),
        saved_doc,
        "receipt version matches the returned complete resource"
    );
    assert_eq!(put(&global, Some(&old)).status(), 412);
    assert_eq!(
        http.get(format!("{}/v1/skills", public.base_url))
            .bearer_auth(&public.token)
            .header("if-none-match", &committed)
            .send()
            .unwrap()
            .status(),
        304
    );
    let head = http
        .head(format!("{}/v1/skills", public.base_url))
        .bearer_auth(&public.token)
        .send()
        .unwrap();
    assert_eq!(tag(&head), committed);
    assert!(head.bytes().unwrap().is_empty());
    let scoped = json!({"workdir":project_a.to_str().unwrap(),"enabled":true,"selected":[],"mode":"custom","skillNames":["project-skill"]});
    assert_eq!(
        put(&scoped, Some(&committed)).status(),
        412,
        "global read cannot lend a workspace version"
    );
    let a_read = tag(&get(&scope_path(&project_a)));
    let b_read = tag(&get(&scope_path(&project_b)));
    assert_ne!(a_read, b_read);
    assert_eq!(
        put(&scoped, Some(&b_read)).status(),
        412,
        "another workspace cannot lend its version"
    );
    let scoped_saved = put(&scoped, Some(&a_read));
    assert_eq!(scoped_saved.status(), 200);
    let a_new = tag(&scoped_saved);
    let scoped_doc: Value = scoped_saved.json().unwrap();
    assert_eq!(scoped_doc["settings"]["mode"], "custom");
    assert!(scoped_doc["settings"]["selected"]
        .as_array()
        .unwrap()
        .contains(&json!("project-skill")));
    assert_eq!(
        get(&scope_path(&project_a)).json::<Value>().unwrap(),
        scoped_doc
    );
    assert_eq!(put(&scoped, Some(&a_read)).status(), 412);
    assert_eq!(
        put(&global, Some(&committed)).status(),
        412,
        "workspace writes invalidate earlier composite/global reads"
    );
    assert!(
        get(&scope_path(&project_b)).json::<Value>().unwrap()["settings"]["selected"]
            .as_array()
            .unwrap()
            .contains(&json!("global-skill"))
    );
    let off =
        json!({"workdir":project_a.to_str().unwrap(),"enabled":true,"selected":[],"mode":"off"});
    let off_saved = put(&off, Some(&a_new));
    assert_eq!(off_saved.status(), 200);
    let off_tag = tag(&off_saved);
    assert_eq!(
        off_saved.json::<Value>().unwrap()["settings"]["enabled"],
        false
    );
    let inherit = json!({"workdir":project_a.to_str().unwrap(),"enabled":true,"selected":[],"mode":"inherit"});
    assert_eq!(put(&inherit, Some(&off_tag)).status(), 200);
    let inherited = get(&scope_path(&project_a)).json::<Value>().unwrap();
    assert_eq!(inherited["settings"]["mode"], "inherit");
    assert!(inherited["settings"]["selected"]
        .as_array()
        .unwrap()
        .contains(&json!("global-skill")));
    let before_install = tag(&get("/v1/skills"));
    private.request(reqwest::Method::POST,"/v1/skills/manage",Some(&json!({"action":"create","name":"new-discovery","description":"Fixture","body":"Instructions"}))).unwrap();
    assert_ne!(
        tag(&get("/v1/skills")),
        before_install,
        "listing changes cannot get a stale 304"
    );
    let before_native = tag(&get("/v1/skills"));
    let mut conn = open_profile_db(settings.join(DB_FILENAME)).unwrap();
    save_memory(&mut conn, json!({"enabled":true})).unwrap();
    assert_eq!(put(&global, Some(&before_native)).status(), 412);
    let before_external = tag(&get("/v1/skills"));
    let connection = manager.connection();
    assert_eq!(
        http.put(format!("{}/v1/skills/settings", connection.base_url))
            .bearer_auth(&connection.token)
            .json(&json!({"enabled":false,"selected":[]}))
            .send()
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        put(&global, Some(&before_external)).status(),
        412,
        "actual backend revision protects against writes outside the Native counter"
    );
    let concurrent = tag(&get("/v1/skills"));
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut workers = Vec::new();
    for name in ["concurrent-one", "concurrent-two"] {
        let http = http.clone();
        let public = public.clone();
        let version = concurrent.clone();
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            http.put(format!("{}/v1/skills/settings", public.base_url))
                .bearer_auth(&public.token)
                .header("if-match", version)
                .json(&json!({"enabled":true,"selected":[name]}))
                .send()
                .unwrap()
                .status()
                .as_u16()
        }));
    }
    barrier.wait();
    let mut statuses = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    statuses.sort();
    assert_eq!(statuses, vec![200, 412]);
    let recovery = fs::read_dir(settings.join("configuration-recovery"))
        .unwrap()
        .map(|entry| {
            serde_json::from_slice::<Value>(&fs::read(entry.unwrap().path()).unwrap()).unwrap()
        })
        .collect::<Vec<_>>();
    assert!(recovery
        .iter()
        .any(|before| before["format"] == "zeroagent-private-skills-v1"
            && before["workdir"] == project_a.to_str().unwrap()));
    assert!(
        recovery
            .iter()
            .any(|before| before["workdir"] == project_a.to_str().unwrap()
                && before["rawSettingsFile"]["exists"] == true
                && before["rawSettingsFile"]["document"]
                    .get("projects")
                    .and_then(Value::as_object)
                    .is_none_or(|projects| projects.is_empty())),
        "absence of a project override is preserved"
    );
    assert!(
        recovery
            .iter()
            .any(|before| before["workdir"] == project_a.to_str().unwrap()
                && before["rawSettingsFile"]["document"]["projects"]
                    .as_object()
                    .is_some_and(|projects| projects
                        .values()
                        .any(|project| project["mode"] == "custom"
                            && project["skillNames"] == json!(["project-skill"])))),
        "a custom override remains distinct from inheritance"
    );
    drop(facade);
    manager.shutdown();
}

#[test]
fn canonical_http_skills_keep_acknowledged_saves_and_block_unknown_results() {
    use crate::services::backend_facade::ConfigurationHttpRequest;
    use std::sync::atomic::{AtomicBool, Ordering};
    for mode in ["refresh-failure", "server-failure", "invalid-receipt"] {
        let root = tempfile::tempdir().unwrap();
        let skills_root = root.path().join("skills");
        fs::create_dir_all(&skills_root).unwrap();
        fs::write(
            root.path().join("skills-settings.json"),
            serde_json::to_vec(&json!({"revision":1,
            "global":{"enabled":true,"selected":[]},"projects":{}}))
            .unwrap(),
        )
        .unwrap();
        let skills_root = skills_root.to_str().unwrap().to_owned();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let worker = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let written=Arc::new(AtomicBool::new(false));
                let router=axum::Router::new().fallback(move |method:axum::http::Method|{
                    let written=written.clone();let skills_root=skills_root.clone();async move {
                        let (status,body)=if method==axum::http::Method::PUT {
                            written.store(true,Ordering::SeqCst);
                            match mode {
                                "server-failure"=>(503,json!({"error":"response lost after write"})),
                                "invalid-receipt"=>(200,json!({"ok":true})),
                                _=>(200,json!({"version":"v1","revision":2,"settings":{"enabled":false,"selected":["saved"]}})),
                            }
                        } else if written.load(Ordering::SeqCst) {
                            (503,json!({"error":"read unavailable"}))
                        } else {
                            (200,json!({"version":"v1","revision":1,"rootDir":skills_root,"skills":[],"settings":{"enabled":true,"selected":[]}}))
                        };
                        (axum::http::StatusCode::from_u16(status).unwrap(),axum::Json(body))
                    }
                });
                axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(),router)
                    .with_graceful_shutdown(async {let _=stopped.await;}).await.unwrap();
            });
        });
        let mut client = ProfileBackupBackend::new(
            KBrainBackendConnection {
                base_url: format!("http://{address}"),
                token: "fixture".into(),
                protocol_version: "kbrain.agent.v1".into(),
                storage_id: Uuid::new_v4().to_string(),
            },
            None,
            root.path().to_path_buf(),
        )
        .unwrap();
        client.backend_root = Some(root.path().to_path_buf());
        let mut conn = native_db();
        let uri = url::Url::parse("http://native/v1/skills").unwrap();
        let request =
            |method: &str, etag: Option<String>, body: Option<Value>| ConfigurationHttpRequest {
                method: method.into(),
                uri: if method == "GET" {
                    "/v1/skills"
                } else {
                    "/v1/skills/settings"
                }
                .into(),
                if_match: etag,
                if_none_match: None,
                body,
            };
        let read = ProfileConfigurationHttp::skills_request_locked(
            &client,
            &mut conn,
            "fixture-read",
            request("GET", None, None),
            &uri,
        )
        .unwrap();
        let update_uri = url::Url::parse("http://native/v1/skills/settings").unwrap();
        let result = ProfileConfigurationHttp::skills_request_locked(
            &client,
            &mut conn,
            "fixture-read",
            request(
                "PUT",
                read.etag,
                Some(json!({"enabled":false,"selected":["saved"]})),
            ),
            &update_uri,
        );
        if mode == "refresh-failure" {
            let result = result.unwrap();
            assert_eq!(result.status, 200);
            assert!(result.etag.is_none());
            let body = result.body.unwrap();
            assert_eq!(body["settings"]["selected"], json!(["saved"]));
            assert!(body["warning"].is_string());
            assert!(client.configuration.ensure_consistent().is_ok());
        } else {
            assert_eq!(result.err().expect("unknown write must fail").0, 503);
            assert!(client.configuration.ensure_consistent().is_err());
        }
        assert_eq!(
            fs::read_dir(root.path().join("configuration-recovery"))
                .unwrap()
                .count(),
            1
        );
        let _ = stop.send(());
        worker.join().unwrap();
    }
}
