#![doc = " Recent activity, visit history, and quick-action history."]
use crate::{api::Success, ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<Option<ActivityListInput>, Vec<Activity>>("personalization.activity.list")
        .query_stub::<(), GaebViewPreferences>("personalization.gaebView.get")
        .mutation_stub::<GaebViewPreferences, Success>("personalization.gaebView.set")
}
#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityListInput {
    #[serde(default)]
    #[ts(optional)]
    pub latest_per_resource: Option<bool>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub cursor: Option<Id>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub limit: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub resource_type: Option<ActivityResourceType>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub resource_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub context_id: Option<Id>,
    #[serde(default)]
    #[ts(optional)]
    pub include_project_context: Option<bool>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ActivityResourceType {
    Project,
    Tool,
    User,
    Customer,
    Contact,
    Product,
    ProductVendor,
    DeliveryNote,
    RegieReport,
    DailyProjectReport,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: Id,
    pub entity_table: String,
    pub entity_id: String,
    pub changed_columns: Vec<String>,
    pub actor_user_id: Option<Id>,
    pub actor_kind: String,
    pub actor_name: Option<String>,
    pub is_imported: bool,
    #[ts(type = "ActivityResourceType")]
    pub resource_type: String,
    pub resource_id: Id,
    pub context_id: Option<Id>,
    pub context_title: Option<String>,
    #[ts(type = "Date | null")]
    pub context_date: Option<DateTime<Utc>>,
    pub title: String,
    pub resource_title: Option<String>,
    pub description: Option<String>,
    #[ts(type = "\"created\" | \"updated\" | \"deleted\" | \"completed\" | \"resumed\"")]
    pub action: String,
    #[ts(type = "Date")]
    pub occurred_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date | null")]
    pub modified_at: Option<DateTime<Utc>>,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GaebViewPreferences {
    pub show_fields: bool,
    pub outline_open: bool,
    pub outline_width: u32,
    pub ribbon_collapsed: bool,
    pub zoom: Option<f64>,
}
impl Default for GaebViewPreferences {
    fn default() -> Self {
        Self {
            show_fields: true,
            outline_open: true,
            outline_width: 320,
            ribbon_collapsed: false,
            zoom: None,
        }
    }
}
