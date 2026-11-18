//! Exercise physical content views against the real store. Small integers stand
//! for opaque metadata pointers; signatures come from browser WebCrypto vectors.
use super::*;
use crate::control::content::head_key;
use sortsys_store::metadata::Target;
use sortsys_zerotrust::{
    content_epoch::{ContentEpoch, ContentPin, content_pin_key, namespace_record},
    metadata::{MetadataBatch, RecordCheck, RecordPut},
    protocol::AuthorityCertificate,
};

fn fixtures() -> (Vec<ContentEpoch>, Vec<AuthorityCertificate>) {
    let value: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sortsys-zerotrust/test/fixtures/content-epochs.json"
    )))
    .unwrap();
    (
        serde_json::from_value(value["epochs"].clone()).unwrap(),
        serde_json::from_value(value["certificates"].clone()).unwrap(),
    )
}

fn document(number: usize) -> sortsys_zerotrust::metadata::RecordKey {
    key("documents", &format!("doc-{number:02}"))
}

async fn stage(store: &CipherStore, epoch: &str, entries: &[(usize, u64)]) {
    let mut batch = MetadataBatch {
        operation: super::super::super::crypto::random_id().unwrap(),
        checks: Vec::new(),
        collections: Vec::new(),
        puts: Vec::new(),
        deletes: Vec::new(),
        hints: Vec::new(),
        journal: Vec::new(),
    };
    for (number, value) in entries {
        let physical = namespace_record(&document(*number), epoch).unwrap();
        batch.checks.push(RecordCheck {
            record: physical.clone(),
            version: None,
        });
        batch.puts.push(RecordPut {
            record: physical,
            value: value.to_string(),
        });
    }
    store
        .metadata_transact(
            Target::Tenant {
                tenant: "laboratory".into(),
            },
            batch,
        )
        .await
        .unwrap();
}

async fn publish_head(
    repository: &Repository,
    epoch: &ContentEpoch,
    previous: Option<&ContentEpoch>,
    source: Option<&ContentEpoch>,
    authority: &AuthorityCertificate,
) {
    epoch.follows(previous, source).unwrap();
    let mut transaction = repository.transaction().unwrap();
    transaction.put_protected(head_key(), epoch).await.unwrap();
    crate::zerotrust::content::verify_view(&mut transaction, "laboratory", authority)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
}

#[tokio::test]
#[ignore = "scripts/test-native-auth provides disposable DuckDB and loopback listeners"]
async fn restored_content_views_keep_current_access_pins_and_transaction_guards() {
    assert_eq!(
        std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
        Ok("1")
    );
    let config = QuackConfig::from_env().unwrap().unwrap();
    assert!(config.control_url.starts_with("http://127.0.0.1:"));
    assert!(config.token.starts_with("sortsys-disposable-"));
    let (store, probe, _proxy) = batching::measured_store(&config).await;
    let first = Repository::system(store.clone())
        .tenant("laboratory")
        .unwrap();
    let second = Repository::system(CipherStore::new(config).unwrap())
        .tenant("laboratory")
        .unwrap();
    let (epochs, certificates) = fixtures();
    let mut initial = first.transaction().unwrap();
    for (number, value) in [(0, 100_u64), (2, 222), (4, 444), (8, 888)] {
        initial.put(document(number), &value).await.unwrap();
    }
    initial
        .put_protected(key("accounts", "current-member"), &77_u64)
        .await
        .unwrap();
    initial
        .put_protected(key("policies", "current"), &99_u64)
        .await
        .unwrap();
    initial
        .put_protected(key("delivery-state", "current"), &123_u64)
        .await
        .unwrap();
    initial
        .put_protected(
            key("authority-history", "00000000000000000001"),
            &crate::zerotrust::objects::AuthorityHistory {
                certificate: certificates[0].clone(),
                transition: None,
            },
        )
        .await
        .unwrap();
    for number in [2, 8] {
        initial
            .protect_records(&format!("permanent-document-{number}"), &[document(number)])
            .await
            .unwrap();
    }
    initial.commit().await.unwrap();

    let mut stale_read = first.transaction().unwrap();
    assert_eq!(
        stale_read.read::<u64>(document(4)).await.unwrap(),
        Some(444)
    );
    let mut stale_write = first.transaction().unwrap();
    stale_write.put(document(4), &555_u64).await.unwrap();
    stage(&store, "1", &[(1, 11), (2, 22), (3, 33), (4, 44), (5, 55)]).await;
    publish_head(&second, &epochs[0], None, None, &certificates[0]).await;
    assert_eq!(
        stale_read.validate().await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        stale_write.commit().await.unwrap_err().code,
        ErrorCode::Conflict
    );

    probe.take_reads();
    let mut read = first.transaction().unwrap();
    let values = read
        .many::<u64>(vec![
            document(0),
            document(1),
            document(2),
            document(4),
            document(8),
            document(2),
        ])
        .await
        .unwrap();
    assert_eq!(
        values,
        [None, Some(11), Some(222), Some(44), Some(888), Some(222)]
    );
    let requests = probe.take_reads();
    assert!(
        requests.len() <= 3,
        "View head, selected records/pins and pinned targets must stay batched"
    );
    assert!(requests.iter().all(|records| records.len() <= 1024));
    read.validate().await.unwrap();
    assert_eq!(
        first.read::<u64>(document(2)).await.unwrap().value,
        Some(222)
    );
    assert_eq!(
        first.read::<u64>(document(8)).await.unwrap().value,
        Some(888)
    );

    let mut listed = first.transaction().unwrap();
    let mut after = None;
    let mut rows = Vec::new();
    let mut version = None;
    loop {
        let page = listed
            .scan_prefix::<u64>("documents", "doc-", after, 2)
            .await
            .unwrap();
        assert!(page.records.len() <= 2);
        assert!(
            page.records
                .iter()
                .all(|row| row.record.collection == "documents" && row.version.is_some())
        );
        if let Some(version) = &version {
            assert_eq!(&page.version, version);
        }
        version = Some(page.version);
        rows.extend(
            page.records
                .into_iter()
                .map(|row| (row.record.key, row.value.unwrap())),
        );
        after = page.after;
        if after.is_none() {
            break;
        }
    }
    listed.validate().await.unwrap();
    assert_eq!(
        rows,
        [
            ("doc-01".into(), 11),
            ("doc-02".into(), 222),
            ("doc-03".into(), 33),
            ("doc-04".into(), 44),
            ("doc-05".into(), 55),
            ("doc-08".into(), 888)
        ]
    );
    let direct_page = first
        .scan_prefix::<u64>("documents", Some("doc-08"), None, None, 2)
        .await
        .unwrap();
    assert_eq!(direct_page.records.len(), 1);
    assert_eq!(direct_page.records[0].value, Some(888));

    let mut changed = second.transaction().unwrap();
    changed.put(document(4), &4444_u64).await.unwrap();
    changed
        .protect_records("permanent-document-3", &[document(3)])
        .await
        .unwrap();
    changed.commit().await.unwrap();
    let original = store
        .metadata_read(
            Target::Tenant {
                tenant: "laboratory".into(),
            },
            vec![document(4)],
        )
        .await
        .unwrap();
    assert_eq!(original[0].value.as_deref(), Some("444"));
    assert_eq!(
        first.read::<u64>(document(4)).await.unwrap().value,
        Some(4444)
    );
    let pin: ContentPin = first
        .read(content_pin_key(&document(3)).unwrap())
        .await
        .unwrap()
        .value
        .unwrap();
    assert_eq!(pin.number, "1");
    assert_eq!(pin.physical, namespace_record(&document(3), "1").unwrap());

    // A newly pinned key changes the pin directory alone. It invalidates a
    // reader even when the active physical content collection is unchanged.
    let mut stale_scan = first.transaction().unwrap();
    let page = stale_scan
        .scan_with_limit::<u64>("documents", None, 2)
        .await
        .unwrap();
    let mut pinned = second.transaction().unwrap();
    pinned.protect_record(document(5)).await.unwrap();
    pinned.commit().await.unwrap();
    assert_eq!(
        stale_scan
            .scan_with_limit::<u64>("documents", page.after, 2)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );

    // Retention fixes the physical location; it does not prohibit an otherwise
    // authorized, witnessed advance such as an invoice counter increment.
    let mut advanced = second.transaction().unwrap();
    advanced.put_protected(document(5), &56_u64).await.unwrap();
    advanced.commit().await.unwrap();

    let mut stale_epoch = first.transaction().unwrap();
    stale_epoch.read::<u64>(document(4)).await.unwrap();
    crate::zerotrust::content::verify_view(&mut stale_epoch, "laboratory", &certificates[1])
        .await
        .unwrap();
    stage(&store, "2", &[(0, 10), (2, 20), (3, 30), (4, 40)]).await;
    publish_head(
        &second,
        &epochs[1],
        Some(&epochs[0]),
        Some(&epochs[0]),
        &certificates[1],
    )
    .await;
    assert_eq!(
        stale_epoch.validate().await.unwrap_err().code,
        ErrorCode::Conflict
    );
    let mut latest = first.transaction().unwrap();
    assert_eq!(
        latest
            .many::<u64>(vec![
                document(0),
                document(2),
                document(3),
                document(4),
                document(5),
                document(8)
            ])
            .await
            .unwrap(),
        [Some(10), Some(222), Some(33), Some(40), Some(56), Some(888)]
    );
    for (collection, expected) in [
        ("accounts", 77_u64),
        ("policies", 99),
        ("delivery-state", 123),
    ] {
        let record = if collection == "accounts" {
            "current-member"
        } else {
            "current"
        };
        assert_eq!(
            latest.read::<u64>(key(collection, record)).await.unwrap(),
            Some(expected)
        );
    }
    latest.validate().await.unwrap();

    let mut invalid = epochs[1].clone();
    invalid.snapshot = super::super::super::crypto::encode(&[9; 32]);
    let mut forged = second.transaction().unwrap();
    forged.put_protected(head_key(), &invalid).await.unwrap();
    assert!(
        crate::zerotrust::content::verify_view(&mut forged, "laboratory", &certificates[1])
            .await
            .is_err()
    );
    drop(forged);

    for record in [
        head_key(),
        content_pin_key(&document(2)).unwrap(),
        document(2),
    ] {
        let mut erased = second.transaction().unwrap();
        erased.delete(record).await.unwrap();
        assert!(erased.commit().await.is_err());
    }
    assert_eq!(
        first.read::<u64>(document(2)).await.unwrap().value,
        Some(222)
    );
    assert!(
        first
            .read::<u64>(namespace_record(&document(4), "1").unwrap())
            .await
            .is_err()
    );
    assert!(
        first
            .scan::<u64>("zt-data:1:documents", None, None)
            .await
            .is_err()
    );
    println!(
        "Two content epoch switches: current control records, immutable pins across epochs, bounded merged pages, batched lookup, stale read/write rejection and signed head checks verified against the shared store."
    );
}
