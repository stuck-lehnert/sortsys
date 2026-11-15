//! Invitation-bound OPAQUE registration. A reservation never resets a vault.
use super::*;

const PURPOSE: &str = "invitation-registration";
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationExchange {
    tenant: String,
    invitation: super::super::invitations::Invitation,
    user_id: i64,
    account_epoch: u64,
    tenant_epoch: u64,
    attempt_key: Vec<u8>,
    attempt_expires_at: DateTime<Utc>,
}
async fn start(
    service: &crate::auth::AuthService,
    input: InvitationStartInput,
) -> RpcResult<EnrollmentStartOutput> {
    let _admission = auth_limits::admit_login()?;
    crypto::identifier(&input.tenant)?;
    crypto::identifier(&input.invitation)?;
    let attempt = service
        .reserve_login("invitation", &[&input.tenant, &input.invitation])
        .await?;
    let repository = super::super::invitations::metadata_repository(service, &input.tenant).await?;
    let mut transaction = repository.transaction()?;
    let (row, account, _) = super::super::invitations::metadata_registration(
        &mut transaction,
        &input.tenant,
        &input.invitation,
    )
    .await?;
    if account.credential.is_some() {
        return Err(denied());
    }
    let status: accounts::TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(denied)?;
    let registration =
        RegistrationRequest::<Suite>::deserialize(&decode(&input.registration_request, 128)?)
            .map_err(|_| invalid())?;
    let credential_id = format!("{}/{}", input.tenant, account.username);
    let response = ServerRegistration::<Suite>::start(
        &store_setup(&repository).await?,
        registration,
        credential_id.as_bytes(),
    )
    .map_err(|_| invalid())?;
    transaction.validate().await?;
    let (attempt_key, attempt_expires_at) = attempt.reservation();
    let exchange = store_exchange(
        service,
        &repository,
        Some(input.tenant.clone()),
        PURPOSE,
        RegistrationExchange {
            tenant: input.tenant.clone(),
            invitation: row.invitation,
            user_id: account.id,
            account_epoch: account.epoch,
            tenant_epoch: status.epoch,
            attempt_key: attempt_key.to_vec(),
            attempt_expires_at,
        },
    )
    .await?;
    Ok(EnrollmentStartOutput {
        exchange,
        registration_response: encode(&response.message.serialize()),
        tenant: input.tenant,
        username: account.username,
    })
}
async fn finish(
    service: &crate::auth::AuthService,
    request: &RequestContext,
    input: InvitationFinishInput,
) -> RpcResult<LoginFinishOutput> {
    let _admission = auth_limits::admit_login()?;
    input.vault.validate()?;
    let upload =
        RegistrationUpload::<Suite>::deserialize(&decode(&input.registration_record, 4096)?)
            .map_err(|_| invalid())?;
    let record = ServerRegistration::<Suite>::finish(upload)
        .serialize()
        .to_vec();
    let ticket = read_store_ticket(service, &input.exchange, PURPOSE)?;
    let tenant = ticket.tenant.ok_or_else(denied)?;
    let repository = super::super::invitations::metadata_repository(service, &tenant).await?;
    let mut transaction = repository.transaction()?;
    let exchange_key = key(PURPOSE, &ticket.id);
    let stored: StoredExchange<RegistrationExchange> = transaction
        .read(exchange_key.clone())
        .await?
        .ok_or_else(denied)?;
    if stored.expires_at <= Utc::now() || stored.payload.tenant != tenant {
        return Err(denied());
    }
    let exchange = stored.payload;
    let (row, mut account, _) = super::super::invitations::metadata_registration(
        &mut transaction,
        &tenant,
        &exchange.invitation.id,
    )
    .await?;
    let status: accounts::TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(denied)?;
    if row.invitation.signature != exchange.invitation.signature
        || account.id != exchange.user_id
        || account.epoch != exchange.account_epoch
        || status.epoch != exchange.tenant_epoch
        || account.credential.is_some()
        || input.vault.tenant != tenant
        || input.vault.username != account.username
        || input.claim.revision != "1"
        || input.claim.encryption_key != input.vault.encryption_key
        || input.claim.signing_key != input.vault.signing_key
    {
        return Err(denied());
    }
    crypto::verify(
        &crypto::sized::<32>(&input.claim.signing_key)?,
        &input.claim.proof,
        &input.claim.frame(&row.invitation)?,
    )?;
    let claim_hash = input.claim.hash(&row.invitation)?;
    crypto::verify(
        &crypto::sized::<32>(&input.vault.signing_key)?,
        &input.proof,
        &crypto::frame(
            "sortsys/invitation-registration/v1",
            &[
                &tenant,
                &account.username,
                &row.invitation.id,
                &row.invitation.generation,
                &row.invitation.signature,
                &input.exchange,
                &encode(&Sha256::digest(&record)),
                &encode(&Sha256::digest(input.vault.frame())),
                &claim_hash,
            ],
        ),
    )?;
    account.credential = Some(accounts::Credential {
        revision: 1,
        record: encode(&record),
        vault: input.vault.clone(),
        certificate: json!({"format": "pending"}),
    });
    account.epoch = account.epoch.checked_add(1).ok_or_else(denied)?;
    transaction
        .put_protected(accounts::account_key(account.id), &account)
        .await?;
    super::super::invitations::metadata_store_claim(&mut transaction, row, input.claim).await?;
    let user_agent = request
        .headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok());
    let address = request
        .headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    let session =
        accounts::new_session(&mut transaction, &account, &status, address, user_agent).await?;
    transaction.delete(exchange_key).await?;
    transaction.commit().await?;
    auth_limits::LoginAttempt::resume(exchange.attempt_key, exchange.attempt_expires_at)
        .succeeded(service.records()?)
        .await;
    let token = service
        .issue_user_token(&tenant, &session.id.to_string())
        .map_err(internal)?;
    Ok(LoginFinishOutput {
        token,
        tenant,
        username: account.username,
        vault: input.vault,
    })
}
pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let begin = Arc::clone(&service);
    builder
        .mutation(
            "auth.opaque.invitationStart",
            move |_, input: InvitationStartInput| {
                let service = Arc::clone(&begin);
                async move { start(&service, input).await }
            },
        )
        .mutation(
            "auth.opaque.invitationFinish",
            move |ctx, input: InvitationFinishInput| {
                let service = Arc::clone(&service);
                async move { finish(&service, &ctx, input).await }
            },
        )
}
