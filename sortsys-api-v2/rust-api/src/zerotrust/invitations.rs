//! Invitation confirmation secrets are verified by the inviting browser only.
//! This service stores public proofs and arbitrates one-time approval.
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{
    crypto::{encode, frame, identifier, invalid, revision, sized, verify},
    objects::TrustHistory,
    wire::IdentityCertificate,
};
use crate::{
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    error::{forbidden, internal, not_found},
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Invitation {
    pub(super) tenant: String,
    pub(super) id: String,
    pub(super) generation: String,
    pub(super) user: String,
    pub(super) username: String,
    pub(super) valid_until: String,
    pub(super) verifier: String,
    pub(super) signature: String,
}
impl Invitation {
    pub(super) fn frame(&self) -> RpcResult<Vec<u8>> {
        for value in [&self.tenant, &self.id, &self.user, &self.username] {
            identifier(value)?;
        }
        subject(&self.user)?;
        revision(&self.generation)?;
        revision(&self.valid_until)?;
        sized::<32>(&self.verifier)?;
        Ok(frame(
            "sortsys/invitation/v1",
            &[
                &self.tenant,
                &self.id,
                &self.generation,
                &self.user,
                &self.username,
                &self.valid_until,
                &self.verifier,
            ],
        ))
    }
}
#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Claim {
    pub(super) invitation: String,
    pub(super) generation: String,
    pub(super) user: String,
    pub(super) revision: String,
    pub(super) encryption_key: String,
    pub(super) signing_key: String,
    pub(super) proof: String,
    pub(super) confirmation: String,
}
impl Claim {
    pub(super) fn frame(&self, invitation: &Invitation) -> RpcResult<Vec<u8>> {
        if self.invitation != invitation.id
            || self.generation != invitation.generation
            || self.user != invitation.user
        {
            return Err(invalid());
        }
        revision(&self.revision)?;
        sized::<32>(&self.encryption_key)?;
        sized::<32>(&self.signing_key)?;
        sized::<32>(&self.confirmation)?;
        Ok(frame(
            "sortsys/invitation-claim/v1",
            &[
                &invitation.tenant,
                &invitation.id,
                &invitation.generation,
                &invitation.user,
                &invitation.signature,
                &self.revision,
                &self.encryption_key,
                &self.signing_key,
            ],
        ))
    }
    pub(super) fn hash(&self, invitation: &Invitation) -> RpcResult<String> {
        sized::<64>(&self.proof)?;
        Ok(encode(&Sha256::digest(frame(
            "sortsys/invitation-claim-hash/v1",
            &[
                &encode(&self.frame(invitation)?),
                &self.proof,
                &self.confirmation,
            ],
        ))))
    }
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct InvitationId {
    id: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Approval {
    id: String,
    claim_hash: String,
    certificate: IdentityCertificate,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct Revoke {
    id: String,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completion {
    id: String,
    claim_hash: String,
    proof: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Entry {
    invitation: Invitation,
    claim: Option<Claim>,
    accepted: bool,
    completed: bool,
    revoked: bool,
}
#[derive(Serialize, TS)]
struct Opened {
    entry: Entry,
    history: TrustHistory,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Member {
    id: Id,
    username: String,
    enrolled: bool,
    roles: Vec<String>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct MemberPage {
    after: Option<Id>,
}
#[derive(Serialize, TS)]
struct Members {
    rows: Vec<Member>,
    after: Option<Id>,
}

fn subject(value: &str) -> RpcResult<Id> {
    Id::decode(value.strip_prefix("user:").ok_or_else(invalid)?).map_err(|_| invalid())
}
fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Invitation changed").with_http_code(409)
}
mod persistence;
pub(crate) use persistence::register as register_metadata;
pub(super) use persistence::{
    registration_target as metadata_registration, repository as metadata_repository,
    store_claim as metadata_store_claim,
};

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<PublicInvitationId, PublicInvitation>("auth.opaque.invitation")
        .query_stub::<MemberPage, Members>("zerotrust.members.list")
        .mutation_stub::<Invitation, Success>("zerotrust.invitations.create")
        .query_stub::<(), Vec<Entry>>("zerotrust.invitations.list")
        .query_stub::<InvitationId, Opened>("zerotrust.invitations.get")
        .mutation_stub::<Claim, Success>("zerotrust.invitations.join")
        .mutation_stub::<Approval, Success>("zerotrust.invitations.approve")
        .mutation_stub::<Completion, Success>("zerotrust.invitations.complete")
        .mutation_stub::<Revoke, Success>("zerotrust.invitations.revoke")
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct PublicInvitationId {
    tenant: String,
    id: String,
}
#[derive(Serialize, TS)]
struct PublicInvitation {
    invitation: Invitation,
    history: TrustHistory,
    enrolled: bool,
}
