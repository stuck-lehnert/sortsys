use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[cfg(test)]
use super::crypto::sized;
use super::crypto::{invalid, verify};
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
        }
    }

    pub fn frame(&self) -> RpcResult<Vec<u8>> {
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
