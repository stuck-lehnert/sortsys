//! Public receipts for client-verified migration of opaque file contents.
use crate::{
    Result,
    crypto::{encode, frame, identifier, invalid, revision, sized},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(deny_unknown_fields)]
pub struct MigrationFileBlock {
    pub id: String,
    pub hash: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationFileReceipt {
    pub tenant: String,
    pub migration: String,
    pub generation: String,
    pub source: String,
    pub bytes: String,
    pub object: String,
    pub revision: String,
    pub ciphertext_hash: String,
    pub blocks: Vec<MigrationFileBlock>,
    pub author: String,
    pub proof: String,
}

impl MigrationFileReceipt {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [
            &self.tenant,
            &self.migration,
            &self.source,
            &self.object,
            &self.author,
        ] {
            identifier(value)?;
        }
        revision(&self.generation)?;
        revision(&self.revision)?;
        let bytes: i64 = self.bytes.parse().map_err(|_| invalid())?;
        if bytes < 0 || bytes.to_string() != self.bytes || self.blocks.len() > 4096 {
            return Err(invalid());
        }
        sized::<32>(&self.ciphertext_hash)?;
        let mut ids = HashSet::new();
        let mut blocks = Vec::with_capacity(self.blocks.len());
        for block in &self.blocks {
            identifier(&block.id)?;
            sized::<32>(&block.hash)?;
            if !ids.insert(&block.id) {
                return Err(invalid());
            }
            blocks.push(encode(&frame(
                "sortsys/migration-file-block/v1",
                &[&block.id, &block.hash],
            )));
        }
        Ok(frame(
            "sortsys/migration-file-receipt/v1",
            &[
                &self.tenant,
                &self.migration,
                &self.generation,
                &self.source,
                &self.bytes,
                &self.object,
                &self.revision,
                &self.ciphertext_hash,
                &self.author,
                &encode(&frame(
                    "sortsys/migration-file-blocks/v1",
                    &blocks.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
            ],
        ))
    }
}

/// Public commitment only: the signer, not the storage server, attests that
/// the hidden source and destination passed the application's local checks.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDigest {
    pub count: String,
    pub hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typescript", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSeal {
    pub tenant: String,
    pub migration: String,
    pub schema: String,
    pub generation: String,
    pub policy_version: String,
    pub catalog_version: String,
    pub source: MigrationDigest,
    pub target: MigrationDigest,
    pub author: String,
    pub proof: String,
}

fn nonnegative(value: &str) -> Result<i64> {
    let parsed: i64 = value.parse().map_err(|_| invalid())?;
    if parsed < 0 || parsed.to_string() != value {
        return Err(invalid());
    }
    Ok(parsed)
}

impl MigrationSeal {
    pub fn frame(&self) -> Result<Vec<u8>> {
        for value in [&self.tenant, &self.migration, &self.schema, &self.author] {
            identifier(value)?;
        }
        for value in [
            &self.generation,
            &self.policy_version,
            &self.catalog_version,
        ] {
            revision(value)?;
        }
        for digest in [&self.source, &self.target] {
            nonnegative(&digest.count)?;
            sized::<32>(&digest.hash)?;
        }
        Ok(frame(
            "zerotrust/migration-seal/v1",
            &[
                &self.tenant,
                &self.migration,
                &self.schema,
                &self.generation,
                &self.policy_version,
                &self.catalog_version,
                &self.source.count,
                &self.source.hash,
                &self.target.count,
                &self.target.hash,
                &self.author,
            ],
        ))
    }

    pub fn verify(&self, signing_key: &[u8]) -> Result<()> {
        crate::crypto::verify(signing_key, &self.proof, &self.frame()?)
    }
}

/// Streaming inventory commitment; entries must be ordered by (kind, id).
/// Identifiers are ASCII, so browser, SQL C collation and Rust agree on order.
pub struct MigrationInventory {
    state: sha2::Sha256,
    previous: Option<(String, String)>,
    count: i64,
}

impl Default for MigrationInventory {
    fn default() -> Self {
        use sha2::Digest;
        let mut state = sha2::Sha256::new();
        state.update(frame("zerotrust/migration-inventory/v1", &[]));
        Self {
            state,
            previous: None,
            count: 0,
        }
    }
}

impl MigrationInventory {
    pub fn add(&mut self, kind: &str, id: &str, version: &str, hash: &str) -> Result<()> {
        use sha2::Digest;
        identifier(kind)?;
        identifier(id)?;
        nonnegative(version)?;
        sized::<32>(hash)?;
        let key = (kind.to_owned(), id.to_owned());
        if self
            .previous
            .as_ref()
            .is_some_and(|previous| previous >= &key)
        {
            return Err(invalid());
        }
        self.count = self.count.checked_add(1).ok_or_else(invalid)?;
        self.state.update(frame(
            "zerotrust/migration-entry/v1",
            &[kind, id, version, hash],
        ));
        self.previous = Some(key);
        Ok(())
    }

    pub fn finish(self) -> MigrationDigest {
        use sha2::Digest;
        let count = self.count.to_string();
        let hash = encode(&sha2::Sha256::digest(frame(
            "zerotrust/migration-inventory-end/v1",
            &[&count, &encode(&self.state.finalize())],
        )));
        MigrationDigest { count, hash }
    }
}
