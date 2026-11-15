//! First ownership is authorized by a one-use setup capability, never by a
//! provider-owned password. The private authority and recovery keys stay local.
use super::super::crypto::{sized, verify};
use super::super::setup::{self, SetupInput, packet_hash};
use super::*;
use crate::{control::tenants, ids::Id};

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectInput {
    tenant: String,
    secret: String,
    #[ts(optional)]
    user_id: Option<String>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct OwnerInfo {
    tenant: String,
    user_id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartInput {
    tenant: String,
    secret: String,
    username: String,
    registration_request: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Started {
    exchange: String,
    registration_response: String,
    tenant: String,
    username: String,
    user_id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishInput {
    exchange: String,
    registration_record: String,
    vault: AccountVault,
    setup: SetupInput,
    #[ts(type = "\"de\" | \"en\"")]
    locale: String,
    proof: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingOwner {
    tenant: String,
    username: String,
    owner_id: i64,
    grant_hash: String,
}

fn secret_hash(secret: &str) -> RpcResult<String> {
    Ok(encode(&Sha256::digest(crypto::sized::<32>(secret)?)))
}

async fn owner_repository(
    service: &crate::auth::AuthService,
    tenant: &str,
) -> RpcResult<Repository> {
    let name = tenants::normalized_name(tenant)?;
    if name != tenant
        || service
            .records()?
            .read::<Value>(key("tenants", tenant))
            .await?
            .value
            .is_none()
    {
        return Err(denied());
    }
    service.records()?.tenant(tenant)
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let inspect_service = Arc::clone(&service);
    let start_service = Arc::clone(&service);
    builder
        .mutation("auth.owner.inspect", move |_, input: InspectInput| {
            let service = Arc::clone(&inspect_service);
            async move {
                let repository = owner_repository(&service, &input.tenant).await?;
                let mut transaction = repository.transaction()?;
                let mut provisioning = tenants::setup_access(
                    &mut transaction,
                    &input.tenant,
                    &secret_hash(&input.secret)?,
                )
                .await?;
                let mut changed = false;
                if let Some(requested) = &input.user_id {
                    let user = Id::decode(requested).map_err(|_| invalid())?;
                    if user.0 <= 0 || user.encode() != *requested {
                        return Err(invalid());
                    }
                    if provisioning.owner_id != user.0 {
                        provisioning.owner_id = user.0;
                        transaction
                            .put(tenants::provisioning_key(), &provisioning)
                            .await?;
                        changed = true;
                    }
                }
                if changed {
                    transaction.commit().await?;
                } else {
                    transaction.validate().await?;
                }
                Ok(OwnerInfo {
                    tenant: input.tenant,
                    user_id: Id(provisioning.owner_id),
                })
            }
        })
        .mutation("auth.owner.start", move |_, input: StartInput| {
            let service = Arc::clone(&start_service);
            async move { start(&service, input).await }
        })
        .mutation("auth.owner.finish", move |ctx, input: FinishInput| {
            let service = Arc::clone(&service);
            async move { finish(&service, &ctx, input).await }
        })
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<InspectInput, OwnerInfo>("auth.owner.inspect")
        .mutation_stub::<StartInput, Started>("auth.owner.start")
        .mutation_stub::<FinishInput, LoginFinishOutput>("auth.owner.finish")
}

async fn start(service: &crate::auth::AuthService, input: StartInput) -> RpcResult<Started> {
    let _admission = auth_limits::admit_login()?;
    let (tenant, username) = normalize(&input.tenant, &input.username)?;
    let repository = owner_repository(service, &tenant).await?;
    let hash = secret_hash(&input.secret)?;
    let mut transaction = repository.transaction()?;
    let provisioning = tenants::setup_access(&mut transaction, &tenant, &hash).await?;
    let _attempt = service
        .reserve_login("owner-registration", &[&tenant])
        .await?;
    let request =
        RegistrationRequest::<Suite>::deserialize(&decode(&input.registration_request, 128)?)
            .map_err(|_| invalid())?;
    let credential_id = format!("{tenant}/{username}");
    let response = ServerRegistration::<Suite>::start(
        &store_setup(&repository).await?,
        request,
        credential_id.as_bytes(),
    )
    .map_err(|_| invalid())?;
    let exchange = store_exchange(
        service,
        &repository,
        Some(tenant.clone()),
        "owner-registration",
        PendingOwner {
            tenant: tenant.clone(),
            username: username.clone(),
            owner_id: provisioning.owner_id,
            grant_hash: hash,
        },
    )
    .await?;
    Ok(Started {
        exchange,
        registration_response: encode(&response.message.serialize()),
        tenant,
        username,
        user_id: Id(provisioning.owner_id),
    })
}

async fn finish(
    service: &crate::auth::AuthService,
    context: &RequestContext,
    input: FinishInput,
) -> RpcResult<LoginFinishOutput> {
    let _admission = auth_limits::admit_login()?;
    let ticket = read_store_ticket(service, &input.exchange, "owner-registration")?;
    let tenant = ticket.tenant.ok_or_else(denied)?;
    let repository = owner_repository(service, &tenant).await?;
    let mut transaction = repository.transaction()?;
    let exchange_key = key("owner-registration", &ticket.id);
    let stored: StoredExchange<PendingOwner> = transaction
        .read(exchange_key.clone())
        .await?
        .ok_or_else(denied)?;
    let owner = stored.payload;
    if stored.expires_at <= Utc::now()
        || owner.tenant != tenant
        || !["de", "en"].contains(&input.locale.as_str())
    {
        return Err(denied());
    }
    input.vault.validate()?;
    if input.vault.tenant != tenant || input.vault.username != owner.username {
        return Err(denied());
    }
    let record = validate_registration(&input.registration_record)?;
    let subject = format!("user:{}", Id(owner.owner_id).encode());
    input.setup.validate(
        &tenant,
        &subject,
        &sized::<32>(&input.vault.encryption_key)?,
        &sized::<32>(&input.vault.signing_key)?,
    )?;
    if let Some(context) = &input.setup.authority.context {
        super::super::bootstrap::validate_context(context)?;
    }
    let binding = sortsys_zerotrust::initialization::OwnerRegistration {
        tenant: tenant.clone(),
        subject,
        username: owner.username.clone(),
        exchange_hash: encode(&Sha256::digest(input.exchange.as_bytes())),
        registration_hash: encode(&Sha256::digest(&record)),
        vault_hash: encode(&Sha256::digest(input.vault.frame())),
        setup_hash: packet_hash(input.setup.frame()?, &input.setup.proof)?,
        locale: input.locale.clone(),
    };
    verify(
        &sized::<32>(&input.vault.signing_key)?,
        &input.proof,
        &binding.frame()?,
    )?;
    tenants::claim(&mut transaction, &tenant, &owner.grant_hash, owner.owner_id).await?;
    if transaction
        .read::<accounts::Account>(accounts::account_key(owner.owner_id))
        .await?
        .is_some()
        || transaction
            .read::<accounts::Username>(key("usernames", &owner.username))
            .await?
            .is_some()
    {
        return Err(denied());
    }
    let account = accounts::Account {
        id: owner.owner_id,
        username: owner.username.clone(),
        locale: input.locale,
        epoch: 1,
        roles: vec![":admin".into()],
        created_at: Utc::now(),
        modified_at: Utc::now(),
        deactivated_at: None,
        archived_at: None,
        credential: Some(accounts::Credential {
            revision: 1,
            record: encode(&record),
            vault: input.vault,
            certificate: serde_json::to_value(&input.setup.owner).map_err(internal)?,
        }),
    };
    transaction
        .put_protected(accounts::account_key(account.id), &account)
        .await?;
    transaction
        .put(
            key("member-directory", &format!("{:020}", account.id)),
            &account.id,
        )
        .await?;
    transaction
        .put(
            key("usernames", &owner.username),
            &accounts::Username {
                user_id: account.id,
            },
        )
        .await?;
    setup::install_initial(&mut transaction, &input.setup).await?;
    let status: accounts::TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(denied)?;
    let address = context
        .headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    let user_agent = context
        .headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok());
    let session =
        accounts::new_session(&mut transaction, &account, &status, address, user_agent).await?;
    transaction.delete(exchange_key).await?;
    transaction.commit().await?;
    let token = service
        .issue_user_token(&tenant, &session.id.to_string())
        .map_err(internal)?;
    Ok(LoginFinishOutput {
        token,
        tenant,
        username: owner.username,
        vault: account.credential()?.vault.clone(),
    })
}
