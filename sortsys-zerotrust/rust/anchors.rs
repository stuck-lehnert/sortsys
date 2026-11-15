//! Monotonic public record heads. A storage adapter keeps the witness outside
//! the restored object store and publishes an advance with its transaction.
//! These heads do not grant access or replace a payload's own signature checks.
use crate::{
    Result,
    crypto::{encode, frame, invalid, revision, sized},
    metadata::RecordKey,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "typescript")]
use ts_rs::TS;

pub const ANCHOR_COLLECTION: &str = "zt-anchors";
pub const MAX_ANCHOR_PAYLOAD_BYTES: usize = 512 * 1024;
pub const MAX_CHECKPOINT_RECORDS: usize = 64;
const CHECKPOINT_FORMAT: &str = "zt-record-checkpoint-v1";

/// A monotonic witness can bind opaque control values as well as its own head.
/// Storage keeps the corresponding values outside the restored tenant file.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecordBinding {
    pub record: RecordKey,
    pub fingerprint: String,
}

impl RecordBinding {
    pub fn bind(record: RecordKey, value: &str) -> Result<Self> {
        record.validate()?;
        if record.collection == ANCHOR_COLLECTION {
            return Err(invalid());
        }
        let fingerprint = encode(&Sha256::digest(frame(
            "zt/record-binding/v1",
            &[&record.collection, &record.key, value],
        )));
        Ok(Self {
            record,
            fingerprint,
        })
    }

    pub fn validate(&self) -> Result<()> {
        self.record.validate()?;
        if self.record.collection == ANCHOR_COLLECTION {
            return Err(invalid());
        }
        sized::<32>(&self.fingerprint)?;
        Ok(())
    }

    pub fn verify(&self, value: &str) -> Result<()> {
        self.validate()?;
        if Self::bind(self.record.clone(), value)? != *self {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecordCheckpoint {
    pub format: String,
    pub records: Vec<RecordBinding>,
}

impl RecordCheckpoint {
    pub fn new(mut records: Vec<RecordBinding>) -> Result<Self> {
        records.sort_by(|left, right| {
            left.record
                .collection
                .cmp(&right.record.collection)
                .then_with(|| left.record.key.cmp(&right.record.key))
        });
        let checkpoint = Self {
            format: CHECKPOINT_FORMAT.into(),
            records,
        };
        checkpoint.validate()?;
        Ok(checkpoint)
    }

    pub fn validate(&self) -> Result<()> {
        if self.format != CHECKPOINT_FORMAT
            || self.records.is_empty()
            || self.records.len() > MAX_CHECKPOINT_RECORDS
        {
            return Err(invalid());
        }
        let mut previous = None;
        for binding in &self.records {
            binding.validate()?;
            let key = (&binding.record.collection, &binding.record.key);
            if previous.is_some_and(|previous| previous >= key) {
                return Err(invalid());
            }
            previous = Some(key);
        }
        Ok(())
    }

    /// Existing bindings cannot disappear when a protected record advances.
    /// The caller still validates which application changes are authorized.
    pub fn follows(&self, previous: Option<&Self>) -> Result<()> {
        self.validate()?;
        if let Some(previous) = previous {
            previous.validate()?;
            for binding in &previous.records {
                if !self
                    .records
                    .iter()
                    .any(|next| next.record == binding.record)
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }

    /// Other opaque anchor payloads remain valid. Once a binding checkpoint
    /// exists, storage must also reject a later switch back to an opaque value.
    pub fn from_payload(payload: &str) -> Result<Option<Self>> {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            return Ok(None);
        };
        if value.get("format").and_then(serde_json::Value::as_str) != Some(CHECKPOINT_FORMAT) {
            return Ok(None);
        }
        let checkpoint: Self = serde_json::from_value(value).map_err(|_| invalid())?;
        checkpoint.validate()?;
        Ok(Some(checkpoint))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RecordAnchor {
    pub format: String,
    pub revision: String,
    pub predecessor: Option<String>,
    pub payload: String,
}

impl RecordAnchor {
    pub fn initial(payload: String) -> Result<Self> {
        let result = Self {
            format: "zt-record-anchor-v1".into(),
            revision: "1".into(),
            predecessor: None,
            payload,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn next(&self, payload: String) -> Result<Self> {
        let next = revision(&self.revision)?
            .checked_add(1)
            .ok_or_else(invalid)?;
        let result = Self {
            format: "zt-record-anchor-v1".into(),
            revision: next.to_string(),
            predecessor: Some(self.fingerprint()?),
            payload,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<()> {
        let sequence = revision(&self.revision)?;
        if self.format != "zt-record-anchor-v1"
            || self.payload.is_empty()
            || self.payload.len() > MAX_ANCHOR_PAYLOAD_BYTES
            || (sequence == 1) != self.predecessor.is_none()
        {
            return Err(invalid());
        }
        if let Some(predecessor) = &self.predecessor {
            sized::<32>(predecessor)?;
        }
        Ok(())
    }

    pub fn fingerprint(&self) -> Result<String> {
        self.validate()?;
        Ok(encode(&Sha256::digest(frame(
            "zt/record-anchor/v1",
            &[
                &self.revision,
                self.predecessor.as_deref().unwrap_or(""),
                &self.payload,
            ],
        ))))
    }

    pub fn follows(&self, previous: Option<&Self>) -> Result<()> {
        self.validate()?;
        let Some(previous) = previous else {
            return if self.revision == "1" {
                Ok(())
            } else {
                Err(invalid())
            };
        };
        previous.validate()?;
        if revision(&previous.revision)?.checked_add(1) != Some(revision(&self.revision)?)
            || self.predecessor.as_deref() != Some(previous.fingerprint()?.as_str())
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_and_rust_bind_the_same_record_identity_and_utf8_bytes() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../test/fixtures/record-bindings.json")).unwrap();
        let record: RecordKey = serde_json::from_value(fixture["record"].clone()).unwrap();
        let value = fixture["value"].as_str().unwrap();
        let binding = RecordBinding::bind(record.clone(), value).unwrap();
        assert_eq!(binding.fingerprint, fixture["fingerprint"]);
        binding.verify(value).unwrap();
        assert!(binding.verify(&format!("{value} ")).is_err());
        assert!(binding.verify("null").is_err());
        let mut substituted = binding.clone();
        substituted.record.key = "offer:4712".into();
        assert!(substituted.verify(value).is_err());
        substituted.record = RecordKey {
            collection: "other-records".into(),
            ..record.clone()
        };
        assert!(substituted.verify(value).is_err());
        assert!(
            RecordBinding::bind(
                RecordKey {
                    collection: ANCHOR_COLLECTION.into(),
                    ..record
                },
                value
            )
            .is_err()
        );
    }

    #[test]
    fn checkpoints_cannot_drop_bindings_or_use_ambiguous_record_order() {
        let record = RecordKey {
            collection: "records".into(),
            key: "first".into(),
        };
        let first = RecordBinding::bind(record.clone(), "old").unwrap();
        let updated = RecordBinding::bind(record.clone(), "new").unwrap();
        let extra = RecordBinding::bind(
            RecordKey {
                key: "second".into(),
                ..record
            },
            "extra",
        )
        .unwrap();
        let previous = RecordCheckpoint::new(vec![first.clone()]).unwrap();
        let next = RecordCheckpoint::new(vec![extra.clone(), updated]).unwrap();
        previous.follows(None).unwrap();
        next.follows(Some(&previous)).unwrap();
        assert!(previous.follows(Some(&next)).is_err());
        assert!(RecordCheckpoint::new(vec![first.clone(), first.clone()]).is_err());
        assert!(RecordCheckpoint::new(vec![]).is_err());
        assert!(RecordCheckpoint::new(vec![first; MAX_CHECKPOINT_RECORDS + 1]).is_err());
        let mut unsorted = next.clone();
        unsorted.records.reverse();
        assert!(unsorted.validate().is_err());
        let encoded = serde_json::to_string(&next).unwrap();
        assert_eq!(
            RecordCheckpoint::from_payload(&encoded).unwrap(),
            Some(next)
        );
        assert!(
            RecordCheckpoint::from_payload("opaque data")
                .unwrap()
                .is_none()
        );
        assert!(
            RecordCheckpoint::from_payload(
                r#"{"format":"zt-record-checkpoint-v1","records":[],"extra":true}"#
            )
            .is_err()
        );
    }

    #[test]
    fn browser_and_rust_bind_the_same_public_record_history() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../test/fixtures/record-anchors.json")).unwrap();
        let first: RecordAnchor = serde_json::from_value(fixture["first"].clone()).unwrap();
        let second: RecordAnchor = serde_json::from_value(fixture["second"].clone()).unwrap();
        first.follows(None).unwrap();
        second.follows(Some(&first)).unwrap();
        assert_eq!(first.fingerprint().unwrap(), fixture["firstFingerprint"]);
        assert_eq!(second.fingerprint().unwrap(), fixture["secondFingerprint"]);
        assert!(first.follows(Some(&second)).is_err());
        assert!(second.follows(None).is_err());
        let mut substituted = first.clone();
        substituted.payload.push('!');
        assert!(second.follows(Some(&substituted)).is_err());
        let mut skipped = second.clone();
        skipped.revision = "3".into();
        assert!(skipped.follows(Some(&first)).is_err());
        let mut exhausted = second;
        exhausted.revision = i64::MAX.to_string();
        assert!(exhausted.next("next".into()).is_err());
    }
}
