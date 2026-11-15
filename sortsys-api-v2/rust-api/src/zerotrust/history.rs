//! Accepted encrypted revisions, without server-side business interpretation.
use super::crypto::verify;
use super::{
    access::Security,
    crypto::{frame, identifier, invalid, revision, sized},
    wire::{Action, EncryptedObject},
};
use crate::{
    error::RpcResult,
    error::forbidden,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize, TS, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MigrationOrigin {
    pub generation: String,
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<HistoryOrigin>,
}
#[derive(Clone, Deserialize, Serialize, TS, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoryOrigin {
    source: String,
    occurred_micros: String,
}
impl HistoryOrigin {
    fn instant(&self) -> RpcResult<DateTime<Utc>> {
        revision(&self.source)?;
        let time = self.occurred_micros.parse::<i64>().map_err(|_| invalid())?;
        if time.to_string() != self.occurred_micros
            || !(-62_135_596_800_000_000..=253_402_300_799_999_999).contains(&time)
        {
            return Err(invalid());
        }
        DateTime::from_timestamp_micros(time).ok_or_else(invalid)
    }
}
impl MigrationOrigin {
    pub fn event_order(&self) -> Option<String> {
        self.history.as_ref().map(|origin| origin.source.clone())
    }
    pub fn event_time(&self) -> RpcResult<Option<DateTime<Utc>>> {
        self.history
            .as_ref()
            .map(HistoryOrigin::instant)
            .transpose()
    }

    pub fn verify_authority(&self, envelope: &EncryptedObject, guard: &Security) -> RpcResult<()> {
        if self.generation != guard.root.generation.to_string() || envelope.revision != "1" {
            return Err(forbidden());
        }
        sized::<64>(&self.signature)?;
        let mut fields = vec![
            envelope.tenant.as_str(),
            envelope.scope.as_str(),
            envelope.facet.name(),
            envelope.object.as_str(),
            envelope.revision.as_str(),
            envelope.signature.as_str(),
            self.generation.as_str(),
        ];
        let domain = if let Some(history) = &self.history {
            history.instant()?;
            let prefix = format!(
                "legacy-activity:{}:{}:{}:",
                envelope.scope,
                envelope.facet.name(),
                history.source
            );
            if envelope.is_tombstone()
                || !envelope
                    .object
                    .strip_prefix(&prefix)
                    .is_some_and(|kind| ["event", "resource", "context", "actor"].contains(&kind))
            {
                return Err(invalid());
            }
            fields.extend([history.source.as_str(), history.occurred_micros.as_str()]);
            "sortsys/migration-history/v1"
        } else {
            "sortsys/migration-origin/v1"
        };
        verify(&guard.authority, &self.signature, &frame(domain, &fields))
    }
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    prefixes: Vec<String>,
    before: Option<String>,
    snapshot: Option<String>,
    known: Option<String>,
    known_total: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Get {
    id: String,
    revision: Option<String>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Change {
    access: Access,
    sequence: String,
    order_id: String,
    publication: String,
    initial_publication: String,
    domain: String,
    envelope: EncryptedObject,
    previous: Option<EncryptedObject>,
    migration_origin: Option<MigrationOrigin>,
    deletion: Option<Value>,
    references: Option<Value>,
    #[ts(type = "Date")]
    occurred_at: DateTime<Utc>,
    occurred_micros: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Page {
    access: Access,
    current: String,
    total: String,
    snapshot: String,
    after: Option<String>,
    after_micros: Option<String>,
    after_order: Option<String>,
    unchanged: bool,
    changes: Vec<Change>,
}
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Access {
    generation: String,
    policy_version: String,
}
impl Access {
    fn for_guard(guard: &Security) -> Self {
        Self {
            generation: guard.root.generation.to_string(),
            policy_version: guard.root.policy_version.to_string(),
        }
    }
}
mod persistence;
pub(crate) use persistence::register as register_metadata;

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<List, Page>("zerotrust.history.list")
        .query_stub::<Get, Option<Change>>("zerotrust.history.get")
}
