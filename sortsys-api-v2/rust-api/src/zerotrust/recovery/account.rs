//! Reusing an administrator is an explicit seed-authorized recovery target.
//! The full technical account is bound so concurrent credential, alias or
//! lifecycle changes cannot be overwritten by a previously prepared plan.
use super::super::setup::RootState;
use super::{ExistingAccount, conflict, encode, frame, invalid};
use crate::{
    control::{Transaction, accounts, key},
    error::{RpcResult, internal},
    ids::Id,
};
use sha2::{Digest, Sha256};

fn version(tenant: &str, account: &accounts::Account) -> RpcResult<String> {
    let content = encode(&serde_json::to_vec(account).map_err(internal)?);
    Ok(encode(&Sha256::digest(frame(
        "sortsys/recovery-account-state/v1",
        &[tenant, &content],
    ))))
}

fn subject_id(subject: &str) -> RpcResult<Id> {
    let id = subject
        .strip_prefix("user:")
        .and_then(|value| Id::decode(value).ok())
        .filter(|id| id.0 > 0 && accounts::subject(id.0) == subject)
        .ok_or_else(invalid)?;
    Ok(id)
}

async fn current(
    transaction: &mut Transaction,
    root: &RootState,
) -> RpcResult<Option<accounts::Account>> {
    let owner = &root.profile.owner;
    let id = subject_id(&owner.user)?;
    let Some(account) = transaction
        .read::<accounts::Account>(accounts::account_key(id.0))
        .await?
    else {
        return Ok(None);
    };
    // Recovery cannot resurrect a deleted profile or silently cancel a
    // suspension. An explicitly scheduled suspension is excluded as well.
    if !account.active(chrono::Utc::now()) || account.deactivated_at.is_some() {
        return Ok(None);
    }
    let credential = account.credential()?;
    if account.id != id.0
        || credential.vault.tenant != root.profile.authority.tenant
        || credential.vault.subject != owner.user
        || credential.vault.encryption_key != owner.encryption_key
        || credential.vault.signing_key != owner.signing_key
    {
        return Err(invalid());
    }
    Ok(Some(account))
}

pub(super) async fn describe(
    transaction: &mut Transaction,
    root: &RootState,
) -> RpcResult<Option<ExistingAccount>> {
    let Some(account) = current(transaction, root).await? else {
        return Ok(None);
    };
    Ok(Some(ExistingAccount {
        subject: accounts::subject(account.id),
        version: version(&root.profile.authority.tenant, &account)?,
        username: account.username,
    }))
}

pub(super) async fn target(
    transaction: &mut Transaction,
    root: &RootState,
    subject: &str,
    username: &str,
    expected: Option<&str>,
) -> RpcResult<Option<accounts::Account>> {
    let id = subject_id(subject)?;
    let alias: Option<accounts::Username> = transaction.read(key("usernames", username)).await?;
    if let Some(expected) = expected {
        if subject != root.profile.owner.user {
            return Err(invalid());
        }
        let account = current(transaction, root).await?.ok_or_else(conflict)?;
        if account.id != id.0
            || account.username != username
            || alias.as_ref().map(|alias| alias.user_id) != Some(id.0)
            || version(&root.profile.authority.tenant, &account)? != expected
        {
            return Err(conflict());
        }
        return Ok(Some(account));
    }
    let existing: Option<accounts::Account> = transaction.read(accounts::account_key(id.0)).await?;
    if existing.is_some() || alias.is_some() {
        return Err(conflict());
    }
    Ok(None)
}
