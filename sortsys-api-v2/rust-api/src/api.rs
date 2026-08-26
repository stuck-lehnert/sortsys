//! Shared request and response types used by multiple procedure modules.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::sleep;
use ts_rs::TS;

use crate::{
    AppState,
    error::{ErrorCode, RpcError},
    ids::Id,
    rpc::{ProcedureRegistry, ProcedureRegistryBuilder, RequestContext},
};

const MIN_LOGIN_TIME: Duration = Duration::from_secs(3);

pub fn registry(state: Arc<AppState>) -> ProcedureRegistry {
    let builder = ProcedureRegistryBuilder::default()
        .query("ping", |_ctx: RequestContext, _input: ()| async move {
            Ok("pong".to_owned())
        });
    let builder = register_auth(builder, Arc::clone(&state));
    crate::procedures::register(builder, state).build()
}

pub fn contract_registry() -> ProcedureRegistry {
    crate::contract_generated::FULL_CONTRACT
        .iter()
        .fold(ProcedureRegistryBuilder::default(), |builder, spec| {
            builder.raw_stub(spec)
        })
        .build()
}

fn register_auth(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let login_state = Arc::clone(&state);
    let logout_state = Arc::clone(&state);
    let check_state = Arc::clone(&state);
    let session_state = Arc::clone(&state);

    builder
        .mutation(
            "auth.login",
            move |ctx: RequestContext, input: LoginInput| {
                let state = Arc::clone(&login_state);
                async move {
                    let started = Instant::now();
                    let user_agent = ctx
                        .headers
                        .get("user-agent")
                        .and_then(|value| value.to_str().ok());
                    let inet_addr = ctx
                        .headers
                        .get("x-forwarded-for")
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.split(',').next())
                        .map(str::trim);
                    let token = state
                        .auth
                        .login(
                            input.tenant.trim(),
                            input.username.trim(),
                            input.password.trim(),
                            user_agent,
                            inet_addr,
                        )
                        .await;
                    sleep(MIN_LOGIN_TIME.saturating_sub(started.elapsed())).await;
                    token
                        .map(|token| LoginOutput { token })
                        .ok_or_else(|| unauthorized("Login failed"))
                }
            },
        )
        .mutation("auth.logout", move |ctx: RequestContext, _input: ()| {
            let state = Arc::clone(&logout_state);
            async move {
                let auth = state.auth.authenticate(&ctx.headers).await?;
                state.auth.logout(&auth).await?;
                Ok(Success { success: true })
            }
        })
        .query("auth.check", move |ctx: RequestContext, _input: ()| {
            let state = Arc::clone(&check_state);
            async move {
                state.auth.authenticate(&ctx.headers).await?;
                Ok(Success { success: true })
            }
        })
        .query(
            "auth.sessionInfo",
            move |ctx: RequestContext, _input: ()| {
                let state = Arc::clone(&session_state);
                async move {
                    let auth = state.auth.authenticate(&ctx.headers).await?;
                    let tenant = state
                        .tenants
                        .tenant(&auth.tenant)
                        .await
                        .map_err(|error| {
                            RpcError::new(ErrorCode::InternalServerError, error.to_string())
                        })?
                        .ok_or_else(|| unauthorized("Unauthorized"))?;
                    let company_name = tenant
                        .contact_details
                        .get("companyName")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let object_storage_enabled = tenant
                        .connection_details
                        .pointer("/objectStorage/enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    Ok(SessionInfo {
                        user: SessionInfoUser {
                            id: wire_id(&auth.user.id)?,
                            username: auth.user.username,
                            salutation: auth.user.salutation,
                            first_name: auth.user.first_name,
                            last_name: auth.user.last_name,
                            contract_type: auth.user.contract_type,
                            phone: auth.user.phone,
                            email: auth.user.email,
                        },
                        session: SessionInfoSession {
                            id: wire_id(&auth.session.id)?,
                            inet_addr: auth.session.inet_addr,
                            user_agent: auth.session.user_agent,
                            created_at: auth.session.created_at,
                            expires_at: auth.session.expires_at,
                        },
                        roles: auth.roles,
                        tenant: SessionInfoTenant {
                            company_name,
                            object_storage_enabled,
                        },
                    })
                }
            },
        )
}

fn wire_id(value: &str) -> Result<String, RpcError> {
    value
        .parse::<i64>()
        .map(Id)
        .map(Id::encode)
        .map_err(|error| RpcError::new(ErrorCode::InternalServerError, error.to_string()))
}

fn unauthorized(message: &str) -> RpcError {
    RpcError::new(ErrorCode::Unauthorized, message).with_http_code(401)
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct LoginInput {
    tenant: String,
    username: String,
    password: String,
}

#[derive(Debug, Serialize, TS)]
struct LoginOutput {
    token: String,
}

#[derive(Debug, Serialize, TS)]
pub(crate) struct Success {
    #[ts(type = "true")]
    pub(crate) success: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    user: SessionInfoUser,
    session: SessionInfoSession,
    roles: Vec<String>,
    tenant: SessionInfoTenant,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SessionInfoUser {
    id: String,
    username: String,
    salutation: Option<String>,
    first_name: String,
    last_name: Option<String>,
    #[ts(type = "\"internal\" | \"external\" | \"subcontractor\"")]
    contract_type: String,
    phone: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SessionInfoSession {
    id: String,
    inet_addr: Option<String>,
    user_agent: Option<String>,
    #[ts(type = "Date")]
    created_at: chrono::DateTime<chrono::Utc>,
    #[ts(type = "Date")]
    expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SessionInfoTenant {
    company_name: Option<String>,
    object_storage_enabled: bool,
}
