use super::*;

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn seed_recovery_retains_the_primary_account_and_rejects_concurrent_credential_changes() {
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
    let tenant_name = "existing-recovery-tenant";
    browser_with_tenant("owner-minimal", &root, Some(&endpoints), Some(tenant_name)).await;
    let tenant = first.tenant(tenant_name).unwrap();
    let initial = tenant
        .scan::<Account>("accounts", None, None)
        .await
        .unwrap()
        .records;
    assert_eq!(initial.len(), 1);
    let before = initial[0].value.as_ref().unwrap();
    browser("recovery-account", &root, Some(&endpoints)).await;
    let result: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("report.json")).unwrap()).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["passwordRaceRejected"], true);
    assert_eq!(result["aliasRaceRejected"], true);
    assert_eq!(result["repeatedSeedRotation"], true);
    let after = tenant
        .scan::<Account>("accounts", None, None)
        .await
        .unwrap()
        .records;
    assert_eq!(after.len(), 1);
    let after = after[0].value.as_ref().unwrap();
    assert_eq!(after.id, before.id);
    assert_eq!(after.username, "builder.renamed");
    assert_eq!(after.created_at, before.created_at);
    assert_eq!(after.locale, before.locale);
    assert_eq!(after.epoch, before.epoch + 3);
    assert_eq!(
        after.credential().unwrap().revision,
        before.credential().unwrap().revision + 3
    );
    assert_eq!(after.roles, [":admin"]);
    assert!(after.deactivated_at.is_none());
    assert!(after.archived_at.is_none());
    assert!(after.deleted_at.is_none());
    assert!(
        tenant
            .read::<Username>(key("usernames", "builder"))
            .await
            .unwrap()
            .value
            .is_none()
    );
    let alias = tenant
        .read::<Username>(key("usernames", "builder.renamed"))
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(alias.user_id, after.id);
    assert_protected_collection(&tenant, "accounts").await;
    assert_protected_collection(&tenant, "authority-history").await;
}
