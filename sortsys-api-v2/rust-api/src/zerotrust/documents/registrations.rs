//! References to the exact encrypted case facets when a document is locked.
//! A restored case can recover one missing row without restoring the case itself.
use super::*;
use crate::control::{Transaction, key};
use crate::rpc::RequestContext;

use super::super::{
    access::{MetadataContext, MetadataRequest},
    objects::persistence::{ObjectRecord, read, record_key},
    wire::EncryptedObject,
};

pub(in crate::zerotrust) const COLLECTION: &str = "locked-document-registrations";
const REGISTRATION_FACETS: [Facet; 6] = [
    Facet::MasterData,
    Facet::Attachment,
    Facet::Billing,
    Facet::OfferPrices,
    Facet::Calculation,
    Facet::Procurement,
];

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    head: String,
    facets: Vec<RegisteredFacet>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RegisteredFacet {
    facet: Facet,
    revision: String,
    reference: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct ListInput {
    scope: String,
    #[ts(optional)]
    sequence: Option<String>,
    #[ts(optional)]
    after: Option<String>,
    #[ts(optional)]
    prepared: Option<super::super::content::PreparedView>,
}

#[derive(Serialize, TS)]
pub(super) struct Page {
    documents: Vec<OpenedRegistration>,
    after: Option<String>,
}

#[derive(Serialize, TS)]
struct OpenedRegistration {
    head: DocumentHead,
    facets: Vec<EncryptedObject>,
}

fn registration_key(scope: &str, id: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key(COLLECTION, &format!("{scope}:{id}"))
}

fn case_object(scope: &str, facet: Facet) -> String {
    format!("{scope}:{}:case", facet.name())
}

pub(super) async fn capture(transaction: &mut Transaction, head: &DocumentHead) -> RpcResult<()> {
    let registration_key = registration_key(&head.scope, &head.id);
    if transaction
        .read::<Registration>(registration_key.clone())
        .await?
        .is_some()
    {
        return Err(conflict());
    }
    let records = REGISTRATION_FACETS
        .iter()
        .map(|facet| {
            let domain = format!("{}:{}", head.scope, facet.name());
            record_key(&domain, &case_object(&head.scope, *facet))
        })
        .collect();
    let packets: Vec<Option<ObjectRecord>> = transaction.many(records).await?;
    let mut facets = Vec::new();
    for (facet, packet) in REGISTRATION_FACETS.into_iter().zip(packets) {
        let Some(packet) = packet else {
            if facet == Facet::MasterData {
                return Err(invalid());
            }
            continue;
        };
        if packet.deleted
            || packet.tombstone
            || packet.object != case_object(&head.scope, facet)
            || packet.domain != format!("{}:{}", head.scope, facet.name())
        {
            return Err(invalid());
        }
        facets.push(RegisteredFacet {
            facet,
            revision: packet.revision,
            reference: packet.reference,
        });
    }
    let registration = Registration {
        head: head.hash()?,
        facets,
    };
    transaction
        .put_protected(registration_key, &registration)
        .await
}

fn validate(head: &DocumentHead, registration: &Registration) -> RpcResult<()> {
    if !head.locked || registration.head != head.hash()? {
        return Err(invalid());
    }
    let mut seen = BTreeSet::new();
    for part in &registration.facets {
        if !REGISTRATION_FACETS.contains(&part.facet) || !seen.insert(part.facet.name()) {
            return Err(invalid());
        }
        revision(&part.revision)?;
        if part.reference.len() != 64
            || !part
                .reference
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(invalid());
        }
    }
    if !seen.contains(Facet::MasterData.name()) {
        return Err(invalid());
    }
    Ok(())
}

pub(super) async fn require_restore_registration(
    transaction: &mut Transaction,
    head: &DocumentHead,
) -> RpcResult<()> {
    let entry = transaction
        .read::<Registration>(registration_key(&head.scope, &head.id))
        .await?
        .ok_or_else(conflict)?;
    validate(head, &entry)
}

async fn open_registration(
    context: &mut MetadataContext,
    head: DocumentHead,
    registration: Registration,
    master_only: bool,
) -> RpcResult<OpenedRegistration> {
    validate(&head, &registration)?;
    let mut facets = Vec::new();
    for part in registration.facets {
        if master_only && part.facet != Facet::MasterData {
            continue;
        }
        if !context.security.allows(
            &context.security.subject,
            &head.scope,
            part.facet,
            Action::Read,
        ) {
            continue;
        }
        let envelope = read(&context.repository, &part.reference).await?;
        if envelope.tenant != head.tenant
            || envelope.scope != head.scope
            || envelope.facet != part.facet
            || envelope.object != case_object(&head.scope, part.facet)
            || envelope.revision != part.revision
            || envelope.is_tombstone()
        {
            return Err(invalid());
        }
        facets.push(envelope);
    }
    Ok(OpenedRegistration { head, facets })
}

pub(super) async fn list(
    service: &crate::auth::AuthService,
    request: &RequestContext,
    input: ListInput,
) -> RpcResult<Page> {
    checked_id(
        input
            .scope
            .strip_prefix("commercial:")
            .ok_or_else(invalid)?,
    )?;
    if input.sequence.is_some() == input.prepared.is_some() {
        return Err(invalid());
    }
    let prefix = format!("{}:", input.scope);
    if let Some(after) = &input.after {
        checked_id(after.strip_prefix(&prefix).ok_or_else(invalid)?)?;
    }
    let domain = format!("{}:master-data", input.scope);
    let master_only = input.prepared.is_some();
    let domains = REGISTRATION_FACETS
        .iter()
        .filter(|facet| !master_only || **facet == Facet::MasterData)
        .map(|facet| format!("{}:{}", input.scope, facet.name()))
        .collect::<Vec<_>>();
    let metadata = MetadataRequest::open(service, request).await?;
    let mut context = metadata.authorize(Some(&domains)).await?;
    if !context.security.allows(
        &context.security.subject,
        &input.scope,
        Facet::MasterData,
        Action::Read,
    ) {
        return Err(forbidden());
    }
    if let Some(prepared) = &input.prepared {
        context = super::super::content::select_for_inspection(
            context,
            &prepared.operation,
            &prepared.approval,
        )
        .await?;
    }
    let number = super::super::content::content_number(&mut context.transaction).await?;
    if let Some(sequence) = &input.sequence {
        revision(sequence)?;
        let area =
            super::super::objects::registry::domain(&mut context.transaction, &domain).await?;
        if &area.content_sequence(number)? != sequence {
            return Err(conflict());
        }
    }
    let mut documents = Vec::new();
    let mut after = None;
    if number > 0 {
        // A page can contain large case facets. Only return one registration
        // at a time and let independent bounded requests share the transport.
        let page = context
            .transaction
            .scan_prefix::<Registration>(COLLECTION, &prefix, input.after, 1)
            .await?;
        after = page.after;
        for row in page.records {
            let id = row.record.key.strip_prefix(&prefix).ok_or_else(invalid)?;
            let head: DocumentHead = context
                .transaction
                .read(key("documents", id))
                .await?
                .ok_or_else(invalid)?;
            if head.scope != input.scope || head.id != id || head.tenant != context.auth.tenant {
                return Err(invalid());
            }
            if first_publication_missing(&mut context.transaction, &head).await? {
                documents.push(
                    open_registration(
                        &mut context,
                        head,
                        row.value.ok_or_else(invalid)?,
                        master_only,
                    )
                    .await?,
                );
            }
        }
    }
    context.transaction.validate().await?;
    Ok(Page { documents, after })
}
