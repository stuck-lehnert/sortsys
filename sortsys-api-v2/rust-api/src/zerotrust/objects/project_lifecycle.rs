//! Project closure is derived from the signed canonical tombstone in the
//! selected content view. The per-transaction read also fences racing writes.
use super::{Facet, Id, RpcResult, SaveInput, forbidden, invalid, persistence};
use crate::control::Transaction;
use sortsys_zerotrust::metadata::RecordKey;
use std::collections::BTreeSet;

pub(in crate::zerotrust) fn project_scope(scope: &str) -> Option<&str> {
    let rest = scope.strip_prefix("project:")?;
    let (token, _) = rest.split_once(':').unwrap_or((rest, ""));
    let id = Id::decode(token).ok()?;
    if id.0 <= 0 || id.encode() != token {
        return None;
    }
    Some(&scope[.."project:".len() + token.len()])
}

pub(super) fn dependent_project(scope: &str, facet: Facet) -> Option<&str> {
    let project = project_scope(scope)?;
    // Keep the root accessible to authorized readers for signed deletion
    // verification and readback after a lost publication response.
    (project != scope || facet != Facet::MasterData).then_some(project)
}

pub(super) fn deletion(packet: &SaveInput) -> Option<&str> {
    let envelope = &packet.envelope;
    let root = project_scope(&envelope.scope)?;
    (envelope.is_tombstone()
        && envelope.facet == Facet::MasterData
        && envelope.scope == root
        && envelope.object == root
        && packet.domain == master_domain(root))
    .then_some(root)
}

fn master_domain(project: &str) -> String {
    format!("{project}:master-data")
}

fn master_record(project: &str) -> RecordKey {
    persistence::record_key(&master_domain(project), project)
}

pub(in crate::zerotrust) fn root_record_for_domain(domain: &str) -> Option<RecordKey> {
    let project = project_scope(domain)?;
    (domain != master_domain(project)).then(|| master_record(project))
}

fn deleted(record: Option<persistence::ObjectRecord>, project: &str) -> RpcResult<bool> {
    let Some(record) = record else {
        // Creation and backup adoption can provision areas before publishing
        // the master record. Only a terminal root closes the project.
        return Ok(false);
    };
    if record.object != project || record.domain != master_domain(project) {
        return Err(invalid());
    }
    Ok(record.tombstone || record.deleted)
}

pub(super) async fn closed<'a>(
    transaction: &mut Transaction,
    areas: impl Iterator<Item = (&'a str, Facet)>,
) -> RpcResult<BTreeSet<String>> {
    let projects: BTreeSet<_> = areas
        .filter_map(|(scope, facet)| dependent_project(scope, facet))
        .collect();
    let records = transaction
        .many(
            projects
                .iter()
                .map(|project| master_record(project))
                .collect(),
        )
        .await?;
    let mut result = BTreeSet::new();
    for (project, record) in projects.into_iter().zip(records) {
        if deleted(record, project)? {
            result.insert(project.to_owned());
        }
    }
    Ok(result)
}

pub(in crate::zerotrust) async fn is_active(
    transaction: &mut Transaction,
    scope: &str,
    facet: Facet,
) -> RpcResult<bool> {
    if let Some(project) = dependent_project(scope, facet) {
        let record = transaction.read(master_record(project)).await?;
        return Ok(!deleted(record, project)?);
    }
    Ok(true)
}

pub(super) async fn require_active(
    transaction: &mut Transaction,
    scope: &str,
    facet: Facet,
) -> RpcResult<()> {
    if !is_active(transaction, scope, facet).await? {
        return Err(forbidden());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_project_facets_share_a_root_without_closing_tombstone_reads() {
        assert_eq!(dependent_project("project:2", Facet::MasterData), None);
        assert_eq!(
            dependent_project("project:2", Facet::Attachment),
            Some("project:2")
        );
        assert_eq!(
            dependent_project("project:2:planning", Facet::MasterData),
            Some("project:2")
        );
        assert!(root_record_for_domain("project:2:master-data").is_none());
        assert_eq!(
            root_record_for_domain("project:2:daily-reports:master-data"),
            Some(master_record("project:2"))
        );
        assert!(root_record_for_domain("project:02:attachment").is_none());
        assert!(root_record_for_domain("commercial:2:attachment").is_none());
    }
}
