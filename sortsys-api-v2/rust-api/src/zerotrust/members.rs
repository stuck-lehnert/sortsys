//! Technical account reservations. Personal profiles never enter this service.
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{
    crypto::{encode, frame, identifier, invalid, revision, sized, verify},
    objects::{SaveInput, conflict},
    wire::{Facet, SignedPolicy},
};
use crate::{
    api::Success,
    error::RpcResult,
    error::{forbidden, internal, not_found},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

#[derive(Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemberCreation {
    tenant: String,
    generation: String,
    author: String,
    id: String,
    username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    source: Option<InitialMemberState>,
    proof: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialMemberState {
    context: String,
    locale: String,
    created_micros: String,
    modified_micros: String,
    deactivated_micros: Option<String>,
    archived_micros: Option<String>,
}
impl MemberCreation {
    fn user_id(&self) -> RpcResult<Id> {
        let id = Id::decode(&self.id).map_err(|_| invalid())?;
        if id.0 <= 0 || id.encode() != self.id {
            return Err(invalid());
        }
        Ok(id)
    }
    fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.author)?;
        revision(&self.generation)?;
        self.user_id()?;
        if self.username.is_empty()
            || self.username.len() > 63
            || self.username.starts_with('.')
            || self.username.ends_with('.')
            || self.username.contains("..")
            || !self
                .username
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.'))
        {
            return Err(invalid());
        }
        let mut fields: Vec<&str> = vec![
            &self.tenant,
            &self.generation,
            &self.author,
            &self.id,
            &self.username,
        ];
        if let Some(source) = &self.source {
            super::bootstrap::validate_context(&source.context)?;
            if !["de", "en"].contains(&source.locale.as_str())
                || source.archived_micros.is_some() && source.deactivated_micros.is_none()
            {
                return Err(invalid());
            }
            micros(&source.created_micros)?;
            micros(&source.modified_micros)?;
            for value in [&source.deactivated_micros, &source.archived_micros]
                .into_iter()
                .flatten()
            {
                micros(value)?;
            }
            fields.extend([
                &source.context,
                &source.locale,
                &source.created_micros,
                &source.modified_micros,
                source.deactivated_micros.as_deref().unwrap_or(""),
                source.archived_micros.as_deref().unwrap_or(""),
            ]);
            return Ok(frame("sortsys/member-create-from-backup/v1", &fields));
        }
        Ok(frame("sortsys/member-create/v1", &fields))
    }
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CreationId {
    id: Id,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CreatedMember {
    creation: MemberCreation,
    created_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
pub(super) enum MemberAction {
    Activate,
    Deactivate,
    Archive,
    Unarchive,
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MemberChange {
    tenant: String,
    generation: String,
    author: String,
    id: String,
    action: MemberAction,
    request_id: String,
    expected: String,
    at_micros: String,
    packet_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    permissions: Option<SignedPolicy>,
    proof: String,
}
impl MemberChange {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        for value in [&self.tenant, &self.author, &self.request_id] {
            identifier(value)?;
        }
        let id = Id::decode(&self.id).map_err(|_| invalid())?;
        if id.0 <= 0 || id.encode() != self.id {
            return Err(invalid());
        }
        revision(&self.generation)?;
        sized::<32>(&self.expected)?;
        sized::<64>(&self.packet_signature)?;
        micros(&self.at_micros)?;
        let action = match self.action {
            MemberAction::Activate => "activate",
            MemberAction::Deactivate => "deactivate",
            MemberAction::Archive => "archive",
            MemberAction::Unarchive => "unarchive",
        };
        Ok(frame(
            "sortsys/member-change/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.author,
                &self.id,
                action,
                &self.request_id,
                &self.expected,
                &self.at_micros,
                &self.packet_signature,
                self.permissions
                    .as_ref()
                    .map(|policy| policy.signature.as_str())
                    .unwrap_or(""),
            ],
        ))
    }
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeReceiptId {
    request_id: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct MemberStatus {
    id: Id,
    version: String,
    at_micros: String,
    deactivated_micros: Option<String>,
    archived_micros: Option<String>,
}
struct StatusRow {
    username: String,
    modified_at: DateTime<Utc>,
    deactivated_at: Option<DateTime<Utc>>,
    archived_at: Option<DateTime<Utc>>,
    stamp: DateTime<Utc>,
}
fn date(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Micros, true)
}
fn micros(value: &str) -> RpcResult<DateTime<Utc>> {
    let integer: i64 = value.parse().map_err(|_| invalid())?;
    if integer.to_string() != value {
        return Err(invalid());
    }
    DateTime::from_timestamp_micros(integer).ok_or_else(invalid)
}
impl StatusRow {
    fn version(&self, id: Id) -> String {
        encode(&Sha256::digest(frame(
            "sortsys/member-status/v1",
            &[
                &id.encode(),
                &self.username,
                &date(self.modified_at),
                &self.deactivated_at.map(date).unwrap_or_default(),
                &self.archived_at.map(date).unwrap_or_default(),
            ],
        )))
    }
}

mod persistence;
pub(super) use persistence::apply_change as metadata_apply_change;
pub(crate) use persistence::register as register_metadata;

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<MemberCreation, Success>("zerotrust.members.create")
        .query_stub::<CreationId, CreatedMember>("zerotrust.members.creation")
        .query_stub::<CreationId, MemberStatus>("zerotrust.members.status")
        .query_stub::<ChangeReceiptId, MemberChange>("zerotrust.members.changeReceipt")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> MemberCreation {
        MemberCreation {
            tenant: "test".into(),
            generation: "1".into(),
            author: "user:1".into(),
            id: "4".into(),
            username: "anna.muster".into(),
            source: None,
            proof: String::new(),
        }
    }
    #[test]
    fn reservations_accept_only_canonical_technical_identifiers() {
        assert!(request().frame().is_ok());
        for username in ["", "Anna", ".anna", "anna.", "anna..muster", "a-b"] {
            let mut value = request();
            value.username = username.into();
            assert!(value.frame().is_err());
        }
        for id in ["0", "04", "-1"] {
            let mut value = request();
            value.id = id.into();
            assert!(value.frame().is_err());
        }
    }
    #[test]
    fn reservations_reject_personal_profile_fields() {
        let mut value = serde_json::to_value(request()).unwrap();
        value["firstName"] = serde_json::json!("No personal data here");
        assert!(serde_json::from_value::<MemberCreation>(value).is_err());
    }
}
