//! Browser-generated ciphertext and real independent API states sharing PG.
use super::*;
use opaque_ke::{
    CipherSuite, ClientLogin, ClientLoginFinishParameters, CredentialResponse, Identifiers,
    rand::rngs::OsRng,
};
use std::sync::Arc;

struct Suite;

#[tokio::test]
async fn browser_row_model_is_derived_from_the_actual_migrated_schema() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let actual = sortsys_api::browser_schema::describe(&fixture.tenant_pool)
        .await
        .unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("../../schema/business.generated.json")).unwrap();
    assert_eq!(actual, expected);
    fixture.tenant_pool.close().await;
}
impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2_10::Sha512>;
    type Ksf = argon2::Argon2<'static>;
}
async fn serve(state: Arc<AppState>) -> (RpcClient, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc = RpcClient::new(format!("http://{}", listener.local_addr().unwrap()));
    let task = tokio::spawn(async move {
        axum::serve(listener, sortsys_api::app_with_state(state))
            .await
            .unwrap();
    });
    (rpc, task)
}

async fn setup_waits_for_an_inflight_legacy_write(
    first: &RpcClient,
    second: &RpcClient,
    pool: &PgPool,
    token: &str,
    setup: Value,
) {
    // Pause the business handler before its ordinary freeze trigger. Setup on
    // another node must wait without taking a state-row lock that would block
    // the handler it is waiting for.
    sqlx::raw_sql("CREATE FUNCTION test_pause_case() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(147830119); RETURN NEW; END $$; CREATE TRIGGER aaa_test_pause_case BEFORE INSERT ON commercial_cases FOR EACH ROW EXECUTE FUNCTION test_pause_case()")
        .execute(pool).await.unwrap();
    let mut pause = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(147830119)")
        .execute(&mut *pause)
        .await
        .unwrap();
    let writer = RpcClient::new(first.base_url.clone());
    let write_token = token.to_owned();
    let write = tokio::spawn(async move {
        writer
            .call(
                "commercial.cases.create",
                Method::POST,
                json!({"kind":"offer","title":"Before encrypted cutover"}),
                Some(&write_token),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%INSERT INTO commercial_cases%')").fetch_one(pool).await.unwrap();
            if waiting {break;}
            sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("legacy write never reached the pause");
    let initializer = RpcClient::new(second.base_url.clone());
    let setup_token = token.to_owned();
    let setup = tokio::spawn(async move {
        initializer
            .call("zerotrust.setup", Method::POST, setup, Some(&setup_token))
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%sortsys:zerotrust-cutover%')").fetch_one(pool).await.unwrap();
            if waiting {break;}
            sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("setup did not wait for the legacy request");
    pause.rollback().await.unwrap();
    let (write, setup) =
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(write, setup) })
            .await
            .expect("cutover and the business write deadlocked");
    assert!(write.unwrap().is_ok());
    assert!(setup.unwrap().is_ok());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM commercial_cases")
            .fetch_one(pool)
            .await
            .unwrap(),
        1
    );
    assert!(
        sqlx::query("UPDATE commercial_cases SET title='too late'")
            .execute(pool)
            .await
            .is_err()
    );
    sqlx::raw_sql(
        "DROP TRIGGER aaa_test_pause_case ON commercial_cases; DROP FUNCTION test_pause_case()",
    )
    .execute(pool)
    .await
    .unwrap();
}
async fn opaque_login(
    first: &RpcClient,
    second: &RpcClient,
    username: &str,
    password: &str,
) -> Value {
    let started = ClientLogin::<Suite>::start(&mut OsRng, password.as_bytes()).unwrap();
    let response=first.mutation("auth.opaque.loginStart",json!({"tenant":"test","username":username,"startLoginRequest":URL_SAFE_NO_PAD.encode(started.message.serialize())}),None).await;
    let ksf = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(65536, 3, 1, Some(64)).unwrap(),
    );
    let id = format!("test/{username}");
    let finished = started
        .state
        .finish(
            &mut OsRng,
            password.as_bytes(),
            CredentialResponse::deserialize(
                &URL_SAFE_NO_PAD
                    .decode(response["loginResponse"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap(),
            ClientLoginFinishParameters {
                context: None,
                identifiers: Identifiers {
                    client: Some(id.as_bytes()),
                    server: Some(b"sortsys/opaque/v1"),
                },
                ksf: Some(&ksf),
            },
        )
        .unwrap();
    second.mutation("auth.opaque.loginFinish",json!({"exchange":response["exchange"],"finishLoginRequest":URL_SAFE_NO_PAD.encode(finished.message.serialize())}),None).await
}

#[tokio::test]
async fn recovery_survives_a_failed_apply_and_two_replicas_cannot_reuse_the_old_phrase() {
    let Some(mut environment) = TestEnvironment::from_env() else {
        return;
    };
    let vector: Value =
        serde_json::from_str(include_str!("../fixtures/zerotrust-recovery.json")).unwrap();
    // Separate master: the vector deliberately uses the stable tenant "test".
    let mut url = Url::parse(&environment.master_dsn).unwrap();
    url.set_path("/postgres");
    let postgres = PgPool::connect(url.as_str()).await.unwrap();
    let database = format!("zerotrust_{}", unique_suffix());
    sqlx::query(&format!("CREATE DATABASE \"{database}\""))
        .execute(&postgres)
        .await
        .unwrap();
    url.set_path(&format!("/{database}"));
    environment.master_dsn = url.to_string();
    let mut config = Config::from_env().unwrap();
    config.master_dsn = Arc::from(environment.master_dsn.as_str());
    let (a, b) = tokio::join!(AppState::connect(config.clone()), AppState::connect(config));
    let (a, b) = (a.unwrap(), b.unwrap());
    let fixture = Fixture::create(&environment).await;
    sqlx::query("UPDATE __tenants SET name='test' WHERE name=$1")
        .bind(&fixture.tenant)
        .execute(a.tenants.master())
        .await
        .unwrap();
    sqlx::query("DELETE FROM user_role_assignments WHERE user_id=$1")
        .bind(fixture.user_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(fixture.user_id)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    let owner = Id::decode("interop").unwrap().0;
    sqlx::query("INSERT INTO users(id,username,first_name,password,deactivated_at) VALUES($1,$2,'Admin',$3,NULL)").bind(owner).bind(&fixture.admin_username).bind(hash(&fixture.admin_password,4).unwrap()).execute(&fixture.tenant_pool).await.unwrap();
    sqlx::query("INSERT INTO user_role_assignments(user_id,role_name) VALUES($1,':admin')")
        .bind(owner)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO __opaque_setup(singleton,server_setup) VALUES(TRUE,$1)")
        .bind(
            URL_SAFE_NO_PAD
                .decode(vector["opaqueServerSetup"].as_str().unwrap())
                .unwrap(),
        )
        .execute(a.tenants.master())
        .await
        .unwrap();
    let (first, task_a) = serve(Arc::clone(&a)).await;
    let (second, task_b) = serve(Arc::clone(&b)).await;
    let login=first.mutation("auth.login",json!({"tenant":"test","username":fixture.admin_username,"password":fixture.admin_password}),None).await;
    let token = login["token"].as_str().unwrap();
    let started = first
        .mutation(
            "auth.opaque.enrollStart",
            json!({"registrationRequest":vector["initialRegistrationRequest"]}),
            Some(token),
        )
        .await;
    assert_eq!(
        started["registrationResponse"],
        vector["initialRegistrationResponse"]
    );
    second.mutation("auth.opaque.enrollFinish",json!({"exchange":started["exchange"],"registrationRecord":vector["initialRegistrationRecord"],"vault":vector["initialVault"],"previousIdentityProof":null}),Some(token)).await;
    let account = first
        .query("auth.opaque.vault", Value::Null, Some(token))
        .await;
    assert_eq!(account["revision"], "1");
    assert_eq!(account["vault"], vector["initialVault"]);
    assert!(second.call("auth.opaque.vaultUpdate", Method::POST,
        json!({"revision":"1","vault":vector["initialVault"],"proof":URL_SAFE_NO_PAD.encode([0u8;64])}),
        Some(token)).await.is_err(), "a session token replaced a vault without its identity proof");
    assert_eq!(
        first
            .query("auth.opaque.vault", Value::Null, Some(token))
            .await,
        account
    );
    setup_waits_for_an_inflight_legacy_write(
        &first,
        &second,
        &fixture.tenant_pool,
        token,
        vector["initialSetup"].clone(),
    )
    .await;
    // Stored generated search fields are NULL in BEFORE UPDATE triggers. A
    // password-only change must remain possible after the business cutover.
    sqlx::query("UPDATE users SET password=NULL WHERE username=$1")
        .bind(&fixture.admin_username)
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    let business_change =
        sqlx::query("UPDATE users SET first_name=first_name || ' forbidden' WHERE username=$1")
            .bind(&fixture.admin_username)
            .execute(&fixture.tenant_pool)
            .await
            .unwrap_err();
    assert_eq!(
        business_change
            .as_database_error()
            .unwrap()
            .code()
            .as_deref(),
        Some("55000")
    );
    first
        .expect_error(
            "auth.setPassword",
            Method::POST,
            json!({"username":fixture.admin_username,"password":"Some-other-password!"}),
            Some(token),
            "CONFLICT",
        )
        .await;
    first
        .mutation(
            "zerotrust.domains.put",
            vector["initialDomain"].clone(),
            Some(token),
        )
        .await;
    first.mutation("zerotrust.objects.save",json!({"domain":"domain:calculation","messageId":"first-write","envelope":vector["initialObject"]}),Some(token)).await;
    let stored: Value =
        sqlx::query_scalar("SELECT envelope FROM __zerotrust_objects WHERE id='position:fixture'")
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(stored["format"], "sortsys-quack-ref-v1");
    assert!(
        stored.get("ciphertext").is_none(),
        "SQL metadata retained the document payload"
    );
    assert_eq!(
        second
            .query(
                "zerotrust.objects.get",
                json!({"id":"position:fixture"}),
                Some(token)
            )
            .await,
        vector["initialObject"]
    );
    let page = second
        .query(
            "zerotrust.objects.list",
            json!({
                "domain":"domain:calculation","prefix":"position:","after":null,"snapshot":null
            }),
            Some(token),
        )
        .await;
    assert_eq!(page["objects"], json!([vector["initialObject"]]));
    assert_eq!(page["after"], Value::Null);
    assert_ne!(page["snapshot"], "0");
    first
        .expect_error(
            "zerotrust.objects.list",
            Method::GET,
            json!({
                "domain":"domain:calculation","prefix":"position:","after":null,"snapshot":"0"
            }),
            Some(token),
            "CONFLICT",
        )
        .await;
    // Retried batches are idempotent across independent API states.
    second.mutation("zerotrust.objects.batch", json!({"heads":[{"domain":"domain:calculation","sequence":"0"}],"objects":[{
        "domain":"domain:calculation","messageId":"first-write","envelope":vector["initialObject"]
    }]}), Some(token)).await;
    assert_eq!(first.query("zerotrust.objects.list", json!({
        "domain":"domain:calculation","prefix":"position:","after":null,"snapshot":page["snapshot"]
    }), Some(token)).await, page);
    let source = first
        .mutation(
            "zerotrust.recovery.inspect",
            vector["inspectProbe"].clone(),
            None,
        )
        .await;
    assert_eq!(source["catalogVersion"], "2");
    assert_eq!(source["domains"][0]["generation"], "1");
    sqlx::query("INSERT INTO __zerotrust_recovery_challenges(id,tenant,generation,nonce) VALUES($1,'test',1,$2)").bind(vector["source"]["challengeId"].as_str().unwrap()).bind(URL_SAFE_NO_PAD.decode(vector["source"]["challenge"].as_str().unwrap()).unwrap()).execute(a.tenants.master()).await.unwrap();
    // Fail after the master has consumed R1, before the tenant installs R2.
    sqlx::query("ALTER TABLE users ADD CONSTRAINT test_recovery_failure CHECK(username NOT LIKE 'recovery-%')").execute(&fixture.tenant_pool).await.unwrap();
    assert!(
        first
            .call(
                "zerotrust.recovery.begin",
                Method::POST,
                vector["plan"].clone(),
                None
            )
            .await
            .is_err()
    );
    let (generation, phase): (i64, String) = sqlx::query_as(
        "SELECT generation,phase FROM __zerotrust_recovery_heads WHERE tenant='test'",
    )
    .fetch_one(a.tenants.master())
    .await
    .unwrap();
    assert_eq!((generation, phase), (2, "rekeying".into()));
    let phase: String = sqlx::query_scalar("SELECT phase FROM __zerotrust_state WHERE singleton")
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert_eq!(phase, "recovery_prepared");
    second
        .expect_error(
            "zerotrust.recovery.begin",
            Method::POST,
            vector["stalePlan"].clone(),
            None,
            "CONFLICT",
        )
        .await;
    first
        .expect_error(
            "zerotrust.objects.get",
            Method::GET,
            json!({"id":"position:fixture"}),
            Some(token),
            "FORBIDDEN",
        )
        .await;
    sqlx::query("ALTER TABLE users DROP CONSTRAINT test_recovery_failure")
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    let resume = json!({"tenant":"test","operation":vector["plan"]["transition"]["operation"]});
    let (one, two) = tokio::join!(
        first.call(
            "zerotrust.recovery.resume",
            Method::POST,
            resume.clone(),
            None
        ),
        second.call("zerotrust.recovery.resume", Method::POST, resume, None)
    );
    assert_eq!(one.unwrap(), json!({"success":true}));
    assert_eq!(two.unwrap(), json!({"success":true}));
    let owner_login = opaque_login(
        &first,
        &second,
        vector["plan"]["username"].as_str().unwrap(),
        vector["password"].as_str().unwrap(),
    )
    .await;
    assert_eq!(owner_login["vault"], vector["plan"]["vault"]);
    let recovered = owner_login["token"].as_str().unwrap();
    let status = first
        .query("zerotrust.status", Value::Null, Some(recovered))
        .await;
    assert_eq!(status["generation"], "2");
    assert_eq!(status["phase"], "enrolling");
    let trust = second
        .query("zerotrust.trust.history", Value::Null, Some(recovered))
        .await;
    assert_eq!(trust["authorities"].as_array().unwrap().len(), 2);
    assert_eq!(trust["identities"].as_array().unwrap().len(), 2);
    assert_eq!(
        trust["authorities"][1]["transition"]["transition"],
        vector["plan"]["transition"]
    );
    assert!(trust["authorities"][1]["transition"].get("vault").is_none());
    assert_eq!(
        first
            .query(
                "zerotrust.keys.get",
                json!({"domain":"domain:calculation","generation":"1"}),
                Some(recovered)
            )
            .await,
        vector["plan"]["oldKeyEnvelopes"][0]
    );
    assert_eq!(
        second
            .query(
                "zerotrust.objects.get",
                json!({"id":"position:fixture"}),
                Some(recovered)
            )
            .await,
        vector["initialObject"]
    );
    assert!(
        second
            .call(
                "zerotrust.objects.get",
                Method::GET,
                json!({"id":"position:fixture"}),
                Some(token)
            )
            .await
            .is_err()
    );
    second
        .expect_error(
            "zerotrust.recovery.begin",
            Method::POST,
            vector["stalePlan"].clone(),
            None,
            "CONFLICT",
        )
        .await;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE username LIKE 'recovery-%'")
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let root: String = sqlx::query_scalar(
        "SELECT generation::text FROM __zerotrust_recovery_heads WHERE tenant='test'",
    )
    .fetch_one(a.tenants.master())
    .await
    .unwrap();
    assert_eq!(root, "2");
    let durable:String=sqlx::query_scalar("SELECT domain_generation::text FROM __zerotrust_recovery_keys WHERE tenant='test' AND recovery_generation=2").fetch_one(a.tenants.master()).await.unwrap();
    assert_eq!(durable, "2");
    task_a.abort();
    task_b.abort();
    a.tenants.close().await;
    b.tenants.close().await;
    fixture.tenant_pool.close().await;
    sqlx::query(&format!("DROP DATABASE \"{database}\" WITH(FORCE)"))
        .execute(&postgres)
        .await
        .unwrap();
    postgres.close().await;
}
