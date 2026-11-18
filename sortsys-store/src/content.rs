//! Resumable, unpublished content copies from closed snapshots. Only opaque
//! records and ciphertexts are handled here; activation belongs to the API.
use std::{
    collections::{BTreeSet, HashSet},
    io::Read,
    path::Path,
};

use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sortsys_zerotrust::{
    content_epoch::{ContentEpoch, head_key, namespace_record},
    crypto::{encode, identifier, revision, sized},
    metadata::{MetadataBatch, MetadataRecord, RecordCheck, RecordKey, RecordPut},
};

use crate::{
    MAX_CIPHERTEXT_BYTES, StoreError, content_id, metadata, snapshot_id, sql_string, witness,
};

const PAGE_SIZE: usize = 32;
const VALUE_BUDGET: usize = 4 * 1024 * 1024;
const PREPARATIONS: &str = "zt-content-preparations";
const OPERATIONS: &str = "zt-content-preparation-operations";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    number: String,
    request: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SnapshotSelection {
    pub tenant: String,
    pub operation: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DescribeInput {
    pub source: SnapshotSelection,
    pub records: Vec<RecordKey>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Description {
    pub id: String,
    pub bytes: u64,
    pub digest: String,
    pub head: Option<ContentEpoch>,
    pub collections: Vec<String>,
    pub records: Vec<MetadataRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareInput {
    pub source: SnapshotSelection,
    pub operation: String,
    pub number: String,
    pub previous: Option<String>,
    pub snapshot: String,
    pub source_number: String,
    pub source_head: Option<String>,
    pub collections: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preparation {
    pub operation: String,
    pub number: String,
    pub previous: Option<String>,
    pub snapshot: String,
    pub source_number: String,
    pub source_head: Option<String>,
    pub request: String,
    pub phase: Phase,
    pub collection: usize,
    pub after: Option<String>,
    pub records: String,
    pub ciphertexts: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Reset,
    Metadata,
    Ciphertexts,
    Ready,
}

pub fn preparation_key(number: &str) -> Result<RecordKey, StoreError> {
    revision(number).map_err(|_| StoreError::Integrity)?;
    Ok(RecordKey {
        collection: PREPARATIONS.into(),
        key: format!("epoch-{number}"),
    })
}

fn database(_: duckdb::Error) -> StoreError {
    StoreError::Unavailable("content-preparation")
}

fn zero_revision(value: &str) -> Result<i64, StoreError> {
    if value == "0" {
        return Ok(0);
    }
    revision(value).map_err(|_| StoreError::Integrity)
}

impl PrepareInput {
    pub fn fingerprint(&self) -> Result<String, StoreError> {
        let encoded = serde_json::to_vec(self).map_err(|_| StoreError::Integrity)?;
        Ok(encode(&Sha256::digest(encoded)))
    }

    fn initial(&self) -> Result<Preparation, StoreError> {
        identifier(&self.source.tenant).map_err(|_| StoreError::Integrity)?;
        identifier(&self.operation).map_err(|_| StoreError::Integrity)?;
        sized::<32>(&self.snapshot).map_err(|_| StoreError::Integrity)?;
        let number = revision(&self.number).map_err(|_| StoreError::Integrity)?;
        let source = zero_revision(&self.source_number)?;
        if source >= number
            || (source == 0) != self.source_head.is_none()
            || (number == 1) != self.previous.is_none()
        {
            return Err(StoreError::Integrity);
        }
        for hash in [&self.previous, &self.source_head].into_iter().flatten() {
            sized::<32>(hash).map_err(|_| StoreError::Integrity)?;
        }
        let mut selected = BTreeSet::new();
        for collection in &self.collections {
            let record = RecordKey {
                collection: collection.clone(),
                key: "sample".into(),
            };
            record.validate().map_err(|_| StoreError::Integrity)?;
            namespace_record(&record, &self.number).map_err(|_| StoreError::Integrity)?;
            if !selected.insert(collection) {
                return Err(StoreError::Integrity);
            }
        }
        Ok(Preparation {
            operation: self.operation.clone(),
            number: self.number.clone(),
            previous: self.previous.clone(),
            snapshot: self.snapshot.clone(),
            source_number: self.source_number.clone(),
            source_head: self.source_head.clone(),
            request: self.fingerprint()?,
            phase: Phase::Reset,
            collection: 0,
            after: None,
            records: "0".into(),
            ciphertexts: "0".into(),
        })
    }
}

/// A snapshot is opened on an isolated read-only connection. The query context
/// has no other tenant catalogs and cannot access external files or networks.
pub(crate) struct Source {
    connection: Connection,
    pub description: Description,
}

pub(crate) struct CopyPlan {
    source: Source,
    input: PrepareInput,
    initial: Preparation,
}

impl Source {
    pub(crate) fn plan(self, input: PrepareInput) -> Result<CopyPlan, StoreError> {
        self.verify(&input)?;
        let initial = input.initial()?;
        Ok(CopyPlan {
            source: self,
            input,
            initial,
        })
    }
    pub(crate) fn open(directory: &Path, input: &DescribeInput) -> Result<Self, StoreError> {
        if input.records.len() > 32 {
            return Err(StoreError::Integrity);
        }
        let id = snapshot_id(&input.source.tenant, &input.source.operation)?;
        let path = directory.join("snapshots").join(format!("{id}.duckdb"));
        if !path
            .symlink_metadata()
            .map_err(|_| StoreError::NotFound)?
            .is_file()
        {
            return Err(StoreError::Integrity);
        }
        let wal = path.with_extension("duckdb.wal");
        match wal.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(StoreError::Integrity),
            Err(_) => return Err(StoreError::Unavailable("snapshot-wal")),
        }
        let mut file = std::fs::File::open(&path).map_err(|_| StoreError::NotFound)?;
        let bytes = file
            .metadata()
            .map_err(|_| StoreError::Unavailable("snapshot-size"))?
            .len();
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 256 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| StoreError::Unavailable("snapshot-read"))?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        let digest = encode(&hash.finalize());
        let connection = Connection::open_in_memory().map_err(database)?;
        connection.execute_batch("SET memory_limit='256MB'; SET threads=1; SET autoload_known_extensions=false; SET autoinstall_known_extensions=false;").map_err(database)?;
        let path = path.to_str().ok_or(StoreError::Integrity)?;
        connection
            .execute_batch(&format!(
                "ATTACH {} AS source (READ_ONLY); SET enable_external_access=false;",
                sql_string(path)
            ))
            .map_err(database)?;
        let head = metadata::read(&connection, "source", &[head_key()])?
            .pop()
            .ok_or(StoreError::Integrity)?;
        let head: Option<ContentEpoch> = head
            .value
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| StoreError::Integrity)?;
        if let Some(head) = &head {
            head.frame().map_err(|_| StoreError::Integrity)?;
            if head.tenant != input.source.tenant {
                return Err(StoreError::Integrity);
            }
        }
        let mut statement = connection
            .prepare("SELECT DISTINCT collection FROM source.metadata_records ORDER BY collection")
            .map_err(database)?;
        let collections = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database)?;
        drop(statement);
        let records = metadata::read(&connection, "source", &input.records)?;
        Ok(Self {
            connection,
            description: Description {
                id,
                bytes,
                digest,
                head,
                collections,
                records,
            },
        })
    }

    fn verify(&self, input: &PrepareInput) -> Result<(), StoreError> {
        input.initial()?;
        let head = self.description.head.as_ref();
        if self.description.digest != input.snapshot
            || head.map_or("0", |head| head.number.as_str()) != input.source_number
            || head
                .map(ContentEpoch::fingerprint)
                .transpose()
                .map_err(|_| StoreError::Integrity)?
                != input.source_head
        {
            return Err(StoreError::Integrity);
        }
        let available = self.description.collections.iter().collect::<HashSet<_>>();
        for collection in &input.collections {
            let physical = namespace_record(
                &RecordKey {
                    collection: collection.clone(),
                    key: "sample".into(),
                },
                &input.source_number,
            )
            .map_err(|_| StoreError::Integrity)?;
            if !available.contains(&physical.collection) {
                return Err(StoreError::Integrity);
            }
        }
        Ok(())
    }

    fn rows(
        &self,
        collection: &str,
        after: Option<String>,
    ) -> Result<Vec<MetadataRecord>, StoreError> {
        let mut page = metadata::scan(
            &self.connection,
            "source",
            &metadata::ScanRequest {
                target: metadata::Target::System,
                collection: collection.into(),
                prefix: None,
                after,
                version: None,
                limit: Some(PAGE_SIZE),
            },
        )?
        .records;
        let mut bytes = 0;
        let mut count = 0;
        for row in &page {
            let size = row.value.as_ref().ok_or(StoreError::Integrity)?.len();
            if size > sortsys_zerotrust::metadata::MAX_RECORD_BYTES {
                return Err(StoreError::Integrity);
            }
            if count > 0 && bytes + size > VALUE_BUDGET {
                break;
            }
            bytes += size;
            count += 1;
        }
        page.truncate(count);
        Ok(page)
    }

    fn ciphertexts(&self, after: Option<&str>) -> Result<Vec<(String, String)>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT id,content FROM source.ciphertexts WHERE id>? ORDER BY id LIMIT 4")
            .map_err(database)?;
        let rows = statement
            .query_map([after.unwrap_or("")], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database)?;
        let mut result = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let (id, data) = row.map_err(database)?;
            if data.len() > MAX_CIPHERTEXT_BYTES || content_id(&data) != id {
                return Err(StoreError::Integrity);
            }
            if !result.is_empty() && bytes + data.len() > MAX_CIPHERTEXT_BYTES {
                break;
            }
            bytes += data.len();
            result.push((id, data));
        }
        Ok(result)
    }
}

fn current_head(
    connection: &Connection,
    catalog: &str,
    input: &PrepareInput,
) -> Result<MetadataRecord, StoreError> {
    let record = metadata::read(connection, catalog, &[head_key()])?
        .pop()
        .ok_or(StoreError::Integrity)?;
    let context = metadata::Target::Tenant {
        tenant: input.source.tenant.clone(),
    }
    .context()?;
    witness::validate_records(connection, &context, std::slice::from_ref(&record))?;
    let current: Option<ContentEpoch> = record
        .value
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| StoreError::Integrity)?;
    let current_number = current
        .as_ref()
        .map(|head| revision(&head.number))
        .transpose()
        .map_err(|_| StoreError::Integrity)?
        .unwrap_or(0);
    if current
        .as_ref()
        .is_some_and(|head| head.tenant != input.source.tenant)
    {
        return Err(StoreError::Integrity);
    }
    let previous = current
        .as_ref()
        .map(ContentEpoch::fingerprint)
        .transpose()
        .map_err(|_| StoreError::Integrity)?;
    if current_number.checked_add(1)
        != Some(revision(&input.number).map_err(|_| StoreError::Integrity)?)
        || previous != input.previous
    {
        return Err(StoreError::Conflict);
    }
    Ok(record)
}

fn empty_batch() -> Result<MetadataBatch, StoreError> {
    Ok(MetadataBatch {
        operation: sortsys_zerotrust::crypto::random_id()
            .map_err(|_| StoreError::Unavailable("content-operation"))?,
        checks: Vec::new(),
        collections: Vec::new(),
        puts: Vec::new(),
        deletes: Vec::new(),
        hints: Vec::new(),
        journal: Vec::new(),
    })
}

/// One bounded transaction per call. The caller releases the service lock
/// between calls, allowing ordinary tenant work to continue during a copy.
pub(crate) fn advance(
    connection: &Connection,
    catalog: &str,
    plan: &CopyPlan,
) -> Result<Preparation, StoreError> {
    let source = &plan.source;
    let input = &plan.input;
    let head = current_head(connection, catalog, input)?;
    let key = preparation_key(&input.number)?;
    let operation_key = RecordKey {
        collection: OPERATIONS.into(),
        key: input.operation.clone(),
    };
    let records = metadata::read(connection, catalog, &[key.clone(), operation_key.clone()])?;
    let stored = &records[0];
    let operation = &records[1];
    let prior: Option<Operation> = operation
        .value
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| StoreError::Integrity)?;
    let existing: Option<Preparation> = stored
        .value
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| StoreError::Integrity)?;
    let initial = plan.initial.clone();
    let same = existing
        .as_ref()
        .is_some_and(|state| state.request == initial.request);
    if prior.is_some_and(|prior| {
        prior.number != initial.number || prior.request != initial.request || !same
    }) {
        return Err(StoreError::Conflict);
    }
    let mut state = if same { existing.unwrap() } else { initial };
    if state.operation != input.operation
        || state.number != input.number
        || state.previous != input.previous
        || state.snapshot != input.snapshot
        || state.source_number != input.source_number
        || state.source_head != input.source_head
    {
        return Err(StoreError::Integrity);
    }
    if same && state.phase == Phase::Ready {
        return Ok(state);
    }
    let mut batch = empty_batch()?;
    batch.checks.extend([
        RecordCheck {
            record: head.record,
            version: head.version,
        },
        RecordCheck {
            record: key.clone(),
            version: stored.version.clone(),
        },
        RecordCheck {
            record: operation_key.clone(),
            version: operation.version.clone(),
        },
    ]);
    if !same {
        // Superseding an unpublished preparation invalidates its next step by
        // changing this same guarded row. An active namespace is never reset.
        batch.puts.push(RecordPut {
            record: key,
            value: serde_json::to_string(&state).map_err(|_| StoreError::Integrity)?,
        });
        batch.puts.push(RecordPut {
            record: operation_key,
            value: serde_json::to_string(&Operation {
                number: state.number.clone(),
                request: state.request.clone(),
            })
            .map_err(|_| StoreError::Integrity)?,
        });
    } else {
        match state.phase {
            Phase::Reset => {
                let prefix = format!("zt-data:{}:", state.number);
                let mut statement = connection.prepare(&format!("SELECT collection,record_key,version FROM {catalog}.metadata_records WHERE starts_with(collection,?) ORDER BY collection,record_key LIMIT {PAGE_SIZE}")).map_err(database)?;
                let rows = statement
                    .query_map([&prefix], |row| {
                        Ok((
                            RecordKey {
                                collection: row.get(0)?,
                                key: row.get(1)?,
                            },
                            row.get::<_, i64>(2)?,
                        ))
                    })
                    .map_err(database)?;
                for row in rows {
                    let (record, version) = row.map_err(database)?;
                    batch.checks.push(RecordCheck {
                        record: record.clone(),
                        version: Some(version.to_string()),
                    });
                    batch.deletes.push(record);
                }
                if batch.deletes.is_empty() {
                    state.phase = Phase::Metadata;
                }
            }
            Phase::Metadata => {
                if let Some(collection) = input.collections.get(state.collection) {
                    let sample = RecordKey {
                        collection: collection.clone(),
                        key: "sample".into(),
                    };
                    let source_collection = namespace_record(&sample, &input.source_number)
                        .map_err(|_| StoreError::Integrity)?
                        .collection;
                    let rows = source.rows(&source_collection, state.after.clone())?;
                    if rows.is_empty() {
                        state.collection += 1;
                        state.after = None;
                    } else {
                        state.records = zero_revision(&state.records)?
                            .checked_add(rows.len() as i64)
                            .ok_or(StoreError::Integrity)?
                            .to_string();
                        state.after = rows.last().map(|row| row.record.key.clone());
                        let target_collection = namespace_record(&sample, &input.number)
                            .map_err(|_| StoreError::Integrity)?
                            .collection;
                        for row in rows {
                            let record = RecordKey {
                                collection: target_collection.clone(),
                                key: row.record.key,
                            };
                            batch.checks.push(RecordCheck {
                                record: record.clone(),
                                version: None,
                            });
                            batch.puts.push(RecordPut {
                                record,
                                value: row.value.ok_or(StoreError::Integrity)?,
                            });
                        }
                    }
                } else {
                    state.phase = Phase::Ciphertexts;
                    state.collection = 0;
                    state.after = None;
                }
            }
            Phase::Ciphertexts => {
                let rows = source.ciphertexts(state.after.as_deref())?;
                for (id, data) in &rows {
                    let existing: Option<String> = connection
                        .query_row(
                            &format!("SELECT content FROM {catalog}.ciphertexts WHERE id=?"),
                            [id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(database)?;
                    if existing.as_ref().is_some_and(|existing| existing != data) {
                        return Err(StoreError::Integrity);
                    }
                    // Immutable blocks can be staged before the metadata commit,
                    // just as in normal uploads. Failed steps leave no references.
                    connection
                        .execute(
                            &format!(
                                "INSERT INTO {catalog}.ciphertexts(id,content)
                                 VALUES(?,?) ON CONFLICT(id) DO NOTHING"
                            ),
                            params![id, data],
                        )
                        .map_err(database)?;
                }
                state.ciphertexts = zero_revision(&state.ciphertexts)?
                    .checked_add(rows.len() as i64)
                    .ok_or(StoreError::Integrity)?
                    .to_string();
                state.after = rows.last().map(|(id, _)| id.clone());
                if rows.is_empty() {
                    state.phase = Phase::Ready;
                }
            }
            Phase::Ready => unreachable!("ready preparations return before copying"),
        }
        batch.puts.push(RecordPut {
            record: key,
            value: serde_json::to_string(&state).map_err(|_| StoreError::Integrity)?,
        });
    }
    let context = metadata::Target::Tenant {
        tenant: input.source.tenant.clone(),
    }
    .context()?;
    witness::transact(connection, catalog, &context, &batch, false)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        connection: Connection,
        directory: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "sortsys-content-copy-{}",
                sortsys_zerotrust::crypto::random_id().unwrap()
            ));
            std::fs::create_dir_all(directory.join("snapshots")).unwrap();
            let connection = Connection::open(directory.join("control.duckdb")).unwrap();
            connection
                .execute_batch(
                    "ATTACH ':memory:' AS tenant;
                 CREATE TABLE tenant.ciphertexts(
                     id VARCHAR PRIMARY KEY CHECK(length(id)=64),
                     content VARCHAR NOT NULL CHECK(sha256(content)=id),
                     created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
                 );",
                )
                .unwrap();
            metadata::initialize(&connection, "tenant").unwrap();
            witness::initialize(&connection).unwrap();
            Self {
                connection,
                directory,
            }
        }

        fn put(&self, records: Vec<(RecordKey, String)>) {
            let keys = records
                .iter()
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let current = metadata::read(&self.connection, "tenant", &keys).unwrap();
            let mut batch = empty_batch().unwrap();
            for ((record, value), current) in records.into_iter().zip(current) {
                batch.checks.push(RecordCheck {
                    record: record.clone(),
                    version: current.version,
                });
                batch.puts.push(RecordPut { record, value });
            }
            witness::transact(
                &self.connection,
                "tenant",
                &metadata::Target::Tenant {
                    tenant: "laboratory".into(),
                }
                .context()
                .unwrap(),
                &batch,
                false,
            )
            .unwrap();
        }

        fn snapshot(&self, operation: &str) -> SnapshotSelection {
            let selection = SnapshotSelection {
                tenant: "laboratory".into(),
                operation: operation.into(),
            };
            let id = snapshot_id(&selection.tenant, operation).unwrap();
            let path = self
                .directory
                .join("snapshots")
                .join(format!("{id}.duckdb"));
            self.connection
                .execute_batch(&format!(
                    "ATTACH {} AS backup; COPY FROM DATABASE tenant TO backup; DETACH backup;",
                    sql_string(path.to_str().unwrap())
                ))
                .unwrap();
            selection
        }

        fn open(&self, selection: &SnapshotSelection) -> Source {
            Source::open(
                &self.directory,
                &DescribeInput {
                    source: selection.clone(),
                    records: vec![key("accounts", "member")],
                },
            )
            .unwrap()
        }

        fn read(&self, key: RecordKey) -> Option<String> {
            metadata::read(&self.connection, "tenant", &[key])
                .unwrap()
                .pop()
                .unwrap()
                .value
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn key(collection: &str, key: &str) -> RecordKey {
        RecordKey {
            collection: collection.into(),
            key: key.into(),
        }
    }

    fn input(source: &Source, selection: SnapshotSelection, operation: &str) -> PrepareInput {
        PrepareInput {
            source: selection,
            operation: operation.into(),
            number: "1".into(),
            previous: None,
            snapshot: source.description.digest.clone(),
            source_number: "0".into(),
            source_head: None,
            collections: vec!["documents".into()],
        }
    }

    fn complete(fixture: &Fixture, plan: &CopyPlan) -> Preparation {
        for _ in 0..100 {
            let state = advance(&fixture.connection, "tenant", plan).unwrap();
            if state.phase == Phase::Ready {
                return state;
            }
        }
        panic!("a bounded fixture copy must finish");
    }

    #[test]
    fn closed_snapshot_copy_is_unpublished_resumable_and_preserves_current_control_and_blobs() {
        let fixture = Fixture::new();
        let records = (0..80)
            .map(|number| {
                (
                    key("documents", &format!("d-{number:03}")),
                    number.to_string(),
                )
            })
            .collect::<Vec<_>>();
        fixture.put(records);
        fixture.put(vec![
            (key("accounts", "member"), "1".into()),
            (
                key("file-chunks", "chunk-one"),
                "\"opaque-block-reference\"".into(),
            ),
        ]);
        for data in ["opaque-original", "opaque-Ä-漢"] {
            fixture
                .connection
                .execute(
                    "INSERT INTO tenant.ciphertexts(id,content) VALUES(?,?)",
                    params![content_id(data), data],
                )
                .unwrap();
        }
        let selection = fixture.snapshot("original");
        fixture.put(vec![
            (key("documents", "d-000"), "999".into()),
            (key("accounts", "member"), "9".into()),
            (
                key("file-chunks", "chunk-one"),
                "\"newer-block-reference\"".into(),
            ),
        ]);
        fixture
            .connection
            .execute(
                "INSERT INTO tenant.ciphertexts(id,content) VALUES(?,?)",
                params![content_id("opaque-newer"), "opaque-newer"],
            )
            .unwrap();
        let source = fixture.open(&selection);
        assert_eq!(source.description.records[0].value.as_deref(), Some("1"));
        assert_eq!(
            source.description.id,
            snapshot_id("laboratory", "original").unwrap()
        );
        let request = input(&source, selection.clone(), "copy-one");
        let plan = source.plan(request.clone()).unwrap();
        for _ in 0..3 {
            advance(&fixture.connection, "tenant", &plan).unwrap();
        }
        assert_eq!(
            fixture.read(key("documents", "d-000")).as_deref(),
            Some("999")
        );
        drop(plan);

        let reopened = fixture.open(&selection).plan(request).unwrap();
        let ready = complete(&fixture, &reopened);
        assert_eq!(ready.records, "80");
        assert_eq!(ready.ciphertexts, "2");
        assert_eq!(
            fixture
                .read(namespace_record(&key("documents", "d-000"), "1").unwrap())
                .as_deref(),
            Some("0")
        );
        assert_eq!(
            fixture.read(key("documents", "d-000")).as_deref(),
            Some("999")
        );
        assert_eq!(
            fixture.read(key("accounts", "member")).as_deref(),
            Some("9")
        );
        assert!(fixture.read(head_key()).is_none());
        assert_eq!(
            fixture.read(key("file-chunks", "chunk-one")).as_deref(),
            Some("\"newer-block-reference\"")
        );
        let before: i64 = fixture
            .connection
            .query_row("SELECT revision FROM tenant.metadata_state", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            advance(&fixture.connection, "tenant", &reopened).unwrap(),
            ready
        );
        let after: i64 = fixture
            .connection
            .query_row("SELECT revision FROM tenant.metadata_state", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(before, after);
        let blobs: i64 = fixture
            .connection
            .query_row("SELECT count(*) FROM tenant.ciphertexts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(blobs, 3);
    }

    #[test]
    fn superseded_preparations_cannot_reclaim_a_namespace_and_wrong_digests_never_start() {
        let fixture = Fixture::new();
        fixture.put(vec![(key("documents", "one"), "1".into())]);
        let old = fixture.snapshot("old");
        fixture.put(vec![(key("documents", "one"), "2".into())]);
        let new = fixture.snapshot("new");
        let source = fixture.open(&old);
        let mut wrong = input(&source, old.clone(), "wrong");
        wrong.snapshot = encode(&[9; 32]);
        assert!(source.plan(wrong).is_err());
        assert!(fixture.read(preparation_key("1").unwrap()).is_none());
        let source = fixture.open(&old);
        let original = source
            .plan(input(&fixture.open(&old), old, "first"))
            .unwrap();
        advance(&fixture.connection, "tenant", &original).unwrap();
        let source = fixture.open(&new);
        let replacement_input = input(&source, new, "replacement");
        let replacement = source.plan(replacement_input).unwrap();
        advance(&fixture.connection, "tenant", &replacement).unwrap();
        assert!(matches!(
            advance(&fixture.connection, "tenant", &original),
            Err(StoreError::Conflict)
        ));
        complete(&fixture, &replacement);
        assert_eq!(
            fixture
                .read(namespace_record(&key("documents", "one"), "1").unwrap())
                .as_deref(),
            Some("2")
        );

        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../sortsys-zerotrust/test/fixtures/content-epochs.json"
        ))
        .unwrap();
        fixture.put(vec![(head_key(), value["epochs"][0].to_string())]);
        assert!(matches!(
            advance(&fixture.connection, "tenant", &replacement),
            Err(StoreError::Conflict)
        ));
        assert_eq!(
            fixture
                .read(namespace_record(&key("documents", "one"), "1").unwrap())
                .as_deref(),
            Some("2")
        );
    }
}
