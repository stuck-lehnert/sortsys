//! Recovery uploads are invisible staging records. The existing seed-signed
//! transition authorizes this operation; only the complete, independently
//! verified plan can publish new roots, keys and accounts.
use super::super::setup;
use super::*;
use crate::{
    auth::AuthService,
    control::{Transaction, key},
};
use sortsys_zerotrust::prepared_payload::{PreparedPayloadManifest, part_hash};

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadAuthorization {
    challenge_id: String,
    source_authority: AuthorityCertificate,
    transition: Transition,
    proof: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct StageInput {
    authorization: UploadAuthorization,
    manifest: PreparedPayloadManifest,
    content: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CommitInput {
    authorization: UploadAuthorization,
    manifest: PreparedPayloadManifest,
}

#[derive(Serialize, TS)]
struct PartReceipt {
    hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UploadState {
    proof: String,
    manifest: PreparedPayloadManifest,
}

impl UploadAuthorization {
    fn identity(&self) -> RpcResult<String> {
        identifier(&self.transition.operation)?;
        identifier(&self.challenge_id)?;
        let fingerprint = crate::control::fingerprint(&encode(&frame(
            "sortsys/recovery-upload/v1",
            &[&self.transition.tenant, &self.challenge_id],
        )));
        Ok(format!("upload-{fingerprint}"))
    }

    fn matches(&self, plan: &RecoveryPlan) -> RpcResult<bool> {
        Ok(self.challenge_id == plan.challenge_id
            && self.source_authority.signature == plan.source_authority.signature
            && self.proof == plan.proof
            && self.transition.frame()? == plan.transition.frame()?)
    }
}

async fn authorize(
    service: &AuthService,
    authorization: &UploadAuthorization,
    manifest: &PreparedPayloadManifest,
) -> RpcResult<(Transaction, persistence::Challenge)> {
    manifest.validate()?;
    let transition = &authorization.transition;
    if manifest.context != transition.tenant || manifest.operation != transition.operation {
        return Err(invalid());
    }
    authorization.identity()?;
    let repository = persistence::repository(service, &transition.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = setup::metadata_root(&mut transaction, &transition.tenant).await?;
    if root.profile.authority.generation != transition.generation
        || root.catalog_version != transition.catalog_version
        || serde_json::to_value(&root.profile.authority).map_err(internal)?
            != serde_json::to_value(&authorization.source_authority).map_err(internal)?
    {
        return Err(conflict());
    }
    verify(
        &sized::<32>(&root.profile.authority.recovery_signing_key)?,
        &authorization.proof,
        &transition.frame()?,
    )?;
    let challenge =
        persistence::challenge(&mut transaction, &root, &authorization.challenge_id).await?;
    if challenge.nonce != transition.challenge {
        return Err(conflict());
    }
    Ok((transaction, challenge))
}

fn state_key(identity: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key("recovery-uploads", identity)
}
fn part_key(identity: &str, hash: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key("recovery-upload-parts", &format!("{identity}:{hash}"))
}

async fn stage_once(service: &AuthService, input: &StageInput, hash: &str) -> RpcResult<()> {
    let (mut transaction, challenge) =
        authorize(service, &input.authorization, &input.manifest).await?;
    let identity = input.authorization.identity()?;
    let state_key = state_key(&identity);
    if let Some(previous) = transaction.read::<UploadState>(state_key.clone()).await? {
        if previous.proof != input.authorization.proof || previous.manifest != input.manifest {
            return Err(conflict());
        }
    } else {
        transaction
            .put_expiring(
                state_key,
                &UploadState {
                    proof: input.authorization.proof.clone(),
                    manifest: input.manifest.clone(),
                },
                challenge.expires_at,
            )
            .await?;
    }
    let record = part_key(&identity, hash);
    if let Some(previous) = transaction.read::<String>(record.clone()).await? {
        if previous != input.content {
            return Err(conflict());
        }
    } else {
        transaction
            .put_expiring(record, &input.content, challenge.expires_at)
            .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn stage(service: &AuthService, input: StageInput) -> RpcResult<PartReceipt> {
    let _admission = crate::auth_limits::admit_login()?;
    let hash = part_hash(&input.content)?;
    input.manifest.validate()?;
    if !input.manifest.parts.contains(&hash) {
        return Err(invalid());
    }
    // Only first registration of this immutable manifest can race. Later parts
    // observe the same state without advancing a shared upload counter.
    for attempt in 0..4 {
        match stage_once(service, &input, &hash).await {
            Ok(()) => return Ok(PartReceipt { hash }),
            Err(error) if error.code == ErrorCode::Conflict && attempt < 3 => continue,
            Err(error) => return Err(error),
        }
    }
    Err(conflict())
}

async fn commit(service: &AuthService, input: CommitInput) -> RpcResult<Success> {
    let _admission = crate::auth_limits::admit_login()?;
    let permit = recovery_check_permit()?;
    let (mut transaction, _) = authorize(service, &input.authorization, &input.manifest).await?;
    let identity = input.authorization.identity()?;
    let state: UploadState = transaction
        .read(state_key(&identity))
        .await?
        .ok_or_else(not_found)?;
    if state.proof != input.authorization.proof || state.manifest != input.manifest {
        return Err(conflict());
    }
    let keys = input
        .manifest
        .parts
        .iter()
        .map(|hash| part_key(&identity, hash))
        .collect();
    let parts = transaction
        .many::<String>(keys)
        .await?
        .into_iter()
        .map(|part| part.ok_or_else(not_found))
        .collect::<RpcResult<Vec<_>>>()?;
    let manifest = input.manifest.clone();
    let plan: RecoveryPlan = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let encoded = manifest.assemble(&parts)?;
        serde_json::from_str(&encoded).map_err(|_| invalid())
    })
    .await
    .map_err(internal)??;
    if !input.authorization.matches(&plan)? {
        return Err(invalid());
    }
    transaction.validate().await?;
    drop(_admission);
    // This opens a fresh publication transaction and checks the complete source
    // snapshot again. Staged bytes never substitute for either seed signature.
    persistence::begin(service, plan).await
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let upload = Arc::clone(&service);
    builder
        .mutation("zerotrust.recovery.stage", move |_, input: StageInput| {
            let service = Arc::clone(&upload);
            async move { stage(&service, input).await }
        })
        .mutation("zerotrust.recovery.commit", move |_, input: CommitInput| {
            let service = Arc::clone(&service);
            async move { commit(&service, input).await }
        })
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<StageInput, PartReceipt>("zerotrust.recovery.stage")
        .mutation_stub::<CommitInput, Success>("zerotrust.recovery.commit")
}
