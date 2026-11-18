//! Signed content restoration namespaces. Authorization, account recovery and
//! immutable record retention remain with the embedding application's adapter.
use crate::{
    Result,
    crypto::{encode, frame, identifier, invalid, revision, signed_packet_frame, sized, verify},
    metadata::RecordKey,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "typescript")]
use ts_rs::TS;

const DATA_PREFIX: &str = "zt-data:";

pub fn head_key() -> RecordKey {
    RecordKey {
        collection: "zt-content-epochs".into(),
        key: "current".into(),
    }
}

fn number(input: &str) -> Result<i64> {
    if input == "0" {
        return Ok(0);
    }
    revision(input)
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentEpoch {
    pub format: String,
    pub tenant: String,
    pub authority_generation: String,
    pub number: String,
    pub previous: Option<String>,
    pub source_number: String,
    pub source_head: Option<String>,
    pub snapshot: String,
    pub actor: String,
    pub signature: String,
}
impl ContentEpoch {
    pub fn frame(&self) -> Result<Vec<u8>> {
        if self.format != "zt-content-epoch-v1" {
            return Err(invalid());
        }
        identifier(&self.tenant)?;
        identifier(&self.actor)?;
        revision(&self.authority_generation)?;
        let target = revision(&self.number)?;
        let source = number(&self.source_number)?;
        sized::<32>(&self.snapshot)?;
        if (target == 1) != self.previous.is_none()
            || (source == 0) != self.source_head.is_none()
            || source >= target
        {
            return Err(invalid());
        }
        if let Some(previous) = &self.previous {
            sized::<32>(previous)?;
        }
        if let Some(source) = &self.source_head {
            sized::<32>(source)?;
        }
        Ok(frame(
            "zt/content-epoch/v1",
            &[
                &self.tenant,
                &self.authority_generation,
                &self.number,
                self.previous.as_deref().unwrap_or(""),
                &self.source_number,
                self.source_head.as_deref().unwrap_or(""),
                &self.snapshot,
                &self.actor,
            ],
        ))
    }

    pub fn verify(
        &self,
        tenant: &str,
        authority_generation: Option<&str>,
        actor: Option<&str>,
        authority: &[u8],
    ) -> Result<()> {
        if self.tenant != tenant
            || authority_generation.is_some_and(|value| value != self.authority_generation)
            || actor.is_some_and(|value| value != self.actor)
        {
            return Err(invalid());
        }
        verify(authority, &self.signature, &self.frame()?)
    }

    pub fn fingerprint(&self) -> Result<String> {
        sized::<64>(&self.signature)?;
        Ok(encode(&Sha256::digest(signed_packet_frame(
            &self.frame()?,
            &self.signature,
        )?)))
    }

    /// Certificates must first be verified against the application's pinned
    /// authority history; these comparisons alone never grant restoration.
    pub fn follows(&self, previous: Option<&Self>, source: Option<&Self>) -> Result<()> {
        self.frame()?;
        let previous_number = previous
            .map(|value| revision(&value.number))
            .transpose()?
            .unwrap_or(0);
        let predecessor = previous.map(Self::fingerprint).transpose()?;
        let source_number = source
            .map(|value| revision(&value.number))
            .transpose()?
            .unwrap_or(0);
        let source_head = source.map(Self::fingerprint).transpose()?;
        if previous_number.checked_add(1) != Some(revision(&self.number)?)
            || predecessor != self.previous
            || source_number != number(&self.source_number)?
            || source_head != self.source_head
        {
            return Err(invalid());
        }
        if let Some(previous) = previous {
            if previous.tenant != self.tenant
                || revision(&previous.authority_generation)? > revision(&self.authority_generation)?
            {
                return Err(invalid());
            }
        }
        if let Some(source) = source {
            if source.tenant != self.tenant
                || revision(&source.authority_generation)? > revision(&self.authority_generation)?
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

pub fn namespace_record(record: &RecordKey, epoch: &str) -> Result<RecordKey> {
    record.validate()?;
    number(epoch)?;
    if record.collection.starts_with(DATA_PREFIX) {
        return Err(invalid());
    }
    if epoch == "0" {
        return Ok(record.clone());
    }
    let physical = RecordKey {
        collection: format!("{DATA_PREFIX}{epoch}:{}", record.collection),
        key: record.key.clone(),
    };
    physical.validate()?;
    Ok(physical)
}

pub fn logical_record(record: &RecordKey, epoch: &str) -> Result<RecordKey> {
    record.validate()?;
    number(epoch)?;
    let collection = if epoch == "0" {
        record.collection.clone()
    } else {
        record
            .collection
            .strip_prefix(&format!("{DATA_PREFIX}{epoch}:"))
            .ok_or_else(invalid)?
            .to_owned()
    };
    if collection.starts_with(DATA_PREFIX) {
        return Err(invalid());
    }
    let logical = RecordKey {
        collection,
        key: record.key.clone(),
    };
    logical.validate()?;
    Ok(logical)
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ContentPin {
    pub format: String,
    pub record: RecordKey,
    pub number: String,
    pub physical: RecordKey,
}
impl ContentPin {
    pub fn validate(&self) -> Result<()> {
        if self.format != "zt-content-pin-v1"
            || namespace_record(&self.record, &self.number)? != self.physical
        {
            return Err(invalid());
        }
        Ok(())
    }
}

pub fn content_pin_key(record: &RecordKey) -> Result<RecordKey> {
    record.validate()?;
    let digest = encode(&Sha256::digest(frame(
        "zt/content-pins/v1",
        &[&record.collection],
    )));
    let pin = RecordKey {
        collection: format!("zt-content-pins-{digest}"),
        key: record.key.clone(),
    };
    pin.validate()?;
    Ok(pin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../test/fixtures/content-epochs.json")).unwrap()
    }

    #[test]
    fn browser_signed_restore_chain_binds_current_and_source_snapshots() {
        let fixture = fixture();
        let epochs: Vec<ContentEpoch> = serde_json::from_value(fixture["epochs"].clone()).unwrap();
        for (index, epoch) in epochs.iter().enumerate() {
            let authority = sized::<32>(
                fixture["authorities"][&epoch.authority_generation]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            epoch
                .verify(
                    "laboratory",
                    Some(&epoch.authority_generation),
                    Some("researcher:admin"),
                    &authority,
                )
                .unwrap();
            assert_eq!(encode(&epoch.frame().unwrap()), fixture["frames"][index]);
            assert_eq!(epoch.fingerprint().unwrap(), fixture["fingerprints"][index]);
            let mut tampered = epoch.clone();
            tampered.snapshot = encode(&[9; 32]);
            assert!(
                tampered
                    .verify("laboratory", None, None, &authority)
                    .is_err()
            );
            assert!(epoch.verify("other", None, None, &authority).is_err());
            assert!(
                epoch
                    .verify("laboratory", None, Some("provider"), &authority)
                    .is_err()
            );
        }
        epochs[0].follows(None, None).unwrap();
        epochs[1]
            .follows(Some(&epochs[0]), Some(&epochs[0]))
            .unwrap();
        epochs[2]
            .follows(Some(&epochs[1]), Some(&epochs[0]))
            .unwrap();
        assert!(
            epochs[2]
                .follows(Some(&epochs[0]), Some(&epochs[0]))
                .is_err()
        );
        assert!(epochs[2].follows(Some(&epochs[1]), None).is_err());
        let mut source_fork = epochs[0].clone();
        source_fork.snapshot = encode(&[7; 32]);
        assert!(
            epochs[2]
                .follows(Some(&epochs[1]), Some(&source_fork))
                .is_err()
        );
        let mut old_authority = epochs[2].clone();
        old_authority.authority_generation = "1".into();
        assert!(
            old_authority
                .follows(Some(&epochs[1]), Some(&epochs[0]))
                .is_err()
        );
    }

    #[test]
    fn record_namespaces_and_immutable_pins_match_browser_values() {
        let fixture = fixture();
        let logical: RecordKey = serde_json::from_value(fixture["logical"].clone()).unwrap();
        let physical: RecordKey = serde_json::from_value(fixture["physical"].clone()).unwrap();
        assert_eq!(namespace_record(&logical, "2").unwrap(), physical);
        assert_eq!(logical_record(&physical, "2").unwrap(), logical);
        assert!(logical_record(&physical, "1").is_err());
        assert!(namespace_record(&physical, "3").is_err());
        assert!(number("01").is_err());
        assert!(number("-1").is_err());
        assert!(number("9223372036854775808").is_err());
        let pin: ContentPin = serde_json::from_value(fixture["pin"].clone()).unwrap();
        pin.validate().unwrap();
        let expected: RecordKey = serde_json::from_value(fixture["pinKey"].clone()).unwrap();
        assert_eq!(content_pin_key(&logical).unwrap(), expected);
        let mut substituted = pin.clone();
        substituted.number = "1".into();
        assert!(substituted.validate().is_err());
        substituted = pin;
        substituted.physical.key = "other".into();
        assert!(substituted.validate().is_err());
    }
}
