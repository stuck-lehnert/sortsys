//! Wire descriptions for the client business facade and native procedures.
//! Business stubs describe browser operations; they do not register server handlers.
pub mod commercial;
pub mod commercial_billing;
pub mod commercial_documents;
pub mod common;
pub mod delivery_notes;
pub mod document_templates;
pub mod gaeb_positions;
pub mod llm;
pub mod passkeys;
pub mod personalization;
pub mod products;
pub mod project_files;
pub mod settings;
pub mod tool_bookings;
pub mod xml_documents;
use crate::rpc::ProcedureRegistryBuilder;
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    let builder = crate::operator::register_contract(builder);
    let builder = crate::telemetry::register_contract(builder);
    let builder = crate::storage::register_contract(builder);
    let builder = passkeys::register_contract(builder);
    let builder = crate::zerotrust::register_contract(builder);
    let builder = crate::llm::live::register_contract(builder);
    let builder = settings::register_contract(builder);
    let builder = document_templates::register_contract(builder);
    let builder = commercial::register_contract(builder);
    let builder = commercial_billing::register_contract(builder);
    let builder = commercial_documents::register_contract(builder);
    let builder = gaeb_positions::register_contract(builder);
    let builder = personalization::register_contract(builder);
    let builder = tool_bookings::register_contract(builder);
    let builder = llm::register_contract(builder);
    let builder = delivery_notes::register_contract(builder);
    let builder = products::register_contract(builder);
    let builder = project_files::register_contract(builder);
    xml_documents::register_contract(builder)
}
