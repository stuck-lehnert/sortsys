#![doc = " Opaque native files for pre-project sales and project commercial workflows."]
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<AdoptInput, CreatedDocument>("commercial.cases.adoptContract")
        .query_stub::<DocumentInput, DocumentContent>("commercial.documents.get")
        .mutation_stub::<CreateInput, CreatedDocument>("commercial.documents.create")
        .mutation_stub::<SaveInput, SavedDocument>("commercial.documents.save")
        .mutation_stub::<VersionInput, SavedDocument>("commercial.documents.finalize")
        .query_stub::<DocumentInput, Download>("commercial.documents.download")
}
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: Id,
    pub case_id: Id,
    pub purpose: String,
    pub phase: String,
    pub file_name: String,
    pub version: i64,
    pub read_only: bool,
    pub source_document_id: Option<Id>,
    pub source_version: Option<i64>,
    pub source_current_version: Option<i64>,
    pub partner_name: Option<String>,
    pub net_amount: Option<String>,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentInput {
    pub case_id: Id,
    pub id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionInput {
    pub case_id: Id,
    pub id: Id,
    pub version: i64,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveInput {
    pub case_id: Id,
    pub id: Id,
    pub version: i64,
    pub xml: String,
    #[ts(optional)]
    pub live_sequence: Option<String>,
    #[ts(optional)]
    pub live_positions: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub net_amount: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    pub case_id: Id,
    pub purpose: String,
    pub file_name: String,
    pub xml: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub net_amount: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub partner_name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source_document_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source_version: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub replace_document_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub expected_version: Option<i64>,
}
#[derive(Serialize, TS)]
pub struct CreatedDocument {
    pub id: Id,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub version: i64,
    pub saved_at: DateTime<Utc>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub url: String,
    pub file_name: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentContent {
    pub frozen: bool,
    pub xml: String,
    pub reference_xml: Option<String>,
    pub file_name: String,
    pub version: i64,
    pub can_edit: bool,
    pub live_ticket: String,
    pub live_path: String,
    pub recovery_scope: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptInput {
    pub project_id: Id,
    pub title: String,
    pub source_xml: String,
    #[ts(type = "'84'|'85'|'86'|'87'")]
    pub source_phase: String,
    pub source_file_name: String,
    pub offer_xml: Option<String>,
    pub reference_xml: Option<String>,
    pub net_amount: String,
}
