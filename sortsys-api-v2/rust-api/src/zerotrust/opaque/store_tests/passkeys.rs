use super::*;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::test]
#[ignore = "scripts/test-native-auth with SORTSYS_NATIVE_BROWSER=1 provides disposable services and Chromium"]
async fn browser_passkeys_unlock_cold_vaults_and_reject_replay_across_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_NATIVE_BROWSER").as_deref(),
        Ok("1"),
        "Native WebAuthn browser tests require SORTSYS_NATIVE_BROWSER=1"
    );
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let webapp = workspace.join("sortsys-webapp-v2");
    let build_log = std::fs::File::create(root.join("passkey-browser-build.log")).unwrap();
    let built = Command::new(std::env::var("SORTSYS_NATIVE_BUN").unwrap_or_else(|_| "bun".into()))
        .current_dir(&webapp)
        .arg("scripts/ui/build-native-passkeys.mjs")
        .stdout(build_log.try_clone().unwrap())
        .stderr(build_log)
        .kill_on_drop(true)
        .status()
        .await
        .unwrap();
    assert!(
        built.success(),
        "{}",
        std::fs::read_to_string(root.join("passkey-browser-build.log")).unwrap()
    );
    let frontend_log = std::fs::File::create(root.join("passkey-frontend.log")).unwrap();
    let mut frontend = Command::new("node")
        .current_dir(&webapp)
        .arg("scripts/ui/serve-native-passkeys.mjs")
        .env("SORTSYS_DISPOSABLE_AUTH_TEST", "1")
        .env("SORTSYS_NATIVE_AUTH_ROOT", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(frontend_log)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut ready = String::new();
    let mut output = BufReader::new(frontend.stdout.take().unwrap());
    tokio::time::timeout(Duration::from_secs(15), output.read_line(&mut ready))
        .await
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&ready)
        .expect("Native browser frontend did not report its bound origin");
    let origin = ready["origin"].as_str().unwrap();
    assert!(origin.starts_with("http://localhost:"));
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-owner-service-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    settings.passkeys = crate::zerotrust::passkeys::Config::parse(Some(origin.into())).unwrap();
    let (first_url, _first_api) = api(auth_service(&settings, first.clone())).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    let endpoints = [first_url, second_url];
    std::fs::write(
        root.join("passkey-endpoints.json"),
        serde_json::to_vec(&endpoints).unwrap(),
    )
    .unwrap();
    browser_with_tenant(
        "owner-minimal",
        &root,
        Some(&endpoints),
        Some("passkey-tenant-a"),
    )
    .await;
    std::fs::copy(
        root.join("owner-recovery.json"),
        root.join("passkey-recovery-source.json"),
    )
    .unwrap();
    browser_with_tenant(
        "owner-minimal",
        &root,
        Some(&endpoints),
        Some("passkey-tenant-b"),
    )
    .await;
    let log = std::fs::File::create(root.join("passkeys-browser.log")).unwrap();
    let mut browser_command = Command::new("node");
    browser_command
        .current_dir(webapp)
        .arg("scripts/ui/passkeys-native.mjs")
        .env("SORTSYS_PASSKEY_TEST_ORIGIN", origin)
        .env(
            "SORTSYS_AUTH_TEST_ENDPOINTS",
            serde_json::to_string(&endpoints).unwrap(),
        )
        .env("SORTSYS_NATIVE_AUTH_ROOT", &root)
        .env("SORTSYS_DISPOSABLE_AUTH_TEST", "1")
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(300), browser_command.status())
        .await
        .expect("Native WebAuthn browser test timed out")
        .unwrap();
    assert!(
        status.success(),
        "{}",
        std::fs::read_to_string(root.join("passkeys-browser.log")).unwrap()
    );
    frontend.kill().await.unwrap();
    frontend.wait().await.unwrap();
    let result: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("passkeys-browser-result.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["zeroCounterReplayRejected"], true);
    assert_eq!(result["recoveryRevokedPasskeys"], true);
    assert_eq!(result["signingRenewalRevokedPasskeys"], true);
    let tenant = first.tenant("passkey-tenant-a").unwrap();
    assert_protected_collection(&tenant, "passkeys").await;
    assert_protected_collection(&tenant, "passkey-users").await;
    assert!(
        !first
            .scan::<Value>("passkey-owners", None, None)
            .await
            .unwrap()
            .records
            .is_empty()
    );
}
