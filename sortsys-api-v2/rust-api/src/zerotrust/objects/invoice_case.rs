//! Retain the case projections of a sealed invoice, including the payment
//! status visible to readers who cannot open the billing facet.
use std::collections::BTreeMap;

use crate::control::{Transaction, key};
use crate::error::RpcResult;
use sortsys_zerotrust::anchors::{ANCHOR_COLLECTION, RecordAnchor};

use super::super::{access::MetadataContext, creation::COMMERCIAL_FACETS, documents::DocumentHead};
use super::persistence::{ObjectRecord, history_key, record_key};
use super::{Facet, SaveInput, conflict, invalid};

fn seal_object(scope: &str) -> RpcResult<String> {
    let id = scope.strip_prefix("commercial:").ok_or_else(invalid)?;
    Ok(format!("immutable:{scope}:master-data:invoice-seal:{id}"))
}

fn billing_object(scope: &str) -> RpcResult<String> {
    let id = scope.strip_prefix("commercial:").ok_or_else(invalid)?;
    Ok(format!("immutable:{scope}:billing:invoice:{id}"))
}

pub(in crate::zerotrust) async fn sealed(
    transaction: &mut Transaction,
    scope: &str,
) -> RpcResult<bool> {
    let seal = seal_object(scope)?;
    let domain = format!("{scope}:master-data");
    let record: Option<ObjectRecord> = transaction.read(record_key(&domain, &seal)).await?;
    let Some(record) = record else {
        return Ok(false);
    };
    require_receipt(&record, &domain, &seal)?;
    let billing = billing_object(scope)?;
    let domain = format!("{scope}:billing");
    let record: ObjectRecord = transaction
        .read(record_key(&domain, &billing))
        .await?
        .ok_or_else(conflict)?;
    require_receipt(&record, &domain, &billing)?;
    Ok(true)
}

fn require_receipt(record: &ObjectRecord, domain: &str, object: &str) -> RpcResult<()> {
    if record.deleted
        || record.tombstone
        || record.domain != domain
        || record.object != object
        || record.revision != "1"
    {
        return Err(conflict());
    }
    Ok(())
}

#[derive(Default)]
struct Writes {
    seal: bool,
    payment: bool,
    master: bool,
    other_case: bool,
}

pub(super) async fn retain(
    context: &mut MetadataContext,
    packets: &[&SaveInput],
    documents: &[DocumentHead],
) -> RpcResult<()> {
    let mut scopes = BTreeMap::<&str, Writes>::new();
    for packet in packets {
        let envelope = &packet.envelope;
        let scope = envelope.scope.as_str();
        if !scope.starts_with("commercial:") {
            continue;
        }
        let object = envelope.object.as_str();
        let facet = envelope.facet;
        if object == format!("{scope}:{}:case", facet.name()) {
            let writes = scopes.entry(scope).or_default();
            if facet == Facet::MasterData {
                writes.master = true;
            } else {
                writes.other_case = true;
            }
        } else if facet == Facet::MasterData && object == seal_object(scope)? {
            scopes.entry(scope).or_default().seal = true;
        } else if facet == Facet::Billing
            && sortsys_zerotrust::immutable::binding(envelope)?
                .is_some_and(|record| record.kind == "invoice-payment")
        {
            scopes.entry(scope).or_default().payment = true;
        }
    }

    for (scope, writes) in scopes {
        if !sealed(&mut context.transaction, scope).await? {
            if writes.seal || writes.payment {
                return Err(conflict());
            }
            continue;
        }
        let checkpoint = format!("issued-invoice-case:{scope}");
        let facets = if writes.seal {
            // Backup adoption seals a previously published source document in
            // a later batch while the pending tenant is still closed.
            if !documents
                .iter()
                .any(|head| head.scope == scope && head.locked)
            {
                super::super::bootstrap::require_pending(context).await?;
            }
            COMMERCIAL_FACETS.as_slice()
        } else {
            if !writes.master || !writes.payment || writes.other_case {
                return Err(conflict());
            }
            let previous = context
                .transaction
                .read::<RecordAnchor>(key(ANCHOR_COLLECTION, &checkpoint))
                .await?;
            if previous.is_some() {
                &[Facet::MasterData]
            } else {
                COMMERCIAL_FACETS.as_slice()
            }
        };
        retain_facets(&mut context.transaction, scope, &checkpoint, facets).await?;
    }
    Ok(())
}

async fn retain_facets(
    transaction: &mut Transaction,
    scope: &str,
    checkpoint: &str,
    facets: &[Facet],
) -> RpcResult<()> {
    let mut case_keys = Vec::new();
    for facet in facets {
        let domain = format!("{scope}:{}", facet.name());
        let object = format!("{domain}:case");
        case_keys.push(record_key(&domain, &object));
    }
    let records: Vec<Option<ObjectRecord>> = transaction.many(case_keys.clone()).await?;
    let mut retained = Vec::new();
    for (case_key, record) in case_keys.into_iter().zip(records) {
        let record = record.ok_or_else(conflict)?;
        if record.deleted || record.tombstone || record.object != case_key.key {
            return Err(conflict());
        }
        let history = history_key(&record.object, &record.revision)?;
        let event: String = transaction
            .read(history.clone())
            .await?
            .ok_or_else(conflict)?;
        transaction.protect_record(history).await?;
        transaction
            .protect_record(key("object-changes", &event))
            .await?;
        retained.extend([key("object-locations", &record.object), case_key]);
    }
    transaction.protect_records(checkpoint, &retained).await
}
