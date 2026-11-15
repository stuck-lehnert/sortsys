//! Wire values for the browser's encrypted diagram editor facade.
#![doc = " diagrams.net runs in embed mode and never owns a sortsys document. The"]
#![doc = " browser receives XML from this API and sends autosaved XML back through the"]
#![doc = " authenticated project-file procedure."]
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<DrawioConfigInput, DrawioConfigOutput>("projects.files.drawioConfig")
        .mutation_stub::<DrawioSaveInput, DrawioSaveOutput>("projects.files.drawioSave")
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrawioConfigInput {
    pub project_id: Id,
    pub file_id: Id,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DrawioConfigOutput {
    pub editor_url: String,
    pub can_edit: bool,
    pub file_name: String,
    pub version: i64,
    pub xml: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrawioSaveInput {
    pub project_id: Id,
    pub file_id: Id,
    pub version: i64,
    pub xml: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DrawioSaveOutput {
    pub version: i64,
    #[ts(type = "Date")]
    pub saved_at: DateTime<Utc>,
}
