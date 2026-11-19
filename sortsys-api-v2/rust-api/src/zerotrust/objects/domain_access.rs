//! Preserve authorization independently from the frequently changing content
//! cursor. Restoring a cursor must never restore an older key membership.
use super::registry::DomainRecord;
use crate::{
    control::{Transaction, key},
    error::RpcResult,
    zerotrust::{crypto::invalid, wire::Facet},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DomainAccess {
    id: String,
    scope: String,
    facet: Facet,
    generation: String,
    policy_version: String,
    definitions: BTreeMap<String, Vec<String>>,
    recipients: BTreeMap<String, BTreeSet<String>>,
}

const COLLECTION: &str = "domain-access";

pub(super) fn record(id: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key(COLLECTION, id)
}

pub(in crate::zerotrust) async fn version(transaction: &mut Transaction) -> RpcResult<String> {
    transaction.collection_version(COLLECTION).await
}

pub(super) async fn check(transaction: &mut Transaction, area: &DomainRecord) -> RpcResult<()> {
    let access: DomainAccess = transaction
        .read(record(&area.id))
        .await?
        .ok_or_else(invalid)?;
    if access.id != area.id
        || access.scope != area.scope
        || access.facet != area.facet
        || access.generation != area.generation
        || access.policy_version != area.policy_version
        || access.definitions != area.definitions
        || access.recipients != area.recipients
    {
        return Err(invalid());
    }
    Ok(())
}

pub(super) async fn publish(transaction: &mut Transaction, area: &DomainRecord) -> RpcResult<()> {
    let access = DomainAccess {
        id: area.id.clone(),
        scope: area.scope.clone(),
        facet: area.facet,
        generation: area.generation.clone(),
        policy_version: area.policy_version.clone(),
        definitions: area.definitions.clone(),
        recipients: area.recipients.clone(),
    };
    transaction.put(key("domains", &area.id), area).await?;
    transaction.put_protected(record(&area.id), &access).await
}
