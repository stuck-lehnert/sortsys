//! Native publications and accepted live updates share one transaction boundary.
pub(super) mod persistence;
use super::{
    crypto::{frame, identifier, invalid, revision, sized, verify},
    document_messages::Room,
    documents::DocumentHead,
    objects::{SaveInput, conflict, packet_hash},
};
use crate::{error::RpcResult, error::forbidden, ids::Id, rpc::ProcedureRegistryBuilder};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LiveCheckpoint {
    format: String,
    tenant: String,
    pub scope: String,
    pub document: String,
    pub facet: String,
    sequence: String,
    covered: String,
    target: String,
    generation: String,
    policy_version: String,
    author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    content: Option<String>,
    signature: String,
}
pub(super) fn position(value: &str) -> RpcResult<i64> {
    if value == "0" {
        return Ok(0);
    }
    revision(value)
}
fn checked_id(value: &str) -> RpcResult<()> {
    let id = Id::decode(value).map_err(|_| invalid())?;
    if id.0 <= 0 || id.encode() != value {
        return Err(invalid());
    }
    Ok(())
}
impl LiveCheckpoint {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.author)?;
        let owner = self
            .scope
            .strip_prefix("commercial:")
            .or_else(|| self.scope.strip_prefix("project:"))
            .ok_or_else(invalid)?;
        checked_id(owner)?;
        checked_id(&self.document)?;
        checked_id(self.author.strip_prefix("user:").ok_or_else(invalid)?)?;
        Room {
            scope: self.scope.clone(),
            document: self.document.clone(),
            facet: self.facet.clone(),
        }
        .keys()?;
        if position(&self.covered)? > position(&self.sequence)? {
            return Err(invalid());
        }
        revision(&self.generation)?;
        revision(&self.policy_version)?;
        sized::<32>(&self.target)?;
        let mut fields: Vec<&str> = vec![
            &self.tenant,
            &self.scope,
            &self.document,
            &self.facet,
            &self.sequence,
            &self.covered,
            &self.target,
            &self.generation,
            &self.policy_version,
            &self.author,
        ];
        let protocol = match (self.format.as_str(), self.content.as_deref()) {
            ("sortsys-live-checkpoint-v2", None) => "sortsys/live-checkpoint/v2",
            ("sortsys-live-checkpoint-v3", Some(content)) => {
                sized::<32>(content)?;
                fields.push(content);
                "sortsys/live-checkpoint/v3"
            }
            _ => return Err(invalid()),
        };
        Ok(frame(protocol, &fields))
    }
}

#[derive(Serialize, TS)]
pub(super) struct LiveState {
    current: String,
    checkpoint: Option<LiveCheckpoint>,
    content: Option<String>,
}

struct Target {
    room: Room,
    hash: String,
    frozen: bool,
    deletion: bool,
    current_target: bool,
}
type RoomKey = (String, String, String);
struct Targets<'a> {
    targets: BTreeMap<RoomKey, Target>,
    selected: BTreeMap<RoomKey, &'a LiveCheckpoint>,
}

fn collect_targets<'a>(
    documents: &[DocumentHead],
    objects: &[SaveInput],
    proofs: &'a [LiveCheckpoint],
) -> RpcResult<Targets<'a>> {
    if proofs.len() > 1800 {
        return Err(invalid());
    }
    let mut targets = BTreeMap::new();
    for document in documents {
        for facet in super::documents::CONTENT_FACETS {
            let room = Room {
                scope: document.scope.clone(),
                document: document.id.clone(),
                facet: facet.to_owned(),
            };
            targets.insert(
                (
                    room.scope.clone(),
                    room.document.clone(),
                    room.facet.clone(),
                ),
                Target {
                    room,
                    hash: document.part_target(facet)?,
                    frozen: document.locked || document.read_only,
                    deletion: false,
                    current_target: false,
                },
            );
        }
    }
    for packet in objects {
        let parts: Vec<_> = packet.envelope.object.split(':').collect();
        if parts.len() != 4 || parts[0] != "project-files" || parts[2] != "file" {
            continue;
        }
        checked_id(parts[1])?;
        checked_id(parts[3])?;
        let room = Room {
            scope: format!("project:{}", parts[1]),
            document: parts[3].to_owned(),
            facet: "attachment".to_owned(),
        };
        if packet.envelope.scope != room.scope {
            return Err(invalid());
        }
        targets.insert(
            (
                room.scope.clone(),
                room.document.clone(),
                room.facet.clone(),
            ),
            Target {
                room,
                hash: packet_hash(packet.envelope.frame()?, &packet.envelope.signature)?,
                frozen: false,
                deletion: packet.envelope.is_tombstone(),
                current_target: false,
            },
        );
    }
    let mut selected = BTreeMap::new();
    for proof in proofs {
        proof.frame()?;
        let key = (
            proof.scope.clone(),
            proof.document.clone(),
            proof.facet.clone(),
        );
        if selected.insert(key.clone(), proof).is_some() {
            return Err(invalid());
        }
        targets.entry(key).or_insert_with(|| Target {
            room: Room {
                scope: proof.scope.clone(),
                document: proof.document.clone(),
                facet: proof.facet.clone(),
            },
            hash: proof.target.clone(),
            frozen: false,
            deletion: false,
            current_target: true,
        });
    }
    Ok(Targets { targets, selected })
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<Room, LiveState>("zerotrust.documents.messages.state")
}

#[cfg(test)]
mod tests {
    use super::super::crypto::encode;
    use super::*;

    #[test]
    fn checkpoint_frame_and_signature_match_the_browser_vector() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-live-channels.json"
        ))
        .unwrap();
        let checkpoint: LiveCheckpoint =
            serde_json::from_value(fixture["checkpoint"].clone()).unwrap();
        let key = sized::<32>(fixture["publicKey"].as_str().unwrap()).unwrap();
        assert_eq!(encode(&checkpoint.frame().unwrap()), fixture["frame"]);
        verify(&key, &checkpoint.signature, &checkpoint.frame().unwrap()).unwrap();
        let mut other_channel = checkpoint.clone();
        other_channel.facet = "billing".into();
        assert!(
            verify(
                &key,
                &other_channel.signature,
                &other_channel.frame().unwrap()
            )
            .is_err()
        );
    }
}
