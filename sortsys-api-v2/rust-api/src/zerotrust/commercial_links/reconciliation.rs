//! Bind legacy relationship proofs without publishing a new object revision.

use std::collections::BTreeSet;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{Attestation, CommercialLinks, LinkAddress, conflict, retirement};
use crate::{
    api::Success,
    auth::AuthService,
    control::{Transaction, key},
    error::{RpcResult, forbidden},
    rpc::RequestContext,
    zerotrust::{
        access::{MetadataContext, MetadataRequest},
        content::{PreparedView, select_read_view},
        crypto::{encode, frame, invalid, verify},
        objects::{metadata_object, registry},
        wire::Action,
    },
};

pub(super) async fn reviewed_attestation(
    transaction: &mut Transaction,
    domain: &str,
    object: &str,
    reference: &str,
) -> RpcResult<Option<Attestation>> {
    let proof = transaction
        .read::<Attestation>(reviewed_key(domain, object, reference))
        .await?;
    if proof
        .as_ref()
        .is_some_and(|saved| saved.reference.as_deref() != Some(reference))
    {
        return Err(conflict());
    }

    Ok(proof)
}

// An exact-address review can be reused only for the same ciphertext. Its
// storage is independent of the selected content epoch and its seal.
pub(super) fn reviewed_key(
    domain: &str,
    object: &str,
    reference: &str,
) -> sortsys_zerotrust::metadata::RecordKey {
    let identity = frame(
        "sortsys/commercial-reviewed-object/v1",
        &[domain, object, reference],
    );
    key(
        "commercial-reviewed-links",
        &encode(&Sha256::digest(identity)),
    )
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelationshipProof {
    domain: String,
    object: String,
    reference: String,
    links: CommercialLinks,
}

impl RelationshipProof {
    fn frame(&self, tenant: &str, statement: &[u8]) -> Vec<u8> {
        frame(
            "sortsys/commercial-legacy-binding/v1",
            &[
                tenant,
                &self.domain,
                &self.object,
                &self.reference,
                &encode(statement),
            ],
        )
    }
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub(super) struct ReconcileRelationships {
    proofs: Vec<RelationshipProof>,
    #[ts(optional)]
    prepared: Option<PreparedView>,
}

pub(super) async fn reconcile(
    service: &AuthService,
    request: &RequestContext,
    input: ReconcileRelationships,
) -> RpcResult<Success> {
    if input.proofs.is_empty() || input.proofs.len() > 8 {
        return Err(invalid());
    }

    let mut records = BTreeSet::new();
    let mut domains = BTreeSet::new();
    let mut proofs = Vec::with_capacity(input.proofs.len());
    for proof in &input.proofs {
        let address = LinkAddress::at(&proof.domain, &proof.object).ok_or_else(invalid)?;
        if !records.insert(address.record().key) {
            return Err(invalid());
        }

        domains.insert(proof.domain.clone());
        proofs.push((address, proof));
    }

    let domains: Vec<_> = domains.into_iter().collect();
    let sealed_view = input.prepared.is_some();
    let request = MetadataRequest::open(service, request).await?;
    let context = if sealed_view {
        request.authorize_origins(&domains).await?
    } else {
        request.authorize(Some(&domains)).await?
    };
    if !context.auth.is_admin() {
        return Err(forbidden());
    }

    let mut context = select_read_view(context, input.prepared.as_ref()).await?;
    for (address, proof) in proofs {
        stage(&mut context, &address, proof, sealed_view).await?;
    }

    context.transaction.commit().await?;
    Ok(Success { success: true })
}

async fn stage(
    context: &mut MetadataContext,
    address: &LinkAddress<'_>,
    proof: &RelationshipProof,
    sealed_view: bool,
) -> RpcResult<()> {
    let area = registry::domain(&mut context.transaction, &proof.domain).await?;
    let security = &context.security;
    if !security.allows(&security.subject, &area.scope, area.facet, Action::Read) {
        return Err(forbidden());
    }

    let object = metadata_object(&mut context.transaction, &proof.object)
        .await?
        .filter(|record| !record.deleted && !record.tombstone)
        .ok_or_else(conflict)?;
    if object.reference != proof.reference
        || object.domain != proof.domain
        || object.object != proof.object
    {
        return Err(conflict());
    }

    let envelope = object
        .read_envelope(&context.repository, &context.auth.tenant)
        .await?;
    let packet_hash = envelope.packet_hash()?;
    let (signature, statement) = proof.links.statement(address, &packet_hash)?;
    verify(
        &security.authority,
        signature,
        &proof.frame(&context.auth.tenant, &statement),
    )?;

    let record = address.record();
    let saved = context
        .transaction
        .read::<Attestation>(record.clone())
        .await?;
    // A prepared packet can predate the primary proof. Keep that proof for
    // its own packet and record the reviewed packet under its exact reference.
    let applicable = saved
        .as_ref()
        .filter(|proof| proof.applies_to(&object.reference));
    if let Some(proof) = applicable
        && !requires_binding(proof, address, &statement, &object.reference)?
    {
        return Ok(());
    }

    if let Some(saved) = reviewed_attestation(
        &mut context.transaction,
        &proof.domain,
        &proof.object,
        &object.reference,
    )
    .await?
    {
        if !saved.acknowledges(address, &object.reference, &statement)? {
            return Err(conflict());
        }
        return Ok(());
    }

    if !sealed_view && saved.is_some() && applicable.is_none() {
        return Err(conflict());
    }

    retirement::check_publication(&mut context.transaction, Some(&proof.links)).await?;
    let attestation = Attestation {
        packet_hash,
        reference: Some(object.reference),
        links: proof.links.clone(),
    };

    if sealed_view {
        let record = reviewed_key(&proof.domain, &proof.object, &proof.reference);
        return context
            .transaction
            .put_protected(record, &attestation)
            .await;
    }

    context.transaction.put(record, &attestation).await
}

fn requires_binding(
    saved: &Attestation,
    address: &LinkAddress<'_>,
    statement: &[u8],
    reference: &str,
) -> RpcResult<bool> {
    if !saved.acknowledges(address, reference, statement)? {
        return Err(conflict());
    }

    Ok(saved.reference.is_none())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_reviews_are_unversioned_but_bound_to_the_exact_address_and_ciphertext() {
        let review = reviewed_key("area", "object", "ciphertext");

        assert!(!crate::control::content::collection(&review.collection));
        assert_eq!(review, reviewed_key("area", "object", "ciphertext"));
        assert_ne!(review, reviewed_key("other-area", "object", "ciphertext"));
        assert_ne!(review, reviewed_key("area", "other-object", "ciphertext"));
        assert_ne!(review, reviewed_key("area", "object", "other-ciphertext"));
    }
    use crate::zerotrust::commercial_links::FinancialLink;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn reviewed_statement_binds_unmodified_legacy_proof_only_once() {
        let domain = "project:3:billing";
        let object = "immutable:project:3:billing:financial-invoice:4";
        let address = LinkAddress::at(domain, object).unwrap();
        let mut saved = Attestation {
            packet_hash: "original-packet".into(),
            reference: None,
            links: CommercialLinks::Financial(FinancialLink {
                financial_case: Some("7".into()),
                signature: "author-signature".into(),
            }),
        };
        let reference = "23".repeat(32);
        let (_, statement) = saved.links.statement(&address, &saved.packet_hash).unwrap();
        let (_, changed) = saved.links.statement(&address, "different-packet").unwrap();
        let no_links = CommercialLinks::Financial(FinancialLink {
            financial_case: None,
            signature: String::new(),
        });
        let (_, without_case) = no_links.statement(&address, &saved.packet_hash).unwrap();

        assert!(requires_binding(&saved, &address, &statement, &reference).unwrap());
        assert!(requires_binding(&saved, &address, &changed, &reference).is_err());
        assert!(requires_binding(&saved, &address, &without_case, &reference).is_err());
        saved.reference = Some(reference.clone());
        assert!(!requires_binding(&saved, &address, &statement, &reference).unwrap());
        assert!(requires_binding(&saved, &address, &statement, &"32".repeat(32)).is_err());

        let mut proof = RelationshipProof {
            domain: domain.into(),
            object: object.into(),
            reference,
            links: saved.links,
        };
        let authority = SigningKey::from_bytes(&[81; 32]);
        let public = authority.verifying_key().to_bytes();
        let review = proof.frame("legacy-tenant", &statement);
        let signature = encode(&authority.sign(&review).to_bytes());
        verify(&public, &signature, &review).unwrap();
        assert!(verify(&public, &signature, &statement).is_err());

        proof.reference = "32".repeat(32);
        let changed_review = proof.frame("legacy-tenant", &statement);
        assert!(verify(&public, &signature, &changed_review).is_err());
    }
}
