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
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        super::crypto::identifier(&self.tenant)?;
        super::crypto::identifier(&self.id)?;
        revision(&self.generation)?;
        self.creation_scope()?;
        if self.readers.is_empty() || self.readers.len() > 8 {
            return Err(invalid());
        }
        let mut seen = HashSet::new();
        for reader in &self.readers {
            if !seen.insert(&reader.user) {
                return Err(invalid());
            }
        }
        let mut hashes = Vec::new();
        for member in std::iter::once(&self.creator).chain(&self.readers) {
            if member.tenant != self.tenant || member.generation != self.generation {
                return Err(invalid());
            }
            hashes.push(packet_hash(member.frame()?, &member.signature)?);
        }
        let mut fields = vec![
            self.tenant.as_str(),
            self.id.as_str(),
            self.generation.as_str(),
            self.namespace.as_str(),
        ];
        fields.extend(hashes.iter().map(String::as_str));
        Ok(frame("sortsys/creation-capability/v1", &fields))
    }
    pub fn verify(&self, authority: &[u8]) -> RpcResult<()> {
        verify(authority, &self.signature, &self.frame()?)?;
        for member in std::iter::once(&self.creator).chain(&self.readers) {
            member.verify(authority)?;
        }
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
        Ok(frame(
            if self.parent.is_some() {
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
        subjects
            .into_iter()
            .map(|subject| Rule {
                origin: None,
                subject,
                scope: self.scope.clone(),
                facet: self.facet,
                actions: vec![Action::Read, Action::Create, Action::Update, Action::Delete],
                effect: Effect::Allow,
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
        transaction.all::<CreationOrigin>(&collection, 2000).await?
    };
    let mut visible = Vec::new();
    for origin in origins {
        if origin.tenant != auth.tenant || origin.capability.generation != generation.to_string() {
            return Err(invalid());
        }
        origin.verify(authority)?;
        let original_participant = origin.capability.creator.user == subject
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
        );
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
}
pub(super) fn creation_scope(namespace: &str) -> RpcResult<&'static str> {
    match namespace {
        "project" => Ok("create:project"),
        "commercial" => Ok("create:commercial"),
        "tool" => Ok("create:tool"),
        "tool-tracking" => Ok("create:tool-tracking"),
        _ => Err(invalid()),
    }
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Vec<CreationOrigin>>("zerotrust.creations.list")
        .query_stub::<OriginInput, Option<CreationOrigin>>("zerotrust.creations.origin")
        .query_stub::<CapabilityInput, Option<CreationCapability>>("zerotrust.creations.capability")
        .mutation_stub::<CreationCapability, Success>("zerotrust.creations.grant")
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
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
