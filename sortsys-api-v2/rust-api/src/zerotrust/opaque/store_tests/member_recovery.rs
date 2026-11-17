use super::*;

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn seed_recovery_restores_an_ordinary_member_without_granting_administration() {
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
    let tenant_name = "member-recovery-tenant";
    browser_with_tenant("owner-minimal", &root, Some(&endpoints), Some(tenant_name)).await;
    let tenant = first.tenant(tenant_name).unwrap();
    browser("member-recovery", &root, Some(&endpoints)).await;
    let result: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("report.json")).unwrap()).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["pendingInvitationPrepared"], true);
    assert_eq!(result["seedRequired"], true);
    assert_eq!(result["passwordRaceRejected"], true);
    assert_eq!(result["suspensionRaceRejected"], true);
    assert_eq!(result["repeatedSeedRotation"], true);
    assert_eq!(result["memberRemainsOrdinary"], true);
    assert_eq!(result["privateHistoryRecovered"], true);
    let member = crate::ids::Id::decode(result["member"].as_str().unwrap()).unwrap();
    let account = tenant
        .read::<Account>(accounts::account_key(member.0))
        .await
        .unwrap()
        .value
        .unwrap();
    assert!(account.roles.is_empty());
    assert_eq!(account.username, "recover.member");
    assert_eq!(account.credential().unwrap().revision, 4);
    assert_eq!(
        account.credential().unwrap().vault.subject,
        accounts::subject(member.0)
    );
    assert_protected_collection(&tenant, "accounts").await;
    assert_protected_collection(&tenant, "identity-history").await;
}
