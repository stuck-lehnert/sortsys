//! Operator controls for the independent tenant registry. Organization contents
//! and user passwords are not part of these infrastructure procedures.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    api::Success,
    auth::AuthService,
    control::{
        accounts::{self, TenantStatus},
        tenants::{self, ListedTenant, ProvisionRequest, RegistryEntry, Summary},
    },
    error::{ErrorCode, RpcError, RpcResult},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct AdminLoginInput {
    tenant: Option<String>,
    password: String,
}
#[derive(Serialize, TS)]
struct AdminLoginOutput {
    token: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct TenantNameInput {
    name: String,
}

#[derive(Clone, Copy)]
enum Action {
    Activate,
    Deactivate,
    Delete,
    Undelete,
    Lock,
    Unlock,
}

pub(crate) fn register_operator(
    mut builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let login_service = Arc::clone(&service);
    builder = builder.mutation("admin.login", move |_, input: AdminLoginInput| {
        let service = Arc::clone(&login_service);
        async move {
            let started = Instant::now();
            let token = service
                .login_admin(&input.password, input.tenant.as_deref())
                .await;
            tokio::time::sleep(Duration::from_secs(3).saturating_sub(started.elapsed())).await;
            let token = token?.ok_or_else(|| {
                RpcError::new(ErrorCode::Unauthorized, "Login failed").with_http_code(401)
            })?;
            Ok(AdminLoginOutput { token })
        }
    });
    let list_service = Arc::clone(&service);
    builder = builder.query("admin.tenants.list", move |ctx, _: ()| {
        let service = Arc::clone(&list_service);
        async move {
            operator(&service, &ctx).await?;
            let system = service.records()?;
            let mut rows = Vec::new();
            let mut after = None;
            let mut version = None;
            loop {
                let page = system
                    .scan::<RegistryEntry>("tenants", after, version)
                    .await?;
                version = Some(page.version);
                for record in page.records {
                    let entry = record.value.ok_or_else(crate::control::unavailable)?;
                    if entry.name != record.record.key {
                        return Err(crate::control::unavailable());
                    }
                    let listed = match tenants::summary_for_entry(system, &entry).await {
                        Ok(summary) => ListedTenant::Available { summary },
                        Err(error) if error.http_code == Some(503) => ListedTenant::Unavailable {
                            name: entry.name,
                            created_at: entry.created_at,
                        },
                        Err(error) => return Err(error),
                    };
                    rows.push(listed);
                }
                after = page.after;
                if after.is_none() {
                    break;
                }
            }
            Ok(rows)
        }
    });
    let get_service = Arc::clone(&service);
    builder = builder.query("admin.tenants.get", move |ctx, input: TenantNameInput| {
        let service = Arc::clone(&get_service);
        async move {
            operator(&service, &ctx).await?;
            tenants::summary(service.records()?, &input.name).await
        }
    });
    let create_service = Arc::clone(&service);
    builder = builder.mutation(
        "admin.tenants.create",
        move |ctx, input: ProvisionRequest| {
            let service = Arc::clone(&create_service);
            async move {
                operator(&service, &ctx).await?;
                tenants::provision(service.records()?, &input).await
            }
        },
    );
    let setup_service = Arc::clone(&service);
    builder = builder.mutation(
        "admin.tenants.setupLink",
        move |ctx, input: ProvisionRequest| {
            let service = Arc::clone(&setup_service);
            async move {
                operator(&service, &ctx).await?;
                tenants::renew_setup(service.records()?, &input).await
            }
        },
    );
    for (path, action) in [
        ("admin.tenants.activate", Action::Activate),
        ("admin.tenants.deactivate", Action::Deactivate),
        ("admin.tenants.delete", Action::Delete),
        ("admin.tenants.undelete", Action::Undelete),
        ("admin.tenants.lock", Action::Lock),
        ("admin.tenants.unlock", Action::Unlock),
    ] {
        let action_service = Arc::clone(&service);
        builder = builder.mutation(path, move |ctx, input: TenantNameInput| {
            let service = Arc::clone(&action_service);
            async move {
                operator(&service, &ctx).await?;
                let name = tenants::normalized_name(&input.name)?;
                tenants::summary(service.records()?, &name).await?;
                let tenant = service.records()?.tenant(&name)?;
                let mut transaction = tenant.transaction()?;
                let mut status: TenantStatus = transaction
                    .read(accounts::tenant_key())
                    .await?
                    .ok_or_else(crate::control::unavailable)?;
                match action {
                    Action::Activate => status.deactivated_at = None,
                    Action::Deactivate => status.deactivated_at = Some(chrono::Utc::now()),
                    Action::Delete => status.deleted_at = Some(chrono::Utc::now()),
                    Action::Undelete => status.deleted_at = None,
                    Action::Lock => status.locked_at = Some(chrono::Utc::now()),
                    Action::Unlock => status.locked_at = None,
                }
                status.epoch = status
                    .epoch
                    .checked_add(1)
                    .ok_or_else(crate::control::unavailable)?;
                transaction
                    .put_protected(accounts::tenant_key(), &status)
                    .await?;
                transaction.commit().await?;
                Ok(Success { success: true })
            }
        });
    }
    builder
}

async fn operator(service: &AuthService, context: &RequestContext) -> RpcResult<()> {
    service.require_global_operator(&context.headers).await
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    let mut builder = builder
        .mutation_stub::<AdminLoginInput, AdminLoginOutput>("admin.login")
        .query_stub::<(), Vec<ListedTenant>>("admin.tenants.list")
        .query_stub::<TenantNameInput, Summary>("admin.tenants.get")
        .mutation_stub::<ProvisionRequest, Summary>("admin.tenants.create")
        .mutation_stub::<ProvisionRequest, Summary>("admin.tenants.setupLink");
    for path in [
        "admin.tenants.activate",
        "admin.tenants.deactivate",
        "admin.tenants.delete",
        "admin.tenants.undelete",
        "admin.tenants.lock",
        "admin.tenants.unlock",
    ] {
        builder = builder.mutation_stub::<TenantNameInput, Success>(path);
    }
    builder
}
