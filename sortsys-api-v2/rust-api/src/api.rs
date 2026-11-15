//! Shared request and response types used by multiple procedure modules.

use std::sync::Arc;

use serde::Serialize;
use ts_rs::TS;

use crate::{
    auth::AuthUser,
    error::{ErrorCode, RpcError},
    ids::Id,
    rpc::{ProcedureRegistry, ProcedureRegistryBuilder, RequestContext},
};

pub fn contract_registry() -> ProcedureRegistry {
    let builder = crate::contract_generated::FULL_CONTRACT
        .iter()
        .filter(|spec| {
            spec.path != "personalization.activity.list"
                && spec.path != "admin.login"
                && spec.path != "errorReports.report"
                && spec.path != "admin.errors.list"
                && !spec.path.starts_with("admin.tenants.")
        })
        .fold(ProcedureRegistryBuilder::default(), |builder, spec| {
            builder.raw_stub(spec)
        });

    crate::contracts::register_contract(builder).build()
}

pub(crate) fn register_session_auth(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let logout_state = Arc::clone(&service);
    let check_state = Arc::clone(&service);
    let session_state = Arc::clone(&service);
    builder
        .mutation("auth.logout", move |ctx: RequestContext, _input: ()| {
            let state = Arc::clone(&logout_state);
            async move {
                let auth = state.authenticate(&ctx.headers).await?;
                state.logout(&auth).await?;
                Ok(Success { success: true })
            }
        })
        .query("auth.check", move |ctx: RequestContext, _input: ()| {
            let state = Arc::clone(&check_state);
            async move {
                state.authenticate(&ctx.headers).await?;
                Ok(Success { success: true })
            }
        })
        .query(
            "auth.sessionInfo",
            move |ctx: RequestContext, _input: ()| {
                let state = Arc::clone(&session_state);
                async move {
                    let auth = state.authenticate(&ctx.headers).await?;
                    Ok(SessionInfo {
                        user: AuthUser {
                            id: wire_id(&auth.user.id)?,
                            ..auth.user
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
                            company_name: None,
                            object_storage_enabled: true,
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

#[derive(Debug, Serialize, TS)]
pub(crate) struct Success {
    #[ts(type = "true")]
    pub(crate) success: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    user: AuthUser,
    session: SessionInfoSession,
    roles: Vec<String>,
    tenant: SessionInfoTenant,
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

#[cfg(test)]
mod tests {
    #[test]
    fn client_contract_exposes_new_setup_without_live_sql_source_endpoints() {
        let contract = super::contract_registry().typescript_contract();
        assert!(contract.contains("\"auth.owner.finish\""));
        assert!(contract.contains("\"zerotrust.setup.backup.complete\""));
        assert!(!contract.contains("\"zerotrust.migration."));
        assert!(contract.contains("\"admin.storage.snapshots.create\""));
        assert!(!contract.contains("\"admin.databases."));
    }
}
