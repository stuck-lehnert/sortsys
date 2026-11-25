//! Check deletion against current object locations, not the proof inventory.

use std::collections::BTreeSet;

use super::{
    Attestation, CommercialLinks, LinkAddress, address, case_address, conflict, reconciliation,
    retirement,
};
use crate::{
    control::{Transaction, key},
    error::RpcResult,
    zerotrust::{
        content::content_number,
        creation::COMMERCIAL_FACETS,
        documents::DocumentHead,
        objects::{DomainRecord, ObjectRecord, invoice_case, metadata_record_key},
    },
};

const LOCATIONS: &str = "object-locations";
const PAGE: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CoveredDocuments {
    pub ids: BTreeSet<String>,
    pub heads: Vec<String>,
}

/// Return only the target's document IDs and the subset with an active head.
/// Noneditable imports can appear in the roster without a head.
/// The caller must authorize and commit retirement in this same transaction.
pub(super) async fn verify(
    transaction: &mut Transaction,
    target: &str,
) -> RpcResult<CoveredDocuments> {
    address(target)?;

    let (domain, object) = case_address(target);
    let location: Option<String> = transaction.read(key(LOCATIONS, &object)).await?;
    if location.as_deref() != Some(domain.as_str()) {
        return Err(conflict());
    }

    let Some(CommercialLinks::Case(links)) = current_links(transaction, &domain, &object).await?
    else {
        return Err(conflict());
    };
    if !links.standalone_offer {
        return Err(conflict());
    }

    let documents = links.documents.into_iter().map(|doc| doc.id).collect();
    let heads = verify_document_heads(transaction, target, &documents).await?;
    verify_locations(
        transaction,
        LocationCheck::Retirement {
            target,
            documents: &documents,
        },
    )
    .await?;

    Ok(CoveredDocuments {
        ids: documents,
        heads,
    })
}

/// Hide the current case and remove its document heads instead of deleting
/// retained packets or releasing any number claims. The caller must authorize
/// the command in the same transaction.
#[allow(dead_code)] // Not routed until the legacy-data cutover is defined.
pub(super) async fn stage_removal(
    transaction: &mut Transaction,
    target: &str,
    expected_reference: &str,
) -> RpcResult<()> {
    address(target)?;
    let (domain, object) = case_address(target);
    let record_key = metadata_record_key(&domain, &object);
    let mut record: ObjectRecord = transaction
        .read(record_key.clone())
        .await?
        .ok_or_else(conflict)?;

    // A revision number alone does not identify the same packet after restore.
    if record.reference != expected_reference
        || record.domain != domain
        || record.object != object
        || record.tombstone
        || invoice_case::sealed(transaction, &format!("commercial:{target}")).await?
    {
        return Err(conflict());
    }

    // An authenticated replay can confirm the original outcome only against
    // the same packet in the active view and its durable retirement fence.
    if record.deleted {
        return if retirement::case_is_retired(transaction, target).await? {
            Ok(())
        } else {
            Err(conflict())
        };
    }

    let documents = verify(transaction, target).await?;
    retirement::retire(transaction, target, &documents.ids).await?;
    record.deleted = true;
    transaction.put(record_key, &record).await?;

    let heads: Vec<_> = documents
        .heads
        .iter()
        .map(|id| key("documents", id))
        .collect();
    transaction.prefetch(heads.clone()).await?;
    for head in heads {
        transaction.delete(head).await?;
    }

    // Advance the observable sequence even for a projection whose encrypted
    // record remains physically present but is now hidden by the scope fence.
    let scope = format!("commercial:{target}");
    let keys: Vec<_> = COMMERCIAL_FACETS
        .iter()
        .map(|facet| key("domains", &format!("{scope}:{}", facet.name())))
        .collect();
    let areas = transaction.many::<DomainRecord>(keys.clone()).await?;
    let content = content_number(transaction).await?;
    for ((record, facet), area) in keys.into_iter().zip(COMMERCIAL_FACETS).zip(areas) {
        let Some(mut area) = area else { continue };
        if area.id != record.key || area.scope != scope || area.facet != facet {
            return Err(conflict());
        }

        area.advance_objects(transaction, content, false).await?;
    }

    Ok(())
}

#[derive(Clone, Copy)]
enum LocationCheck<'a> {
    Retirement {
        target: &'a str,
        documents: &'a BTreeSet<String>,
    },
    Restore,
}

/// Prepared content bypasses object publication. Check the active packets in
/// the selected view against the same proofs and durable retirement records.
pub(in crate::zerotrust) async fn verify_restored_locations(
    transaction: &mut Transaction,
) -> RpcResult<()> {
    verify_locations(transaction, LocationCheck::Restore).await
}

async fn verify_locations(
    transaction: &mut Transaction,
    check: LocationCheck<'_>,
) -> RpcResult<()> {
    for prefix in [
        "commercial:",
        "financial:",
        "immutable:project:",
        "project:",
    ] {
        let mut cursor = None;
        loop {
            let page = transaction
                .scan_prefix::<String>(LOCATIONS, prefix, cursor, PAGE)
                .await?;
            let mut candidates = Vec::new();
            let mut keys = Vec::new();

            for location in page.records {
                let domain = location.value.ok_or_else(conflict)?;
                let object = location.record.key;
                let Some(address) = LinkAddress::at(&domain, &object) else {
                    continue;
                };
                if matches!(check, LocationCheck::Retirement { target, .. }
                    if address == LinkAddress::Case(target))
                {
                    continue;
                }

                keys.extend([metadata_record_key(&domain, &object), address.record()]);
                candidates.push((domain, object));
            }

            transaction.prefetch(keys).await?;
            let mut restored = Vec::new();
            for (domain, object) in &candidates {
                let Some(links) = current_links(transaction, domain, object).await? else {
                    continue;
                };

                match check {
                    LocationCheck::Retirement { target, documents } => {
                        if refers_to(&links, target, documents) {
                            return Err(conflict());
                        }
                    }
                    LocationCheck::Restore => {
                        let owner = match LinkAddress::at(domain, object) {
                            Some(LinkAddress::Case(id)) => Some(id),
                            _ => None,
                        };
                        restored.push((owner, links));
                    }
                }
            }

            if !restored.is_empty() {
                retirement::check_restored_links(transaction, &restored).await?;
            }

            let Some(after) = page.after else { break };
            cursor = Some(after);
        }
    }

    Ok(())
}

async fn verify_document_heads(
    transaction: &mut Transaction,
    target: &str,
    documents: &BTreeSet<String>,
) -> RpcResult<Vec<String>> {
    let scope = format!("commercial:{target}");
    let mut cursor = None;
    let mut heads = Vec::new();
    loop {
        let page = transaction
            .scan_with_limit::<DocumentHead>("documents", cursor, PAGE)
            .await?;

        for record in page.records {
            let head = record.value.ok_or_else(conflict)?;
            // A head can be published on its own. Require it to agree with
            // the case roster; a claim to a foreign head also blocks retirement.
            if head.id != record.record.key || (head.scope == scope) != documents.contains(&head.id)
            {
                return Err(conflict());
            }
            if head.scope == scope {
                heads.push(head.id);
            }
        }

        let Some(after) = page.after else { break };
        cursor = Some(after);
    }

    Ok(heads)
}

async fn current_links(
    transaction: &mut Transaction,
    domain: &str,
    object: &str,
) -> RpcResult<Option<CommercialLinks>> {
    let record: ObjectRecord = transaction
        .read(metadata_record_key(domain, object))
        .await?
        .ok_or_else(conflict)?;
    if record.domain != domain || record.object != object {
        return Err(conflict());
    }
    if record.deleted || record.tombstone {
        return Ok(None);
    }

    let address = LinkAddress::at(domain, object).ok_or_else(conflict)?;
    let stored = transaction.read::<Attestation>(address.record()).await?;
    let proof = match stored {
        Some(proof) if proof.reference.is_some() => proof,
        legacy => {
            let reviewed = reconciliation::reviewed_attestation(
                transaction,
                domain,
                object,
                &record.reference,
            )
            .await?
            .ok_or_else(conflict)?;

            if let Some(legacy) = legacy {
                let (_, statement) = reviewed.links.statement(&address, &reviewed.packet_hash)?;
                if !legacy.acknowledges(&address, &record.reference, &statement)? {
                    return Err(conflict());
                }
            }

            reviewed
        }
    };

    Ok(Some(bound_links(address, &record.reference, proof)?))
}

fn bound_links(
    address: LinkAddress<'_>,
    reference: &str,
    proof: Attestation,
) -> RpcResult<CommercialLinks> {
    if proof.reference.as_deref() != Some(reference) {
        return Err(conflict());
    }

    match (address, proof.links) {
        (LinkAddress::Case(_), links @ CommercialLinks::Case(_))
        | (LinkAddress::Financial { .. }, links @ CommercialLinks::Financial(_))
        | (LinkAddress::ProjectRegister { .. }, links @ CommercialLinks::ProjectRegister(_)) => {
            Ok(links)
        }
        _ => Err(conflict()),
    }
}

fn refers_to(links: &CommercialLinks, target: &str, documents: &BTreeSet<String>) -> bool {
    if links
        .case_ids()
        .binary_search_by(|id| id.as_str().cmp(target))
        .is_ok()
    {
        return true;
    }

    let CommercialLinks::Case(links) = links else {
        return false;
    };
    links.documents.iter().any(|document| {
        // Document heads are addressed by ID, not by case. A second claim to
        // the same ID also blocks retirement.
        documents.contains(&document.id)
            || document
                .source
                .as_ref()
                .is_some_and(|source| documents.contains(source))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::Repository;
    use crate::zerotrust::commercial_links::{
        CaseLinks, DocumentLink, FinancialLink, ProjectRegisterLinks,
        retirement::{fence_key, retire},
    };

    async fn fixture_repositories(tenant: &str) -> (Repository, Repository) {
        use crate::{
            control::tenants,
            quack_store::{CipherStore, QuackConfig},
            zerotrust::crypto::{encode, random_id},
        };

        assert_eq!(
            std::env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref(),
            Ok("1")
        );
        let config = QuackConfig::from_env().unwrap().unwrap();
        assert!(config.control_url.starts_with("http://127.0.0.1:"));
        assert!(config.token.starts_with("sortsys-disposable-"));
        let first = Repository::system(CipherStore::new(config.clone()).unwrap());
        let second = Repository::system(CipherStore::new(config).unwrap());

        tenants::provision(
            &first,
            &tenants::ProvisionRequest {
                name: tenant.into(),
                operation: random_id().unwrap(),
                setup_token_hash: encode(&[7; 32]),
            },
        )
        .await
        .unwrap();

        (
            first.tenant(tenant).unwrap(),
            second.tenant(tenant).unwrap(),
        )
    }

    fn fixture_document_head() -> DocumentHead {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/zerotrust-document.json"
        ))
        .unwrap();
        serde_json::from_value(fixture["head"].clone()).unwrap()
    }

    #[tokio::test]
    #[ignore = "scripts/test-native-auth provides a disposable DuckDB store"]
    async fn concurrent_heads_and_object_locations_invalidate_coverage() {
        use crate::{error::ErrorCode, zerotrust::crypto::encode};

        let tenant = "commercial-link-coverage";
        let (first, second) = fixture_repositories(tenant).await;

        // This fixture exercises the metadata CAS, not packet publication.
        let mut initial = first.transaction().unwrap();
        let domain = "commercial:7:master-data";
        let object = "commercial:7:master-data:case";
        put_fixture(
            &mut initial,
            domain,
            object,
            Some(CommercialLinks::Case(CaseLinks {
                standalone_offer: true,
                parent_case: None,
                documents: vec![DocumentLink {
                    id: "4".into(),
                    source: None,
                }],
                signature: "fixture".into(),
            })),
        )
        .await;
        let area = DomainRecord {
            id: domain.into(),
            scope: "commercial:7".into(),
            facet: crate::zerotrust::wire::Facet::MasterData,
            generation: "1".into(),
            policy_version: "1".into(),
            sequence: "1".into(),
            definitions: Default::default(),
            recipients: Default::default(),
        };
        initial.put(key("domains", domain), &area).await.unwrap();
        initial.commit().await.unwrap();

        let mut before_head = first.transaction().unwrap();
        let documents = verify(&mut before_head, "7").await.unwrap();
        assert_eq!(documents.ids, BTreeSet::from(["4".into()]));
        assert!(documents.heads.is_empty());
        stage_removal(&mut before_head, "7", "fixture-reference")
            .await
            .unwrap();

        let mut head = fixture_document_head();
        head.scope = "commercial:7".into();
        head.id = "5".into();

        let mut document = second.transaction().unwrap();
        document.put(key("documents", "5"), &head).await.unwrap();
        document.commit().await.unwrap();
        assert_eq!(
            before_head.commit().await.unwrap_err().code,
            ErrorCode::Conflict
        );
        let mut fresh = first.transaction().unwrap();
        assert!(fresh.read::<bool>(fence_key()).await.unwrap().is_none());
        assert_eq!(
            verify(&mut fresh, "7").await.unwrap_err().code,
            ErrorCode::Conflict
        );

        // The case roster cannot claim a head owned by another case.
        head.scope = "commercial:9".into();
        head.id = "4".into();
        let mut document = second.transaction().unwrap();
        document.delete(key("documents", "5")).await.unwrap();
        document.put(key("documents", "4"), &head).await.unwrap();
        document.commit().await.unwrap();
        let mut fresh = first.transaction().unwrap();
        assert_eq!(
            verify(&mut fresh, "7").await.unwrap_err().code,
            ErrorCode::Conflict
        );

        head.scope = "commercial:7".into();
        let mut document = second.transaction().unwrap();
        document.put(key("documents", "4"), &head).await.unwrap();
        document.commit().await.unwrap();

        let mut checked = first.transaction().unwrap();
        let documents = verify(&mut checked, "7").await.unwrap();
        assert_eq!(documents.ids, BTreeSet::from(["4".into()]));
        assert_eq!(documents.heads, ["4"]);
        stage_removal(&mut checked, "7", "fixture-reference")
            .await
            .unwrap();

        let mut dependent = second.transaction().unwrap();
        let domain = "project:3:procurement";
        let object = "project:3:procurement:workflow:register";
        put_fixture(&mut dependent, domain, object, None).await;
        dependent.commit().await.unwrap();

        assert_eq!(
            checked.commit().await.unwrap_err().code,
            ErrorCode::Conflict
        );
        let mut fresh = first.transaction().unwrap();
        assert!(fresh.read::<bool>(fence_key()).await.unwrap().is_none());
        assert_eq!(
            verify(&mut fresh, "7").await.unwrap_err().code,
            ErrorCode::Conflict
        );

        let mut attested = second.transaction().unwrap();
        put_fixture(
            &mut attested,
            domain,
            object,
            Some(CommercialLinks::ProjectRegister(ProjectRegisterLinks {
                project_cases: vec!["7".into()],
                signature: "fixture".into(),
            })),
        )
        .await;
        attested.commit().await.unwrap();

        let mut fresh = first.transaction().unwrap();
        assert_eq!(
            verify(&mut fresh, "7").await.unwrap_err().code,
            ErrorCode::Conflict
        );

        // Only the selected prepared view contains this reference. A later
        // retirement must invalidate both review and activation of the view.
        let prepared = sortsys_zerotrust::content_epoch::ContentEpoch {
            format: "zt-content-epoch-v1".into(),
            tenant: tenant.into(),
            authority_generation: "1".into(),
            number: "1".into(),
            previous: None,
            source_number: "0".into(),
            source_head: None,
            snapshot: encode(&[15; 32]),
            actor: "test-authority".into(),
            signature: String::new(),
        };
        let domain = "project:3:billing";
        let object = "financial:3:invoice:4";
        let mut fixture = first.transaction().unwrap();
        fixture.select_prepared_content(&prepared).await.unwrap();
        put_fixture(&mut fixture, domain, object, None).await;
        fixture.commit().await.unwrap();

        let mut deletion = second.transaction().unwrap();
        retire(&mut deletion, "8", &BTreeSet::new()).await.unwrap();
        deletion.commit().await.unwrap();

        let mut checked = first.transaction().unwrap();
        checked.select_prepared_content(&prepared).await.unwrap();
        assert!(retirement::enabled(&mut checked).await.unwrap());
        assert_eq!(
            verify_restored_locations(&mut checked)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
        );

        let proof = Attestation {
            packet_hash: "fixture-packet".into(),
            reference: Some("fixture-reference".into()),
            links: CommercialLinks::Financial(FinancialLink {
                financial_case: Some("9".into()),
                signature: "fixture".into(),
            }),
        };
        let mut review = second.transaction().unwrap();
        review.select_prepared_content(&prepared).await.unwrap();
        review
            .put_protected(
                reconciliation::reviewed_key(domain, object, "fixture-reference"),
                &proof,
            )
            .await
            .unwrap();
        review.commit().await.unwrap();

        let mut checked = first.transaction().unwrap();
        checked.select_prepared_content(&prepared).await.unwrap();
        let address = LinkAddress::at(domain, object).unwrap();
        assert!(
            checked
                .read::<Attestation>(address.record())
                .await
                .unwrap()
                .is_none()
        );
        verify_restored_locations(&mut checked).await.unwrap();

        let mut deletion = second.transaction().unwrap();
        retire(&mut deletion, "9", &BTreeSet::new()).await.unwrap();
        deletion.commit().await.unwrap();
        assert_eq!(
            checked.validate().await.unwrap_err().code,
            ErrorCode::Conflict
        );

        let mut fresh = first.transaction().unwrap();
        fresh.select_prepared_content(&prepared).await.unwrap();
        assert_eq!(
            verify_restored_locations(&mut fresh)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
        );

        // An already deleted object may keep its location. It must not block
        // restoration of the remaining live records.
        let mut fixture = first.transaction().unwrap();
        fixture.select_prepared_content(&prepared).await.unwrap();
        let restored_record = metadata_record_key(domain, object);
        let mut row = fixture
            .read::<ObjectRecord>(restored_record.clone())
            .await
            .unwrap()
            .unwrap();
        row.tombstone = true;
        fixture.put(restored_record, &row).await.unwrap();
        fixture.commit().await.unwrap();

        let mut fresh = first.transaction().unwrap();
        fresh.select_prepared_content(&prepared).await.unwrap();
        verify_restored_locations(&mut fresh).await.unwrap();
        fresh.validate().await.unwrap();

        // Remove the live fixture's dependency and verify both the rejected
        // stale command and the successful, peer-visible removal.
        let mut clear_dependency = second.transaction().unwrap();
        put_fixture(
            &mut clear_dependency,
            "project:3:procurement",
            "project:3:procurement:workflow:register",
            Some(CommercialLinks::ProjectRegister(ProjectRegisterLinks {
                project_cases: Vec::new(),
                signature: "fixture".into(),
            })),
        )
        .await;
        clear_dependency.commit().await.unwrap();

        let mut stale = first.transaction().unwrap();
        assert_eq!(
            stage_removal(&mut stale, "7", "stale-reference")
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
        );

        let before = second.changes(None, 0).await.unwrap().head;
        let mut removal = first.transaction().unwrap();
        stage_removal(&mut removal, "7", "fixture-reference")
            .await
            .unwrap();
        removal.commit().await.unwrap();

        let mut peer = second.transaction().unwrap();
        let (domain, object) = case_address("7");
        let row: ObjectRecord = peer
            .read(metadata_record_key(&domain, &object))
            .await
            .unwrap()
            .unwrap();
        assert!(row.deleted);
        assert_eq!(row.reference, "fixture-reference");
        assert!(
            peer.read::<DocumentHead>(key("documents", "4"))
                .await
                .unwrap()
                .is_none()
        );
        let area: DomainRecord = peer.read(key("domains", &domain)).await.unwrap().unwrap();
        assert_eq!(area.sequence, "2");
        verify_restored_locations(&mut peer).await.unwrap();
        peer.validate().await.unwrap();

        let changes = second.changes(Some(before), 0).await.unwrap();
        assert_eq!(changes.events.len(), 1);
        assert_eq!(changes.events[0].hints.len(), 1);
        let hint = &changes.events[0].hints[0];
        assert_eq!(hint.channel, "object");
        let hint: serde_json::Value = serde_json::from_str(&hint.value).unwrap();
        assert_eq!(hint["domain"], domain);
        assert_eq!(hint["sequence"], "2");
        assert_eq!(hint["staged"], false);

        let mut replay = second.transaction().unwrap();
        stage_removal(&mut replay, "7", "fixture-reference")
            .await
            .unwrap();
        replay.commit().await.unwrap();

        let mut confirmed = first.transaction().unwrap();
        let area: DomainRecord = confirmed
            .read(key("domains", &domain))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(area.sequence, "2", "replay does not republish the deletion");
        assert_eq!(
            stage_removal(&mut confirmed, "7", "stale-reference")
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
        );
    }

    #[tokio::test]
    #[ignore = "scripts/test-native-auth provides a disposable DuckDB store"]
    async fn large_offer_retirement_commits_all_heads_in_one_change() {
        use crate::{
            ids::Id,
            quack_store::QuackConfig,
            zerotrust::opaque::measured_store,
        };
        use sortsys_zerotrust::metadata::MAX_OPERATIONS;

        let tenant = "commercial-large-retirement";
        let (first, second) = fixture_repositories(tenant).await;
        let (domain, object) = case_address("7");
        let documents = (0..=MAX_OPERATIONS)
            .map(|offset| DocumentLink {
                id: Id(100 + offset as i64).encode(),
                source: None,
            })
            .collect::<Vec<_>>();

        // Populate logical metadata through the same store, without signing
        // thousands of fixture packets or seeding their file contents.
        let mut head = fixture_document_head();
        head.scope = "commercial:7".into();
        for chunk in documents.chunks(MAX_OPERATIONS) {
            let mut batch = first.transaction().unwrap();
            batch
                .prefetch(chunk.iter().map(|doc| key("documents", &doc.id)).collect())
                .await
                .unwrap();
            for doc in chunk {
                head.id.clone_from(&doc.id);
                batch.put(key("documents", &head.id), &head).await.unwrap();
            }
            batch.commit().await.unwrap();
        }

        let mut initial = first.transaction().unwrap();
        head.scope = "commercial:8".into();
        head.id = "4".into();
        initial
            .put(key("documents", &head.id), &head)
            .await
            .unwrap();

        put_fixture(
            &mut initial,
            &domain,
            &object,
            Some(CommercialLinks::Case(CaseLinks {
                standalone_offer: true,
                parent_case: None,
                documents,
                signature: "fixture".into(),
            })),
        )
        .await;
        initial.commit().await.unwrap();

        let before = second.changes(None, 0).await.unwrap().head;
        let config = QuackConfig::from_env().unwrap().unwrap();
        let (store, probe, _proxy) = measured_store(&config).await;
        let remover = Repository::system(store).tenant(tenant).unwrap();
        let unrelated_head = key("documents", "4");

        // This fixture uses the initial epoch. Verify the proxy sees its
        // document collection before measuring a separate transaction.
        let mut control = remover.transaction().unwrap();
        let observed = control
            .read::<DocumentHead>(unrelated_head.clone())
            .await
            .unwrap();
        assert!(observed.is_some());
        assert!(
            probe.take_reads().iter().any(|records| records.contains(&unrelated_head)),
            "proxy did not observe the control document read"
        );

        let mut removal = remover.transaction().unwrap();
        stage_removal(&mut removal, "7", "fixture-reference")
            .await
            .unwrap();
        removal.commit().await.unwrap();

        // The inventory scan is paged. Any point reads needed to stage the
        // deletions must be batched, rather than one store call per head.
        let head_reads = probe
            .take_reads()
            .into_iter()
            .filter(|records| {
                records
                    .iter()
                    .any(|record| record.collection == unrelated_head.collection)
            })
            .count();
        assert!(head_reads <= 2, "1025 document heads took {head_reads} point-read calls");

        // More head deletions than fit in a regular batch must still produce
        // one commit. The peer sees the retired case and the unrelated head.
        let changes = second.changes(Some(before), 0).await.unwrap();
        assert_eq!(changes.events.len(), 1);

        let mut peer = second.transaction().unwrap();
        let case: ObjectRecord = peer
            .read(metadata_record_key(&domain, &object))
            .await
            .unwrap()
            .unwrap();
        assert!(case.deleted);

        let active = peer.scan::<DocumentHead>("documents", None).await.unwrap();
        assert!(active.after.is_none());
        assert_eq!(active.records.len(), 1);
        assert_eq!(active.records[0].record.key, "4");
        assert_eq!(
            active.records[0].value.as_ref().unwrap().scope,
            "commercial:8"
        );
        peer.validate().await.unwrap();
    }

    async fn put_fixture(
        transaction: &mut Transaction,
        domain: &str,
        object: &str,
        proof: Option<CommercialLinks>,
    ) {
        transaction
            .put(key(LOCATIONS, object), &domain)
            .await
            .unwrap();
        let record = ObjectRecord {
            domain: domain.into(),
            object: object.into(),
            revision: "1".into(),
            reference: "fixture-reference".into(),
            deleted: false,
            tombstone: false,
        };
        transaction
            .put(metadata_record_key(domain, object), &record)
            .await
            .unwrap();
        if let Some(links) = proof {
            let address = LinkAddress::at(domain, object).unwrap();
            transaction
                .put(
                    address.record(),
                    &Attestation {
                        packet_hash: "fixture-packet".into(),
                        reference: Some(record.reference),
                        links,
                    },
                )
                .await
                .unwrap();
        }
    }

    #[test]
    fn only_a_proof_for_the_current_storage_reference_covers_an_active_packet() {
        let address = || LinkAddress::at("project:3:billing", "financial:3:invoice:4").unwrap();
        let proof = |reference: Option<&str>| Attestation {
            packet_hash: "signed-packet".into(),
            reference: reference.map(str::to_owned),
            links: CommercialLinks::Financial(FinancialLink {
                financial_case: None,
                signature: "author-signature".into(),
            }),
        };

        for reference in [None, Some("content-1")] {
            assert!(bound_links(address(), "content-2", proof(reference)).is_err());
        }
        assert!(bound_links(address(), "content-2", proof(Some("content-2"))).is_ok());
        assert!(
            bound_links(
                LinkAddress::Case("4"),
                "content-2",
                proof(Some("content-2"))
            )
            .is_err()
        );
    }

    #[test]
    fn all_incoming_case_and_document_relationships_block_removal() {
        let documents = BTreeSet::from(["4".into(), "5".into()]);
        let case = |parent: Option<&str>, document: &str, source: Option<&str>| {
            CommercialLinks::Case(CaseLinks {
                standalone_offer: false,
                parent_case: parent.map(str::to_owned),
                documents: vec![DocumentLink {
                    id: document.into(),
                    source: source.map(str::to_owned),
                }],
                signature: String::new(),
            })
        };
        let financial = |id: Option<&str>| {
            CommercialLinks::Financial(FinancialLink {
                financial_case: id.map(str::to_owned),
                signature: String::new(),
            })
        };
        let register = CommercialLinks::ProjectRegister(ProjectRegisterLinks {
            project_cases: vec!["2".into(), "7".into()],
            signature: String::new(),
        });

        assert!(refers_to(&case(Some("7"), "9", None), "7", &documents));
        assert!(refers_to(&case(None, "9", Some("5")), "7", &documents));
        assert!(refers_to(&case(None, "5", None), "7", &documents));
        assert!(refers_to(&financial(Some("7")), "7", &documents));
        assert!(refers_to(&register, "7", &documents));
        assert!(!refers_to(
            &case(Some("8"), "9", Some("7")),
            "7",
            &documents
        ));
        assert!(!refers_to(&financial(None), "7", &documents));
        assert!(!refers_to(&register, "8", &documents));
    }
}
