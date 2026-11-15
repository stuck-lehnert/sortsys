//! Transport-neutral optimistic transactions for public control metadata and
//! ciphertext references. No SQL dialect or database driver belongs here.
use crate::{
    Result,
    crypto::{identifier, invalid, revision},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
#[cfg(feature = "typescript")]
use ts_rs::TS;

pub const MAX_OPERATIONS: usize = 1024;
// A read may compare historical policies for every area while changing only
// one record. Keep that read footprint separate from the write batch limit.
pub const MAX_CHECKS: usize = 8192;
pub const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
pub const MAX_PREPARED_OPERATIONS: usize = 400_000;
pub const MAX_PREPARED_CHECKS: usize = 512_000;
pub const MAX_PREPARED_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_PREPARED_PARTS: usize = 64;
pub const MAX_PREPARED_PART_BYTES: usize = 8 * 1024 * 1024;

/// Immutable transport parts are invisible until the store checks the whole
/// read set and publishes one transaction. Context identifies its destination.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct PreparedMetadataManifest {
    pub context: String,
    pub operation: String,
    pub fingerprint: String,
    pub parts: Vec<String>,
}
impl PreparedMetadataManifest {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.context)?;
        identifier(&self.operation)?;
        let valid_reference = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if !valid_reference(&self.fingerprint)
            || self.parts.is_empty()
            || self.parts.len() > MAX_PREPARED_PARTS
            || self.parts.iter().any(|part| !valid_reference(part))
        {
            return Err(invalid());
        }
        // Identical UTF-8 fragments may legitimately occur more than once.
        // Their order and multiplicity are covered by the complete fingerprint.
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RecordKey {
    pub collection: String,
    pub key: String,
}
impl RecordKey {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.collection)?;
        if self.key.is_empty() || self.key.len() > 512 {
            return Err(invalid());
        }
        let mut characters = self.key.bytes();
        if !characters
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || characters.any(|byte| !byte.is_ascii_alphanumeric() && !b"_:.@/-".contains(&byte))
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RecordCheck {
    pub record: RecordKey,
    /// None means the record must not exist.
    pub version: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct CollectionCheck {
    pub collection: String,
    /// Zero is the version of an empty, never-written collection.
    pub version: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RecordPut {
    pub record: RecordKey,
    pub value: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct MetadataHint {
    pub channel: String,
    pub value: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataBatch {
    pub operation: String,
    pub checks: Vec<RecordCheck>,
    pub collections: Vec<CollectionCheck>,
    pub puts: Vec<RecordPut>,
    pub deletes: Vec<RecordKey>,
    pub hints: Vec<MetadataHint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub journal: Vec<crate::journal::JournalAppend>,
}
impl MetadataBatch {
    /// Independent of JSON field order, escaping and an omitted empty journal.
    /// Array order remains part of the exact operation being acknowledged.
    pub fn fingerprint(&self) -> String {
        fn number(hash: &mut Sha256, value: usize) {
            hash.update((value as u64).to_be_bytes());
        }
        fn text(hash: &mut Sha256, value: &str) {
            number(hash, value.len());
            hash.update(value.as_bytes());
        }
        fn record(hash: &mut Sha256, value: &RecordKey) {
            text(hash, &value.collection);
            text(hash, &value.key);
        }
        let mut hash = Sha256::new();
        text(&mut hash, "sortsys/metadata-batch/v1");
        text(&mut hash, &self.operation);
        number(&mut hash, self.checks.len());
        for check in &self.checks {
            record(&mut hash, &check.record);
            text(&mut hash, check.version.as_deref().unwrap_or(""));
        }
        number(&mut hash, self.collections.len());
        for check in &self.collections {
            text(&mut hash, &check.collection);
            text(&mut hash, &check.version);
        }
        number(&mut hash, self.puts.len());
        for put in &self.puts {
            record(&mut hash, &put.record);
            text(&mut hash, &put.value);
        }
        number(&mut hash, self.deletes.len());
        for deletion in &self.deletes {
            record(&mut hash, deletion);
        }
        number(&mut hash, self.hints.len());
        for hint in &self.hints {
            text(&mut hash, &hint.channel);
            text(&mut hash, &hint.value);
        }
        number(&mut hash, self.journal.len());
        for entry in &self.journal {
            text(&mut hash, &entry.stream);
            text(&mut hash, &entry.id);
            text(&mut hash, &entry.object);
            text(&mut hash, &entry.occurred_micros);
            text(&mut hash, entry.order.as_deref().unwrap_or(""));
            text(&mut hash, &entry.value);
        }
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_limits(MAX_CHECKS, MAX_OPERATIONS, MAX_BATCH_BYTES)
    }

    pub fn validate_prepared(&self) -> Result<()> {
        self.validate_limits(
            MAX_PREPARED_CHECKS,
            MAX_PREPARED_OPERATIONS,
            MAX_PREPARED_BYTES,
        )
    }

    fn validate_limits(
        &self,
        maximum_checks: usize,
        maximum_operations: usize,
        maximum_bytes: usize,
    ) -> Result<()> {
        identifier(&self.operation)?;
        if self.checks.len() > maximum_checks
            || self.collections.len() > MAX_OPERATIONS
            || self.puts.len() + self.deletes.len() + self.journal.len() > maximum_operations
            || self.hints.len() > 64
        {
            return Err(invalid());
        }
        let mut checked = HashSet::new();
        for check in &self.checks {
            check.record.validate()?;
            if let Some(version) = &check.version {
                revision(version)?;
            }
            if !checked.insert(&check.record) {
                return Err(invalid());
            }
        }
        let mut collections = HashSet::new();
        for check in &self.collections {
            identifier(&check.collection)?;
            if check.version != "0" {
                revision(&check.version)?;
            }
            if !collections.insert(&check.collection) {
                return Err(invalid());
            }
        }
        let mut changed = HashSet::new();
        let mut bytes = 0usize;
        for put in &self.puts {
            put.record.validate()?;
            bytes = bytes.checked_add(put.value.len()).ok_or_else(invalid)?;
            if put.value.len() > MAX_RECORD_BYTES
                || !checked.contains(&put.record)
                || !changed.insert(&put.record)
            {
                return Err(invalid());
            }
        }
        for deletion in &self.deletes {
            deletion.validate()?;
            if !checked.contains(deletion) || !changed.insert(deletion) {
                return Err(invalid());
            }
        }
        for hint in &self.hints {
            identifier(&hint.channel)?;
            bytes = bytes.checked_add(hint.value.len()).ok_or_else(invalid)?;
            if hint.value.len() > 4096 {
                return Err(invalid());
            }
        }
        let mut entries = HashSet::new();
        for entry in &self.journal {
            entry.validate()?;
            bytes = bytes.checked_add(entry.value.len()).ok_or_else(invalid)?;
            if !entries.insert((&entry.stream, &entry.id)) {
                return Err(invalid());
            }
        }
        if bytes > maximum_bytes {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct MetadataReceipt {
    pub operation: String,
    pub revision: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct MetadataRecord {
    pub record: RecordKey,
    pub version: Option<String>,
    pub value: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_fingerprint_matches_the_browser_without_json_spelling_dependencies() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../test/fixtures/metadata-fingerprint.json"))
                .unwrap();
        let batch: MetadataBatch = serde_json::from_value(vector["batch"].clone()).unwrap();
        batch.validate().unwrap();
        assert_eq!(batch.fingerprint(), vector["fingerprint"].as_str().unwrap());
    }
    #[test]
    fn larger_read_snapshots_keep_the_existing_write_limit() {
        let checks = (0..MAX_CHECKS)
            .map(|number| RecordCheck {
                record: RecordKey {
                    collection: "policies".into(),
                    key: format!("version:{number}"),
                },
                version: None,
            })
            .collect();
        let mut request = MetadataBatch {
            operation: "read:policies".into(),
            checks,
            collections: vec![],
            puts: vec![],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        };
        request.validate().unwrap();
        request.checks.push(RecordCheck {
            record: RecordKey {
                collection: "policies".into(),
                key: "overflow".into(),
            },
            version: None,
        });
        assert!(request.validate().is_err());
        assert!(request.validate_prepared().is_ok());
        request.checks.pop();
        request.puts = request
            .checks
            .iter()
            .take(MAX_OPERATIONS + 1)
            .map(|check| RecordPut {
                record: check.record.clone(),
                value: "ciphertext-reference".into(),
            })
            .collect();
        assert!(request.validate().is_err());
        assert!(request.validate_prepared().is_ok());
        request.puts[0].record.key = "not-observed".into();
        assert!(request.validate_prepared().is_err());
    }
}
