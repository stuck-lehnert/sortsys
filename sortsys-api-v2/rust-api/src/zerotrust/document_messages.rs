//! Accepted ciphertext updates, shared across API instances. The service never
//! interprets field names, Yjs updates, selections or participant display names.
pub(super) mod persistence;
use super::{
    crypto::{identifier, invalid, revision, sized},
    documents::DocumentHead,
    objects::conflict,
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    api::Success,
    error::RpcResult,
    error::{forbidden, internal},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize, TS, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub(super) struct Room {
    pub scope: String,
    pub document: String,
    pub facet: String,
}
impl Room {
    pub(super) fn keys(&self) -> RpcResult<Vec<Facet>> {
        checked_id(&self.document)?;
        if let Some(owner) = self.scope.strip_prefix("project:") {
            checked_id(owner)?;
            if self.facet != "attachment" {
                return Err(invalid());
            }
            return Ok(vec![Facet::Attachment]);
        }
        let owner = self.scope.strip_prefix("commercial:").ok_or_else(invalid)?;
        checked_id(owner)?;
        if self.facet == "opaque" {
            return Ok(super::creation::COMMERCIAL_FACETS.to_vec());
        }
        if !super::documents::CONTENT_FACETS.contains(&self.facet.as_str()) {
            return Err(invalid());
        }
        let facet = Facet::ALL
            .into_iter()
            .find(|facet| facet.name() == self.facet)
            .ok_or_else(invalid)?;
        Ok(vec![facet])
    }
    pub(super) fn outer(&self) -> RpcResult<Facet> {
        let keys = self.keys()?;
        if self.facet == "opaque" {
            return Ok(Facet::Scope);
        }
        Ok(keys[0])
    }
    pub(super) fn access_domains(&self) -> RpcResult<Vec<String>> {
        let mut domains = self
            .keys()?
            .into_iter()
            .map(|facet| format!("{}:{}", self.scope, facet.name()))
            .collect::<Vec<_>>();
        if self.scope.starts_with("commercial:") {
            domains.push(format!("{}:master-data", self.scope));
        }
        domains.sort();
        domains.dedup();
        Ok(domains)
    }
}
#[derive(Clone, Copy, Deserialize, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Initialize,
    Update,
    Presence,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::Update => "update",
            Self::Presence => "presence",
        }
    }
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Post {
    room: Room,
    kind: Kind,
    key: String,
    authority_generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    content: Option<String>,
    envelope: EncryptedObject,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Read {
    room: Room,
    after: String,
    #[serde(default)]
    #[ts(optional)]
    content: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ReadBatch {
    selections: Vec<Read>,
}
impl ReadBatch {
    fn domains(&self) -> RpcResult<Vec<String>> {
        if self.selections.is_empty() || self.selections.len() > 4 {
            return Err(invalid());
        }
        let mut domains = std::collections::BTreeSet::new();
        for selection in &self.selections {
            super::live_checkpoints::position(&selection.after)?;
            domains.extend(selection.room.access_domains()?);
        }
        Ok(domains.into_iter().collect())
    }
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Message {
    sequence: String,
    kind: Kind,
    key: String,
    authority_generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    content: Option<String>,
    envelope: EncryptedObject,
}
#[derive(Serialize, TS)]
struct Page {
    messages: Vec<Message>,
    presence: Vec<Message>,
    after: String,
    more: bool,
}
fn checked_id(value: &str) -> RpcResult<()> {
    let id = Id::decode(value).map_err(|_| invalid())?;
    if id.0 <= 0 || id.encode() != value {
        return Err(invalid());
    }
    Ok(())
}
fn message_object(room: &Room, kind: Kind, key: &str, content: Option<&str>) -> RpcResult<String> {
    room.keys()?;
    if key.len() != 43
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(invalid());
    }
    let channel = format!(
        "{}:{}:{}:{}:{key}",
        room.scope,
        room.document,
        room.facet,
        kind.name()
    );
    let object = if let Some(content) = content {
        sized::<32>(content)?;
        format!("live:v3:{channel}:{content}")
    } else {
        format!("live:v2:{channel}")
    };
    identifier(&object)?;
    Ok(object)
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<Post, Success>("zerotrust.documents.messages.post")
        .query_stub::<Read, Page>("zerotrust.documents.messages.read")
        .query_stub::<ReadBatch, Vec<Page>>("zerotrust.documents.messages.pages")
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    fn batch(count: usize) -> ReadBatch {
        ReadBatch {
            selections: (0..count)
                .map(|index| Read {
                    room: Room {
                        scope: "commercial:2".into(),
                        document: "3".into(),
                        facet: "scope".into(),
                    },
                    after: index.to_string(),
                    content: None,
                })
                .collect(),
        }
    }

    #[test]
    fn message_batches_bound_work_and_validate_every_room_and_cursor() {
        assert!(batch(0).domains().is_err());
        assert!(batch(5).domains().is_err());
        assert_eq!(
            batch(4).domains().unwrap(),
            vec!["commercial:2:master-data", "commercial:2:scope"]
        );
        let mut invalid_cursor = batch(4);
        invalid_cursor.selections[3].after = "-1".into();
        assert!(invalid_cursor.domains().is_err());
        let mut invalid_room = batch(4);
        invalid_room.selections[3].room.facet = "master-data".into();
        assert!(invalid_room.domains().is_err());
        let mut invalid_document = batch(4);
        invalid_document.selections[3].room.document = "0".into();
        assert!(invalid_document.domains().is_err());
    }
}
