//! Opaque authentication, public authorization proofs and ciphertext persistence.
//! Operator-held credentials must never be used as tenant decryption keys.

mod access;
mod creation;
mod crypto;
mod delivery;
mod documents;
pub mod events;
mod file_chunks;
mod invitations;
mod migration;
mod objects;
mod opaque;
mod recovery;
mod setup;
mod staged;
mod stock;
mod wire;

use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{AppState, rpc::ProcedureRegistryBuilder};

pub(crate) async fn live_identity(
    state: &AppState,
    auth: &crate::auth::AuthResult,
) -> crate::error::RpcResult<(String, String)> {
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(crate::procedures::common::internal)?;
    let mut tx = pool
        .begin()
        .await
        .map_err(crate::procedures::common::internal)?;
    let identity = access::security(&mut tx, state.tenants.master(), auth, false).await?;
    Ok((identity.subject, identity.root.generation.to_string()))
}

pub(crate) async fn verify_live_identity(
    state: &AppState,
    auth: &crate::auth::AuthResult,
    generation: &str,
    ticket: &str,
    proof: &str,
) -> crate::error::RpcResult<()> {
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(crate::procedures::common::internal)?;
    let mut tx = pool
        .begin()
        .await
        .map_err(crate::procedures::common::internal)?;
    let identity = access::security(&mut tx, state.tenants.master(), auth, false).await?;
    if identity.root.generation.to_string() != generation {
        return Err(crate::procedures::common::forbidden());
    }
    crypto::verify(
        &identity.signing_key,
        proof,
        &crypto::frame(
            "sortsys/llm-live-browser/v1",
            &[
                &auth.tenant,
                &identity.subject,
                generation,
                &crypto::encode(&Sha256::digest(ticket.as_bytes())),
            ],
        ),
    )
}

pub async fn guard_legacy_request(
    state: &AppState,
    path: &str,
    context: &crate::rpc::RequestContext,
) -> crate::error::RpcResult<crate::rpc::RequestPermit> {
    if path == "ping"
        // Provider availability and token counts are technical metadata only.
        || path == "llm.status"
        || path.starts_with("auth.")
        || path.starts_with("admin.")
        || path.starts_with("zerotrust.")
        || path == "errorReports.report"
    {
        return Ok(Box::new(()));
    }
    let auth = state.auth.authenticate(&context.headers).await?;
    legacy_tenant_permit(
        state,
        &auth.tenant,
        matches!(path, "llm.messages.send" | "llm.proposals.review"),
    )
    .await
}

/// Internal legacy editor routes authenticate signed service sessions rather
/// than browser tokens. They must participate in the same cutover barrier.
pub(crate) async fn guard_legacy_tenant(
    state: &AppState,
    tenant: &str,
) -> crate::error::RpcResult<crate::rpc::RequestPermit> {
    legacy_tenant_permit(state, tenant, false).await
}

async fn legacy_tenant_permit(
    state: &AppState,
    tenant: &str,
    provider: bool,
) -> crate::error::RpcResult<crate::rpc::RequestPermit> {
    let pool = state
        .tenants
        .tenant_pool(tenant)
        .await
        .map_err(crate::procedures::common::internal)?;
    let slot = if provider {
        state.tenants.legacy_llm_request_slot(tenant).await
    } else {
        state.tenants.legacy_request_slot(tenant).await
    };
    let mut tx = pool
        .begin()
        .await
        .map_err(crate::procedures::common::internal)?;
    lock_cutover(&mut tx, false).await?;
    let phase: String = sqlx::query_scalar("SELECT phase FROM __zerotrust_state WHERE singleton")
        .fetch_one(&mut *tx)
        .await
        .map_err(crate::procedures::common::internal)?;
    if phase != "unenrolled" {
        return Err(crate::error::RpcError::new(
            crate::error::ErrorCode::Forbidden,
            "This tenant requires the encrypted data path",
        )
        .with_http_code(403));
    }
    Ok(Box::new((slot, tx)))
}

async fn lock_cutover(
    connection: &mut sqlx::PgConnection,
    exclusive: bool,
) -> crate::error::RpcResult<()> {
    // Keep this separate from the state row. A handler uses another connection
    // for its own write-trigger state lock; a queued state-row writer would
    // otherwise block that handler while waiting for its enclosing permit.
    let sql = if exclusive {
        "SELECT pg_advisory_xact_lock(hashtextextended('sortsys:zerotrust-cutover',0))"
    } else {
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('sortsys:zerotrust-cutover',0))"
    };
    sqlx::query(sql)
        .execute(connection)
        .await
        .map_err(crate::procedures::common::internal)?;
    Ok(())
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
struct EditorConfig {
    drawio_url: Option<String>,
    office_origin: Option<String>,
}

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let config = Arc::clone(&state);
    let builder = builder.query("zerotrust.editors.config", move |ctx, _: ()| {
        let state = Arc::clone(&config);
        async move {
            crate::procedures::common::authenticated_pool(&state, &ctx).await?;
            Ok(EditorConfig {
                office_origin: state
                    .config
                    .office_origin
                    .as_ref()
                    .map(|origin| origin.to_string()),
                drawio_url: state
                    .config
                    .drawio
                    .as_ref()
                    .map(|config| config.public_url.to_string()),
            })
        }
    });
    let builder = opaque::register(builder, Arc::clone(&state));
    let builder = setup::register(builder, Arc::clone(&state));
    let builder = objects::register(builder, Arc::clone(&state));
    let builder = stock::register(builder, Arc::clone(&state));
    let builder = delivery::register(builder, Arc::clone(&state));
    let builder = staged::register(builder, Arc::clone(&state));
    let builder = documents::register(builder, Arc::clone(&state));
    let builder = creation::register(builder, Arc::clone(&state));
    let builder = file_chunks::register(builder, Arc::clone(&state));
    let builder = invitations::register(builder, Arc::clone(&state));
    let builder = migration::register(builder, Arc::clone(&state));
    let builder = events::register(builder, Arc::clone(&state));
    recovery::register(builder, state)
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    let builder = builder.query_stub::<(), EditorConfig>("zerotrust.editors.config");
    let builder = documents::register_contract(builder);
    let builder = stock::register_contract(builder);
    let builder = delivery::register_contract(builder);
    let builder = staged::register_contract(builder);
    recovery::register_contract(events::register_contract(migration::register_contract(
        invitations::register_contract(objects::register_contract(setup::register_contract(
            creation::register_contract(file_chunks::register_contract(opaque::register_contract(
                builder,
            ))),
        ))),
    )))
}
