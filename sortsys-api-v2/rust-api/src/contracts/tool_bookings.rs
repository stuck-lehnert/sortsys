//! Browser-side tool booking commands. No business plaintext handler is registered.
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.mutation_stub::<ToolBookingInput, ToolBookingResult>("tools.trackMany")
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolBookingInput {
    pub operation_id: Id,
    pub tools: Vec<ToolBookingSelection>,
    pub data: ToolBookingData,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolBookingSelection {
    pub id: Id,
    pub expected_tracking_id: Option<Id>,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolBookingData {
    #[ts(optional = nullable)]
    pub project_id: Option<Id>,
    #[ts(optional = nullable)]
    pub responsible_user_id: Option<Id>,
    #[ts(optional, type = "Date | null")]
    pub deadline_at: Option<DateTime<Utc>>,
    #[ts(optional = nullable)]
    pub comment: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolBookingResult {
    pub trackings: Vec<ToolBookingReference>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolBookingReference {
    pub tool_id: Id,
    pub tracking_id: Id,
}
