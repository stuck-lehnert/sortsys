#![doc = " Exact invoice settlement, numbering and payment records for native X89 files."]
use crate::{api::Success, ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<ContextInput, BillingContext>("commercial.invoices.context")
        .mutation_stub::<CaseInput, Success>("commercial.invoices.issue")
        .mutation_stub::<PaymentInput, Success>("commercial.invoices.recordPayment")
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextInput {
    pub contract_case_id: Id,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CaseInput {
    pub id: Id,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentInput {
    pub id: Id,
    pub amount: String,
    pub paid_on: NaiveDate,
    pub reference: String,
    #[serde(default)]
    #[ts(optional)]
    pub operation_id: Option<Id>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InvoicePayment {
    pub id: Id,
    pub amount: String,
    pub paid_on: NaiveDate,
    pub reference: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceDetails {
    pub basis: String,
    pub vat_rate: String,
    pub invoice_number: Option<String>,
    pub invoice_date: NaiveDate,
    pub due_date: NaiveDate,
    pub service_start: NaiveDate,
    pub service_end: NaiveDate,
    pub total_net: String,
    pub deducted_net: String,
    pub gross_amount: String,
    pub paid_amount: String,
    pub payments: Vec<InvoicePayment>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PriorInvoice {
    pub id: Id,
    pub invoice_number: String,
    pub invoice_date: NaiveDate,
    pub net_amount: String,
    pub gross_amount: String,
    pub paid_amount: String,
    pub vat_rate: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingContext {
    pub progress_invoices: Vec<PriorInvoice>,
    pub has_invoice: bool,
    pub has_final_invoice: bool,
    pub vat_rate: Option<String>,
}
