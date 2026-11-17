use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::crypto::invalid;
#[cfg(test)]
use super::crypto::sized;
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
    pub const ALL: [Self; 10] = [
        Self::Scope,
        Self::ContractQuantities,
        Self::Measurement,
        Self::OfferPrices,
        Self::Calculation,
        Self::Procurement,
        Self::Billing,
        Self::MasterData,
        Self::Personnel,
        Self::Attachment,
    ];

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

impl AsRef<str> for Facet {
    fn as_ref(&self) -> &str {
        self.name()
    }
}

pub(super) use sortsys_zerotrust::policy::{Action, Effect};

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct Rule {
    pub subject: String,
    pub scope: String,
    pub facet: Facet,
    pub actions: Vec<Action>,
    pub effect: Effect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<RuleOrigin>,
}

#[derive(Clone, Copy, Deserialize, Serialize, TS)]
pub(super) enum RuleOrigin {
    #[serde(rename = "absence-default")]
    AbsenceDefault,
}

pub(super) use sortsys_zerotrust::policy::PolicyTransaction;

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct SignedPolicy {
    pub tenant: String,
    pub version: String,
    pub rules: Vec<Rule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub suspended: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transaction: Option<PolicyTransaction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub administration:
        Option<sortsys_zerotrust::administration::PolicyAdministration<SignedPolicy, Facet>>,
    pub signature: String,
}
impl Rule {
    fn as_protocol(&self) -> sortsys_zerotrust::policy::RuleRef<'_> {
        sortsys_zerotrust::policy::RuleRef {
            subject: &self.subject,
            scope: &self.scope,
            facet: self.facet.name(),
            actions: &self.actions,
            effect: self.effect,
            origin: self.origin.map(|origin| match origin {
                RuleOrigin::AbsenceDefault => "absence-default",
            }),
        }
    }

    fn validate_application_origin(&self) -> RpcResult<()> {
        if self.origin.is_none() {
            return Ok(());
        }
        let subject = self.subject.strip_prefix("user:").ok_or_else(invalid)?;
        let personnel_read = self.facet == Facet::Scope
            && self.actions.iter().all(|action| *action == Action::Read)
            && self.scope.starts_with("personnel:");
        let scope_prefix = if personnel_read {
            "personnel:"
        } else {
            "absence:"
        };
        let target = self.scope.strip_prefix(scope_prefix).ok_or_else(invalid)?;
        for value in [subject, target] {
            let id = crate::ids::Id::decode(value).map_err(|_| invalid())?;
            if id.0 <= 0 || id.encode() != value {
                return Err(invalid());
            }
        }
        if self.effect != Effect::Allow {
            return Err(invalid());
        }
        for action in &self.actions {
            let permitted = match self.facet {
                Facet::MasterData => {
                    matches!(action, Action::Read | Action::Create | Action::Delete)
                }
                Facet::Personnel => matches!(action, Action::Read | Action::Approve),
                Facet::Scope => personnel_read,
                _ => false,
            };
            if !permitted {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

impl SignedPolicy {
    fn as_protocol(&self) -> sortsys_zerotrust::policy::PolicyRef<'_> {
        sortsys_zerotrust::policy::PolicyRef {
            tenant: &self.tenant,
            version: &self.version,
            rules: self.rules.iter().map(Rule::as_protocol).collect(),
            suspended: self.suspended.as_deref(),
            transaction: self.transaction.as_ref(),
            administration: self.administration.as_ref().map(|value| {
                sortsys_zerotrust::administration::PolicyAdministrationRef {
                    root: Box::new(value.root.as_protocol()),
                    root_signature: &value.root.signature,
                    profiles: value
                        .profiles
                        .iter()
                        .map(|profile| profile.as_protocol())
                        .collect(),
                    author: &value.author,
                    previous_signature: &value.previous_signature,
                }
            }),
        }
    }

    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        if let Some(administration) = &self.administration {
            if administration.root.administration.is_some() {
                return Err(invalid());
            }
            // Application-specific rule origins must also be valid in the
            // primary checkpoint, including rules replaced by a profile.
            administration.root.frame()?;
        }
        if let Some(subjects) = &self.suspended {
            for subject in subjects {
                let value = subject.strip_prefix("user:").ok_or_else(invalid)?;
                let id = crate::ids::Id::decode(value).map_err(|_| invalid())?;
                if id.0 <= 0 || id.encode() != value {
                    return Err(invalid());
                }
            }
        }
        for rule in &self.rules {
            rule.validate_application_origin()?;
        }
        self.as_protocol().frame().map_err(Into::into)
    }

    pub fn verify(&self, key: &[u8]) -> RpcResult<()> {
        self.frame()?;
        self.as_protocol()
            .verify(key, &self.signature)
            .map_err(Into::into)
    }

    pub fn administrative_replacement(
        &self,
        previous: &Self,
        actor: &super::wire::IdentityCertificate,
    ) -> RpcResult<bool> {
        let protocol = self.as_protocol();
        let Some(administration) = protocol.administration.as_ref() else {
            return Ok(false);
        };
        administration
            .replaces(
                &previous.as_protocol(),
                &previous.signature,
                actor,
                &self.version,
            )
            .map_err(Into::into)
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
        sortsys_zerotrust::policy::allows(
            self.rules.iter().chain(inherited).map(Rule::as_protocol),
            self.suspended.as_deref(),
            sortsys_zerotrust::policy::PermissionRequest {
                subject,
                scope,
                facet: facet.name(),
                action,
            },
        )
    }
}

pub(super) use sortsys_zerotrust::protocol::{
    AuthorityCertificate, IdentityCertificate, SealedBox,
};

pub(super) type EncryptedObject = sortsys_zerotrust::protocol::EncryptedObject<Facet>;

#[cfg(test)]
mod object_tombstone_tests {
    use super::*;
    use crate::zerotrust::crypto::encode;

    #[test]
    fn delegated_frames_validate_primary_rule_origins_and_reject_nested_administration() {
        let certificate = IdentityCertificate {
            tenant: "frame-test".into(),
            generation: "1".into(),
            user: "user:1".into(),
            previous_signature: None,
            encryption_key: encode(&[0; 32]),
            signing_key: encode(&[0; 32]),
            signature: encode(&[0; 64]),
        };
        let mut root = SignedPolicy {
            tenant: certificate.tenant.clone(),
            version: "1".into(),
            rules: vec![Rule {
                subject: "user:1".into(),
                scope: "catalog:products".into(),
                facet: Facet::MasterData,
                actions: vec![Action::Read],
                effect: Effect::Allow,
                origin: Some(RuleOrigin::AbsenceDefault),
            }],
            suspended: None,
            transaction: None,
            administration: None,
            signature: certificate.signature.clone(),
        };
        let mut delegated = SignedPolicy {
            tenant: root.tenant.clone(),
            version: "2".into(),
            rules: Vec::new(),
            suspended: None,
            transaction: None,
            administration: Some(sortsys_zerotrust::administration::PolicyAdministration {
                root: Box::new(root.clone()),
                profiles: Vec::new(),
                author: certificate,
                previous_signature: root.signature.clone(),
            }),
            signature: root.signature.clone(),
        };
        assert!(delegated.frame().is_err());
        root.rules[0].origin = None;
        *delegated.administration.as_mut().unwrap().root = root;
        assert!(delegated.frame().is_ok());
        let nested = delegated.clone();
        *delegated.administration.as_mut().unwrap().root = nested;
        assert!(delegated.frame().is_err());
    }

    #[test]
    fn browser_tombstones_are_signed_empty_bodies_and_cannot_be_relabelled() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-tombstones.json"
        ))
        .unwrap();
        let key = sized::<32>(value["signer"].as_str().unwrap()).unwrap();
        let initial: EncryptedObject = serde_json::from_value(value["initial"].clone()).unwrap();
        let deleted: EncryptedObject = serde_json::from_value(value["deleted"].clone()).unwrap();
        initial.verify(&key).unwrap();
        deleted.verify(&key).unwrap();
        assert!(!initial.is_tombstone());
        assert!(deleted.is_tombstone());
        let mut changed = deleted.clone();
        changed.format = "sortsys-object-v1".into();
        assert!(changed.verify(&key).is_err());
        let mut changed = initial;
        changed.format = "sortsys-object-tombstone-v1".into();
        changed.revision = "2".into();
        assert!(
            changed.frame().is_err(),
            "A deletion cannot carry an arbitrary encrypted payload"
        );
        let mut changed = deleted.clone();
        changed.revision = "1".into();
        assert!(changed.frame().is_err());
        let mut changed = deleted;
        changed.ciphertext = super::super::crypto::encode(&[0; 17]);
        assert!(changed.frame().is_err());
    }
}
