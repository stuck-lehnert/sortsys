//! Atomic control metadata stored alongside each tenant's ciphertexts. This is
//! the persistence boundary for the independent DuckDB runtime, not a PG shim.
use super::StoreError;
use duckdb::{Connection, OptionalExt, params, params_from_iter};
use serde::{Deserialize, Serialize};
use sortsys_zerotrust::metadata::{MetadataBatch, MetadataReceipt, MetadataRecord, RecordKey};
use std::collections::BTreeSet;

pub const MAX_SCAN_BATCH: usize = 32;
pub const MAX_SCAN_PAGE: usize = 640;
const DEFAULT_SCAN_PAGE: usize = 128;
const WIDE_SCAN_BYTES: usize = sortsys_zerotrust::metadata::MAX_RECORD_BYTES;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    System,
    Tenant { tenant: String },
}
impl Target {
    pub fn context(&self) -> Result<String, StoreError> {
        match self {
            Self::System => Ok("system".into()),
            Self::Tenant { tenant } => Ok(format!("tenant:{}", super::tenant_id(tenant)?)),
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JournalRead {
    pub target: Target,
    pub stream: String,
    pub id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JournalOrigins {
    pub target: Target,
    pub objects: Vec<sortsys_zerotrust::metadata::RecordKey>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JournalList {
    pub target: Target,
    pub query: sortsys_zerotrust::journal::JournalQuery,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub target: Target,
    pub records: Vec<RecordKey>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BatchRequest {
    pub target: Target,
    pub batch: MetadataBatch,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScanRequest {
    pub target: Target,
    pub collection: String,
    pub after: Option<String>,
    pub version: Option<String>,
    pub prefix: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordPage {
    pub version: String,
    pub records: Vec<MetadataRecord>,
    pub after: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventsRequest {
    pub target: Target,
    pub after: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChangesRequest {
    pub target: Target,
    pub after: Option<String>,
    pub wait_ms: u32,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChangesPage {
    pub head: String,
    pub events: Vec<MetadataEvent>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MetadataEvent {
    pub revision: String,
    pub changed: Vec<RecordKey>,
    pub hints: Vec<sortsys_zerotrust::metadata::MetadataHint>,
}

fn database(_error: duckdb::Error) -> StoreError {
    // Database diagnostics may contain bound credentials or record contents.
    // Keep them out of application logs as well as API responses.
    tracing::warn!("DuckDB metadata operation failed");
    StoreError::Unavailable("metadata-database")
}
fn version(value: &str) -> Result<i64, StoreError> {
    if value == "0" {
        return Ok(0);
    }
    sortsys_zerotrust::crypto::revision(value).map_err(|_| StoreError::Integrity)
}
fn checked_record(key: &RecordKey) -> Result<(), StoreError> {
    key.validate().map_err(|_| StoreError::Integrity)
}

pub(super) fn initialize(connection: &Connection, catalog: &str) -> Result<(), StoreError> {
    connection
        .execute_batch("BEGIN TRANSACTION")
        .map_err(database)?;
    let initialized = connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {catalog}.metadata_state(singleton BOOLEAN PRIMARY KEY CHECK(singleton),revision BIGINT NOT NULL CHECK(revision>=0)); \
         INSERT INTO {catalog}.metadata_state VALUES(TRUE,0) ON CONFLICT DO NOTHING; \
         CREATE TABLE IF NOT EXISTS {catalog}.metadata_records(collection VARCHAR NOT NULL,record_key VARCHAR NOT NULL,version BIGINT NOT NULL CHECK(version>0),value VARCHAR NOT NULL,PRIMARY KEY(collection,record_key)); \
         CREATE TABLE IF NOT EXISTS {catalog}.metadata_collections(collection VARCHAR PRIMARY KEY,version BIGINT NOT NULL CHECK(version>0)); \
         CREATE TABLE IF NOT EXISTS {catalog}.metadata_operations(operation VARCHAR PRIMARY KEY,fingerprint VARCHAR NOT NULL,revision BIGINT NOT NULL CHECK(revision>0)); \
         CREATE TABLE IF NOT EXISTS {catalog}.metadata_events(revision BIGINT PRIMARY KEY CHECK(revision>0),event VARCHAR NOT NULL); \
         CREATE TABLE IF NOT EXISTS {catalog}.metadata_prepared_parts(id VARCHAR PRIMARY KEY,content VARCHAR NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);"
    ));
    let initialized = initialized
        .map_err(database)
        .and_then(|_| crate::journal::initialize(connection, catalog));
    if let Err(error) = initialized {
        let _ = connection.execute_batch("ROLLBACK");
        return Err(error);
    }
    if let Err(error) = connection.execute_batch("COMMIT") {
        let _ = connection.execute_batch("ROLLBACK");
        return Err(database(error));
    }
    Ok(())
}

pub(super) fn read(
    connection: &Connection,
    catalog: &str,
    keys: &[RecordKey],
) -> Result<Vec<MetadataRecord>, StoreError> {
    if keys.len() > sortsys_zerotrust::metadata::MAX_OPERATIONS {
        return Err(StoreError::Integrity);
    }
    for key in keys {
        checked_record(key)?;
    }
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    // Include an ordinal so missing and repeated keys retain the caller's exact
    // order. A single LEFT JOIN replaces one planned query per snapshot guard.
    let selection = keys
        .iter()
        .enumerate()
        .map(|(index, _)| format!("({index},?,?)"))
        .collect::<Vec<_>>()
        .join(",");
    let parameters = keys.iter().flat_map(|key| [&key.collection, &key.key]);
    let mut statement = connection
        .prepare(&format!(
            "SELECT record.version,record.value
             FROM (VALUES {selection}) selected(ordinal,collection,record_key)
             LEFT JOIN {catalog}.metadata_records record
             ON record.collection=selected.collection AND record.record_key=selected.record_key
             ORDER BY selected.ordinal"
        ))
        .map_err(database)?;
    let rows = statement
        .query_map(params_from_iter(parameters), |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })
        .map_err(database)?;
    let mut records = Vec::with_capacity(keys.len());
    for (key, row) in keys.iter().zip(rows) {
        let (version, value) = row.map_err(database)?;
        records.push(MetadataRecord {
            record: key.clone(),
            version: version.map(|value| value.to_string()),
            value,
        });
    }
    if records.len() != keys.len() {
        return Err(StoreError::Integrity);
    }
    Ok(records)
}

fn collection_version(
    connection: &Connection,
    catalog: &str,
    collection: &str,
) -> Result<i64, StoreError> {
    let current: Option<i64> = connection
        .query_row(
            &format!("SELECT version FROM {catalog}.metadata_collections WHERE collection=?"),
            [collection],
            |row| row.get(0),
        )
        .optional()
        .map_err(database)?;
    Ok(current.unwrap_or(0))
}

pub(super) fn scan(
    connection: &Connection,
    catalog: &str,
    input: &ScanRequest,
) -> Result<RecordPage, StoreError> {
    sortsys_zerotrust::crypto::identifier(&input.collection).map_err(|_| StoreError::Integrity)?;
    let limit = input.limit.unwrap_or(DEFAULT_SCAN_PAGE);
    if !(1..=MAX_SCAN_PAGE).contains(&limit) {
        return Err(StoreError::Integrity);
    }
    if let Some(prefix) = &input.prefix {
        checked_record(&RecordKey {
            collection: input.collection.clone(),
            key: prefix.clone(),
        })?;
    }
    if let Some(after) = &input.after {
        checked_record(&RecordKey {
            collection: input.collection.clone(),
            key: after.clone(),
        })?;
    }
    let current = collection_version(connection, catalog, &input.collection)?;
    if input
        .version
        .as_ref()
        .is_some_and(|expected| version(expected).ok() != Some(current))
    {
        return Err(StoreError::Conflict);
    }
    let mut statement = connection.prepare(&format!(
        "SELECT record_key,version,value FROM {catalog}.metadata_records WHERE collection=? AND record_key>? AND starts_with(record_key,?) ORDER BY record_key LIMIT ?"
    )).map_err(database)?;
    let rows = statement
        .query_map(
            params![
                input.collection,
                input.after.as_deref().unwrap_or(""),
                input.prefix.as_deref().unwrap_or(""),
                (limit + 1) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(database)?;
    let mut records = Vec::new();
    let mut bytes = 0;
    let mut more = false;
    for row in rows {
        let (key, version, value) = row.map_err(database)?;
        if records.len() == limit
            || (limit > DEFAULT_SCAN_PAGE
                && !records.is_empty()
                && bytes + value.len() > WIDE_SCAN_BYTES)
        {
            more = true;
            break;
        }
        bytes += value.len();
        records.push(MetadataRecord {
            record: RecordKey {
                collection: input.collection.clone(),
                key,
            },
            version: Some(version.to_string()),
            value: Some(value),
        });
    }
    let after = if more {
        records.last().map(|record| record.record.key.clone())
    } else {
        None
    };
    Ok(RecordPage {
        version: current.to_string(),
        records,
        after,
    })
}

pub(super) fn transact(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
) -> Result<MetadataReceipt, StoreError> {
    batch.validate().map_err(|_| StoreError::Integrity)?;
    transact_checked(connection, catalog, batch)
}

pub(super) fn transact_prepared(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
) -> Result<MetadataReceipt, StoreError> {
    batch
        .validate_prepared()
        .map_err(|_| StoreError::Integrity)?;
    transact_checked(connection, catalog, batch)
}

fn transact_checked(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
) -> Result<MetadataReceipt, StoreError> {
    let fingerprint = batch.fingerprint();
    connection
        .execute_batch("BEGIN TRANSACTION")
        .map_err(database)?;
    let result = apply(connection, catalog, batch, &fingerprint);
    match result {
        Ok(receipt) => {
            if let Err(error) = connection.execute_batch("COMMIT") {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(database(error));
            }
            Ok(receipt)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub(super) fn check_reads(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    for checks in batch
        .checks
        .chunks(sortsys_zerotrust::metadata::MAX_OPERATIONS)
    {
        let keys = checks
            .iter()
            .map(|check| check.record.clone())
            .collect::<Vec<_>>();
        let records = read(connection, catalog, &keys)?;
        for (check, record) in checks.iter().zip(records) {
            let expected = check.version.as_deref().map(version).transpose()?;
            let found = record.version.as_deref().map(version).transpose()?;
            if found != expected {
                return Err(StoreError::Conflict);
            }
        }
    }
    for checks in batch
        .collections
        .chunks(sortsys_zerotrust::metadata::MAX_OPERATIONS)
    {
        for check in checks {
            version(&check.version)?;
        }
        let selection = vec!["(?,?)"; checks.len()].join(",");
        let parameters = checks
            .iter()
            .flat_map(|check| [&check.collection, &check.version]);
        let mut statement = connection
            .prepare(&format!(
                "SELECT COALESCE(record.version,0),CAST(selected.version AS BIGINT)
             FROM (VALUES {selection}) selected(collection,version)
             LEFT JOIN {catalog}.metadata_collections record
             ON record.collection=selected.collection"
            ))
            .map_err(database)?;
        let records = statement
            .query_map(params_from_iter(parameters), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(database)?;
        for record in records {
            let (found, expected) = record.map_err(database)?;
            if found != expected {
                return Err(StoreError::Conflict);
            }
        }
    }
    Ok(())
}

/// Validate an assembled read snapshot without producing a write, operation
/// receipt or event. Writes continue to use the atomic batch endpoint.
pub(super) fn validate_snapshot(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    batch.validate().map_err(|_| StoreError::Integrity)?;
    validate_snapshot_checked(connection, catalog, batch)
}

pub(super) fn validate_prepared_snapshot(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    batch
        .validate_prepared()
        .map_err(|_| StoreError::Integrity)?;
    validate_snapshot_checked(connection, catalog, batch)
}

fn validate_snapshot_checked(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    if !batch.puts.is_empty()
        || !batch.deletes.is_empty()
        || !batch.hints.is_empty()
        || !batch.journal.is_empty()
    {
        return Err(StoreError::Integrity);
    }
    connection
        .execute_batch("BEGIN TRANSACTION")
        .map_err(database)?;
    match check_reads(connection, catalog, batch) {
        Ok(()) => {
            if let Err(error) = connection.execute_batch("COMMIT") {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(database(error));
            }
            Ok(())
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub(super) fn prior_receipt(
    connection: &Connection,
    catalog: &str,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<MetadataReceipt>, StoreError> {
    let prior: Option<(String, i64)> = connection
        .query_row(
            &format!(
                "SELECT fingerprint,revision FROM {catalog}.metadata_operations WHERE operation=?"
            ),
            [operation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(database)?;
    let Some((expected, revision)) = prior else {
        return Ok(None);
    };
    if expected != fingerprint {
        return Err(StoreError::Conflict);
    }
    Ok(Some(MetadataReceipt {
        operation: operation.into(),
        revision: revision.to_string(),
    }))
}

fn apply(
    connection: &Connection,
    catalog: &str,
    batch: &MetadataBatch,
    fingerprint: &str,
) -> Result<MetadataReceipt, StoreError> {
    if let Some(receipt) = prior_receipt(connection, catalog, &batch.operation, fingerprint)? {
        return Ok(receipt);
    }
    check_reads(connection, catalog, batch)?;
    let revision: i64 = connection.query_row(
        &format!("UPDATE {catalog}.metadata_state SET revision=revision+1 WHERE singleton RETURNING revision"),
        [], |row| row.get(0),
    ).map_err(database)?;
    let mut changed = Vec::with_capacity(batch.puts.len() + batch.deletes.len());
    let mut collections = BTreeSet::new();
    let mut put_record = connection.prepare(&format!(
        "INSERT INTO {catalog}.metadata_records VALUES(?,?,?,?) ON CONFLICT(collection,record_key) DO UPDATE SET version=excluded.version,value=excluded.value"
    )).map_err(database)?;
    for put in &batch.puts {
        put_record
            .execute(params![
                put.record.collection,
                put.record.key,
                revision,
                put.value
            ])
            .map_err(database)?;
        changed.push(put.record.clone());
        collections.insert(put.record.collection.as_str());
    }
    for deletion in &batch.deletes {
        connection
            .execute(
                &format!(
                    "DELETE FROM {catalog}.metadata_records WHERE collection=? AND record_key=?"
                ),
                params![deletion.collection, deletion.key],
            )
            .map_err(database)?;
        changed.push(deletion.clone());
        collections.insert(deletion.collection.as_str());
    }
    for collection in collections {
        connection.execute(
            &format!("INSERT INTO {catalog}.metadata_collections VALUES(?,?) ON CONFLICT(collection) DO UPDATE SET version=excluded.version"),
            params![collection,revision],
        ).map_err(database)?;
    }
    crate::journal::append(connection, catalog, &batch.journal)?;
    let event = MetadataEvent {
        revision: revision.to_string(),
        changed,
        hints: batch.hints.clone(),
    };
    connection
        .execute(
            &format!("INSERT INTO {catalog}.metadata_events VALUES(?,?)"),
            params![
                revision,
                serde_json::to_string(&event).map_err(|_| StoreError::Integrity)?
            ],
        )
        .map_err(database)?;
    connection
        .execute(
            &format!("INSERT INTO {catalog}.metadata_operations VALUES(?,?,?)"),
            params![batch.operation, fingerprint, revision],
        )
        .map_err(database)?;
    Ok(MetadataReceipt {
        operation: batch.operation.clone(),
        revision: revision.to_string(),
    })
}

pub(crate) fn read_transaction<T>(
    connection: &Connection,
    read: impl FnOnce() -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    connection
        .execute_batch("BEGIN TRANSACTION")
        .map_err(database)?;
    let result = read();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK");
        return result;
    }
    if let Err(error) = connection.execute_batch("COMMIT") {
        let _ = connection.execute_batch("ROLLBACK");
        return Err(database(error));
    }
    result
}

pub(super) fn changes(
    connection: &Connection,
    catalog: &str,
    after: Option<&str>,
) -> Result<ChangesPage, StoreError> {
    if let Some(after) = after {
        version(after)?;
    }
    read_transaction(connection, || {
        let head: i64 = connection
            .query_row(
                &format!("SELECT revision FROM {catalog}.metadata_state WHERE singleton=TRUE"),
                [],
                |row| row.get(0),
            )
            .map_err(database)?;
        let events = match after {
            Some(after) => events(connection, catalog, after)?,
            None => vec![],
        };
        Ok(ChangesPage {
            head: head.to_string(),
            events,
        })
    })
}

pub(super) fn events(
    connection: &Connection,
    catalog: &str,
    after: &str,
) -> Result<Vec<MetadataEvent>, StoreError> {
    let after = version(after)?;
    let mut statement = connection.prepare(&format!(
        "SELECT event FROM {catalog}.metadata_events WHERE revision>? ORDER BY revision LIMIT 128"
    )).map_err(database)?;
    let rows = statement
        .query_map([after], |row| row.get::<_, String>(0))
        .map_err(database)?;
    let mut result = Vec::new();
    for row in rows {
        result.push(
            serde_json::from_str(&row.map_err(database)?).map_err(|_| StoreError::Integrity)?,
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sortsys_zerotrust::metadata::{CollectionCheck, RecordCheck, RecordPut};

    fn key(value: &str) -> RecordKey {
        RecordKey {
            collection: "accounts".into(),
            key: value.into(),
        }
    }
    fn batch(
        operation: &str,
        record: RecordKey,
        expected: Option<&str>,
        value: &str,
    ) -> MetadataBatch {
        MetadataBatch {
            operation: operation.into(),
            checks: vec![RecordCheck {
                record: record.clone(),
                version: expected.map(str::to_owned),
            }],
            collections: vec![],
            puts: vec![RecordPut {
                record,
                value: value.into(),
            }],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        }
    }
    fn memory() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection, "memory").unwrap();
        connection
    }

    #[test]
    fn wide_scan_continues_after_the_last_returned_record_at_its_size_limit() {
        let connection = memory();
        let full_page = "x".repeat(WIDE_SCAN_BYTES);
        for (record, value) in [("first", full_page.as_str()), ("second", "small")] {
            transact(
                &connection,
                "memory",
                &batch(record, key(record), None, value),
            )
            .unwrap();
        }

        let mut input = ScanRequest {
            target: Target::System,
            collection: "accounts".into(),
            after: None,
            version: None,
            prefix: None,
            limit: Some(MAX_SCAN_PAGE),
        };
        let first = scan(&connection, "memory", &input).unwrap();
        assert_eq!(first.records.len(), 1);
        assert_eq!(first.after.as_deref(), Some("first"));

        input.after = first.after;
        input.version = Some(first.version);
        let second = scan(&connection, "memory", &input).unwrap();
        assert_eq!(second.records.len(), 1);
        assert_eq!(second.records[0].record, key("second"));
        assert_eq!(second.after, None);
    }

    #[test]
    fn batched_reads_preserve_order_duplicates_absences_and_collection_identity() {
        let connection = memory();
        transact(
            &connection,
            "memory",
            &batch("first", key("one"), None, "first-value"),
        )
        .unwrap();
        let other_collection = RecordKey {
            collection: "policies".into(),
            key: "one".into(),
        };
        transact(
            &connection,
            "memory",
            &batch("second", other_collection.clone(), None, "second-value"),
        )
        .unwrap();
        let keys = [key("missing"), other_collection, key("one"), key("one")];
        let records = read(&connection, "memory", &keys).unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| &record.record)
                .collect::<Vec<_>>(),
            keys.iter().collect::<Vec<_>>()
        );
        assert_eq!(
            records
                .iter()
                .map(|record| record.value.as_deref())
                .collect::<Vec<_>>(),
            vec![
                None,
                Some("second-value"),
                Some("first-value"),
                Some("first-value")
            ]
        );
        assert_eq!(
            records
                .iter()
                .map(|record| record.version.as_deref())
                .collect::<Vec<_>>(),
            vec![None, Some("2"), Some("1"), Some("1")]
        );
        assert!(read(&connection, "memory", &[]).unwrap().is_empty());
        let invalid = RecordKey {
            collection: "".into(),
            key: "one".into(),
        };
        assert!(matches!(
            read(&connection, "memory", &[invalid]),
            Err(StoreError::Integrity)
        ));
    }
    #[test]
    fn batched_collection_guards_detect_the_first_insert_into_an_empty_collection() {
        let connection = memory();
        transact(
            &connection,
            "memory",
            &batch("first-account", key("one"), None, "account"),
        )
        .unwrap();
        let policy = RecordKey {
            collection: "policies".into(),
            key: "one".into(),
        };
        transact(
            &connection,
            "memory",
            &batch("first-policy", policy, None, "policy"),
        )
        .unwrap();
        let mut snapshot = MetadataBatch {
            operation: "collection-snapshot".into(),
            checks: vec![],
            collections: vec![
                CollectionCheck {
                    collection: "accounts".into(),
                    version: "1".into(),
                },
                CollectionCheck {
                    collection: "empty".into(),
                    version: "0".into(),
                },
                CollectionCheck {
                    collection: "policies".into(),
                    version: "2".into(),
                },
            ],
            puts: vec![],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        };
        validate_snapshot(&connection, "memory", &snapshot).unwrap();
        let inserted = RecordKey {
            collection: "empty".into(),
            key: "first".into(),
        };
        transact(
            &connection,
            "memory",
            &batch("first-insert", inserted, None, "new-value"),
        )
        .unwrap();
        assert!(matches!(
            validate_snapshot(&connection, "memory", &snapshot),
            Err(StoreError::Conflict)
        ));
        snapshot.collections[1].version = "3".into();
        validate_snapshot(&connection, "memory", &snapshot).unwrap();
    }
    #[test]
    fn prepared_read_guards_check_every_chunk_before_any_write() {
        let connection = memory();
        let count = sortsys_zerotrust::metadata::MAX_OPERATIONS + 17;
        let mut snapshot = MetadataBatch {
            operation: "many-guards".into(),
            checks: (0..count)
                .map(|index| RecordCheck {
                    record: key(&format!("missing:{index}")),
                    version: None,
                })
                .collect(),
            collections: vec![],
            puts: vec![],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        };
        validate_prepared_snapshot(&connection, "memory", &snapshot).unwrap();
        snapshot.checks.last_mut().unwrap().version = Some("1".into());
        assert!(matches!(
            validate_prepared_snapshot(&connection, "memory", &snapshot),
            Err(StoreError::Conflict)
        ));
        snapshot.puts.push(RecordPut {
            record: key("must-not-exist"),
            value: "unpublished".into(),
        });
        snapshot.checks.push(RecordCheck {
            record: key("must-not-exist"),
            version: None,
        });
        assert!(matches!(
            transact_prepared(&connection, "memory", &snapshot),
            Err(StoreError::Conflict)
        ));
        assert!(
            read(&connection, "memory", &[key("must-not-exist")]).unwrap()[0]
                .value
                .is_none()
        );
        assert!(events(&connection, "memory", "0").unwrap().is_empty());
    }
    #[test]
    fn prefix_pages_match_literal_keys_and_keep_the_full_collection_snapshot() {
        let connection = memory();
        for (index, name) in ["member:001", "member:002", "member:003", "member_004"]
            .iter()
            .enumerate()
        {
            transact(
                &connection,
                "memory",
                &batch(
                    &format!("create:{index}"),
                    key(name),
                    None,
                    "public-reference",
                ),
            )
            .unwrap();
        }
        let mut request = ScanRequest {
            target: Target::System,
            collection: "accounts".into(),
            after: None,
            version: None,
            prefix: Some("member:".into()),
            limit: Some(2),
        };
        let first = scan(&connection, "memory", &request).unwrap();
        assert_eq!(first.records.len(), 2);
        assert_eq!(first.records[0].record.key, "member:001");
        request.after = first.after;
        request.version = Some(first.version);
        let next = scan(&connection, "memory", &request).unwrap();
        assert_eq!(next.records.len(), 1);
        assert_eq!(next.records[0].record.key, "member:003");
        request.prefix = Some("member_".into());
        request.after = None;
        let literal = scan(&connection, "memory", &request).unwrap();
        assert_eq!(literal.records.len(), 1);
        assert_eq!(literal.records[0].record.key, "member_004");
        transact(
            &connection,
            "memory",
            &batch("other-prefix", key("unrelated"), None, "changed"),
        )
        .unwrap();
        assert!(matches!(
            scan(&connection, "memory", &request),
            Err(StoreError::Conflict)
        ));
        request.version = None;
        request.limit = Some(0);
        assert!(matches!(
            scan(&connection, "memory", &request),
            Err(StoreError::Integrity)
        ));
    }
    #[test]
    fn read_validation_detects_changed_snapshots_without_creating_writes_or_receipts() {
        let connection = memory();
        transact(
            &connection,
            "memory",
            &batch("create:1", key("member:1"), None, "account"),
        )
        .unwrap();
        let mut snapshot = MetadataBatch {
            operation: "validate:read".into(),
            checks: vec![RecordCheck {
                record: key("member:1"),
                version: Some("1".into()),
            }],
            collections: vec![CollectionCheck {
                collection: "accounts".into(),
                version: "1".into(),
            }],
            puts: vec![],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        };
        validate_snapshot(&connection, "memory", &snapshot).unwrap();
        validate_snapshot(&connection, "memory", &snapshot).unwrap();
        assert_eq!(events(&connection, "memory", "0").unwrap().len(), 1);
        let receipts: i64 = connection
            .query_row("SELECT count(*) FROM metadata_operations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(receipts, 1);
        transact(
            &connection,
            "memory",
            &batch("create:2", key("member:2"), None, "peer"),
        )
        .unwrap();
        assert!(matches!(
            validate_snapshot(&connection, "memory", &snapshot),
            Err(StoreError::Conflict)
        ));
        snapshot.collections.clear();
        validate_snapshot(&connection, "memory", &snapshot).unwrap();
        transact(
            &connection,
            "memory",
            &batch("update:1", key("member:1"), Some("1"), "changed"),
        )
        .unwrap();
        assert!(matches!(
            validate_snapshot(&connection, "memory", &snapshot),
            Err(StoreError::Conflict)
        ));
        let attempted_write = batch("must-not-write", key("member:3"), None, "injected");
        assert!(matches!(
            validate_snapshot(&connection, "memory", &attempted_write),
            Err(StoreError::Integrity)
        ));
        assert!(
            read(&connection, "memory", &[key("member:3")]).unwrap()[0]
                .value
                .is_none()
        );
        assert_eq!(events(&connection, "memory", "0").unwrap().len(), 3);
    }
    #[test]
    fn exact_retries_keep_the_original_receipt_and_reused_operations_cannot_overwrite() {
        let connection = memory();
        let created = batch("create:1", key("member:1"), None, "opaque-account-v1");
        let original = transact(&connection, "memory", &created).unwrap();
        transact(
            &connection,
            "memory",
            &batch("update:1", key("member:1"), Some("1"), "opaque-account-v2"),
        )
        .unwrap();
        assert_eq!(transact(&connection, "memory", &created).unwrap(), original);
        let mut forged = created.clone();
        forged.puts[0].value = "different-content".into();
        assert!(matches!(
            transact(&connection, "memory", &forged),
            Err(StoreError::Conflict)
        ));
        assert_eq!(
            read(&connection, "memory", &[key("member:1")]).unwrap()[0]
                .value
                .as_deref(),
            Some("opaque-account-v2")
        );
        assert_eq!(events(&connection, "memory", "0").unwrap().len(), 2);
    }
    #[test]
    fn a_late_storage_failure_rolls_back_values_versions_receipts_and_events() {
        let connection = memory();
        transact(
            &connection,
            "memory",
            &batch("create:1", key("member:1"), None, "original"),
        )
        .unwrap();
        connection.execute_batch("DROP TABLE metadata_events; CREATE TABLE metadata_events(revision BIGINT PRIMARY KEY CHECK(revision<2),event VARCHAR NOT NULL);").unwrap();
        let attempt = batch("failed:1", key("member:1"), Some("1"), "must-not-survive");
        assert!(transact(&connection, "memory", &attempt).is_err());
        let record = &read(&connection, "memory", &[key("member:1")]).unwrap()[0];
        assert_eq!(record.version.as_deref(), Some("1"));
        assert_eq!(record.value.as_deref(), Some("original"));
        let version: i64 = connection
            .query_row("SELECT revision FROM metadata_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        let receipts: i64 = connection
            .query_row("SELECT count(*) FROM metadata_operations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(receipts, 1);
    }
    #[test]
    fn collection_pages_refuse_phantoms_and_record_checks_prevent_lost_updates() {
        let connection = memory();
        let mut creation = MetadataBatch {
            operation: "create:many".into(),
            checks: vec![],
            collections: vec![],
            puts: vec![],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        };
        for index in 0..129 {
            let record = key(&format!("member:{index:04}"));
            creation.checks.push(RecordCheck {
                record: record.clone(),
                version: None,
            });
            creation.puts.push(RecordPut {
                record,
                value: format!("ciphertext-reference:{index}"),
            });
        }
        transact(&connection, "memory", &creation).unwrap();
        let mut request = ScanRequest {
            target: Target::System,
            collection: "accounts".into(),
            after: None,
            version: None,
            prefix: None,
            limit: None,
        };
        let first = scan(&connection, "memory", &request).unwrap();
        assert_eq!(first.records.len(), 128);
        assert!(first.after.is_some());
        request.after = first.after;
        request.version = Some(first.version);
        transact(
            &connection,
            "memory",
            &batch("insert:late", key("member:9999"), None, "late"),
        )
        .unwrap();
        assert!(matches!(
            scan(&connection, "memory", &request),
            Err(StoreError::Conflict)
        ));
        let mut guarded = batch("guarded:write", key("member:0000"), Some("1"), "changed");
        guarded.collections.push(CollectionCheck {
            collection: "accounts".into(),
            version: "1".into(),
        });
        assert!(matches!(
            transact(&connection, "memory", &guarded),
            Err(StoreError::Conflict)
        ));
        transact(
            &connection,
            "memory",
            &batch("peer:write", key("member:0000"), Some("1"), "peer"),
        )
        .unwrap();
        assert!(matches!(
            transact(
                &connection,
                "memory",
                &batch("stale:write", key("member:0000"), Some("1"), "stale")
            ),
            Err(StoreError::Conflict)
        ));
    }
    #[test]
    fn a_tenant_database_snapshot_contains_ciphertexts_and_control_records_together() {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let suffix = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("sortsys_control_snapshot_{suffix}.duckdb"));
        let connection = memory();
        connection.execute_batch("CREATE TABLE ciphertexts(id VARCHAR PRIMARY KEY,content VARCHAR NOT NULL); INSERT INTO ciphertexts VALUES('ciphertext:1','opaque-body');").unwrap();
        transact(
            &connection,
            "memory",
            &batch("create:1", key("member:1"), None, "opaque-vault-reference"),
        )
        .unwrap();
        connection
            .execute_batch(&format!(
                "ATTACH {} AS backup; COPY FROM DATABASE memory TO backup; DETACH backup;",
                super::super::sql_string(path.to_str().unwrap())
            ))
            .unwrap();
        let restored = Connection::open(&path).unwrap();
        let record = &read(&restored, "main", &[key("member:1")]).unwrap()[0];
        assert_eq!(record.value.as_deref(), Some("opaque-vault-reference"));
        let body: String = restored
            .query_row(
                "SELECT content FROM ciphertexts WHERE id='ciphertext:1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(body, "opaque-body");
        assert_eq!(
            transact(
                &restored,
                "main",
                &batch("create:1", key("member:1"), None, "opaque-vault-reference")
            )
            .unwrap()
            .revision,
            "1"
        );
        drop(restored);
        std::fs::remove_file(path).unwrap();
    }
}
