//! Technical relationships attested by the author of an encrypted packet.
//! A proof describes a revision, not the completeness of the tenant's index.

mod coverage;
mod reconciliation;
mod removal;
mod retirement;
pub(super) use coverage::verify_restored_locations;
pub(super) use retirement::{
    check_document_publication, check_restored_documents, check_scope_publication,
    document_is_active, enabled as retirement_enabled, fence_key as retirement_fence_key,
    hidden_objects,
};

use serde::{Deserialize, Serialize};
use sortsys_zerotrust::metadata::RecordKey;
use ts_rs::TS;

use crate::{
    api::Success, auth::AuthService, control, error::RpcResult, ids::Id,
    rpc::ProcedureRegistryBuilder,
};

use super::{
    access::Security,
    crypto::{frame, invalid, verify},
    objects::{SaveInput, conflict},
};

const REVIEW_RELATIONSHIPS: &str = "zerotrust.commercial.reviewRelationships";
const REMOVE_OFFER: &str = "zerotrust.commercial.removeOffer";

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<reconciliation::ReconcileRelationships, Success>(REVIEW_RELATIONSHIPS)
        .mutation_stub::<removal::RemoveOffer, Success>(REMOVE_OFFER)
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    service: std::sync::Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let review = service.clone();
    builder
        .mutation(REVIEW_RELATIONSHIPS, move |context, input| {
            let service = review.clone();
            async move { reconciliation::reconcile(&service, &context, input).await }
        })
        .mutation(REMOVE_OFFER, move |context, input| {
            let service = service.clone();
            async move { removal::remove_offer(&service, &context, input).await }
        })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentLink {
    id: String,
    source: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CaseLinks {
    standalone_offer: bool,
    parent_case: Option<String>,
    documents: Vec<DocumentLink>,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FinancialLink {
    financial_case: Option<String>,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProjectRegisterLinks {
    project_cases: Vec<String>,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub(super) enum CommercialLinks {
    Case(CaseLinks),
    Financial(FinancialLink),
    ProjectRegister(ProjectRegisterLinks),
}

impl CommercialLinks {
    fn case_ids(&self) -> &[String] {
        match self {
            Self::Case(links) => links.parent_case.as_slice(),
            Self::Financial(links) => links.financial_case.as_slice(),
            Self::ProjectRegister(links) => &links.project_cases,
        }
    }

    fn statement(&self, address: &LinkAddress<'_>, hash: &str) -> RpcResult<(&str, Vec<u8>)> {
        match (address, self) {
            (LinkAddress::Case(id), Self::Case(link)) => {
                Ok((&link.signature, link.frame(id, hash)?))
            }
            (LinkAddress::Financial { project, entry, .. }, Self::Financial(link)) => {
                Ok((&link.signature, link.frame(project, entry, hash)?))
            }
            (LinkAddress::ProjectRegister { project, .. }, Self::ProjectRegister(link)) => {
                Ok((&link.signature, link.frame(project, hash)?))
            }
            _ => Err(invalid()),
        }
    }
}

#[derive(Deserialize, Serialize)]
struct Attestation {
    packet_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reference: Option<String>,
    links: CommercialLinks,
}

impl Attestation {
    fn applies_to(&self, reference: &str) -> bool {
        self.reference
            .as_deref()
            .is_none_or(|saved| saved == reference)
    }

    fn acknowledges(
        &self,
        address: &LinkAddress<'_>,
        reference: &str,
        statement: &[u8],
    ) -> RpcResult<bool> {
        let (_, saved_statement) = self.links.statement(address, &self.packet_hash)?;

        Ok(saved_statement == statement && self.applies_to(reference))
    }
}

fn address(value: &str) -> RpcResult<()> {
    let id = Id::decode(value).map_err(|_| invalid())?;
    if id.0 <= 0 || id.encode() != value {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum LinkAddress<'a> {
    Case(&'a str),
    Financial {
        project: &'a str,
        entry: &'a str,
        object: &'a str,
    },
    ProjectRegister {
        project: &'a str,
        object: &'a str,
    },
}

impl<'a> LinkAddress<'a> {
    // The same address rules apply to incoming packets and persisted object
    // locations. Classifying a location must not require an existing proof.
    fn at(domain: &'a str, object: &'a str) -> Option<Self> {
        let (scope, facet) = domain.rsplit_once(':')?;
        if facet == "master-data"
            && object.strip_prefix(domain) == Some(":case")
            && let Some(id) = scope.strip_prefix("commercial:")
        {
            return Some(Self::Case(id));
        }

        let project = scope.strip_prefix("project:")?;
        if matches!(facet, "offer-prices" | "procurement")
            && object.strip_prefix(domain) == Some(":workflow:register")
        {
            return Some(Self::ProjectRegister { project, object });
        }

        let mutable = object
            .strip_prefix("financial:")
            .and_then(|address| address.strip_prefix(project));
        let entry = match facet {
            "offer-prices" => mutable.and_then(|suffix| suffix.strip_prefix(":offer:")),
            "billing" => mutable
                .and_then(|suffix| suffix.strip_prefix(":invoice:"))
                .or_else(|| {
                    object
                        .strip_prefix("immutable:")?
                        .strip_prefix(domain)?
                        .strip_prefix(":financial-invoice:")
                }),
            _ => None,
        }?;

        Some(Self::Financial {
            project,
            entry,
            object,
        })
    }

    fn publication(input: &'a SaveInput) -> Option<Self> {
        let envelope = &input.envelope;
        let (scope, facet) = input.domain.rsplit_once(':')?;
        if scope != envelope.scope || facet != envelope.facet.name() {
            return None;
        }

        Self::at(&input.domain, &envelope.object)
    }

    fn record(&self) -> RecordKey {
        let id = match self {
            Self::Case(id) => id,
            Self::Financial { object, .. } | Self::ProjectRegister { object, .. } => object,
        };
        control::key("commercial-case-links", id)
    }
}

pub(super) fn publication_records(input: &SaveInput) -> impl Iterator<Item = RecordKey> {
    LinkAddress::publication(input)
        .into_iter()
        .flat_map(|address| [address.record(), retirement::fence_key()])
}

fn case_address(id: &str) -> (String, String) {
    let domain = format!("commercial:{id}:master-data");
    let object = format!("{domain}:case");
    (domain, object)
}

impl CaseLinks {
    fn frame(&self, id: &str, hash: &str) -> RpcResult<Vec<u8>> {
        address(id)?;
        if let Some(parent) = &self.parent_case {
            address(parent)?;
            if parent == id {
                return Err(invalid());
            }
        }

        // The encrypted case model accepts at most 10,000 rows in one facet.
        if self.documents.len() >= 10_000 {
            return Err(invalid());
        }

        let mut fields = vec![
            hash,
            if self.standalone_offer { "1" } else { "0" },
            self.parent_case.as_deref().unwrap_or_default(),
        ];
        let mut previous = "";
        for document in &self.documents {
            address(&document.id)?;
            if document.id.as_str() <= previous {
                return Err(invalid());
            }
            if let Some(source) = &document.source {
                address(source)?;
                if source == &document.id {
                    return Err(invalid());
                }
            }

            fields.extend([&document.id, document.source.as_deref().unwrap_or_default()]);
            previous = &document.id;
        }

        Ok(frame("sortsys/commercial-case-links/v1", &fields))
    }
}

impl FinancialLink {
    fn frame(&self, project: &str, entry: &str, hash: &str) -> RpcResult<Vec<u8>> {
        address(project)?;
        address(entry)?;
        if let Some(case) = &self.financial_case {
            address(case)?;
        }

        Ok(frame(
            "sortsys/financial-case-link/v1",
            &[hash, self.financial_case.as_deref().unwrap_or_default()],
        ))
    }
}

impl ProjectRegisterLinks {
    fn frame(&self, project: &str, hash: &str) -> RpcResult<Vec<u8>> {
        address(project)?;

        // A register can hold 10,000 awards with up to two case IDs each.
        if self.project_cases.len() > 20_000 {
            return Err(invalid());
        }

        let mut previous = "";
        for case in &self.project_cases {
            address(case)?;
            if case.as_str() <= previous {
                return Err(invalid());
            }
            previous = case;
        }

        let mut fields = vec![hash];
        fields.extend(self.project_cases.iter().map(String::as_str));
        Ok(frame("sortsys/project-register-case-links/v1", &fields))
    }
}

pub(super) async fn save(
    transaction: &mut control::Transaction,
    guard: &Security,
    input: &SaveInput,
    reference: String,
    written: bool,
) -> RpcResult<()> {
    let Some(address) = LinkAddress::publication(input) else {
        return if input.commercial_links.is_some() {
            Err(invalid())
        } else {
            Ok(())
        };
    };
    let record = address.record();

    let Some(links) = &input.commercial_links else {
        // Older clients can still publish. A write without an attestation
        // invalidates the previous proof, never attests to an empty graph.
        if !written {
            return Ok(());
        }

        retirement::check_publication(transaction, None).await?;
        if transaction
            .read::<Attestation>(record.clone())
            .await?
            .is_some()
        {
            transaction.delete(record).await?;
        }
        return Ok(());
    };

    if input.envelope.is_tombstone() {
        return Err(invalid());
    }

    let hash = input.envelope.packet_hash()?;
    let (signature, statement) = links.statement(&address, &hash)?;
    verify(&guard.signing_key, signature, &statement)?;

    if written {
        retirement::check_publication(transaction, Some(links)).await?;
        transaction
            .put(
                record,
                &Attestation {
                    packet_hash: hash,
                    reference: Some(reference),
                    links: links.clone(),
                },
            )
            .await?;
    } else {
        let saved: Attestation = transaction.read(record).await?.ok_or_else(conflict)?;

        // A replay of a pre-upgrade write may read a proof without the storage
        // reference. It can acknowledge that write but cannot complete coverage.
        // A reviewed proof may use a different signer; the author's signature
        // was just verified above, so compare the signed data, not signatures.
        if !saved.acknowledges(&address, &reference, &statement)? {
            return Err(conflict());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_registers_are_bound_to_the_project_and_facet() {
        for facet in ["offer-prices", "procurement"] {
            let domain = format!("project:3:{facet}");
            let object = format!("{domain}:workflow:register");
            let link = LinkAddress::at(&domain, &object).unwrap();
            assert_eq!(link.record().key, object);
            assert_eq!(
                link,
                LinkAddress::ProjectRegister {
                    project: "3",
                    object: &object,
                }
            );
            assert!(LinkAddress::at(&format!("project:30:{facet}"), &object).is_none());
        }

        let billing = "project:3:billing";
        assert!(LinkAddress::at(billing, "project:3:billing:workflow:register").is_none());
    }

    #[test]
    fn workflow_register_signature_frame_requires_sorted_unique_canonical_case_ids() {
        let link = |cases: &[&str]| ProjectRegisterLinks {
            project_cases: cases.iter().map(|case| (*case).into()).collect(),
            signature: String::new(),
        };

        assert_eq!(
            link(&["2", "7"]).frame("3", "packet-hash").unwrap(),
            frame(
                "sortsys/project-register-case-links/v1",
                &["packet-hash", "2", "7"]
            ),
        );
        for invalid_cases in [["7", "2"], ["2", "2"], ["0", "7"], ["02", "7"]] {
            assert!(link(&invalid_cases).frame("3", "packet-hash").is_err());
        }
    }

    #[test]
    fn relation_addresses_match_the_current_domain_and_object() {
        assert_eq!(
            LinkAddress::at("commercial:7:master-data", "commercial:7:master-data:case"),
            Some(LinkAddress::Case("7")),
        );
        for (domain, object) in [
            ("project:3:offer-prices", "financial:3:offer:4"),
            ("project:3:billing", "financial:3:invoice:4"),
            (
                "project:3:billing",
                "immutable:project:3:billing:financial-invoice:4",
            ),
        ] {
            let address = LinkAddress::at(domain, object).unwrap();
            assert_eq!(address.record().key, object);
            assert_eq!(
                address,
                LinkAddress::Financial {
                    project: "3",
                    entry: "4",
                    object
                }
            );
        }

        for (domain, object) in [
            ("project:3:billing", "financial:30:invoice:4"),
            ("project:3:billing", "financial:3:offer:4"),
            (
                "project:3:billing",
                "immutable:project:30:billing:financial-invoice:4",
            ),
            (
                "project:3:billing",
                "immutable:project:3:billing:invoice-payment:4",
            ),
            ("commercial:7:billing", "commercial:7:billing:case"),
            ("commercial:7:master-data", "commercial:8:master-data:case"),
        ] {
            assert_eq!(LinkAddress::at(domain, object), None, "{domain} / {object}");
        }
    }

    #[test]
    fn a_replay_requires_the_saved_links_and_storage_reference() {
        let old: Attestation = serde_json::from_value(serde_json::json!({
            "packet_hash": "signed-packet",
            "links": { "financialCase": "7", "signature": "author-signature" }
        }))
        .unwrap();

        let address = LinkAddress::at("project:3:billing", "financial:3:invoice:4").unwrap();
        let mut published_links = FinancialLink {
            financial_case: Some("7".into()),
            signature: "author-signature".into(),
        };
        let current_statement = published_links.frame("3", "4", "signed-packet").unwrap();
        assert!(
            old.acknowledges(&address, "stored-packet", &current_statement)
                .unwrap()
        );

        let reviewed = Attestation {
            packet_hash: old.packet_hash.clone(),
            reference: Some("stored-packet".into()),
            links: CommercialLinks::Financial(FinancialLink {
                financial_case: Some("7".into()),
                signature: "authority-signature".into(),
            }),
        };
        assert!(
            reviewed
                .acknowledges(&address, "stored-packet", &current_statement)
                .unwrap()
        );
        assert!(
            !reviewed
                .acknowledges(&address, "other-record", &current_statement)
                .unwrap()
        );

        let other_packet = published_links.frame("3", "4", "other-packet").unwrap();
        published_links.financial_case = None;
        let other_relation = published_links.frame("3", "4", "signed-packet").unwrap();
        assert!(
            !reviewed
                .acknowledges(&address, "stored-packet", &other_packet)
                .unwrap()
        );
        assert!(
            !reviewed
                .acknowledges(&address, "stored-packet", &other_relation)
                .unwrap()
        );
    }

    #[test]
    fn financial_frame_attests_the_case_not_the_entry_id() {
        let mut link = FinancialLink {
            financial_case: Some("7".into()),
            signature: String::new(),
        };
        assert_eq!(
            link.frame("3", "4", "packet").unwrap(),
            frame("sortsys/financial-case-link/v1", &["packet", "7"]),
        );

        link.financial_case = None;
        assert_eq!(
            link.frame("3", "4", "packet").unwrap(),
            frame("sortsys/financial-case-link/v1", &["packet", ""]),
        );

        link.financial_case = Some("07".into());
        assert!(link.frame("3", "4", "packet").is_err());
    }

    #[test]
    fn frame_binds_exact_packet_and_canonical_document_links() {
        let mut links = CaseLinks {
            standalone_offer: true,
            parent_case: None,
            documents: vec![
                DocumentLink {
                    id: "4".into(),
                    source: None,
                },
                DocumentLink {
                    id: "5".into(),
                    source: Some("4".into()),
                },
            ],
            signature: String::new(),
        };
        assert_eq!(
            links.frame("3", "packet").unwrap(),
            frame(
                "sortsys/commercial-case-links/v1",
                &["packet", "1", "", "4", "", "5", "4"]
            ),
        );
        assert_ne!(
            links.frame("3", "packet").unwrap(),
            links.frame("3", "other").unwrap()
        );
        links.documents.swap(0, 1);
        assert!(links.frame("3", "packet").is_err());
        links.documents.swap(0, 1);
        links.documents[1].source = Some("05".into());
        assert!(links.frame("3", "packet").is_err());
    }
}
