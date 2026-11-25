//! Close the reference race after coverage has been checked. Large registers
//! can name more cases than fit in a transaction's point-check budget.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};
use sortsys_zerotrust::metadata::RecordKey;

use super::{CommercialLinks, address, conflict};
use crate::{
    control::{Transaction, key},
    error::RpcResult,
    zerotrust::{documents::blob, objects::ObjectRecord},
};

const COLLECTION: &str = "commercial-retirements";

pub(in crate::zerotrust) fn fence_key() -> RecordKey {
    key(COLLECTION, "enabled")
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Kind {
    Case,
    Document,
}

type Shard<'a> = BTreeSet<&'a str>;
type Shards<'a> = BTreeMap<(Kind, u8), Shard<'a>>;

fn shard_records<'a>(ids: impl IntoIterator<Item = (Kind, &'a str)>) -> Shards<'a> {
    let mut shards = Shards::new();
    for (kind, id) in ids {
        let bucket = Sha256::digest(id.as_bytes())[0];
        shards.entry((kind, bucket)).or_default().insert(id);
    }

    shards
}

fn shard_key((kind, bucket): (Kind, u8)) -> RecordKey {
    let prefix = match kind {
        Kind::Case => "case",
        Kind::Document => "document",
    };
    key(COLLECTION, &format!("{prefix}:{bucket:02x}"))
}

async fn retired_ids<'a>(
    transaction: &mut Transaction,
    shards: Shards<'a>,
) -> RpcResult<BTreeSet<(Kind, &'a str)>> {
    // At most 512 checks, including missing buckets. A concurrent retirement
    // changes a checked bucket before either writer can commit stale results.
    let records = transaction
        .many::<BTreeSet<String>>(shards.keys().copied().map(shard_key).collect())
        .await?;

    let mut result = BTreeSet::new();
    for (((kind, _), ids), retired) in shards.into_iter().zip(records) {
        if let Some(retired) = retired {
            result.extend(
                ids.into_iter()
                    .filter(|id| retired.contains(*id))
                    .map(|id| (kind, id)),
            );
        }
    }

    Ok(result)
}

/// Only actual writes need to supply a proof. A legacy write must observe the
/// first retirement as a conflict, even if its encrypted references are unknown.
pub(super) async fn check_publication(
    transaction: &mut Transaction,
    links: Option<&CommercialLinks>,
) -> RpcResult<()> {
    if !enabled(transaction).await? {
        return Ok(());
    }

    let shards = shard_records(link_ids(links.ok_or_else(conflict)?));
    require_active(transaction, shards).await
}

fn link_ids(links: &CommercialLinks) -> impl Iterator<Item = (Kind, &str)> {
    let cases = links.case_ids().iter().map(|id| (Kind::Case, id.as_str()));
    let documents = match links {
        CommercialLinks::Case(case) => case.documents.as_slice(),
        _ => &[],
    };
    let documents = documents.iter().flat_map(|doc| {
        std::iter::once(doc.id.as_str())
            .chain(doc.source.as_deref())
            .map(|id| (Kind::Document, id))
    });
    cases.chain(documents)
}

async fn require_active(transaction: &mut Transaction, shards: Shards<'_>) -> RpcResult<()> {
    if !retired_ids(transaction, shards).await?.is_empty() {
        return Err(conflict());
    }

    Ok(())
}

/// The view is already prepared. Validate owners as well as references,
/// since activation does not go through the ordinary publication checks.
pub(super) async fn check_restored_links(
    transaction: &mut Transaction,
    entries: &[(Option<&str>, CommercialLinks)],
) -> RpcResult<()> {
    let shards = shard_records(entries.iter().flat_map(|(owner, links)| {
        owner
            .iter()
            .map(|id| (Kind::Case, *id))
            .chain(link_ids(links))
    }));
    require_active(transaction, shards).await
}

pub(in crate::zerotrust) async fn check_restored_documents(
    transaction: &mut Transaction,
    documents: &[(&str, &str)],
) -> RpcResult<()> {
    let shards = shard_records(documents.iter().copied().flat_map(|(scope, id)| {
        std::iter::once((Kind::Document, id)).chain(
            scope
                .strip_prefix("commercial:")
                .map(|case| (Kind::Case, case)),
        )
    }));
    require_active(transaction, shards).await
}

pub(in crate::zerotrust) async fn enabled(transaction: &mut Transaction) -> RpcResult<bool> {
    match transaction.read::<bool>(fence_key()).await? {
        None => Ok(false),
        Some(true) => Ok(true),
        Some(false) => Err(conflict()),
    }
}

/// Document heads and encrypted parts can be written independently of the case
/// packet. Both the owning case and the global document ID must stay active.
pub(in crate::zerotrust) async fn check_document_publication(
    transaction: &mut Transaction,
    scope: &str,
    id: &str,
) -> RpcResult<()> {
    if !document_is_active(transaction, scope, id).await? {
        return Err(conflict());
    }

    Ok(())
}

/// Case facets and retained snapshots can be written without a document ID.
pub(in crate::zerotrust) async fn check_scope_publication(
    transaction: &mut Transaction,
    scope: &str,
) -> RpcResult<()> {
    let Some(case) = scope.strip_prefix("commercial:") else {
        return Ok(());
    };

    if case_is_retired(transaction, case).await? {
        return Err(conflict());
    }

    Ok(())
}

pub(super) async fn case_is_retired(transaction: &mut Transaction, case: &str) -> RpcResult<bool> {
    if !enabled(transaction).await? {
        return Ok(false);
    }
    let shards = shard_records([(Kind::Case, case)]);
    Ok(!retired_ids(transaction, shards).await?.is_empty())
}

/// Read the fence in the same content view as the document reference.
pub(in crate::zerotrust) async fn document_is_active(
    transaction: &mut Transaction,
    scope: &str,
    id: &str,
) -> RpcResult<bool> {
    let Some(case) = scope.strip_prefix("commercial:") else {
        return Ok(true);
    };
    if !enabled(transaction).await? {
        return Ok(true);
    }

    let retired = retired_ids(
        transaction,
        shard_records([(Kind::Case, case), (Kind::Document, id)]),
    )
    .await?;

    Ok(retired.is_empty())
}

/// Resolve all relevant IDs in one batch, including retained blobs whose
/// reference can outlive the active case packet.
pub(in crate::zerotrust) async fn hidden_objects(
    transaction: &mut Transaction,
    records: &[ObjectRecord],
) -> RpcResult<Vec<usize>> {
    if !records
        .iter()
        .any(|row| row.domain.starts_with("commercial:"))
        || !enabled(transaction).await?
    {
        return Ok(Vec::new());
    }

    let mut indexed = Vec::new();
    for (index, row) in records.iter().enumerate() {
        let Some((scope, _)) = row.domain.rsplit_once(':') else {
            continue;
        };
        let Some(case) = scope.strip_prefix("commercial:") else {
            continue;
        };
        let document = blob(&row.object)?.map(|blob| blob.id);
        indexed.push((
            index,
            (Kind::Case, case),
            document.map(|id| (Kind::Document, id)),
        ));
    }

    let shards = shard_records(
        indexed
            .iter()
            .flat_map(|(_, case, document)| std::iter::once(*case).chain(*document)),
    );
    let retired = retired_ids(transaction, shards).await?;
    Ok(indexed
        .into_iter()
        .filter(|(_, case, document)| {
            retired.contains(case) || document.is_some_and(|id| retired.contains(&id))
        })
        .map(|(index, _, _)| index)
        .collect())
}

/// Commit the fences with the offer retirement. Pin them so even a later
/// content view sees the same retired IDs. This alone does not reconcile
/// restored objects that already refer to those IDs.
/// The caller must first verify coverage and authorize the retirement.
#[allow(dead_code)] // No retirement RPC until document and restore paths are fenced.
pub(in crate::zerotrust) async fn retire(
    transaction: &mut Transaction,
    case: &str,
    documents: &BTreeSet<String>,
) -> RpcResult<()> {
    address(case)?;
    for id in documents {
        address(id)?;
    }

    let ids = std::iter::once((Kind::Case, case))
        .chain(documents.iter().map(|id| (Kind::Document, id.as_str())));
    let shards = shard_records(ids);
    transaction
        .prefetch_protected(
            std::iter::once(fence_key())
                .chain(shards.keys().copied().map(shard_key))
                .collect(),
        )
        .await?;

    match transaction.read::<bool>(fence_key()).await? {
        None => transaction.put_protected(fence_key(), &true).await?,
        Some(false) => return Err(conflict()),
        Some(true) => {}
    }

    for (shard, ids) in shards {
        let record = shard_key(shard);
        let mut retired = transaction
            .read::<BTreeSet<String>>(record.clone())
            .await?
            .unwrap_or_default();

        for id in ids {
            if !retired.insert(id.to_owned()) {
                return Err(conflict());
            }
        }

        transaction.put_protected(record, &retired).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests;
