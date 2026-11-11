//! Seed-authorized recovery. This module never accepts a phrase or private key.
//! A prepared transition is durable before the old root is consumed. Retrying
//! can finish that same signed transition, but cannot choose another owner.
use super::{
    crypto::{
        AccountVault, decode, encode, frame, identifier, invalid, random_id, revision, sized,
        verify,
    },
    objects::DomainDefinition,
    opaque::{recovery_registration, validate_registration},
    setup::{SetupInput, packet_hash},
    wire::{AuthorityCertificate, Facet, SealedBox},
};
use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    procedures::common::{internal, not_found},
    rpc::ProcedureRegistryBuilder,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::{
    collections::HashSet,
    sync::{Arc, LazyLock},
};
use ts_rs::TS;

fn conflict() -> RpcError {
    RpcError::new(
        ErrorCode::Conflict,
        "Recovery state changed; refresh before continuing",
    )
    .with_http_code(409)
}

static RECOVERY_CHECKS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));
async fn validate_plan(input: &RecoveryPlan) -> RpcResult<()> {
    let permit = Arc::clone(&RECOVERY_CHECKS)
        .try_acquire_owned()
        .map_err(|_| {
            RpcError::new(ErrorCode::TooManyRequests, "Recovery checks are busy")
                .with_http_code(429)
        })?;
    let input = input.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        input.validate()
    })
    .await
    .map_err(internal)?
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transition {
    tenant: String,
    generation: String,
    operation: String,
    challenge: String,
    catalog_version: String,
    catalog_hash: String,
    previous_authority_certificate_hash: String,
    next_recovery_encryption_key: String,
    next_recovery_signing_key: String,
    next_authority_signing_key: String,
    next_administrator: String,
    next_administrator_bundle_hash: String,
}
impl Transition {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        for value in [&self.tenant, &self.operation, &self.next_administrator] {
            identifier(value)?;
        }
        revision(&self.generation)?;
        revision(&self.catalog_version)?;
        for value in [
            &self.challenge,
            &self.catalog_hash,
            &self.previous_authority_certificate_hash,
            &self.next_recovery_encryption_key,
            &self.next_recovery_signing_key,
            &self.next_authority_signing_key,
            &self.next_administrator_bundle_hash,
        ] {
            sized::<32>(value)?;
        }
        Ok(frame(
            "sortsys/recovery-transition/v1",
            &[
                &self.tenant,
                &self.generation,
                &self.operation,
                &self.challenge,
                &self.catalog_version,
                &self.catalog_hash,
                &self.previous_authority_certificate_hash,
                &self.next_recovery_encryption_key,
                &self.next_recovery_signing_key,
                &self.next_authority_signing_key,
                &self.next_administrator,
                &self.next_administrator_bundle_hash,
            ],
        ))
    }
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryPlan {
    challenge_id: String,
    source_authority: AuthorityCertificate,
    transition: Transition,
    next_setup: SetupInput,
    username: String,
    registration_record: String,
    vault: AccountVault,
    old_key_envelopes: Vec<SealedBox>,
    domains: Vec<DomainDefinition>,
    proof: String,
    next_proof: String,
}
impl RecoveryPlan {
    fn bundle_hash(&self) -> RpcResult<String> {
        let old_keys = self
            .old_key_envelopes
            .iter()
            .map(|e| packet_hash(e.frame()?, &e.signature))
            .collect::<RpcResult<Vec<_>>>()?;
        let domains = self
            .domains
            .iter()
            .map(|d| packet_hash(d.frame()?, &d.proof))
            .collect::<RpcResult<Vec<_>>>()?;
        Ok(encode(&Sha256::digest(frame(
            "sortsys/recovery-bundle/v1",
            &[
                &self.username,
                &encode(&Sha256::digest(decode(&self.registration_record, 4096)?)),
                &packet_hash(self.next_setup.frame()?, &self.next_setup.proof)?,
                &encode(&Sha256::digest(self.vault.frame())),
                &encode(&frame(
                    "sortsys/archivekeys/v1",
                    &old_keys.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
                &encode(&frame(
                    "sortsys/new-domains/v1",
                    &domains.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
            ],
        ))))
    }
    fn owner_id(&self) -> RpcResult<Id> {
        let value = self
            .transition
            .next_administrator
            .strip_prefix("user:")
            .ok_or_else(invalid)?;
        let id = Id::decode(value).map_err(|_| invalid())?;
        if id.0 <= 0 || id.encode() != value {
            return Err(invalid());
        }
        Ok(id)
    }
    fn validate(&self) -> RpcResult<()> {
        let t = &self.transition;
        identifier(&self.challenge_id)?;
        let generation = revision(&t.generation)?
            .checked_add(1)
            .ok_or_else(invalid)?;
        let policy = revision(&self.next_setup.policy.version)?;
        let owner = self.owner_id()?;
        if self.username != format!("recovery-{}", owner.encode())
            || self.domains.len() > 2000
            || self.old_key_envelopes.len() > 10000
        {
            return Err(invalid());
        }
        self.source_authority.verify()?;
        // Reject unauthenticated submissions before hashing large bundles or
        // checking thousands of envelopes. The source root is pinned by begin.
        verify(
            &sized::<32>(&self.source_authority.recovery_signing_key)?,
            &self.proof,
            &t.frame()?,
        )?;
        let next = &self.next_setup.authority;
        if self.source_authority.tenant != t.tenant
            || self.source_authority.generation != t.generation
            || next.tenant != t.tenant
            || next.generation != generation.to_string()
            || next.recovery_encryption_key != t.next_recovery_encryption_key
            || next.recovery_signing_key != t.next_recovery_signing_key
            || next.authority_signing_key != t.next_authority_signing_key
            || next.recovery_signing_key == self.source_authority.recovery_signing_key
            || next.recovery_encryption_key == self.source_authority.recovery_encryption_key
            || t.previous_authority_certificate_hash
                != packet_hash(
                    self.source_authority.frame()?,
                    &self.source_authority.signature,
                )?
            || t.catalog_hash
                != packet_hash(
                    self.next_setup.catalog.frame()?,
                    &self.next_setup.catalog.signature,
                )?
            || t.next_administrator_bundle_hash != self.bundle_hash()?
        {
            return Err(invalid());
        }
        verify(
            &sized::<32>(&self.source_authority.recovery_signing_key)?,
            &self.proof,
            &t.frame()?,
        )?;
        verify(
            &sized::<32>(&next.recovery_signing_key)?,
            &self.next_proof,
            &t.frame()?,
        )?;
        self.vault.validate()?;
        validate_registration(&self.registration_record)?;
        if self.vault.tenant != t.tenant || self.vault.username != self.username {
            return Err(invalid());
        }
        let scopes = self
            .domains
            .iter()
            .map(|d| (d.scope.clone(), d.facet))
            .collect::<Vec<_>>();
        self.next_setup.validate_for(
            &t.tenant,
            &t.next_administrator,
            &sized::<32>(&self.vault.encryption_key)?,
            &sized::<32>(&self.vault.signing_key)?,
            generation,
            policy,
            &scopes,
        )?;
        let authority = sized::<32>(&next.authority_signing_key)?;
        let author = format!("authority:{generation}");
        let recipient = format!("recovery:{generation}");
        let mut ids = HashSet::new();
        for domain in &self.domains {
            if !ids.insert(&domain.id)
                || domain.tenant != t.tenant
                || domain.policy_version != self.next_setup.policy.version
                || domain.envelopes.len() != 1
                || domain.envelopes[0].recipient != t.next_administrator
                || domain.recovery_envelope.recipient != recipient
            {
                return Err(invalid());
            }
            verify(&authority, &domain.proof, &domain.frame()?)?;
            for box_ in domain
                .envelopes
                .iter()
                .chain(std::iter::once(&domain.recovery_envelope))
            {
                if box_.tenant != t.tenant
                    || box_.purpose != "area-key"
                    || box_.object != domain.id
                    || box_.generation != domain.generation
                    || box_.author != author
                {
                    return Err(invalid());
                }
                box_.verify(&authority)?;
            }
        }
        let mut versions = HashSet::new();
        for box_ in &self.old_key_envelopes {
            if box_.tenant != t.tenant
                || box_.purpose != "area-key"
                || box_.author != author
                || box_.recipient != t.next_administrator
                || !ids.contains(&box_.object)
                || !versions.insert((&box_.object, &box_.generation))
            {
                return Err(invalid());
            }
            box_.verify(&authority)?;
        }
        Ok(())
    }
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct TenantInput {
    tenant: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct InspectInput {
    tenant: String,
    generation: String,
    nonce: String,
    proof: String,
}
#[derive(Serialize, TS)]
struct RecoveryHead {
    phase: String,
    generation: String,
    authority: AuthorityCertificate,
    operation: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationInput {
    tenant: String,
    challenge_id: String,
    username: String,
    registration_request: String,
    proof: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct RegistrationOutput {
    registration_response: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ResumeInput {
    tenant: String,
    operation: String,
}
#[derive(Clone, Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
struct DomainInfo {
    id: String,
    scope: String,
    facet: Facet,
    generation: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct RecoverySource {
    challenge_id: String,
    challenge: String,
    authority: AuthorityCertificate,
    catalog: SealedBox,
    catalog_version: String,
    policy_version: String,
    domains: Vec<DomainInfo>,
    keys: Vec<SealedBox>,
    created_domains: Vec<DomainDefinition>,
}
#[derive(FromRow)]
struct Head {
    generation: i64,
    phase: String,
    certificate: Value,
    operation: Option<String>,
    prepared_plan: Option<Value>,
    source_phase: Option<String>,
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let inspect = Arc::clone(&state);
    let public_head = Arc::clone(&state);
    let registration = Arc::clone(&state);
    let begin = Arc::clone(&state);
    builder
        .query("zerotrust.recovery.head", move |_, input: TenantInput| {
            let state = Arc::clone(&public_head);
            async move { public_recovery_head(&state, input).await }
        })
        .mutation(
            "zerotrust.recovery.inspect",
            move |_, input: InspectInput| {
                let state = Arc::clone(&inspect);
                async move { source(&state, input).await }
            },
        )
        .mutation(
            "zerotrust.recovery.registration",
            move |_, input: RegistrationInput| {
                let state = Arc::clone(&registration);
                async move { registration_response(&state, input).await }
            },
        )
        .mutation("zerotrust.recovery.begin", move |_, input: RecoveryPlan| {
            let state = Arc::clone(&begin);
            async move { begin_recovery(&state, input).await }
        })
        .mutation("zerotrust.recovery.resume", move |_, input: ResumeInput| {
            let state = Arc::clone(&state);
            async move { resume(&state, input).await }
        })
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<TenantInput, RecoveryHead>("zerotrust.recovery.head")
        .mutation_stub::<InspectInput, RecoverySource>("zerotrust.recovery.inspect")
        .mutation_stub::<RegistrationInput, RegistrationOutput>("zerotrust.recovery.registration")
        .mutation_stub::<RecoveryPlan, Success>("zerotrust.recovery.begin")
        .mutation_stub::<ResumeInput, Success>("zerotrust.recovery.resume")
}
async fn head(pool: &PgPool, tenant: &str) -> RpcResult<Head> {
    sqlx::query_as("SELECT generation,phase,certificate,operation,prepared_plan,source_phase FROM __zerotrust_recovery_heads WHERE tenant=$1").bind(tenant).fetch_optional(pool).await.map_err(internal)?.ok_or_else(not_found)
}
async fn public_recovery_head(state: &AppState, input: TenantInput) -> RpcResult<RecoveryHead> {
    identifier(&input.tenant)?;
    let head = head(state.tenants.master(), &input.tenant).await?;
    let pool = state
        .tenants
        .tenant_pool(&input.tenant)
        .await
        .map_err(internal)?;
    let (tenant_phase, tenant_generation, operation): (String, i64, Option<String>) =
        sqlx::query_as(
            "SELECT phase,generation,recovery_operation FROM __zerotrust_state WHERE singleton",
        )
        .fetch_one(&pool)
        .await
        .map_err(internal)?;
    let (phase, operation) = if head.phase == "rekeying" {
        (head.phase, head.operation)
    } else if tenant_phase == "recovery_prepared" && tenant_generation == head.generation {
        (tenant_phase, operation)
    } else {
        (head.phase, None)
    };
    Ok(RecoveryHead {
        phase,
        generation: head.generation.to_string(),
        authority: serde_json::from_value(head.certificate).map_err(|_| invalid())?,
        operation,
    })
}
async fn source(state: &AppState, input: InspectInput) -> RpcResult<RecoverySource> {
    identifier(&input.tenant)?;
    sized::<32>(&input.nonce)?;
    let initial = head(state.tenants.master(), &input.tenant).await?;
    if revision(&input.generation)? != initial.generation || initial.phase == "rekeying" {
        return Err(conflict());
    }
    let certificate: AuthorityCertificate =
        serde_json::from_value(initial.certificate).map_err(|_| invalid())?;
    verify(
        &sized::<32>(&certificate.recovery_signing_key)?,
        &input.proof,
        &frame(
            "sortsys/recovery-inspect/v1",
            &[&input.tenant, &input.generation, &input.nonce],
        ),
    )?;
    let pool = state
        .tenants
        .tenant_pool(&input.tenant)
        .await
        .map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (phase,generation,catalog_version,policy_version):(String,i64,i64,i64)=sqlx::query_as("SELECT phase,generation,catalog_version,policy_version FROM __zerotrust_state WHERE singleton FOR SHARE").fetch_one(&mut *tx).await.map_err(internal)?;
    let head = head(state.tenants.master(), &input.tenant).await?;
    if !["enrolling", "active"].contains(&phase.as_str())
        || head.generation != generation
        || head.phase == "rekeying"
    {
        return Err(conflict());
    }
    // Hard bounds are explicit: never present a truncated catalog as complete.
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT id,scope,facet,generation FROM __zerotrust_domains ORDER BY id LIMIT 2001",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(internal)?;
    if rows.len() > 2000 {
        return Err(conflict());
    }
    let domains = rows
        .into_iter()
        .map(|(id, scope, facet, generation)| {
            Ok(DomainInfo {
                id,
                scope,
                facet: serde_json::from_value(Value::String(facet)).map_err(|_| invalid())?,
                generation: generation.to_string(),
            })
        })
        .collect::<RpcResult<Vec<_>>>()?;
    let keys:Vec<(String,i64,Value)>=sqlx::query_as("SELECT domain_id,domain_generation,definition FROM __zerotrust_recovery_keys WHERE tenant=$1 AND recovery_generation=$2 ORDER BY domain_id,domain_generation LIMIT 10001").bind(&input.tenant).bind(generation).fetch_all(state.tenants.master()).await.map_err(internal)?;
    if keys.len() > 10000 {
        return Err(conflict());
    }
    let catalog: Value = sqlx::query_scalar(
        "SELECT catalog FROM __zerotrust_recovery_heads WHERE tenant=$1 AND generation=$2",
    )
    .bind(&input.tenant)
    .bind(generation)
    .fetch_one(state.tenants.master())
    .await
    .map_err(internal)?;
    let id = random_id()?;
    let mut nonce = [0; 32];
    getrandom::fill(&mut nonce).map_err(|_| invalid())?;
    let mut master = state.tenants.master().begin().await.map_err(internal)?;
    // Serialize the quota across independent API instances.
    let locked_generation: i64 = sqlx::query_scalar(
        "SELECT generation FROM __zerotrust_recovery_heads WHERE tenant=$1 FOR UPDATE",
    )
    .bind(&input.tenant)
    .fetch_one(&mut *master)
    .await
    .map_err(internal)?;
    if locked_generation != generation {
        return Err(conflict());
    }
    sqlx::query("DELETE FROM __zerotrust_recovery_challenges WHERE tenant=$1 AND expires_at<now()")
        .bind(&input.tenant)
        .execute(&mut *master)
        .await
        .map_err(internal)?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM __zerotrust_recovery_challenges WHERE tenant=$1")
            .bind(&input.tenant)
            .fetch_one(&mut *master)
            .await
            .map_err(internal)?;
    if count >= 128 {
        return Err(
            RpcError::new(ErrorCode::TooManyRequests, "Too many recovery challenges")
                .with_http_code(429),
        );
    }
    sqlx::query("INSERT INTO __zerotrust_recovery_challenges(id,tenant,generation,nonce) VALUES($1,$2,$3,$4)").bind(&id).bind(&input.tenant).bind(generation).bind(nonce.to_vec()).execute(&mut *master).await.map_err(internal)?;
    master.commit().await.map_err(internal)?;
    let definitions = keys
        .into_iter()
        .filter(|(id, version, _)| {
            domains.iter().any(|domain| {
                domain.id == *id
                    && revision(&domain.generation).is_ok_and(|current| *version <= current)
            })
        })
        .map(|(_, _, value)| serde_json::from_value(value).map_err(|_| invalid()))
        .collect::<RpcResult<Vec<DomainDefinition>>>()?;
    let keys = definitions
        .iter()
        .map(|definition| definition.recovery_envelope.clone())
        .collect();
    let created_domains = definitions
        .into_iter()
        .filter(|definition| definition.creation.is_some())
        .collect();
    Ok(RecoverySource {
        challenge_id: id,
        challenge: encode(&nonce),
        authority: serde_json::from_value(head.certificate).map_err(|_| invalid())?,
        catalog: serde_json::from_value(catalog).map_err(|_| invalid())?,
        catalog_version: catalog_version.to_string(),
        policy_version: policy_version.to_string(),
        domains,
        keys,
        created_domains,
    })
}
async fn challenge(pool: &PgPool, tenant: &str, id: &str, generation: i64) -> RpcResult<Vec<u8>> {
    sqlx::query_scalar("SELECT nonce FROM __zerotrust_recovery_challenges WHERE tenant=$1 AND id=$2 AND generation=$3 AND expires_at>now()")
        .bind(tenant).bind(id).bind(generation).fetch_optional(pool).await.map_err(internal)?.ok_or_else(conflict)
}
async fn registration_response(
    state: &AppState,
    input: RegistrationInput,
) -> RpcResult<RegistrationOutput> {
    for id in [&input.tenant, &input.challenge_id, &input.username] {
        identifier(id)?;
    }
    if input.username.len() > 63 || !input.username.starts_with("recovery-") {
        return Err(invalid());
    }
    let head = head(state.tenants.master(), &input.tenant).await?;
    if head.phase == "rekeying" {
        return Err(conflict());
    }
    challenge(
        state.tenants.master(),
        &input.tenant,
        &input.challenge_id,
        head.generation,
    )
    .await?;
    let root: AuthorityCertificate =
        serde_json::from_value(head.certificate).map_err(|_| invalid())?;
    verify(
        &sized::<32>(&root.recovery_signing_key)?,
        &input.proof,
        &frame(
            "sortsys/recovery-registration/v1",
            &[
                &input.tenant,
                &input.challenge_id,
                &input.username,
                &input.registration_request,
            ],
        ),
    )?;
    Ok(RegistrationOutput {
        registration_response: recovery_registration(
            state.tenants.master(),
            &input.tenant,
            &input.username,
            &input.registration_request,
        )
        .await?,
    })
}

async fn begin_recovery(state: &AppState, input: RecoveryPlan) -> RpcResult<Success> {
    let tenant = &input.transition.tenant;
    identifier(tenant)?;
    let generation = revision(&input.transition.generation)?;
    let current = head(state.tenants.master(), tenant).await?;
    let value = serde_json::to_value(&input).map_err(internal)?;
    if current.operation.as_deref() == Some(&input.transition.operation) {
        if current.prepared_plan.as_ref() != Some(&value) {
            return Err(conflict());
        }
        return resume(
            state,
            ResumeInput {
                tenant: tenant.clone(),
                operation: input.transition.operation.clone(),
            },
        )
        .await;
    }
    if current.generation != generation
        || current.phase == "rekeying"
        || current.certificate != serde_json::to_value(&input.source_authority).map_err(internal)?
    {
        return Err(conflict());
    }
    validate_plan(&input).await?;
    let pool = state.tenants.tenant_pool(tenant).await.map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (phase,current_generation,catalog,policy,prepared):(String,i64,i64,i64,Option<Value>)=sqlx::query_as("SELECT phase,generation,catalog_version,policy_version,recovery_plan FROM __zerotrust_state WHERE singleton FOR UPDATE").fetch_one(&mut *tx).await.map_err(internal)?;
    if phase == "recovery_prepared" && prepared.as_ref() == Some(&value) {
        tx.commit().await.map_err(internal)?;
        return consume(state, &pool, input, current.phase).await;
    }
    if !["enrolling", "active"].contains(&phase.as_str())
        || current_generation != generation
        || catalog != revision(&input.transition.catalog_version)?
        || policy.checked_add(1) != Some(revision(&input.next_setup.policy.version)?)
    {
        return Err(conflict());
    }
    if challenge(
        state.tenants.master(),
        tenant,
        &input.challenge_id,
        generation,
    )
    .await?
        != sized::<32>(&input.transition.challenge)?
    {
        return Err(invalid());
    }
    let domains: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT id,scope,facet,generation FROM __zerotrust_domains ORDER BY id")
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
    if domains.len() != input.domains.len()
        || domains.iter().any(|(id, scope, facet, old)| {
            !input.domains.iter().any(|d| {
                &d.id == id
                    && &d.scope == scope
                    && d.facet.name() == facet
                    && old
                        .checked_add(1)
                        .is_some_and(|next| d.generation == next.to_string())
            })
        })
    {
        return Err(conflict());
    }
    let collision: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 OR username=$2)")
            .bind(input.owner_id()?.0)
            .bind(&input.username)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    if collision {
        return Err(conflict());
    }
    // Every known historical key must have an archive envelope for the new owner. The
    // server can check coverage, not whether either ciphertext holds that key.
    for (id, _, _, old) in &domains {
        if !input
            .old_key_envelopes
            .iter()
            .any(|e| e.object == *id && e.generation == old.to_string())
        {
            return Err(invalid());
        }
    }
    for box_ in &input.old_key_envelopes {
        if !domains.iter().any(|(id, _, _, current)| {
            box_.object == *id && revision(&box_.generation).is_ok_and(|n| n <= *current)
        }) {
            return Err(invalid());
        }
    }
    let historical:Vec<(String,i64)>=sqlx::query_as("SELECT DISTINCT domain_id,domain_generation FROM __zerotrust_recovery_keys WHERE tenant=$1 ORDER BY domain_id,domain_generation LIMIT 10001")
        .bind(tenant).fetch_all(state.tenants.master()).await.map_err(internal)?;
    if historical.len() > 10000 {
        return Err(conflict());
    }
    for (id, version) in historical {
        if domains
            .iter()
            .any(|(current, _, _, generation)| current == &id && version <= *generation)
            && !input
                .old_key_envelopes
                .iter()
                .any(|e| e.object == id && e.generation == version.to_string())
        {
            return Err(invalid());
        }
    }
    sqlx::query("UPDATE __zerotrust_state SET phase='recovery_prepared',recovery_operation=$1,recovery_plan=$2,updated_at=now() WHERE singleton").bind(&input.transition.operation).bind(&value).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    consume(state, &pool, input, phase).await
}

async fn consume(
    state: &AppState,
    pool: &PgPool,
    input: RecoveryPlan,
    source_phase: String,
) -> RpcResult<Success> {
    validate_plan(&input).await?;
    let value = serde_json::to_value(&input).map_err(internal)?;
    let t = &input.transition;
    let generation = revision(&t.generation)?
        .checked_add(1)
        .ok_or_else(invalid)?;
    let mut master = state.tenants.master().begin().await.map_err(internal)?;
    let current:Head=sqlx::query_as("SELECT generation,phase,certificate,operation,prepared_plan,source_phase FROM __zerotrust_recovery_heads WHERE tenant=$1 FOR UPDATE").bind(&t.tenant).fetch_one(&mut *master).await.map_err(internal)?;
    if current.operation.as_deref() != Some(&t.operation) {
        if current.generation != generation - 1
            || current.phase == "rekeying"
            || current.certificate
                != serde_json::to_value(&input.source_authority).map_err(internal)?
        {
            return Err(conflict());
        }
        let consumed=sqlx::query("DELETE FROM __zerotrust_recovery_challenges WHERE tenant=$1 AND id=$2 AND generation=$3 AND nonce=$4").bind(&t.tenant).bind(&input.challenge_id).bind(generation-1).bind(sized::<32>(&t.challenge)?.to_vec()).execute(&mut *master).await.map_err(internal)?;
        if consumed.rows_affected() != 1 {
            return Err(conflict());
        }
        sqlx::query("INSERT INTO __zerotrust_recovery_history(tenant,generation,operation,source_phase,plan) VALUES($1,$2,$3,$4,$5)").bind(&t.tenant).bind(generation).bind(&t.operation).bind(&source_phase).bind(&value).execute(&mut *master).await.map_err(internal)?;
        for domain in &input.domains {
            sqlx::query("INSERT INTO __zerotrust_recovery_keys(tenant,domain_id,domain_generation,recovery_generation,definition) VALUES($1,$2,$3,$4,$5)").bind(&t.tenant).bind(&domain.id).bind(revision(&domain.generation)?).bind(generation).bind(serde_json::to_value(domain).map_err(internal)?).execute(&mut *master).await.map_err(internal)?;
        }
        sqlx::query("UPDATE __zerotrust_recovery_heads SET generation=$1,catalog_version=$2,recovery_encryption_key=$3,recovery_signing_key=$4,authority_key=$5,certificate=$6,catalog=$7,phase='rekeying',operation=$8,prepared_plan=$9,source_phase=$10,updated_at=now() WHERE tenant=$11")
            .bind(generation).bind(revision(&t.catalog_version)?.checked_add(1).ok_or_else(invalid)?).bind(sized::<32>(&t.next_recovery_encryption_key)?.to_vec()).bind(sized::<32>(&t.next_recovery_signing_key)?.to_vec()).bind(sized::<32>(&t.next_authority_signing_key)?.to_vec()).bind(serde_json::to_value(&input.next_setup.authority).map_err(internal)?).bind(serde_json::to_value(&input.next_setup.catalog).map_err(internal)?).bind(&t.operation).bind(&value).bind(&source_phase).bind(&t.tenant).execute(&mut *master).await.map_err(internal)?;
    } else if current.prepared_plan.as_ref() != Some(&value) {
        return Err(conflict());
    }
    master.commit().await.map_err(internal)?;
    apply(pool, &input, &source_phase).await?;
    let mut master = state.tenants.master().begin().await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_recovery_heads SET phase=$1,updated_at=now() WHERE tenant=$2 AND generation=$3 AND operation=$4 AND phase='rekeying'").bind(&source_phase).bind(&t.tenant).bind(generation).bind(&t.operation).execute(&mut *master).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_recovery_history SET applied_at=COALESCE(applied_at,now()) WHERE tenant=$1 AND operation=$2").bind(&t.tenant).bind(&t.operation).execute(&mut *master).await.map_err(internal)?;
    master.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}

async fn apply(pool: &PgPool, input: &RecoveryPlan, source_phase: &str) -> RpcResult<()> {
    let t = &input.transition;
    let generation = revision(&t.generation)?
        .checked_add(1)
        .ok_or_else(invalid)?;
    let policy = revision(&input.next_setup.policy.version)?;
    let value = serde_json::to_value(input).map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (phase,old,operation,prepared):(String,i64,Option<String>,Option<Value>)=sqlx::query_as("SELECT phase,generation,recovery_operation,recovery_plan FROM __zerotrust_state WHERE singleton FOR UPDATE").fetch_one(&mut *tx).await.map_err(internal)?;
    if old == generation
        && operation.as_deref() == Some(&t.operation)
        && prepared.as_ref() == Some(&value)
        && ["active", "enrolling"].contains(&phase.as_str())
    {
        return Ok(());
    }
    if phase != "recovery_prepared"
        || old != generation - 1
        || operation.as_deref() != Some(&t.operation)
        || prepared.as_ref() != Some(&value)
    {
        return Err(conflict());
    }
    let owner = input.owner_id()?.0;
    // The seed-authorized immutable plan may create the replacement account
    // while the database rejects ordinary legacy business writes.
    sqlx::query("SELECT set_config('sortsys.zerotrust_control','recovery',TRUE)")
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO users(id,username,first_name,deactivated_at,password) VALUES($1,$2,'Wiederherstellung',NULL,NULL)").bind(owner).bind(&input.username).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO user_role_assignments(user_id,role_name) VALUES($1,':admin')")
        .bind(owner)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_accounts(user_id,opaque_record,account_vault,encryption_key,signing_key,identity_certificate) VALUES($1,$2,$3,$4,$5,$6)").bind(owner).bind(validate_registration(&input.registration_record)?).bind(serde_json::to_value(&input.vault).map_err(internal)?).bind(sized::<32>(&input.vault.encryption_key)?.to_vec()).bind(sized::<32>(&input.vault.signing_key)?.to_vec()).bind(serde_json::to_value(&input.next_setup.owner).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    let public_transition = serde_json::json!({"sourceAuthority":input.source_authority,"transition":input.transition,"proof":input.proof,"nextProof":input.next_proof});
    sqlx::query(
        "INSERT INTO __zerotrust_authorities(generation,certificate,transition) VALUES($1,$2,$3)",
    )
    .bind(generation)
    .bind(serde_json::to_value(&input.next_setup.authority).map_err(internal)?)
    .bind(public_transition)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_identity_history(subject,generation,signing_key,certificate) VALUES($1,$2,$3,$4)").bind(&t.next_administrator).bind(generation).bind(sized::<32>(&input.vault.signing_key)?.to_vec()).bind(serde_json::to_value(&input.next_setup.owner).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query(
        "INSERT INTO __zerotrust_policies(version,generation,policy,signature) VALUES($1,$2,$3,$4)",
    )
    .bind(policy)
    .bind(generation)
    .bind(serde_json::to_value(&input.next_setup.policy).map_err(internal)?)
    .bind(sized::<64>(&input.next_setup.policy.signature)?.to_vec())
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    for box_ in &input.old_key_envelopes {
        sqlx::query("INSERT INTO __zerotrust_key_envelopes(domain_id,generation,recipient,envelope) VALUES($1,$2,$3,$4)").bind(&box_.object).bind(revision(&box_.generation)?).bind(&box_.recipient).bind(serde_json::to_value(box_).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    }
    for domain in &input.domains {
        let readers = Sha256::digest(frame("sortsys/readers/v1", &[&t.next_administrator]));
        sqlx::query("UPDATE __zerotrust_domains SET readers_hash=$1,generation=$2,policy_version=$3,rotation_required=FALSE,head_sequence=nextval(pg_get_serial_sequence('__zerotrust_changes','seq')) WHERE id=$4").bind(readers.to_vec()).bind(revision(&domain.generation)?).bind(policy).bind(&domain.id).execute(&mut *tx).await.map_err(internal)?;
        for box_ in &domain.envelopes {
            sqlx::query("INSERT INTO __zerotrust_key_envelopes(domain_id,generation,recipient,envelope) VALUES($1,$2,$3,$4)").bind(&domain.id).bind(revision(&domain.generation)?).bind(&box_.recipient).bind(serde_json::to_value(box_).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
        }
        sqlx::query("INSERT INTO __zerotrust_recovery_catalog(domain_id,domain_generation,recovery_generation,envelope) VALUES($1,$2,$3,$4)").bind(&domain.id).bind(revision(&domain.generation)?).bind(generation).bind(serde_json::to_value(&domain.recovery_envelope).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query(
        "UPDATE user_sessions SET expires_at=LEAST(expires_at,now()) WHERE expires_at>now()",
    )
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_state SET phase=$1,generation=$2,policy_version=$3,catalog_version=catalog_version+1,authority_key=$4,recovery_encryption_key=$5,recovery_signing_key=$6,protected_profile=$7,updated_at=now() WHERE singleton").bind(source_phase).bind(generation).bind(policy).bind(sized::<32>(&t.next_authority_signing_key)?.to_vec()).bind(sized::<32>(&t.next_recovery_encryption_key)?.to_vec()).bind(sized::<32>(&t.next_recovery_signing_key)?.to_vec()).bind(serde_json::to_value(&input.next_setup).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("SELECT pg_notify('sortsys_zerotrust',$1)")
        .bind(
            serde_json::json!({"kind":"recovery","generation":generation.to_string()}).to_string(),
        )
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(())
}

async fn resume(state: &AppState, input: ResumeInput) -> RpcResult<Success> {
    identifier(&input.tenant)?;
    identifier(&input.operation)?;
    let current = head(state.tenants.master(), &input.tenant).await?;
    let pool = state
        .tenants
        .tenant_pool(&input.tenant)
        .await
        .map_err(internal)?;
    if current.operation.as_deref() == Some(&input.operation) {
        let plan: RecoveryPlan =
            serde_json::from_value(current.prepared_plan.ok_or_else(conflict)?)
                .map_err(|_| invalid())?;
        return consume(
            state,
            &pool,
            plan,
            current.source_phase.ok_or_else(conflict)?,
        )
        .await;
    }
    let prepared:Option<Value>=sqlx::query_scalar("SELECT recovery_plan FROM __zerotrust_state WHERE singleton AND phase='recovery_prepared' AND recovery_operation=$1").bind(&input.operation).fetch_optional(&pool).await.map_err(internal)?.flatten();
    let plan: RecoveryPlan =
        serde_json::from_value(prepared.ok_or_else(conflict)?).map_err(|_| invalid())?;
    consume(state, &pool, plan, current.phase).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_recovery_plan_requires_both_roots_and_binds_every_replacement() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-recovery.json"))
                .unwrap();
        let input: RecoveryPlan = serde_json::from_value(fixture["plan"].clone()).unwrap();
        input.validate().unwrap();
        let mut changed = input.clone();
        changed.domains.clear();
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.old_key_envelopes.clear();
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.username.push('a');
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.next_proof = input.proof.clone();
        assert!(changed.validate().is_err());
        let mut changed = input.clone();
        changed.transition.catalog_version = "999".into();
        assert!(changed.validate().is_err());
        let mut changed = fixture["plan"].clone();
        changed["seedPhrase"] = serde_json::json!("unaccepted secret");
        assert!(serde_json::from_value::<RecoveryPlan>(changed).is_err());
    }
}
