//! Passkey registration, discovery, authentication, listing, and deletion.
//!
//! Route handlers deliberately keep four visual phases: authentication,
//! validation, database work, and response construction. Cryptographic parsing
//! lives in `webauthn` so this module remains concerned with application flow.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, types::Json};
use tokio::time::sleep;
use ts_rs::TS;

use super::common::trim_required;
use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
    webauthn::{self, AuthenticationCredential, CredentialDescriptor, RegistrationCredential},
};

const MIN_LOGIN_TIME: Duration = Duration::from_secs(3);
const PASSKEY_REGISTER_PURPOSE: &str = "passkey-register";
const PASSKEY_LOGIN_PURPOSE: &str = "passkey-login";

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query("auth.passkeys.list", move |context, _input: ()| {
        let state = Arc::clone(&list_state);

        async move {
            let auth = state.auth.authenticate(&context.headers).await?;
            let pool = tenant_pool(&state, &auth.tenant).await?;
            let user_id = decimal_user_id(&auth.user.id)?;

            let rows = sqlx::query_as::<_, PasskeyListRow>(
                r#"
                SELECT id, label, created_at, last_used_at
                FROM user_passkeys
                WHERE user_id = $1
                ORDER BY created_at DESC
                "#,
            )
            .bind(user_id)
            .fetch_all(&pool)
            .await
            .map_err(internal)?;

            Ok(rows
                .into_iter()
                .map(PasskeyListItem::from)
                .collect::<Vec<_>>())
        }
    });

    let options_state = Arc::clone(&state);
    builder = builder.mutation(
        "auth.passkeys.registerOptions",
        move |context, _input: ()| {
            let state = Arc::clone(&options_state);

            async move { registration_options(&state, &context).await }
        },
    );

    let register_state = Arc::clone(&state);
    builder = builder.mutation(
        "auth.passkeys.register",
        move |context, mut input: RegistrationInput| {
            let state = Arc::clone(&register_state);

            async move {
                input.normalize()?;
                finish_registration(&state, &context, input).await
            }
        },
    );

    let delete_state = Arc::clone(&state);
    builder = builder.mutation(
        "auth.passkeys.delete",
        move |context, input: DeleteInput| {
            let state = Arc::clone(&delete_state);

            async move {
                let auth = state.auth.authenticate(&context.headers).await?;
                let pool = tenant_pool(&state, &auth.tenant).await?;
                let user_id = decimal_user_id(&auth.user.id)?;

                let deleted =
                    sqlx::query("DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2")
                        .bind(input.id.0)
                        .bind(user_id)
                        .execute(&pool)
                        .await
                        .map_err(internal)?;

                if deleted.rows_affected() == 0 {
                    return Err(not_found());
                }

                Ok(Success { success: true })
            }
        },
    );

    let login_options_state = Arc::clone(&state);
    builder = builder.mutation(
        "auth.passkeys.loginOptions",
        move |context, input: Option<LoginOptionsInput>| {
            let state = Arc::clone(&login_options_state);

            async move {
                let started = Instant::now();
                let result = login_options(&state, &context, input).await;

                sleep(MIN_LOGIN_TIME.saturating_sub(started.elapsed())).await;
                result
            }
        },
    );

    builder.mutation("auth.passkeys.login", move |context, input: LoginInput| {
        let state = Arc::clone(&state);

        async move {
            let started = Instant::now();
            let result = finish_login(&state, &context, input).await;

            sleep(MIN_LOGIN_TIME.saturating_sub(started.elapsed())).await;
            result
        }
    })
}

async fn registration_options(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<RegistrationOptionsOutput> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let origin = request_origin(context)?;
    let rp_id = webauthn::rp_id_from_origin(&origin)?;
    let challenge = webauthn::create_challenge();
    let user_id = decimal_user_id(&auth.user.id)?;
    let pool = tenant_pool(state, &auth.tenant).await?;

    let tenant = state
        .tenants
        .tenant(&auth.tenant)
        .await
        .map_err(internal)?
        .ok_or_else(unauthorized)?;
    let rows = sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_id, transports FROM user_passkeys WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    let challenge_token = webauthn::create_challenge_token(
        &state.auth,
        webauthn::ChallengeRequest {
            purpose: PASSKEY_REGISTER_PURPOSE,
            tenant: Some(auth.tenant.clone()),
            challenge: challenge.clone(),
            origin,
            rp_id: rp_id.clone(),
            user_id: Some(auth.user.id.clone()),
            username: None,
        },
    )?;

    let company_name = tenant
        .contact_details
        .get("companyName")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("sortsys")
        .to_owned();
    let display_name = [
        &auth.user.first_name,
        auth.user.last_name.as_deref().unwrap_or(""),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let display_name = if display_name.is_empty() {
        auth.user.username.clone()
    } else {
        display_name
    };

    Ok(RegistrationOptionsOutput {
        challenge_token,
        options: CreationOptions {
            challenge,
            rp: RelyingParty {
                name: company_name,
                id: rp_id,
            },
            user: PasskeyUser {
                id: webauthn::user_handle(&auth.tenant, &auth.user.id),
                name: format!("{}@{}", auth.user.username, auth.tenant),
                display_name,
            },
            pub_key_cred_params: vec![CredentialParameter {
                r#type: "public-key".to_owned(),
                alg: -7,
            }],
            timeout: webauthn::TIMEOUT_MS,
            attestation: "none".to_owned(),
            authenticator_selection: AuthenticatorSelection {
                resident_key: "required".to_owned(),
                require_resident_key: true,
                user_verification: "required".to_owned(),
            },
            exclude_credentials: rows
                .into_iter()
                .map(|row| CredentialDescriptor::public_key(row.credential_id, row.transports))
                .collect(),
        },
    })
}

async fn finish_registration(
    state: &AppState,
    context: &RequestContext,
    input: RegistrationInput,
) -> RpcResult<Success> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let origin = request_origin(context)?;
    let claims = webauthn::verify_challenge_token(
        &state.auth,
        &input.challenge_token,
        PASSKEY_REGISTER_PURPOSE,
    )?;

    if claims.tenant.as_deref() != Some(&auth.tenant)
        || claims.user_id.as_deref() != Some(&auth.user.id)
        || claims.origin != origin
    {
        return Err(unauthorized());
    }

    let registration = webauthn::verify_registration(
        &input.credential,
        &claims.challenge,
        &claims.origin,
        &claims.rp_id,
    )?;
    let pool = tenant_pool(state, &auth.tenant).await?;
    let user_id = decimal_user_id(&auth.user.id)?;

    let result = sqlx::query(
        r#"
        INSERT INTO user_passkeys (
            user_id,
            credential_id,
            public_key_jwk,
            sign_count,
            label,
            transports
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(user_id)
    .bind(registration.credential_id)
    .bind(Json(registration.public_key_jwk))
    .bind(i64::from(registration.counter))
    .bind(input.label)
    .bind(input.credential.transports.unwrap_or_default())
    .execute(&pool)
    .await;

    match result {
        Ok(_) => Ok(Success { success: true }),
        Err(error) if unique_violation(&error) => Err(conflict()),
        Err(error) => Err(internal(error)),
    }
}

async fn login_options(
    state: &AppState,
    context: &RequestContext,
    input: Option<LoginOptionsInput>,
) -> RpcResult<LoginOptionsOutput> {
    let origin = request_origin(context)?;
    let rp_id = webauthn::rp_id_from_origin(&origin)?;
    let challenge = webauthn::create_challenge();

    let Some(mut input) = input else {
        let challenge_token = webauthn::create_challenge_token(
            &state.auth,
            webauthn::ChallengeRequest {
                purpose: PASSKEY_LOGIN_PURPOSE,
                tenant: None,
                challenge: challenge.clone(),
                origin,
                rp_id: rp_id.clone(),
                user_id: None,
                username: None,
            },
        )?;

        return Ok(LoginOptionsOutput::discoverable(
            challenge_token,
            challenge,
            rp_id,
        ));
    };

    input.normalize()?;
    let pool = tenant_pool(state, &input.tenant)
        .await
        .map_err(|_| login_failed())?;
    let rows = sqlx::query_as::<_, CredentialRow>(
        r#"
        SELECT passkey.credential_id, passkey.transports
        FROM user_passkeys passkey
        JOIN users users ON users.id = passkey.user_id
        WHERE users.username = $1
          AND (users.deactivated_at IS NULL OR users.deactivated_at > NOW())
        "#,
    )
    .bind(&input.username)
    .fetch_all(&pool)
    .await
    .map_err(|_| login_failed())?;

    if rows.is_empty() {
        return Err(login_failed());
    }

    let challenge_token = webauthn::create_challenge_token(
        &state.auth,
        webauthn::ChallengeRequest {
            purpose: PASSKEY_LOGIN_PURPOSE,
            tenant: Some(input.tenant),
            challenge: challenge.clone(),
            origin,
            rp_id: rp_id.clone(),
            user_id: None,
            username: Some(input.username),
        },
    )?;

    Ok(LoginOptionsOutput {
        challenge_token,
        options: RequestOptions {
            challenge,
            rp_id,
            allow_credentials: rows
                .into_iter()
                .map(|row| CredentialDescriptor::public_key(row.credential_id, row.transports))
                .collect(),
            timeout: webauthn::TIMEOUT_MS,
            user_verification: "required".to_owned(),
        },
    })
}

async fn finish_login(
    state: &AppState,
    context: &RequestContext,
    input: LoginInput,
) -> RpcResult<LoginOutput> {
    input.validate()?;

    let origin = request_origin(context)?;
    let claims = webauthn::verify_challenge_token(
        &state.auth,
        &input.challenge_token,
        PASSKEY_LOGIN_PURPOSE,
    )
    .map_err(|_| login_failed())?;

    if claims.origin != origin {
        return Err(login_failed());
    }

    let user_handle = webauthn::parse_user_handle(input.credential.response.user_handle.as_deref());
    let tenant_names = match &claims.tenant {
        Some(tenant) => vec![tenant.to_lowercase()],
        None => {
            ordered_discovery_tenants(state, user_handle.as_ref().map(|value| value.0.as_str()))
                .await
                .map_err(|_| login_failed())?
        }
    };

    for tenant in tenant_names {
        let Some(login_row) = find_login_row(
            state,
            &tenant,
            &input.credential.raw_id,
            claims.username.as_deref(),
        )
        .await
        else {
            continue;
        };

        if claims.tenant.is_none() && user_handle.is_none() {
            continue;
        }
        if let Some((handle_tenant, handle_user_id)) = &user_handle
            && (handle_tenant != &tenant || *handle_user_id != login_row.user_id)
        {
            continue;
        }

        let assertion = match webauthn::verify_authentication(
            &input.credential,
            &login_row.public_key_jwk.0,
            &claims.challenge,
            &claims.origin,
            &claims.rp_id,
        ) {
            Ok(assertion) => assertion,
            Err(_) => continue,
        };

        if assertion.credential_id != login_row.credential_id {
            continue;
        }

        let stored_counter = login_row.sign_count.max(0) as u32;
        if stored_counter > 0 && assertion.counter > 0 && assertion.counter <= stored_counter {
            continue;
        }

        if let Some(token) = create_passkey_session(
            state,
            context,
            &tenant,
            login_row,
            stored_counter.max(assertion.counter),
        )
        .await
        {
            return Ok(LoginOutput { token });
        }
    }

    Err(login_failed())
}

async fn find_login_row(
    state: &AppState,
    tenant: &str,
    credential_id: &str,
    username: Option<&str>,
) -> Option<LoginRow> {
    let pool = state.tenants.tenant_pool(tenant).await.ok()?;

    sqlx::query_as::<_, LoginRow>(
        r#"
        SELECT
            users.id AS user_id,
            passkey.id AS passkey_id,
            passkey.credential_id,
            passkey.public_key_jwk,
            passkey.sign_count
        FROM user_passkeys passkey
        JOIN users users ON users.id = passkey.user_id
        WHERE passkey.credential_id = $1
          AND ($2::TEXT IS NULL OR users.username = $2)
          AND (users.deactivated_at IS NULL OR users.deactivated_at > NOW())
        "#,
    )
    .bind(credential_id)
    .bind(username)
    .fetch_optional(&pool)
    .await
    .ok()
    .flatten()
}

async fn create_passkey_session(
    state: &AppState,
    context: &RequestContext,
    tenant: &str,
    login_row: LoginRow,
    next_counter: u32,
) -> Option<String> {
    let pool = state.tenants.tenant_pool(tenant).await.ok()?;
    let mut transaction = pool.begin().await.ok()?;

    sqlx::query(
        r#"
        UPDATE user_passkeys
        SET sign_count = $2, last_used_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(login_row.passkey_id)
    .bind(i64::from(next_counter))
    .execute(&mut *transaction)
    .await
    .ok()?;

    let session_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO user_sessions (user_id, inet_addr, user_agent)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(login_row.user_id)
    .bind(request_inet_addr(context))
    .bind(request_user_agent(context))
    .fetch_one(&mut *transaction)
    .await
    .ok()?;

    transaction.commit().await.ok()?;

    state
        .auth
        .issue_user_token(tenant, &session_id.to_string())
        .ok()
}

async fn ordered_discovery_tenants(
    state: &AppState,
    preferred: Option<&str>,
) -> Result<Vec<String>, crate::database::DatabaseError> {
    let mut names = state.tenants.live_tenant_names().await?;

    if let Some(index) =
        preferred.and_then(|preferred| names.iter().position(|candidate| candidate == preferred))
    {
        let preferred = names.remove(index);
        names.insert(0, preferred);
    }

    Ok(names)
}

async fn tenant_pool(state: &AppState, tenant: &str) -> RpcResult<sqlx::PgPool> {
    state.tenants.tenant_pool(tenant).await.map_err(internal)
}

fn request_origin(context: &RequestContext) -> RpcResult<String> {
    context
        .headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .filter(|origin| !origin.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| bad_request("Missing Origin header"))
}

fn request_user_agent(context: &RequestContext) -> Option<&str> {
    context
        .headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
}

fn request_inet_addr(context: &RequestContext) -> Option<&str> {
    context
        .headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
}

fn decimal_user_id(value: &str) -> RpcResult<i64> {
    value.parse().map_err(internal)
}

fn unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string())
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message.into()).with_http_code(400)
}

fn unauthorized() -> RpcError {
    RpcError::new(ErrorCode::Unauthorized, "Unauthorized").with_http_code(401)
}

fn login_failed() -> RpcError {
    RpcError::new(ErrorCode::Unauthorized, "Login failed").with_http_code(401)
}

fn not_found() -> RpcError {
    RpcError::new(ErrorCode::NotFound, "Passkey not found").with_http_code(404)
}

fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Passkey is already registered").with_http_code(409)
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationInput {
    challenge_token: String,
    label: String,
    credential: RegistrationCredential,
}

impl RegistrationInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.challenge_token, "challengeToken", 20_000)?;
        trim_required(&mut self.label, "label", 160)?;
        self.credential.validate()
    }
}

impl RegistrationCredential {
    fn validate(&self) -> RpcResult<()> {
        bounded(&self.id, "credential.id", 4_000)?;
        bounded(&self.raw_id, "credential.rawId", 4_000)?;
        bounded(
            &self.response.client_data_json,
            "credential.response.clientDataJSON",
            20_000,
        )?;
        bounded(
            &self.response.attestation_object,
            "credential.response.attestationObject",
            20_000,
        )?;

        if self.transports.as_ref().is_some_and(|values| {
            values
                .iter()
                .any(|value| value.is_empty() || value.len() > 64)
        }) {
            return Err(bad_request("Invalid credential transport"));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteInput {
    id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginOptionsInput {
    tenant: String,
    username: String,
}

impl LoginOptionsInput {
    fn normalize(&mut self) -> RpcResult<()> {
        self.tenant = self.tenant.trim().to_lowercase();
        self.username = self.username.trim().to_lowercase();

        bounded(&self.tenant, "tenant", 127)?;
        bounded(&self.username, "username", 127)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginInput {
    challenge_token: String,
    credential: AuthenticationCredential,
}

impl LoginInput {
    fn validate(&self) -> RpcResult<()> {
        bounded(&self.challenge_token, "challengeToken", 20_000)?;
        bounded(&self.credential.id, "credential.id", 4_000)?;
        bounded(&self.credential.raw_id, "credential.rawId", 4_000)?;
        bounded(
            &self.credential.response.client_data_json,
            "credential.response.clientDataJSON",
            20_000,
        )?;
        bounded(
            &self.credential.response.authenticator_data,
            "credential.response.authenticatorData",
            20_000,
        )?;
        bounded(
            &self.credential.response.signature,
            "credential.response.signature",
            20_000,
        )
    }
}

fn bounded(value: &str, field: &str, maximum: usize) -> RpcResult<()> {
    if value.is_empty() || value.len() > maximum {
        Err(bad_request(format!("Invalid {field}")))
    } else {
        Ok(())
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct PasskeyListItem {
    id: Id,
    label: String,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date | null")]
    last_used_at: Option<DateTime<Utc>>,
}

impl From<PasskeyListRow> for PasskeyListItem {
    fn from(row: PasskeyListRow) -> Self {
        Self {
            id: Id(row.id),
            label: row.label,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct RegistrationOptionsOutput {
    challenge_token: String,
    options: CreationOptions,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CreationOptions {
    challenge: String,
    rp: RelyingParty,
    user: PasskeyUser,
    pub_key_cred_params: Vec<CredentialParameter>,
    timeout: u32,

    #[ts(type = "\"none\"")]
    attestation: String,

    authenticator_selection: AuthenticatorSelection,
    exclude_credentials: Vec<CredentialDescriptor>,
}

#[derive(Debug, Serialize, TS)]
struct RelyingParty {
    name: String,
    id: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct PasskeyUser {
    id: String,
    name: String,
    display_name: String,
}

#[derive(Debug, Serialize, TS)]
struct CredentialParameter {
    #[ts(type = "\"public-key\"")]
    r#type: String,
    alg: i32,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AuthenticatorSelection {
    #[ts(type = "\"required\"")]
    resident_key: String,

    #[ts(type = "true")]
    require_resident_key: bool,

    #[ts(type = "\"required\"")]
    user_verification: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LoginOptionsOutput {
    challenge_token: String,
    options: RequestOptions,
}

impl LoginOptionsOutput {
    fn discoverable(challenge_token: String, challenge: String, rp_id: String) -> Self {
        Self {
            challenge_token,
            options: RequestOptions {
                challenge,
                rp_id,
                allow_credentials: Vec::new(),
                timeout: webauthn::TIMEOUT_MS,
                user_verification: "required".to_owned(),
            },
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct RequestOptions {
    challenge: String,
    rp_id: String,
    allow_credentials: Vec<CredentialDescriptor>,
    timeout: u32,

    #[ts(type = "\"required\"")]
    user_verification: String,
}

#[derive(Debug, Serialize, TS)]
struct LoginOutput {
    token: String,
}

#[derive(Debug, FromRow)]
struct PasskeyListRow {
    id: i64,
    label: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct CredentialRow {
    credential_id: String,
    transports: Vec<String>,
}

#[derive(Debug, FromRow)]
struct LoginRow {
    user_id: i64,
    passkey_id: i64,
    credential_id: String,
    public_key_jwk: Json<Value>,
    sign_count: i64,
}

#[cfg(test)]
mod tests {
    use super::{LoginOptionsInput, bounded};

    #[test]
    fn normalizes_login_identity_and_bounds_browser_values() {
        let mut input = LoginOptionsInput {
            tenant: " Tenant-One ".to_owned(),
            username: " Alice ".to_owned(),
        };

        input.normalize().unwrap();

        assert_eq!(input.tenant, "tenant-one");
        assert_eq!(input.username, "alice");
        assert!(bounded("", "credential", 10).is_err());
        assert!(bounded("valid", "credential", 10).is_ok());
    }
}
