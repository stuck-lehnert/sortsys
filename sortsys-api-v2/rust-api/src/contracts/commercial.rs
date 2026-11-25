#![doc = " Contractor sales, changes, subcontract packages and measured-work workflows."]
use crate::{api::Success, ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<ListInput, Vec<CommercialCase>>("commercial.cases.list")
        .query_stub::<ListInput, Vec<CaseOverviewRow>>("commercial.cases.overview")
        .query_stub::<HeaderListInput, Vec<CaseHeader>>("commercial.cases.headers")
        .query_stub::<CaseInput, CaseDetail>("commercial.cases.get")
        .mutation_stub::<CreateInput, CreatedId>("commercial.cases.create")
        .mutation_stub::<UpdateInput, Success>("commercial.cases.update")
        .mutation_stub::<TransitionInput, Success>("commercial.cases.transition")
        .mutation_stub::<CaseInput, CreatedId>("commercial.cases.createProject")
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaseHeader {
    pub id: Id,
    pub reference: String,
    pub title: String,
    pub project_id: Option<Id>,
    #[ts(
        type = "'offer'|'variation'|'alternative'|'subcontract'|'measurement'|'procurement'|'calculation'|'invoice'|'progress_invoice'|'final_invoice'"
    )]
    pub kind: String,
    #[ts(
        type = "'draft'|'sent'|'accepted'|'rejected'|'cancelled'|'requested'|'awarded'|'confirmed'|'submitted'|'approved'|'partially_paid'|'paid'"
    )]
    pub status: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaseOverviewRow {
    #[serde(flatten)]
    pub header: CaseHeader,
    pub customer_name: Option<String>,
    pub counterparty_name: Option<String>,
    pub currency: String,
    pub net_amount: Option<String>,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeaderListInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub project_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommercialCase {
    pub id: Id,
    pub reference: String,
    #[ts(
        type = "'offer'|'variation'|'alternative'|'subcontract'|'measurement'|'procurement'|'calculation'|'invoice'|'progress_invoice'|'final_invoice'"
    )]
    pub kind: String,
    #[ts(
        type = "'draft'|'sent'|'accepted'|'rejected'|'cancelled'|'requested'|'awarded'|'confirmed'|'submitted'|'approved'|'partially_paid'|'paid'"
    )]
    pub status: String,
    pub title: String,
    pub existing_contract: bool,
    pub project_id: Option<Id>,
    pub project_title: Option<String>,
    pub parent_case_id: Option<Id>,
    pub customer_id: Option<Id>,
    pub customer_name: Option<String>,
    pub counterparty_name: Option<String>,
    pub currency: String,
    pub net_amount: Option<String>,
    pub valid_until: Option<NaiveDate>,
    pub notes: Option<String>,
    pub scope_item_ids: serde_json::Value,
    pub selected_offer_document_id: Option<Id>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaseDetail {
    pub case: CommercialCase,
    pub documents: Vec<super::commercial_documents::Document>,
    pub events: Vec<CaseEvent>,
    pub can_manage: bool,
    pub can_retire: bool,
    pub invoice: Option<super::commercial_billing::InvoiceDetails>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaseEvent {
    pub id: Id,
    pub action: String,
    pub previous_status: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub actor: String,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<Id>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaseInput {
    pub id: Id,
}
#[derive(Serialize, TS)]
pub struct CreatedId {
    pub id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub project_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub kind: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub status: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub search: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: Option<i64>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub project_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub parent_case_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub customer_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub counterparty_name: Option<String>,
    #[serde(default)]
    pub scope_item_ids: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub billing_basis: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub vat_rate: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateInput {
    pub id: Id,
    pub title: String,
    pub customer_id: Option<Id>,
    pub counterparty_name: Option<String>,
    pub valid_until: Option<NaiveDate>,
    pub notes: Option<String>,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionInput {
    pub id: Id,
    pub expected_status: String,
    pub status: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub selected_offer_document_id: Option<Id>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub awarded_item_ids: Option<Vec<String>>,
}
