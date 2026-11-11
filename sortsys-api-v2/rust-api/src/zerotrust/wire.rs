use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::crypto::{decode, encode, frame, identifier, invalid, revision, sized, verify};
use crate::error::RpcResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Facet {
    Scope,
    ContractQuantities,
    Measurement,
    OfferPrices,
    Calculation,
    Procurement,
    Billing,
    MasterData,
    Personnel,
    Attachment,
}
impl Facet {
    pub fn name(self) -> &'static str {
        match self {
            Self::Scope => "scope",
            Self::ContractQuantities => "contract-quantities",
            Self::Measurement => "measurement",
            Self::OfferPrices => "offer-prices",
            Self::Calculation => "calculation",
            Self::Procurement => "procurement",
            Self::Billing => "billing",
            Self::MasterData => "master-data",
            Self::Personnel => "personnel",
            Self::Attachment => "attachment",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub(super) enum Action {
    Read,
    Create,
    Update,
    Delete,
    Approve,
    Grant,
}
impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Approve => "approve",
            Self::Grant => "grant",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub(super) enum Effect {
    Allow,
    Deny,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct Rule {
    pub subject: String,
    pub scope: String,
    pub facet: Facet,
    pub actions: Vec<Action>,
    pub effect: Effect,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct SignedPolicy {
    pub tenant: String,
    pub version: String,
    pub rules: Vec<Rule>,
    pub signature: String,
}
impl SignedPolicy {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        revision(&self.version)?;
        if self.rules.len() > 10_000 {
            return Err(invalid());
        }
        let mut fields = vec![self.tenant.clone(), self.version.clone()];
        for rule in &self.rules {
            identifier(&rule.subject)?;
            identifier(&rule.scope)?;
            if rule.actions.is_empty()
                || rule.actions.len() > 6
                || rule
                    .actions
                    .iter()
                    .enumerate()
                    .any(|(i, a)| rule.actions[..i].contains(a))
            {
                return Err(invalid());
            }
            let mut parts = vec![
                rule.subject.as_str(),
                rule.scope.as_str(),
                rule.facet.name(),
                if rule.effect == Effect::Allow {
                    "allow"
                } else {
                    "deny"
                },
            ];
            parts.extend(rule.actions.iter().map(|action| action.name()));
            fields.push(encode(&frame("sortsys/rule/v1", &parts)));
        }
        Ok(frame(
            "sortsys/policy/v1",
            &fields.iter().map(String::as_str).collect::<Vec<_>>(),
        ))
    }
    pub fn verify(&self, key: &[u8]) -> RpcResult<()> {
        verify(key, &self.signature, &self.frame()?)
    }
    pub fn allows(&self, subject: &str, scope: &str, facet: Facet, action: Action) -> bool {
        self.allows_with(&[], subject, scope, facet, action)
    }
    pub fn allows_with(
        &self,
        inherited: &[Rule],
        subject: &str,
        scope: &str,
        facet: Facet,
        action: Action,
    ) -> bool {
        let mut allowed = false;
        for rule in self.rules.iter().chain(inherited) {
            if rule.subject != subject
                || rule.scope != scope
                || rule.facet != facet
                || !rule.actions.contains(&action)
            {
                continue;
            }
            if rule.effect == Effect::Deny {
                return false;
            }
            allowed = true;
        }
        allowed
    }
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AuthorityCertificate {
    pub tenant: String,
    pub generation: String,
    pub recovery_encryption_key: String,
    pub recovery_signing_key: String,
    pub authority_signing_key: String,
    pub signature: String,
}
impl AuthorityCertificate {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        revision(&self.generation)?;
        sized::<32>(&self.recovery_encryption_key)?;
        sized::<32>(&self.recovery_signing_key)?;
        sized::<32>(&self.authority_signing_key)?;
        Ok(frame(
            "sortsys/authority/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.recovery_encryption_key,
                &self.recovery_signing_key,
                &self.authority_signing_key,
            ],
        ))
    }
    pub fn verify(&self) -> RpcResult<()> {
        verify(
            &sized::<32>(&self.recovery_signing_key)?,
            &self.signature,
            &self.frame()?,
        )
    }
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IdentityCertificate {
    pub tenant: String,
    pub generation: String,
    pub user: String,
    pub encryption_key: String,
    pub signing_key: String,
    pub signature: String,
}
impl IdentityCertificate {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.user)?;
        revision(&self.generation)?;
        sized::<32>(&self.encryption_key)?;
        sized::<32>(&self.signing_key)?;
        Ok(frame(
            "sortsys/identity-certificate/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.user,
                &self.encryption_key,
                &self.signing_key,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> RpcResult<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct SealedBox {
    pub tenant: String,
    pub purpose: String,
    pub object: String,
    pub generation: String,
    pub recipient: String,
    pub author: String,
    pub format: String,
    pub enc: String,
    pub ciphertext: String,
    pub signature: String,
}
impl SealedBox {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        identifier(&self.tenant)?;
        identifier(&self.object)?;
        identifier(&self.recipient)?;
        identifier(&self.author)?;
        revision(&self.generation)?;
        if self.format != "sortsys-hpke-v1"
            || ![
                "area-key",
                "authority-key",
                "recovery-catalog",
                "validation-request",
                "validation-result",
                "search-request",
                "search-result",
                "live-llm-context",
            ]
            .contains(&self.purpose.as_str())
        {
            return Err(invalid());
        }
        sized::<32>(&self.enc)?;
        if decode(&self.ciphertext, 32 * 1024 * 1024 + 16)?.len() < 16 {
            return Err(invalid());
        }
        Ok(frame(
            "sortsys/hpke/v1",
            &[
                &self.tenant,
                &self.purpose,
                &self.object,
                &self.generation,
                &self.recipient,
                &self.author,
                &self.format,
                &self.enc,
                &self.ciphertext,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> RpcResult<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EncryptedObject {
    pub tenant: String,
    pub scope: String,
    pub facet: Facet,
    pub object: String,
    pub revision: String,
    pub generation: String,
    pub policy_version: String,
    pub author: String,
    pub format: String,
    pub nonce: String,
    pub ciphertext: String,
    pub wrapped_key: String,
    pub signature: String,
}
impl EncryptedObject {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        for value in [&self.tenant, &self.scope, &self.object, &self.author] {
            identifier(value)?;
        }
        for value in [&self.revision, &self.generation, &self.policy_version] {
            revision(value)?;
        }
        if self.format != "sortsys-object-v1" {
            return Err(invalid());
        }
        sized::<12>(&self.nonce)?;
        sized::<40>(&self.wrapped_key)?;
        if decode(&self.ciphertext, 16 * 1024 * 1024 + 16)?.len() < 16 {
            return Err(invalid());
        }
        Ok(frame(
            "sortsys/object/v1",
            &[
                &self.tenant,
                &self.scope,
                self.facet.name(),
                &self.object,
                &self.revision,
                &self.generation,
                &self.policy_version,
                &self.author,
                &self.format,
                &self.nonce,
                &self.ciphertext,
                &self.wrapped_key,
            ],
        ))
    }
    pub fn verify(&self, key: &[u8]) -> RpcResult<()> {
        verify(key, &self.signature, &self.frame()?)
    }
}
