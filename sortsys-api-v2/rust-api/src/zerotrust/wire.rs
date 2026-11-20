use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

#[derive(Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(super) enum RuleOrigin {
    AbsenceDefault,
    OrganizationOffice,
    OrganizationProcurement,
    ProjectOverview,
    ProjectDocumentation,
    ProjectManagement,
}

type RoleArea = (&'static str, Facet, &'static [Action]);

impl RuleOrigin {
    fn name(self) -> &'static str {
        match self {
            Self::AbsenceDefault => "absence-default",
            Self::OrganizationOffice => "organization-office",
            Self::OrganizationProcurement => "organization-procurement",
            Self::ProjectOverview => "project-overview",
            Self::ProjectDocumentation => "project-documentation",
            Self::ProjectManagement => "project-management",
        }
    }

    fn is_project_role(self) -> bool {
        matches!(
            self,
            Self::ProjectOverview | Self::ProjectDocumentation | Self::ProjectManagement
        )
    }

    fn role_areas(self) -> Option<&'static [RoleArea]> {
        const READ: &[Action] = &[Action::Read];
        const EDIT: &[Action] = &[Action::Read, Action::Create, Action::Update];
        match self {
            Self::AbsenceDefault => None,
            Self::OrganizationOffice => Some(&[
                ("catalog:customers", Facet::MasterData, EDIT),
                ("catalog:contacts", Facet::MasterData, EDIT),
                ("catalog:products", Facet::MasterData, READ),
            ]),
            Self::OrganizationProcurement => Some(&[
                ("catalog:products", Facet::MasterData, EDIT),
                ("catalog:vendors", Facet::MasterData, EDIT),
                ("catalog:products", Facet::Procurement, EDIT),
            ]),
            Self::ProjectOverview => {
                Some(&[("", Facet::MasterData, READ), ("", Facet::Attachment, READ)])
            }
            Self::ProjectDocumentation => Some(&[
                ("", Facet::MasterData, READ),
                ("", Facet::Attachment, &[Action::Read, Action::Create]),
                ("daily-reports", Facet::MasterData, EDIT),
                ("regie-reports", Facet::MasterData, EDIT),
            ]),
            Self::ProjectManagement => Some(&[
                ("", Facet::MasterData, &[Action::Read, Action::Update]),
                ("", Facet::Attachment, EDIT),
                ("delivery-notes", Facet::MasterData, EDIT),
                ("daily-reports", Facet::MasterData, EDIT),
                ("regie-reports", Facet::MasterData, EDIT),
                ("regie-reports", Facet::Personnel, EDIT),
                ("planning", Facet::MasterData, EDIT),
            ]),
        }
    }
}

#[cfg(test)]
mod role_tests {
    use super::*;

    fn rules_for_role(origin: RuleOrigin, project: Option<&str>) -> Vec<Rule> {
        origin
            .role_areas()
            .unwrap()
            .iter()
            .map(|(area, facet, actions)| {
                let scope = match project {
                    Some(id) if area.is_empty() => format!("project:{id}"),
                    Some(id) => format!("project:{id}:{area}"),
                    None => (*area).into(),
                };
                Rule {
                    subject: "user:4".into(),
                    scope,
                    facet: *facet,
                    actions: actions.to_vec(),
                    effect: Effect::Allow,
                    origin: Some(origin),
                }
            })
            .collect()
    }

    #[test]
    fn organization_roles_require_all_areas_and_only_fixed_actions() {
        let origin = RuleOrigin::OrganizationOffice;
        let mut rules = rules_for_role(origin, None);
        assert!(validate_rule_origins(&rules).is_ok());
        assert!(validate_rule_origins(&rules[..2]).is_err());
        rules.push(rules[0].clone());
        assert!(validate_rule_origins(&rules).is_err());
        rules.pop();
        rules[0].actions.push(Action::Delete);
        assert!(validate_rule_origins(&rules).is_err());
    }

    #[test]
    fn project_roles_require_a_complete_assignment_in_one_canonical_project() {
        let origin = RuleOrigin::ProjectDocumentation;
        let rules = rules_for_role(origin, Some("3"));
        assert!(validate_rule_origins(&rules).is_ok());
        assert!(validate_rule_origins(&rules[1..]).is_err());

        let mut cross_project = rules.clone();
        cross_project[2].scope = "project:5:daily-reports".into();
        assert!(validate_rule_origins(&cross_project).is_err());

        let mut overbroad = rules.clone();
        overbroad[2].facet = Facet::Calculation;
        assert!(validate_rule_origins(&overbroad).is_err());

        let mut invalid_id = rules.clone();
        invalid_id[0].scope = "project:03".into();
        assert!(validate_rule_origins(&invalid_id).is_err());

        let mut two_roles = rules.clone();
        two_roles.extend(rules_for_role(RuleOrigin::ProjectOverview, Some("3")));
        assert!(validate_rule_origins(&two_roles).is_err());

        let mut two_projects = rules;
        two_projects.extend(rules_for_role(RuleOrigin::ProjectOverview, Some("5")));
        assert!(validate_rule_origins(&two_projects).is_ok());
    }
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
            origin: self.origin.map(RuleOrigin::name),
        }
    }

    fn validate_application_origin(&self) -> RpcResult<Option<RoleBinding<'_>>> {
        let Some(origin) = self.origin else {
            return Ok(None);
        };
        let subject = self.subject.strip_prefix("user:").ok_or_else(invalid)?;
        if self.effect != Effect::Allow {
            return Err(invalid());
        }
        validate_rule_id(subject)?;
        if let Some(areas) = origin.role_areas() {
            let (group, relative_scope) = if origin.is_project_role() {
                let resource = self.scope.strip_prefix("project:").ok_or_else(invalid)?;
                let (project, module) = resource.split_once(':').unwrap_or((resource, ""));
                validate_rule_id(project)?;
                // Module names must be present when the separator is present.
                if resource.ends_with(':') {
                    return Err(invalid());
                }
                (project, module)
            } else {
                (origin.name(), self.scope.as_str())
            };
            let valid = areas.iter().any(|(scope, facet, actions)| {
                *scope == relative_scope && *facet == self.facet && *actions == self.actions
            });
            if !valid {
                return Err(invalid());
            }
            return Ok(Some(RoleBinding {
                origin,
                group,
                expected: areas.len(),
            }));
        }
        let personnel_read = self.facet == Facet::Scope
            && self.actions.iter().all(|action| *action == Action::Read)
            && self.scope.starts_with("personnel:");
        let scope_prefix = if personnel_read {
            "personnel:"
        } else {
            "absence:"
        };
        let target = self.scope.strip_prefix(scope_prefix).ok_or_else(invalid)?;
        validate_rule_id(target)?;
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
        Ok(None)
    }
}

fn validate_rule_id(value: &str) -> RpcResult<()> {
    let id = crate::ids::Id::decode(value).map_err(|_| invalid())?;
    if id.0 <= 0 || id.encode() != value {
        return Err(invalid());
    }
    Ok(())
}

struct RoleBinding<'a> {
    origin: RuleOrigin,
    group: &'a str,
    expected: usize,
}

fn validate_rule_origins(rules: &[Rule]) -> RpcResult<()> {
    let mut assignments = HashMap::<_, (RoleBinding<'_>, HashSet<_>)>::new();
    for rule in rules {
        if let Some(binding) = rule.validate_application_origin()? {
            let origin = binding.origin;
            let (first, actual) = assignments
                .entry((&rule.subject, binding.group))
                .or_insert_with(|| (binding, HashSet::new()));
            if first.origin != origin || !actual.insert((&rule.scope, rule.facet.name())) {
                return Err(invalid());
            }
        }
    }
    if assignments
        .values()
        .any(|(binding, actual)| actual.len() != binding.expected)
    {
        return Err(invalid());
    }
    Ok(())
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
                    continuation: value.continuation.as_deref(),
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
        validate_rule_origins(&self.rules)?;
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

    pub fn continues(&self, previous: &Self, binding: &str) -> RpcResult<bool> {
        self.as_protocol()
            .continues(&previous.as_protocol(), &previous.signature, binding)
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
                continuation: None,
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
