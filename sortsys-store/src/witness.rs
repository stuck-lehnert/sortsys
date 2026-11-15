//! Durable heads outside a tenant backup. A write-ahead intent bridges the two
//! DuckDB files: no request may pass a pending or mismatched record witness.
//! The service's connection mutex covers admission, publication and recovery.
use crate::{StoreError, metadata};
use duckdb::{Connection, OptionalExt, params, params_from_iter, types::Value};
use sortsys_zerotrust::{
    anchors::{ANCHOR_COLLECTION, RecordAnchor, RecordBinding, RecordCheckpoint},
    metadata::{MetadataBatch, MetadataReceipt, MetadataRecord, RecordKey, RecordPut},
};
use std::collections::BTreeMap;

const BINDING_OWNER_QUERY: &str = "SELECT anchor_key FROM control.record_bindings WHERE context=? AND collection=? AND record_key=?";

fn database(_: duckdb::Error) -> StoreError {
    StoreError::Unavailable("record-witness")
}

pub(super) fn initialize(connection: &Connection) -> Result<(), StoreError> {
    connection
        .execute_batch(
            "BEGIN;
         CREATE TABLE IF NOT EXISTS control.record_witnesses(
             context VARCHAR NOT NULL,
             record_key VARCHAR NOT NULL,
             value VARCHAR NOT NULL,
             PRIMARY KEY(context,record_key)
         );
         CREATE TABLE IF NOT EXISTS control.witness_intents(
             context VARCHAR PRIMARY KEY,
             batch VARCHAR NOT NULL
         );
         CREATE TABLE IF NOT EXISTS control.record_bindings(
             context VARCHAR NOT NULL,
             anchor_key VARCHAR NOT NULL,
             collection VARCHAR NOT NULL,
             record_key VARCHAR NOT NULL,
             version BIGINT NOT NULL,
             fingerprint VARCHAR NOT NULL,
             value VARCHAR NOT NULL,
             PRIMARY KEY(context,collection,record_key)
         );
         COMMIT;",
        )
        .map_err(database)
}

fn anchor(value: &str) -> Result<RecordAnchor, StoreError> {
    let value: RecordAnchor = serde_json::from_str(value).map_err(|_| StoreError::Integrity)?;
    value.validate().map_err(|_| StoreError::Integrity)?;
    Ok(value)
}

fn witness(
    connection: &Connection,
    context: &str,
    key: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT value FROM control.record_witnesses WHERE context=? AND record_key=?",
            params![context, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(database)
}

fn changes(batch: &MetadataBatch) -> Result<Vec<&RecordPut>, StoreError> {
    if batch
        .deletes
        .iter()
        .any(|key| key.collection == ANCHOR_COLLECTION)
    {
        return Err(StoreError::Integrity);
    }
    Ok(batch
        .puts
        .iter()
        .filter(|put| put.record.collection == ANCHOR_COLLECTION)
        .collect())
}

fn check_advances(
    connection: &Connection,
    catalog: &str,
    context: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    let mut owners = BTreeMap::new();
    for put in changes(batch)? {
        let previous = witness(connection, context, &put.record.key)?;
        let current = metadata::read(connection, catalog, std::slice::from_ref(&put.record))?
            .pop()
            .ok_or(StoreError::Integrity)?
            .value;
        if previous != current {
            return Err(StoreError::Integrity);
        }
        let previous = previous.as_deref().map(anchor).transpose()?;
        let next = anchor(&put.value)?;
        next.follows(previous.as_ref())
            .map_err(|_| StoreError::Integrity)?;
        let checkpoint =
            RecordCheckpoint::from_payload(&next.payload).map_err(|_| StoreError::Integrity)?;
        let previous_checkpoint = previous
            .as_ref()
            .map(|value| RecordCheckpoint::from_payload(&value.payload))
            .transpose()
            .map_err(|_| StoreError::Integrity)?
            .flatten();
        if previous_checkpoint.is_some() && checkpoint.is_none() {
            return Err(StoreError::Integrity);
        }
        if let Some(checkpoint) = checkpoint {
            checkpoint
                .follows(previous_checkpoint.as_ref())
                .map_err(|_| StoreError::Integrity)?;
            for binding in &checkpoint.records {
                if batch.deletes.contains(&binding.record) {
                    return Err(StoreError::Integrity);
                }
                let identity = (
                    binding.record.collection.clone(),
                    binding.record.key.clone(),
                );
                if owners.insert(identity, put.record.key.clone()).is_some() {
                    return Err(StoreError::Integrity);
                }
                let owner: Option<String> = connection.query_row(
                    "SELECT anchor_key FROM control.record_bindings WHERE context=? AND collection=? AND record_key=?",
                    params![context, binding.record.collection, binding.record.key], |row| row.get(0)
                ).optional().map_err(database)?;
                if owner.as_ref().is_some_and(|owner| owner != &put.record.key) {
                    return Err(StoreError::Integrity);
                }
                let value = match batch
                    .puts
                    .iter()
                    .find(|value| value.record == binding.record)
                {
                    Some(put) => put.value.clone(),
                    None => {
                        metadata::read(connection, catalog, std::slice::from_ref(&binding.record))?
                            .pop()
                            .and_then(|row| row.value)
                            .ok_or(StoreError::Integrity)?
                    }
                };
                binding.verify(&value).map_err(|_| StoreError::Integrity)?;
            }
        }
    }
    Ok(())
}

fn bound_owner(
    statement: &mut duckdb::Statement<'_>,
    context: &str,
    record: &sortsys_zerotrust::metadata::RecordKey,
) -> Result<Option<String>, StoreError> {
    statement
        .query_row(params![context, record.collection, record.key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(database)
}

/// A bound value may only advance with its owning checkpoint. Reject this
/// before a tenant write, rather than discovering a broken witness afterwards.
fn check_bound_changes(
    connection: &Connection,
    context: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    if context == "system" {
        return Ok(());
    }
    let mut ownership = connection.prepare(BINDING_OWNER_QUERY).map_err(database)?;
    let anchors = changes(batch)?
        .into_iter()
        .map(|put| (put.record.key.as_str(), put))
        .collect::<BTreeMap<_, _>>();
    for record in &batch.deletes {
        if bound_owner(&mut ownership, context, record)?.is_some() {
            return Err(StoreError::Integrity);
        }
    }
    for put in &batch.puts {
        if let Some(owner) = bound_owner(&mut ownership, context, &put.record)? {
            let owner = anchors.get(owner.as_str()).ok_or(StoreError::Integrity)?;
            let checkpoint = RecordCheckpoint::from_payload(&anchor(&owner.value)?.payload)
                .map_err(|_| StoreError::Integrity)?
                .ok_or(StoreError::Integrity)?;
            let binding = checkpoint
                .records
                .iter()
                .find(|binding| binding.record == put.record)
                .ok_or(StoreError::Integrity)?;
            binding
                .verify(&put.value)
                .map_err(|_| StoreError::Integrity)?;
        }
    }
    Ok(())
}

/// Compare returned values with the independent binding. Only requested rows
/// are hashed; large tenants do not rehash every document on each cursor event.
pub(super) fn validate_records(
    connection: &Connection,
    context: &str,
    records: &[MetadataRecord],
) -> Result<(), StoreError> {
    if context == "system" {
        return Ok(());
    }
    for records in records.chunks(sortsys_zerotrust::metadata::MAX_OPERATIONS) {
        let keys = records
            .iter()
            .map(|row| row.record.clone())
            .collect::<Vec<_>>();
        let (selected, parameters) = record_selection(&keys, context);
        let mut query = connection
            .prepare(&format!(
                "SELECT binding.collection,binding.record_key,binding.version,binding.fingerprint
             FROM control.record_bindings binding
             JOIN (VALUES {selected}) selected(collection,record_key)
             ON selected.collection=binding.collection AND selected.record_key=binding.record_key
             WHERE binding.context=?"
            ))
            .map_err(database)?;
        let bindings = query
            .query_map(params_from_iter(parameters), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(database)?;
        let mut expected = BTreeMap::new();
        for binding in bindings {
            let (collection, key, version, fingerprint) = binding.map_err(database)?;
            expected.insert((collection, key), (version, fingerprint));
        }
        for record in records {
            let identity = (record.record.collection.clone(), record.record.key.clone());
            if let Some((version, fingerprint)) = expected.get(&identity) {
                verify_bound_record(record, *version, fingerprint)?;
            }
        }
    }
    Ok(())
}

fn record_selection(keys: &[RecordKey], context: &str) -> (String, Vec<Value>) {
    let placeholders = vec!["(?,?)"; keys.len()].join(",");
    let mut parameters = Vec::with_capacity(keys.len() * 2 + 1);
    for record in keys {
        parameters.push(Value::Text(record.collection.clone()));
        parameters.push(Value::Text(record.key.clone()));
    }
    parameters.push(Value::Text(context.into()));
    (placeholders, parameters)
}

fn verify_bound_record(
    record: &MetadataRecord,
    version: i64,
    fingerprint: &str,
) -> Result<(), StoreError> {
    let version = version.to_string();
    if record.version.as_deref() != Some(version.as_str()) {
        return Err(StoreError::Integrity);
    }
    RecordBinding {
        record: record.record.clone(),
        fingerprint: fingerprint.into(),
    }
    .verify(record.value.as_deref().ok_or(StoreError::Integrity)?)
    .map_err(|_| StoreError::Integrity)
}

pub(super) fn validate_checks(
    connection: &Connection,
    catalog: &str,
    context: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    if context == "system" {
        return Ok(());
    }
    for checks in batch
        .checks
        .chunks(sortsys_zerotrust::metadata::MAX_OPERATIONS)
    {
        let keys = checks
            .iter()
            .map(|check| check.record.clone())
            .collect::<Vec<_>>();
        let (selected, parameters) = record_selection(&keys, context);
        let mut query = connection.prepare(&format!(
            "SELECT binding.collection,binding.record_key,binding.version,binding.fingerprint,record.version,record.value
             FROM control.record_bindings binding
             JOIN (VALUES {selected}) selected(collection,record_key)
             ON selected.collection=binding.collection AND selected.record_key=binding.record_key
             LEFT JOIN {catalog}.metadata_records record
             ON record.collection=binding.collection AND record.record_key=binding.record_key
             WHERE binding.context=?"
        )).map_err(database)?;
        let rows = query
            .query_map(params_from_iter(parameters), |row| {
                let current_version = row.get::<_, Option<i64>>(4)?;
                let record = MetadataRecord {
                    record: RecordKey {
                        collection: row.get(0)?,
                        key: row.get(1)?,
                    },
                    version: current_version.map(|value| value.to_string()),
                    value: row.get(5)?,
                };
                Ok((record, row.get::<_, i64>(2)?, row.get::<_, String>(3)?))
            })
            .map_err(database)?;
        for row in rows {
            let (record, version, fingerprint) = row.map_err(database)?;
            verify_bound_record(&record, version, &fingerprint)?;
        }
    }
    Ok(())
}

fn save_intent(
    connection: &Connection,
    context: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    let value = serde_json::to_string(batch).map_err(|_| StoreError::Integrity)?;
    // This is a committed write-ahead record in a different file. It must be
    // durable before the tenant transaction can publish a new recovery head.
    connection
        .execute(
            "INSERT INTO control.witness_intents VALUES(?,?)",
            params![context, value],
        )
        .map_err(database)?;
    Ok(())
}

fn finish_intent(
    connection: &Connection,
    catalog: &str,
    context: &str,
    batch: &MetadataBatch,
) -> Result<(), StoreError> {
    connection
        .execute_batch("BEGIN TRANSACTION")
        .map_err(database)?;
    let result = (|| {
        for put in changes(batch)? {
            let checkpoint = RecordCheckpoint::from_payload(&anchor(&put.value)?.payload)
                .map_err(|_| StoreError::Integrity)?;
            if let Some(checkpoint) = checkpoint {
                for binding in checkpoint.records {
                    let row =
                        metadata::read(connection, catalog, std::slice::from_ref(&binding.record))?
                            .pop()
                            .ok_or(StoreError::Integrity)?;
                    let value = row.value.ok_or(StoreError::Integrity)?;
                    binding.verify(&value).map_err(|_| StoreError::Integrity)?;
                    let version = row
                        .version
                        .ok_or(StoreError::Integrity)?
                        .parse::<i64>()
                        .map_err(|_| StoreError::Integrity)?;
                    connection.execute(
                        "INSERT INTO control.record_bindings VALUES(?,?,?,?,?,?,?) ON CONFLICT(context,collection,record_key) DO UPDATE SET version=excluded.version,fingerprint=excluded.fingerprint,value=excluded.value",
                        params![context, put.record.key, binding.record.collection, binding.record.key, version, binding.fingerprint, value]
                    ).map_err(database)?;
                }
            }
            connection
                .execute(
                    "INSERT INTO control.record_witnesses VALUES(?,?,?)
                 ON CONFLICT(context,record_key) DO UPDATE SET value=excluded.value",
                    params![context, put.record.key, put.value],
                )
                .map_err(database)?;
        }
        connection
            .execute(
                "DELETE FROM control.witness_intents WHERE context=?",
                [context],
            )
            .map_err(database)?;
        connection.execute_batch("COMMIT").map_err(database)
    })();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK");
    }
    result
}

/// Run before any tenant metadata read, validation, journal or mutation. A
/// pending transaction is replayed exactly, including its original CAS guards.
/// Never infer a witness from a restored tenant file or erase a stale witness.
pub(super) fn admit(
    connection: &Connection,
    catalog: &str,
    context: &str,
) -> Result<(), StoreError> {
    let pending: Option<String> = connection
        .query_row(
            "SELECT batch FROM control.witness_intents WHERE context=?",
            [context],
            |row| row.get(0),
        )
        .optional()
        .map_err(database)?;
    if let Some(pending) = pending {
        let batch: MetadataBatch =
            serde_json::from_str(&pending).map_err(|_| StoreError::Integrity)?;
        batch
            .validate_prepared()
            .map_err(|_| StoreError::Integrity)?;
        if changes(&batch)?.is_empty() {
            return Err(StoreError::Integrity);
        }
        // A crash can happen before or after the tenant COMMIT. The operation
        // receipt distinguishes these cases without guessing from a version.
        let published =
            metadata::prior_receipt(connection, catalog, &batch.operation, &batch.fingerprint())?;
        if published.is_none() {
            check_advances(connection, catalog, context, &batch)?;
        }
        metadata::transact_prepared(connection, catalog, &batch)?;
        finish_intent(connection, catalog, context, &batch)?;
    }
    check_heads(connection, catalog, context)
}

fn check_heads(connection: &Connection, catalog: &str, context: &str) -> Result<(), StoreError> {
    let mismatched: i64 = connection
        .query_row(
            &format!(
                "SELECT count(*) FROM
                 (SELECT record_key,value FROM control.record_witnesses WHERE context=?) witness
                 FULL OUTER JOIN
                 (SELECT record_key,value FROM {catalog}.metadata_records WHERE collection=?) record
                 ON record.record_key=witness.record_key
                 WHERE record.value IS NULL OR witness.value IS NULL OR record.value<>witness.value"
            ),
            params![context, ANCHOR_COLLECTION],
            |row| row.get(0),
        )
        .map_err(database)?;
    if mismatched != 0 {
        return Err(StoreError::Integrity);
    }
    let stale_bindings: i64 = connection
        .query_row(
            &format!(
                "SELECT count(*) FROM control.record_bindings binding
         LEFT JOIN {catalog}.metadata_records record
         ON record.collection=binding.collection AND record.record_key=binding.record_key
         WHERE binding.context=? AND (record.version IS NULL OR record.version<>binding.version)"
            ),
            [context],
            |row| row.get(0),
        )
        .map_err(database)?;
    if stale_bindings != 0 {
        return Err(StoreError::Integrity);
    }
    Ok(())
}

pub(super) fn transact(
    connection: &Connection,
    catalog: &str,
    context: &str,
    batch: &MetadataBatch,
    prepared: bool,
) -> Result<MetadataReceipt, StoreError> {
    if prepared {
        batch
            .validate_prepared()
            .map_err(|_| StoreError::Integrity)?;
    } else {
        batch.validate().map_err(|_| StoreError::Integrity)?;
    }
    admit(connection, catalog, context)?;
    validate_checks(connection, catalog, context, batch)?;
    check_bound_changes(connection, context, batch)?;
    let protected = !changes(batch)?.is_empty();
    if !protected {
        return if prepared {
            metadata::transact_prepared(connection, catalog, batch)
        } else {
            metadata::transact(connection, catalog, batch)
        };
    }
    if catalog == "control" {
        // A witness in the same file would disappear with the protected data.
        return Err(StoreError::Integrity);
    }
    if let Some(receipt) =
        metadata::prior_receipt(connection, catalog, &batch.operation, &batch.fingerprint())?
    {
        return Ok(receipt);
    }
    check_advances(connection, catalog, context, batch)?;
    metadata::check_reads(connection, catalog, batch)?;
    save_intent(connection, context, batch)?;
    let receipt = match metadata::transact_prepared(connection, catalog, batch) {
        Ok(receipt) => receipt,
        Err(error) => {
            if matches!(error, StoreError::Conflict | StoreError::Integrity) {
                // The live operation reported a rolled-back validation failure.
                // Remove its intent only after independently observing the old
                // heads and the absence of a committed operation receipt.
                // An interrupted or uncertain COMMIT is never cancelled here.
                if metadata::prior_receipt(
                    connection,
                    catalog,
                    &batch.operation,
                    &batch.fingerprint(),
                )?
                .is_none()
                    && check_heads(connection, catalog, context).is_ok()
                {
                    connection
                        .execute(
                            "DELETE FROM control.witness_intents WHERE context=?",
                            [context],
                        )
                        .map_err(database)?;
                }
            }
            return Err(error);
        }
    };
    finish_intent(connection, catalog, context, batch)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sortsys_zerotrust::metadata::{RecordCheck, RecordKey};

    const CONTEXT: &str = "tenant:witness-test";

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("ATTACH ':memory:' AS control; ATTACH ':memory:' AS tenant")
            .unwrap();
        initialize(&connection).unwrap();
        metadata::initialize(&connection, "tenant").unwrap();
        connection
    }

    fn head() -> RecordKey {
        RecordKey {
            collection: ANCHOR_COLLECTION.into(),
            key: "authority".into(),
        }
    }

    fn batch(connection: &Connection, operation: &str, payload: &str) -> MetadataBatch {
        let credential = RecordKey {
            collection: "credentials".into(),
            key: "owner".into(),
        };
        let rows = metadata::read(connection, "tenant", &[head(), credential.clone()]).unwrap();
        let previous = rows[0].value.as_deref().map(anchor).transpose().unwrap();
        let next = match previous {
            Some(previous) => previous.next(payload.into()).unwrap(),
            None => RecordAnchor::initial(payload.into()).unwrap(),
        };
        MetadataBatch {
            operation: operation.into(),
            checks: rows
                .into_iter()
                .map(|row| RecordCheck {
                    record: row.record,
                    version: row.version,
                })
                .collect(),
            collections: vec![],
            puts: vec![
                RecordPut {
                    record: head(),
                    value: serde_json::to_string(&next).unwrap(),
                },
                RecordPut {
                    record: credential,
                    value: format!("credential:{payload}"),
                },
            ],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        }
    }

    fn saved_payload(connection: &Connection) -> String {
        let record = metadata::read(connection, "tenant", &[head()])
            .unwrap()
            .pop()
            .unwrap();
        anchor(record.value.as_deref().unwrap()).unwrap().payload
    }

    fn intent_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT count(*) FROM control.witness_intents", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn document_key(name: &str) -> RecordKey {
        RecordKey {
            collection: "documents".into(),
            key: name.into(),
        }
    }

    fn checkpoint_batch(
        connection: &Connection,
        operation: &str,
        owner: &str,
        values: &[(&str, &str)],
    ) -> MetadataBatch {
        let owner = RecordKey {
            collection: ANCHOR_COLLECTION.into(),
            key: owner.into(),
        };
        let mut keys = vec![owner.clone()];
        keys.extend(values.iter().map(|(name, _)| document_key(name)));
        let rows = metadata::read(connection, "tenant", &keys).unwrap();
        let previous = rows[0].value.as_deref().map(anchor).transpose().unwrap();
        let previous_checkpoint = previous
            .as_ref()
            .and_then(|value| RecordCheckpoint::from_payload(&value.payload).unwrap());
        let mut bindings = BTreeMap::new();
        if let Some(previous) = previous_checkpoint {
            for binding in previous.records {
                bindings.insert(binding.record.key.clone(), binding);
            }
        }
        let mut puts = Vec::new();
        for (name, value) in values {
            let record = document_key(name);
            let binding = RecordBinding::bind(record.clone(), value).unwrap();
            bindings.insert(name.to_string(), binding);
            puts.push(RecordPut {
                record,
                value: value.to_string(),
            });
        }
        let checkpoint = RecordCheckpoint::new(bindings.into_values().collect()).unwrap();
        let payload = serde_json::to_string(&checkpoint).unwrap();
        let next = match previous {
            Some(previous) => previous.next(payload).unwrap(),
            None => RecordAnchor::initial(payload).unwrap(),
        };
        puts.push(RecordPut {
            record: owner,
            value: serde_json::to_string(&next).unwrap(),
        });
        MetadataBatch {
            operation: operation.into(),
            checks: rows
                .into_iter()
                .map(|row| RecordCheck {
                    record: row.record,
                    version: row.version,
                })
                .collect(),
            collections: vec![],
            puts,
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        }
    }

    #[test]
    fn bound_values_are_independently_retained_and_only_advance_with_their_owner() {
        let connection = connection();
        let first = checkpoint_batch(
            &connection,
            "lock",
            "lock:one",
            &[("one", "locked ciphertext")],
        );
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        let retained: String = connection
            .query_row(
                "SELECT value FROM control.record_bindings WHERE context=? AND record_key='one'",
                [CONTEXT],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, "locked ciphertext");
        let mut unprotected = checkpoint_batch(
            &connection,
            "overwrite",
            "lock:one",
            &[("one", "replacement")],
        );
        unprotected
            .puts
            .retain(|put| put.record.collection != ANCHOR_COLLECTION);
        assert!(transact(&connection, "tenant", CONTEXT, &unprotected, false).is_err());
        let mut deletion = unprotected.clone();
        deletion.operation = "delete".into();
        deletion.puts.clear();
        deletion.deletes.push(document_key("one"));
        assert!(transact(&connection, "tenant", CONTEXT, &deletion, false).is_err());
        let stolen = checkpoint_batch(
            &connection,
            "steal",
            "lock:other",
            &[("one", "replacement")],
        );
        assert!(transact(&connection, "tenant", CONTEXT, &stolen, false).is_err());
        assert_eq!(intent_count(&connection), 0);
        admit(&connection, "tenant", CONTEXT).unwrap();
        let next = checkpoint_batch(
            &connection,
            "advance",
            "lock:one",
            &[("one", "new ciphertext"), ("history", "prior evidence")],
        );
        transact(&connection, "tenant", CONTEXT, &next, false).unwrap();
        let records = metadata::read(
            &connection,
            "tenant",
            &[document_key("one"), document_key("history")],
        )
        .unwrap();
        validate_records(&connection, CONTEXT, &records).unwrap();
        assert_eq!(records[0].value.as_deref(), Some("new ciphertext"));
    }

    #[test]
    fn checkpoints_cannot_discard_bindings_downgrade_or_double_claim_values() {
        let connection = connection();
        let first = checkpoint_batch(
            &connection,
            "first",
            "owner",
            &[("one", "one"), ("two", "two")],
        );
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        let next = checkpoint_batch(&connection, "next", "owner", &[("one", "changed")]);
        let remaining = RecordBinding::bind(document_key("one"), "changed").unwrap();
        let missing_binding = RecordCheckpoint::new(vec![remaining]).unwrap();
        let missing_binding = serde_json::to_string(&missing_binding).unwrap();
        for payload in ["null".to_string(), missing_binding] {
            let mut invalid = next.clone();
            let put = invalid
                .puts
                .iter_mut()
                .find(|put| put.record.collection == ANCHOR_COLLECTION)
                .unwrap();
            let mut value = anchor(&put.value).unwrap();
            value.payload = payload;
            put.value = serde_json::to_string(&value).unwrap();
            assert!(transact(&connection, "tenant", CONTEXT, &invalid, false).is_err());
        }
        let mut double_claim = checkpoint_batch(&connection, "double", "left", &[("new", "same")]);
        let right = checkpoint_batch(&connection, "unused", "right", &[("new", "same")]);
        double_claim.checks.push(right.checks[0].clone());
        double_claim.puts.push(right.puts.last().unwrap().clone());
        assert!(transact(&connection, "tenant", CONTEXT, &double_claim, false).is_err());
        assert_eq!(intent_count(&connection), 0);
        admit(&connection, "tenant", CONTEXT).unwrap();
    }

    #[test]
    fn binding_a_record_deleted_in_the_same_batch_fails_before_intent_publication() {
        let connection = connection();
        let mut plain = checkpoint_batch(&connection, "plain", "unused", &[("one", "value")]);
        plain
            .puts
            .retain(|put| put.record.collection != ANCHOR_COLLECTION);
        transact(&connection, "tenant", CONTEXT, &plain, false).unwrap();
        let mut invalid =
            checkpoint_batch(&connection, "bind-and-delete", "owner", &[("one", "value")]);
        invalid
            .puts
            .retain(|put| put.record.collection == ANCHOR_COLLECTION);
        invalid.deletes.push(document_key("one"));
        assert!(transact(&connection, "tenant", CONTEXT, &invalid, false).is_err());
        assert_eq!(intent_count(&connection), 0);
        admit(&connection, "tenant", CONTEXT).unwrap();
    }

    #[test]
    fn unversioned_tampering_is_detected_on_reads_and_guard_validation() {
        let connection = connection();
        let first = checkpoint_batch(
            &connection,
            "first",
            "lock",
            &[("one", "locked ciphertext")],
        );
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        connection.execute("UPDATE tenant.metadata_records SET value='forged' WHERE collection='documents' AND record_key='one'", []).unwrap();
        // The global admission check uses versions. Access to a bound value
        // additionally hashes its bytes, even if an attacker preserved its version.
        admit(&connection, "tenant", CONTEXT).unwrap();
        let rows = metadata::read(&connection, "tenant", &[document_key("one")]).unwrap();
        assert!(validate_records(&connection, CONTEXT, &rows).is_err());
        let read = MetadataBatch {
            operation: "read".into(),
            checks: vec![RecordCheck {
                record: document_key("one"),
                version: rows[0].version.clone(),
            }],
            collections: vec![],
            puts: vec![],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        };
        assert!(validate_checks(&connection, "tenant", CONTEXT, &read).is_err());
        assert!(transact(&connection, "tenant", CONTEXT, &read, false).is_err());
    }

    #[test]
    fn record_advances_publish_all_changes_once_and_never_allow_null_or_rewind() {
        let connection = connection();
        let first = batch(&connection, "first", "public certificate one");
        let receipt = transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        assert_eq!(
            receipt,
            transact(&connection, "tenant", CONTEXT, &first, false).unwrap()
        );
        assert_eq!(intent_count(&connection), 0);
        let mut deletion = batch(&connection, "delete", "unused");
        deletion.puts.remove(0);
        deletion.deletes.push(head());
        assert!(transact(&connection, "tenant", CONTEXT, &deletion, false).is_err());
        let mut rewind = batch(&connection, "rewind", "unused");
        rewind.puts[0].value = first.puts[0].value.clone();
        assert!(transact(&connection, "tenant", CONTEXT, &rewind, false).is_err());
        let mut nulled = batch(&connection, "null", "unused");
        nulled.puts[0].value = "null".into();
        assert!(transact(&connection, "tenant", CONTEXT, &nulled, false).is_err());
        assert_eq!(saved_payload(&connection), "public certificate one");
        let next = batch(&connection, "second", "public certificate two");
        transact(&connection, "tenant", CONTEXT, &next, false).unwrap();
        assert_eq!(saved_payload(&connection), "public certificate two");
        assert_eq!(intent_count(&connection), 0);
        assert!(transact(&connection, "tenant", CONTEXT, &rewind, false).is_err());
    }

    #[test]
    fn stale_guards_are_rejected_before_any_durable_intent_is_written() {
        let connection = connection();
        let first = batch(&connection, "first", "first");
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        let stale = batch(&connection, "stale", "stale");
        let winning = batch(&connection, "winning", "winning");
        transact(&connection, "tenant", CONTEXT, &winning, false).unwrap();
        assert!(transact(&connection, "tenant", CONTEXT, &stale, false).is_err());
        assert_eq!(intent_count(&connection), 0);
        admit(&connection, "tenant", CONTEXT).unwrap();
    }

    #[test]
    fn an_interruption_before_the_tenant_commit_replays_the_exact_guarded_write() {
        let connection = connection();
        let first = batch(&connection, "initial", "initial");
        check_advances(&connection, "tenant", CONTEXT, &first).unwrap();
        save_intent(&connection, CONTEXT, &first).unwrap();
        assert_eq!(intent_count(&connection), 1);
        assert!(
            metadata::read(&connection, "tenant", &[head()]).unwrap()[0]
                .value
                .is_none()
        );
        admit(&connection, "tenant", CONTEXT).unwrap();
        assert_eq!(saved_payload(&connection), "initial");
        assert_eq!(intent_count(&connection), 0);
        assert!(
            metadata::prior_receipt(&connection, "tenant", "initial", &first.fingerprint())
                .unwrap()
                .is_some()
        );
        admit(&connection, "tenant", CONTEXT).unwrap();
    }

    #[test]
    fn a_rolled_back_journal_conflict_does_not_leave_the_tenant_locked() {
        let connection = connection();
        let mut first = batch(&connection, "initial", "initial");
        let event = sortsys_zerotrust::journal::JournalAppend {
            stream: "security:history".into(),
            id: "event:1".into(),
            object: "authority".into(),
            occurred_micros: "1700000000000000".into(),
            order: None,
            value: "first event".into(),
        };
        first.journal.push(event.clone());
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        let mut rejected = batch(&connection, "conflicting", "must roll back");
        rejected
            .journal
            .push(sortsys_zerotrust::journal::JournalAppend {
                value: "conflicting event".into(),
                ..event
            });
        assert!(matches!(
            transact(&connection, "tenant", CONTEXT, &rejected, false),
            Err(StoreError::Conflict)
        ));
        assert_eq!(intent_count(&connection), 0);
        assert_eq!(saved_payload(&connection), "initial");
        admit(&connection, "tenant", CONTEXT).unwrap();
        let valid = batch(&connection, "later", "later");
        transact(&connection, "tenant", CONTEXT, &valid, false).unwrap();
    }

    #[test]
    fn an_interrupted_intent_never_guesses_when_its_original_source_has_changed() {
        let connection = connection();
        let first = batch(&connection, "initial", "initial");
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        let pending = batch(&connection, "recovery", "replacement");
        save_intent(&connection, CONTEXT, &pending).unwrap();
        connection.execute("UPDATE tenant.metadata_records SET version=version+1 WHERE collection='credentials'", []).unwrap();
        assert!(admit(&connection, "tenant", CONTEXT).is_err());
        assert_eq!(intent_count(&connection), 1);
        assert_eq!(saved_payload(&connection), "initial");
    }

    #[test]
    fn an_interruption_after_the_tenant_commit_finishes_without_a_second_write() {
        let connection = connection();
        let first = batch(&connection, "initial", "initial");
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        let next = batch(&connection, "recovery", "replacement");
        check_advances(&connection, "tenant", CONTEXT, &next).unwrap();
        save_intent(&connection, CONTEXT, &next).unwrap();
        let receipt = metadata::transact_prepared(&connection, "tenant", &next).unwrap();
        assert_eq!(intent_count(&connection), 1);
        admit(&connection, "tenant", CONTEXT).unwrap();
        assert_eq!(saved_payload(&connection), "replacement");
        assert_eq!(
            transact(&connection, "tenant", CONTEXT, &next, false).unwrap(),
            receipt
        );
        assert_eq!(intent_count(&connection), 0);
        let events: i64 = connection
            .query_row("SELECT count(*) FROM tenant.metadata_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(events, 2);
    }

    #[test]
    fn orphaned_and_cross_tenant_heads_are_never_silently_registered() {
        let connection = connection();
        let first = batch(&connection, "first", "public certificate");
        metadata::transact(&connection, "tenant", &first).unwrap();
        assert!(admit(&connection, "tenant", CONTEXT).is_err());
        assert!(admit(&connection, "tenant", "tenant:another").is_err());
        assert!(transact(&connection, "tenant", CONTEXT, &first, false).is_err());
        assert_eq!(witness(&connection, CONTEXT, "authority").unwrap(), None);
    }

    struct Files(std::path::PathBuf);
    impl Files {
        fn new() -> Self {
            let mut random = [0; 16];
            getrandom::fill(&mut random).unwrap();
            let name = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let result = Self(std::env::temp_dir().join(format!("sortsys-witness-{name}")));
            std::fs::create_dir(&result.0).unwrap();
            result
        }

        fn open(&self) -> Connection {
            let connection = Connection::open(self.0.join("control.duckdb")).unwrap();
            connection
                .execute_batch(&format!(
                    "ATTACH {} AS tenant",
                    crate::sql_string(self.0.join("tenant.duckdb").to_str().unwrap()),
                ))
                .unwrap();
            initialize(&connection).unwrap();
            metadata::initialize(&connection, "tenant").unwrap();
            connection
        }
    }
    impl Drop for Files {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn restoring_an_older_tenant_file_cannot_restore_its_replaced_recovery_head() {
        let files = Files::new();
        let tenant = files.0.join("tenant.duckdb");
        let backup = files.0.join("backup.duckdb");
        let connection = files.open();
        let first = batch(&connection, "first", "former certificate");
        transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
        connection
            .execute_batch(&format!(
                "ATTACH {} AS backup; COPY FROM DATABASE tenant TO backup; DETACH backup",
                crate::sql_string(backup.to_str().unwrap()),
            ))
            .unwrap();
        let recovery = batch(&connection, "recovery", "replacement certificate");
        transact(&connection, "tenant", CONTEXT, &recovery, false).unwrap();
        drop(connection);
        std::fs::copy(&backup, &tenant).unwrap();
        let restored = files.open();
        assert_eq!(saved_payload(&restored), "former certificate");
        assert!(admit(&restored, "tenant", CONTEXT).is_err());
        assert!(transact(&restored, "tenant", CONTEXT, &first, false).is_err());
        assert!(
            witness(&restored, CONTEXT, "authority")
                .unwrap()
                .unwrap()
                .contains("replacement certificate")
        );
    }

    #[test]
    fn durable_intents_resume_after_both_files_have_been_closed_and_reopened() {
        for committed in [false, true] {
            let files = Files::new();
            let connection = files.open();
            let first = batch(&connection, "first", "first");
            transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
            let next = batch(&connection, "recovery", "replacement");
            save_intent(&connection, CONTEXT, &next).unwrap();
            if committed {
                metadata::transact_prepared(&connection, "tenant", &next).unwrap();
            }
            drop(connection);
            let restarted = files.open();
            assert_eq!(intent_count(&restarted), 1);
            admit(&restarted, "tenant", CONTEXT).unwrap();
            assert_eq!(saved_payload(&restarted), "replacement");
            assert_eq!(intent_count(&restarted), 0);
            let receipt =
                metadata::prior_receipt(&restarted, "tenant", &next.operation, &next.fingerprint())
                    .unwrap()
                    .unwrap();
            assert_eq!(
                transact(&restarted, "tenant", CONTEXT, &next, false).unwrap(),
                receipt
            );
        }
    }

    #[test]
    fn restoring_a_file_cannot_erase_a_later_lock_with_the_same_authority_head() {
        let files = Files::new();
        let connection = files.open();
        let authority = batch(&connection, "authority", "unchanged authority");
        transact(&connection, "tenant", CONTEXT, &authority, false).unwrap();
        let backup = files.0.join("before-lock.duckdb");
        connection
            .execute_batch(&format!(
                "ATTACH {} AS backup; COPY FROM DATABASE tenant TO backup; DETACH backup",
                crate::sql_string(backup.to_str().unwrap()),
            ))
            .unwrap();
        let locked = checkpoint_batch(
            &connection,
            "lock",
            "document-lock",
            &[("one", "permanently locked")],
        );
        transact(&connection, "tenant", CONTEXT, &locked, false).unwrap();
        drop(connection);
        std::fs::copy(&backup, files.0.join("tenant.duckdb")).unwrap();
        let restored = files.open();
        assert_eq!(saved_payload(&restored), "unchanged authority");
        assert!(admit(&restored, "tenant", CONTEXT).is_err());
        let retained: String = restored
            .query_row(
                "SELECT value FROM control.record_bindings WHERE context=? AND record_key='one'",
                [CONTEXT],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, "permanently locked");
    }

    #[test]
    fn binding_publication_resumes_after_a_crash_on_either_side_of_tenant_commit() {
        for committed in [false, true] {
            let files = Files::new();
            let connection = files.open();
            let first = checkpoint_batch(&connection, "first", "lock", &[("one", "first")]);
            transact(&connection, "tenant", CONTEXT, &first, false).unwrap();
            let next = checkpoint_batch(
                &connection,
                "next",
                "lock",
                &[("one", "next"), ("two", "evidence")],
            );
            check_advances(&connection, "tenant", CONTEXT, &next).unwrap();
            save_intent(&connection, CONTEXT, &next).unwrap();
            if committed {
                metadata::transact_prepared(&connection, "tenant", &next).unwrap();
            }
            drop(connection);
            let restarted = files.open();
            admit(&restarted, "tenant", CONTEXT).unwrap();
            assert_eq!(intent_count(&restarted), 0);
            let records = metadata::read(
                &restarted,
                "tenant",
                &[document_key("one"), document_key("two")],
            )
            .unwrap();
            validate_records(&restarted, CONTEXT, &records).unwrap();
            assert_eq!(records[0].value.as_deref(), Some("next"));
            let retained: String = restarted.query_row(
                "SELECT value FROM control.record_bindings WHERE context=? AND record_key='two'",
                [CONTEXT], |row| row.get(0),
            ).unwrap();
            assert_eq!(retained, "evidence");
            let receipt =
                metadata::prior_receipt(&restarted, "tenant", &next.operation, &next.fingerprint())
                    .unwrap()
                    .unwrap();
            assert_eq!(
                transact(&restarted, "tenant", CONTEXT, &next, false).unwrap(),
                receipt
            );
        }
    }
}
