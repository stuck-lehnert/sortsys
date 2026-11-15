//! Immutable absence requests and separately authorized decisions. All checks
//! concern signed public context, references and capabilities, never contents.

use super::{
    access::Security,
    crypto::{invalid, revision},
    objects::SaveInput,
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    error::RpcResult,
    error::{conflict, forbidden},
    ids::Id,
};

pub(super) struct Binding {
    pub scope: String,
    pub decision: bool,
    pub request_object: String,
    pub decision_object: String,
}
impl Binding {
    pub fn domains(&self) -> [String; 2] {
        [
            format!("{}:master-data", self.scope),
            format!("{}:personnel", self.scope),
        ]
    }
}
pub(super) fn binding(envelope: &EncryptedObject) -> RpcResult<Option<Binding>> {
    if super::immutable::binding(envelope)? {
        return Ok(None);
    }
    // History shares this content key but has its own mandatory authority
    // origin. The object writer enforces that proof and one immutable revision.
    if envelope.object.starts_with("legacy-activity:") {
        return Ok(None);
    }
    if !envelope.scope.starts_with("absence:") && !envelope.object.starts_with("absence:") {
        return Ok(None);
    }
    let parts = envelope.object.split(':').collect::<Vec<_>>();
    if parts.len() != 4 || parts[0] != "absence" {
        return Err(invalid());
    }
    for token in [parts[1], parts[3]] {
        let id = Id::decode(token).map_err(|_| invalid())?;
        if id.0 <= 0 || id.encode() != token {
            return Err(invalid());
        }
    }
    let decision = match parts[2] {
        "request" => false,
        "decision" => true,
        _ => return Err(invalid()),
    };
    let scope = format!("absence:{}", parts[1]);
    if envelope.scope != scope
        || envelope.facet
            != if decision {
                Facet::Personnel
            } else {
                Facet::MasterData
            }
    {
        return Err(invalid());
    }
    Ok(Some(Binding {
        request_object: format!("{scope}:request:{}", parts[3]),
        decision_object: format!("{scope}:decision:{}", parts[3]),
        scope,
        decision,
    }))
}
pub(super) fn write_action(envelope: &EncryptedObject) -> RpcResult<Option<Action>> {
    let Some(area) = binding(envelope)? else {
        return Ok(None);
    };
    let version = revision(&envelope.revision)?;
    if envelope.is_tombstone() {
        if area.decision || version != 2 {
            return Err(invalid());
        }
        return Ok(Some(Action::Delete));
    }
    if version != 1 {
        return Err(invalid());
    }
    Ok(Some(if area.decision {
        Action::Approve
    } else {
        Action::Create
    }))
}

type ReferenceState = Option<(String, i64, bool, bool)>;
fn validate_decision_target(request: ReferenceState, domain: &str) -> RpcResult<()> {
    if request != Some((domain.to_owned(), 1, false, false)) {
        return Err(conflict());
    }
    Ok(())
}
fn validate_withdrawal(
    decision: ReferenceState,
    domain: &str,
    may_delete_decided: bool,
) -> RpcResult<()> {
    if let Some(value) = decision {
        if value != (domain.to_owned(), 1, false, false) {
            return Err(invalid());
        }
        if !may_delete_decided {
            return Err(forbidden());
        }
    }
    Ok(())
}

/// Validate the final state of the shared metadata transaction. Request and
/// decision packets may arrive in either order, but publish atomically.
pub(in crate::zerotrust) async fn metadata_validate_references(
    transaction: &mut crate::control::Transaction,
    guard: &Security,
    written: &[SaveInput],
) -> RpcResult<()> {
    async fn state(
        transaction: &mut crate::control::Transaction,
        object: &str,
    ) -> RpcResult<ReferenceState> {
        super::objects::metadata_object(transaction, object)
            .await?
            .map(|record| {
                Ok((
                    record.domain,
                    revision(&record.revision)?,
                    record.tombstone,
                    record.deleted,
                ))
            })
            .transpose()
    }
    for input in written {
        let Some(area) = binding(&input.envelope)? else {
            continue;
        };
        if area.decision {
            let request = state(transaction, &area.request_object).await?;
            validate_decision_target(request, &area.domains()[0])?;
        } else if input.envelope.is_tombstone() {
            let decision = state(transaction, &area.decision_object).await?;
            validate_withdrawal(
                decision,
                &area.domains()[1],
                guard.allows(
                    &guard.subject,
                    &area.scope,
                    Facet::Personnel,
                    Action::Delete,
                ),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn browser_absences_require_their_exact_immutable_operation_and_context() {
        let source: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-absences.json"))
                .unwrap();
        let signer = super::super::crypto::sized::<32>(source["signer"].as_str().unwrap()).unwrap();
        for case in source["cases"].as_array().unwrap() {
            let envelope: EncryptedObject =
                serde_json::from_value(case["envelope"].clone()).unwrap();
            envelope.verify(&signer).unwrap();
            if let Some(action) = case["action"].as_str() {
                assert_eq!(write_action(&envelope).unwrap().unwrap().name(), action);
                let binding = binding(&envelope).unwrap().unwrap();
                assert_eq!(
                    binding.domains(),
                    ["absence:2:master-data", "absence:2:personnel"]
                );
            } else {
                assert!(write_action(&envelope).is_err());
            }
        }
    }

    #[test]
    fn decisions_reject_missing_withdrawn_or_replaced_requests() {
        let domain = "absence:2:master-data";
        validate_decision_target(Some((domain.into(), 1, false, false)), domain).unwrap();
        for state in [
            None,
            Some(("absence:4:master-data".into(), 1, false, false)),
            Some((domain.into(), 2, false, false)),
            Some((domain.into(), 1, true, false)),
            Some((domain.into(), 1, false, true)),
        ] {
            assert!(validate_decision_target(state, domain).is_err());
        }
    }

    #[test]
    fn only_pending_requests_can_be_withdrawn_without_permission_for_decided_absences() {
        let domain = "absence:2:personnel";
        let decided = Some((domain.to_owned(), 1, false, false));
        validate_withdrawal(None, domain, false).unwrap();
        assert!(validate_withdrawal(decided.clone(), domain, false).is_err());
        validate_withdrawal(decided, domain, true).unwrap();
        for state in [
            Some(("absence:4:personnel".into(), 1, false, false)),
            Some((domain.into(), 2, false, false)),
            Some((domain.into(), 1, true, false)),
            Some((domain.into(), 1, false, true)),
        ] {
            assert!(validate_withdrawal(state, domain, true).is_err());
        }
    }
}
