use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use std::sync::Arc;
use ts_rs::TS;

use super::{
    access::{Security, security},
    crypto::{encode, frame, identifier, invalid, revision, sized, verify},
    wire::{
        Action, AuthorityCertificate, EncryptedObject, Facet, IdentityCertificate, SealedBox,
        SignedPolicy,
    },
};
use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    procedures::common::{authenticated_pool, forbidden, internal, not_found},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub(super) fn conflict() -> RpcError {
    RpcError::new(
        ErrorCode::Conflict,
        "Protected data changed; reload the current version",
    )
    .with_http_code(409)
}
pub(super) fn packet_hash(message: Vec<u8>, signature: &str) -> RpcResult<String> {
    sized::<64>(signature)?;
    Ok(encode(&Sha256::digest(frame(
        "sortsys/signed-packet/v1",
        &[&encode(&message), signature],
    ))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CipherReference {
    format: String,
    id: String,
}

fn storage_unavailable() -> RpcError {
    RpcError::new(
        ErrorCode::InternalServerError,
        "Encrypted storage is unavailable",
    )
    .with_http_code(503)
}
fn storage_failure(error: crate::quack_store::StoreError) -> RpcError {
    // StoreError contains only fixed operation labels, never native SQL,
    // service credentials, ciphertext bodies or decrypted business content.
    tracing::warn!(error = %error, "Ciphertext storage request failed");
    storage_unavailable()
}
pub(super) fn envelope_reference(envelope: &EncryptedObject) -> RpcResult<Value> {
    let data = serde_json::to_value(envelope)
        .map_err(internal)?
        .to_string();
    Ok(
        serde_json::json!({"format":"sortsys-quack-ref-v1","id":crate::quack_store::content_id(&data)}),
    )
}
pub(super) async fn persist_envelope(
    state: &AppState,
    tenant: &str,
    envelope: &EncryptedObject,
) -> RpcResult<()> {
    let store = state.ciphertexts.as_ref().ok_or_else(storage_unavailable)?;
    let data = serde_json::to_value(envelope)
        .map_err(internal)?
        .to_string();
    store.put(tenant, data).await.map_err(storage_failure)?;
    Ok(())
}
pub(super) async fn read_envelope(
    state: &AppState,
    tenant: &str,
    reference: Value,
) -> RpcResult<EncryptedObject> {
    let reference: CipherReference = serde_json::from_value(reference).map_err(|_| invalid())?;
    if reference.format != "sortsys-quack-ref-v1" {
        return Err(invalid());
    }
    let store = state.ciphertexts.as_ref().ok_or_else(storage_unavailable)?;
    let data = store
        .get(tenant, &reference.id)
        .await
        .map_err(storage_failure)?;
    let envelope: EncryptedObject = serde_json::from_str(&data).map_err(|_| invalid())?;
    envelope.frame()?;
    Ok(envelope)
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DomainDefinition {
    pub tenant: String,
    pub id: String,
    pub scope: String,
    pub facet: Facet,
    pub generation: String,
    pub policy_version: String,
    pub envelopes: Vec<SealedBox>,
    pub recovery_envelope: SealedBox,
    pub proof: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub creation: Option<super::creation::CreationOrigin>,
}
impl DomainDefinition {
    pub fn frame(&self) -> RpcResult<Vec<u8>> {
        for id in [&self.tenant, &self.id, &self.scope] {
            identifier(id)?;
        }
        revision(&self.generation)?;
        revision(&self.policy_version)?;
        if self.envelopes.len() > 10000 {
            return Err(invalid());
        }
        let mut recipients = std::collections::HashSet::new();
        let mut hashes = Vec::new();
        for box_ in self
            .envelopes
            .iter()
            .chain(std::iter::once(&self.recovery_envelope))
        {
            if !recipients.insert(&box_.recipient) {
                return Err(invalid());
            }
            hashes.push(packet_hash(box_.frame()?, &box_.signature)?);
        }
        let mut values = vec![
            self.tenant.as_str(),
            self.id.as_str(),
            self.scope.as_str(),
            self.facet.name(),
            self.generation.as_str(),
            self.policy_version.as_str(),
        ];
        if let Some(origin) = &self.creation {
            if self.generation != "1"
                || origin.tenant != self.tenant
                || origin.id != self.id
                || origin.scope != self.scope
                || origin.facet != self.facet
            {
                return Err(invalid());
            }
            hashes.push(packet_hash(origin.frame()?, &origin.signature)?);
        }
        values.extend(hashes.iter().map(String::as_str));
        Ok(frame(
            if self.creation.is_some() {
                "sortsys/domain-created/v1"
            } else {
                "sortsys/domain/v1"
            },
            &values,
        ))
    }
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct IdInput {
    id: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyInput {
    domain: String,
    generation: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyGrant {
    domain: String,
    generation: String,
    envelope: SealedBox,
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SaveInput {
    pub domain: String,
    pub message_id: String,
    pub envelope: EncryptedObject,
    #[ts(optional)]
    pub references: Option<super::stock::StockReferences>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct BatchInput {
    pub objects: Vec<SaveInput>,
    #[ts(optional)]
    pub heads: Option<Vec<DomainHead>>,
    #[ts(optional)]
    pub documents: Option<Vec<super::documents::DocumentHead>>,
}
#[derive(Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct DomainHead {
    domain: String,
    sequence: String,
}
#[derive(Serialize, TS)]
pub(super) struct BatchResult {
    success: bool,
    heads: Vec<DomainHead>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ListInput {
    domain: String,
    prefix: String,
    after: Option<String>,
    snapshot: Option<String>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ObjectPage {
    snapshot: String,
    key_generation: String,
    objects: Vec<EncryptedObject>,
    after: Option<String>,
}
#[derive(Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
struct DomainInfo {
    id: String,
    scope: String,
    facet: String,
    generation: String,
    rotation_required: bool,
}
#[derive(FromRow)]
struct DomainRow {
    scope: String,
    facet: String,
    generation: i64,
    rotation_required: bool,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct IdentityInfo {
    subject: String,
    encryption_key: String,
    signing_key: String,
    certificate: Value,
}

#[derive(Serialize, TS)]
pub(super) struct AuthorityHistory {
    certificate: AuthorityCertificate,
    transition: Option<Value>,
}
#[derive(Serialize, TS)]
pub(super) struct TrustHistory {
    authorities: Vec<AuthorityHistory>,
    identities: Vec<IdentityCertificate>,
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let policy_get = Arc::clone(&state);
    let policy_set = Arc::clone(&state);
    let domains = Arc::clone(&state);
    let domain_set = Arc::clone(&state);
    let keys = Arc::clone(&state);
    let key_grant = Arc::clone(&state);
    let definitions = Arc::clone(&state);
    let save = Arc::clone(&state);
    let batch = Arc::clone(&state);
    let list = Arc::clone(&state);
    let get = Arc::clone(&state);
    let directory = Arc::clone(&state);
    let certify = Arc::clone(&state);
    let trust = Arc::clone(&state);
    builder.query("zerotrust.policy.get",move|ctx,_:()|{let state=Arc::clone(&policy_get);async move{let(auth,pool)=authenticated_pool(&state,&ctx).await?;let mut tx=pool.begin().await.map_err(internal)?;Ok(security(&mut tx,state.tenants.master(),&auth,false).await?.policy)}})
        .mutation("zerotrust.policy.replace",move|ctx,input:SignedPolicy|{let state=Arc::clone(&policy_set);async move{replace_policy(&state,&ctx,input).await}})
        .query("zerotrust.domains.list",move|ctx,_:()|{let state=Arc::clone(&domains);async move{let(auth,pool)=authenticated_pool(&state,&ctx).await?;let mut tx=pool.begin().await.map_err(internal)?;let guard=security(&mut tx,state.tenants.master(),&auth,false).await?;let rows=sqlx::query_as::<_,DomainInfo>("SELECT id,scope,facet,generation::text,rotation_required FROM __zerotrust_domains ORDER BY id").fetch_all(&mut *tx).await.map_err(internal)?;Ok(rows.into_iter().filter(|row|auth.is_admin() || facet(&row.facet).is_ok_and(|f|guard.allows(&guard.subject,&row.scope,f,Action::Read))).collect::<Vec<_>>())}})
        .mutation("zerotrust.domains.put",move|ctx,input:DomainDefinition|{let state=Arc::clone(&domain_set);async move{put_domain(&state,&ctx,input).await}})
        .query("zerotrust.keys.get",move|ctx,input:KeyInput|{let state=Arc::clone(&keys);async move{get_key(&state,&ctx,input).await}})
        .mutation("zerotrust.keys.grant",move|ctx,input:KeyGrant|{let state=Arc::clone(&key_grant);async move{grant_key(&state,&ctx,input).await}})
        .query("zerotrust.domains.get",move|ctx,input:KeyInput|{let state=Arc::clone(&definitions);async move{get_definition(&state,&ctx,input).await}})
        .mutation("zerotrust.objects.save",move|ctx,input:SaveInput|{let state=Arc::clone(&save);async move{save_object(&state,&ctx,input).await}})
        .mutation("zerotrust.objects.batch",move|ctx,input:BatchInput|{let state=Arc::clone(&batch);async move{save_batch(&state,&ctx,input).await}})
        .query("zerotrust.objects.list",move|ctx,input:ListInput|{let state=Arc::clone(&list);async move{list_objects(&state,&ctx,input).await}})
        .query("zerotrust.objects.get",move|ctx,input:IdInput|{let state=Arc::clone(&get);async move{get_object(&state,&ctx,input).await}})
        .query("zerotrust.identities.list",move|ctx,_:()|{let state=Arc::clone(&directory);async move{identities(&state,&ctx).await}})
        .mutation("zerotrust.identities.certify",move|ctx,input:IdentityCertificate|{let state=Arc::clone(&certify);async move{certify_identity(&state,&ctx,input).await}})
        .query("zerotrust.trust.history",move|ctx,_:()|{let state=Arc::clone(&trust);async move{trust_history(&state,&ctx).await}})
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), SignedPolicy>("zerotrust.policy.get")
        .mutation_stub::<SignedPolicy, Success>("zerotrust.policy.replace")
        .query_stub::<(), Vec<DomainInfo>>("zerotrust.domains.list")
        .mutation_stub::<DomainDefinition, Success>("zerotrust.domains.put")
        .query_stub::<KeyInput, SealedBox>("zerotrust.keys.get")
        .mutation_stub::<KeyGrant, Success>("zerotrust.keys.grant")
        .query_stub::<KeyInput, DomainDefinition>("zerotrust.domains.get")
        .mutation_stub::<SaveInput, Success>("zerotrust.objects.save")
        .mutation_stub::<BatchInput, BatchResult>("zerotrust.objects.batch")
        .query_stub::<ListInput, ObjectPage>("zerotrust.objects.list")
        .query_stub::<IdInput, EncryptedObject>("zerotrust.objects.get")
        .query_stub::<(), Vec<IdentityInfo>>("zerotrust.identities.list")
        .mutation_stub::<IdentityCertificate, Success>("zerotrust.identities.certify")
        .query_stub::<(), TrustHistory>("zerotrust.trust.history")
}

async fn trust_history(state: &AppState, ctx: &RequestContext) -> RpcResult<TrustHistory> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    security(&mut tx, state.tenants.master(), &auth, false).await?;
    load_history(&mut tx, true).await
}

pub(super) async fn load_history(
    tx: &mut sqlx::PgConnection,
    include_identities: bool,
) -> RpcResult<TrustHistory> {
    let authorities: Vec<(Value, Option<Value>)> = sqlx::query_as(
        "SELECT certificate,transition FROM __zerotrust_authorities ORDER BY generation LIMIT 10001",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(internal)?;
    let identities: Vec<Value> = if include_identities {
        sqlx::query_scalar("SELECT certificate FROM __zerotrust_identity_history ORDER BY generation,subject,signing_key LIMIT 10001").fetch_all(&mut *tx).await.map_err(internal)?
    } else {
        Vec::new()
    };
    if authorities.len() > 10000 || identities.len() > 10000 {
        return Err(conflict());
    }
    let authorities=authorities.into_iter().map(|(certificate,transition)|Ok(AuthorityHistory{
        certificate:serde_json::from_value(certificate).map_err(|_|invalid())?,
        transition:transition.map(|plan|serde_json::json!({"sourceAuthority":plan["sourceAuthority"],"transition":plan["transition"],"proof":plan["proof"],"nextProof":plan["nextProof"]})),
    })).collect::<RpcResult<_>>()?;
    Ok(TrustHistory {
        authorities,
        identities: identities
            .into_iter()
            .map(|c| serde_json::from_value(c).map_err(|_| invalid()))
            .collect::<RpcResult<_>>()?,
    })
}
fn facet(input: &str) -> RpcResult<Facet> {
    serde_json::from_value(Value::String(input.into())).map_err(|_| invalid())
}

async fn identities(state: &AppState, ctx: &RequestContext) -> RpcResult<Vec<IdentityInfo>> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let rows:Vec<(i64,Vec<u8>,Vec<u8>,Value)>=sqlx::query_as("SELECT user_id,encryption_key,signing_key,identity_certificate FROM __zerotrust_accounts ORDER BY user_id").fetch_all(&pool).await.map_err(internal)?;
    Ok(rows
        .into_iter()
        .map(|(id, encryption, signing, certificate)| IdentityInfo {
            subject: format!("user:{}", Id(id).encode()),
            encryption_key: encode(&encryption),
            signing_key: encode(&signing),
            certificate,
        })
        .collect())
}

async fn certify_identity(
    state: &AppState,
    ctx: &RequestContext,
    input: IdentityCertificate,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    input.verify(&guard.authority)?;
    if input.tenant != auth.tenant || input.generation != guard.root.generation.to_string() {
        return Err(invalid());
    }
    let id =
        Id::decode(input.user.strip_prefix("user:").ok_or_else(invalid)?).map_err(|_| invalid())?;
    let current: Option<(Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT encryption_key,signing_key FROM __zerotrust_accounts WHERE user_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    if current
        != Some((
            sized::<32>(&input.encryption_key)?.to_vec(),
            sized::<32>(&input.signing_key)?.to_vec(),
        ))
    {
        return Err(invalid());
    }
    let cert = serde_json::to_value(&input).map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_accounts SET identity_certificate=$1 WHERE user_id=$2")
        .bind(&cert)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_identity_history(subject,generation,signing_key,certificate) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING").bind(&input.user).bind(guard.root.generation).bind(sized::<32>(&input.signing_key)?.to_vec()).bind(cert).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}

/// Precompute effective readers once per policy, preserving deny precedence.
/// Policy changes must not repeatedly scan every rule for every member/domain.
type ReaderSets = std::collections::HashMap<(String, String), std::collections::HashSet<String>>;
fn policy_readers<'a>(rules: impl Iterator<Item = &'a super::wire::Rule>) -> ReaderSets {
    let mut allowed = std::collections::HashMap::<_, std::collections::HashSet<String>>::new();
    let mut denied = std::collections::HashMap::<_, std::collections::HashSet<String>>::new();
    for rule in rules {
        if !rule.actions.contains(&Action::Read) {
            continue;
        }
        let target = if rule.effect == super::wire::Effect::Deny {
            &mut denied
        } else {
            &mut allowed
        };
        target
            .entry((rule.scope.clone(), rule.facet.name().to_owned()))
            .or_default()
            .insert(rule.subject.clone());
    }
    for (scope, subjects) in denied {
        if let Some(readers) = allowed.get_mut(&scope) {
            readers.retain(|subject| !subjects.contains(subject));
        }
    }
    allowed
}

async fn replace_policy(
    state: &AppState,
    ctx: &RequestContext,
    input: SignedPolicy,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    input.verify(&guard.authority)?;
    let next = revision(&input.version)?;
    if input.tenant != auth.tenant || guard.root.policy_version.checked_add(1) != Some(next) {
        return Err(conflict());
    }
    // Memberships must be certified before group subjects can be supported.
    if input.rules.iter().any(|r| !r.subject.starts_with("user:")) {
        return Err(invalid());
    }
    sqlx::query(
        "INSERT INTO __zerotrust_policies(version,generation,policy,signature) VALUES($1,$2,$3,$4)",
    )
    .bind(next)
    .bind(guard.root.generation)
    .bind(serde_json::to_value(&input).map_err(internal)?)
    .bind(sized::<64>(&input.signature)?.to_vec())
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    let domains: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT id,scope,facet,generation FROM __zerotrust_domains")
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
    let old_readers = policy_readers(guard.policy.rules.iter().chain(&guard.inherited));
    let new_readers = policy_readers(input.rules.iter().chain(&guard.inherited));
    let nobody = std::collections::HashSet::new();
    for (id, scope, facet_name, generation) in domains {
        let current: Vec<String> = sqlx::query_scalar(
            "SELECT recipient FROM __zerotrust_key_envelopes WHERE domain_id=$1 AND generation=$2",
        )
        .bind(&id)
        .bind(generation)
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?;
        // A committed policy carries the durable work marker for the browser.
        // Additions also need historical keys, even after an interrupted grant.
        let key = (scope.clone(), facet_name.clone());
        let expected = new_readers.get(&key).unwrap_or(&nobody);
        let changed = old_readers.get(&key).unwrap_or(&nobody) != expected
            || current.iter().any(|subject| !expected.contains(subject));
        sqlx::query("UPDATE __zerotrust_domains SET policy_version=$1,rotation_required=rotation_required OR $2 WHERE id=$3").bind(next).bind(changed).bind(id).execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query("UPDATE __zerotrust_state SET policy_version=$1,updated_at=now() WHERE singleton")
        .bind(next)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)")
        .bind(serde_json::json!({"kind":"policy","version":input.version}).to_string())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}

async fn put_domain(
    state: &AppState,
    ctx: &RequestContext,
    input: DomainDefinition,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() && input.creation.is_none() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    let signing_key = if let Some(origin) = &input.creation {
        origin.verify(&guard.authority)?;
        if origin.tenant != auth.tenant
            || origin.capability.generation != guard.root.generation.to_string()
            || origin.capability.creator.user != guard.subject
        {
            return Err(forbidden());
        }
        sized::<32>(&origin.capability.creator.signing_key)?.to_vec()
    } else {
        guard.authority.clone()
    };
    verify(&signing_key, &input.proof, &input.frame()?)?;
    let generation = revision(&input.generation)?;
    if input.tenant != auth.tenant || revision(&input.policy_version)? != guard.root.policy_version
    {
        return Err(invalid());
    }
    let current: Option<(String, String, i64)> =
        sqlx::query_as("SELECT scope,facet,generation FROM __zerotrust_domains WHERE id=$1")
            .bind(&input.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if let Some((scope, facet_name, old_generation)) = current {
        if scope == input.scope && facet_name == input.facet.name() && old_generation == generation
        {
            let existing:Option<Value>=sqlx::query_scalar("SELECT definition FROM __zerotrust_recovery_keys WHERE tenant=$1 AND domain_id=$2 AND domain_generation=$3 AND recovery_generation=$4")
                .bind(&auth.tenant).bind(&input.id).bind(generation).bind(guard.root.generation).fetch_optional(state.tenants.master()).await.map_err(internal)?;
            if existing == Some(serde_json::to_value(&input).map_err(internal)?) {
                return Ok(Success { success: true });
            }
        }
        if input.creation.is_some()
            || scope != input.scope
            || facet_name != input.facet.name()
            || old_generation.checked_add(1) != Some(generation)
        {
            return Err(conflict());
        }
    } else if generation != 1 {
        return Err(conflict());
    }
    if let Some(origin) = &input.creation {
        if origin.facet != Facet::MasterData {
            let master: Option<Value> = sqlx::query_scalar("SELECT origin FROM __zerotrust_created_areas WHERE domain_id=$1 AND root_generation=$2")
                .bind(format!("{}:master-data", origin.scope)).bind(guard.root.generation).fetch_optional(&mut *tx).await.map_err(internal)?;
            let master: super::creation::CreationOrigin =
                serde_json::from_value(master.ok_or_else(forbidden)?).map_err(|_| invalid())?;
            master.verify(&guard.authority)?;
            if master.tenant != auth.tenant
                || master.scope != origin.scope
                || master.facet != Facet::MasterData
                || master.capability.creator.user != guard.subject
                || master.capability.namespace != origin.capability.namespace
            {
                return Err(forbidden());
            }
        }
        // The exclusive tenant-root lock also serializes this quota across
        // replicas. Creation must not exceed the bounded domain inventory used
        // by administration, event admission and phrase-only recovery.
        let area_count: i64 = sqlx::query_scalar("SELECT count(*) FROM __zerotrust_domains")
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
        if area_count >= 2000 {
            return Err(RpcError::new(
                ErrorCode::BadRequest,
                "Protected tenant area limit reached",
            ));
        }
        if !guard.policy.allows(
            &guard.subject,
            origin.capability.creation_scope()?,
            Facet::MasterData,
            Action::Create,
        ) {
            return Err(forbidden());
        }
        let published:Option<Value>=sqlx::query_scalar("SELECT capability FROM __zerotrust_creation_capabilities WHERE user_id=$1 AND generation=$2 AND namespace=$3")
            .bind(auth.user.id.parse::<i64>().map_err(internal)?).bind(guard.root.generation).bind(&origin.capability.namespace).fetch_optional(&mut *tx).await.map_err(internal)?;
        if published != Some(serde_json::to_value(&origin.capability).map_err(internal)?) {
            return Err(forbidden());
        }
        for member in std::iter::once(&origin.capability.creator).chain(&origin.capability.readers)
        {
            super::creation::check_member(&mut tx, member, &guard).await?;
        }
        let expected: std::collections::HashSet<_> = origin
            .rules()
            .into_iter()
            .map(|rule| rule.subject)
            .collect();
        if input.envelopes.len() != expected.len()
            || input
                .envelopes
                .iter()
                .any(|box_| !expected.contains(&box_.recipient))
        {
            return Err(forbidden());
        }
    }
    let author = input
        .creation
        .as_ref()
        .map(super::creation::CreationOrigin::author)
        .unwrap_or_else(|| format!("authority:{}", guard.root.generation));
    let mut inherited = guard.inherited.clone();
    if let Some(origin) = &input.creation {
        inherited.extend(origin.rules());
    }
    let mut recipients = Vec::new();
    for envelope in &input.envelopes {
        if !guard.policy.allows_with(
            &inherited,
            &envelope.recipient,
            &input.scope,
            input.facet,
            Action::Read,
        ) {
            return Err(forbidden());
        }
        check_box(
            envelope,
            &auth.tenant,
            &input.id,
            &input.generation,
            &author,
        )?;
        envelope.verify(&signing_key)?;
        let user = Id::decode(
            envelope
                .recipient
                .strip_prefix("user:")
                .ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?;
        let cert: Value = sqlx::query_scalar(
            "SELECT identity_certificate FROM __zerotrust_accounts WHERE user_id=$1",
        )
        .bind(user)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or_else(forbidden)?;
        let cert: IdentityCertificate = serde_json::from_value(cert).map_err(|_| forbidden())?;
        cert.verify(&guard.authority)?;
        if cert.user != envelope.recipient
            || cert.tenant != auth.tenant
            || cert.generation != guard.root.generation.to_string()
        {
            return Err(forbidden());
        }
        recipients.push(envelope.recipient.clone());
    }
    let recovery = &input.recovery_envelope;
    check_box(
        recovery,
        &auth.tenant,
        &input.id,
        &input.generation,
        &author,
    )?;
    recovery.verify(&signing_key)?;
    if recovery.recipient != format!("recovery:{}", guard.root.generation) {
        return Err(invalid());
    }
    let definition = serde_json::to_value(&input).map_err(internal)?;
    // Durable recovery copy precedes publication. The exclusive tenant-root
    // lock and the generation check above prove this generation is still
    // unpublished. An aborted earlier attempt may have left another encrypted
    // draft here; it is safe to replace because no object can reference it.
    // Already published generations returned/rejected in the branch above and
    // must never reach this upsert with a different definition.
    let mut master = state.tenants.master().begin().await.map_err(internal)?;
    let root_generation: i64 = sqlx::query_scalar(
        "SELECT generation FROM __zerotrust_recovery_heads WHERE tenant=$1 FOR SHARE",
    )
    .bind(&auth.tenant)
    .fetch_one(&mut *master)
    .await
    .map_err(internal)?;
    if root_generation != guard.root.generation {
        return Err(conflict());
    }
    sqlx::query("INSERT INTO __zerotrust_recovery_keys(tenant,domain_id,domain_generation,recovery_generation,definition) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant,domain_id,domain_generation,recovery_generation) DO UPDATE SET definition=EXCLUDED.definition").bind(&auth.tenant).bind(&input.id).bind(generation).bind(root_generation).bind(&definition).execute(&mut *master).await.map_err(internal)?;
    let existing:Value=sqlx::query_scalar("SELECT definition FROM __zerotrust_recovery_keys WHERE tenant=$1 AND domain_id=$2 AND domain_generation=$3 AND recovery_generation=$4").bind(&auth.tenant).bind(&input.id).bind(generation).bind(root_generation).fetch_one(&mut *master).await.map_err(internal)?;
    if existing != definition {
        return Err(conflict());
    }
    master.commit().await.map_err(internal)?;
    recipients.sort();
    let readers_hash = Sha256::digest(frame(
        "sortsys/readers/v1",
        &recipients.iter().map(String::as_str).collect::<Vec<_>>(),
    ));
    // A key change must invalidate every earlier snapshot, including guards
    // for a composite document part which writes only one of its key domains.
    // Reserve from the same global sequence as object writes: head+1 alone
    // could collide with the next object change and make that write invisible.
    sqlx::query("INSERT INTO __zerotrust_domains(id,scope,facet,readers_hash,generation,policy_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET readers_hash=EXCLUDED.readers_hash,generation=EXCLUDED.generation,policy_version=EXCLUDED.policy_version,rotation_required=FALSE,head_sequence=nextval(pg_get_serial_sequence('__zerotrust_changes','seq'))")
        .bind(&input.id).bind(&input.scope).bind(input.facet.name()).bind(readers_hash.to_vec()).bind(generation).bind(guard.root.policy_version).execute(&mut *tx).await.map_err(internal)?;
    for envelope in &input.envelopes {
        sqlx::query("INSERT INTO __zerotrust_key_envelopes(domain_id,generation,recipient,envelope) VALUES($1,$2,$3,$4)").bind(&input.id).bind(generation).bind(&envelope.recipient).bind(serde_json::to_value(envelope).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    }
    if let Some(origin) = &input.creation {
        let readers: Vec<_> = origin
            .capability
            .readers
            .iter()
            .map(|member| member.user.clone())
            .collect();
        sqlx::query("INSERT INTO __zerotrust_created_areas(domain_id,root_generation,creator,readers,origin) VALUES($1,$2,$3,$4,$5)")
            .bind(&input.id).bind(guard.root.generation).bind(&origin.capability.creator.user).bind(readers).bind(serde_json::to_value(origin).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
        sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)").bind(serde_json::json!({"kind":"policy","version":guard.root.policy_version.to_string()}).to_string()).execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query("INSERT INTO __zerotrust_recovery_catalog(domain_id,domain_generation,recovery_generation,envelope) VALUES($1,$2,$3,$4)").bind(&input.id).bind(generation).bind(root_generation).bind(serde_json::to_value(recovery).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_state SET catalog_version=$1 WHERE singleton")
        .bind(
            guard
                .root
                .catalog_version
                .checked_add(1)
                .ok_or_else(conflict)?,
        )
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    super::events::notify_domain(&mut tx, &input.id).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
fn check_box(
    box_: &SealedBox,
    tenant: &str,
    id: &str,
    generation: &str,
    author: &str,
) -> RpcResult<()> {
    if box_.tenant != tenant
        || box_.purpose != "area-key"
        || box_.object != id
        || box_.generation != generation
        || box_.author != author
    {
        return Err(invalid());
    }
    Ok(())
}

async fn domain(tx: &mut PgConnection, id: &str) -> RpcResult<DomainRow> {
    identifier(id)?;
    sqlx::query_as(
        "SELECT scope,facet,generation,rotation_required FROM __zerotrust_domains WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(tx)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)
}
async fn get_key(state: &AppState, ctx: &RequestContext, input: KeyInput) -> RpcResult<SealedBox> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    let domain = domain(&mut tx, &input.domain).await?;
    if !guard.allows(
        &guard.subject,
        &domain.scope,
        facet(&domain.facet)?,
        Action::Read,
    ) {
        return Err(forbidden());
    }
    let generation = revision(&input.generation)?;
    let box_:Value=sqlx::query_scalar("SELECT envelope FROM __zerotrust_key_envelopes WHERE domain_id=$1 AND generation=$2 AND recipient=$3").bind(&input.domain).bind(generation).bind(&guard.subject).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
    serde_json::from_value(box_).map_err(|_| invalid())
}

async fn grant_key(state: &AppState, ctx: &RequestContext, input: KeyGrant) -> RpcResult<Success> {
    identifier(&input.domain)?;
    let generation = revision(&input.generation)?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    let domain = domain(&mut tx, &input.domain).await?;
    let known:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_recovery_catalog WHERE domain_id=$1 AND domain_generation=$2)")
        .bind(&input.domain).bind(generation).fetch_one(&mut *tx).await.map_err(internal)?;
    if !known
        || generation > domain.generation
        || !guard.allows(
            &input.envelope.recipient,
            &domain.scope,
            facet(&domain.facet)?,
            Action::Read,
        )
    {
        return Err(forbidden());
    }
    check_box(
        &input.envelope,
        &auth.tenant,
        &input.domain,
        &input.generation,
        &format!("authority:{}", guard.root.generation),
    )?;
    input.envelope.verify(&guard.authority)?;
    let id = Id::decode(
        input
            .envelope
            .recipient
            .strip_prefix("user:")
            .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())?;
    let value: Value = sqlx::query_scalar(
        "SELECT identity_certificate FROM __zerotrust_accounts WHERE user_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .ok_or_else(forbidden)?;
    let certificate: IdentityCertificate =
        serde_json::from_value(value).map_err(|_| forbidden())?;
    certificate.verify(&guard.authority)?;
    if certificate.tenant != auth.tenant
        || certificate.user != input.envelope.recipient
        || certificate.generation != guard.root.generation.to_string()
    {
        return Err(forbidden());
    }
    sqlx::query("INSERT INTO __zerotrust_key_envelopes(domain_id,generation,recipient,envelope) VALUES($1,$2,$3,$4) ON CONFLICT(domain_id,generation,recipient) DO UPDATE SET envelope=EXCLUDED.envelope")
        .bind(&input.domain).bind(generation).bind(&input.envelope.recipient).bind(serde_json::to_value(&input.envelope).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    if generation == domain.generation {
        let recipients:Vec<String>=sqlx::query_scalar("SELECT recipient FROM __zerotrust_key_envelopes WHERE domain_id=$1 AND generation=$2 ORDER BY recipient COLLATE \"C\"")
            .bind(&input.domain).bind(generation).fetch_all(&mut *tx).await.map_err(internal)?;
        let hash = Sha256::digest(frame(
            "sortsys/readers/v1",
            &recipients.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
        sqlx::query("UPDATE __zerotrust_domains SET readers_hash=$2 WHERE id=$1")
            .bind(&input.domain)
            .bind(hash.to_vec())
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    super::events::notify_account(&mut tx, &input.envelope.recipient).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}

async fn get_definition(
    state: &AppState,
    ctx: &RequestContext,
    input: KeyInput,
) -> RpcResult<DomainDefinition> {
    identifier(&input.domain)?;
    let generation = revision(&input.generation)?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    let value: Value = sqlx::query_scalar("SELECT definition FROM __zerotrust_recovery_keys WHERE tenant=$1 AND domain_id=$2 AND domain_generation=$3 AND recovery_generation<=$4 ORDER BY recovery_generation DESC LIMIT 1")
        .bind(&auth.tenant).bind(&input.domain).bind(generation).bind(guard.root.generation)
        .fetch_optional(state.tenants.master()).await.map_err(internal)?.ok_or_else(not_found)?;
    let definition: DomainDefinition = serde_json::from_value(value).map_err(|_| invalid())?;
    if definition.tenant != auth.tenant
        || definition.id != input.domain
        || definition.generation != input.generation
        || !auth.is_admin()
            && !guard.allows(
                &guard.subject,
                &definition.scope,
                definition.facet,
                Action::Read,
            )
    {
        return Err(forbidden());
    }
    Ok(definition)
}
async fn get_object(
    state: &AppState,
    ctx: &RequestContext,
    input: IdInput,
) -> RpcResult<EncryptedObject> {
    identifier(&input.id)?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    let (envelope, domain_id): (Value, String) = sqlx::query_as(
        "SELECT envelope,domain_id FROM __zerotrust_objects WHERE id=$1 AND deleted_at IS NULL",
    )
    .bind(&input.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;
    let domain = domain(&mut tx, &domain_id).await?;
    if !guard.allows(
        &guard.subject,
        &domain.scope,
        facet(&domain.facet)?,
        Action::Read,
    ) {
        return Err(forbidden());
    }
    read_envelope(state, &auth.tenant, envelope).await
}
async fn save_object(
    state: &AppState,
    ctx: &RequestContext,
    input: SaveInput,
) -> RpcResult<Success> {
    save_batch(
        state,
        ctx,
        BatchInput {
            objects: vec![input],
            heads: None,
            documents: None,
        },
    )
    .await?;
    Ok(Success { success: true })
}

// Domain locks order commits across API replicas. A page token is invalidated
// by every committed write in its domain, including a write to another prefix.
pub(super) async fn domain_lock(tx: &mut PgConnection, id: &str, write: bool) -> RpcResult<()> {
    identifier(id)?;
    let sql = if write {
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))"
    } else {
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))"
    };
    sqlx::query(sql)
        .bind(format!("sortsys:zerotrust:domain:{id}"))
        .execute(tx)
        .await
        .map_err(internal)?;
    Ok(())
}

async fn list_objects(
    state: &AppState,
    ctx: &RequestContext,
    input: ListInput,
) -> RpcResult<ObjectPage> {
    identifier(&input.prefix)?;
    if let Some(after) = &input.after {
        identifier(after)?;
        if !after.starts_with(&input.prefix) || input.snapshot.is_none() {
            return Err(invalid());
        }
    }
    if let Some(snapshot) = &input.snapshot
        && snapshot != "0"
    {
        revision(snapshot)?;
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    domain_lock(&mut tx, &input.domain, false).await?;
    let area = domain(&mut tx, &input.domain).await?;
    if !guard.allows(
        &guard.subject,
        &area.scope,
        facet(&area.facet)?,
        Action::Read,
    ) {
        return Err(forbidden());
    }
    let snapshot: i64 =
        sqlx::query_scalar("SELECT head_sequence FROM __zerotrust_domains WHERE id=$1")
            .bind(&input.domain)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    let snapshot = snapshot.to_string();
    if input
        .snapshot
        .as_ref()
        .is_some_and(|expected| *expected != snapshot)
    {
        return Err(conflict());
    }
    let rows: Vec<(String, Value)> = sqlx::query_as("SELECT id,envelope FROM __zerotrust_objects WHERE domain_id=$1 AND starts_with(id,$2) AND ($3::text IS NULL OR id COLLATE \"C\">$3 COLLATE \"C\") AND deleted_at IS NULL ORDER BY id COLLATE \"C\" LIMIT 33")
        .bind(&input.domain).bind(&input.prefix).bind(&input.after).fetch_all(&mut *tx).await.map_err(internal)?;
    let more = rows.len() > 32;
    let references = rows
        .into_iter()
        .take(32)
        .map(|(id, reference)| {
            let reference: CipherReference =
                serde_json::from_value(reference).map_err(|_| invalid())?;
            if reference.format != "sortsys-quack-ref-v1" {
                return Err(invalid());
            }
            Ok((id, reference.id))
        })
        .collect::<RpcResult<Vec<_>>>()?;
    let mut objects = Vec::new();
    if !references.is_empty() {
        let data = state
            .ciphertexts
            .as_ref()
            .ok_or_else(storage_unavailable)?
            .get_prefix(
                &auth.tenant,
                references
                    .iter()
                    .map(|(_, reference)| reference.clone())
                    .collect(),
                16 * 1024 * 1024,
            )
            .await
            .map_err(storage_failure)?;
        if data.is_empty() || data.len() > references.len() {
            return Err(invalid());
        }
        for ((id, _), data) in references.iter().zip(data) {
            let envelope: EncryptedObject = serde_json::from_str(&data).map_err(|_| invalid())?;
            envelope.frame()?;
            if envelope.object != *id
                || envelope.tenant != auth.tenant
                || envelope.scope != area.scope
                || envelope.facet.name() != area.facet
            {
                return Err(invalid());
            }
            objects.push(envelope);
        }
    }
    let after = if more || objects.len() < references.len() {
        objects.last().map(|object| object.object.clone())
    } else {
        None
    };
    Ok(ObjectPage {
        snapshot,
        key_generation: area.generation.to_string(),
        objects,
        after,
    })
}

async fn save_batch(
    state: &AppState,
    ctx: &RequestContext,
    input: BatchInput,
) -> RpcResult<BatchResult> {
    commit_batch(state, ctx, input, false).await
}

pub(super) async fn commit_batch(
    state: &AppState,
    ctx: &RequestContext,
    input: BatchInput,
    staged: bool,
) -> RpcResult<BatchResult> {
    let file_metadata = input.objects.iter().all(|object| {
        object.envelope.facet == Facet::Attachment
            && object.envelope.object.starts_with("project-files:")
    });
    let document_heads = input.documents.as_deref().unwrap_or_default();
    if (input.objects.is_empty() && document_heads.is_empty())
        || document_heads.len() > 16
        || input.objects.len()
            > if staged {
                40_001
            } else if file_metadata {
                200
            } else {
                64
            }
    {
        return Err(invalid());
    }
    let mut domains = std::collections::BTreeSet::new();
    let mut ids = std::collections::BTreeSet::new();
    let mut messages = std::collections::HashSet::new();
    let mut bytes = 0usize;
    let mut opaque_scopes = std::collections::BTreeSet::new();
    for object in &input.objects {
        tool_object_binding(object)?;
        if let Some(scope) = opaque_scope(object)? {
            opaque_scopes.insert(scope);
        }
        identifier(&object.domain)?;
        identifier(&object.message_id)?;
        identifier(&object.envelope.object)?;
        if !ids.insert(&object.envelope.object) || !messages.insert(&object.message_id) {
            return Err(invalid());
        }
        domains.insert(object.domain.clone());
        bytes += object.envelope.ciphertext.len();
    }
    if bytes
        > if staged {
            256 * 1024 * 1024
        } else {
            24 * 1024 * 1024
        }
    {
        return Err(invalid());
    }
    if !staged && input.objects.len() > 64 && domains.len() != 1 {
        return Err(invalid());
    }
    if input.heads.is_none()
        && input.objects.iter().any(|obj| {
            obj.envelope.object.starts_with("product:")
                || obj.envelope.object.starts_with("vendor:")
                || obj.envelope.object.starts_with("product-price:")
                || obj.envelope.object.starts_with("customer:")
                || obj.envelope.object.starts_with("contact:")
                || obj.envelope.object.starts_with("project:")
                || obj.envelope.object.starts_with("project-files:")
                || obj.envelope.object.starts_with("project-folder:")
                || obj.envelope.object.starts_with("delivery-note:")
                || obj.envelope.object.starts_with("delivery-price:")
                || obj.envelope.object.starts_with("delivery-create:")
                || obj.envelope.object.starts_with("tool:")
                || obj.envelope.object.starts_with("tool-tracking:")
                || obj.envelope.object == "tool-index"
        })
    {
        return Err(invalid());
    }
    if let Some(heads) = &input.heads {
        let mut seen = std::collections::HashSet::new();
        if heads.len() < domains.len() || heads.len() > 128 {
            return Err(invalid());
        }
        for head in heads {
            identifier(&head.domain)?;
            if !seen.insert(&head.domain) {
                return Err(invalid());
            }
            if head.sequence != "0" {
                revision(&head.sequence)?;
            }
        }
        if domains.iter().any(|domain| !seen.contains(domain)) {
            return Err(invalid());
        }
    }
    for scope in &opaque_scopes {
        for facet in super::creation::COMMERCIAL_FACETS {
            let id = format!("{scope}:{}", facet.name());
            if !input
                .heads
                .as_ref()
                .is_some_and(|heads| heads.iter().any(|head| head.domain == id))
            {
                return Err(invalid());
            }
        }
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    // Read-only guards bind cross-area reference checks to the same commit.
    // Lock all areas in one order, including areas without a changed object.
    let mut locked_domains = domains.clone();
    for object in &input.objects {
        // These namespaces belong to exactly one area. Validate that binding
        // before relying on the area's lock instead of thousands of ID locks.
        import_receipt(object, &guard.subject)?;
        if staged {
            super::stock::verify_references(
                &guard,
                &auth.tenant,
                &object.domain,
                &object.envelope,
                object.references.as_ref(),
            )?;
        }
        if let Some(reference) = &object.references {
            locked_domains.extend(super::stock::reference_domains(reference)?);
        }
    }
    if let Some(heads) = &input.heads {
        locked_domains.extend(heads.iter().map(|head| head.domain.clone()));
    }
    for head in document_heads {
        head.frame()?;
        locked_domains.extend(head.domains());
    }
    for domain in &locked_domains {
        domain_lock(&mut tx, domain, true).await?;
    }
    super::documents::lock(&mut tx, document_heads).await?;
    for scope in &opaque_scopes {
        for facet in super::creation::COMMERCIAL_FACETS {
            let area = domain(&mut tx, &format!("{scope}:{}", facet.name())).await?;
            if area.scope != *scope || area.facet != facet.name() {
                return Err(invalid());
            }
            if area.rotation_required {
                return Err(conflict());
            }
            if !guard.allows(&guard.subject, scope, facet, Action::Read)
                || !guard.allows(&guard.subject, scope, facet, Action::Update)
            {
                return Err(forbidden());
            }
        }
    }
    // Object IDs are tenant-wide, so independently named domains must still
    // take their object locks in one shared order.
    if staged {
        let ordered = ids
            .iter()
            .filter(|id| {
                super::stock::kind(id).ok().flatten().is_none() && !id.starts_with("price-import:")
            })
            .map(|id| (*id).clone())
            .collect::<Vec<_>>();
        if ordered.len() > 200 {
            return Err(invalid());
        }
        sqlx::query("WITH ids AS MATERIALIZED (SELECT unnest($1::text[]) AS id ORDER BY id) SELECT pg_advisory_xact_lock(hashtextextended('sortsys:zerotrust:'||id,0)) FROM ids")
            .bind(ordered).execute(&mut *tx).await.map_err(internal)?;
    } else {
        for id in ids {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
                .bind(format!("sortsys:zerotrust:{id}"))
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
        }
    }
    if let Some(heads) = &input.heads {
        let mut changed = false;
        for head in heads {
            let area = domain(&mut tx, &head.domain).await?;
            if !guard.allows(
                &guard.subject,
                &area.scope,
                facet(&area.facet)?,
                Action::Read,
            ) {
                return Err(forbidden());
            }
            let current: i64 =
                sqlx::query_scalar("SELECT head_sequence FROM __zerotrust_domains WHERE id=$1")
                    .bind(&head.domain)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(internal)?;
            changed |= current.to_string() != head.sequence;
        }
        if changed {
            // A lost acknowledgement may replay the exact committed batch.
            // Partial matches cannot bypass the collection version check.
            for object in &input.objects {
                let current: Option<(String, i64, Value)> = sqlx::query_as("SELECT domain_id,revision,envelope FROM __zerotrust_objects WHERE id=$1 AND deleted_at IS NULL")
                    .bind(&object.envelope.object).fetch_optional(&mut *tx).await.map_err(internal)?;
                if current
                    != Some((
                        object.domain.clone(),
                        revision(&object.envelope.revision)?,
                        envelope_reference(&object.envelope)?,
                    ))
                {
                    return Err(conflict());
                }
            }
            for head in document_heads {
                let current: Option<(String, Value)> =
                    sqlx::query_as("SELECT scope,head FROM __zerotrust_documents WHERE id=$1")
                        .bind(&head.id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(internal)?;
                if current
                    != Some((
                        head.scope.clone(),
                        serde_json::to_value(head).map_err(internal)?,
                    ))
                {
                    return Err(conflict());
                }
            }
        }
    }
    let mut metadata_changed = std::collections::BTreeSet::new();
    for object in &input.objects {
        let written =
            save_in_transaction(state, &mut tx, &auth.tenant, &guard, object, staged).await?;
        if staged {
            super::stock::save_verified_references(&mut tx, object.references.as_ref(), written)
                .await?;
        } else {
            super::stock::save_references(
                &mut tx,
                &guard,
                &auth.tenant,
                &object.domain,
                &object.envelope,
                object.references.as_ref(),
                written,
            )
            .await?;
        }
        if written
            && object.envelope.object
                == format!(
                    "{}:{}:case",
                    object.envelope.scope,
                    object.envelope.facet.name()
                )
        {
            metadata_changed.insert(object.envelope.scope.as_str());
        }
    }
    super::stock::validate_references(
        &mut tx,
        &input
            .objects
            .iter()
            .map(|object| object.envelope.object.clone())
            .collect::<Vec<_>>(),
    )
    .await?;
    for head in document_heads {
        super::documents::commit(
            state,
            &mut tx,
            &guard,
            &auth.tenant,
            head,
            metadata_changed.contains(head.scope.as_str()),
        )
        .await?;
    }
    let mut heads = Vec::new();
    for domain in domains {
        let sequence: i64 =
            sqlx::query_scalar("SELECT head_sequence FROM __zerotrust_domains WHERE id=$1")
                .bind(&domain)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
        heads.push(DomainHead {
            domain: domain.clone(),
            sequence: sequence.to_string(),
        });
        if staged {
            sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)")
                .bind(
                    serde_json::json!({"kind":"object","seq":sequence.to_string(),"domain":domain})
                        .to_string(),
                )
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
        }
    }
    tx.commit().await.map_err(internal)?;
    Ok(BatchResult {
        success: true,
        heads,
    })
}

/// Resource names bind public tool metadata to exactly one key area. Content
/// and business relationships remain encrypted and are checked by the client.
fn tool_object_binding(input: &SaveInput) -> RpcResult<()> {
    let object = &input.envelope.object;
    if object == "tool-index" {
        if input.domain != "catalog:tools:master-data"
            || input.envelope.scope != "catalog:tools"
            || input.envelope.facet != Facet::MasterData
        {
            return Err(invalid());
        }
    } else if object.starts_with("tool:") || object.starts_with("tool-tracking:") {
        let (namespace, tail) = object.split_once(':').ok_or_else(invalid)?;
        let (token, _) = tail.split_once(':').ok_or_else(invalid)?;
        let id = Id::decode(token).map_err(|_| invalid())?;
        let facet = input.envelope.facet;
        let allowed = match namespace {
            "tool" => matches!(
                facet,
                Facet::MasterData | Facet::Procurement | Facet::Measurement
            ),
            "tool-tracking" => {
                matches!(facet, Facet::MasterData | Facet::Procurement | Facet::Scope)
            }
            _ => false,
        };
        let scope = format!("{namespace}:{token}");
        if !allowed
            || id.0 <= 0
            || id.encode() != token
            || input.envelope.scope != scope
            || input.domain != format!("{scope}:{}", facet.name())
            || *object != format!("{}:record", input.domain)
        {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Opaque GAEB extensions require all nine keys and all nine update rights,
/// although their outer envelope lives in the scope domain.
fn opaque_scope(input: &SaveInput) -> RpcResult<Option<&str>> {
    let object = &input.envelope.object;
    if !object.starts_with("commercial:") {
        return Ok(None);
    }
    let Some((scope, suffix)) = object.split_once(":scope:opaque:") else {
        return Ok(None);
    };
    let token = scope.strip_prefix("commercial:").ok_or_else(invalid)?;
    let id = Id::decode(token).map_err(|_| invalid())?;
    if id.0 <= 0
        || id.encode() != token
        || suffix.is_empty()
        || input.envelope.scope != scope
        || input.envelope.facet != Facet::Scope
        || input.domain != format!("{scope}:scope")
    {
        return Err(invalid());
    }
    Ok(Some(scope))
}

/// Private import receipts are immutable and namespaced by their actual
/// author. Another price editor cannot overwrite a caller's retry evidence.
fn import_receipt(input: &SaveInput, subject: &str) -> RpcResult<bool> {
    let Some(tail) = input.envelope.object.strip_prefix("price-import:") else {
        return Ok(false);
    };
    let (user, request) = tail.split_once(':').ok_or_else(invalid)?;
    let decoded = Id::decode(user).map_err(|_| invalid())?;
    if decoded.0 <= 0
        || decoded.encode() != user
        || request.len() < 16
        || request.len() > 80
        || !request
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(invalid());
    }
    if subject != format!("user:{user}") {
        return Err(forbidden());
    }
    if input.domain != "catalog:products:procurement"
        || input.envelope.scope != "catalog:products"
        || input.envelope.facet != Facet::Procurement
        || input.envelope.revision != "1"
    {
        return Err(invalid());
    }
    Ok(true)
}

async fn save_in_transaction(
    state: &AppState,
    tx: &mut PgConnection,
    tenant: &str,
    guard: &Security,
    input: &SaveInput,
    staged: bool,
) -> RpcResult<bool> {
    identifier(&input.message_id)?;
    let envelope = &input.envelope;
    envelope.verify(&guard.signing_key)?;
    super::delivery::validate_packet(tx, guard, input).await?;
    let domain = domain(tx, &input.domain).await?;
    let version = revision(&envelope.revision)?;
    if envelope.tenant != tenant
        || envelope.author != guard.subject
        || envelope.scope != domain.scope
        || envelope.facet.name() != domain.facet
        || revision(&envelope.generation)? != domain.generation
        || revision(&envelope.policy_version)? != guard.root.policy_version
        || domain.rotation_required
    {
        return Err(conflict());
    }
    let current: Option<(String, i64, Value, bool)> = sqlx::query_as(
        "SELECT domain_id,revision,envelope,deleted_at IS NOT NULL FROM __zerotrust_objects WHERE id=$1 FOR UPDATE",
    )
    .bind(&envelope.object)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    if current.as_ref().is_some_and(|row| row.3) {
        return Err(conflict());
    }
    let action = if current.is_some() {
        Action::Update
    } else {
        Action::Create
    };
    let blob = super::documents::blob(&envelope.object)?;
    if !guard.allows(&guard.subject, &domain.scope, envelope.facet, Action::Read) {
        return Err(forbidden());
    }
    if let Some(blob) = &blob {
        let owner = if blob.facet == "opaque" {
            "scope"
        } else {
            blob.facet
        };
        if blob.scope != domain.scope
            || domain.facet != owner
            || input.domain != format!("{}:{owner}", blob.scope)
            || version != 1
        {
            return Err(invalid());
        }
        if let Some((id, old, previous, _)) = &current {
            if id == &input.domain && *old == version && previous == &envelope_reference(envelope)?
            {
                if !staged {
                    persist_envelope(state, tenant, envelope).await?;
                }
                return Ok(false);
            }
            return Err(conflict());
        }
        let locked:bool=sqlx::query_scalar("SELECT COALESCE((SELECT (head->>'locked')::boolean FROM __zerotrust_documents WHERE id=$1),FALSE)").bind(blob.id).fetch_one(&mut *tx).await.map_err(internal)?;
        if locked {
            return Err(forbidden());
        }
    }
    if !guard.allows(&guard.subject, &domain.scope, envelope.facet, Action::Read)
        || !(guard.allows(&guard.subject, &domain.scope, envelope.facet, action)
            || blob.is_some()
                && guard.allows(
                    &guard.subject,
                    &domain.scope,
                    envelope.facet,
                    Action::Update,
                ))
    {
        return Err(forbidden());
    }
    let value = envelope_reference(envelope)?;
    if let Some((id, old, previous, _)) = &current {
        if id == &input.domain && *old == version && previous == &value {
            if !staged {
                persist_envelope(state, tenant, envelope).await?;
            }
            return Ok(false);
        }
        if id != &input.domain || old.checked_add(1) != Some(version) {
            return Err(conflict());
        }
    } else if version != 1 {
        return Err(conflict());
    }
    let duplicate: Option<(String, i64)> =
        sqlx::query_as("SELECT object_id,revision FROM __zerotrust_changes WHERE message_id=$1")
            .bind(&input.message_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if duplicate.is_some() {
        return Err(conflict());
    }
    // Ciphertext is immutable and durable before publishing its reference. A
    // failed SQL transaction can leave an unreachable ciphertext, never a
    // visible head that points at a not-yet-written object.
    if !staged {
        persist_envelope(state, tenant, envelope).await?;
    }
    sqlx::query("INSERT INTO __zerotrust_objects(id,domain_id,revision,envelope) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,envelope=EXCLUDED.envelope,updated_at=now()")
        .bind(&envelope.object).bind(&input.domain).bind(version).bind(&value).execute(&mut *tx).await.map_err(internal)?;
    let seq:i64=sqlx::query_scalar("INSERT INTO __zerotrust_changes(object_id,message_id,revision,envelope) VALUES($1,$2,$3,$4) RETURNING seq").bind(&envelope.object).bind(&input.message_id).bind(version).bind(value).fetch_one(&mut *tx).await.map_err(|error| match error {sqlx::Error::Database(ref db) if db.is_unique_violation()=>conflict(),error=>internal(error)})?;
    sqlx::query("UPDATE __zerotrust_domains SET head_sequence=$1 WHERE id=$2")
        .bind(seq)
        .bind(&input.domain)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    if !staged {
        sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)")
        .bind(
            serde_json::json!({"kind":"object","seq":seq.to_string(),"id":envelope.object,"domain":input.domain})
                .to_string(),
        )
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    Ok(true)
}

#[cfg(test)]
mod permission_tests {
    use super::*;
    #[test]
    fn tool_object_names_bind_the_scope_facet_record_and_number_index() {
        let value: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-recovery.json"))
                .unwrap();
        let mut envelope: EncryptedObject =
            serde_json::from_value(value["initialObject"].clone()).unwrap();
        envelope.object = "tool:abc:master-data:record".into();
        envelope.scope = "tool:abc".into();
        envelope.facet = Facet::MasterData;
        let mut input = SaveInput {
            domain: "tool:abc:master-data".into(),
            message_id: "test".into(),
            envelope,
            references: None,
        };
        tool_object_binding(&input).unwrap();
        for object in [
            "tool:def:master-data:record",
            "tool:0abc:master-data:record",
            "tool:abc:procurement:record",
            "tool:abc:master-data:other",
            "tool-tracking:abc:master-data:record",
        ] {
            let mut changed = input.clone();
            changed.envelope.object = object.into();
            assert!(tool_object_binding(&changed).is_err());
        }
        input.envelope.object = "tool-index".into();
        assert!(tool_object_binding(&input).is_err());
        input.domain = "catalog:tools:master-data".into();
        input.envelope.scope = "catalog:tools".into();
        tool_object_binding(&input).unwrap();
        input.envelope.facet = Facet::Procurement;
        assert!(tool_object_binding(&input).is_err());
    }
    #[test]
    fn import_receipts_bind_the_author_area_and_immutable_first_version() {
        let value: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-recovery.json"))
                .unwrap();
        let mut envelope: EncryptedObject =
            serde_json::from_value(value["initialObject"].clone()).unwrap();
        envelope.object = "price-import:1:import-request-20261111".into();
        envelope.scope = "catalog:products".into();
        envelope.facet = Facet::Procurement;
        envelope.revision = "1".into();
        let mut input = SaveInput {
            domain: "catalog:products:procurement".into(),
            message_id: "test".into(),
            envelope,
            references: None,
        };
        assert!(import_receipt(&input, "user:1").unwrap());
        assert!(import_receipt(&input, "user:2").is_err());
        input.envelope.revision = "2".into();
        assert!(import_receipt(&input, "user:1").is_err());
        input.envelope.revision = "1".into();
        input.domain = "other:procurement".into();
        assert!(import_receipt(&input, "user:1").is_err());
        input.domain = "catalog:products:procurement".into();
        input.envelope.object = "price-import:01:import-request-20261111".into();
        assert!(import_receipt(&input, "user:1").is_err());
    }
    #[test]
    fn reader_inventory_preserves_denials_and_separates_scopes_facets_and_write_only_grants() {
        let policy: SignedPolicy = serde_json::from_value(serde_json::json!({"tenant":"test","version":"1","signature":"unused","rules":[
            {"subject":"user:1","scope":"catalog:a","facet":"master-data","actions":["read"],"effect":"allow"},
            {"subject":"user:1","scope":"catalog:a","facet":"master-data","actions":["read"],"effect":"deny"},
            {"subject":"user:1","scope":"catalog:a","facet":"procurement","actions":["read"],"effect":"allow"},
            {"subject":"user:1","scope":"catalog:b","facet":"master-data","actions":["read"],"effect":"allow"},
            {"subject":"user:2","scope":"catalog:a","facet":"master-data","actions":["update"],"effect":"allow"},
            {"subject":"user:3","scope":"catalog:a","facet":"master-data","actions":["read","update"],"effect":"allow"}
        ]})).unwrap();
        let readers = policy_readers(policy.rules.iter());
        for rule in &policy.rules {
            for subject in ["user:1", "user:2", "user:3"] {
                assert_eq!(
                    readers
                        .get(&(rule.scope.clone(), rule.facet.name().to_owned()))
                        .is_some_and(|set| set.contains(subject)),
                    policy.allows(subject, &rule.scope, rule.facet, Action::Read)
                );
            }
        }
    }
}
