//! Public inventory accounting shares the key publication's CAS transaction.
use crate::{
    control::{Transaction, key},
    error::{ErrorCode, RpcError, RpcResult},
};
use sortsys_zerotrust::{
    metadata::RecordKey,
    recovery_inventory::{DEFAULT_RECOVERY_LIMITS, RecoveryInventory},
};

pub(in crate::zerotrust) fn record_key() -> RecordKey {
    key("domain-inventory", "current")
}

fn capacity_reached() -> RpcError {
    RpcError::new(
        ErrorCode::BadRequest,
        "Protected tenant recovery capacity reached",
    )
}

async fn current(transaction: &mut Transaction) -> RpcResult<RecoveryInventory> {
    transaction
        .read::<RecoveryInventory>(record_key())
        .await?
        .ok_or_else(super::invalid)?
        .validate(DEFAULT_RECOVERY_LIMITS)
        .map_err(Into::into)
}

pub(in crate::zerotrust) async fn reserve_key(
    transaction: &mut Transaction,
    new_domain: bool,
) -> RpcResult<()> {
    let inventory = current(transaction).await?;
    let next = inventory
        .reserve(
            RecoveryInventory {
                domains: u32::from(new_domain),
                key_generations: 1,
            },
            DEFAULT_RECOVERY_LIMITS,
        )
        .map_err(|_| capacity_reached())?;
    transaction.put_protected(record_key(), &next).await
}

pub(super) async fn reserve_recovery(
    transaction: &mut Transaction,
    domains: usize,
    keys: usize,
) -> RpcResult<()> {
    let expected = RecoveryInventory {
        domains: u32::try_from(domains).map_err(|_| super::invalid())?,
        key_generations: u32::try_from(keys).map_err(|_| super::invalid())?,
    };
    let inventory = current(transaction).await?;
    if inventory != expected {
        return Err(super::conflict());
    }
    let next = inventory
        .reserve(
            RecoveryInventory {
                domains: 0,
                key_generations: inventory.domains,
            },
            DEFAULT_RECOVERY_LIMITS,
        )
        .map_err(|_| capacity_reached())?;
    transaction.put_protected(record_key(), &next).await
}
