//! Public, certified creation authority. No private tenant key is delegated.
use super::{
    access::{Security, security},
    crypto::{frame, invalid, revision, sized, verify},
    objects::packet_hash,
    wire::{Action, Effect, Facet, IdentityCertificate, Rule},
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    procedures::common::{authenticated_pool, forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, OnceLock},
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
}
impl CreationOrigin {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        let prefix = format!("{}:", self.capability.namespace);
        let token = self.scope.strip_prefix(&prefix).ok_or_else(invalid)?;
        let id = Id::decode(token).map_err(|_| invalid())?;
        let allowed_facet = match self.capability.namespace.as_str() {
            "project" => matches!(
                self.facet,
                Facet::MasterData
                    | Facet::Attachment
                    | Facet::OfferPrices
                    | Facet::Procurement
                    | Facet::ContractQuantities
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
        };
        if id.0 <= 0
            || id.encode() != token
            || self.tenant != self.capability.tenant
            || !allowed_facet
            || self.id != format!("{}:{}", self.scope, self.facet.name())
        {
            return Err(invalid());
        }
        let hash = packet_hash(self.capability.frame()?, &self.capability.signature)?;
        Ok(frame(
            "sortsys/created-area/v1",
            &[
                &self.tenant,
                &self.id,
                &self.scope,
                self.facet.name(),
                &hash,
            ],
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
                subject,
                scope: self.scope.clone(),
                facet: self.facet,
                actions: vec![Action::Read, Action::Create, Action::Update, Action::Delete],
                effect: Effect::Allow,
            })
            .collect()
    }
}
pub(super) async fn origins(
    tx: &mut PgConnection,
    tenant: &str,
    generation: i64,
    authority: &[u8],
    subject: &str,
    admin: bool,
) -> RpcResult<Vec<CreationOrigin>> {
    let rows:Vec<(String,Value)>=sqlx::query_as("SELECT domain_id,origin FROM __zerotrust_created_areas WHERE root_generation=$1 AND ($2 OR creator=$3 OR $3=ANY(readers)) ORDER BY domain_id LIMIT 2001")
        .bind(generation).bind(admin).bind(subject).fetch_all(tx).await.map_err(internal)?;
    if rows.len() > 2000 {
        return Err(invalid());
    }
    rows.into_iter()
        .map(|(id, value)| {
            let origin: CreationOrigin = serde_json::from_value(value).map_err(|_| invalid())?;
            if origin.id != id
                || origin.tenant != tenant
                || origin.capability.generation != generation.to_string()
            {
                return Err(invalid());
            }
            origin.verify(authority)?;
            Ok(origin)
        })
        .collect()
}
pub(super) async fn check_member(
    tx: &mut PgConnection,
    member: &IdentityCertificate,
    guard: &Security,
) -> RpcResult<()> {
    member.verify(&guard.authority)?;
    if member.tenant != guard.policy.tenant
        || member.generation != guard.root.generation.to_string()
    {
        return Err(forbidden());
    }
    let user = Id::decode(member.user.strip_prefix("user:").ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let current:Option<(Vec<u8>,Vec<u8>)>=sqlx::query_as("SELECT a.encryption_key,a.signing_key FROM __zerotrust_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND u.deactivated_at IS NULL")
        .bind(user).fetch_optional(tx).await.map_err(internal)?;
    if current
        != Some((
            sized::<32>(&member.encryption_key)?.to_vec(),
            sized::<32>(&member.signing_key)?.to_vec(),
        ))
    {
        return Err(forbidden());
    }
    Ok(())
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct OriginInput {
    domain: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CapabilityInput {
    #[ts(type = "'project'|'commercial'|'tool'|'tool-tracking'")]
    namespace: String,
}
fn creation_scope(namespace: &str) -> RpcResult<&'static str> {
    match namespace {
        "project" => Ok("create:project"),
        "commercial" => Ok("create:commercial"),
        "tool" => Ok("create:tool"),
        "tool-tracking" => Ok("create:tool-tracking"),
        _ => Err(invalid()),
    }
}
pub(super) fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list = Arc::clone(&state);
    builder = builder.query("zerotrust.creations.list", move |ctx, _: ()| {
        let state = Arc::clone(&list);
        async move {
            let (auth, pool) = authenticated_pool(&state, &ctx).await?;
            let mut tx = pool.begin().await.map_err(internal)?;
            Ok(security(&mut tx, state.tenants.master(), &auth, false)
                .await?
                .origins)
        }
    });
    let get = Arc::clone(&state);
    builder = builder.query(
        "zerotrust.creations.origin",
        move |ctx, input: OriginInput| {
            let state = Arc::clone(&get);
            async move {
                let (auth, pool) = authenticated_pool(&state, &ctx).await?;
                let mut tx = pool.begin().await.map_err(internal)?;
                let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
                let area: Option<(String, String)> =
                    sqlx::query_as("SELECT scope,facet FROM __zerotrust_domains WHERE id=$1")
                        .bind(&input.domain)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(internal)?;
                let (scope, facet) = area.ok_or_else(forbidden)?;
                let facet: Facet =
                    serde_json::from_value(Value::String(facet)).map_err(|_| invalid())?;
                if !auth.is_admin() && !guard.allows(&guard.subject, &scope, facet, Action::Read) {
                    return Err(forbidden());
                }
                Ok(guard
                    .origins
                    .into_iter()
                    .find(|origin| origin.id == input.domain))
            }
        },
    );
    let cap = Arc::clone(&state);
    builder=builder.query("zerotrust.creations.capability",move|ctx,input:CapabilityInput| {let state=Arc::clone(&cap);async move {
        let scope=creation_scope(&input.namespace)?;
        let(auth,pool)=authenticated_pool(&state,&ctx).await?;let mut tx=pool.begin().await.map_err(internal)?;
        let guard=security(&mut tx,state.tenants.master(),&auth,false).await?;
        if !guard.policy.allows(&guard.subject,scope,Facet::MasterData,Action::Create) {return Ok(None);}
        let value:Option<Value>=sqlx::query_scalar("SELECT capability FROM __zerotrust_creation_capabilities WHERE user_id=$1 AND generation=$2 AND namespace=$3")
            .bind(auth.user.id.parse::<i64>().map_err(internal)?).bind(guard.root.generation).bind(&input.namespace).fetch_optional(&mut *tx).await.map_err(internal)?;
        let Some(value)=value else {return Ok(None)};
        let cap:CreationCapability=serde_json::from_value(value).map_err(|_|invalid())?;cap.verify(&guard.authority)?;
        if cap.tenant!=auth.tenant || cap.creator.user!=guard.subject || cap.generation!=guard.root.generation.to_string() || cap.namespace!=input.namespace {return Err(forbidden());}
        check_member(&mut tx,&cap.creator,&guard).await?; Ok(Some(cap))
    }});
    builder.mutation("zerotrust.creations.grant",move|ctx:RequestContext,input:CreationCapability| {let state=Arc::clone(&state);async move {
        let(auth,pool)=authenticated_pool(&state,&ctx).await?;if !auth.is_admin() {return Err(forbidden());}
        let mut tx=pool.begin().await.map_err(internal)?;let guard=security(&mut tx,state.tenants.master(),&auth,true).await?;
        input.verify(&guard.authority)?;
        if input.tenant!=auth.tenant || input.generation!=guard.root.generation.to_string() {return Err(invalid());}
        for member in std::iter::once(&input.creator).chain(&input.readers) {check_member(&mut tx,member,&guard).await?;}
        let user=Id::decode(input.creator.user.strip_prefix("user:").ok_or_else(invalid)?).map_err(|_|invalid())?;
        sqlx::query("INSERT INTO __zerotrust_creation_capabilities(user_id,namespace,generation,capability) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,namespace) DO UPDATE SET generation=EXCLUDED.generation,capability=EXCLUDED.capability")
            .bind(user).bind(&input.namespace).bind(guard.root.generation).bind(serde_json::to_value(&input).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
        sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)").bind(serde_json::json!({"kind":"policy","version":guard.root.policy_version.to_string()}).to_string()).execute(&mut *tx).await.map_err(internal)?;
        tx.commit().await.map_err(internal)?; Ok(Success{success:true})
    }})
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
                        | Facet::ContractQuantities
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
