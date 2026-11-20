//! Public, certified creation authority. No private tenant key is delegated.
use super::{
    crypto::{frame, invalid, revision, sized, verify},
    objects::packet_hash,
    wire::{Action, Effect, Facet, IdentityCertificate, Rule},
};
use crate::{
    api::Success, error::RpcResult, error::internal, ids::Id, rpc::ProcedureRegistryBuilder,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sortsys_zerotrust::resource_access::{ResourceCommand, ResourceCommandContext};
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};
use ts_rs::TS;

pub(super) const COMMERCIAL_FACETS: [Facet; 9] = [
    Facet::MasterData,
    Facet::Scope,
    Facet::ContractQuantities,
    Facet::Measurement,
    Facet::OfferPrices,
    Facet::Calculation,
    Facet::Procurement,
    Facet::Billing,
    Facet::Attachment,
];
pub(super) const TOOL_RETURN_PURPOSE: &str = "tool-return";
pub(super) const CREATION_SCOPES: [(&str, &str); 4] = [
    ("project", "create:project"),
    ("commercial", "create:commercial"),
    ("tool", "create:tool"),
    ("tool-tracking", "create:tool-tracking"),
];

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreationCapability {
    pub tenant: String,
    pub id: String,
    pub generation: String,
    pub namespace: String,
    pub creator: IdentityCertificate,
    pub readers: Vec<IdentityCertificate>,
    pub signature: String,
}
impl CreationCapability {
    pub fn creation_scope(&self) -> RpcResult<&'static str> {
        creation_scope(&self.namespace)
    }
    fn as_protocol(&self) -> sortsys_zerotrust::delegations::DelegationRef<'_> {
        sortsys_zerotrust::delegations::DelegationRef {
            tenant: &self.tenant,
            id: &self.id,
            generation: &self.generation,
            namespace: &self.namespace,
            creator: &self.creator,
            readers: &self.readers,
            signature: &self.signature,
        }
    }
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        self.creation_scope()?;
        Ok(self.as_protocol().frame()?)
    }
    pub fn verify(&self, authority: &[u8]) -> RpcResult<()> {
        self.creation_scope()?;
        self.as_protocol().verify(
            &sortsys_zerotrust::delegations::DelegationContext {
                tenant: &self.tenant,
                generation: &self.generation,
                namespace: &self.namespace,
                creator: &self.creator.user,
            },
            authority,
        )?;
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreationOrigin {
    pub tenant: String,
    pub id: String,
    pub scope: String,
    pub facet: Facet,
    pub capability: CreationCapability,
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent: Option<CreationParent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub assignee: Option<IdentityCertificate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub access: Option<sortsys_zerotrust::resource_access::ResourceAccessState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub returned: Option<ResourceCommand>,
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreationParent {
    pub tenant: String,
    pub id: String,
    pub scope: String,
    pub facet: Facet,
    pub capability: CreationCapability,
    pub signature: String,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreationRenewalInput {
    pub origins: Vec<CreationOrigin>,
    pub object: String,
    pub revision: String,
    pub packet_signature: String,
    pub proof: String,
}
impl CreationRenewalInput {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        if self.origins.len() != 2 {
            return Err(invalid());
        }
        let master = &self.origins[0];
        if master.capability.namespace != "tool-tracking"
            || self.object != format!("{}:master-data:record", master.scope)
        {
            return Err(invalid());
        }
        revision(&self.revision)?;
        sized::<64>(&self.packet_signature)?;
        let mut hashes = Vec::new();
        for (origin, facet) in self.origins.iter().zip([Facet::MasterData, Facet::Scope]) {
            if origin.tenant != master.tenant
                || origin.scope != master.scope
                || origin.facet != facet
                || origin.capability.signature != master.capability.signature
                || origin.assignee.is_some()
                || origin.access.is_some()
                || origin.returned.is_some()
                || origin.parent.is_some()
            {
                return Err(invalid());
            }
            hashes.push(packet_hash(origin.frame()?, &origin.signature)?);
        }
        Ok(frame(
            "sortsys/created-booking-renewal/v1",
            &[
                &master.tenant,
                &master.capability.generation,
                &master.scope,
                &self.object,
                &self.revision,
                &self.packet_signature,
                &hashes[0],
                &hashes[1],
            ],
        ))
    }
}
impl CreationParent {
    fn origin(&self) -> CreationOrigin {
        CreationOrigin {
            tenant: self.tenant.clone(),
            id: self.id.clone(),
            scope: self.scope.clone(),
            facet: self.facet,
            capability: self.capability.clone(),
            signature: self.signature.clone(),
            parent: None,
            assignee: None,
            access: None,
            returned: None,
        }
    }
}
pub(super) fn project_module_facets(module: &str) -> Option<&'static [Facet]> {
    match module {
        "delivery-notes" => Some(&[Facet::MasterData, Facet::Procurement]),
        "daily-reports" => Some(&[Facet::MasterData, Facet::Calculation]),
        "regie-reports" => Some(&[Facet::MasterData, Facet::Personnel]),
        "planning" => Some(&[Facet::MasterData]),
        "tool-usage" => Some(&[Facet::MasterData, Facet::Procurement]),
        _ => None,
    }
}

/// Allocating keys does not publish a business resource. Its canonical first
/// record still needs the current namespace grant at the atomic write boundary.
pub(super) fn initial_record_creation_scope(
    scope: &str,
    facet: Facet,
    object: &str,
) -> Option<&'static str> {
    if facet != Facet::MasterData {
        return None;
    }
    let (namespace, token) = scope.split_once(':')?;
    let id = Id::decode(token).ok()?;
    if id.0 <= 0 || id.encode() != token {
        return None;
    }
    if namespace == "tool" && object == format!("{scope}:master-data:booking") {
        return creation_scope(namespace).ok();
    }
    let expected = match namespace {
        "project" => scope.to_owned(),
        "commercial" => format!("{scope}:master-data:case"),
        "tool" | "tool-tracking" => format!("{scope}:master-data:record"),
        _ => return None,
    };
    if object != expected {
        return None;
    }
    creation_scope(namespace).ok()
}

impl CreationOrigin {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        let prefix = format!("{}:", self.capability.namespace);
        let resource = self.scope.strip_prefix(&prefix).ok_or_else(invalid)?;
        let mut parts = resource.split(':');
        let token = parts.next().ok_or_else(invalid)?;
        let module = parts.next();
        if parts.next().is_some() || module.is_some() && self.capability.namespace != "project" {
            return Err(invalid());
        }
        let id = Id::decode(token).map_err(|_| invalid())?;
        let allowed_facet = if let Some(module) = module {
            project_module_facets(module).is_some_and(|facets| facets.contains(&self.facet))
        } else {
            match self.capability.namespace.as_str() {
                "project" => matches!(
                    self.facet,
                    Facet::MasterData
                        | Facet::Attachment
                        | Facet::OfferPrices
                        | Facet::Procurement
                        | Facet::Billing
                ),
                "commercial" => COMMERCIAL_FACETS.contains(&self.facet),
                "tool" => matches!(
                    self.facet,
                    Facet::MasterData | Facet::Procurement | Facet::Measurement
                ),
                "tool-tracking" => matches!(
                    self.facet,
                    Facet::MasterData | Facet::Procurement | Facet::Scope
                ),
                _ => false,
            }
        };
        if id.0 <= 0
            || id.encode() != token
            || self.tenant != self.capability.tenant
            || !allowed_facet
            || self.id != format!("{}:{}", self.scope, self.facet.name())
            || module.is_some() != self.parent.is_some()
        {
            return Err(invalid());
        }
        let hash = packet_hash(self.capability.frame()?, &self.capability.signature)?;
        let mut fields = vec![
            self.tenant.clone(),
            self.id.clone(),
            self.scope.clone(),
            self.facet.name().to_owned(),
            hash,
        ];
        if let Some(parent) = &self.parent {
            let origin = parent.origin();
            if parent.tenant != self.tenant
                || parent.scope != format!("project:{token}")
                || parent.id != format!("{}:master-data", parent.scope)
                || parent.facet != Facet::MasterData
                || parent.capability.generation != self.capability.generation
                || parent.capability.creator.user != self.capability.creator.user
                || parent.capability.creator.signing_key != self.capability.creator.signing_key
                || parent.capability.creator.encryption_key
                    != self.capability.creator.encryption_key
            {
                return Err(invalid());
            }
            fields.push(packet_hash(origin.frame()?, &parent.signature)?);
        }
        if let Some(assignee) = &self.assignee {
            if self.capability.namespace != "tool-tracking"
                || !matches!(self.facet, Facet::MasterData | Facet::Scope)
                || assignee.tenant != self.tenant
                || assignee.generation != self.capability.generation
                || std::iter::once(&self.capability.creator)
                    .chain(&self.capability.readers)
                    .any(|member| member.user == assignee.user)
            {
                return Err(invalid());
            }
            fields.push(packet_hash(assignee.frame()?, &assignee.signature)?);
        } else if self.access.is_some()
            && (self.capability.namespace != "tool-tracking"
                || !matches!(self.facet, Facet::MasterData | Facet::Scope))
        {
            return Err(invalid());
        }
        Ok(frame(
            if self.assignee.is_some() {
                "sortsys/created-area-assignee/v1"
            } else if self.parent.is_some() {
                "sortsys/created-area/v2"
            } else {
                "sortsys/created-area/v1"
            },
            &fields.iter().map(String::as_str).collect::<Vec<_>>(),
        ))
    }
    pub fn author(&self) -> String {
        format!(
            "creator:{}:{}",
            self.capability.creator.user, self.capability.generation
        )
    }
    pub fn verify(&self, authority: &[u8]) -> RpcResult<()> {
        let body = self.frame()?;
        if let Some(access) = &self.access {
            access.verify(
                &sortsys_zerotrust::resource_access::ResourceAccessContext {
                    tenant: &self.tenant,
                    resource: &self.scope,
                    object: &format!("{}:master-data:record", self.scope),
                    generation: &self.capability.generation,
                    binding: &self.resource_binding()?,
                },
                authority,
            )?;
        }
        if let Some(returned) = &self.returned {
            let access = self.access.as_ref().ok_or_else(invalid)?;
            let binding = access.command_binding.as_deref().ok_or_else(invalid)?;
            let command_revision = revision(&returned.revision)?;
            let access_revision = revision(&access.revision)?;
            let valid_revision = if access.active {
                command_revision == access_revision
            } else {
                command_revision < access_revision
            };
            if !valid_revision {
                return Err(invalid());
            }
            returned.verify(&ResourceCommandContext {
                tenant: &self.tenant,
                purpose: TOOL_RETURN_PURPOSE,
                binding,
            })?;
        }
        let mut hash = Sha256::new();
        hash.update(authority);
        hash.update(&body);
        hash.update(sized::<64>(&self.signature)?);
        let key: [u8; 32] = hash.finalize().into();
        static VERIFIED: OnceLock<Mutex<HashSet<[u8; 32]>>> = OnceLock::new();
        let cache = VERIFIED.get_or_init(|| Mutex::new(HashSet::new()));
        if cache.lock().map_err(internal)?.contains(&key) {
            return Ok(());
        }
        self.capability.verify(authority)?;
        if let Some(assignee) = &self.assignee {
            assignee.verify(authority)?;
        }
        if let Some(parent) = &self.parent {
            parent.origin().verify(authority)?;
        }
        verify(
            &sized::<32>(&self.capability.creator.signing_key)?,
            &self.signature,
            &body,
        )?;
        let mut cache = cache.lock().map_err(internal)?;
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(key);
        Ok(())
    }
    pub fn rules(&self) -> Vec<Rule> {
        let subjects: HashSet<_> = std::iter::once(&self.capability.creator)
            .chain(&self.capability.readers)
            .map(|member| member.user.clone())
            .collect();
        let mut rules: Vec<_> = subjects
            .into_iter()
            .map(|subject| Rule {
                origin: None,
                subject,
                scope: self.scope.clone(),
                facet: self.facet,
                actions: vec![Action::Read, Action::Create, Action::Update, Action::Delete],
                effect: Effect::Allow,
            })
            .collect();
        if let Some(assignee) = &self.assignee
            && self.is_active_booking()
        {
            rules.push(Rule {
                origin: None,
                subject: assignee.user.clone(),
                scope: self.scope.clone(),
                facet: self.facet,
                actions: vec![Action::Read],
                effect: Effect::Allow,
            });
        }
        rules
    }
    pub fn recipients(&self) -> Vec<&IdentityCertificate> {
        std::iter::once(&self.capability.creator)
            .chain(&self.capability.readers)
            .chain(self.assignee.iter())
            .collect()
    }
    pub fn is_active_booking(&self) -> bool {
        self.access.as_ref().is_some_and(|access| access.active) && self.returned.is_none()
    }
    pub fn assignment_binding(&self) -> RpcResult<String> {
        let assignee = self.assignee.as_ref().ok_or_else(invalid)?;
        Ok(super::crypto::encode(&Sha256::digest(frame(
            "sortsys/creation-assignment/v1",
            &[
                &self.tenant,
                &self.scope,
                &self.capability.signature,
                &assignee.signature,
            ],
        ))))
    }

    pub fn resource_binding(&self) -> RpcResult<String> {
        if self.assignee.is_some() {
            return self.assignment_binding();
        }
        if self.capability.namespace != "tool-tracking"
            || !matches!(self.facet, Facet::MasterData | Facet::Scope)
        {
            return Err(invalid());
        }
        Ok(super::crypto::encode(&Sha256::digest(frame(
            "sortsys/created-booking-state/v1",
            &[&self.tenant, &self.scope, &self.capability.signature],
        ))))
    }

    pub fn active_booking_rules(&self, policy: &super::wire::SignedPolicy) -> Vec<Rule> {
        if self.capability.namespace != "tool-tracking"
            || !matches!(self.facet, Facet::MasterData | Facet::Scope)
            || !self.is_active_booking()
        {
            return Vec::new();
        }
        let intent = format!("active-tool:{}", self.scope);
        let subjects: std::collections::BTreeSet<_> = policy
            .rules
            .iter()
            .filter(|rule| rule.scope == intent && rule.facet == self.facet)
            .map(|rule| rule.subject.clone())
            .collect();
        subjects
            .into_iter()
            .filter(|subject| policy.allows(subject, &intent, self.facet, Action::Read))
            .map(|subject| Rule {
                origin: None,
                subject,
                scope: self.scope.clone(),
                facet: self.facet,
                effect: Effect::Allow,
                actions: vec![Action::Read],
            })
            .collect()
    }
}

pub(super) async fn metadata_origins(
    transaction: &mut crate::control::Transaction,
    auth: &crate::auth::AuthResult,
    generation: i64,
    authority: &[u8],
    subject: &str,
    policy: &super::wire::SignedPolicy,
    domains: Option<&[String]>,
) -> RpcResult<Vec<CreationOrigin>> {
    let collection = format!("created-areas-{generation}");
    let origins = if let Some(domains) = domains {
        let keys = domains
            .iter()
            .map(|domain| crate::control::key(&collection, domain))
            .collect();
        let origins = transaction.many::<CreationOrigin>(keys).await?;
        let mut selected = Vec::new();
        for (domain, origin) in domains.iter().zip(origins) {
            if let Some(origin) = origin {
                if origin.id != *domain {
                    return Err(invalid());
                }
                selected.push(origin);
            }
        }
        selected
    } else {
        transaction
            .all::<CreationOrigin>(
                &collection,
                sortsys_zerotrust::recovery_inventory::DEFAULT_RECOVERY_LIMITS.domains as usize,
            )
            .await?
    };
    visible_origins(origins, auth, generation, authority, subject, policy)
}

/// Authorize the canonical origin records that the read transaction observed.
/// A catalogue scan and a targeted lookup share the same proof checks.
pub(super) fn visible_origins(
    origins: Vec<CreationOrigin>,
    auth: &crate::auth::AuthResult,
    generation: i64,
    authority: &[u8],
    subject: &str,
    policy: &super::wire::SignedPolicy,
) -> RpcResult<Vec<CreationOrigin>> {
    let mut visible = Vec::new();
    for origin in origins {
        if origin.tenant != auth.tenant || origin.capability.generation != generation.to_string() {
            return Err(invalid());
        }
        origin.verify(authority)?;
        let original_participant = origin.capability.creator.user == subject
            || origin
                .assignee
                .as_ref()
                .is_some_and(|assignee| assignee.user == subject)
            || origin
                .capability
                .readers
                .iter()
                .any(|reader| reader.user == subject);
        let currently_shared = policy.allows(
            subject,
            &origin.scope,
            origin.facet,
            super::wire::Action::Read,
        ) || origin
            .active_booking_rules(policy)
            .iter()
            .any(|rule| rule.subject == subject);
        // A later recipient needs the same public creation proof as the
        // original participants to derive the area's complete writer set.
        if auth.is_admin() || original_participant || currently_shared {
            visible.push(origin);
        }
    }
    Ok(visible)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct OriginInput {
    pub domain: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct CapabilityInput {
    #[ts(type = "'project'|'commercial'|'tool'|'tool-tracking'")]
    pub namespace: String,
    #[serde(default)]
    #[ts(optional)]
    pub subject: Option<String>,
}
pub(super) fn creation_scope(namespace: &str) -> RpcResult<&'static str> {
    CREATION_SCOPES
        .iter()
        .find_map(|&(name, scope)| (name == namespace).then_some(scope))
        .ok_or_else(invalid)
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Vec<CreationOrigin>>("zerotrust.creations.list")
        .query_stub::<OriginInput, Option<CreationOrigin>>("zerotrust.creations.origin")
        .query_stub::<CapabilityInput, Option<CreationCapability>>("zerotrust.creations.capability")
        .mutation_stub::<CreationCapability, Success>("zerotrust.creations.grant")
        .mutation_stub::<CreationRenewalInput, Success>("zerotrust.creations.renew")
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    #[test]
    fn canonical_resource_records_require_namespace_creation_only_in_master_data() {
        use super::{Facet, initial_record_creation_scope};
        for (scope, object, expected) in [
            ("project:abc", "project:abc", "create:project"),
            (
                "commercial:abc",
                "commercial:abc:master-data:case",
                "create:commercial",
            ),
            ("tool:abc", "tool:abc:master-data:record", "create:tool"),
            ("tool:abc", "tool:abc:master-data:booking", "create:tool"),
            (
                "tool-tracking:abc",
                "tool-tracking:abc:master-data:record",
                "create:tool-tracking",
            ),
        ] {
            assert_eq!(
                initial_record_creation_scope(scope, Facet::MasterData, object),
                Some(expected)
            );
            assert_eq!(
                initial_record_creation_scope(scope, Facet::Procurement, object),
                None
            );
            assert_eq!(
                initial_record_creation_scope(
                    scope,
                    Facet::MasterData,
                    &format!("{object}:receipt")
                ),
                None
            );
        }
        for scope in [
            "project:0",
            "project:0abc",
            "project:w",
            "project:abc:planning",
            "catalog:products",
        ] {
            assert_eq!(
                initial_record_creation_scope(scope, Facet::MasterData, scope),
                None
            );
        }
    }
    #[test]
    fn browser_tool_creation_proofs_bind_each_resource_without_expanding_other_capabilities() {
        let input: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-tool-creation.json"
        ))
        .unwrap();
        for vector in input["vectors"].as_array().unwrap() {
            let definition: super::super::objects::DomainDefinition =
                serde_json::from_value(vector["definition"].clone()).unwrap();
            let origin = definition.creation.unwrap();
            let authority =
                super::super::crypto::sized::<32>(vector["authority"].as_str().unwrap()).unwrap();
            origin.verify(&authority).unwrap();
            for scope in [
                "project:abc",
                "commercial:abc",
                "tool:def",
                "tool-tracking:def",
            ] {
                let mut changed = origin.clone();
                changed.scope = scope.into();
                changed.id = format!("{scope}:master-data");
                assert!(changed.verify(&authority).is_err());
            }
            let mut changed = origin.clone();
            changed.capability.namespace = "project".into();
            assert!(changed.verify(&authority).is_err());
            assert_eq!(
                origin.capability.creation_scope().unwrap(),
                format!("create:{}", origin.capability.namespace)
            );
        }
    }

    #[test]
    fn browser_tool_return_only_ends_the_derived_booking_grants() {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-tool-return.json"
        ))
        .unwrap();
        let mut origin: CreationOrigin = serde_json::from_value(source["origin"].clone()).unwrap();
        let authority = sized::<32>(source["authority"].as_str().unwrap()).unwrap();
        let active = serde_json::from_value(source["active"].clone()).unwrap();
        let closed = serde_json::from_value(source["closed"].clone()).unwrap();
        let returned: ResourceCommand = serde_json::from_value(source["returned"].clone()).unwrap();
        origin.access = Some(active);
        origin.verify(&authority).unwrap();
        assert!(origin.is_active_booking());
        let member = origin.assignee.as_ref().unwrap().user.clone();
        assert!(origin.rules().iter().any(|rule| rule.subject == member));

        let mut unbound = origin.clone();
        unbound.access = None;
        unbound.returned = Some(returned.clone());
        assert!(unbound.verify(&authority).is_err());

        origin.returned = Some(returned);
        origin.verify(&authority).unwrap();
        assert!(!origin.is_active_booking());
        assert!(!origin.rules().iter().any(|rule| rule.subject == member));
        assert!(origin.rules().iter().any(|rule| {
            rule.subject == origin.capability.creator.user && rule.actions.contains(&Action::Update)
        }));
        let mut substituted = origin.clone();
        substituted.returned.as_mut().unwrap().issued_at = "1795046400001".into();
        assert!(substituted.verify(&authority).is_err());

        origin.access = Some(closed);
        origin.verify(&authority).unwrap();
        assert!(!origin.is_active_booking());
    }
    use super::*;
    use crate::zerotrust::objects::DomainDefinition;

    #[test]
    fn browser_project_modules_bind_root_creator_and_isolate_each_business_area() {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-project-modules.json"
        ))
        .unwrap();
        let authority = sized::<32>(source["authority"].as_str().unwrap()).unwrap();
        let root: DomainDefinition = serde_json::from_value(source["root"].clone()).unwrap();
        let definitions = source["definitions"].as_array().unwrap();
        assert_eq!(definitions.len(), 9);
        for entry in definitions {
            let definition: DomainDefinition = serde_json::from_value(entry.clone()).unwrap();
            let origin = definition.creation.as_ref().unwrap();
            origin.verify(&authority).unwrap();
            let creator = sized::<32>(&origin.capability.creator.signing_key).unwrap();
            verify(&creator, &definition.proof, &definition.frame().unwrap()).unwrap();
            assert_eq!(
                serde_json::to_value(origin.parent.as_ref().unwrap()).unwrap(),
                serde_json::to_value(root.creation.as_ref().unwrap()).unwrap()
            );
            assert!(
                origin
                    .rules()
                    .iter()
                    .all(|rule| rule.scope == origin.scope && rule.facet == origin.facet)
            );
            for change in [
                "missing",
                "project",
                "creator",
                "generation",
                "facet",
                "signature",
                "module",
            ] {
                let mut changed = origin.clone();
                match change {
                    "missing" => changed.parent = None,
                    "project" => {
                        let parent = changed.parent.as_mut().unwrap();
                        parent.scope = "project:def".into();
                        parent.id = "project:def:master-data".into();
                    }
                    "creator" => {
                        changed.parent.as_mut().unwrap().capability.creator.user = "user:3".into()
                    }
                    "generation" => {
                        changed.parent.as_mut().unwrap().capability.generation = "2".into()
                    }
                    "facet" => changed.parent.as_mut().unwrap().facet = Facet::Attachment,
                    "signature" => {
                        changed.parent.as_mut().unwrap().signature =
                            super::super::crypto::encode(&[0; 64])
                    }
                    _ => {
                        changed.scope = "project:abc:unknown".into();
                        changed.id = format!("{}:{}", changed.scope, changed.facet.name());
                    }
                }
                assert!(changed.verify(&authority).is_err(), "{change}");
            }
            let mut nested = serde_json::to_value(origin).unwrap();
            nested["parent"]["parent"] = source["root"]["creation"].clone();
            assert!(serde_json::from_value::<CreationOrigin>(nested).is_err());
        }
        let mut root = root.creation.unwrap();
        root.parent = serde_json::from_value(definitions[0]["creation"]["parent"].clone()).unwrap();
        assert!(root.frame().is_err());
    }

    #[test]
    fn browser_creation_proof_binds_certified_members_and_the_fresh_project() {
        let source: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-creation.json"))
                .unwrap();
        let authority = sized::<32>(source["authority"].as_str().unwrap()).unwrap();
        let definition: DomainDefinition =
            serde_json::from_value(source["definition"].clone()).unwrap();
        let origin = definition.creation.as_ref().unwrap();
        origin.verify(&authority).unwrap();
        let creator = sized::<32>(&origin.capability.creator.signing_key).unwrap();
        verify(&creator, &definition.proof, &definition.frame().unwrap()).unwrap();
        for box_ in definition
            .envelopes
            .iter()
            .chain(std::iter::once(&definition.recovery_envelope))
        {
            box_.verify(&creator).unwrap();
            assert_eq!(box_.author, origin.author());
        }
        assert_eq!(origin.rules().len(), 2);
        for change in ["creator", "reader", "scope", "generation"] {
            let mut altered = origin.clone();
            match change {
                "creator" => altered.capability.creator.user = "user:3".into(),
                "reader" => altered.capability.readers.clear(),
                "scope" => {
                    altered.scope = "project:def".into();
                    altered.id = "project:def:master-data".into();
                }
                _ => altered.capability.generation = "2".into(),
            }
            assert!(altered.verify(&authority).is_err());
        }
    }

    #[test]
    fn creation_accepts_only_canonical_project_ids_and_declared_project_facets() {
        let source: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-creation.json"))
                .unwrap();
        let definition: DomainDefinition =
            serde_json::from_value(source["definition"].clone()).unwrap();
        for token in [
            "0",
            "0abc",
            "ABC",
            "8000000000000",
            "abc:calculation",
            "abc/",
        ] {
            let mut origin = definition.creation.clone().unwrap();
            origin.scope = format!("project:{token}");
            origin.id = format!("{}:master-data", origin.scope);
            assert!(origin.frame().is_err(), "{token}");
        }
        for facet in [
            Facet::MasterData,
            Facet::Attachment,
            Facet::OfferPrices,
            Facet::Procurement,
            Facet::ContractQuantities,
            Facet::Calculation,
            Facet::Personnel,
            Facet::Billing,
        ] {
            let mut origin = definition.creation.clone().unwrap();
            origin.facet = facet;
            origin.id = format!("{}:{}", origin.scope, facet.name());
            assert_eq!(
                origin.frame().is_ok(),
                matches!(
                    facet,
                    Facet::MasterData
                        | Facet::Attachment
                        | Facet::OfferPrices
                        | Facet::Procurement
                        | Facet::Billing
                )
            );
        }
    }

    #[test]
    fn browser_commercial_creation_cannot_escalate_to_projects_or_personnel() {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/zerotrust-commercial-creation.json"
        ))
        .unwrap();
        let authority = sized::<32>(source["authority"].as_str().unwrap()).unwrap();
        let definition: DomainDefinition =
            serde_json::from_value(source["definition"].clone()).unwrap();
        let origin = definition.creation.as_ref().unwrap();
        origin.verify(&authority).unwrap();
        assert_eq!(
            origin.capability.creation_scope().unwrap(),
            "create:commercial"
        );
        let signer = sized::<32>(&origin.capability.creator.signing_key).unwrap();
        verify(&signer, &definition.proof, &definition.frame().unwrap()).unwrap();
        for facet in [
            Facet::Scope,
            Facet::ContractQuantities,
            Facet::Measurement,
            Facet::OfferPrices,
            Facet::Calculation,
            Facet::Procurement,
            Facet::Billing,
            Facet::Attachment,
        ] {
            let mut changed = origin.clone();
            changed.facet = facet;
            changed.id = format!("{}:{}", changed.scope, facet.name());
            assert!(changed.frame().is_ok());
            assert!(
                changed.verify(&authority).is_err(),
                "Each facet needs its own signed origin"
            );
        }
        for (scope, facet) in [
            ("project:abc", Facet::MasterData),
            ("commercial:abc", Facet::Personnel),
        ] {
            let mut changed = origin.clone();
            changed.scope = scope.into();
            changed.facet = facet;
            changed.id = format!("{scope}:{}", facet.name());
            assert!(changed.frame().is_err());
        }
        let mut changed = origin.clone();
        changed.capability.namespace = "project".into();
        assert!(changed.verify(&authority).is_err());
    }
}
