//! Opaque authentication, public authorization proofs and ciphertext persistence.
//! Operator-held credentials must never be used as tenant decryption keys.

mod absences;
mod access;
mod bootstrap;
mod creation;
mod crypto;
mod delivery;
mod document_messages;
mod documents;
mod domain_proofs;
pub mod events;
mod file_chunks;
mod history;
mod immutable;
mod initialization;
mod invitations;
mod live_checkpoints;
mod members;
mod objects;
mod opaque;
mod ots;
mod recovery;
mod setup;
mod staged;
mod stock;
mod timestamps;
mod wire;

use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::rpc::ProcedureRegistryBuilder;

/// Only handlers that use the independent encrypted persistence boundary.
/// Unsupported old business procedures are never registered in this runtime.
pub(crate) fn register_native(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    let builder = setup::register_root_queries(builder, Arc::clone(&service));
    let builder = initialization::register(builder, Arc::clone(&service));
    let builder = bootstrap::register(builder, Arc::clone(&service));
    let builder = objects::register_metadata(builder, Arc::clone(&service));
    let builder = staged::register_metadata(builder, Arc::clone(&service));
    let builder = recovery::register_metadata(builder, Arc::clone(&service));
    let builder = members::register_metadata(builder, Arc::clone(&service));
    let builder = invitations::register_metadata(builder, Arc::clone(&service));
    let builder = documents::register_metadata(builder, Arc::clone(&service));
    let builder = document_messages::persistence::register(builder, Arc::clone(&service));
    let builder = live_checkpoints::persistence::register(builder, Arc::clone(&service));
    let builder = domain_proofs::register_metadata(builder, Arc::clone(&service));
    let builder = stock::register_metadata(builder, Arc::clone(&service));
    let builder = file_chunks::register(builder, Arc::clone(&service));
    let builder = delivery::register_metadata(builder, Arc::clone(&service));
    let builder = history::register_metadata(builder, Arc::clone(&service));
    let builder = timestamps::register_metadata(builder, Arc::clone(&service));
    let builder = objects::register_creation(builder, Arc::clone(&service));
    let builder = events::register_metadata(builder, Arc::clone(&service));
    opaque::register_account_auth(builder, service)
}

pub(crate) async fn live_identity(
    service: &crate::auth::AuthService,
    auth: &crate::auth::AuthResult,
) -> crate::error::RpcResult<(String, String)> {
    crate::control::read_snapshot(|| async {
        let mut transaction = service.records()?.tenant(&auth.tenant)?.transaction()?;
        let identity = live_session(&mut transaction, auth, false).await?;
        transaction.validate().await?;
        Ok(identity)
    })
    .await
}

pub(crate) async fn live_session(
    transaction: &mut crate::control::Transaction,
    auth: &crate::auth::AuthResult,
    catalogue: bool,
) -> crate::error::RpcResult<(String, String)> {
    let access = live_access(transaction, auth).await?;
    if !access.assistant || catalogue && !access.catalogue {
        return Err(crate::error::forbidden());
    }
    Ok((access.subject, access.generation))
}

pub(crate) struct LiveAccess {
    pub subject: String,
    pub generation: String,
    pub assistant: bool,
    pub catalogue: bool,
}

pub(crate) async fn live_access(
    transaction: &mut crate::control::Transaction,
    auth: &crate::auth::AuthResult,
) -> crate::error::RpcResult<LiveAccess> {
    let identity = access::metadata_security_for_domains(transaction, auth, Some(&[])).await?;
    let generation = identity.root.generation.to_string();
    let scope = format!("assistant:{}", identity.subject);
    let mut assistant = [
        wire::Action::Read,
        wire::Action::Create,
        wire::Action::Update,
    ]
    .into_iter()
    .all(|action| identity.allows(&identity.subject, &scope, wire::Facet::MasterData, action));
    assistant &= initialization::completed(transaction, &generation)
        .await?
        .is_some();
    if assistant {
        let domain = format!("{scope}:master-data");
        let saved: Option<objects::registry::DomainRecord> = transaction
            .read(crate::control::key("domains", &domain))
            .await?;
        if let Some(area) = saved {
            if area.id != domain || area.scope != scope || area.facet != wire::Facet::MasterData {
                return Err(crypto::invalid());
            }
            let mut rotations = objects::registry::RotationChecks::new(&identity);
            assistant = objects::registry::has_key(
                transaction,
                &domain,
                &area.generation,
                &identity.subject,
            )
            .await?
                && !rotations.required(transaction, &identity, &area).await?;
        } else {
            assistant = false;
        }
    }
    let catalogue = identity.allows(
        &identity.subject,
        "catalog:products",
        wire::Facet::MasterData,
        wire::Action::Read,
    );
    Ok(LiveAccess {
        subject: identity.subject,
        generation,
        assistant,
        catalogue,
    })
}

pub(crate) async fn verify_live_identity(
    service: &crate::auth::AuthService,
    auth: &crate::auth::AuthResult,
    generation: &str,
    ticket: &str,
    proof: &str,
) -> crate::error::RpcResult<()> {
    let mut transaction = service.records()?.tenant(&auth.tenant)?.transaction()?;
    let identity = access::metadata_security_for_domains(&mut transaction, auth, Some(&[])).await?;
    if identity.root.generation.to_string() != generation {
        return Err(crate::error::forbidden());
    }
    crypto::verify(
        &identity.signing_key,
        proof,
        &crypto::frame(
            "sortsys/llm-live-browser/v1",
            &[
                &auth.tenant,
                &identity.subject,
                generation,
                &crypto::encode(&Sha256::digest(ticket.as_bytes())),
            ],
        ),
    )?;
    transaction.validate().await
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    let builder = bootstrap::register_contract(builder);
    let builder =
        builder.query_stub::<(), crate::editors::EditorConfig>("zerotrust.editors.config");
    let builder = documents::register_contract(builder);
    let builder = domain_proofs::register_contract(builder);
    let builder = document_messages::register_contract(builder);
    let builder = live_checkpoints::register_contract(builder);
    let builder = stock::register_contract(builder);
    let builder = delivery::register_contract(builder);
    let builder = staged::register_contract(builder);
    let builder = members::register_contract(builder);
    let builder = history::register_contract(timestamps::register_contract(builder));
    recovery::register_contract(events::register_contract(invitations::register_contract(
        objects::register_contract(setup::register_contract(creation::register_contract(
            file_chunks::register_contract(opaque::register_contract(builder)),
        ))),
    )))
}
