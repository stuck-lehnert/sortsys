//! Infrastructure registry and one-time initial ownership. A claimed tenant
//! cannot be initialized again; recovery is a separate, seed-authorized path.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sortsys_zerotrust::crypto::{identifier, sized};
use ts_rs::TS;

use super::{
    Repository, Transaction,
    accounts::{self, TenantStatus},
    conflict, key, unavailable,
};
use crate::error::{ErrorCode, RpcError, RpcResult};

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvisionRequest {
    pub name: String,
    pub operation: String,
    pub setup_token_hash: String,
}

/// Resolve only published tenants before opening a tenant database. Public
/// invitation and recovery endpoints must not create files for arbitrary names.
pub async fn published_repository(system: &Repository, tenant: &str) -> RpcResult<Repository> {
    identifier(tenant)?;
    let entry: RegistryEntry = system
        .read(key("tenants", tenant))
        .await?
        .value
        .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Tenant not found"))?;
    if entry.name != tenant {
        return Err(unavailable());
    }
    system.tenant(tenant)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryEntry {
    pub name: String,
    pub operation: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provisioning {
    pub name: String,
    pub operation: String,
    pub initial_token_hash: String,
    pub owner_id: i64,
    pub created_at: DateTime<Utc>,
    pub registered_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupGrant {
    pub operation: String,
    pub hash: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub name: String,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    pub owner_registered: bool,
    #[ts(type = "Date | null")]
    pub locked_at: Option<DateTime<Utc>>,
    #[ts(type = "Date | null")]
    pub deactivated_at: Option<DateTime<Utc>>,
    #[ts(type = "Date | null")]
    pub deleted_at: Option<DateTime<Utc>>,
}

pub fn normalized_name(value: &str) -> RpcResult<String> {
    let name = value.trim().to_lowercase();
    if name.is_empty()
        || name.len() > 63
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || name
            .bytes()
            .any(|byte| !byte.is_ascii_lowercase() && !byte.is_ascii_digit() && byte != b'-')
    {
        return Err(RpcError::new(ErrorCode::BadRequest, "Invalid tenant name"));
    }
    Ok(name)
}

pub fn provisioning_key() -> sortsys_zerotrust::metadata::RecordKey {
    key("tenant-provisioning", "current")
}

pub fn setup_grant_key() -> sortsys_zerotrust::metadata::RecordKey {
    key("tenant-setup-grant", "current")
}

pub async fn provision(system: &Repository, input: &ProvisionRequest) -> RpcResult<Summary> {
    let name = normalized_name(&input.name)?;
    identifier(&input.operation)?;
    sized::<32>(&input.setup_token_hash)?;
    let published = system
        .read::<RegistryEntry>(key("tenants", &name))
        .await?
        .value;
    if published
        .as_ref()
        .is_some_and(|entry| entry.operation != input.operation || entry.name != name)
    {
        return Err(conflict());
    }
    let tenant = system.tenant(&name)?;
    let mut transaction = tenant.transaction()?;
    let existing: Option<Provisioning> = transaction.read(provisioning_key()).await?;
    let provisioning = match existing {
        Some(existing) => {
            if existing.name != name
                || existing.operation != input.operation
                || existing.initial_token_hash != input.setup_token_hash
            {
                return Err(conflict());
            }
            existing
        }
        None => {
            if published.is_some() {
                return Err(conflict());
            }
            // Do not infer an empty tenant merely from a missing setup field.
            // Restored, partially prepared or already encrypted files cannot
            // acquire an operator-owned initialization grant this way.
            if transaction
                .read::<TenantStatus>(accounts::tenant_key())
                .await?
                .is_some()
                || transaction
                    .read::<Value>(key("crypto-root", "current"))
                    .await?
                    .is_some()
                || !transaction
                    .scan::<accounts::Account>("accounts", None)
                    .await?
                    .records
                    .is_empty()
            {
                return Err(conflict());
            }
            let now = Utc::now();
            let provisioning = Provisioning {
                name: name.clone(),
                operation: input.operation.clone(),
                initial_token_hash: input.setup_token_hash.clone(),
                owner_id: accounts::random_id()?,
                created_at: now,
                registered_at: None,
            };
            let grant = SetupGrant {
                operation: input.operation.clone(),
                hash: input.setup_token_hash.clone(),
                expires_at: now + chrono::Duration::days(7),
            };
            let status = TenantStatus {
                epoch: 1,
                locked_at: None,
                deactivated_at: None,
                deleted_at: None,
            };
            transaction.put(provisioning_key(), &provisioning).await?;
            transaction
                .put_protected(accounts::tenant_key(), &status)
                .await?;
            transaction
                .put_expiring(setup_grant_key(), &grant, grant.expires_at)
                .await?;
            transaction.commit().await?;
            provisioning
        }
    };
    // Publication follows the complete tenant-file commit. A lost response or
    // process failure between these commits is resumed with the same operation.
    let entry = RegistryEntry {
        name: name.clone(),
        operation: provisioning.operation.clone(),
        created_at: provisioning.created_at,
    };
    let mut registry = system.transaction()?;
    let previous: Option<RegistryEntry> = registry.read(key("tenants", &name)).await?;
    if let Some(previous) = previous {
        if previous.operation != entry.operation
            || previous.name != entry.name
            || previous.created_at != entry.created_at
        {
            return Err(conflict());
        }
    } else {
        registry.put(key("tenants", &name), &entry).await?;
        registry.commit().await?;
    }
    summary(system, &name).await
}

pub async fn summary(system: &Repository, name: &str) -> RpcResult<Summary> {
    let name = normalized_name(name)?;
    let entry = system
        .read::<RegistryEntry>(key("tenants", &name))
        .await?
        .value
        .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Tenant not found"))?;
    let tenant = system.tenant(&name)?;
    let provisioning = tenant
        .read::<Provisioning>(provisioning_key())
        .await?
        .value
        .ok_or_else(unavailable)?;
    let status = tenant
        .read::<TenantStatus>(accounts::tenant_key())
        .await?
        .value
        .ok_or_else(unavailable)?;
    if entry.name != name || provisioning.name != name || entry.operation != provisioning.operation
    {
        return Err(unavailable());
    }
    Ok(Summary {
        name,
        created_at: entry.created_at,
        owner_registered: provisioning.registered_at.is_some(),
        locked_at: status.locked_at,
        deactivated_at: status.deactivated_at,
        deleted_at: status.deleted_at,
    })
}

pub async fn renew_setup(system: &Repository, input: &ProvisionRequest) -> RpcResult<Summary> {
    let name = normalized_name(&input.name)?;
    identifier(&input.operation)?;
    sized::<32>(&input.setup_token_hash)?;
    summary(system, &name).await?;
    let tenant = system.tenant(&name)?;
    let mut transaction = tenant.transaction()?;
    let provisioning: Provisioning = transaction
        .read(provisioning_key())
        .await?
        .ok_or_else(unavailable)?;
    if provisioning.registered_at.is_some()
        || transaction
            .read::<Value>(key("crypto-root", "current"))
            .await?
            .is_some()
        || !transaction
            .scan::<accounts::Account>("accounts", None)
            .await?
            .records
            .is_empty()
    {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "An initialized tenant cannot receive a new setup link",
        ));
    }
    let previous: Option<SetupGrant> = transaction.read(setup_grant_key()).await?;
    if let Some(previous) = previous.filter(|grant| grant.operation == input.operation) {
        if previous.hash != input.setup_token_hash {
            return Err(conflict());
        }
    } else {
        let grant = SetupGrant {
            operation: input.operation.clone(),
            hash: input.setup_token_hash.clone(),
            expires_at: Utc::now() + chrono::Duration::days(7),
        };
        transaction
            .put_expiring(setup_grant_key(), &grant, grant.expires_at)
            .await?;
        transaction.commit().await?;
    }
    summary(system, &name).await
}

pub async fn setup_access(
    transaction: &mut Transaction,
    name: &str,
    expected_hash: &str,
) -> RpcResult<Provisioning> {
    let provisioning: Provisioning = transaction
        .read(provisioning_key())
        .await?
        .ok_or_else(accounts::denied)?;
    let grant: SetupGrant = transaction
        .read(setup_grant_key())
        .await?
        .ok_or_else(accounts::denied)?;
    let status: TenantStatus = transaction
        .read(accounts::tenant_key())
        .await?
        .ok_or_else(accounts::denied)?;
    if provisioning.name != name
        || provisioning.registered_at.is_some()
        || grant.hash != expected_hash
        || grant.expires_at <= Utc::now()
        || !status.available(Utc::now())
        || transaction
            .read::<Value>(key("crypto-root", "current"))
            .await?
            .is_some()
    {
        return Err(accounts::denied());
    }
    Ok(provisioning)
}

pub async fn claim(
    transaction: &mut Transaction,
    name: &str,
    expected_hash: &str,
    owner_id: i64,
) -> RpcResult<()> {
    let mut provisioning = setup_access(transaction, name, expected_hash).await?;
    if provisioning.owner_id != owner_id {
        return Err(accounts::denied());
    }
    provisioning.registered_at = Some(Utc::now());
    transaction.put(provisioning_key(), &provisioning).await?;
    transaction.delete(setup_grant_key()).await
}
