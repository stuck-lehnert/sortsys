//! Shared wire types for model configuration and public usage counters.
use crate::llm;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateSettingsInput {
    pub(crate) provider: ProviderName,
    pub(crate) model: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub(crate) base_url: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub(crate) api_key: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub(crate) enum ProviderName {
    Openai,
    Anthropic,
    Meta,
    Openrouter,
    Deepseek,
    Custom,
}

impl ProviderName {
    pub(crate) const fn as_str(&self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Meta => "meta",
            Self::Openrouter => "openrouter",
            Self::Deepseek => "deepseek",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderInput {
    pub(crate) provider: ProviderName,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateProviderAccountInput {
    pub(crate) provider: ProviderName,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub(crate) base_url: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub(crate) api_key: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub(crate) enum LlmUseCase {
    Chat,
    DocumentImport,
}

impl LlmUseCase {
    pub(crate) const fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => llm::CHAT_USE_CASE,
            Self::DocumentImport => llm::DOCUMENT_IMPORT_USE_CASE,
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateUseCaseInput {
    pub(crate) use_case: LlmUseCase,
    pub(crate) provider: ProviderName,
    pub(crate) model: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateTenantLlmInput {
    pub(crate) name: String,
    pub(crate) enabled: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    #[serde(with = "crate::superjson::optional_bigint")]
    #[ts(as = "Option<i64>")]
    pub(crate) monthly_token_quota: Option<i64>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlmStatus {
    pub(crate) available: bool,
    pub(crate) has_role: bool,
    pub(crate) tenant_enabled: bool,
    pub(crate) provider_configured: bool,
    pub(crate) scan_provider_configured: bool,
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
    #[serde(with = "crate::superjson::optional_bigint")]
    #[ts(as = "Option<i64>")]
    pub(crate) monthly_token_quota: Option<i64>,
    #[serde(with = "crate::superjson::bigint")]
    #[ts(as = "i64")]
    pub(crate) used_tokens: i64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalSettings {
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) base_url: Option<String>,
    pub(crate) has_api_key: bool,
    pub(crate) mcp_available: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAccountSettings {
    pub(crate) provider: String,
    pub(crate) base_url: Option<String>,
    pub(crate) has_api_key: bool,
}

impl From<llm::PublicProviderAccount> for ProviderAccountSettings {
    fn from(value: llm::PublicProviderAccount) -> Self {
        Self {
            provider: value.provider,
            base_url: value.base_url,
            has_api_key: value.has_api_key,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderModelOption {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) supports_image_input: bool,
}

impl From<llm::AvailableProviderModel> for ProviderModelOption {
    fn from(value: llm::AvailableProviderModel) -> Self {
        Self {
            id: value.id,
            name: value.name,
            supports_image_input: value.supports_image_input,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UseCaseSettings {
    #[ts(type = "\"chat\" | \"documentImport\"")]
    pub(crate) use_case: String,
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
}

impl From<llm::PublicProviderConfiguration> for GlobalSettings {
    fn from(value: llm::PublicProviderConfiguration) -> Self {
        Self {
            provider: value.provider,
            model: value.model,
            base_url: value.base_url,
            has_api_key: value.has_api_key,
            mcp_available: value.mcp_available,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TenantLlmSettings {
    pub(crate) name: String,
    pub(crate) enabled: bool,
    #[serde(with = "crate::superjson::optional_bigint")]
    #[ts(as = "Option<i64>")]
    pub(crate) monthly_token_quota: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageSummary {
    pub(crate) tenant: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) purpose: String,
    #[serde(with = "crate::superjson::bigint")]
    #[ts(as = "i64")]
    pub(crate) request_count: i64,
    #[serde(with = "crate::superjson::bigint")]
    #[ts(as = "i64")]
    pub(crate) input_tokens: i64,
    #[serde(with = "crate::superjson::bigint")]
    #[ts(as = "i64")]
    pub(crate) output_tokens: i64,
    #[serde(with = "crate::superjson::bigint")]
    #[ts(as = "i64")]
    pub(crate) total_tokens: i64,
    #[serde(with = "crate::superjson::bigint")]
    #[ts(as = "i64")]
    pub(crate) failed_requests: i64,
}
