//! Real Quack clients, separate tenant files and an offline-openable snapshot.
use super::*;
use sortsys_api::quack_store::{CipherStore, QuackConfig, content_id, tenant_id};

const RESTART_PROOF: &str = "/tmp/sortsys-duckdb-restart-proof.json";
const PERSISTED_TENANT: &str = "quack-persisted-fixture";

fn config() -> Option<QuackConfig> {
    TestEnvironment::from_env()?;
    Some(
        Config::from_env()
            .unwrap()
            .quack
            .expect("the isolated Quack service must be configured"),
    )
}
fn public_ciphertext() -> String {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/zerotrust-recovery.json")).unwrap();
    fixture["initialObject"].to_string()
}
async fn download(config: &QuackConfig, id: &str) -> Vec<u8> {
    reqwest::Client::new()
        .get(format!("{}/snapshots/{id}", config.control_url))
        .bearer_auth(&*config.token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap()
        .to_vec()
}
fn check_snapshot(bytes: &[u8], expected: &str) -> i64 {
    let path =
        std::env::temp_dir().join(format!("sortsys-quack-snapshot-{}.duckdb", unique_suffix()));
    std::fs::write(&path, bytes).unwrap();
    let connection = duckdb::Connection::open_with_flags(
        &path,
        duckdb::Config::default()
            .access_mode(duckdb::AccessMode::ReadOnly)
            .unwrap(),
    )
    .unwrap();
    let data: String = connection
        .query_row(
            "SELECT content FROM ciphertexts WHERE id=?",
            duckdb::params![content_id(expected)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(data, expected);
    let invalid: i64 = connection
        .query_row(
            "SELECT count(*) FROM ciphertexts WHERE sha256(content)<>id",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(invalid, 0);
    let checks: i64 = connection
        .query_row(
            "SELECT count(*) FROM duckdb_constraints() WHERE constraint_type='CHECK'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checks, 3, "schema and ciphertext constraints were lost");
    let primary_keys: i64 = connection
        .query_row(
            "SELECT count(*) FROM duckdb_constraints() WHERE constraint_type='PRIMARY KEY'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(primary_keys, 2, "primary keys were lost in the snapshot");
    let count: i64 = connection
        .query_row("SELECT count(*) FROM ciphertexts", [], |row| row.get(0))
        .unwrap();
    drop(connection);
    std::fs::remove_file(path).unwrap();
    count
}

#[tokio::test]
async fn independent_clients_isolate_tenants_and_create_consistent_snapshots() {
    let Some(config) = config() else {
        return;
    };
    let first = CipherStore::new(config.clone()).unwrap();
    let second = CipherStore::new(config.clone()).unwrap();
    let tenant = format!("quack-{}", unique_suffix());
    let other = format!("quack-other-{}", unique_suffix());
    let data = public_ciphertext();
    let (left, right) = tokio::join!(
        first.put(&tenant, data.clone()),
        second.put(&tenant, data.clone())
    );
    let id = left.unwrap();
    assert_eq!(right.unwrap(), id);
    assert_eq!(second.get(&tenant, &id).await.unwrap(), data);
    assert!(matches!(
        second.get(&other, &id).await,
        Err(sortsys_api::quack_store::StoreError::NotFound)
    ));
    assert_ne!(tenant_id(&tenant).unwrap(), tenant_id(&other).unwrap());
    let escaped = "opaque bytes with äöü and '); DROP TABLE ciphertexts; -- \\n\n\0";
    let escaped_id = first.put(&other, escaped.into()).await.unwrap();
    assert_eq!(second.get(&other, &escaped_id).await.unwrap(), escaped);
    let bulk = vec![
        escaped.to_owned(),
        format!("{escaped}second"),
        escaped.to_owned(),
    ];
    let ids = first.put_many(&other, bulk.clone()).await.unwrap();
    assert_eq!(ids[0], ids[2]);
    assert_eq!(second.put_many(&other, bulk.clone()).await.unwrap(), ids);
    for (id, expected) in ids.iter().zip(&bulk) {
        assert_eq!(second.get(&other, id).await.unwrap(), *expected);
    }
    let reversed = ids.iter().cloned().rev().collect::<Vec<_>>();
    assert_eq!(
        second.get_many(&other, reversed.clone()).await.unwrap(),
        bulk.iter().cloned().rev().collect::<Vec<_>>()
    );
    assert_eq!(
        second.get_prefix(&other, reversed, 1).await.unwrap(),
        vec![escaped.to_owned()]
    );
    assert!(matches!(
        second.get_many(&tenant, ids.clone()).await,
        Err(sortsys_api::quack_store::StoreError::NotFound)
    ));
    assert!(matches!(
        second
            .get_many(&other, vec![ids[0].clone(), "0".repeat(64)])
            .await,
        Err(sortsys_api::quack_store::StoreError::NotFound)
    ));
    assert!(
        second
            .get_many(&other, vec!["'invalid'".into()])
            .await
            .is_err()
    );
    let large = "x".repeat(1024 * 1024);
    let large_id = first.put(&other, large.clone()).await.unwrap();
    assert!(matches!(
        second.get_many(&other, vec![large_id.clone(); 64]).await,
        Err(sortsys_api::quack_store::StoreError::BatchTooLarge)
    ));
    assert_eq!(
        second
            .get_prefix(&other, vec![large_id; 64], 4 * 1024 * 1024)
            .await
            .unwrap(),
        vec![large; 4]
    );
    assert!(first.put_many(&other, Vec::new()).await.is_err());
    let base = data.clone();
    let target = tenant.clone();
    let writer = first.clone();
    let writes = tokio::spawn(async move {
        for index in 1..=24 {
            writer
                .put(&target, format!("{base}{}", " ".repeat(index)))
                .await
                .unwrap();
        }
    });
    let snapshot = second.snapshot(&tenant).await.unwrap();
    assert_eq!(snapshot.tenant, tenant_id(&tenant).unwrap());
    let bytes = download(&config, &snapshot.id).await;
    assert_eq!(bytes.len() as u64, snapshot.bytes);
    let count = check_snapshot(&bytes, &data);
    assert!((1..=25).contains(&count));
    writes.await.unwrap();
    first.put(&tenant, format!("{data}\n ")).await.unwrap();
    assert_eq!(
        download(&config, &snapshot.id).await,
        bytes,
        "a published snapshot changed after later source writes"
    );
    assert_eq!(check_snapshot(&bytes, &data), count);
    let unauthorized = reqwest::Client::new()
        .post(format!("{}/tenants", config.control_url))
        .bearer_auth("incorrect-service-token")
        .json(&json!({"tenant":tenant}))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
    let unauthorized_quack = duckdb::Connection::open_in_memory().unwrap();
    unauthorized_quack
        .execute_batch(&format!(
            "SET extension_directory={}; SET autoinstall_known_extensions=false; \
             SET autoload_known_extensions=false; LOAD httpfs; LOAD quack;",
            sortsys_api::quack_store::sql_string(config.extensions.to_str().unwrap()),
        ))
        .unwrap();
    assert!(unauthorized_quack.execute_batch(&format!(
        "ATTACH {} AS remote(TOKEN 'incorrect-service-token',DISABLE_SSL {}); CONNECT remote; SELECT 1;",
        sortsys_api::quack_store::sql_string(&config.uri), config.disable_ssl,
    )).is_err(), "Quack accepted an invalid service credential");

    // A separate invocation after the service's OS process has restarted must
    // read these bytes and the completed snapshot from persistent storage.
    let id = first.put(PERSISTED_TENANT, data.clone()).await.unwrap();
    let snapshot = first.snapshot(PERSISTED_TENANT).await.unwrap();
    std::fs::write(
        RESTART_PROOF,
        json!({"id":id,"snapshot":snapshot.id}).to_string(),
    )
    .unwrap();
}

#[tokio::test]
#[ignore = "scripts/test-api runs this after restarting the independent DuckDB container"]
async fn persisted_ciphertexts_survive_service_restart() {
    let config = config().expect("isolated integration environment is required");
    let proof: Value = serde_json::from_slice(&std::fs::read(RESTART_PROOF).unwrap()).unwrap();
    let store = CipherStore::new(config.clone()).unwrap();
    let data = public_ciphertext();
    assert_eq!(
        store
            .get(PERSISTED_TENANT, proof["id"].as_str().unwrap())
            .await
            .unwrap(),
        data
    );
    let snapshot = download(&config, proof["snapshot"].as_str().unwrap()).await;
    assert_eq!(check_snapshot(&snapshot, &data), 1);
}
