//! Invisible bounded transport parts for one large metadata transaction.
use crate::{StoreError, content_id, metadata::Target};
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};
use sortsys_zerotrust::metadata::{
    MAX_PREPARED_BYTES, MAX_PREPARED_PART_BYTES, MetadataBatch, MetadataReceipt,
    PreparedMetadataManifest,
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartRequest {
    pub target: Target,
    pub content: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartReceipt {
    pub id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitRequest {
    pub target: Target,
    pub manifest: PreparedMetadataManifest,
}

fn unavailable(_: duckdb::Error) -> StoreError {
    StoreError::Unavailable("prepared-metadata")
}

pub(super) fn prepare(
    connection: &Connection,
    catalog: &str,
    content: &str,
) -> Result<PartReceipt, StoreError> {
    if content.is_empty() || content.len() > MAX_PREPARED_PART_BYTES {
        return Err(StoreError::Integrity);
    }
    let id = content_id(content);
    // Unpublished transport fragments do not belong to the business history.
    // Exact retries refresh their lifetime; committed receipts remain valid.
    connection.execute(
        &format!("DELETE FROM {catalog}.metadata_prepared_parts WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '1 day'"),
        [],
    ).map_err(unavailable)?;
    connection.execute(
        &format!("INSERT INTO {catalog}.metadata_prepared_parts(id,content) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET created_at=now()"),
        params![id, content],
    ).map_err(unavailable)?;
    Ok(PartReceipt { id })
}

pub(super) fn commit(
    connection: &Connection,
    catalog: &str,
    context: &str,
    manifest: &PreparedMetadataManifest,
) -> Result<MetadataReceipt, StoreError> {
    manifest.validate().map_err(|_| StoreError::Integrity)?;
    if manifest.context != context {
        return Err(StoreError::Integrity);
    }
    if let Some(receipt) = crate::metadata::prior_receipt(
        connection,
        catalog,
        &manifest.operation,
        &manifest.fingerprint,
    )? {
        return Ok(receipt);
    }
    let batch = read_batch(connection, catalog, context, manifest)?;
    crate::witness::transact(connection, catalog, context, &batch, true)
}

pub(super) fn validate_snapshot(
    connection: &Connection,
    catalog: &str,
    context: &str,
    manifest: &PreparedMetadataManifest,
) -> Result<(), StoreError> {
    let batch = read_batch(connection, catalog, context, manifest)?;
    crate::witness::validate_checks(connection, catalog, context, &batch)?;
    crate::metadata::validate_prepared_snapshot(connection, catalog, &batch)
}

fn read_batch(
    connection: &Connection,
    catalog: &str,
    context: &str,
    manifest: &PreparedMetadataManifest,
) -> Result<MetadataBatch, StoreError> {
    manifest.validate().map_err(|_| StoreError::Integrity)?;
    if manifest.context != context {
        return Err(StoreError::Integrity);
    }
    let mut encoded = String::new();
    let mut query = connection
        .prepare(&format!(
            "SELECT content FROM {catalog}.metadata_prepared_parts WHERE id=?"
        ))
        .map_err(unavailable)?;
    for id in &manifest.parts {
        let content: String = query
            .query_row([id], |row| row.get(0))
            .optional()
            .map_err(unavailable)?
            .ok_or(StoreError::NotFound)?;
        if content.len() > MAX_PREPARED_PART_BYTES
            || content_id(&content) != *id
            || encoded
                .len()
                .checked_add(content.len())
                .is_none_or(|length| length > MAX_PREPARED_BYTES)
        {
            return Err(StoreError::Integrity);
        }
        encoded.push_str(&content);
    }
    let batch: MetadataBatch = serde_json::from_str(&encoded).map_err(|_| StoreError::Integrity)?;
    if batch.operation != manifest.operation || batch.fingerprint() != manifest.fingerprint {
        return Err(StoreError::Integrity);
    }
    // Fragments have not touched revisions, events, records or journal rows.
    // The normal compare-and-swap implementation publishes all of them once.
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sortsys_zerotrust::metadata::{RecordCheck, RecordKey, RecordPut};

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("ATTACH ':memory:' AS control")
            .unwrap();
        crate::witness::initialize(&connection).unwrap();
        crate::metadata::initialize(&connection, "main").unwrap();
        connection
    }

    fn batch(operation: &str, prefix: &str) -> MetadataBatch {
        let puts = (0..1100)
            .map(|index| RecordPut {
                record: RecordKey {
                    collection: "proposals".into(),
                    key: format!("{prefix}:{index}"),
                },
                value: "Vertrauliche Referenz – keine Geschäftsinhalte".repeat(4),
            })
            .collect::<Vec<_>>();
        MetadataBatch {
            operation: operation.into(),
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
        }
    }

    fn stage(connection: &Connection, batch: &MetadataBatch) -> PreparedMetadataManifest {
        let encoded = serde_json::to_string(batch).unwrap();
        let mut middle = encoded.len() / 2;
        while !encoded.is_char_boundary(middle) {
            middle -= 1;
        }
        let parts = [&encoded[..middle], &encoded[middle..]]
            .into_iter()
            .map(|content| prepare(connection, "main", content).unwrap().id)
            .collect();
        PreparedMetadataManifest {
            context: "tenant:test".into(),
            operation: batch.operation.clone(),
            fingerprint: batch.fingerprint(),
            parts,
        }
    }

    fn count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn prepared_changes_are_invisible_bound_and_idempotent_after_fragment_cleanup() {
        let connection = connection();
        let batch = batch("bulk:1", "first");
        assert!(batch.validate().is_err());
        let manifest = stage(&connection, &batch);
        assert_eq!(count(&connection, "metadata_records"), 0);
        assert_eq!(count(&connection, "metadata_events"), 0);
        assert_eq!(count(&connection, "metadata_operations"), 0);
        assert!(commit(&connection, "main", "tenant:other", &manifest).is_err());
        let mut reordered = manifest.clone();
        reordered.parts.reverse();
        assert!(commit(&connection, "main", "tenant:test", &reordered).is_err());
        let mut missing = manifest.clone();
        missing.parts[0] = "0".repeat(64);
        assert!(commit(&connection, "main", "tenant:test", &missing).is_err());
        assert_eq!(count(&connection, "metadata_records"), 0);
        let receipt = commit(&connection, "main", "tenant:test", &manifest).unwrap();
        assert_eq!(count(&connection, "metadata_records"), 1100);
        assert_eq!(count(&connection, "metadata_events"), 1);
        connection
            .execute("DELETE FROM metadata_prepared_parts", [])
            .unwrap();
        assert_eq!(
            commit(&connection, "main", "tenant:test", &manifest).unwrap(),
            receipt
        );
        assert_eq!(count(&connection, "metadata_events"), 1);
        let mut relabelled = manifest;
        relabelled.fingerprint = "0".repeat(64);
        assert!(matches!(
            commit(&connection, "main", "tenant:test", &relabelled),
            Err(StoreError::Conflict)
        ));
    }

    #[test]
    fn one_stale_check_rolls_back_every_prepared_change() {
        let connection = connection();
        let initial = batch("bulk:1", "first");
        let original = stage(&connection, &initial);
        commit(&connection, "main", "tenant:test", &original).unwrap();
        let mut proposed = batch("bulk:2", "later");
        proposed.checks.push(RecordCheck {
            record: initial.puts[0].record.clone(),
            version: None,
        });
        let staged = stage(&connection, &proposed);
        assert!(matches!(
            commit(&connection, "main", "tenant:test", &staged),
            Err(StoreError::Conflict)
        ));
        assert_eq!(count(&connection, "metadata_records"), 1100);
        assert_eq!(count(&connection, "metadata_events"), 1);
        assert_eq!(count(&connection, "metadata_operations"), 1);
    }
}
