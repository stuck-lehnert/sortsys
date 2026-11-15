//! Provider credentials and usage settings are operator metadata. Tenant
//! documents, prompts and model answers never belong in these records.
use super::{
    ProviderAccountConfiguration, ProviderConfiguration, environment, provider, settings_types::*,
};
use crate::{
    api::Success,
    auth::AuthService,
    control::{Repository, Transaction, key, tenants},
    error::{ErrorCode, RpcError, RpcResult},
    error::{bad_request, forbidden, internal},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Default)]
pub(crate) struct Settings {
    pub encryption_key: Option<[u8; 32]>,
    pub mcp_url: Option<String>,
    pub internal_url: Option<String>,
    environment: Option<ProviderConfiguration>,
}

impl Settings {
    pub fn from_env() -> Self {
        let environment = environment::select_configuration(crate::config::optional)
            .filter(|value| provider::supports_mcp(value.provider))
            .map(|value| ProviderConfiguration {
                provider: value.provider.into(),
                model: value.model,
                base_url: value.base_url.map(str::to_owned),
                api_key: value.api_key,
            });
        Self {
            encryption_key: crate::config::optional("LLM_ENCRYPTION_KEY")
                .map(|value| Sha256::digest(value.as_bytes()).into()),
            mcp_url: crate::config::optional("LLM_MCP_URL"),
            internal_url: crate::config::optional("LLM_LIVE_INTERNAL_URL"),
            environment,
        }
    }

    fn cipher(&self) -> RpcResult<Aes256Gcm> {
        let key = self.encryption_key.as_ref().ok_or_else(|| {
            RpcError::new(
                ErrorCode::PreconditionFailed,
                "LLM_ENCRYPTION_KEY is required to store provider credentials",
            )
        })?;
        Aes256Gcm::new_from_slice(key).map_err(internal)
    }

    fn seal(&self, provider: &str, api_key: &str) -> RpcResult<Secret> {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).map_err(internal)?;
        let aad = credential_context(provider);
        let ciphertext = self
            .cipher()?
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: api_key.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(internal)?;
        Ok(Secret {
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        })
    }

    fn open(&self, provider: &str, secret: &Secret) -> RpcResult<String> {
        let nonce = URL_SAFE_NO_PAD
            .decode(&secret.nonce)
            .map_err(|_| unavailable())?;
        let nonce = Nonce::try_from(nonce.as_slice()).map_err(|_| unavailable())?;
        let ciphertext = URL_SAFE_NO_PAD
            .decode(&secret.ciphertext)
            .map_err(|_| unavailable())?;
        let aad = credential_context(provider);
        let plaintext = self
            .cipher()?
            .decrypt(
                &nonce,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| unavailable())?;
        String::from_utf8(plaintext).map_err(|_| unavailable())
    }
}

fn credential_context(provider: &str) -> Vec<u8> {
    sortsys_zerotrust::crypto::frame("sortsys/provider-credential/v1", &[provider])
}
fn unavailable() -> RpcError {
    RpcError::new(
        ErrorCode::PreconditionFailed,
        "LLM configuration is unavailable",
    )
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Secret {
    nonce: String,
    ciphertext: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Account {
    provider: String,
    base_url: Option<String>,
    secret: Secret,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    provider: String,
    model: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TenantOptions {
    pub enabled: bool,
    pub monthly_token_quota: Option<i64>,
}

async fn operator(service: &AuthService, request: &RequestContext) -> RpcResult<()> {
    if service.authenticate_admin(&request.headers).await? != "+all" {
        return Err(forbidden());
    }
    Ok(())
}

async fn account(
    transaction: &mut Transaction,
    settings: &Settings,
    name: &str,
) -> RpcResult<Option<ProviderAccountConfiguration>> {
    super::validate_provider(name)?;
    if let Some(saved) = transaction
        .read::<Account>(key("llm-provider-accounts", name))
        .await?
    {
        if saved.provider != name {
            return Err(unavailable());
        }
        return Ok(Some(ProviderAccountConfiguration {
            provider: saved.provider.clone(),
            base_url: saved.base_url,
            api_key: settings.open(&saved.provider, &saved.secret)?,
        }));
    }
    let blocked: Option<bool> = transaction.read(key("llm-provider-disabled", name)).await?;
    if blocked == Some(true) {
        return Ok(None);
    }
    Ok(settings
        .environment
        .as_ref()
        .filter(|value| value.provider == name)
        .map(|value| ProviderAccountConfiguration {
            provider: value.provider.clone(),
            base_url: value.base_url.clone(),
            api_key: value.api_key.clone(),
        }))
}

async fn configuration_in(
    transaction: &mut Transaction,
    settings: &Settings,
    use_case: &str,
) -> RpcResult<Option<ProviderConfiguration>> {
    super::validate_use_case(use_case)?;
    let selected: Option<Selection> = transaction.read(key("llm-use-cases", use_case)).await?;
    let selected = selected.or_else(|| {
        settings.environment.as_ref().map(|value| Selection {
            provider: value.provider.clone(),
            model: value.model.clone(),
        })
    });
    let Some(selected) = selected else {
        return Ok(None);
    };
    let Some(account) = account(transaction, settings, &selected.provider).await? else {
        return Ok(None);
    };
    Ok(Some(ProviderConfiguration {
        provider: account.provider,
        model: selected.model,
        base_url: account.base_url,
        api_key: account.api_key,
    }))
}

pub(super) async fn configuration(
    service: &AuthService,
    settings: &Settings,
    use_case: &str,
) -> RpcResult<Option<ProviderConfiguration>> {
    let mut transaction = service.records()?.transaction()?;
    let value = configuration_in(&mut transaction, settings, use_case).await?;
    transaction.validate().await?;
    Ok(value)
}

fn public_configuration(settings: &Settings, value: ProviderConfiguration) -> GlobalSettings {
    GlobalSettings {
        mcp_available: provider::supports_mcp(&value.provider)
            && (value.provider == "openrouter" || settings.mcp_url.is_some()),
        provider: value.provider,
        model: value.model,
        base_url: value.base_url,
        has_api_key: !value.api_key.is_empty(),
    }
}

pub(super) async fn tenant_options(transaction: &mut Transaction) -> RpcResult<TenantOptions> {
    Ok(transaction
        .read(key("llm-options", "current"))
        .await?
        .unwrap_or_default())
}

pub(super) async fn used_tokens(transaction: &mut Transaction) -> RpcResult<i64> {
    let month = Utc::now().format("%Y-%m").to_string();
    Ok(transaction
        .read::<i64>(key("llm-monthly-tokens", &month))
        .await?
        .unwrap_or(0))
}

async fn status(
    service: &AuthService,
    settings: &Settings,
    request: &RequestContext,
) -> RpcResult<LlmStatus> {
    let auth = service.authenticate(&request.headers).await?;
    let mut transaction = service.records()?.tenant(&auth.tenant)?.transaction()?;
    let access = crate::zerotrust::live_access(&mut transaction, &auth).await?;
    let options = tenant_options(&mut transaction).await?;
    let used_tokens = used_tokens(&mut transaction).await?;
    transaction.validate().await?;
    let provider = configuration(service, settings, super::CHAT_USE_CASE)
        .await?
        .map(|value| public_configuration(settings, value));
    let scan_provider_configured =
        configuration(service, settings, super::DOCUMENT_IMPORT_USE_CASE)
            .await?
            .is_some();
    let has_role = access.assistant;
    Ok(LlmStatus {
        available: has_role
            && options.enabled
            && provider.as_ref().is_some_and(|value| value.mcp_available)
            && options
                .monthly_token_quota
                .is_none_or(|limit| used_tokens < limit),
        has_role,
        tenant_enabled: options.enabled,
        provider_configured: provider.is_some(),
        scan_provider_configured,
        provider: provider.as_ref().map(|value| value.provider.clone()),
        model: provider.map(|value| value.model),
        monthly_token_quota: options.monthly_token_quota,
        used_tokens,
    })
}

fn checked_url(value: Option<&str>) -> RpcResult<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(value).map_err(|_| bad_request("Invalid provider URL"))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(bad_request("Invalid provider URL"));
    }
    Ok(Some(url.to_string().trim_end_matches('/').into()))
}

async fn save_account(
    transaction: &mut Transaction,
    settings: &Settings,
    name: &str,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> RpcResult<ProviderAccountSettings> {
    super::validate_provider(name)?;
    let previous = account(transaction, settings, name).await?;
    let api_key = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| previous.map(|value| value.api_key))
        .ok_or_else(|| bad_request("Provider credentials have not been configured"))?;
    if api_key.len() > 8192 {
        return Err(bad_request("Provider credential is too long"));
    }
    let base_url = checked_url(base_url)?;
    let saved = Account {
        provider: name.into(),
        base_url: base_url.clone(),
        secret: settings.seal(name, &api_key)?,
    };
    transaction
        .put(key("llm-provider-accounts", name), &saved)
        .await?;
    transaction
        .delete(key("llm-provider-disabled", name))
        .await?;
    Ok(ProviderAccountSettings {
        provider: name.into(),
        base_url,
        has_api_key: true,
    })
}

async fn select_model(
    transaction: &mut Transaction,
    settings: &Settings,
    use_case: &str,
    provider: &str,
    model: &str,
) -> RpcResult<UseCaseSettings> {
    super::validate_use_case(use_case)?;
    super::validate_provider(provider)?;
    if !provider::supports_mcp(provider) {
        return Err(bad_request(
            "Chat and document import require an authenticated MCP provider",
        ));
    }
    let model = model.trim();
    if model.is_empty() || model.len() > 255 {
        return Err(bad_request("Invalid model name"));
    }
    let account = account(transaction, settings, provider)
        .await?
        .ok_or_else(|| bad_request("Provider credentials have not been configured"))?;
    if use_case == super::DOCUMENT_IMPORT_USE_CASE {
        provider::require_image_input_model(&account, model).await?;
    }
    transaction
        .put(
            key("llm-use-cases", use_case),
            &Selection {
                provider: provider.into(),
                model: model.into(),
            },
        )
        .await?;
    let use_case = if use_case == super::DOCUMENT_IMPORT_USE_CASE {
        "documentImport"
    } else {
        "chat"
    };
    Ok(UseCaseSettings {
        use_case: use_case.into(),
        provider: Some(provider.into()),
        model: Some(model.into()),
    })
}

async fn published_tenants(service: &AuthService) -> RpcResult<Vec<tenants::RegistryEntry>> {
    let mut transaction = service.records()?.transaction()?;
    let tenants = transaction.all("tenants", 2000).await?;
    transaction.validate().await?;
    Ok(tenants)
}

async fn tenant_summary(repository: &Repository, name: &str) -> RpcResult<TenantLlmSettings> {
    let mut transaction = repository.transaction()?;
    let options = tenant_options(&mut transaction).await?;
    transaction.validate().await?;
    Ok(TenantLlmSettings {
        name: name.into(),
        enabled: options.enabled,
        monthly_token_quota: options.monthly_token_quota,
    })
}

async fn usage(repository: &Repository) -> RpcResult<Vec<UsageSummary>> {
    let mut transaction = repository.transaction()?;
    let month = Utc::now().format("%Y-%m").to_string();
    let values = transaction.all(&format!("llm-usage-{month}"), 2000).await?;
    transaction.validate().await?;
    Ok(values)
}

pub(crate) fn register(
    mut builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
    settings: Arc<Settings>,
) -> ProcedureRegistryBuilder {
    let reader = Arc::clone(&service);
    let preferences = Arc::clone(&settings);
    builder = builder.query("llm.status", move |ctx, _: ()| {
        let service = Arc::clone(&reader);
        let settings = Arc::clone(&preferences);
        async move { status(&service, &settings, &ctx).await }
    });
    let tenant_usage = Arc::clone(&service);
    builder = builder.query("llm.admin.usage", move |ctx, _: ()| {
        let service = Arc::clone(&tenant_usage);
        async move {
            let auth = service.authenticate(&ctx.headers).await?;
            if !auth.is_admin() {
                return Err(forbidden());
            }
            usage(&service.records()?.tenant(&auth.tenant)?).await
        }
    });
    let global_usage = Arc::clone(&service);
    builder = builder.query("admin.llm.usage", move |ctx, _: ()| {
        let service = Arc::clone(&global_usage);
        async move {
            operator(&service, &ctx).await?;
            let mut values = Vec::new();
            for tenant in published_tenants(&service).await? {
                values.extend(usage(&service.records()?.tenant(&tenant.name)?).await?);
            }
            values.sort_by(|left, right| {
                (&left.tenant, &left.provider, &left.model, &left.purpose).cmp(&(
                    &right.tenant,
                    &right.provider,
                    &right.model,
                    &right.purpose,
                ))
            });
            Ok(values)
        }
    });
    for (path, use_case) in [
        ("admin.llm.settings.get", super::CHAT_USE_CASE),
        (
            "admin.llm.scanSettings.get",
            super::DOCUMENT_IMPORT_USE_CASE,
        ),
    ] {
        let service = Arc::clone(&service);
        let settings = Arc::clone(&settings);
        builder = builder.query(path, move |ctx, _: ()| {
            let service = Arc::clone(&service);
            let settings = Arc::clone(&settings);
            async move {
                operator(&service, &ctx).await?;
                Ok(configuration(&service, &settings, use_case)
                    .await?
                    .map(|value| public_configuration(&settings, value)))
            }
        });
    }
    for (path, use_case) in [
        ("admin.llm.settings.update", super::CHAT_USE_CASE),
        (
            "admin.llm.scanSettings.update",
            super::DOCUMENT_IMPORT_USE_CASE,
        ),
    ] {
        let service = Arc::clone(&service);
        let settings = Arc::clone(&settings);
        builder = builder.mutation(path, move |ctx, input: UpdateSettingsInput| {
            let service = Arc::clone(&service);
            let settings = Arc::clone(&settings);
            async move {
                operator(&service, &ctx).await?;
                let mut transaction = service.records()?.transaction()?;
                save_account(
                    &mut transaction,
                    &settings,
                    input.provider.as_str(),
                    input.base_url.as_deref(),
                    input.api_key.as_deref(),
                )
                .await?;
                select_model(
                    &mut transaction,
                    &settings,
                    use_case,
                    input.provider.as_str(),
                    &input.model,
                )
                .await?;
                let value = configuration_in(&mut transaction, &settings, use_case)
                    .await?
                    .ok_or_else(unavailable)?;
                transaction.commit().await?;
                Ok(public_configuration(&settings, value))
            }
        });
    }
    let make = Arc::clone(&service);
    let preferences = Arc::clone(&settings);
    builder = builder.mutation(
        "admin.llm.providers.update",
        move |ctx, input: UpdateProviderAccountInput| {
            let service = Arc::clone(&make);
            let settings = Arc::clone(&preferences);
            async move {
                operator(&service, &ctx).await?;
                let mut transaction = service.records()?.transaction()?;
                let value = save_account(
                    &mut transaction,
                    &settings,
                    input.provider.as_str(),
                    input.base_url.as_deref(),
                    input.api_key.as_deref(),
                )
                .await?;
                transaction.commit().await?;
                Ok(value)
            }
        },
    );
    let erase = Arc::clone(&service);
    builder = builder.mutation(
        "admin.llm.providers.delete",
        move |ctx, input: ProviderInput| {
            let service = Arc::clone(&erase);
            async move {
                operator(&service, &ctx).await?;
                let mut transaction = service.records()?.transaction()?;
                transaction
                    .delete(key("llm-provider-accounts", input.provider.as_str()))
                    .await?;
                transaction
                    .put(key("llm-provider-disabled", input.provider.as_str()), &true)
                    .await?;
                transaction.commit().await?;
                Ok(Success { success: true })
            }
        },
    );
    let read = Arc::clone(&service);
    let preferences = Arc::clone(&settings);
    builder = builder.query("admin.llm.providers.list", move |ctx, _: ()| {
        let service = Arc::clone(&read);
        let settings = Arc::clone(&preferences);
        async move {
            operator(&service, &ctx).await?;
            let mut transaction = service.records()?.transaction()?;
            let mut values = Vec::new();
            for name in [
                "openai",
                "anthropic",
                "openrouter",
                "meta",
                "deepseek",
                "custom",
            ] {
                if let Some(value) = account(&mut transaction, &settings, name).await? {
                    values.push(ProviderAccountSettings {
                        provider: value.provider,
                        base_url: value.base_url,
                        has_api_key: !value.api_key.is_empty(),
                    });
                }
            }
            transaction.validate().await?;
            Ok(values)
        }
    });
    let models = Arc::clone(&service);
    let preferences = Arc::clone(&settings);
    builder = builder.query(
        "admin.llm.providers.models",
        move |ctx, input: ProviderInput| {
            let service = Arc::clone(&models);
            let settings = Arc::clone(&preferences);
            async move {
                operator(&service, &ctx).await?;
                let mut transaction = service.records()?.transaction()?;
                let account = account(&mut transaction, &settings, input.provider.as_str())
                    .await?
                    .ok_or_else(unavailable)?;
                transaction.validate().await?;
                Ok(provider::available_models(&account)
                    .await?
                    .into_iter()
                    .map(ProviderModelOption::from)
                    .collect::<Vec<_>>())
            }
        },
    );
    let list = Arc::clone(&service);
    let preferences = Arc::clone(&settings);
    builder = builder.query("admin.llm.useCases.list", move |ctx, _: ()| {
        let service = Arc::clone(&list);
        let settings = Arc::clone(&preferences);
        async move {
            operator(&service, &ctx).await?;
            let mut transaction = service.records()?.transaction()?;
            let mut values = Vec::new();
            for (id, name) in [
                (super::CHAT_USE_CASE, "chat"),
                (super::DOCUMENT_IMPORT_USE_CASE, "documentImport"),
            ] {
                let value = configuration_in(&mut transaction, &settings, id).await?;
                values.push(UseCaseSettings {
                    use_case: name.into(),
                    provider: value.as_ref().map(|value| value.provider.clone()),
                    model: value.map(|value| value.model),
                });
            }
            transaction.validate().await?;
            Ok(values)
        }
    });
    let select = Arc::clone(&service);
    let preferences = Arc::clone(&settings);
    builder = builder.mutation(
        "admin.llm.useCases.update",
        move |ctx, input: UpdateUseCaseInput| {
            let service = Arc::clone(&select);
            let settings = Arc::clone(&preferences);
            async move {
                operator(&service, &ctx).await?;
                let mut transaction = service.records()?.transaction()?;
                let value = select_model(
                    &mut transaction,
                    &settings,
                    input.use_case.as_str(),
                    input.provider.as_str(),
                    &input.model,
                )
                .await?;
                transaction.commit().await?;
                Ok(value)
            }
        },
    );
    let list = Arc::clone(&service);
    builder = builder.query("admin.llm.tenants.list", move |ctx, _: ()| {
        let service = Arc::clone(&list);
        async move {
            operator(&service, &ctx).await?;
            let mut values = Vec::new();
            for tenant in published_tenants(&service).await? {
                values.push(
                    tenant_summary(&service.records()?.tenant(&tenant.name)?, &tenant.name).await?,
                );
            }
            Ok(values)
        }
    });
    builder.mutation(
        "admin.llm.tenants.update",
        move |ctx, input: UpdateTenantLlmInput| {
            let service = Arc::clone(&service);
            async move {
                operator(&service, &ctx).await?;
                if input.monthly_token_quota.is_some_and(|quota| quota <= 0) {
                    return Err(bad_request("Invalid monthly token quota"));
                }
                let repository =
                    tenants::published_repository(service.records()?, &input.name).await?;
                let mut transaction = repository.transaction()?;
                transaction
                    .put(
                        key("llm-options", "current"),
                        &TenantOptions {
                            enabled: input.enabled,
                            monthly_token_quota: input.monthly_token_quota,
                        },
                    )
                    .await?;
                transaction
                    .notify("access", &serde_json::json!({}))
                    .map_err(internal)?;
                transaction.commit().await?;
                Ok(TenantLlmSettings {
                    name: input.name,
                    enabled: input.enabled,
                    monthly_token_quota: input.monthly_token_quota,
                })
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_credentials_are_authenticated_and_bound_to_the_provider() {
        let mut settings = Settings {
            encryption_key: Some([0x31; 32]),
            ..Default::default()
        };
        let secret = settings
            .seal("openrouter", "private-provider-token")
            .unwrap();
        assert_eq!(
            settings.open("openrouter", &secret).unwrap(),
            "private-provider-token"
        );
        assert!(settings.open("openai", &secret).is_err());
        let stored = serde_json::to_string(&secret).unwrap();
        assert!(!stored.contains("private-provider-token"));
        let mut replaced = URL_SAFE_NO_PAD.decode(&secret.ciphertext).unwrap();
        replaced[0] ^= 1;
        let altered = Secret {
            nonce: secret.nonce.clone(),
            ciphertext: URL_SAFE_NO_PAD.encode(replaced),
        };
        assert!(settings.open("openrouter", &altered).is_err());
        settings.encryption_key = Some([0x32; 32]);
        assert!(settings.open("openrouter", &secret).is_err());
    }
}
