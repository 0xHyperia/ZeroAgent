#[test]
fn broker_rejects_retired_probe_purpose_and_endpoint_extensions() {
    let fixture = Fixture::new(|| {});
    let profile = TestProfile::new(&fixture);
    profile.seed(fixture.record());
    let host = profile.host(Arc::new(AtomicBool::new(true)));
    let http = client();
    assert_eq!(
        request(&http, &host, &profile.target, "").status().as_u16(),
        200
    );
    for purpose in [
        json!("probe"),
        json!("runtime"),
        json!("admin"),
        json!(true),
        Value::Null,
    ] {
        let reply = http
            .post(host.endpoint())
            .bearer_auth(host.capability())
            .json(&json!({"protocol":PROTOCOL,"target":profile.target,"purpose":purpose}))
            .send()
            .unwrap();
        assert_eq!(reply.status().as_u16(), 400);
        assert!(!reply.text().unwrap().contains("fixture-old-access"));
    }
    let mut extended = profile.target.clone();
    extended["messageUrl"] = json!("/messages");
    assert_eq!(request(&http, &host, &extended, "").status().as_u16(), 401);
    let file = profile.backend.join("config.json.live-mcp.json");
    let mut saved: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    saved["servers"][0]["enabled"] = json!(false);
    let bytes = serde_json::to_vec(&saved).unwrap();
    fs::write(&file, &bytes).unwrap();
    assert_eq!(
        request(&http, &host, &profile.target, "").status().as_u16(),
        401
    );
    assert_eq!(fs::read(&file).unwrap(), bytes);
}
