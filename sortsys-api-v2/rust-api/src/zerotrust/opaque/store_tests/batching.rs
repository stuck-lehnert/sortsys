//! Count actual HTTP reads while retaining the real shared-store transaction path.
use super::*;
use axum::{
    Router,
    body::Bytes,
    extract::{Path as RoutePath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use sortsys_zerotrust::{
    anchors::{ANCHOR_COLLECTION, RecordAnchor, RecordCheckpoint},
    metadata::RecordKey,
};
use std::sync::Mutex;

#[derive(Clone)]
pub(super) struct ReadProbe {
    upstream: Arc<str>,
    client: reqwest::Client,
    reads: Arc<Mutex<Vec<Vec<RecordKey>>>>,
}

impl ReadProbe {
    pub(super) fn take_reads(&self) -> Vec<Vec<RecordKey>> {
        std::mem::take(&mut *self.reads.lock().unwrap())
    }
}

async fn forward_metadata(
    State(probe): State<ReadProbe>,
    RoutePath(path): RoutePath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if path == "metadata/read" {
        let input: sortsys_store::metadata::ReadRequest = serde_json::from_slice(&body).unwrap();
        probe.reads.lock().unwrap().push(input.records);
    }
    let response = probe
        .client
        .post(format!("{}/{path}", probe.upstream))
        .header("authorization", headers.get("authorization").unwrap())
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
    if !status.is_success() && status != StatusCode::CONFLICT {
        eprintln!("Datendienst-Testproxy: {path} antwortet mit {status}");
    }
    (status, response.bytes().await.unwrap()).into_response()
}

pub(super) async fn measured_store(config: &QuackConfig) -> (CipherStore, ReadProbe, ApiTask) {
    let probe = ReadProbe {
        upstream: config.control_url.clone(),
        client: reqwest::Client::new(),
        reads: Arc::default(),
    };
    let router = Router::new()
        .route("/{*path}", post(forward_metadata))
        .with_state(probe.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = ApiTask(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let mut measured = config.clone();
    measured.control_url = Arc::from(format!("http://{address}"));
    (CipherStore::new(measured).unwrap(), probe, task)
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB and loopback listeners"]
async fn protected_write_batches_preserve_missing_record_and_checkpoint_guards() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
    let (store, probe, _proxy) = measured_store(&config).await;
    let first = Repository::system(store).tenant("batching-test").unwrap();
    let second = Repository::system(CipherStore::new(config).unwrap())
        .tenant("batching-test")
        .unwrap();
    let records = (0..600)
        .map(|index| key("test-batched-records", &format!("r-{index:04}")))
        .collect::<Vec<_>>();
    let mut publication = first.transaction().unwrap();
    publication.put(records[0].clone(), &999_u64).await.unwrap();
    let mut requested = records.clone();
    requested.extend(records.clone());
    publication.prefetch_protected(requested).await.unwrap();
    publication
        .prefetch_protected(records.clone())
        .await
        .unwrap();
    assert_eq!(
        publication.read::<u64>(records[0].clone()).await.unwrap(),
        Some(999)
    );
    for (index, record) in records.iter().enumerate() {
        publication
            .put_protected(record.clone(), &(index as u64))
            .await
            .unwrap();
    }
    // One initial read, then 1,199 previously unseen records/checkpoints in two
    // bounded requests. Duplicate keys and repeated prefetches make no requests.
    let requests = probe.take_reads();
    assert_eq!(
        requests.iter().map(Vec::len).collect::<Vec<_>>(),
        [1, 1024, 175]
    );
    let receipt = publication.commit().await.unwrap();
    assert!(probe.take_reads().is_empty());
    println!(
        "600 geschützte Schreibziele: 3 HTTP-Leseanfragen, atomarer Commit {}",
        receipt.revision
    );

    let mut readback = second.transaction().unwrap();
    let values = readback.many::<u64>(records.clone()).await.unwrap();
    let expected_values = (0_u64..600).map(Some).collect::<Vec<_>>();
    assert_eq!(values, expected_values);
    let checkpoints = readback
        .all::<RecordAnchor>(ANCHOR_COLLECTION, 2000)
        .await
        .unwrap();
    let mut protected = std::collections::BTreeSet::new();
    for anchor in checkpoints {
        let Some(checkpoint) = RecordCheckpoint::from_payload(&anchor.payload).unwrap() else {
            continue;
        };
        for binding in checkpoint.records {
            if binding.record.collection == "test-batched-records" {
                let value = readback
                    .read::<u64>(binding.record.clone())
                    .await
                    .unwrap()
                    .unwrap();
                binding
                    .verify(&serde_json::to_string(&value).unwrap())
                    .unwrap();
                protected.insert(binding.record.key);
            }
        }
    }
    assert_eq!(protected.len(), 600);
    readback.validate().await.unwrap();

    // An absent write target observed during prefetch must still conflict if
    // another API instance creates it before publication. No partial writes.
    let added = key("test-batched-records", "concurrent-addition");
    let mut stale = first.transaction().unwrap();
    stale
        .prefetch_protected(vec![records[0].clone(), added.clone()])
        .await
        .unwrap();
    let mut competing = second.transaction().unwrap();
    competing
        .put_protected(added.clone(), &7_u64)
        .await
        .unwrap();
    competing.commit().await.unwrap();
    stale
        .put_protected(records[0].clone(), &1000_u64)
        .await
        .unwrap();
    stale.put_protected(added.clone(), &1000_u64).await.unwrap();
    assert_eq!(stale.commit().await.unwrap_err().code, ErrorCode::Conflict);
    assert_eq!(
        second.read::<u64>(records[0].clone()).await.unwrap().value,
        Some(0)
    );
    assert_eq!(second.read::<u64>(added).await.unwrap().value, Some(7));

    // A checkpoint can advance without changing its record's value. Its own
    // observed version is necessary to prevent a stale witness publication.
    let mut stale = first.transaction().unwrap();
    stale
        .prefetch_protected(vec![records[0].clone()])
        .await
        .unwrap();
    let mut competing = second.transaction().unwrap();
    competing.protect_record(records[0].clone()).await.unwrap();
    competing.commit().await.unwrap();
    stale
        .put_protected(records[0].clone(), &2000_u64)
        .await
        .unwrap();
    assert_eq!(stale.commit().await.unwrap_err().code, ErrorCode::Conflict);
    assert_eq!(
        second.read::<u64>(records[0].clone()).await.unwrap().value,
        Some(0)
    );
}
