//! Uploads remain invisible until one ordinary authorization/CAS transaction
//! publishes the complete batch. No business plaintext enters this service.
use super::{
    crypto::{identifier, invalid},
    objects::{BatchInput, BatchResult, DomainHead, SaveInput},
    wire::Action,
};
use crate::{
    error::RpcResult,
    error::{forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

mod persistence;
pub(super) fn register_metadata(
    builder: ProcedureRegistryBuilder,
    service: Arc<crate::auth::AuthService>,
) -> ProcedureRegistryBuilder {
    persistence::register(builder, service)
}

#[derive(Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
struct StageInput {
    objects: Vec<SaveInput>,
}
#[derive(Serialize, TS)]
struct StageResult {
    id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StagedObjects {
    format: String,
    tenant: String,
    subject: String,
    objects: Vec<SaveInput>,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CommitInput {
    parts: Vec<String>,
    heads: Vec<DomainHead>,
    #[ts(optional)]
    #[serde(rename = "liveCheckpoints")]
    live_checkpoints: Option<Vec<super::live_checkpoints::LiveCheckpoint>>,
    #[ts(optional)]
    member: Option<super::members::MemberChange>,
    #[ts(optional)]
    policy: Option<super::wire::SignedPolicy>,
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<StageInput, StageResult>("zerotrust.objects.stage")
        .mutation_stub::<CommitInput, BatchResult>("zerotrust.objects.commit")
}
