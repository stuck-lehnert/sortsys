//! Shared authorization and credential helpers for native admin procedures.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bcrypt::DEFAULT_COST;

use super::common::{bad_request, forbidden, internal, not_found};
use crate::{
    AppState,
    database::{AccessOptions, Tenant},
    error::RpcResult,
    rpc::RequestContext,
};

pub async fn admin_for(state: &AppState, context: &RequestContext) -> RpcResult<String> {
    state.auth.authenticate_admin(&context.headers).await
}

pub fn require_global(admin_for: &str) -> RpcResult<()> {
    if admin_for == "+all" {
        Ok(())
    } else {
        Err(forbidden())
    }
}

pub fn ensure_tenant_access(admin_for: &str, tenant_name: &str) -> RpcResult<()> {
    // Deliberately return NotFound instead of Forbidden so a tenant-scoped
    // administrator cannot use this API to enumerate other tenant names.
    if admin_for == "+all" || admin_for == tenant_name {
        Ok(())
    } else {
        Err(not_found())
    }
}

pub async fn tenant(state: &AppState, tenant_name: &str) -> RpcResult<Tenant> {
    state
        .tenants
        .tenant(tenant_name)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)
}

pub fn ensure_not_locked(admin_for: &str, tenant: &Tenant) -> RpcResult<()> {
    if admin_for == "+all"
        || tenant
            .locked_at
            .is_none_or(|locked| locked > chrono::Utc::now())
    {
        Ok(())
    } else {
        Err(forbidden())
    }
}

pub async fn tenant_pool_for_admin(
    state: &AppState,
    tenant_name: &str,
    admin_for: &str,
) -> RpcResult<sqlx::PgPool> {
    state
        .tenants
        .tenant_pool_with(
            tenant_name,
            AccessOptions {
                ignore_lock_and_deactivation: admin_for == "+all",
            },
        )
        .await
        .map_err(internal)
}

pub fn generated_password(byte_count: usize) -> RpcResult<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(internal)?;

    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub async fn password_hash(password: &str) -> RpcResult<String> {
    validate_admin_password(password)?;

    let password = password.to_owned();
    tokio::task::spawn_blocking(move || bcrypt::hash(password, DEFAULT_COST))
        .await
        .map_err(internal)?
        .map_err(internal)
}

pub fn validate_admin_password(password: &str) -> RpcResult<()> {
    if !(10..=2_000).contains(&password.len()) {
        return Err(bad_request(
            "password must contain between 10 and 2000 characters",
        ));
    }

    let allowed = |character: char| {
        character.is_ascii_alphanumeric() || "_~§$&+,:;=?@#|'<>.^*()%!{}[]-".contains(character)
    };

    if password.chars().all(allowed) {
        Ok(())
    } else {
        Err(bad_request("password contains unsupported characters"))
    }
}
