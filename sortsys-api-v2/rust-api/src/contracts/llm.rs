#![doc = " LLM administration, personal chat history, usage, and proposal review."]
use crate::llm::settings_types::*;
use crate::{api::Success, ids::Id, rpc::ProcedureRegistryBuilder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
pub fn register_contract(mut builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder = builder.query_stub::<(), LlmStatus>("llm.status");
    builder = builder.query_stub::<(), Vec<ChatSummary>>("llm.chats.list");
    builder = builder.mutation_stub::<CreateChatInput, ChatSummary>("llm.chats.create");
    builder = builder.query_stub::<ChatInput, ChatDetail>("llm.chats.get");
    builder = builder.mutation_stub::<ChatInput, Success>("llm.chats.delete");
    builder = builder.mutation_stub::<SendMessageInput, ChatDetail>("llm.messages.send");
    builder = builder.mutation_stub::<ReviewProposalInput, Success>("llm.proposals.review");
    builder = builder.query_stub::<(), Vec<UsageSummary>>("llm.admin.usage");
    builder = builder.query_stub::<(), Vec<ProviderAccountSettings>>("admin.llm.providers.list");
    builder = builder.mutation_stub::<UpdateProviderAccountInput, ProviderAccountSettings>(
        "admin.llm.providers.update",
    );
    builder = builder.mutation_stub::<ProviderInput, Success>("admin.llm.providers.delete");
    builder =
        builder.query_stub::<ProviderInput, Vec<ProviderModelOption>>("admin.llm.providers.models");
    builder = builder.query_stub::<(), Vec<UseCaseSettings>>("admin.llm.useCases.list");
    builder =
        builder.mutation_stub::<UpdateUseCaseInput, UseCaseSettings>("admin.llm.useCases.update");
    builder = builder.query_stub::<(), Option<GlobalSettings>>("admin.llm.settings.get");
    builder =
        builder.mutation_stub::<UpdateSettingsInput, GlobalSettings>("admin.llm.settings.update");
    builder = builder.query_stub::<(), Option<GlobalSettings>>("admin.llm.scanSettings.get");
    builder = builder
        .mutation_stub::<UpdateSettingsInput, GlobalSettings>("admin.llm.scanSettings.update");
    builder = builder.query_stub::<(), Vec<TenantLlmSettings>>("admin.llm.tenants.list");
    builder = builder
        .mutation_stub::<UpdateTenantLlmInput, TenantLlmSettings>("admin.llm.tenants.update");
    builder.query_stub::<(), Vec<UsageSummary>>("admin.llm.usage")
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateChatInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub title: Option<String>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatInput {
    pub chat_id: Id,
}
#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AssistantLocale {
    #[default]
    De,
    En,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMessageInput {
    pub chat_id: Id,
    pub content: String,
    #[serde(default)]
    #[ts(optional)]
    pub locale: Option<AssistantLocale>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewProposalInput {
    pub proposal_id: Id,
    pub decision: ProposalDecision,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub comment: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub execution_results: Option<Vec<ProposalExecutionResult>>,
    #[serde(default)]
    #[ts(optional)]
    pub continue_conversation: Option<bool>,
}
#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalExecutionResult {
    pub path: String,
    pub output: Value,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ProposalDecision {
    Accept,
    Decline,
    RequestRevision,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: Id,
    pub title: String,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub updated_at: DateTime<Utc>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: Id,
    #[ts(type = "\"user\" | \"assistant\"")]
    pub role: String,
    pub content: String,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeProposal {
    pub id: Id,
    pub assistant_message_id: Option<Id>,
    pub title: String,
    pub summary: String,
    pub operations: Value,
    pub execution_results: Option<Value>,
    #[ts(type = "\"pending\" | \"declined\" | \"revision_requested\" | \"accepted\"")]
    pub status: String,
    pub review_comment: Option<String>,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date | null")]
    pub reviewed_at: Option<DateTime<Utc>>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChatDetail {
    pub chat: ChatSummary,
    pub messages: Vec<ChatMessage>,
    pub proposals: Vec<ChangeProposal>,
}
