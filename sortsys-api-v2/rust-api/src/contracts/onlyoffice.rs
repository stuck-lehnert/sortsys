//! Configuration returned by the browser's client-side office editor facade.
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<EditorConfigInput, EditorConfigOutput>("projects.files.officeConfig")
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorConfigInput {
    pub project_id: Id,
    pub file_id: Id,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfigOutput {
    pub api_url: String,
    pub can_edit: bool,
    #[ts(type = "Record<string, unknown>")]
    pub config: Value,
}
