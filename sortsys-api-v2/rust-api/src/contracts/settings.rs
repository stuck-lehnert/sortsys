#![doc = " Tenant settings and common-cost procedures."]
use super::common::Address;
use crate::{api::Success, rpc::ProcedureRegistryBuilder};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Organization {
    pub company_name: Option<String>,
    pub address: Option<Address>,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InvoiceNumberingScheme {
    Sequential,
    DateSeparated,
    DateCompact,
    ProjectLocal,
    ProjectGlobal,
}
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvoiceNumbering {
    pub scheme: InvoiceNumberingScheme,
    pub start_number: String,
}
impl Default for InvoiceNumbering {
    fn default() -> Self {
        Self {
            scheme: InvoiceNumberingScheme::Sequential,
            start_number: "1".to_owned(),
        }
    }
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Organization>("settings.organization.get")
        .mutation_stub::<Organization, Success>("settings.organization.set")
        .query_stub::<(), InvoiceNumbering>("settings.invoiceNumbering.get")
        .mutation_stub::<InvoiceNumbering, Success>("settings.invoiceNumbering.set")
}
