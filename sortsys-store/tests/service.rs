//! The real standalone service, two independent API clients and an offline
//! restore. No PostgreSQL process, test master database or external network.
use std::{
    net::{SocketAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use sortsys_store::{
    CipherStore, QuackConfig, StoreError, content_id,
    metadata::{ScanRequest, Target},
    tenant_id,
};
use sortsys_zerotrust::metadata::{MetadataBatch, RecordCheck, RecordKey, RecordPut};

struct Service {
    directory: PathBuf,
    process: Option<Child>,
    config: QuackConfig,
}

impl Service {
    async fn start() -> Self {
        let extensions = std::env::var_os("DUCKDB_EXTENSION_DIRECTORY")
            .expect("set DUCKDB_EXTENSION_DIRECTORY to the pinned extension directory");
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = std::env::temp_dir().join(format!("sortsys-store-service-{suffix}"));
        std::fs::create_dir_all(&directory).unwrap();
        let control = TcpListener::bind("127.0.0.1:0").unwrap();
        let quack = TcpListener::bind("127.0.0.1:0").unwrap();
        let control_address = control.local_addr().unwrap();
        let quack_address = quack.local_addr().unwrap();
        let config = QuackConfig {
            uri: format!("quack:{quack_address}").into(),
            control_url: format!("http://{control_address}").into(),
            token: "standalone-integration-service-token".into(),
            extensions: extensions.into(),
            disable_ssl: true,
        };
        let mut service = Self {
            directory,
            process: None,
            config,
        };
        drop(control);
        drop(quack);
        service.launch(control_address, quack_address);
        service.wait_ready().await;
        service
    }

    fn launch(&mut self, control: SocketAddr, quack: SocketAddr) {
        let output = std::fs::File::create(self.directory.join("service.log")).unwrap();
        self.process = Some(
            Command::new(env!("CARGO_BIN_EXE_sortsys-duckdb"))
                .env("DUCKDB_DATA_DIRECTORY", &self.directory)
                .env("DUCKDB_SERVICE_TOKEN", &*self.config.token)
                .env("DUCKDB_CONTROL_LISTEN", control.to_string())
                .env("DUCKDB_QUACK_LISTEN", quack.to_string())
                .env("DUCKDB_EXTENSION_DIRECTORY", &self.config.extensions)
                .stdin(Stdio::null())
                .stdout(output.try_clone().unwrap())
                .stderr(output)
                .spawn()
                .unwrap(),
        );
    }

    async fn wait_ready(&mut self) {
        let http = reqwest::Client::new();
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            if let Some(status) = self.process.as_mut().unwrap().try_wait().unwrap() {
                panic!(
                    "datastore exited {status}: {}",
                    std::fs::read_to_string(self.directory.join("service.log")).unwrap()
                );
            }
            if http
                .get(format!("{}/health", self.config.control_url))
                .timeout(Duration::from_millis(200))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return;
            }
            assert!(Instant::now() < deadline, "datastore startup timed out");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn key() -> RecordKey {
    RecordKey {
        collection: "technical-records".into(),
        key: "account:1".into(),
    }
}

fn batch(operation: &str, expected: Option<String>, value: &str) -> MetadataBatch {
    MetadataBatch {
        operation: operation.into(),
        checks: vec![RecordCheck {
            record: key(),
            version: expected,
        }],
        collections: vec![],
        puts: vec![RecordPut {
            record: key(),
            value: value.into(),
        }],
        deletes: vec![],
        hints: vec![],
        journal: vec![],
    }
}

#[tokio::test]
#[ignore = "requires the pinned DuckDB shared library, extensions and local listeners"]
async fn independent_api_clients_share_atomic_tenant_files_and_restorable_backups() {
    let mut service = Service::start().await;
    let first = CipherStore::new(service.config.clone()).unwrap();
    let second = CipherStore::new(service.config.clone()).unwrap();
    let target = Target::Tenant {
        tenant: "first".into(),
    };
    let scan = |target| ScanRequest {
        target,
        collection: "technical-records".into(),
        after: None,
        version: None,
        prefix: None,
        limit: Some(1),
    };
    let mixed_tenants = [
        scan(target.clone()),
        scan(Target::Tenant {
            tenant: "second".into(),
        }),
    ];
    assert!(matches!(
        first.metadata_scan_batch(&mixed_tenants).await,
        Err(StoreError::Integrity)
    ));
    let other = Target::Tenant {
        tenant: "second".into(),
    };

    // The global 1 KiB request limit must not accidentally truncate metadata.
    let mut initial = batch(
        "initial",
        None,
        &"encrypted-envelope-reference ".repeat(200),
    );
    initial
        .journal
        .push(sortsys_zerotrust::journal::JournalAppend {
            stream: "fixture".into(),
            id: "first-event".into(),
            object: "account:1".into(),
            occurred_micros: "1794657600123456".into(),
            order: None,
            value: "opaque-history-reference".into(),
        });
    let original = first
        .metadata_transact(target.clone(), initial.clone())
        .await
        .unwrap();
    let record = second
        .metadata_read(target.clone(), vec![key()])
        .await
        .unwrap()
        .remove(0);
    assert_eq!(record.value.as_ref(), Some(&initial.puts[0].value));
    assert_eq!(record.version.as_ref(), Some(&original.revision));
    let event = second
        .journal_get(target.clone(), "fixture".into(), "first-event".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.sequence, "1");
    let history = second
        .journal_list(
            target.clone(),
            sortsys_zerotrust::journal::JournalQuery {
                streams: vec!["fixture".into()],
                prefixes: vec!["account:".into()],
                before: None,
                snapshot: None,
                known: None,
                known_total: None,
                limit: 16,
            },
        )
        .await
        .unwrap();
    assert_eq!(history.total, "1");
    assert_eq!(history.entries[0].entry.value, "opaque-history-reference");

    assert!(
        second
            .metadata_read(other.clone(), vec![key()])
            .await
            .unwrap()[0]
            .value
            .is_none()
    );

    let left = batch("race-left", record.version.clone(), "left");
    let right = batch("race-right", record.version, "right");
    let (left, right) = tokio::join!(
        first.metadata_transact(target.clone(), left),
        second.metadata_transact(target.clone(), right),
    );
    assert!(matches!(
        (&left, &right),
        (Ok(_), Err(StoreError::Conflict)) | (Err(StoreError::Conflict), Ok(_))
    ));

    // A lost response can be recovered after subsequent writes, using another
    // API replica. Reusing the operation with different data must fail.
    assert_eq!(
        second
            .metadata_transact(target.clone(), initial.clone())
            .await
            .unwrap(),
        original
    );
    let mut changed = initial.clone();
    changed.puts[0].value = "different request".into();
    assert!(matches!(
        second.metadata_transact(target.clone(), changed).await,
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        first
            .metadata_events(target.clone(), "0".into())
            .await
            .unwrap()
            .len(),
        2
    );

    let ciphertext = "opaque ciphertext bytes äöü and '); DROP TABLE metadata_records; --";
    let id = first.put("first", ciphertext.into()).await.unwrap();
    assert_eq!(id, content_id(ciphertext));
    assert_eq!(second.get("first", &id).await.unwrap(), ciphertext);
    let contents = vec![
        ciphertext.to_owned(),
        "opaque äöü\0\nbytes".to_owned(),
        ciphertext.to_owned(),
    ];
    let ids = first.put_many("first", contents.clone()).await.unwrap();
    assert_eq!(
        second.get_many("first", ids.clone()).await.unwrap(),
        contents
    );
    assert_eq!(
        second.get_prefix("first", ids.clone(), 1).await.unwrap(),
        vec![ciphertext.to_owned()]
    );
    let groups = vec![vec![ids[1].clone(), ids[0].clone()], ids];
    let first_items_bytes = contents[0].len() + contents[1].len();
    assert_eq!(
        second
            .get_prefixes("first", groups.clone(), 1, first_items_bytes)
            .await
            .unwrap(),
        vec![vec![contents[1].clone()], vec![contents[0].clone()]]
    );
    assert!(matches!(
        second
            .get_prefixes("first", groups.clone(), 1, first_items_bytes - 1)
            .await,
        Err(StoreError::BatchTooLarge)
    ));
    assert_eq!(
        second
            .get_prefixes("first", groups.clone(), first_items_bytes + 1, 1024)
            .await
            .unwrap(),
        vec![vec![contents[1].clone(), contents[0].clone()], contents]
    );
    assert!(matches!(
        second.get_prefixes("second", groups, 1, 1024).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        second.get("second", &id).await,
        Err(StoreError::NotFound)
    ));
    let snapshot = first.snapshot("first").await.unwrap();
    let http = reqwest::Client::new();
    let url = format!("{}/snapshots/{}", service.config.control_url, snapshot.id);
    assert_eq!(
        http.get(&url).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let backup = http
        .get(url)
        .bearer_auth(&*service.config.token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(backup.len() as u64, snapshot.bytes);

    let operation = "replayed-snapshot-operation";
    let (left, right) = tokio::join!(
        first.snapshot_for_operation("first", operation),
        second.snapshot_for_operation("first", operation)
    );
    let fixed = left.unwrap();
    assert_eq!(fixed.id, right.unwrap().id);
    let saved = first
        .download_snapshot(&fixed.id)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    first
        .put(
            "first",
            "later ciphertext outside the original snapshot".into(),
        )
        .await
        .unwrap();
    let replayed = second
        .snapshot_for_operation("first", operation)
        .await
        .unwrap();
    assert_eq!(fixed.id, replayed.id);
    let replayed_bytes = second
        .download_snapshot(&replayed.id)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(saved, replayed_bytes);
    let other = first
        .snapshot_for_operation("second", operation)
        .await
        .unwrap();
    assert_ne!(fixed.id, other.id);
    assert!(
        first
            .snapshot_for_operation("first", "../traversal")
            .await
            .is_err()
    );

    let bad = QuackConfig {
        token: "a-different-service-token-is-invalid".into(),
        ..service.config.clone()
    };
    assert!(
        CipherStore::new(bad)
            .unwrap()
            .metadata_read(target.clone(), vec![key()])
            .await
            .is_err()
    );
    let expected = first.metadata_read(target, vec![key()]).await.unwrap();
    drop(first);
    drop(second);
    service.stop();

    // Restore needs just this tenant file. There is no tenant metadata to copy
    // from a master PostgreSQL database or another service's memory.
    let restored = service
        .directory
        .join("tenants")
        .join(format!("{}.duckdb", tenant_id("restored").unwrap()));
    std::fs::write(restored, backup).unwrap();
    let control = service
        .config
        .control_url
        .strip_prefix("http://")
        .unwrap()
        .parse()
        .unwrap();
    let quack = service
        .config
        .uri
        .strip_prefix("quack:")
        .unwrap()
        .parse()
        .unwrap();
    service.launch(control, quack);
    service.wait_ready().await;
    let restored = CipherStore::new(service.config.clone()).unwrap();
    let restored_target = Target::Tenant {
        tenant: "restored".into(),
    };
    let actual = restored
        .metadata_read(restored_target.clone(), vec![key()])
        .await
        .unwrap();
    assert_eq!(actual[0].version, expected[0].version);
    assert_eq!(actual[0].value, expected[0].value);
    assert_eq!(restored.get("restored", &id).await.unwrap(), ciphertext);
    let history = restored
        .journal_get(
            restored_target.clone(),
            "fixture".into(),
            "first-event".into(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(history.sequence, "1");
    assert_eq!(history.entry.value, "opaque-history-reference");

    assert_eq!(
        restored
            .metadata_transact(restored_target, initial)
            .await
            .unwrap(),
        original
    );
}

#[tokio::test]
#[ignore = "requires the pinned DuckDB shared library, extensions and local listeners"]
async fn change_waits_wake_after_commit_without_losing_admission_races() {
    let service = Service::start().await;
    let writer = CipherStore::new(service.config.clone()).unwrap();
    let reader = CipherStore::new(service.config.clone()).unwrap();
    let target = Target::Tenant {
        tenant: "first".into(),
    };
    let other = Target::Tenant {
        tenant: "second".into(),
    };
    let initial = reader
        .metadata_changes(target.clone(), None, 0)
        .await
        .unwrap();
    assert_eq!(initial.head, "0");
    assert!(initial.events.is_empty());

    let pending = reader.metadata_changes(target.clone(), Some(initial.head), 2000);
    tokio::pin!(pending);
    writer
        .metadata_transact(other, batch("unrelated", None, "unrelated metadata"))
        .await
        .unwrap();
    tokio::select! {
        result = &mut pending => panic!("Another tenant woke this reader: {:?}", result.is_ok()),
        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
    }
    let start = Instant::now();
    let first = writer
        .metadata_transact(target.clone(), batch("first", None, "first reference"))
        .await
        .unwrap();
    let page = tokio::time::timeout(Duration::from_secs(1), &mut pending)
        .await
        .unwrap()
        .unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(page.head, first.revision);
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].revision, first.revision);

    let second = writer
        .metadata_transact(
            target.clone(),
            batch("second", Some(first.revision.clone()), "second reference"),
        )
        .await
        .unwrap();
    // This reader starts after the commit. The durable log still provides it.
    let missed = reader
        .metadata_changes(target.clone(), Some(first.revision), 2000)
        .await
        .unwrap();
    assert_eq!(missed.head, second.revision);
    assert_eq!(missed.events.len(), 1);
    let baseline = reader
        .metadata_changes(target.clone(), None, 0)
        .await
        .unwrap();
    assert_eq!(baseline.head, second.revision);
    assert!(
        baseline.events.is_empty(),
        "New subscribers need no full history replay"
    );
    let timeout = reader
        .metadata_changes(target.clone(), Some(second.revision), 20)
        .await
        .unwrap();
    assert!(timeout.events.is_empty());
    let restored = reader
        .metadata_changes(target.clone(), Some("999".into()), 0)
        .await
        .unwrap();
    assert_ne!(
        restored.head, "999",
        "A cursor ahead of the durable head can detect a restored file"
    );
    assert!(restored.events.is_empty());
    assert!(matches!(
        reader.metadata_changes(target, None, 25_001).await,
        Err(StoreError::Integrity)
    ));
}

#[tokio::test]
#[ignore = "requires the pinned DuckDB shared library, extensions and local listeners"]
async fn prepared_metadata_keeps_large_writes_atomic_and_large_reads_free_of_events() {
    let service = Service::start().await;
    let first = CipherStore::new(service.config.clone()).unwrap();
    let second = CipherStore::new(service.config.clone()).unwrap();
    let target = Target::Tenant {
        tenant: "prepared".into(),
    };
    let puts = (0..1100)
        .map(|index| RecordPut {
            record: RecordKey {
                collection: "prepared".into(),
                key: format!("record:{index:05}"),
            },
            value: "ö".repeat(4200),
        })
        .collect::<Vec<_>>();
    let initial = MetadataBatch {
        operation: "prepared:first".into(),
        checks: puts
            .iter()
            .map(|put| RecordCheck {
                record: put.record.clone(),
                version: None,
            })
            .collect(),
        collections: vec![],
        puts,
        deletes: vec![],
        hints: vec![],
        journal: vec![],
    };
    assert!(initial.validate().is_err());
    let receipt = first
        .metadata_transact_ref(target.clone(), &initial)
        .await
        .unwrap();
    assert_eq!(
        second
            .metadata_transact_ref(target.clone(), &initial)
            .await
            .unwrap(),
        receipt
    );
    let events = second
        .metadata_changes(target.clone(), Some("0".into()), 0)
        .await
        .unwrap();
    assert_eq!(events.events.len(), 1);
    assert_eq!(events.events[0].changed.len(), 1100);
    let mut checks = initial.checks.clone();
    for check in &mut checks {
        check.version = Some(receipt.revision.clone());
    }
    for index in 0..8000 {
        checks.push(RecordCheck {
            record: RecordKey {
                collection: "missing".into(),
                key: format!("record:{index}"),
            },
            version: None,
        });
    }
    let read = MetadataBatch {
        operation: "prepared:read".into(),
        checks,
        collections: vec![],
        puts: vec![],
        deletes: vec![],
        hints: vec![],
        journal: vec![],
    };
    first
        .metadata_validate(target.clone(), read.clone())
        .await
        .unwrap();
    let after_read = second
        .metadata_changes(target.clone(), Some("0".into()), 0)
        .await
        .unwrap();
    assert_eq!(after_read.head, events.head);
    let make_update = |operation: &str, value: &str| {
        let mut next = initial.clone();
        next.operation = operation.into();
        for check in &mut next.checks {
            check.version = Some(receipt.revision.clone());
        }
        for put in &mut next.puts {
            put.value = value.into();
        }
        next
    };
    let left = make_update("prepared:left", "left");
    let right = make_update("prepared:right", "right");
    let (left, right) = tokio::join!(
        first.metadata_transact_ref(target.clone(), &left),
        second.metadata_transact_ref(target.clone(), &right),
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let rejected = if left.is_err() { left } else { right };
    assert!(matches!(rejected, Err(StoreError::Conflict)));
    assert!(matches!(
        first.metadata_validate(target.clone(), read).await,
        Err(StoreError::Conflict)
    ));
    let events = second
        .metadata_changes(target.clone(), Some("0".into()), 0)
        .await
        .unwrap();
    assert_eq!(events.events.len(), 2);
    let saved = first
        .metadata_read(
            target,
            vec![
                initial.puts[0].record.clone(),
                initial.puts[1099].record.clone(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(saved[0].value, saved[1].value);
    assert!(matches!(saved[0].value.as_deref(), Some("left" | "right")));
}
