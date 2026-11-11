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
use sqlx::{FromRow, PgPool};
use ts_rs::TS;

use super::crypto::{self, AccountVault, decode, encode, invalid, random_id};
use crate::{
    AppState,
    api::Success,
    auth_limits,
    error::{ErrorCode, RpcError, RpcResult},
    procedures::common::{authenticated_pool, forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

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
        let params = || ServerLoginParameters {
            context: None,
            identifiers: Identifiers {
                client: Some(b"test/interop"),
                server: Some(b"sortsys/opaque/v1"),
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
                b"test/interop",
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

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let invitation_start = Arc::clone(&state);
    let invitation_finish = Arc::clone(&state);
    let mode_state = Arc::clone(&state);
    let begin = Arc::clone(&state);
    let finish = Arc::clone(&state);
    let login = Arc::clone(&state);
    let vault_read = Arc::clone(&state);
    let vault_update = Arc::clone(&state);
    builder
        .mutation("auth.opaque.invitationStart", move |_, input: InvitationStartInput| {
            let state = Arc::clone(&invitation_start);
            async move { invited_start(&state, input).await }
        })
        .mutation("auth.opaque.invitationFinish", move |ctx, input: InvitationFinishInput| {
            let state = Arc::clone(&invitation_finish);
            async move { invited_finish(&state, &ctx, input).await }
        })
        .query("auth.opaque.vault", move |ctx, _: ()| {
            let state = Arc::clone(&vault_read);
            async move { account_vault(&state, &ctx).await }
        })
        .mutation("auth.opaque.vaultUpdate", move |ctx, input: VaultUpdateInput| {
            let state = Arc::clone(&vault_update);
            async move { update_vault(&state, &ctx, input).await }
        })
        .query("auth.opaque.mode", move |_, input: ModeInput| {
            let state = Arc::clone(&mode_state);
            async move {
                let (tenant, username) = normalize(&input.tenant, &input.username)?;
                let Ok(pool) = state.tenants.tenant_pool(&tenant).await else { return Ok(ModeOutput { opaque: false }); };
                let opaque = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_accounts a JOIN users u ON u.id=a.user_id WHERE u.username=$1) OR EXISTS(SELECT 1 FROM __zerotrust_state WHERE singleton AND phase='active')")
                    .bind(username).fetch_one(&pool).await.map_err(internal)?;
                Ok(ModeOutput { opaque })
            }
        })
        .mutation("auth.opaque.enrollStart", move |ctx, input: EnrollmentStartInput| {
            let state = Arc::clone(&begin);
            async move { enroll_start(&state, &ctx, input).await }
        })
        .mutation("auth.opaque.enrollFinish", move |ctx, input: EnrollmentFinishInput| {
            let state = Arc::clone(&finish);
            async move { enroll_finish(&state, &ctx, input).await }
        })
        .mutation("auth.opaque.loginStart", move |_, input: LoginStartInput| {
            let state = Arc::clone(&login);
            async move {
                let started = Instant::now();
                let result = login_start(&state, input).await;
                tokio::time::sleep(Duration::from_secs(3).saturating_sub(started.elapsed())).await;
                result
            }
        })
        .mutation("auth.opaque.loginFinish", move |ctx, input: LoginFinishInput| {
            let state = Arc::clone(&state);
            async move { login_finish(&state, &ctx, input).await }
        })
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
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

async fn account_vault(state: &AppState, ctx: &RequestContext) -> RpcResult<VaultOutput> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let (revision, vault): (i64, Value) =
        sqlx::query_as("SELECT revision,account_vault FROM __zerotrust_accounts WHERE user_id=$1")
            .bind(auth.user.id.parse::<i64>().map_err(internal)?)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?
            .ok_or_else(forbidden)?;
    let vault: AccountVault = serde_json::from_value(vault).map_err(|_| invalid())?;
    vault.validate()?;
    if vault.tenant != auth.tenant || vault.username != auth.user.username {
        return Err(forbidden());
    }
    Ok(VaultOutput {
        revision: revision.to_string(),
        vault,
    })
}

async fn update_vault(
    state: &AppState,
    ctx: &RequestContext,
    input: VaultUpdateInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let revision = crypto::revision(&input.revision)?;
    input.vault.validate()?;
    if input.vault.tenant != auth.tenant || input.vault.username != auth.user.username {
        return Err(forbidden());
    }
    let user = auth.user.id.parse::<i64>().map_err(internal)?;
    let session = auth.session.id.parse::<i64>().map_err(internal)?;
    let mut tx = pool.begin().await.map_err(internal)?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(user)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_sessions WHERE id=$1 AND user_id=$2 AND expires_at>statement_timestamp())")
        .bind(session).bind(user).fetch_one(&mut *tx).await.map_err(internal)?;
    if !active {
        return Err(denied());
    }
    let (current, signing_key, encryption_key): (i64, Vec<u8>, Vec<u8>) = sqlx::query_as(
        "SELECT revision,signing_key,encryption_key FROM __zerotrust_accounts WHERE user_id=$1 FOR UPDATE",
    ).bind(user).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(forbidden)?;
    if current != revision {
        return Err(RpcError::new(ErrorCode::Conflict, "Account state changed").with_http_code(409));
    }
    if crypto::sized::<32>(&input.vault.signing_key)?.as_slice() != signing_key
        || crypto::sized::<32>(&input.vault.encryption_key)?.as_slice() != encryption_key
    {
        return Err(forbidden());
    }
    crypto::verify(
        &signing_key,
        &input.proof,
        &crypto::frame(
            "sortsys/account-vault-update/v1",
            &[
                &auth.tenant,
                &auth.user.username,
                &input.revision,
                &encode(&Sha256::digest(input.vault.frame())),
            ],
        ),
    )?;
    sqlx::query(
        "UPDATE __zerotrust_accounts SET account_vault=$2,revision=revision+1 WHERE user_id=$1",
    )
    .bind(user)
    .bind(serde_json::to_value(input.vault).map_err(internal)?)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
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

async fn setup(pool: &PgPool) -> RpcResult<ServerSetup<Suite>> {
    if let Some(stored) =
        sqlx::query_scalar::<_, Vec<u8>>("SELECT server_setup FROM __opaque_setup WHERE singleton")
            .fetch_optional(pool)
            .await
            .map_err(internal)?
    {
        return ServerSetup::deserialize(&stored).map_err(|_| internal("Invalid OPAQUE setup"));
    }
    let value = ServerSetup::<Suite>::new(&mut OsRng).serialize().to_vec();
    sqlx::query("INSERT INTO __opaque_setup(singleton,server_setup) VALUES(TRUE,$1) ON CONFLICT(singleton) DO NOTHING")
        .bind(value).execute(pool).await.map_err(internal)?;
    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT server_setup FROM __opaque_setup WHERE singleton")
            .fetch_one(pool)
            .await
            .map_err(internal)?;
    ServerSetup::deserialize(&stored).map_err(|_| internal("Invalid OPAQUE setup"))
}

pub(super) async fn recovery_registration(
    pool: &PgPool,
    tenant: &str,
    username: &str,
    request: &str,
) -> RpcResult<String> {
    let request =
        RegistrationRequest::<Suite>::deserialize(&decode(request, 128)?).map_err(|_| invalid())?;
    let credential = format!("{tenant}/{username}");
    let response =
        ServerRegistration::<Suite>::start(&setup(pool).await?, request, credential.as_bytes())
            .map_err(|_| invalid())?;
    Ok(encode(&response.message.serialize()))
}

pub(super) fn validate_registration(record: &str) -> RpcResult<Vec<u8>> {
    let record = decode(record, 4096)?;
    ServerRegistration::<Suite>::deserialize(&record).map_err(|_| invalid())?;
    Ok(record)
}

async fn cleanup(pool: &PgPool) {
    let _ = sqlx::query("WITH old AS (SELECT id FROM __opaque_exchanges WHERE expires_at < now() ORDER BY expires_at LIMIT 128 FOR UPDATE SKIP LOCKED) DELETE FROM __opaque_exchanges e USING old WHERE e.id=old.id")
        .execute(pool).await;
}

async fn enroll_start(
    state: &AppState,
    ctx: &RequestContext,
    input: EnrollmentStartInput,
) -> RpcResult<EnrollmentStartOutput> {
    let _admission = auth_limits::admit_login()?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let user: i64 = auth.user.id.parse().map_err(internal)?;
    let registration =
        RegistrationRequest::<Suite>::deserialize(&decode(&input.registration_request, 128)?)
            .map_err(|_| invalid())?;
    let id = format!("{}/{}", auth.tenant, auth.user.username);
    let response = ServerRegistration::<Suite>::start(
        &setup(state.tenants.master()).await?,
        registration,
        id.as_bytes(),
    )
    .map_err(|_| invalid())?;
    let revision: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM __zerotrust_accounts WHERE user_id=$1")
            .bind(user)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?;
    let exchange = random_id()?;
    sqlx::query("INSERT INTO __opaque_exchanges(id,tenant,username,kind,account_revision,user_id,session_id) VALUES($1,$2,$3,'register',$4,$5,$6)")
        .bind(&exchange).bind(&auth.tenant).bind(&auth.user.username).bind(revision).bind(user).bind(auth.session.id.parse::<i64>().map_err(internal)?)
        .execute(state.tenants.master()).await.map_err(internal)?;
    cleanup(state.tenants.master()).await;
    Ok(EnrollmentStartOutput {
        exchange,
        registration_response: encode(&response.message.serialize()),
        tenant: auth.tenant,
        username: auth.user.username,
    })
}

#[derive(FromRow)]
struct Exchange {
    tenant: String,
    username: String,
    server_state: Option<Vec<u8>>,
    account_revision: Option<i64>,
    user_id: Option<i64>,
    session_id: Option<i64>,
    attempt_key: Option<Vec<u8>>,
    attempt_expires_at: Option<DateTime<Utc>>,
}

async fn take_exchange(state: &AppState, id: &str, kind: &str) -> RpcResult<Exchange> {
    crypto::identifier(id)?;
    sqlx::query_as::<_, Exchange>("DELETE FROM __opaque_exchanges WHERE id=$1 AND kind=$2 AND expires_at>now() RETURNING tenant,username,server_state,account_revision,user_id,session_id,attempt_key,attempt_expires_at")
        .bind(id).bind(kind).fetch_optional(state.tenants.master()).await.map_err(internal)?.ok_or_else(denied)
}

async fn enroll_finish(
    state: &AppState,
    ctx: &RequestContext,
    input: EnrollmentFinishInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    input.vault.validate()?;
    if input.vault.tenant != auth.tenant || input.vault.username != auth.user.username {
        return Err(forbidden());
    }
    let upload =
        RegistrationUpload::<Suite>::deserialize(&decode(&input.registration_record, 4096)?)
            .map_err(|_| invalid())?;
    let password_record = ServerRegistration::<Suite>::finish(upload)
        .serialize()
        .to_vec();
    let exchange = take_exchange(state, &input.exchange, "register").await?;
    let user_id: i64 = auth.user.id.parse().map_err(internal)?;
    let session_id: i64 = auth.session.id.parse().map_err(internal)?;
    if exchange.tenant != auth.tenant
        || exchange.user_id != Some(user_id)
        || exchange.session_id != Some(session_id)
    {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_sessions WHERE id=$1 AND user_id=$2 AND expires_at>now())")
        .bind(session_id).bind(user_id).fetch_one(&mut *tx).await.map_err(internal)?;
    if !active {
        return Err(denied());
    }
    let current: Option<(i64, Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT revision,signing_key,encryption_key FROM __zerotrust_accounts WHERE user_id=$1",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    if current.as_ref().map(|value| value.0) != exchange.account_revision {
        return Err(denied());
    }
    if let Some((_, key, encryption_key)) = current {
        if key != crypto::sized::<32>(&input.vault.signing_key)?
            || encryption_key != crypto::sized::<32>(&input.vault.encryption_key)?
        {
            return Err(forbidden());
        }
        let record_hash = encode(&Sha256::digest(&password_record));
        let vault_hash = encode(&Sha256::digest(input.vault.frame()));
        crypto::verify(
            &key,
            input
                .previous_identity_proof
                .as_deref()
                .ok_or_else(forbidden)?,
            &crypto::frame(
                "sortsys/account-enroll/v1",
                &[
                    &auth.tenant,
                    &auth.user.username,
                    &input.exchange,
                    &record_hash,
                    &vault_hash,
                ],
            ),
        )?;
    }
    let vault = serde_json::to_value(&input.vault).map_err(internal)?;
    sqlx::query("INSERT INTO __zerotrust_accounts(user_id,opaque_record,account_vault,encryption_key,signing_key,identity_certificate) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET opaque_record=EXCLUDED.opaque_record,account_vault=EXCLUDED.account_vault,encryption_key=EXCLUDED.encryption_key,signing_key=EXCLUDED.signing_key,revision=__zerotrust_accounts.revision+1")
        .bind(user_id).bind(password_record).bind(vault).bind(crypto::sized::<32>(&input.vault.encryption_key)?.to_vec()).bind(crypto::sized::<32>(&input.vault.signing_key)?.to_vec()).bind(json!({"format":"pending"}))
        .execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE users SET password=NULL WHERE id=$1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    crate::auth::expire_user_sessions(&mut tx, user_id, Some(session_id))
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}

async fn login_start(state: &AppState, input: LoginStartInput) -> RpcResult<LoginStartOutput> {
    let _admission = auth_limits::admit_login()?;
    let (tenant, username) = normalize(&input.tenant, &input.username)?;
    let attempt = auth_limits::reserve(
        state.tenants.master(),
        &state.config.jwt_secret,
        "user",
        &[&tenant, &username],
    )
    .await?;
    let request =
        CredentialRequest::<Suite>::deserialize(&decode(&input.start_login_request, 1024)?)
            .map_err(|_| invalid())?;
    let pool = state
        .tenants
        .tenant_pool(&tenant)
        .await
        .map_err(|_| denied())?;
    let account: Option<(i64,i64,Vec<u8>)> = sqlx::query_as("SELECT a.user_id,a.revision,a.opaque_record FROM __zerotrust_accounts a JOIN users u ON u.id=a.user_id WHERE u.username=$1 AND (u.deactivated_at IS NULL OR u.deactivated_at>now())")
        .bind(&username).fetch_optional(&pool).await.map_err(internal)?;
    let registered = account
        .as_ref()
        .map(|row| ServerRegistration::<Suite>::deserialize(&row.2))
        .transpose()
        .map_err(|_| internal("Invalid OPAQUE registration"))?;
    let id = format!("{tenant}/{username}");
    let response = ServerLogin::<Suite>::start(
        &mut OsRng,
        &setup(state.tenants.master()).await?,
        registered,
        request,
        id.as_bytes(),
        ServerLoginParameters {
            context: None,
            identifiers: Identifiers {
                client: Some(id.as_bytes()),
                server: Some(b"sortsys/opaque/v1"),
            },
        },
    )
    .map_err(|_| denied())?;
    let exchange = random_id()?;
    let (attempt_key, attempt_expires) = attempt.reservation();
    sqlx::query("INSERT INTO __opaque_exchanges(id,tenant,username,kind,server_state,account_revision,user_id,attempt_key,attempt_expires_at) VALUES($1,$2,$3,'login',$4,$5,$6,$7,$8)")
        .bind(&exchange).bind(&tenant).bind(&username).bind(response.state.serialize().to_vec()).bind(account.as_ref().map(|row| row.1)).bind(account.as_ref().map(|row| row.0)).bind(attempt_key).bind(attempt_expires)
        .execute(state.tenants.master()).await.map_err(internal)?;
    cleanup(state.tenants.master()).await;
    Ok(LoginStartOutput {
        exchange,
        login_response: encode(&response.message.serialize()),
    })
}

async fn login_finish(
    state: &AppState,
    ctx: &RequestContext,
    input: LoginFinishInput,
) -> RpcResult<LoginFinishOutput> {
    let _admission = auth_limits::admit_login()?;
    let finalization =
        CredentialFinalization::<Suite>::deserialize(&decode(&input.finish_login_request, 512)?)
            .map_err(|_| denied())?;
    let exchange = take_exchange(state, &input.exchange, "login").await?;
    let server =
        ServerLogin::<Suite>::deserialize(exchange.server_state.as_deref().ok_or_else(denied)?)
            .map_err(|_| denied())?;
    let id = format!("{}/{}", exchange.tenant, exchange.username);
    server
        .finish(
            finalization,
            ServerLoginParameters {
                context: None,
                identifiers: Identifiers {
                    client: Some(id.as_bytes()),
                    server: Some(b"sortsys/opaque/v1"),
                },
            },
        )
        .map_err(|_| denied())?;
    let user = exchange.user_id.ok_or_else(denied)?;
    let pool = state
        .tenants
        .tenant_pool(&exchange.tenant)
        .await
        .map_err(|_| denied())?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let valid: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND (deactivated_at IS NULL OR deactivated_at>now()) FOR SHARE")
        .bind(user).fetch_optional(&mut *tx).await.map_err(internal)?;
    if valid.is_none() {
        return Err(denied());
    }
    let vault: Option<Value> = sqlx::query_scalar(
        "SELECT account_vault FROM __zerotrust_accounts WHERE user_id=$1 AND revision=$2",
    )
    .bind(user)
    .bind(exchange.account_revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let vault: AccountVault =
        serde_json::from_value(vault.ok_or_else(denied)?).map_err(|_| invalid())?;
    let user_agent = ctx
        .headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok());
    let address = ctx
        .headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    let session: i64 = sqlx::query_scalar(
        "INSERT INTO user_sessions(user_id,inet_addr,user_agent) VALUES($1,$2,$3) RETURNING id",
    )
    .bind(user)
    .bind(address)
    .bind(user_agent)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    if let (Some(key), Some(expires)) = (exchange.attempt_key, exchange.attempt_expires_at) {
        auth_limits::LoginAttempt::resume(key, expires)
            .succeeded(state.tenants.master())
            .await;
    }
    let token = state
        .auth
        .issue_user_token(&exchange.tenant, &session.to_string())
        .map_err(internal)?;
    Ok(LoginFinishOutput {
        token,
        tenant: exchange.tenant,
        username: exchange.username,
        vault,
    })
}

async fn invited_start(
    state: &AppState,
    input: InvitationStartInput,
) -> RpcResult<EnrollmentStartOutput> {
    let _admission = auth_limits::admit_login()?;
    crypto::identifier(&input.tenant)?;
    crypto::identifier(&input.invitation)?;
    let attempt = auth_limits::reserve(
        state.tenants.master(),
        &state.config.jwt_secret,
        "invitation",
        &[&input.tenant, &input.invitation],
    )
    .await?;
    let pool = state
        .tenants
        .tenant_pool(&input.tenant)
        .await
        .map_err(|_| denied())?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (invitation, user) = super::invitations::registration_invitation(
        &mut tx,
        state.tenants.master(),
        &input.tenant,
        &input.invitation,
    )
    .await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_accounts WHERE user_id=$1)")
            .bind(user)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    if exists {
        return Err(denied());
    }
    let response = recovery_registration(
        state.tenants.master(),
        &input.tenant,
        &invitation.username,
        &input.registration_request,
    )
    .await?;
    let exchange = random_id()?;
    let (attempt_key, attempt_expires) = attempt.reservation();
    sqlx::query("INSERT INTO __opaque_exchanges(id,tenant,username,kind,server_state,user_id,attempt_key,attempt_expires_at) VALUES($1,$2,$3,'register',$4,$5,$6,$7)")
        .bind(&exchange).bind(&input.tenant).bind(&invitation.username).bind(serde_json::to_vec(&invitation).map_err(internal)?)
        .bind(user).bind(attempt_key).bind(attempt_expires).execute(state.tenants.master()).await.map_err(internal)?;
    cleanup(state.tenants.master()).await;
    Ok(EnrollmentStartOutput {
        exchange,
        registration_response: response,
        tenant: input.tenant,
        username: invitation.username,
    })
}

async fn invited_finish(
    state: &AppState,
    ctx: &RequestContext,
    input: InvitationFinishInput,
) -> RpcResult<LoginFinishOutput> {
    let _admission = auth_limits::admit_login()?;
    input.vault.validate()?;
    let record = validate_registration(&input.registration_record)?;
    let exchange = take_exchange(state, &input.exchange, "register").await?;
    if exchange.session_id.is_some() || exchange.account_revision.is_some() {
        return Err(denied());
    }
    let invitation: super::invitations::Invitation =
        serde_json::from_slice(exchange.server_state.as_deref().ok_or_else(denied)?)
            .map_err(|_| denied())?;
    if input.vault.tenant != exchange.tenant || input.vault.username != exchange.username {
        return Err(denied());
    }
    let pool = state
        .tenants
        .tenant_pool(&exchange.tenant)
        .await
        .map_err(|_| denied())?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let (current, user) = super::invitations::registration_invitation(
        &mut tx,
        state.tenants.master(),
        &exchange.tenant,
        &invitation.id,
    )
    .await?;
    if current.signature != invitation.signature
        || exchange.user_id != Some(user)
        || current.username != exchange.username
    {
        return Err(denied());
    }
    // Every registration path locks the user first, so independent replicas
    // cannot race a new invitation into replacing an existing password vault.
    sqlx::query("SELECT id FROM users WHERE id=$1 AND deactivated_at IS NULL FOR UPDATE")
        .bind(user)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or_else(denied)?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM __zerotrust_accounts WHERE user_id=$1)")
            .bind(user)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    if exists
        || input.claim.revision != "1"
        || input.claim.encryption_key != input.vault.encryption_key
        || input.claim.signing_key != input.vault.signing_key
    {
        return Err(denied());
    }
    crypto::verify(
        &crypto::sized::<32>(&input.claim.signing_key)?,
        &input.claim.proof,
        &input.claim.frame(&current)?,
    )?;
    let claim_hash = input.claim.hash(&current)?;
    crypto::verify(
        &crypto::sized::<32>(&input.vault.signing_key)?,
        &input.proof,
        &crypto::frame(
            "sortsys/invitation-registration/v1",
            &[
                &exchange.tenant,
                &exchange.username,
                &current.id,
                &current.generation,
                &current.signature,
                &input.exchange,
                &encode(&Sha256::digest(&record)),
                &encode(&Sha256::digest(input.vault.frame())),
                &claim_hash,
            ],
        ),
    )?;
    sqlx::query("INSERT INTO __zerotrust_accounts(user_id,opaque_record,account_vault,encryption_key,signing_key,identity_certificate) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(user).bind(record).bind(serde_json::to_value(&input.vault).map_err(internal)?)
        .bind(crypto::sized::<32>(&input.vault.encryption_key)?.to_vec()).bind(crypto::sized::<32>(&input.vault.signing_key)?.to_vec())
        .bind(json!({"format":"pending"})).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_invitations SET claim=$2 WHERE id=$1")
        .bind(&current.id)
        .bind(serde_json::to_value(&input.claim).map_err(internal)?)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE users SET password=NULL WHERE id=$1")
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    crate::auth::expire_user_sessions(&mut tx, user, None)
        .await
        .map_err(internal)?;
    let user_agent = ctx
        .headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok());
    let address = ctx
        .headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    let session: i64 = sqlx::query_scalar(
        "INSERT INTO user_sessions(user_id,inet_addr,user_agent) VALUES($1,$2,$3) RETURNING id",
    )
    .bind(user)
    .bind(address)
    .bind(user_agent)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    if let (Some(key), Some(expires)) = (exchange.attempt_key, exchange.attempt_expires_at) {
        auth_limits::LoginAttempt::resume(key, expires)
            .succeeded(state.tenants.master())
            .await;
    }
    let token = state
        .auth
        .issue_user_token(&exchange.tenant, &session.to_string())
        .map_err(internal)?;
    Ok(LoginFinishOutput {
        token,
        tenant: exchange.tenant,
        username: exchange.username,
        vault: input.vault,
    })
}
