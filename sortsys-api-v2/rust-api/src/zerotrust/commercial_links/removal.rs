//! Authorize retirement against the live account, policy and content view.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::super::{
    access::MetadataRequest,
    content::content_number,
    creation::COMMERCIAL_FACETS,
    crypto::{frame, invalid, verify},
    wire::{Action, SignedPolicy},
};
use super::{address, conflict, coverage};
use crate::{
    api::Success,
    auth::AuthService,
    error::{RpcResult, forbidden},
    rpc::RequestContext,
};

#[derive(Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoveOffer {
    tenant: String,
    author: String,
    authority_generation: String,
    policy_version: String,
    content_epoch: String,
    case_id: String,
    expected_reference: String,
    signature: String,
}

impl RemoveOffer {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        address(&self.case_id)?;
        if self.expected_reference.len() != 64
            || !self
                .expected_reference
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid());
        }

        Ok(frame(
            "sortsys/commercial-retirement/v1",
            &[
                &self.tenant,
                &self.author,
                &self.authority_generation,
                &self.policy_version,
                &self.content_epoch,
                &self.case_id,
                &self.expected_reference,
            ],
        ))
    }
}

fn can_remove(policy: &SignedPolicy, subject: &str, scope: &str) -> bool {
    // Creation readers can inherit CRUD for individual facets. Hiding a
    // whole case requires explicit delete permission across all its facets.
    COMMERCIAL_FACETS
        .iter()
        .all(|&facet| policy.allows(subject, scope, facet, Action::Delete))
}

pub(super) async fn remove_offer(
    service: &AuthService,
    request: &RequestContext,
    input: RemoveOffer,
) -> RpcResult<Success> {
    let message = input.frame()?;
    let mut context = MetadataRequest::open(service, request)
        .await?
        .authorize_origins(&[])
        .await?;
    let guard = &context.security;

    if input.tenant != context.auth.tenant || input.author != guard.subject {
        return Err(forbidden());
    }

    let scope = format!("commercial:{}", input.case_id);
    if !can_remove(&guard.policy, &guard.subject, &scope) {
        return Err(forbidden());
    }
    verify(&guard.signing_key, &input.signature, &message)?;

    let content_epoch = content_number(&mut context.transaction).await?.to_string();

    if input.authority_generation != guard.root.generation.to_string()
        || input.policy_version != guard.policy.version
        || input.content_epoch != content_epoch
    {
        return Err(conflict());
    }

    coverage::stage_removal(
        &mut context.transaction,
        &input.case_id,
        &input.expected_reference,
    )
    .await?;
    context.transaction.commit().await?;

    Ok(Success { success: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zerotrust::{
        crypto::encode,
        wire::{Effect, Facet, Rule},
    };
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn retirement_requires_explicit_permission_across_the_case() {
        let subject = "user:2";
        let scope = "commercial:7";
        let mut policy = SignedPolicy {
            tenant: "retire-test".into(),
            version: "1".into(),
            rules: COMMERCIAL_FACETS
                .into_iter()
                .map(|facet| Rule {
                    subject: subject.into(),
                    scope: scope.into(),
                    facet,
                    actions: vec![Action::Read, Action::Delete],
                    effect: Effect::Allow,
                    origin: None,
                })
                .collect(),
            suspended: None,
            transaction: None,
            administration: None,
            signature: String::new(),
        };

        assert!(can_remove(&policy, subject, scope));
        assert!(!can_remove(&policy, "user:3", scope));
        assert!(!can_remove(&policy, subject, "commercial:8"));

        policy.rules.push(Rule {
            subject: subject.into(),
            scope: scope.into(),
            facet: Facet::Attachment,
            actions: vec![Action::Delete],
            effect: Effect::Deny,
            origin: None,
        });
        assert!(!can_remove(&policy, subject, scope));

        policy.rules.retain(|rule| rule.facet != Facet::Attachment);
        assert!(!can_remove(&policy, subject, scope));
    }

    #[test]
    fn retirement_signature_binds_the_epoch_and_exact_reference() {
        let signer = SigningKey::from_bytes(&[17; 32]);
        let key = signer.verifying_key();
        let mut command = RemoveOffer {
            tenant: "retire-test".into(),
            author: "user:2".into(),
            authority_generation: "2".into(),
            policy_version: "3".into(),
            content_epoch: "4".into(),
            case_id: "7".into(),
            expected_reference: "ab".repeat(32),
            signature: String::new(),
        };
        command.signature = encode(&signer.sign(&command.frame().unwrap()).to_bytes());

        let verify_command = |command: &RemoveOffer| {
            let message = command.frame()?;
            verify(key.as_bytes(), &command.signature, &message)
        };
        verify_command(&command).unwrap();

        command.content_epoch = "5".into();
        assert!(verify_command(&command).is_err());
        command.content_epoch = "4".into();

        command.expected_reference = "ba".repeat(32);
        assert!(verify_command(&command).is_err());
        command.expected_reference = "AB".repeat(32);
        assert!(command.frame().is_err());
    }
}
