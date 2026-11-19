//! Real browser password worker against two independent auth services and the
//! shared DuckDB process. No AppState, PostgreSQL pool or legacy seed is used.
use super::*;
use crate::{
    auth::AuthService,
    control::{
        accounts::{Account, Credential, TenantStatus, Username},
        key,
    },
    quack_store::{CipherStore, QuackConfig},
    standalone::Config,
};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{process::Command, task::JoinHandle};

mod batching;
mod billing_permissions;
mod cold_restore;
mod content_views;
mod member_recovery;
mod passkeys;
mod processes;
mod recovery_account;
mod signing_identity;

struct ApiTask(JoinHandle<()>);
impl Drop for ApiTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn api(service: AuthService) -> (String, ApiTask) {
    let service = Arc::new(service);
    let router = crate::standalone::router(service);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (format!("http://{address}/"), ApiTask(task))
}

fn configuration(store: QuackConfig) -> Config {
    Config {
        port: 0,
        jwt_secret: Arc::from(b"disposable-auth-service-signing-secret-2026".as_slice()),
        admin_hash: "unused-test-admin-hash".into(),
        store,
        editors: crate::editors::EditorConfig::default(),
        passkeys: crate::zerotrust::passkeys::Config::default(),
    }
}

fn auth_service(settings: &Config, repository: Repository) -> AuthService {
    AuthService::from_credentials(
        settings.jwt_secret.clone(),
        Arc::clone(&settings.admin_hash),
        Some(repository),
    )
    .with_passkeys(settings.passkeys.clone())
}

async fn browser(mode: &str, root: &Path, endpoints: Option<&[String]>) {
    browser_with_tenant(mode, root, endpoints, None).await;
}

async fn browser_with_tenant(
    mode: &str,
    root: &Path,
    endpoints: Option<&[String]>,
    tenant: Option<&str>,
) {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let webapp = workspace.join("sortsys-webapp-v2");
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/zerotrust-opaque.json");
    let output = if mode == "prepare" {
        "vault.json"
    } else {
        "report.json"
    };
    let log = std::fs::File::create(root.join(format!("browser-{mode}.log"))).unwrap();
    let mut command =
        Command::new(std::env::var("SORTSYS_NATIVE_BUN").unwrap_or_else(|_| "bun".into()));
    command
        .current_dir(webapp)
        .arg(match mode {
            "owner"
            | "owner-minimal"
            | "owner-bootstrap"
            | "owner-content-preparation"
            | "owner-staging"
            | "owner-print-templates"
            | "owner-planning-recipients"
            | "owner-tool-batches"
            | "owner-access-pages"
            | "owner-access-publications"
            | "owner-backup"
            | "owner-backup-archive" => "scripts/test-owner-setup.ts",
            "invitations" => "scripts/test-duckdb-invitations.ts",
            "member-renames" => "scripts/test-native-member-renames.ts",
            "member-deletion" => "scripts/test-native-member-deletion.ts",
            "recovery-account" => "scripts/test-native-existing-recovery.ts",
            "cold-restore" => "scripts/test-native-cold-restore.ts",
            "member-recovery" => "scripts/test-native-member-recovery.ts",
            "signing-identity" => "scripts/test-native-signing-identity.ts",
            "billing-permissions" => "scripts/test-native-billing-permissions.ts",
            "recovery" => "scripts/test-duckdb-recovery.ts",
            "recovery-scale" => "scripts/test-recovery-scale.ts",
            "llm" => "scripts/test-duckdb-llm.ts",
            "editors" => "scripts/test-duckdb-editors.ts",
            "document-search" => "scripts/test-native-document-search.ts",
            "administration" => "scripts/test-native-administration.ts",
            "development-seed" => "scripts/test-development-seed.ts",
            "telemetry" => "scripts/test-operator-telemetry.ts",
            "locks" => "scripts/test-object-locks.ts",
            "timestamp-retry" => "scripts/test-timestamp-store.ts",
            _ => "scripts/test-duckdb-auth.ts",
        })
        .arg(mode)
        .arg(fixture)
        .arg(root.join(output))
        .env("SORTSYS_DISPOSABLE_AUTH_TEST", "1")
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .kill_on_drop(true);
    if mode == "owner-bootstrap" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "initialization-tenant");
    }
    if mode == "owner-staging" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "staging-tenant");
    }
    if mode == "owner-print-templates" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "print-templates-tenant");
    }
    if mode == "owner-access-publications" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "access-publications-tenant");
    }
    if mode == "owner-access-pages" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "access-pages-tenant");
    }
    if mode == "owner-tool-batches" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "tool-batch-tenant");
    }
    if mode == "owner-backup" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "backup-tenant");
    }
    if mode == "owner-backup-archive" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "backup-archive-tenant");
    }
    if mode == "owner-minimal" {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", "recovery-tenant");
    }
    if let Some(tenant) = tenant {
        command.env("SORTSYS_NATIVE_AUTH_TENANT", tenant);
    }
    if let Some(endpoints) = endpoints {
        command.env(
            "SORTSYS_AUTH_TEST_ENDPOINTS",
            serde_json::to_string(endpoints).unwrap(),
        );
    }
    // This scenario creates about fifty private commercial workflows, repeats
    // startup and optionally drives the rendered application. Its overall
    // budget is independent of the unchanged per-interaction browser deadlines.
    let deadline = if mode == "recovery-scale" {
        // This load case publishes and recovers over ten thousand actual key
        // generations. Ordinary browser interaction deadlines stay unchanged.
        Duration::from_secs(900)
    } else if mode == "development-seed" {
        if std::env::var("SORTSYS_NATIVE_BROWSER").as_deref() == Ok("1") {
            // The complete run includes seed validation and all 18 real-browser
            // workflows. Keep their individual interaction deadlines unchanged.
            Duration::from_secs(3600)
        } else {
            Duration::from_secs(1800)
        }
    } else if matches!(mode, "administration" | "owner-content-preparation")
        && std::env::var("SORTSYS_NATIVE_BROWSER").as_deref() == Ok("1")
    {
        // These cases combine multiple signed transitions with real browser
        // sessions. Their individual interaction deadlines stay unchanged.
        Duration::from_secs(420)
    } else if matches!(
        mode,
        "recovery"
            | "cold-restore"
            | "recovery-account"
            | "member-recovery"
            | "signing-identity"
            | "billing-permissions"
            | "document-search"
            | "administration"
            | "llm"
            | "editors"
            | "owner-staging"
            | "owner-content-preparation"
            | "owner-print-templates"
            | "owner-tool-batches"
            | "owner-planning-recipients"
            | "owner-access-pages"
            | "owner-access-publications"
            | "owner-backup"
            | "owner-backup-archive"
    ) {
        Duration::from_secs(300)
    } else if matches!(
        mode,
        "invitations" | "member-renames" | "member-deletion" | "owner-bootstrap"
    ) {
        Duration::from_secs(180)
    } else {
        Duration::from_secs(90)
    };
    let result = tokio::time::timeout(deadline, command.status())
        .await
        .expect("browser auth test timed out")
        .unwrap();
    assert!(
        result.success(),
        "browser auth failed: {}",
        std::fs::read_to_string(root.join(format!("browser-{mode}.log"))).unwrap()
    );
}

async fn assert_protected_collection(repository: &Repository, collection: &str) {
    let page = repository
        .scan::<Value>(collection, None, None)
        .await
        .unwrap();
    let first = page
        .records
        .into_iter()
        .next()
        .unwrap_or_else(|| panic!("Expected a published record in {collection}"));
    assert_protected_record(repository, first.record).await;
}

async fn assert_protected_record(
    repository: &Repository,
    record: sortsys_zerotrust::metadata::RecordKey,
) {
    let first = repository.read::<Value>(record).await.unwrap();
    assert!(first.value.is_some());
    let mut removal = repository.transaction().unwrap();
    removal.delete(first.record.clone()).await.unwrap();
    assert!(
        removal.commit().await.is_err(),
        "Unprotected record in {}",
        first.record.collection,
    );
    let retained = repository.read::<Value>(first.record).await.unwrap();
    assert_eq!(retained.value, first.value);
    assert_eq!(retained.version, first.version);
}

async fn assert_published_catalog_pages(repository: &Repository, generation: u32) {
    use sortsys_zerotrust::anchors::{ANCHOR_COLLECTION, RecordAnchor, RecordCheckpoint};
    let collection = format!("recovery-catalog-pages-{generation}");
    let mut protected = std::collections::BTreeSet::new();
    let mut after = None;
    let mut version = None;
    loop {
        let page = repository
            .scan::<RecordAnchor>(ANCHOR_COLLECTION, after, version)
            .await
            .unwrap();
        version = Some(page.version);
        for row in page.records {
            let anchor = row.value.unwrap();
            let Some(checkpoint) = RecordCheckpoint::from_payload(&anchor.payload).unwrap() else {
                continue;
            };
            for binding in checkpoint.records {
                if binding.record.collection == collection {
                    protected.insert(binding.record.key.clone());
                    assert_protected_record(repository, binding.record).await;
                }
            }
        }
        after = page.after;
        if after.is_none() {
            break;
        }
    }
    assert!(
        !protected.is_empty(),
        "No published catalog pages in {collection}"
    );
    // Competing recovery plans upload different encrypted trees. A losing
    // plan's pages must remain disposable instead of being retained forever.
    if generation == 2 {
        let pages = repository
            .scan::<Value>(&collection, None, None)
            .await
            .unwrap();
        assert!(pages.after.is_none());
        let abandoned = pages
            .records
            .into_iter()
            .find(|row| !protected.contains(&row.record.key))
            .expect("The losing recovery plan must have staged its own pages");
        let mut cleanup = repository.transaction().unwrap();
        cleanup.delete(abandoned.record).await.unwrap();
        cleanup.commit().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn live_llm_uses_native_configuration_and_authenticated_cross_instance_mcp() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    assert!(root.starts_with(std::env::temp_dir()));
    let config = QuackConfig::from_env().unwrap().unwrap();
    let records = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"native-live-model-admission-test-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Native-model-operator-password-2026!", 4)
        .unwrap()
        .into();
    let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_url = format!("http://{}/", first.local_addr().unwrap());
    let second_url = format!("http://{}/", second.local_addr().unwrap());
    let mut tasks = Vec::new();
    for listener in [first, second] {
        let service = Arc::new(auth_service(&settings, records.clone()));
        let mut configuration = crate::llm::control::Settings::default();
        configuration.encryption_key = Some([0x3c; 32]);
        // Both replicas use the same public MCP address. The browser connects
        // to the second replica, so model tools must be forwarded by the first.
        configuration.mcp_url = Some(format!("{}internal/llm/mcp", first_url));
        let runtime = crate::llm::live::Runtime::new(Arc::clone(&service), Arc::new(configuration));
        runtime
            .live_llm
            .bind_to(None, None, listener.local_addr().unwrap())
            .await
            .unwrap();
        let router = crate::standalone::router_with_runtime(
            service,
            runtime,
            crate::editors::EditorConfig::default(),
        );
        tasks.push(ApiTask(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        })));
    }
    browser("llm", &root, Some(&[first_url, second_url])).await;
    let stored = records
        .read::<serde_json::Value>(key("llm-provider-accounts", "openrouter"))
        .await
        .unwrap()
        .value
        .unwrap();
    assert!(!stored.to_string().contains("synthetic-live-fixture"));
    assert!(stored["secret"]["ciphertext"].as_str().unwrap().len() > 20);
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn private_editors_use_native_configuration_and_separate_file_permissions() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let store = QuackConfig::from_env().unwrap().unwrap();
    let mut settings = configuration(store);
    settings.jwt_secret = Arc::from(b"native-private-editor-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Native-editor-operator-password-2026!", 4)
        .unwrap()
        .into();
    settings.editors = crate::editors::EditorConfig {
        office_origin: Some("http://127.0.0.1:29400".into()),
    };
    let mut tasks = Vec::new();
    let mut endpoints = Vec::new();
    for _ in 0..2 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = crate::standalone::connect_at(&settings, address)
            .await
            .unwrap();
        endpoints.push(format!("http://{address}/"));
        tasks.push(ApiTask(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        })));
    }
    browser("editors", &root, Some(&endpoints)).await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn browser_password_changes_revoke_peer_sessions_without_postgres() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    assert!(root.starts_with(std::env::temp_dir()));
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.uri.starts_with("quack:127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
    browser("prepare", &root, None).await;
    let vector: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/zerotrust-opaque.json"
    ))
    .unwrap();
    let vault: AccountVault =
        serde_json::from_str(&std::fs::read_to_string(root.join("vault.json")).unwrap()).unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let tenant = first.tenant("test").unwrap();
    let status = TenantStatus {
        epoch: 1,
        locked_at: None,
        deactivated_at: None,
        deleted_at: None,
    };
    let account = Account {
        id: 9021,
        username: "interop".into(),
        locale: "de".into(),
        epoch: 1,
        roles: vec![":admin".into()],
        created_at: Utc::now(),
        modified_at: Utc::now(),
        deactivated_at: None,
        archived_at: None,
        deleted_at: None,
        credential: Some(Credential {
            revision: 1,
            record: vector["registrationRecord"].as_str().unwrap().into(),
            vault,
            certificate: json!({"format":"pending"}),
        }),
    };
    let mut registry = first.transaction().unwrap();
    registry
        .put(
            key("tenants", "test"),
            &crate::control::tenants::RegistryEntry {
                name: "test".into(),
                operation: "public_auth_fixture".into(),
                created_at: Utc::now(),
            },
        )
        .await
        .unwrap();
    registry.commit().await.unwrap();
    let mut initial = tenant.transaction().unwrap();
    initial
        .put_protected(accounts::tenant_key(), &status)
        .await
        .unwrap();
    let entry = first
        .read::<crate::control::tenants::RegistryEntry>(key("tenants", "test"))
        .await
        .unwrap()
        .value
        .unwrap();
    initial
        .put(
            crate::control::tenants::provisioning_key(),
            &crate::control::tenants::Provisioning {
                name: "test".into(),
                operation: entry.operation,
                initial_token_hash: encode(&[0; 32]),
                owner_id: account.id,
                created_at: entry.created_at,
                registered_at: Some(entry.created_at),
            },
        )
        .await
        .unwrap();
    initial
        .put_protected(accounts::account_key(account.id), &account)
        .await
        .unwrap();
    initial
        .put(
            key("usernames", "interop"),
            &Username {
                user_id: account.id,
            },
        )
        .await
        .unwrap();
    initial
        .put(
            key("opaque-setup", "current"),
            vector["setup"].as_str().unwrap(),
        )
        .await
        .unwrap();
    initial.commit().await.unwrap();
    let mut settings = configuration(config);
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let first_service = auth_service(&settings, first.clone());
    let second_service = auth_service(&settings, second.clone());
    let (first_url, _first_api) = api(first_service.clone()).await;
    let (second_url, _second_api) = api(second_service.clone()).await;
    browser("exercise", &root, Some(&[first_url, second_url])).await;
    let report: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["success"], true);
    let updated = tenant
        .read::<Account>(accounts::account_key(account.id))
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(updated.epoch, 2);
    assert_eq!(updated.credential().unwrap().revision, 3);

    // Renewal of an identical value changes the expiry head. A stale queue
    // entry must never delete a still-live exchange or reset a login budget.
    let temporary = key("temporary", "renewed");
    let mut expired = tenant.transaction().unwrap();
    expired
        .put_expiring(
            temporary.clone(),
            &"unchanged",
            Utc::now() - chrono::Duration::minutes(1),
        )
        .await
        .unwrap();
    expired.commit().await.unwrap();
    let mut renewed = second.tenant("test").unwrap().transaction().unwrap();
    renewed
        .put_expiring(
            temporary.clone(),
            &"unchanged",
            Utc::now() + chrono::Duration::days(1),
        )
        .await
        .unwrap();
    renewed.commit().await.unwrap();
    tenant.cleanup_expired().await.unwrap();
    assert_eq!(
        tenant
            .read::<String>(temporary)
            .await
            .unwrap()
            .value
            .as_deref(),
        Some("unchanged")
    );

    // Authorization observed before a concurrent tenant/session generation
    // change cannot publish a protected update afterwards.
    let sessions = tenant
        .scan::<accounts::Session>("sessions", None, None)
        .await
        .unwrap();
    let session = sessions
        .records
        .into_iter()
        .filter_map(|row| row.value)
        .find(|session| session.account_epoch == updated.epoch && session.expires_at > Utc::now())
        .unwrap();
    let identity = accounts::session_identity(&first, "test", session.id)
        .await
        .unwrap();
    let mut protected_write = tenant.transaction().unwrap();
    accounts::checked_session(&mut protected_write, &identity)
        .await
        .unwrap();
    protected_write
        .put(key("protected-references", "test"), &"ciphertext-hash")
        .await
        .unwrap();
    let mut revocation = second.tenant("test").unwrap().transaction().unwrap();
    let mut current: TenantStatus = revocation
        .read(accounts::tenant_key())
        .await
        .unwrap()
        .unwrap();
    current.epoch += 1;
    revocation
        .put_protected(accounts::tenant_key(), &current)
        .await
        .unwrap();
    revocation.commit().await.unwrap();
    assert_eq!(
        protected_write.commit().await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert!(
        accounts::session_identity(&first, "test", session.id)
            .await
            .is_err()
    );

    let attempts = futures_util::future::join_all((0..12).map(|number| {
        let repository = if number % 2 == 0 {
            first.clone()
        } else {
            second.clone()
        };
        async move {
            auth_limits::reserve(
                &repository,
                b"shared-disposable-budget",
                "test",
                &["same-account"],
            )
            .await
        }
    }))
    .await;
    assert_eq!(
        attempts.iter().filter(|attempt| attempt.is_ok()).count(),
        10
    );
    assert!(
        attempts
            .iter()
            .filter_map(|attempt| attempt.as_ref().err())
            .all(|error| error.code == ErrorCode::TooManyRequests)
    );
    let successful = attempts.into_iter().find_map(Result::ok).unwrap();
    successful.succeeded(&first).await;
    assert!(
        auth_limits::reserve(
            &second,
            b"shared-disposable-budget",
            "test",
            &["same-account"]
        )
        .await
        .is_ok()
    );
    assert_eq!(
        auth_limits::reserve(
            &first,
            b"shared-disposable-budget",
            "test",
            &["same-account"]
        )
        .await
        .err()
        .unwrap()
        .code,
        ErrorCode::TooManyRequests
    );
    for index in 0..9 {
        let service = if index % 2 == 0 {
            &first_service
        } else {
            &second_service
        };
        assert!(
            service
                .login_admin("incorrect-password", None)
                .await
                .unwrap()
                .is_none()
        );
    }
    assert!(
        second_service
            .login_admin("Disposable-operator-password-2026!", None)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        first_service
            .login_admin("incorrect-password", None)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        second_service
            .login_admin("Disposable-operator-password-2026!", None)
            .await
            .unwrap_err()
            .code,
        ErrorCode::TooManyRequests
    );
    assert!(
        first_service
            .login_admin("Disposable-operator-password-2026!", Some("test"))
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn member_renames_preserve_credentials_and_commit_profiles_atomically_across_replicas() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
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
    browser_with_tenant("owner-minimal", &root, Some(&endpoints), Some("new-tenant")).await;
    browser("member-renames", &root, Some(&endpoints)).await;
    let tenant = first.tenant("new-tenant").unwrap();
    assert_protected_collection(&tenant, "accounts").await;
    for alias in [
        "builder",
        "rename.member",
        "renamed.concurrent",
        "renamed.stale",
        "substituted.alias",
    ] {
        assert!(
            tenant
                .read::<Username>(key("usernames", alias))
                .await
                .unwrap()
                .value
                .is_none()
        );
    }
    for alias in ["builder.updated", "renamed-final"] {
        let index = tenant
            .read::<Username>(key("usernames", alias))
            .await
            .unwrap()
            .value
            .unwrap();
        let account = tenant
            .read::<Account>(accounts::account_key(index.user_id))
            .await
            .unwrap()
            .value
            .unwrap();
        assert_eq!(account.username, alias);
        assert_eq!(account.credential().unwrap().revision, 1);
        assert_eq!(
            account.credential().unwrap().vault.subject,
            accounts::subject(account.id)
        );
    }
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn member_deletions_are_atomic_terminal_and_survive_tenant_recovery() {
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
        Some("member-deletion-tenant"),
    )
    .await;
    browser("member-deletion", &root, Some(&endpoints)).await;
    let result: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("report.json")).unwrap()).unwrap();
    assert_eq!(result["terminalDeletion"], true);
    assert_eq!(result["recoveryRetainedDeletion"], true);
    let id = crate::ids::Id::decode(result["deletedMember"].as_str().unwrap()).unwrap();
    let tenant = first.tenant("member-deletion-tenant").unwrap();
    let account = tenant
        .read::<Account>(accounts::account_key(id.0))
        .await
        .unwrap()
        .value
        .unwrap();
    assert!(account.deleted_at.is_some());
    assert!(!account.active(Utc::now()));
    let directory = tenant
        .read::<i64>(key("member-directory", &format!("{:020}", id.0)))
        .await
        .unwrap();
    assert!(directory.value.is_none());
    assert_protected_collection(&tenant, "accounts").await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn first_owner_setup_cannot_reopen_a_claimed_tenant() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
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
    browser("owner", &root, Some(&endpoints)).await;
    let tenant = first.tenant("new-tenant").unwrap();
    let provisioning = tenant
        .read::<crate::control::tenants::Provisioning>(crate::control::tenants::provisioning_key())
        .await
        .unwrap()
        .value
        .unwrap();
    assert!(provisioning.registered_at.is_some());
    assert!(
        tenant
            .read::<crate::control::tenants::SetupGrant>(crate::control::tenants::setup_grant_key())
            .await
            .unwrap()
            .value
            .is_none()
    );
    let account = tenant
        .read::<Account>(accounts::account_key(provisioning.owner_id))
        .await
        .unwrap()
        .value
        .unwrap();
    let key_state = tenant
        .read::<super::super::setup::RootState>(super::super::setup::root_key())
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(
        key_state.profile.owner.user,
        format!("user:{}", crate::ids::Id(account.id).encode())
    );
    // Move only this disposable queue's clock forward. The application still
    // performs real compare-and-swap reclamation through an independent API.
    let jobs = tenant
        .scan::<Value>("timestamp-jobs", None, None)
        .await
        .unwrap();
    assert_eq!(jobs.records.len(), 2);
    let due = tenant
        .scan::<String>("timestamp-due", None, None)
        .await
        .unwrap();
    let mut expire_jobs = tenant.transaction().unwrap();
    let past = chrono::Utc::now() - chrono::Duration::seconds(1);
    let mut stale_leases = Vec::new();
    for row in jobs.records {
        let mut job = row.value.unwrap();
        let digest = row.record.key.strip_prefix("t_").unwrap();
        stale_leases.push(serde_json::json!({"digest": digest, "lease": job["lease"]}));
        let due_row = due
            .records
            .iter()
            .find(|row| row.value.as_deref() == Some(digest))
            .unwrap();
        let prefix = due_row.record.key.split(':').next().unwrap();
        let next = key(
            "timestamp-due",
            &format!("{prefix}:{:020}:{digest}", past.timestamp_micros()),
        );
        expire_jobs.delete(due_row.record.clone()).await.unwrap();
        expire_jobs.put(next, digest).await.unwrap();
        job["nextAttempt"] = serde_json::to_value(past).unwrap();
        if !job["lease"].is_null() {
            job["leaseExpires"] = serde_json::to_value(past).unwrap();
        }
        expire_jobs.put(row.record, &job).await.unwrap();
    }
    expire_jobs.commit().await.unwrap();
    std::fs::write(
        root.join("timestamp-leases.json"),
        serde_json::to_vec(&stale_leases).unwrap(),
    )
    .unwrap();
    browser("timestamp-retry", &root, Some(&endpoints)).await;
    for collection in [
        "crypto-root",
        "tenant-status",
        "accounts",
        "policies",
        "policy-generations",
        "authority-history",
        "identity-history",
        "domain-definitions",
        "key-envelopes",
        "recovery-inventory-1",
        "timestamp-targets",
        "timestamp-index",
        "documents",
    ] {
        assert_protected_collection(&tenant, collection).await;
    }
    // Once evidence exists, a raw metadata write cannot erase it. Optional
    // queue state remains removable without reopening the signed document.
    let targets = tenant
        .scan::<Value>("timestamp-targets", None, None)
        .await
        .unwrap();
    assert_eq!(targets.records.len(), 2);
    let mut erase_evidence = tenant.transaction().unwrap();
    for target in &targets.records {
        let digest = target.value.as_ref().unwrap()["target"]["digest"]
            .as_str()
            .unwrap();
        let collection = format!("timestamp-proofs-{digest}");
        let proofs = tenant.scan::<Value>(&collection, None, None).await.unwrap();
        for row in proofs.records {
            erase_evidence.delete(row.record).await.unwrap();
        }
    }
    for collection in [
        "timestamp-targets",
        "timestamp-index",
        "timestamp-jobs",
        "timestamp-due",
        "timestamp-queues",
        "stock-deletions",
    ] {
        let rows = tenant.scan::<Value>(collection, None, None).await.unwrap();
        assert!(rows.after.is_none());
        for row in rows.records {
            erase_evidence.delete(row.record).await.unwrap();
        }
    }
    assert!(erase_evidence.commit().await.is_err());
    let mut erase_queue_state = tenant.transaction().unwrap();
    for collection in [
        "timestamp-jobs",
        "timestamp-due",
        "timestamp-queues",
        "stock-deletions",
    ] {
        let rows = tenant.scan::<Value>(collection, None, None).await.unwrap();
        assert!(rows.after.is_none());
        for row in rows.records {
            erase_queue_state.delete(row.record).await.unwrap();
        }
    }
    erase_queue_state.commit().await.unwrap();
    browser("locks", &root, Some(&endpoints)).await;
    browser("invitations", &root, Some(&endpoints)).await;
    // A valid authority certificate alone must not make substituted policy
    // counters authoritative, even through the public recovery-head path.
    let current_root: super::super::setup::RootState = tenant
        .read(super::super::setup::root_key())
        .await
        .unwrap()
        .value
        .unwrap();
    let mut substituted = current_root.clone();
    substituted.policy_version = super::super::crypto::revision(&current_root.policy_version)
        .unwrap()
        .checked_add(1)
        .unwrap()
        .to_string();
    let mut tamper = tenant.transaction().unwrap();
    tamper
        .put(super::super::setup::root_key(), &substituted)
        .await
        .unwrap();
    assert!(tamper.commit().await.is_err());
    assert_eq!(
        super::super::setup::public_root(&first, "new-tenant")
            .await
            .unwrap()
            .policy_version,
        current_root.policy_version,
    );
    // A deleted grant or root field must not turn this tenant into a new tenant.
    let mut broken = tenant.transaction().unwrap();
    broken
        .delete(super::super::setup::root_key())
        .await
        .unwrap();
    assert!(broken.commit().await.is_err());
    let request = crate::control::tenants::ProvisionRequest {
        name: "new-tenant".into(),
        operation: random_id().unwrap(),
        setup_token_hash: encode(&[1; 32]),
    };
    assert!(
        crate::control::tenants::renew_setup(&first, &request)
            .await
            .is_err()
    );
    assert!(
        crate::control::tenants::provision(&first, &request)
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB and loopback listeners"]
async fn tenant_publication_resumes_without_replacing_its_file_or_setup_capability() {
    use crate::control::tenants::{self, ProvisionRequest, Provisioning, SetupGrant};
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config).unwrap());
    let request = ProvisionRequest {
        name: "interrupted-publication".into(),
        operation: random_id().unwrap(),
        setup_token_hash: encode(&[7; 32]),
    };
    tenants::provision(&first, &request).await.unwrap();
    let tenant = first.tenant(&request.name).unwrap();
    let prepared = tenant
        .read::<Provisioning>(tenants::provisioning_key())
        .await
        .unwrap()
        .value
        .unwrap();
    // Recreate the state after the tenant-file commit and before publication.
    // Only the original operation may resume it; no new owner ID is allocated.
    let mut interruption = first.transaction().unwrap();
    interruption
        .delete(key("tenants", &request.name))
        .await
        .unwrap();
    interruption.commit().await.unwrap();
    let competing = ProvisionRequest {
        operation: random_id().unwrap(),
        setup_token_hash: encode(&[8; 32]),
        ..request.clone()
    };
    assert_eq!(
        tenants::provision(&second, &competing)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    let resumed = tenants::provision(&second, &request).await.unwrap();
    assert_eq!(resumed.created_at, prepared.created_at);
    let current = tenant
        .read::<Provisioning>(tenants::provisioning_key())
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(current.owner_id, prepared.owner_id);
    assert_eq!(current.initial_token_hash, request.setup_token_hash);
    let grant = tenant
        .read::<SetupGrant>(tenants::setup_grant_key())
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(grant.hash, request.setup_token_hash);

    let one = ProvisionRequest {
        name: "concurrent-provisioning".into(),
        operation: random_id().unwrap(),
        setup_token_hash: encode(&[9; 32]),
    };
    let two = ProvisionRequest {
        operation: random_id().unwrap(),
        setup_token_hash: encode(&[10; 32]),
        ..one.clone()
    };
    let (first_result, second_result) = tokio::join!(
        tenants::provision(&first, &one),
        tenants::provision(&second, &two)
    );
    assert_ne!(first_result.is_ok(), second_result.is_ok());
    let (winner, loser) = if first_result.is_ok() {
        (&one, &two)
    } else {
        (&two, &one)
    };
    tenants::provision(&first, winner).await.unwrap();
    assert_eq!(
        tenants::provision(&second, loser).await.err().unwrap().code,
        ErrorCode::Conflict
    );
    let registered = first
        .tenant(&one.name)
        .unwrap()
        .read::<Provisioning>(tenants::provisioning_key())
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(registered.operation, winner.operation);
    assert_eq!(registered.initial_token_hash, winner.setup_token_hash);

    // A check of an empty collection must include accounts added by another
    // instance after the check. Checking individual known IDs misses this race.
    let first_tenant = first.tenant(&one.name).unwrap();
    let second_tenant = second.tenant(&one.name).unwrap();
    let mut guarded = first_tenant.transaction().unwrap();
    let empty = guarded.scan::<String>("test-members", None).await.unwrap();
    assert!(empty.records.is_empty());
    guarded
        .put(key("test-decisions", "empty-members"), &true)
        .await
        .unwrap();
    let mut membership = second_tenant.transaction().unwrap();
    membership
        .put(key("test-members", "new-account"), &"member")
        .await
        .unwrap();
    membership.commit().await.unwrap();
    assert_eq!(
        guarded.commit().await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert!(
        first_tenant
            .read::<bool>(key("test-decisions", "empty-members"))
            .await
            .unwrap()
            .value
            .is_none()
    );
    let mut read = first_tenant.transaction().unwrap();
    read.scan::<String>("test-members", None).await.unwrap();
    let mut concurrent = second_tenant.transaction().unwrap();
    concurrent
        .put(key("test-members", "another-account"), &"member")
        .await
        .unwrap();
    concurrent.commit().await.unwrap();
    assert_eq!(read.validate().await.unwrap_err().code, ErrorCode::Conflict);
    let mut current = first_tenant.transaction().unwrap();
    assert_eq!(
        current
            .all::<String>("test-members", 10)
            .await
            .unwrap()
            .len(),
        2
    );
    current.validate().await.unwrap();
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn seed_recovery_is_atomic_across_independent_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
    let (store, probe, _proxy) = batching::measured_store(&config).await;
    let first = Repository::system(store);
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-owner-service-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first.clone())).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    let endpoints = [first_url, second_url];
    browser("owner-minimal", &root, Some(&endpoints)).await;
    probe.take_reads();
    browser("recovery", &root, Some(&endpoints)).await;
    let requests = probe.take_reads();
    assert!(requests.iter().all(|records| records.len() <= 1024));
    assert!(
        requests.iter().any(|records| {
            let definitions = records
                .iter()
                .filter(|record| record.collection == "domain-definitions")
                .collect::<Vec<_>>();
            if definitions.len() != 64 {
                return false;
            }
            // Several historical definitions may refer to the same domain.
            // Its head belongs in the request exactly once.
            let expected_domains = definitions
                .iter()
                .map(|record| {
                    let (domain_and_generation, _) = record.key.rsplit_once(':')?;
                    let (domain, _) = domain_and_generation.rsplit_once(':')?;
                    Some(domain)
                })
                .collect::<Option<std::collections::BTreeSet<_>>>();
            let Some(expected_domains) = expected_domains else {
                return false;
            };
            let domains = records
                .iter()
                .filter(|record| record.collection == "domains")
                .map(|record| record.key.as_str())
                .collect::<std::collections::BTreeSet<_>>();
            let access = records
                .iter()
                .filter(|record| record.collection == "domain-access")
                .map(|record| record.key.as_str())
                .collect::<std::collections::BTreeSet<_>>();
            domains == expected_domains
                && access == domains
                && records.len() == definitions.len() + domains.len() + access.len()
        }),
        "Recovery must read 64 definitions, their distinct domains and protected access states in one HTTP request"
    );
    let tenant = first.tenant("recovery-tenant").unwrap();
    assert_published_catalog_pages(&tenant, 2).await;
    assert_published_catalog_pages(&tenant, 3).await;
    for collection in [
        "domain-inventory",
        "recovery-inventory-3",
        "authority-history",
        "accounts",
        "domain-definitions",
        "key-envelopes",
        "domain-access",
    ] {
        assert_protected_collection(&tenant, collection).await;
    }
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn seed_recovery_preserves_more_than_ten_thousand_key_generations() {
    use sortsys_zerotrust::recovery_inventory::RecoveryInventory;
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
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
    browser("owner-minimal", &root, Some(&endpoints)).await;
    browser("recovery-scale", &root, Some(&endpoints)).await;
    let report: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("report.json")).unwrap()).unwrap();
    assert!(report["originalKeys"].as_u64().unwrap() > 10_000);
    let tenant = first.tenant("recovery-tenant").unwrap();
    let inventory = tenant
        .read::<RecoveryInventory>(crate::zerotrust::recovery::inventory::record_key())
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(
        u64::from(inventory.domains),
        report["domains"].as_u64().unwrap()
    );
    assert_eq!(
        u64::from(inventory.key_generations),
        report["finalKeys"].as_u64().unwrap()
    );
    assert_protected_collection(&tenant, "domain-inventory").await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn local_document_search_enforces_live_access_across_independent_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let store = QuackConfig::from_env().unwrap().unwrap();
    assert!(store.control_url.starts_with("http://127.0.0.1:"));
    let first = Repository::system(CipherStore::new(store.clone()).unwrap());
    let second = Repository::system(CipherStore::new(store.clone()).unwrap());
    let mut settings = configuration(store);
    settings.jwt_secret = Arc::from(b"disposable-owner-service-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    let endpoints = [first_url, second_url];
    browser_with_tenant(
        "owner-minimal",
        &root,
        Some(&endpoints),
        Some("document-search-tenant"),
    )
    .await;
    browser_with_tenant(
        "document-search",
        &root,
        Some(&endpoints),
        Some("document-search-tenant"),
    )
    .await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn delegated_administration_uses_own_keys_and_revokes_across_independent_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let store = QuackConfig::from_env().unwrap().unwrap();
    assert!(store.control_url.starts_with("http://127.0.0.1:"));
    let mut settings = configuration(store);
    settings.jwt_secret = Arc::from(b"disposable-owner-service-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let mut first = processes::ApiProcess::start(&settings, &root, "first").await;
    let mut second = processes::ApiProcess::start(&settings, &root, "second").await;
    assert_ne!(first.pid, second.pid);
    let endpoints = [first.endpoint.clone(), second.endpoint.clone()];
    for mode in ["owner-minimal", "administration"] {
        browser_with_tenant(mode, &root, Some(&endpoints), Some("administration-tenant")).await;
    }
    first.stop().await;
    second.stop().await;
    let processes = serde_json::json!({
        "parentPid": std::process::id(),
        "apiPids": [first.pid, second.pid],
        "endpoints": endpoints,
        "stopped": true,
    });
    std::fs::write(root.join("api-processes.json"), processes.to_string()).unwrap();
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB and loopback listeners"]
async fn standalone_startup_needs_only_duckdb_and_closes_old_plaintext_routes() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let store = QuackConfig::from_env().unwrap().unwrap();
    assert!(store.control_url.starts_with("http://127.0.0.1:"));
    assert!(store.token.starts_with("sortsys-disposable-"));
    let settings = crate::standalone::Config {
        port: 0,
        jwt_secret: Arc::from(b"disposable-standalone-runtime-secret-2026".as_slice()),
        admin_hash: bcrypt::hash("Disposable-operator-password-2026!", 4)
            .unwrap()
            .into(),
        store,
        editors: crate::editors::EditorConfig::default(),
        passkeys: crate::zerotrust::passkeys::Config::default(),
    };
    let router = crate::standalone::connect(&settings).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _server = ApiTask(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let client = reqwest::Client::new();
    let response: Value = client
        .get(format!("http://{address}/ping"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["result"]["data"]["json"], "pong", "{response}");
    for path in ["users.list", "projects.list", "auth.login"] {
        let request = if path == "auth.login" {
            client
                .post(format!("http://{address}/{path}"))
                .json(&serde_json::json!({"json": null}))
        } else {
            client.get(format!("http://{address}/{path}"))
        };
        let response: Value = request.send().await.unwrap().json().await.unwrap();
        assert_eq!(
            response["error"]["json"]["data"]["code"], "NOT_FOUND",
            "The native runtime must never dispatch {path} to a plaintext procedure"
        );
    }
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn first_administrator_finishes_setup_before_business_access() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    let mut settings = configuration(config);
    // Other scenarios deliberately exhaust the operator's shared login quota.
    // This independently configured installation keeps its own admission scope.
    settings.jwt_secret =
        Arc::from(b"disposable-initialization-service-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    processes::run_browser(&settings, &root, "owner-bootstrap").await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn prepared_business_changes_publish_atomically_across_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let (first_store, first_probe, _first_proxy) = batching::measured_store(&config).await;
    let (second_store, second_probe, _second_proxy) = batching::measured_store(&config).await;
    let first = Repository::system(first_store);
    let second = Repository::system(second_store);
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-prepared-metadata-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser("owner-staging", &root, Some(&[first_url, second_url])).await;
    let scans = [first_probe.take_scans(), second_probe.take_scans()];
    assert!(
        scans.iter().flatten().any(|ranges| *ranges == 2),
        "the grouped object-page RPC must send two ranges in one store request"
    );
    let reads = [first_probe.take_reads(), second_probe.take_reads()];
    let selected_product_batches = reads
        .iter()
        .flatten()
        .filter(|records| {
            records.len() == 32
                && records.iter().all(|record| {
                    record.collection == "object-locations" && record.key.starts_with("product:")
                })
        })
        .count();
    assert_eq!(
        selected_product_batches, 10,
        "320 products need one location lookup per group of 32"
    );
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn print_templates_preserve_encrypted_assets_and_permissions_across_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-print-template-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser(
        "owner-print-templates",
        &root,
        Some(&[first_url, second_url]),
    )
    .await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn own_planning_records_use_exact_recipient_keys_across_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-own-planning-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    processes::run_browser(&settings, &root, "owner-planning-recipients").await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn tool_booking_batches_publish_atomically_across_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-tool-booking-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first.clone())).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser("owner-tool-batches", &root, Some(&[first_url, second_url])).await;
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("tool-authorization-witness.json")).unwrap(),
    )
    .unwrap();
    let tenant = first.tenant(fixture["tenant"].as_str().unwrap()).unwrap();
    for collection in [
        "domain-access",
        "creation-capabilities",
        "created-areas-1",
        crate::zerotrust::tool_returns::RECEIPTS,
    ] {
        assert_protected_collection(&tenant, collection).await;
    }
    let domain = fixture["domain"].as_str().unwrap();
    let original: crate::zerotrust::creation::CreationOrigin =
        serde_json::from_value(fixture["origin"].clone()).unwrap();
    let security = tenant
        .read::<crate::zerotrust::setup::RootState>(crate::zerotrust::setup::root_key())
        .await
        .unwrap()
        .value
        .unwrap();
    original
        .verify(
            &crate::zerotrust::crypto::sized::<32>(
                &security.profile.authority.authority_signing_key,
            )
            .unwrap(),
        )
        .unwrap();
    assert!(original.access.as_ref().unwrap().active);
    let record = key("created-areas-1", domain);
    let current = tenant.read::<Value>(record.clone()).await.unwrap();
    assert_eq!(current.value.as_ref().unwrap()["access"]["active"], false);
    let mut replay = tenant.transaction().unwrap();
    replay.put(record.clone(), &original).await.unwrap();
    assert!(
        replay.commit().await.is_err(),
        "A valid earlier active proof must not overwrite its independent current witness"
    );
    let retained = tenant.read::<Value>(record).await.unwrap();
    assert_eq!(retained.value, current.value);
    assert_eq!(retained.version, current.version);
    let mut read = tenant.transaction().unwrap();
    let area = crate::zerotrust::objects::registry::domain(&mut read, domain)
        .await
        .unwrap();
    let access = tenant
        .read::<Value>(key("domain-access", domain))
        .await
        .unwrap();
    let mut altered = area.clone();
    altered.recipients.clear();
    let mut substitution = tenant.transaction().unwrap();
    substitution
        .put(key("domains", domain), &altered)
        .await
        .unwrap();
    substitution.commit().await.unwrap();
    let mut rejected = tenant.transaction().unwrap();
    assert!(
        crate::zerotrust::objects::registry::domain(&mut rejected, domain)
            .await
            .is_err(),
        "A restored or substituted membership must not bypass its independent access state"
    );
    let mut cursor = area.clone();
    cursor.sequence = (cursor.sequence.parse::<u64>().unwrap() + 1).to_string();
    let mut advance = tenant.transaction().unwrap();
    advance.put(key("domains", domain), &cursor).await.unwrap();
    advance.commit().await.unwrap();
    let mut current = tenant.transaction().unwrap();
    let restored = crate::zerotrust::objects::registry::domain(&mut current, domain)
        .await
        .unwrap();
    assert_eq!(restored.sequence, cursor.sequence);
    let retained_access = tenant
        .read::<Value>(key("domain-access", domain))
        .await
        .unwrap();
    assert_eq!(retained_access.value, access.value);
    assert_eq!(retained_access.version, access.version);
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn backup_source_must_complete_before_initialization_on_any_api_instance() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-backup-bootstrap-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser("owner-backup", &root, Some(&[first_url, second_url])).await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn local_backup_archive_resumes_without_any_plaintext_source_service() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-encrypted-backup-archive-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser(
        "owner-backup-archive",
        &root,
        Some(&[first_url, second_url]),
    )
    .await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB and loopback listeners"]
async fn development_seed_creates_ready_accounts_and_preserves_manual_edits() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let store = QuackConfig::from_env().unwrap().unwrap();
    assert!(store.control_url.starts_with("http://127.0.0.1:"));
    assert!(store.token.starts_with("sortsys-disposable-"));
    let mut settings = configuration(store);
    settings.jwt_secret = Arc::from(b"disposable-development-seed-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-development-operator-2026!", 4)
        .unwrap()
        .into();
    processes::run_browser(&settings, &root, "development-seed").await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB and loopback listeners"]
async fn operator_diagnostics_reject_private_contents_and_share_limits() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let store = QuackConfig::from_env().unwrap().unwrap();
    assert!(store.control_url.starts_with("http://127.0.0.1:"));
    assert!(store.token.starts_with("sortsys-disposable-"));
    let first = Repository::system(CipherStore::new(store.clone()).unwrap());
    let second = Repository::system(CipherStore::new(store.clone()).unwrap());
    let mut settings = configuration(store);
    settings.jwt_secret = Arc::from(b"disposable-operator-telemetry-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-telemetry-operator-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser("telemetry", &root, Some(&[first_url, second_url])).await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn access_inventories_page_across_api_instances_without_tracking_content_revisions() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret = Arc::from(b"disposable-access-pages-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser("owner-access-pages", &root, Some(&[first_url, second_url])).await;
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB, Bun and loopback listeners"]
async fn access_publications_commit_grants_and_rotations_atomically_across_api_instances() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var("SORTSYS_NATIVE_AUTH_ROOT").unwrap());
    let config = QuackConfig::from_env().unwrap().unwrap();
    let first = Repository::system(CipherStore::new(config.clone()).unwrap());
    let second = Repository::system(CipherStore::new(config.clone()).unwrap());
    let mut settings = configuration(config);
    settings.jwt_secret =
        Arc::from(b"disposable-access-publication-signing-secret-2026".as_slice());
    settings.admin_hash = bcrypt::hash("Disposable-operator-password-2026!", 4)
        .unwrap()
        .into();
    let (first_url, _first_api) = api(auth_service(&settings, first)).await;
    let (second_url, _second_api) = api(auth_service(&settings, second)).await;
    browser(
        "owner-access-publications",
        &root,
        Some(&[first_url, second_url]),
    )
    .await;
}
