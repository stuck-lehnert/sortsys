use super::*;

#[tokio::test]
#[ignore = "scripts/test-native-auth provides three isolated DuckDB directories and fresh processes"]
async fn reopened_store_preserves_recovery_and_encrypted_files() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let store = QuackConfig::from_env().unwrap().unwrap();
    assert!(store.control_url.starts_with("http://127.0.0.1:"));
    assert!(store.token.starts_with("sortsys-disposable-"));
    let phase = std::env::var("SORTSYS_NATIVE_COLD_RESTORE_PHASE").unwrap();
    assert!(matches!(phase.as_str(), "source" | "stale" | "restored"));

    // Keep the same signing configuration so a stale session must be refused
    // by the restored security state, even though its JWT still verifies.
    let mut settings = configuration(store);
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    if std::env::var("TEST_OFFICE_COLD_RESTORE").as_deref() == Ok("1") {
        let origin = std::env::var("SORTSYS_OFFICE_TEST_ORIGIN").unwrap();
        assert!(origin.starts_with("http://127.0.0.1:"));
        settings.editors.office_origin = Some(crate::editors::office_origin(origin).unwrap());
    }
    let mut first = processes::ApiProcess::start(&settings, &root, "first").await;
    let mut second = processes::ApiProcess::start(&settings, &root, "second").await;
    assert_ne!(first.pid, second.pid);
    let tenant = "cold-restore-tenant";
    let endpoints = [first.endpoint.clone(), second.endpoint.clone()];
    browser_with_tenant("cold-restore", &root, Some(&endpoints), Some(tenant)).await;
    first.stop().await;
    second.stop().await;
    let processes = serde_json::json!({
        "parentPid": std::process::id(),
        "apiPids": [first.pid, second.pid],
        "endpoints": endpoints,
        "tenantFile": format!("{}.duckdb", sortsys_store::tenant_id(tenant).unwrap()),
        "stopped": true,
    });
    std::fs::write(root.join("api-processes.json"), processes.to_string()).unwrap();
}
