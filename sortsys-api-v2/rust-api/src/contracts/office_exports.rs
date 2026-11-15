#![doc = " Temporary, read-only documents created by browser-side export actions."]
use crate::rpc::ProcedureRegistryBuilder;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<CreateExportUploadInput, CreateExportUploadOutput>(
            "office.exports.createUpload",
        )
        .query_stub::<ExportConfigInput, ExportConfigOutput>("office.exports.officeConfig")
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateExportUploadInput {
    pub file_name: String,
    pub mime_type: String,
    #[ts(type = "number")]
    pub size_bytes: i64,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateExportUploadOutput {
    pub upload_url: String,
    pub upload_method: &'static str,
    pub upload_headers: BTreeMap<String, String>,
    pub expires_at: DateTime<Utc>,
    pub session_token: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportConfigInput {
    pub session_token: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportConfigOutput {
    pub api_url: String,
    pub can_edit: bool,
    #[ts(type = "Record<string, unknown>")]
    pub config: Value,
}
