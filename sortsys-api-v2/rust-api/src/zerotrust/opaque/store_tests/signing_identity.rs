use super::*;

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn signing_identity_replacement_keeps_history_and_requires_both_user_keys_and_authority() {
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
    let tenant_name = "signing-identity-tenant";
    browser_with_tenant("owner-minimal", &root, Some(&endpoints), Some(tenant_name)).await;
    browser("signing-identity", &root, Some(&endpoints)).await;
    let result: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("report.json")).unwrap()).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["historicalSignaturesPreserved"], true);
    assert_eq!(result["retiredKeyRejected"], true);
    assert_eq!(result["reinvitationPreservedSuccession"], true);
    assert_eq!(result["recoveryPreservedSuccession"], true);
    let id = crate::ids::Id::decode(result["member"].as_str().unwrap()).unwrap();
    let tenant = first.tenant(tenant_name).unwrap();
    let account = tenant
        .read::<Account>(accounts::account_key(id.0))
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(account.credential().unwrap().revision, 2);
    assert_eq!(account.epoch, 3);
    assert!(account.roles.is_empty());
    let current: crate::zerotrust::wire::IdentityCertificate =
        serde_json::from_value(account.credential().unwrap().certificate.clone()).unwrap();
    let certificates = tenant
        .scan::<crate::zerotrust::wire::IdentityCertificate>("identity-history", None, None)
        .await
        .unwrap()
        .records
        .into_iter()
        .map(|row| row.value.unwrap())
        .filter(|certificate| certificate.user == current.user)
        .collect::<Vec<_>>();
    assert_eq!(certificates.len(), 2);
    let previous = certificates
        .iter()
        .find(|certificate| certificate.previous_signature.is_none())
        .unwrap();
    current.succeeds(previous).unwrap();
    assert_eq!(current.encryption_key, previous.encryption_key);
    assert_ne!(current.signing_key, previous.signing_key);
    let head = tenant
        .read::<String>(crate::zerotrust::setup::identity_head_key(&current).unwrap())
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(head, current.signature);
    assert_protected_collection(&tenant, "identity-history").await;
    assert_protected_collection(&tenant, "identity-heads").await;
    assert_protected_collection(&tenant, "accounts").await;
}
