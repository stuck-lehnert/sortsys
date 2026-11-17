//! Bounded, hash-checked transport parts. These checks establish integrity, not
//! sender authorization: applications must verify the assembled signed payload.
use crate::{
    Result,
    crypto::{identifier, invalid},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "typescript")]
use ts_rs::TS;

pub const MAX_PART_BYTES: usize = 128 * 1024;
pub const MAX_PARTS: usize = 512;
pub const MAX_BYTES: usize = MAX_PART_BYTES * MAX_PARTS;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct PreparedPayloadManifest {
    pub format: String,
    pub context: String,
    pub operation: String,
    pub bytes: usize,
    pub hash: String,
    pub parts: Vec<String>,
}

fn hash(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn part_hash(content: &str) -> Result<String> {
    if content.is_empty() || content.len() > MAX_PART_BYTES {
        return Err(invalid());
    }
    Ok(hash(content.as_bytes()))
}

impl PreparedPayloadManifest {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.context)?;
        identifier(&self.operation)?;
        let reference = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if self.format != "sortsys-prepared-payload-v1"
            || self.bytes == 0
            || self.bytes > MAX_BYTES
            || self.parts.is_empty()
            || self.parts.len() > MAX_PARTS
            || !reference(&self.hash)
            || self.parts.iter().any(|part| !reference(part))
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub fn assemble(&self, parts: &[String]) -> Result<String> {
        self.validate()?;
        if parts.len() != self.parts.len() {
            return Err(invalid());
        }
        let mut total = 0usize;
        let mut fingerprint = Sha256::new();
        for (content, expected) in parts.iter().zip(&self.parts) {
            if part_hash(content)? != *expected {
                return Err(invalid());
            }
            total = total.checked_add(content.len()).ok_or_else(invalid)?;
            if total > self.bytes {
                return Err(invalid());
            }
            fingerprint.update(content.as_bytes());
        }
        let actual: String = fingerprint
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if total != self.bytes || actual != self.hash {
            return Err(invalid());
        }
        Ok(parts.concat())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        manifest: PreparedPayloadManifest,
        parts: Vec<String>,
        content: String,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../test/fixtures/prepared-payload.json")).unwrap()
    }

    #[test]
    fn typescript_unicode_parts_reassemble_with_the_same_fingerprint() {
        let vector = fixture();
        assert_eq!(
            vector.manifest.assemble(&vector.parts).unwrap(),
            vector.content
        );
        for (part, expected) in vector.parts.iter().zip(&vector.manifest.parts) {
            assert_eq!(part_hash(part).unwrap(), *expected);
        }
    }

    #[test]
    fn changed_order_partial_parts_and_false_totals_fail() {
        let vector = fixture();
        let mut reordered = vector.parts.clone();
        reordered.reverse();
        assert!(vector.manifest.assemble(&reordered).is_err());
        assert!(vector.manifest.assemble(&vector.parts[1..]).is_err());
        let mut manifest = vector.manifest.clone();
        manifest.bytes += 1;
        assert!(manifest.assemble(&vector.parts).is_err());
        manifest.bytes -= 1;
        manifest.hash = "0".repeat(64);
        assert!(manifest.assemble(&vector.parts).is_err());
    }

    #[test]
    fn limits_count_utf8_bytes_and_reject_excessive_manifest_bounds() {
        assert!(part_hash(&"ä".repeat(MAX_PART_BYTES)).is_err());
        assert!(part_hash("").is_err());
        let mut manifest = fixture().manifest;
        manifest.bytes = MAX_BYTES + 1;
        assert!(manifest.validate().is_err());
        manifest.bytes = 1;
        manifest.parts = vec!["0".repeat(64); MAX_PARTS + 1];
        assert!(manifest.validate().is_err());
    }
}
