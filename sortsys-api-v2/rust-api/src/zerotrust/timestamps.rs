//! Append-only external evidence for already immutable signed ciphertext.
//! Calendar availability and retry state never participate in write permissions.
use super::{
    access::Security,
    crypto::{decode, encode, identifier, invalid, random_id, revision, sized},
    documents::DocumentHead,
    objects::packet_hash,
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    error::RpcResult,
    error::{conflict, forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize, TS, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    format: String,
    kind: String,
    tenant: String,
    scope: String,
    object: String,
    revision: String,
    signature: String,
    digest: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    target: Target,
    artifact: Value,
    proofs: Vec<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Get {
    scope: String,
    object: String,
    revision: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Work {
    lease: String,
    evidence: Evidence,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Finish {
    digest: String,
    lease: String,
    proof: Option<String>,
}

fn object_target(envelope: &EncryptedObject) -> RpcResult<Option<Target>> {
    let kind = if super::immutable::write_action(envelope)?.is_some() {
        format!("immutable-{}", envelope.facet.name())
    } else {
        let Some(binding) = super::absences::binding(envelope)? else {
            return Ok(None);
        };
        super::absences::write_action(envelope)?;
        if envelope.is_tombstone() {
            "absence-withdrawal".into()
        } else if binding.decision {
            "absence-decision".into()
        } else {
            "absence-request".into()
        }
    };
    Ok(Some(Target {
        format: "sortsys-timestamp-target-v1".into(),
        kind,
        tenant: envelope.tenant.clone(),
        scope: envelope.scope.clone(),
        object: envelope.object.clone(),
        revision: envelope.revision.clone(),
        signature: envelope.signature.clone(),
        digest: packet_hash(envelope.frame()?, &envelope.signature)?,
    }))
}
fn document_target(head: &DocumentHead) -> RpcResult<Option<Target>> {
    if !head.locked {
        return Ok(None);
    }
    Ok(Some(Target {
        format: "sortsys-timestamp-target-v1".into(),
        kind: "document".into(),
        tenant: head.tenant.clone(),
        scope: head.scope.clone(),
        object: head.id.clone(),
        revision: head.version.clone(),
        signature: head.signature.clone(),
        digest: head.hash()?,
    }))
}
fn readable(guard: &Security, scope: &str, kind: &str) -> bool {
    if let Some(name) = kind.strip_prefix("immutable-") {
        return serde_json::from_value::<Facet>(Value::String(name.into()))
            .is_ok_and(|facet| guard.allows(&guard.subject, scope, facet, Action::Read));
    }
    guard.allows(&guard.subject, scope, Facet::MasterData, Action::Read)
        && (kind == "document"
            || guard.allows(&guard.subject, scope, Facet::Personnel, Action::Read))
}

pub(crate) use persistence::register as register_metadata;
pub(super) use persistence::{
    record_document as metadata_record_document, record_object as metadata_record_object,
};
mod persistence;
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<Get, Option<Evidence>>("zerotrust.timestamps.get")
        .mutation_stub::<(), Option<Work>>("zerotrust.timestamps.work")
        .mutation_stub::<Finish, ()>("zerotrust.timestamps.finish")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permanent_evidence_preserves_the_original_facet_permission() {
        use crate::zerotrust::access::Root;
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-native-business.json"
        ))
        .unwrap();
        let mut guard = Security {
            root: Root {
                generation: 1,
                policy_version: 1,
            },
            policy: serde_json::from_value(fixture["setup"]["policy"].clone()).unwrap(),
            subject: "user:1".into(),
            signing_key: vec![],
            authority: vec![],
            origins: vec![],
            inherited: vec![],
        };
        guard.policy.rules = vec![serde_json::from_value(serde_json::json!({
            "subject": "user:1", "scope": "project:2", "facet": "master-data", "actions": ["read"], "effect": "allow",
        })).unwrap()];
        assert!(readable(&guard, "project:2", "immutable-master-data"));
        assert!(!readable(&guard, "project:2", "immutable-billing"));
        guard.policy.rules[0].facet = Facet::Billing;
        assert!(readable(&guard, "project:2", "immutable-billing"));
        assert!(!readable(&guard, "project:2", "immutable-master-data"));
        assert!(!readable(&guard, "project:3", "immutable-billing"));
        assert!(!readable(&guard, "project:2", "immutable-unknown"));
    }

    #[test]
    fn browser_permanent_timestamp_targets_match_exact_signed_ciphertext() {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-immutable-records.json"
        ))
        .unwrap();
        for case in source["cases"].as_array().unwrap() {
            let envelope: EncryptedObject =
                serde_json::from_value(case["envelope"].clone()).unwrap();
            if case["action"].is_null() {
                assert!(object_target(&envelope).is_err());
            } else {
                let target = object_target(&envelope).unwrap();
                assert_eq!(serde_json::to_value(target).unwrap(), case["target"]);
            }
        }
    }
    #[test]
    fn accepted_absence_revisions_have_distinct_targets_and_no_optional_unlock_flag() {
        let source: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-absences.json"))
                .unwrap();
        let mut kinds = std::collections::BTreeSet::new();
        for case in source["cases"].as_array().unwrap() {
            let envelope: EncryptedObject =
                serde_json::from_value(case["envelope"].clone()).unwrap();
            if case["action"].is_string() {
                let target = object_target(&envelope).unwrap().unwrap();
                assert_eq!(target.signature, envelope.signature);
                kinds.insert(target.kind.clone());
                let mut value = serde_json::to_value(target).unwrap();
                value["ots"] = Value::Null;
                assert!(serde_json::from_value::<Target>(value).is_err());
            } else {
                assert!(object_target(&envelope).is_err());
            }
        }
        assert_eq!(kinds.len(), 3);
    }
}
