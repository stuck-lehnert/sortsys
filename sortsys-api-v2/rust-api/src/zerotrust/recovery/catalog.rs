//! Immutable encrypted archive blocks. Only a proof from the current recovery
//! signing key grants access; an account, password reset or provider role cannot.
use super::*;
use sortsys_zerotrust::recovery::{CatalogAction, RecoveryCatalogAccess};

const MAX_PAGE_BYTES: usize = 64 * 1024;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    access: RecoveryCatalogAccess,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct WriteInput {
    access: RecoveryCatalogAccess,
    proof: String,
    packet: SealedBox,
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let reader = Arc::clone(&service);
    builder
        .mutation(
            "zerotrust.recovery.catalog.read",
            move |_, input: ReadInput| {
                let service = Arc::clone(&reader);
                async move { read(&service, input).await }
            },
        )
        .mutation(
            "zerotrust.recovery.catalog.write",
            move |_, input: WriteInput| {
                let service = Arc::clone(&service);
                async move { write(&service, input).await }
            },
        )
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<ReadInput, SealedBox>("zerotrust.recovery.catalog.read")
        .mutation_stub::<WriteInput, Success>("zerotrust.recovery.catalog.write")
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogPage {
    challenge_id: String,
    hash: String,
    packet: SealedBox,
}
fn record_key(access: &RecoveryCatalogAccess) -> RpcResult<sortsys_zerotrust::metadata::RecordKey> {
    identifier(&access.object)?;
    Ok(crate::control::key(
        &format!(
            "recovery-catalog-pages-{}",
            revision(&access.target_generation)?
        ),
        &access.object,
    ))
}

/// Only a published catalog needs independent retention. Abandoned uploads
/// must not become permanent merely because a recovery attempt was started.
pub(super) async fn protect_published_pages(
    transaction: &mut crate::control::Transaction,
    challenge_id: &str,
    authority: &AuthorityCertificate,
) -> RpcResult<()> {
    let collection = format!(
        "recovery-catalog-pages-{}",
        revision(&authority.generation)?
    );
    let signer = sized::<32>(&authority.authority_signing_key)?;
    let mut after = None;
    loop {
        let page = transaction.scan::<CatalogPage>(&collection, after).await?;
        for row in page.records {
            let stored = row.value.ok_or_else(invalid)?;
            if stored.challenge_id != challenge_id {
                continue;
            }
            if stored.packet.tenant != authority.tenant
                || stored.packet.generation != authority.generation
                || stored.packet.object != row.record.key
                || stored.packet.recipient != format!("recovery:{}", authority.generation)
                || stored.packet.author != format!("authority:{}", authority.generation)
                || stored.packet.purpose != "recovery-catalog"
                || packet_hash(stored.packet.frame()?, &stored.packet.signature)? != stored.hash
            {
                return Err(invalid());
            }
            stored.packet.verify(&signer)?;
            transaction.protect_record(row.record).await?;
        }
        after = page.after;
        if after.is_none() {
            return Ok(());
        }
    }
}
async fn authorize(
    service: &crate::auth::AuthService,
    access: &RecoveryCatalogAccess,
    proof: &str,
    action: CatalogAction,
) -> RpcResult<crate::control::Transaction> {
    let message = access.frame()?;
    if access.action != action {
        return Err(invalid());
    }
    let repository = persistence::repository(service, &access.tenant).await?;
    let mut transaction = repository.transaction()?;
    let root = super::super::setup::metadata_root(&mut transaction, &access.tenant).await?;
    if root.profile.authority.generation != access.generation {
        return Err(conflict());
    }
    let challenge = persistence::challenge(&mut transaction, &root, &access.challenge_id).await?;
    if challenge.nonce != access.challenge {
        return Err(conflict());
    }
    verify(
        &sized::<32>(&root.profile.authority.recovery_signing_key)?,
        proof,
        &message,
    )?;
    Ok(transaction)
}
fn check_packet(access: &RecoveryCatalogAccess, packet: &SealedBox) -> RpcResult<()> {
    if decode(&packet.ciphertext, MAX_PAGE_BYTES + 16)?.len() < 16
        || packet.tenant != access.tenant
        || packet.generation != access.target_generation
        || packet.object != access.object
        || packet.purpose != "recovery-catalog"
        || packet.author != format!("authority:{}", access.target_generation)
        || packet.recipient != format!("recovery:{}", access.target_generation)
        || packet_hash(packet.frame()?, &packet.signature)? != access.hash
    {
        return Err(invalid());
    }
    Ok(())
}
async fn read(service: &crate::auth::AuthService, input: ReadInput) -> RpcResult<SealedBox> {
    let _admission = crate::auth_limits::admit_login()?;
    let access = &input.access;
    let mut transaction = authorize(service, access, &input.proof, CatalogAction::Read).await?;
    let row: CatalogPage = transaction
        .read(record_key(access)?)
        .await?
        .ok_or_else(not_found)?;
    if row.hash != access.hash
        || revision(&access.target_generation)? > revision(&access.generation)?
            && row.challenge_id != access.challenge_id
    {
        return Err(conflict());
    }
    check_packet(access, &row.packet)?;
    transaction.validate().await?;
    Ok(row.packet)
}
async fn write(service: &crate::auth::AuthService, input: WriteInput) -> RpcResult<Success> {
    let _admission = crate::auth_limits::admit_login()?;
    let access = &input.access;
    check_packet(access, &input.packet)?;
    let mut transaction = authorize(service, access, &input.proof, CatalogAction::Write).await?;
    let record = record_key(access)?;
    let page = CatalogPage {
        challenge_id: access.challenge_id.clone(),
        hash: access.hash.clone(),
        packet: input.packet,
    };
    if let Some(stored) = transaction.read::<CatalogPage>(record.clone()).await? {
        if serde_json::to_value(stored).map_err(internal)?
            != serde_json::to_value(&page).map_err(internal)?
        {
            return Err(conflict());
        }
        transaction.validate().await?;
    } else {
        transaction.put(record, &page).await?;
        transaction.commit().await?;
    }
    Ok(Success { success: true })
}
