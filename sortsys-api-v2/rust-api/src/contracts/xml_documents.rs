//! Wire values for the browser's XML document facade.
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<XmlDocumentConfigInput, XmlDocumentConfigOutput>("projects.files.xmlContent")
        .mutation_stub::<XmlDocumentSaveInput, XmlDocumentSaveOutput>("projects.files.xmlSave")
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XmlDocumentConfigInput {
    pub project_id: Id,
    pub file_id: Id,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct XmlDocumentConfigOutput {
    pub frozen: bool,
    pub recovery_scope: String,
    pub live_ticket: String,
    pub live_path: String,
    pub can_edit: bool,
    pub file_name: String,
    pub version: i64,
    pub xml: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XmlDocumentSaveInput {
    pub project_id: Id,
    pub file_id: Id,
    pub version: i64,
    pub xml: String,
    #[ts(optional)]
    pub live_sequence: Option<String>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct XmlDocumentSaveOutput {
    pub version: i64,
    #[ts(type = "Date")]
    pub saved_at: DateTime<Utc>,
}
