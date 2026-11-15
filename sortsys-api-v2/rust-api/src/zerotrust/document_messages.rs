//! Accepted ciphertext updates, shared across API instances. The service never
//! interprets field names, Yjs updates, selections or participant display names.
pub(super) mod persistence;
use super::{
    crypto::{identifier, invalid, revision},
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
    envelope: EncryptedObject,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Read {
    room: Room,
    after: String,
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Message {
    sequence: String,
    kind: Kind,
    key: String,
    authority_generation: String,
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
fn message_object(room: &Room, kind: Kind, key: &str) -> RpcResult<String> {
    room.keys()?;
    if key.len() != 43
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(invalid());
    }
    let object = format!(
        "live:v2:{}:{}:{}:{}:{key}",
        room.scope,
        room.document,
        room.facet,
        kind.name()
    );
    identifier(&object)?;
    Ok(object)
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<Post, Success>("zerotrust.documents.messages.post")
        .query_stub::<Read, Page>("zerotrust.documents.messages.read")
}
