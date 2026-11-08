//! Two separately initialized APIs sharing only PostgreSQL and JWT configuration.
use super::*;
use std::sync::Arc;

struct Replicas {
    a: Arc<AppState>,
    b: Arc<AppState>,
    first: RpcClient,
    second: RpcClient,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    environment: TestEnvironment,
    postgres: PgPool,
    database: String,
}

impl Replicas {
    async fn new(environment: &TestEnvironment) -> Self {
        let mut url = Url::parse(&environment.master_dsn).unwrap();
        url.set_path("/postgres");
        let postgres = PgPool::connect(url.as_str()).await.unwrap();
        let database = format!("login_limits_{}", unique_suffix());
        sqlx::query(&format!("CREATE DATABASE \"{database}\""))
            .execute(&postgres)
            .await
            .unwrap();
        url.set_path(&format!("/{database}"));
        let mut environment = environment.clone();
        environment.master_dsn = url.to_string();
        let mut config = Config::from_env().unwrap();
        config.master_dsn = Arc::from(environment.master_dsn.as_str());
        let (a, b) = tokio::join!(AppState::connect(config.clone()), AppState::connect(config));
        let (a, b) = (a.unwrap(), b.unwrap());
        let mut clients = Vec::new();
        let mut tasks = Vec::new();
        for state in [&a, &b] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            clients.push(RpcClient::new(format!(
                "http://{}",
                listener.local_addr().unwrap()
            )));
            let app = sortsys_api::app_with_state(Arc::clone(state));
            tasks.push(tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            }));
        }
        let first = clients.remove(0);
        let second = clients.remove(0);
        Self {
            a,
            b,
            first,
            second,
            tasks,
            environment,
            postgres,
            database,
        }
    }

    async fn close(self) {
        for task in self.tasks {
            task.abort();
        }
        self.a.tenants.close().await;
        self.b.tenants.close().await;
        sqlx::query(&format!("DROP DATABASE \"{}\" WITH (FORCE)", self.database))
            .execute(&self.postgres)
            .await
            .unwrap();
        self.postgres.close().await;
    }
}

async fn user_login(state: &AppState, fixture: &Fixture, password: &str) -> Option<String> {
    state
        .auth
        .login(
            &fixture.tenant,
            &fixture.admin_username,
            password,
            None,
            None,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn login_budgets_are_atomic_across_replicas_and_recover_without_resetting_other_failures() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let replicas = Replicas::new(&environment).await;
    let fixture = Fixture::create(&replicas.environment).await;

    // Successful logins do not exhaust a budget, including on another replica.
    for index in 0..12 {
        let state = if index % 2 == 0 {
            &replicas.a
        } else {
            &replicas.b
        };
        assert!(
            user_login(state, &fixture, &fixture.admin_password)
                .await
                .is_some()
        );
    }
    let (key, initial, _): (Vec<u8>, i16, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT account_key, attempts, expires_at FROM __login_attempts")
            .fetch_one(replicas.a.tenants.master())
            .await
            .unwrap();
    assert_eq!(initial, 0);

    // Reserve all ten attempts concurrently over both real HTTP servers.
    let input = json!({"tenant": fixture.tenant, "username": fixture.admin_username, "password":"incorrect-password"});
    let failures = futures_util::future::join_all((0..10).map(|index| {
        let rpc = if index % 2 == 0 {
            &replicas.first
        } else {
            &replicas.second
        };
        rpc.call("auth.login", Method::POST, input.clone(), None)
    }))
    .await;
    for result in failures {
        assert_eq!(result.unwrap_err().code, "UNAUTHORIZED");
    }
    let (count, expiry): (i16, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT attempts, expires_at FROM __login_attempts WHERE account_key=$1")
            .bind(&key)
            .fetch_one(replicas.a.tenants.master())
            .await
            .unwrap();
    assert_eq!(count, 10);

    // Case changes, whitespace, spoofed proxy addresses and another API do not
    // create another account budget. A valid password is also refused now.
    let response: Value = replicas.second.http.post(format!("{}/auth.login", replicas.second.base_url))
        .header("x-forwarded-for", "198.51.100.77")
        .json(&json!({"json":{"tenant":format!(" {} ", fixture.tenant.to_uppercase()),
            "username":format!(" {} ", fixture.admin_username.to_uppercase()),"password":fixture.admin_password}}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(
        response["error"]["json"]["data"]["code"],
        "TOO_MANY_REQUESTS"
    );
    assert_eq!(response["error"]["json"]["data"]["httpCode"], 429);
    let unchanged: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT expires_at FROM __login_attempts WHERE account_key=$1")
            .bind(&key)
            .fetch_one(replicas.a.tenants.master())
            .await
            .unwrap();
    assert_eq!(expiry, unchanged, "rejected requests extended the lockout");
    let other = Fixture::create(&replicas.environment).await;
    assert!(
        user_login(&replicas.a, &other, &other.admin_password)
            .await
            .is_some()
    );

    // Advance only this account's expiry, rather than sleeping fifteen minutes.
    sqlx::query("UPDATE __login_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE account_key=$1")
        .bind(&key).execute(replicas.a.tenants.master()).await.unwrap();
    assert!(
        user_login(&replicas.b, &fixture, &fixture.admin_password)
            .await
            .is_some()
    );

    // A request from an expired window must not refund a later failed attempt.
    let mut held = fixture.tenant_pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(fixture.user_id)
        .execute(&mut *held)
        .await
        .unwrap();
    let state = Arc::clone(&replicas.a);
    let tenant = fixture.tenant.clone();
    let username = fixture.admin_username.clone();
    let password = fixture.admin_password.clone();
    let pending = tokio::spawn(async move {
        state
            .auth
            .login(&tenant, &username, &password, None, None)
            .await
    });
    super::security::wait_for_user_lock(&fixture.tenant_pool).await;
    sqlx::query("UPDATE __login_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE account_key=$1")
        .bind(&key).execute(replicas.b.tenants.master()).await.unwrap();
    assert!(
        user_login(&replicas.b, &fixture, "incorrect-password")
            .await
            .is_none()
    );
    held.commit().await.unwrap();
    assert!(pending.await.unwrap().unwrap().is_some());
    let count: i16 =
        sqlx::query_scalar("SELECT attempts FROM __login_attempts WHERE account_key=$1")
            .bind(&key)
            .fetch_one(replicas.a.tenants.master())
            .await
            .unwrap();
    assert_eq!(count, 1, "an old successful request erased a new failure");

    // Unknown accounts and tenants receive the same accounting before lookup.
    for tenant in [&fixture.tenant, &format!("missing-{}", unique_suffix())] {
        for index in 0..10 {
            let state = if index % 2 == 0 {
                &replicas.a
            } else {
                &replicas.b
            };
            assert!(
                state
                    .auth
                    .login(tenant, "unknown.user", "incorrect-password", None, None)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let error = replicas
            .b
            .auth
            .login(tenant, "UNKNOWN.USER", "incorrect-password", None, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, sortsys_api::error::ErrorCode::TooManyRequests);
    }

    // No password verification or session may bypass unavailable shared state.
    sqlx::query("ALTER TABLE __login_attempts RENAME TO unavailable_login_attempts")
        .execute(replicas.a.tenants.master())
        .await
        .unwrap();
    let error = replicas
        .b
        .auth
        .login(
            &fixture.tenant,
            &fixture.admin_username,
            &fixture.admin_password,
            None,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.http_code, Some(503));
    sqlx::query("ALTER TABLE unavailable_login_attempts RENAME TO __login_attempts")
        .execute(replicas.a.tenants.master())
        .await
        .unwrap();
    replicas.close().await;
}

#[tokio::test]
async fn administrator_passwords_share_the_policy_and_success_does_not_erase_failed_attempts() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let replicas = Replicas::new(&environment).await;
    let fixture = Fixture::create(&replicas.environment).await;
    sqlx::query("UPDATE __tenants SET admin_hash=$2 WHERE name=$1")
        .bind(&fixture.tenant)
        .bind(hash(&fixture.admin_password, 4).unwrap())
        .execute(replicas.a.tenants.master())
        .await
        .unwrap();
    let global_password = env::var("TEST_ADMIN_PASSWORD").unwrap();

    for (tenant, password) in [
        (
            Some(fixture.tenant.as_str()),
            fixture.admin_password.as_str(),
        ),
        (None, global_password.as_str()),
    ] {
        for index in 0..5 {
            let state = if index % 2 == 0 {
                &replicas.a
            } else {
                &replicas.b
            };
            assert!(
                state
                    .auth
                    .login_admin("incorrect-password", tenant)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            replicas
                .b
                .auth
                .login_admin(password, tenant)
                .await
                .unwrap()
                .is_some()
        );
        for _ in 0..5 {
            assert!(
                replicas
                    .a
                    .auth
                    .login_admin("incorrect-password", tenant)
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let error = replicas
            .first
            .call(
                "admin.login",
                Method::POST,
                json!({"tenant":tenant,"password":password}),
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "TOO_MANY_REQUESTS");
    }
    // Expired keys are reclaimed in bounded batches on later admission.
    sqlx::query("UPDATE __login_attempts SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(replicas.a.tenants.master())
        .await
        .unwrap();
    assert!(
        replicas
            .b
            .auth
            .login_admin(&global_password, None)
            .await
            .unwrap()
            .is_some()
    );
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM __login_attempts")
        .fetch_one(replicas.a.tenants.master())
        .await
        .unwrap();
    assert_eq!(remaining, 1);
    replicas.close().await;
}
