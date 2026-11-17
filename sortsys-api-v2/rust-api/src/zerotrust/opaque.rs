use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use opaque_ke::{
    CipherSuite, CredentialFinalization, CredentialRequest, Identifiers, RegistrationRequest,
    RegistrationUpload, ServerLogin, ServerLoginParameters, ServerRegistration, ServerSetup,
    rand::rngs::OsRng,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sortsys_zerotrust::credentials::{CredentialPrincipal, OPAQUE_SERVER_IDENTIFIER};
use ts_rs::TS;

use super::crypto::{self, AccountVault, decode, encode, invalid, random_id};
use crate::{
    api::Success,
    auth_limits,
    control::{Repository, accounts, key},
    error::{ErrorCode, RpcError, RpcResult},
    error::{forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

#[cfg(test)]
mod store_tests;

mod invited;
mod owner;

struct Suite;
impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2_10::Sha512>;
    type Ksf = argon2::Argon2<'static>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use opaque_ke::{ClientLogin, ClientLoginFinishParameters, CredentialResponse};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Interop {
        password: String,
        tenant: String,
        subject: String,
        setup: String,
        registration_record: String,
        client_login_state: String,
        start_login_request: String,
        server_login_state: String,
        login_response: String,
        finish_login_request: String,
        session_key: String,
        export_key: String,
    }

    #[test]
    fn browser_opaque_messages_are_compatible_with_the_native_server() {
        let vector: Interop =
            serde_json::from_str(include_str!("../../tests/fixtures/zerotrust-opaque.json"))
                .unwrap();
        let credential = CredentialPrincipal {
            tenant: vector.tenant.clone(),
            subject: vector.subject.clone(),
        }
        .identifier()
        .unwrap();
        let params = || ServerLoginParameters {
            context: None,
            identifiers: Identifiers {
                client: Some(credential.as_bytes()),
                server: Some(OPAQUE_SERVER_IDENTIFIER.as_bytes()),
            },
        };
        let finalized =
            ServerLogin::<Suite>::deserialize(&decode(&vector.server_login_state, 4096).unwrap())
                .unwrap()
                .finish(
                    CredentialFinalization::deserialize(
                        &decode(&vector.finish_login_request, 1024).unwrap(),
                    )
                    .unwrap(),
                    params(),
                )
                .unwrap();
        assert_eq!(encode(&finalized.session_key), vector.session_key);
        let setup =
            ServerSetup::<Suite>::deserialize(&decode(&vector.setup, 4096).unwrap()).unwrap();
        let record = ServerRegistration::<Suite>::deserialize(
            &decode(&vector.registration_record, 4096).unwrap(),
        )
        .unwrap();
        let request = CredentialRequest::<Suite>::deserialize(
            &decode(&vector.start_login_request, 1024).unwrap(),
        )
        .unwrap();
        assert!(
            ServerLogin::start(
                &mut OsRng,
                &setup,
                Some(record),
                request,
                credential.as_bytes(),
                params()
            )
            .is_ok()
        );

        let ksf = argon2::Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            argon2::Params::new(65536, 3, 1, Some(64)).unwrap(),
        );
        let client =
            ClientLogin::<Suite>::deserialize(&decode(&vector.client_login_state, 4096).unwrap())
                .unwrap();
        let result = client
            .finish(
                &mut OsRng,
                vector.password.as_bytes(),
                CredentialResponse::deserialize(&decode(&vector.login_response, 4096).unwrap())
                    .unwrap(),
                ClientLoginFinishParameters {
                    context: None,
                    identifiers: params().identifiers,
                    ksf: Some(&ksf),
                },
            )
            .unwrap();
        assert_eq!(encode(&result.export_key), vector.export_key);
        assert_eq!(encode(&result.session_key), vector.session_key);
    }
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentStartInput {
    registration_request: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct EnrollmentStartOutput {
    subject: String,
    exchange: String,
    registration_response: String,
    tenant: String,
    username: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentFinishInput {
    exchange: String,
    registration_record: String,
    vault: AccountVault,
    previous_identity_proof: Option<String>,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvitationStartInput {
    tenant: String,
    invitation: String,
    registration_request: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvitationFinishInput {
    exchange: String,
    registration_record: String,
    vault: AccountVault,
    claim: super::invitations::Claim,
    proof: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginStartInput {
    tenant: String,
    username: String,
    start_login_request: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LoginStartOutput {
    subject: String,
    exchange: String,
    login_response: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginFinishInput {
    exchange: String,
    finish_login_request: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LoginFinishOutput {
    token: String,
    tenant: String,
    username: String,
    vault: AccountVault,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ModeInput {
    tenant: String,
    username: String,
}

#[derive(Serialize, TS)]
struct ModeOutput {
    opaque: bool,
}

#[derive(Serialize, TS)]
struct VaultOutput {
    revision: String,
    vault: AccountVault,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct VaultUpdateInput {
    revision: String,
    vault: AccountVault,
    proof: String,
}

pub(crate) fn register_account_auth(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let builder = owner::register(builder, Arc::clone(&service));
    let builder = invited::register(builder, Arc::clone(&service));
    let vault_read = Arc::clone(&service);
    let vault_update = Arc::clone(&service);
    let begin = Arc::clone(&service);
    let finish = Arc::clone(&service);
    let login = Arc::clone(&service);
    builder
        .query("auth.opaque.vault", move |ctx, _: ()| {
            let service = Arc::clone(&vault_read);
            async move { account_vault(&service, &ctx).await }
        })
        .mutation(
            "auth.opaque.vaultUpdate",
            move |ctx, input: VaultUpdateInput| {
                let service = Arc::clone(&vault_update);
                async move { update_vault(&service, &ctx, input).await }
            },
        )
        .query("auth.opaque.mode", move |_, input: ModeInput| async move {
            normalize(&input.tenant, &input.username)?;
            Ok(ModeOutput { opaque: true })
        })
        .mutation(
            "auth.opaque.enrollStart",
            move |ctx, input: EnrollmentStartInput| {
                let service = Arc::clone(&begin);
                async move { enroll_start(&service, &ctx, input).await }
            },
        )
        .mutation(
            "auth.opaque.enrollFinish",
            move |ctx, input: EnrollmentFinishInput| {
                let service = Arc::clone(&finish);
                async move { enroll_finish(&service, &ctx, input).await }
            },
        )
        .mutation(
            "auth.opaque.loginStart",
            move |_, input: LoginStartInput| {
                let service = Arc::clone(&login);
                async move {
                    let started = Instant::now();
                    let result = login_start(&service, input).await;
                    tokio::time::sleep(Duration::from_secs(3).saturating_sub(started.elapsed()))
                        .await;
                    result
                }
            },
        )
        .mutation(
            "auth.opaque.loginFinish",
            move |ctx, input: LoginFinishInput| {
                let service = Arc::clone(&service);
                async move { login_finish(&service, &ctx, input).await }
            },
        )
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    let builder = owner::register_contract(builder);
    builder
        .mutation_stub::<InvitationStartInput, EnrollmentStartOutput>("auth.opaque.invitationStart")
        .mutation_stub::<InvitationFinishInput, LoginFinishOutput>("auth.opaque.invitationFinish")
        .query_stub::<(), VaultOutput>("auth.opaque.vault")
        .mutation_stub::<VaultUpdateInput, Success>("auth.opaque.vaultUpdate")
        .query_stub::<ModeInput, ModeOutput>("auth.opaque.mode")
        .mutation_stub::<EnrollmentStartInput, EnrollmentStartOutput>("auth.opaque.enrollStart")
        .mutation_stub::<EnrollmentFinishInput, Success>("auth.opaque.enrollFinish")
        .mutation_stub::<LoginStartInput, LoginStartOutput>("auth.opaque.loginStart")
        .mutation_stub::<LoginFinishInput, LoginFinishOutput>("auth.opaque.loginFinish")
}

async fn account_vault(
    service: &crate::auth::AuthService,
    ctx: &RequestContext,
) -> RpcResult<VaultOutput> {
    let auth = service.authenticate(&ctx.headers).await?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (account, _) = accounts::checked_session(&mut transaction, &auth).await?;
    account.credential()?.vault.validate()?;
    let output = VaultOutput {
        revision: account.credential()?.revision.to_string(),
        vault: account.credential()?.vault.clone(),
    };
    transaction.validate().await?;
    Ok(output)
}

async fn update_vault(
    service: &crate::auth::AuthService,
    ctx: &RequestContext,
    input: VaultUpdateInput,
) -> RpcResult<Success> {
    let auth = service.authenticate(&ctx.headers).await?;
    crypto::revision(&input.revision)?;
    input.vault.validate()?;
    if input.vault.tenant != auth.tenant
        || input.vault.subject != accounts::subject(auth.user.id.parse().map_err(|_| denied())?)
    {
        return Err(forbidden());
    }
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (mut account, _) = accounts::checked_session(&mut transaction, &auth).await?;
    if account.credential()?.revision.to_string() != input.revision {
        return Err(crate::control::conflict());
    }
    if account.credential()?.vault.signing_key != input.vault.signing_key
        || account.credential()?.vault.encryption_key != input.vault.encryption_key
    {
        return Err(forbidden());
    }
    crypto::verify(
        &crypto::sized::<32>(&account.credential()?.vault.signing_key)?,
        &input.proof,
        &crypto::frame(
            "sortsys/account-vault-update/v2",
            &[
                &auth.tenant,
                &accounts::subject(account.id),
                &input.revision,
                &encode(&Sha256::digest(input.vault.frame())),
            ],
        ),
    )?;
    account.credential_mut()?.vault = input.vault;
    account.credential_mut()?.revision = account
        .credential()?
        .revision
        .checked_add(1)
        .ok_or_else(crate::control::unavailable)?;
    transaction
        .put_protected(accounts::account_key(account.id), &account)
        .await?;
    transaction.commit().await?;
    Ok(Success { success: true })
}

fn normalize(tenant: &str, username: &str) -> RpcResult<(String, String)> {
    let tenant = tenant.trim().to_lowercase();
    let username = username.trim().to_lowercase();
    crypto::identifier(&tenant)?;
    crypto::identifier(&username)?;
    Ok((tenant, username))
}

fn denied() -> RpcError {
    RpcError::new(ErrorCode::Unauthorized, "Login failed").with_http_code(401)
}

fn rejected_login(reason: &'static str) -> RpcError {
    // Deliberately omit identities, challenges, credentials and vault contents.
    tracing::debug!(reason, "OPAQUE login rejected");
    denied()
}

pub(super) async fn recovery_registration(
    repository: &Repository,
    tenant: &str,
    subject: &str,
    request: &str,
) -> RpcResult<String> {
    let request =
        RegistrationRequest::<Suite>::deserialize(&decode(request, 128)?).map_err(|_| invalid())?;
    let credential = CredentialPrincipal {
        tenant: tenant.into(),
        subject: subject.into(),
    }
    .identifier()?;
    let response = ServerRegistration::<Suite>::start(
        &store_setup(repository).await?,
        request,
        credential.as_bytes(),
    )
    .map_err(|_| invalid())?;
    Ok(encode(&response.message.serialize()))
}

pub(super) fn validate_registration(record: &str) -> RpcResult<Vec<u8>> {
    let record = decode(record, 4096)?;
    ServerRegistration::<Suite>::deserialize(&record).map_err(|_| invalid())?;
    Ok(record)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreTicket {
    purpose: String,
    tenant: Option<String>,
    id: String,
    exp: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredExchange<T> {
    expires_at: DateTime<Utc>,
    payload: T,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginExchange {
    subject: String,
    tenant: String,
    username: String,
    state: String,
    user_id: Option<i64>,
    credential_revision: Option<u64>,
    account_epoch: Option<u64>,
    tenant_epoch: Option<u64>,
    attempt_key: Vec<u8>,
    attempt_expires_at: DateTime<Utc>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentExchange {
    user_id: i64,
    session_id: i64,
    credential_revision: u64,
    account_epoch: u64,
    tenant_epoch: u64,
}

async fn store_setup(repository: &Repository) -> RpcResult<ServerSetup<Suite>> {
    let key = key("opaque-setup", "current");
    for _ in 0..8 {
        let mut transaction = repository.transaction()?;
        if let Some(value) = transaction.read::<String>(key.clone()).await? {
            return ServerSetup::deserialize(&decode(&value, 4096)?)
                .map_err(|_| crate::control::unavailable());
        }
        let setup = ServerSetup::<Suite>::new(&mut OsRng);
        transaction
            .put(key.clone(), &encode(&setup.serialize()))
            .await?;
        match transaction.commit().await {
            Ok(_) => return Ok(setup),
            Err(error) if error.code == ErrorCode::Conflict => continue,
            Err(error) => return Err(error),
        }
    }
    Err(crate::control::conflict())
}

async fn store_exchange<T: Serialize>(
    service: &crate::auth::AuthService,
    repository: &Repository,
    tenant: Option<String>,
    purpose: &str,
    payload: T,
) -> RpcResult<String> {
    let id = random_id()?;
    let expires_at = Utc::now() + chrono::Duration::minutes(2);
    let stored = StoredExchange {
        expires_at,
        payload,
    };
    let mut transaction = repository.transaction()?;
    let record = key(purpose, &id);
    if transaction.read::<Value>(record.clone()).await?.is_some() {
        return Err(crate::control::conflict());
    }
    transaction
        .put_expiring(record, &stored, expires_at)
        .await?;
    transaction.commit().await?;
    let _ = tokio::time::timeout(Duration::from_millis(500), repository.cleanup_expired()).await;
    service.issue_challenge_token(&StoreTicket {
        purpose: purpose.into(),
        tenant,
        id,
        exp: expires_at.timestamp() as usize,
    })
}

fn read_store_ticket(
    service: &crate::auth::AuthService,
    token: &str,
    purpose: &str,
) -> RpcResult<StoreTicket> {
    if token.len() > 4096 {
        return Err(denied());
    }
    let ticket: StoreTicket = service
        .verify_challenge_token(token)
        .map_err(|_| denied())?;
    if ticket.purpose != purpose {
        return Err(denied());
    }
    crypto::identifier(&ticket.id)?;
    Ok(ticket)
}

async fn take_store_exchange<T: serde::de::DeserializeOwned>(
    service: &crate::auth::AuthService,
    token: &str,
    purpose: &str,
) -> RpcResult<T> {
    let ticket = read_store_ticket(service, token, purpose)?;
    let repository = match &ticket.tenant {
        Some(tenant) => service.records()?.tenant(tenant)?,
        None => service.records()?.clone(),
    };
    let mut transaction = repository.transaction()?;
    let record = key(purpose, &ticket.id);
    let stored: StoredExchange<T> = transaction.read(record.clone()).await?.ok_or_else(denied)?;
    if stored.expires_at <= Utc::now() {
        return Err(denied());
    }
    transaction.delete(record).await?;
    transaction.commit().await.map_err(|_| denied())?;
    Ok(stored.payload)
}

async fn enroll_start(
    service: &crate::auth::AuthService,
    ctx: &RequestContext,
    input: EnrollmentStartInput,
) -> RpcResult<EnrollmentStartOutput> {
    let _admission = auth_limits::admit_login()?;
    let auth = service.authenticate(&ctx.headers).await?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (account, tenant) = accounts::checked_session(&mut transaction, &auth).await?;
    let registration =
        RegistrationRequest::<Suite>::deserialize(&decode(&input.registration_request, 128)?)
            .map_err(|_| invalid())?;
    let credential_id = accounts::principal(&auth.tenant, account.id).identifier()?;
    let response = ServerRegistration::<Suite>::start(
        &store_setup(&repository).await?,
        registration,
        credential_id.as_bytes(),
    )
    .map_err(|_| invalid())?;
    let payload = EnrollmentExchange {
        user_id: account.id,
        session_id: auth.session.id.parse().map_err(|_| denied())?,
        credential_revision: account.credential()?.revision,
        account_epoch: account.epoch,
        tenant_epoch: tenant.epoch,
    };
    let exchange = store_exchange(
        service,
        &repository,
        Some(auth.tenant.clone()),
        "opaque-enroll",
        payload,
    )
    .await?;
    Ok(EnrollmentStartOutput {
        subject: accounts::subject(account.id),
        exchange,
        registration_response: encode(&response.message.serialize()),
        tenant: auth.tenant,
        username: account.username,
    })
}

async fn enroll_finish(
    service: &crate::auth::AuthService,
    ctx: &RequestContext,
    input: EnrollmentFinishInput,
) -> RpcResult<Success> {
    let auth = service.authenticate(&ctx.headers).await?;
    input.vault.validate()?;
    if input.vault.tenant != auth.tenant
        || input.vault.subject != accounts::subject(auth.user.id.parse().map_err(|_| denied())?)
    {
        return Err(forbidden());
    }
    let upload =
        RegistrationUpload::<Suite>::deserialize(&decode(&input.registration_record, 4096)?)
            .map_err(|_| invalid())?;
    let password_record = ServerRegistration::<Suite>::finish(upload)
        .serialize()
        .to_vec();
    let exchange: EnrollmentExchange =
        take_store_exchange(service, &input.exchange, "opaque-enroll").await?;
    let session_id: i64 = auth.session.id.parse().map_err(|_| denied())?;
    let repository = service.records()?.tenant(&auth.tenant)?;
    let mut transaction = repository.transaction()?;
    let (mut account, tenant) = accounts::checked_session(&mut transaction, &auth).await?;
    if exchange.user_id != account.id
        || exchange.session_id != session_id
        || exchange.credential_revision != account.credential()?.revision
        || exchange.account_epoch != account.epoch
        || exchange.tenant_epoch != tenant.epoch
    {
        return Err(denied());
    }
    let current = &account.credential()?.vault;
    if current.signing_key != input.vault.signing_key
        || current.encryption_key != input.vault.encryption_key
    {
        return Err(forbidden());
    }
    crypto::verify(
        &crypto::sized::<32>(&current.signing_key)?,
        input
            .previous_identity_proof
            .as_deref()
            .ok_or_else(forbidden)?,
        &crypto::frame(
            "sortsys/account-enroll/v2",
            &[
                &auth.tenant,
                &accounts::subject(account.id),
                &input.exchange,
                &encode(&Sha256::digest(&password_record)),
                &encode(&Sha256::digest(input.vault.frame())),
            ],
        ),
    )?;
    account.credential_mut()?.record = encode(&password_record);
    account.credential_mut()?.vault = input.vault;
    account.credential_mut()?.revision = account
        .credential()?
        .revision
        .checked_add(1)
        .ok_or_else(crate::control::unavailable)?;
    account.epoch = account
        .epoch
        .checked_add(1)
        .ok_or_else(crate::control::unavailable)?;
    transaction
        .put_protected(accounts::account_key(account.id), &account)
        .await?;
    // Keep only the self-changing session; all others retain the old epoch.
    let mut session: accounts::Session = transaction
        .read(accounts::session_key(session_id))
        .await?
        .ok_or_else(denied)?;
    session.account_epoch = account.epoch;
    transaction
        .put_expiring(
            accounts::session_key(session_id),
            &session,
            session.expires_at,
        )
        .await?;
    transaction.commit().await?;
    Ok(Success { success: true })
}

async fn login_start(
    service: &crate::auth::AuthService,
    input: LoginStartInput,
) -> RpcResult<LoginStartOutput> {
    let _admission = auth_limits::admit_login()?;
    let (tenant, username) = normalize(&input.tenant, &input.username)?;
    let attempt = service.reserve_login("user", &[&tenant, &username]).await?;
    let request =
        CredentialRequest::<Suite>::deserialize(&decode(&input.start_login_request, 1024)?)
            .map_err(|_| invalid())?;
    let known = service
        .records()?
        .read::<Value>(key("tenants", &tenant))
        .await?
        .value
        .is_some();
    let repository = if known {
        service.records()?.tenant(&tenant)?
    } else {
        service.records()?.clone()
    };
    let mut transaction = repository.transaction()?;
    let status: Option<accounts::TenantStatus> = if known {
        transaction.read(accounts::tenant_key()).await?
    } else {
        None
    };
    let username_record: Option<accounts::Username> = if known {
        transaction.read(key("usernames", &username)).await?
    } else {
        None
    };
    let account: Option<accounts::Account> = match username_record {
        Some(user) => {
            transaction
                .read(accounts::account_key(user.user_id))
                .await?
        }
        None => None,
    };
    let now = Utc::now();
    let account = account.filter(|account| {
        account.username == username
            && account.active(now)
            && status.as_ref().is_some_and(|status| status.available(now))
    });
    let registered = account
        .as_ref()
        .map(|account| {
            let bytes = decode(&account.credential()?.record, 4096)?;
            ServerRegistration::<Suite>::deserialize(&bytes)
                .map_err(|_| crate::control::unavailable())
        })
        .transpose()?;
    let subject = match &account {
        Some(account) => accounts::subject(account.id),
        None => service.dummy_credential_subject(&tenant, &username),
    };
    let credential_id = CredentialPrincipal {
        tenant: tenant.clone(),
        subject: subject.clone(),
    }
    .identifier()?;
    let response = ServerLogin::<Suite>::start(
        &mut OsRng,
        &store_setup(&repository).await?,
        registered,
        request,
        credential_id.as_bytes(),
        ServerLoginParameters {
            context: None,
            identifiers: Identifiers {
                client: Some(credential_id.as_bytes()),
                server: Some(OPAQUE_SERVER_IDENTIFIER.as_bytes()),
            },
        },
    )
    .map_err(|_| denied())?;
    let (attempt_key, attempt_expires_at) = attempt.reservation();
    let payload = LoginExchange {
        subject: subject.clone(),
        tenant: tenant.clone(),
        username,
        state: encode(&response.state.serialize()),
        user_id: account.as_ref().map(|account| account.id),
        credential_revision: account.as_ref().and_then(|account| {
            account
                .credential
                .as_ref()
                .map(|credential| credential.revision)
        }),
        account_epoch: account.as_ref().map(|account| account.epoch),
        tenant_epoch: status.map(|status| status.epoch),
        attempt_key: attempt_key.to_vec(),
        attempt_expires_at,
    };
    let exchange = store_exchange(
        service,
        &repository,
        known.then_some(tenant),
        "opaque-login",
        payload,
    )
    .await?;
    Ok(LoginStartOutput {
        subject,
        exchange,
        login_response: encode(&response.message.serialize()),
    })
}

async fn login_finish(
    service: &crate::auth::AuthService,
    ctx: &RequestContext,
    input: LoginFinishInput,
) -> RpcResult<LoginFinishOutput> {
    let _admission = auth_limits::admit_login()?;
    let finalization =
        CredentialFinalization::<Suite>::deserialize(&decode(&input.finish_login_request, 512)?)
            .map_err(|_| rejected_login("message-format"))?;
    let exchange: LoginExchange =
        take_store_exchange(service, &input.exchange, "opaque-login").await?;
    let server = ServerLogin::<Suite>::deserialize(&decode(&exchange.state, 4096)?)
        .map_err(|_| rejected_login("exchange-state"))?;
    let credential_id = CredentialPrincipal {
        tenant: exchange.tenant.clone(),
        subject: exchange.subject.clone(),
    }
    .identifier()?;
    server
        .finish(
            finalization,
            ServerLoginParameters {
                context: None,
                identifiers: Identifiers {
                    client: Some(credential_id.as_bytes()),
                    server: Some(OPAQUE_SERVER_IDENTIFIER.as_bytes()),
                },
            },
        )
        .map_err(|_| rejected_login("client-proof"))?;
    let user = exchange
        .user_id
        .ok_or_else(|| rejected_login("unknown-account"))?;
    let repository = service.records()?.tenant(&exchange.tenant)?;
    let mut transaction = repository.transaction()?;
    let account: accounts::Account = transaction
        .read(accounts::account_key(user))
        .await?
        .ok_or_else(denied)?;
    let status: accounts::TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(denied)?;
    let username: accounts::Username = transaction
        .read(key("usernames", &exchange.username))
        .await?
        .ok_or_else(denied)?;
    let now = Utc::now();
    if !account.active(now)
        || !status.available(now)
        || username.user_id != user
        || exchange.subject != accounts::subject(account.id)
        || account.username != exchange.username
        || Some(account.credential()?.revision) != exchange.credential_revision
        || Some(account.epoch) != exchange.account_epoch
        || Some(status.epoch) != exchange.tenant_epoch
    {
        return Err(rejected_login("account-changed"));
    }
    account.credential()?.vault.validate()?;
    if account.credential()?.vault.tenant != exchange.tenant
        || account.credential()?.vault.subject != accounts::subject(account.id)
    {
        return Err(denied());
    }
    let address = ctx
        .headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    let user_agent = ctx
        .headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok());
    let session =
        accounts::new_session(&mut transaction, &account, &status, address, user_agent).await?;
    transaction.commit().await?;
    auth_limits::LoginAttempt::resume(exchange.attempt_key, exchange.attempt_expires_at)
        .succeeded(service.records()?)
        .await;
    let token = service
        .issue_user_token(&exchange.tenant, &session.id.to_string())
        .map_err(internal)?;
    Ok(LoginFinishOutput {
        token,
        tenant: exchange.tenant,
        username: exchange.username,
        vault: account.credential()?.vault.clone(),
    })
}
