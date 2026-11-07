//! Session revocation and authentication boundaries over the real transports.
use super::*;

async fn login(rpc: &RpcClient, fixture: &Fixture, password: &str) -> String {
    rpc.mutation(
        "auth.login",
        json!({
            "tenant": fixture.tenant,
            "username": fixture.admin_username,
            "password": password,
        }),
        None,
    )
    .await["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn wait_for_user_lock(pool: &PgPool) {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
                 WHERE datname = current_database() AND wait_event_type = 'Lock' \
                 AND (query LIKE 'SELECT id FROM users WHERE %' \
                      OR query LIKE 'UPDATE users SET password = %' \
                      OR query LIKE 'INSERT INTO user_sessions%'))",
            )
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn changing_password_revokes_other_sessions_and_an_admin_reset_revokes_all() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let first = login(&rpc, &fixture, &fixture.admin_password).await;
    let second = login(&rpc, &fixture, &fixture.admin_password).await;
    let new_password = "Changed-Password-2026!";
    rpc.mutation(
        "auth.setPassword",
        json!({"username": fixture.admin_username, "password": new_password}),
        Some(&first),
    )
    .await;
    rpc.query("auth.check", Value::Null, Some(&first)).await;
    rpc.expect_error(
        "auth.check",
        Method::GET,
        Value::Null,
        Some(&second),
        "UNAUTHORIZED",
    )
    .await;
    let third = login(&rpc, &fixture, new_password).await;

    // A different tenant administrator resets the account: no target session
    // should survive, including the session kept by the previous self-change.
    let other_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (username, first_name, password, deactivated_at) VALUES ('reset.admin', 'Reset', $1, NULL) RETURNING id",
    )
    .bind(hash("Reset-Administrator-2026!", 4).unwrap())
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_role_assignments (user_id, role_name) VALUES ($1, ':admin')")
        .bind(other_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    let reset_login = rpc.mutation("auth.login", json!({
        "tenant": fixture.tenant, "username": "reset.admin", "password": "Reset-Administrator-2026!"
    }), None).await;
    let reset_token = reset_login["token"].as_str().unwrap();
    rpc.mutation(
        "auth.setPassword",
        json!({
            "username": fixture.admin_username, "password": "Reset-Target-Password-2026!"
        }),
        Some(reset_token),
    )
    .await;
    for token in [&first, &third] {
        rpc.expect_error(
            "auth.check",
            Method::GET,
            Value::Null,
            Some(token),
            "UNAUTHORIZED",
        )
        .await;
    }
    rpc.query("auth.check", Value::Null, Some(reset_token))
        .await;
    login(&rpc, &fixture, "Reset-Target-Password-2026!").await;
}

#[tokio::test]
async fn a_login_verified_before_a_password_reset_cannot_create_a_session_after_it() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let mut reset = fixture.tenant_pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(fixture.user_id)
        .execute(&mut *reset)
        .await
        .unwrap();
    let rpc = RpcClient::new(environment.api_base_url);
    let input = json!({
        "tenant": fixture.tenant, "username": fixture.admin_username, "password": fixture.admin_password
    });
    let pending_login =
        tokio::spawn(async move { rpc.call("auth.login", Method::POST, input, None).await });
    // Wait until the password has been verified and session creation is waiting
    // on our user-row lock. No timing assumption about bcrypt is necessary.
    wait_for_user_lock(&fixture.tenant_pool).await;
    sqlx::query("UPDATE users SET password = $2 WHERE id = $1")
        .bind(fixture.user_id)
        .bind(hash("Race-Reset-Password-2026!", 4).unwrap())
        .execute(&mut *reset)
        .await
        .unwrap();
    reset.commit().await.unwrap();
    let result = pending_login.await.unwrap();
    assert!(
        result.is_err(),
        "an old password must not create a session after reset"
    );
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_sessions WHERE user_id = $1")
        .bind(fixture.user_id)
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
}

#[tokio::test]
async fn an_inflight_password_change_cannot_overwrite_a_reset_that_revoked_its_session() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let token = login(&rpc, &fixture, &fixture.admin_password).await;
    let mut reset = fixture.tenant_pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(fixture.user_id)
        .execute(&mut *reset)
        .await
        .unwrap();
    let input = json!({"username": fixture.admin_username, "password": "Inflight-Password-2026!"});
    let pending_change = tokio::spawn(async move {
        rpc.call("auth.setPassword", Method::POST, input, Some(&token))
            .await
    });
    wait_for_user_lock(&fixture.tenant_pool).await;
    let reset_hash = hash("Administrator-Reset-2026!", 4).unwrap();
    sqlx::query("UPDATE users SET password = $2 WHERE id = $1")
        .bind(fixture.user_id)
        .bind(&reset_hash)
        .execute(&mut *reset)
        .await
        .unwrap();
    sqlx::query("UPDATE user_sessions SET expires_at = statement_timestamp() WHERE user_id = $1")
        .bind(fixture.user_id)
        .execute(&mut *reset)
        .await
        .unwrap();
    reset.commit().await.unwrap();
    let error = pending_change
        .await
        .unwrap()
        .expect_err("revoked session must not change password");
    assert_eq!(error.code, "UNAUTHORIZED");
    let stored: String = sqlx::query_scalar("SELECT password FROM users WHERE id = $1")
        .bind(fixture.user_id)
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert_eq!(stored, reset_hash);
}

#[tokio::test]
async fn worker_sockets_require_authentication_even_when_the_peer_keeps_sending() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let url = format!(
        "{}/internal/job-runners/ws",
        environment.api_base_url.replacen("http", "ws", 1)
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    socket.send(tokio_tungstenite::tungstenite::Message::Text(
                        json!({"type":"jobs.poll"}).to_string().into(),
                    )).await.unwrap();
                }
                message = socket.next() => {
                    match message.unwrap().unwrap() {
                        tokio_tungstenite::tungstenite::Message::Close(frame) => {
                            let frame = frame.expect("authentication timeout must include a close code");
                            assert_eq!(u16::from(frame.code), 1008);
                            assert_eq!(frame.reason, "Authentication timed out");
                            break;
                        }
                        tokio_tungstenite::tungstenite::Message::Text(text) => {
                            let error: Value = serde_json::from_str(&text).unwrap();
                            assert_eq!(error["type"], "error");
                        }
                        other => panic!("unexpected worker message: {other:?}"),
                    }
                }
            }
        }
    }).await.expect("unauthenticated activity must not extend the deadline");
}
