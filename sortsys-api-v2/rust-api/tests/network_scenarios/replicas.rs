//! Real independently initialized API states; no sticky routing or shared Hub.
use super::*;
use std::sync::Arc;
use yrs::{Doc, GetString, Text, Transact, Update, updates::decoder::Decode};

#[path = "../../src/migrations_generated.rs"]
mod embedded_migrations;

async fn replica(state: Arc<AppState>) -> (RpcClient, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = sortsys_api::app_with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (RpcClient::new(format!("http://{address}")), task)
}
async fn live(rpc: &RpcClient, content: &Value) -> (LiveSocket, Doc, String) {
    let url = format!(
        "{}{}",
        rpc.base_url.replacen("http", "ws", 1),
        content["livePath"].as_str().unwrap()
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    send(&mut socket, json!({"ticket":content["liveTicket"]})).await;
    let id = xml_live_message(&mut socket, "ready").await["clientId"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Utf16,
        ..Default::default()
    });
    apply(&doc, &xml_live_message(&mut socket, "sync").await);
    (socket, doc, id)
}
fn apply(doc: &Doc, value: &Value) {
    doc.transact_mut()
        .apply_update(
            Update::decode_v1(&STANDARD.decode(value["data"].as_str().unwrap()).unwrap()).unwrap(),
        )
        .unwrap();
}
async fn send(socket: &mut LiveSocket, value: Value) {
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            value.to_string().into(),
        ))
        .await
        .unwrap();
}
async fn text_is(socket: &mut LiveSocket, doc: &Doc, key: &str, expected: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while doc.get_or_insert_text(key).get_string(&doc.transact()) != expected {
            apply(doc, &xml_live_message(socket, "sync").await);
        }
    })
    .await
    .unwrap();
}
async fn presence(socket: &mut LiveSocket, id: &str, field: Option<&str>, exists: bool) {
    loop {
        let message = xml_live_message(socket, "presence").await;
        let peer = message["participants"]
            .as_array()
            .unwrap()
            .iter()
            .find(|peer| peer["id"] == id);
        if exists && peer.is_some_and(|peer| peer["field"].as_str() == field)
            || !exists && peer.is_none()
        {
            return;
        }
    }
}

#[tokio::test]
async fn independent_replicas_share_initialization_edits_presence_and_committed_versions() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let config = Config::from_env().unwrap();
    let (a, b) = tokio::join!(AppState::connect(config.clone()), AppState::connect(config));
    let a = a.unwrap();
    let b = b.unwrap();
    let (first, task_a) = replica(a.clone()).await;
    let (second, task_b) = replica(b.clone()).await;
    let login=first.mutation("auth.login",json!({"tenant":fixture.tenant,"username":fixture.admin_username,"password":fixture.admin_password}),None).await;
    let token = login["token"].as_str().unwrap();
    let case = first
        .mutation(
            "commercial.cases.create",
            json!({"title":"Replica offer","kind":"offer"}),
            Some(token),
        )
        .await["id"]
        .clone();
    let file=first.mutation("commercial.documents.create",json!({"caseId":case,"purpose":"inquiry","fileName":"replica.x83","xml":"<GAEB/>","readOnly":false}),Some(token)).await["id"].clone();
    let input = json!({"caseId":case,"id":file});
    let content = first
        .query("commercial.documents.get", input.clone(), Some(token))
        .await;
    let (mut left, left_doc, left_id) = live(&first, &content).await;
    // Ticket issued by A is accepted by B without touching A's memory.
    let (mut right, right_doc, right_id) = live(&second, &content).await;
    presence(&mut left, &right_id, None, true).await;
    presence(&mut right, &left_id, None, true).await;
    let key = "item-a:text:0";
    tokio::join!(
        send(
            &mut left,
            json!({"type":"initialize","key":key,"value":"Hallo 👋 Welt"})
        ),
        send(
            &mut right,
            json!({"type":"initialize","key":key,"value":"Hallo 👋 Welt"})
        )
    );
    text_is(&mut left, &left_doc, key, "Hallo 👋 Welt").await;
    text_is(&mut right, &right_doc, key, "Hallo 👋 Welt").await;
    let initialized: i64 = sqlx::query_scalar("SELECT count(*) FROM __xml_live_fields")
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert_eq!(initialized, 1);
    let left_update = {
        let text = left_doc.get_or_insert_text(key);
        let mut tx = left_doc.transact_mut();
        text.insert(&mut tx, 0, "Links ");
        tx.encode_update_v1()
    };
    let right_update = {
        let text = right_doc.get_or_insert_text(key);
        let mut tx = right_doc.transact_mut();
        let len = text.len(&tx);
        text.insert(&mut tx, len, " Rechts");
        tx.encode_update_v1()
    };
    tokio::join!(
        send(
            &mut left,
            json!({"type":"update","data":STANDARD.encode(left_update)})
        ),
        send(
            &mut right,
            json!({"type":"update","data":STANDARD.encode(right_update)})
        )
    );
    text_is(&mut left, &left_doc, key, "Links Hallo 👋 Welt Rechts").await;
    text_is(&mut right, &right_doc, key, "Links Hallo 👋 Welt Rechts").await;
    send(&mut left, json!({"field":key,"start":6,"end":8})).await;
    presence(&mut right, &left_id, Some(key), true).await;
    // Force lost LISTEN connections, then write while notifications may be
    // unavailable. Both nodes must recover from the persisted delta log.
    let listeners:Vec<bool>=sqlx::query_scalar("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'sortsys-xml-live:%'").fetch_all(&fixture.tenant_pool).await.unwrap();
    assert_eq!(listeners.len(), 2);
    let update = {
        let text = left_doc.get_or_insert_text(key);
        let mut tx = left_doc.transact_mut();
        let len = text.len(&tx);
        text.insert(&mut tx, len, "!");
        tx.encode_update_v1()
    };
    send(
        &mut left,
        json!({"type":"update","data":STANDARD.encode(update)}),
    )
    .await;
    text_is(&mut right, &right_doc, key, "Links Hallo 👋 Welt Rechts!").await;
    // Native document commits are also notified across replicas, without waiting
    // for the 30-second authorization fallback.
    second
        .mutation(
            "commercial.documents.save",
            json!({"caseId":case,"id":file,"version":1,"xml":"<GAEB><!--saved--></GAEB>"}),
            Some(token),
        )
        .await;
    assert_eq!(xml_live_message(&mut left, "changed").await["version"], "2");
    assert!(
        second
            .query("commercial.cases.get", json!({"id":case}), Some(token))
            .await["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == file)
    );
    // Competing native saves on different replicas cannot overwrite a winner.
    let (save_a, save_b) = tokio::join!(
        first.call(
            "commercial.documents.save",
            Method::POST,
            json!({"caseId":case,"id":file,"version":2,"xml":"<GAEB>A</GAEB>"}),
            Some(token)
        ),
        second.call(
            "commercial.documents.save",
            Method::POST,
            json!({"caseId":case,"id":file,"version":2,"xml":"<GAEB>B</GAEB>"}),
            Some(token)
        )
    );
    assert_eq!(usize::from(save_a.is_ok()) + usize::from(save_b.is_ok()), 1);
    let winner = if save_a.is_ok() {
        "<GAEB>A</GAEB>"
    } else {
        "<GAEB>B</GAEB>"
    };
    assert_eq!(save_a.err().or(save_b.err()).unwrap().code, "CONFLICT");
    let saved = first
        .query("commercial.documents.get", input.clone(), Some(token))
        .await;
    assert_eq!(saved["xml"], winner);
    // A different document of the same case must update the open case view
    // even when its native file is not the file being edited by this socket.
    sqlx::query("INSERT INTO commercial_documents(case_id,purpose,phase,file_name,object_key,size_bytes,created_by_user_id) SELECT case_id,'offer','84','other.x84',object_key,size_bytes,created_by_user_id FROM commercial_documents WHERE id=$1")
        .bind(Id::decode(file.as_str().unwrap()).unwrap()).execute(&fixture.tenant_pool).await.unwrap();
    loop {
        let snapshot = xml_live_message(&mut left, "case").await;
        if snapshot["detail"]["documents"].as_array().unwrap().len() == 2 {
            break;
        }
    }
    // Above the NOTIFY payload limit, the log carries data. Compaction preserves
    // the whole CRDT for a late joiner, including Unicode identifiers.
    let big = "a".repeat(1_100_000);
    send(
        &mut left,
        json!({"type":"initialize","key":"large:text:0","value":big}),
    )
    .await;
    text_is(&mut right, &right_doc, "large:text:0", &big).await;
    let checkpoint: i64 = sqlx::query_scalar(
        "SELECT checkpoint FROM __xml_live_rooms WHERE room LIKE 'commercial:%'",
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert!(checkpoint > 0);
    let renewed = second
        .query("commercial.documents.get", input.clone(), Some(token))
        .await;
    let c = AppState::connect(Config::from_env().unwrap())
        .await
        .unwrap();
    let (third, task_c) = replica(c.clone()).await;
    let (mut later, later_doc, _) = live(&third, &renewed).await;
    assert_eq!(
        later_doc
            .get_or_insert_text(key)
            .get_string(&later_doc.transact()),
        "Links Hallo 👋 Welt Rechts!"
    );
    assert_eq!(
        later_doc
            .get_or_insert_text("large:text:0")
            .len(&later_doc.transact()),
        big.len() as u32
    );
    left.close(None).await.unwrap();
    presence(&mut right, &left_id, None, false).await;
    // Closing the last local peer of A leaves B's editing state intact.
    let (mut rejoined, rejoined_doc, _) = live(&first, &renewed).await;
    assert_eq!(
        rejoined_doc
            .get_or_insert_text(key)
            .get_string(&rejoined_doc.transact()),
        "Links Hallo 👋 Welt Rechts!"
    );
    right.close(None).await.unwrap();
    later.close(None).await.unwrap();
    rejoined.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM __xml_live_peers")
                .fetch_one(&fixture.tenant_pool)
                .await
                .unwrap();
            if count == 0 {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    // An abandoned room cannot replay old fields over the next native session.
    let (mut abandoned, new_doc, _) = live(&first, &renewed).await;
    assert_eq!(new_doc.get_or_insert_text(key).len(&new_doc.transact()), 0);
    sqlx::query("UPDATE __xml_live_peers SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&fixture.tenant_pool)
        .await
        .unwrap();
    let (mut fresh, fresh_doc, _) = live(&second, &renewed).await;
    assert_eq!(
        fresh_doc.get_or_insert_text(key).len(&fresh_doc.transact()),
        0
    );
    send(
        &mut abandoned,
        json!({"type":"initialize","key":key,"value":"stale"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(Ok(message)) = abandoned.next().await {
            if matches!(message, tokio_tungstenite::tungstenite::Message::Close(_)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    let keys: i64 = sqlx::query_scalar("SELECT count(*) FROM __xml_live_fields")
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();
    assert_eq!(
        keys, 0,
        "an expired session wrote into a new room generation"
    );
    fresh.close(None).await.unwrap();
    task_a.abort();
    task_b.abort();
    task_c.abort();
    c.tenants.close().await;
    a.tenants.close().await;
    b.tenants.close().await;
}

#[tokio::test]
async fn concurrent_tenant_migrations_are_atomic_and_applied_once() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let mut postgres_url = Url::parse(&environment.master_dsn).unwrap();
    postgres_url.set_path("/postgres");
    let postgres = PgPool::connect(postgres_url.as_str()).await.unwrap();
    let database = format!("replica_migrations_{}", unique_suffix());
    sqlx::query(&format!("CREATE DATABASE \"{database}\""))
        .execute(&postgres)
        .await
        .unwrap();
    postgres_url.set_path(&format!("/{database}"));
    let pool = PgPool::connect(postgres_url.as_str()).await.unwrap();
    // A failure recording migration history must roll back the preceding DDL.
    sqlx::query("CREATE TABLE __migrations(name TEXT PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT NOW(),CONSTRAINT reject_migration CHECK(false))").execute(&pool).await.unwrap();
    assert!(migrations::apply(pool.clone()).await.is_err());
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename<>'__migrations'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tables, 0, "failed migration left partial schema behind");
    sqlx::query("ALTER TABLE __migrations DROP CONSTRAINT reject_migration")
        .execute(&pool)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..8 {
        tasks.push(tokio::spawn(migrations::apply(pool.clone())));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    let applied: Vec<String> = sqlx::query_scalar("SELECT name FROM __migrations ORDER BY name")
        .fetch_all(&pool)
        .await
        .unwrap();
    let expected: Vec<&str> = embedded_migrations::MIGRATIONS
        .iter()
        .map(|(name, _)| *name)
        .collect();
    assert_eq!(applied, expected);
    // Notifications emitted in a failed transaction must not reach subscribers.
    let mut listener = sqlx::postgres::PgListener::connect(postgres_url.as_str())
        .await
        .unwrap();
    listener.listen("sortsys_xml_live").await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_notify('sortsys_xml_live','rolled-back')")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(150), listener.recv())
            .await
            .is_err()
    );
    drop(listener);
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE \"{database}\""))
        .execute(&postgres)
        .await
        .unwrap();
    postgres.close().await;
}
