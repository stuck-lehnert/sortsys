use super::*;

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn ordinary_members_issue_partial_invoices_without_private_extension_keys() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-owner-service-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first.clone())).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    let endpoints = [first_url, second_url];
    browser_with_tenant(
        "owner-minimal",
        &root,
        Some(&endpoints),
        Some("billing-permissions-tenant"),
    )
    .await;
    browser("billing-permissions", &root, Some(&endpoints)).await;
    let result: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("report.json")).unwrap()).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["partialInvoiceIssued"], true);
    let tenant = first.tenant("billing-permissions-tenant").unwrap();
    assert_protected_collection(&tenant, "accounts").await;
}
