//! Browser-side tool booking commands. No business plaintext handler is registered.
use crate::{ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<ToolBookingInput, ToolBookingResult>("tools.trackMany")
        .mutation_stub::<ToolReturnInput, crate::api::Success>("tools.trackings.return")
        .query_stub::<ToolTrackingListInput, Vec<ToolTracking>>("tools.trackings.list")
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolTrackingListInput {
    #[ts(optional = nullable)]
    pub finished: Option<bool>,
    #[ts(optional = nullable)]
    pub tool_id: Option<Id>,
    #[ts(optional = nullable)]
    pub project_id: Option<Id>,
    #[ts(optional = nullable)]
    pub responsible_user_id: Option<Id>,
    #[ts(optional = nullable)]
    pub started_by_user_id: Option<Id>,
    #[ts(optional = nullable)]
    pub ended_by_user_id: Option<Id>,
    #[ts(optional, type = "unknown")]
    pub started_before: Option<serde_json::Value>,
    #[ts(optional, type = "unknown")]
    pub started_after: Option<serde_json::Value>,
    #[ts(optional, type = "unknown")]
    pub ended_before: Option<serde_json::Value>,
    #[ts(optional, type = "unknown")]
    pub ended_after: Option<serde_json::Value>,
    #[ts(optional)]
    pub limit: Option<usize>,
    #[ts(optional)]
    pub offset: Option<usize>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolBookingTool {
    pub id: Id,
    pub custom_id: i32,
    pub brand: String,
    pub category: String,
    pub label: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolTracking {
    pub id: Id,
    pub tool_id: Id,
    pub project_id: Option<Id>,
    pub responsible_user_id: Option<Id>,
    pub started_by_user_id: Option<Id>,
    pub ended_by_user_id: Option<Id>,
    pub tool_usage_cost_per_day: Option<f64>,
    pub comment: Option<String>,
    #[ts(type = "Date")]
    pub started_at: DateTime<Utc>,
    #[ts(type = "Date | null")]
    pub ended_at: Option<DateTime<Utc>>,
    #[ts(type = "Date | null")]
    pub deadline_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool_summary: Option<ToolBookingTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub can_return_own: Option<bool>,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolReturnInput {
    pub tracking_id: Id,
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
