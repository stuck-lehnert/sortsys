#![doc = " Organization-wide native Typst source and uploaded template assets."]
use crate::{api::Success, ids::Id, rpc::ProcedureRegistryBuilder};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SavedTemplate {
    pub source: Option<String>,
    pub revision: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub source: Option<String>,
    pub revision: String,
    pub assets: Vec<Asset>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: Id,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u32,
    pub download_url: Option<String>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTemplate {
    pub source: String,
    pub expected_revision: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AssetId {
    pub id: Id,
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Template>("settings.documentTemplate.get")
        .mutation_stub::<SetTemplate, SavedTemplate>("settings.documentTemplate.set")
        .mutation_stub::<AssetId, Success>("settings.documentTemplate.assets.delete")
}
