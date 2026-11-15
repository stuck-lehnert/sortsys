#![doc = " Automatically maintained search metadata. Editing and GAEB validation stay in the browser."]
use crate::rpc::ProcedureRegistryBuilder;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<SearchInput, SearchOutput>("gaeb.positions.search")
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
    pub query: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutput {
    pub items: Vec<Position>,
    pub indexing: bool,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    pub short_text: String,
    pub description: String,
    pub unit: String,
    pub source_file: String,
}
