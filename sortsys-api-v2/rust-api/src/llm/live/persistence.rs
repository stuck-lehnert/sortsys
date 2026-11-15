//! Shared admission and accounting. These records contain routing and token
//! counts, never a prompt, document, tool result or model answer.
use super::*;
use crate::{
    auth::AuthService,
    control::{Transaction, key},
    llm::{ProviderConfiguration, TokenUsage, control, settings_types::UsageSummary},
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Active {
    leases: BTreeMap<String, u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Admission {
    run: String,
    subject: String,
    session: String,
    generation: String,
    kind: LiveKind,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageReceipt {
    provider: String,
    model: String,
    purpose: String,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    failed: bool,
}

fn run_key(collection: &str, run: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key(collection, &format!("r_{run}"))
}

async fn allowed(
    transaction: &mut Transaction,
    auth: &AuthResult,
    kind: LiveKind,
    check_quota: bool,
) -> RpcResult<(String, String)> {
    let identity =
        crate::zerotrust::live_session(transaction, auth, kind == LiveKind::DocumentImport).await?;
    let options = control::tenant_options(transaction).await?;
    if !options.enabled {
        return Err(forbidden());
    }
    let used = control::used_tokens(transaction).await?;
    if check_quota
        && options
            .monthly_token_quota
            .is_some_and(|limit| used >= limit)
    {
        return Err(RpcError::new(
            ErrorCode::TooManyRequests,
            "Monthly LLM quota reached",
        ));
    }
    Ok(identity)
}

pub(super) async fn authorize(
    service: &AuthService,
    auth: &AuthResult,
    kind: LiveKind,
) -> RpcResult<()> {
    crate::control::read_snapshot(|| async {
        let mut transaction = service.records()?.tenant(&auth.tenant)?.transaction()?;
        allowed(&mut transaction, auth, kind, true).await?;
        transaction.validate().await
    })
    .await
}

pub(super) async fn authorize_completion(
    service: &AuthService,
    auth: &AuthResult,
    kind: LiveKind,
) -> RpcResult<()> {
    crate::control::read_snapshot(|| async {
        let mut transaction = service.records()?.tenant(&auth.tenant)?.transaction()?;
        allowed(&mut transaction, auth, kind, false).await?;
        transaction.validate().await
    })
    .await
}

pub(super) async fn admit(
    service: &AuthService,
    auth: &AuthResult,
    ticket: &Ticket,
) -> RpcResult<()> {
    let repository = service.records()?.tenant(&auth.tenant)?;
    for _ in 0..32 {
        let mut transaction = repository.transaction()?;
        let (subject, generation) = allowed(&mut transaction, auth, ticket.kind, true).await?;
        if ticket.subject != subject
            || ticket.generation != generation
            || !ticket.matches(auth, ticket.scope()?)
            || ticket.exp <= now()
        {
            return Err(forbidden());
        }
        let record = run_key("llm-live-admissions", &ticket.run);
        if transaction
            .read::<Admission>(record.clone())
            .await?
            .is_some()
        {
            return Err(forbidden());
        }
        let mut active: Active = transaction
            .read(key("llm-active", "current"))
            .await?
            .unwrap_or_default();
        let now = now();
        active.leases.retain(|_, expires| *expires > now);
        if active.leases.len() >= 4 {
            return Err(busy());
        }
        active
            .leases
            .insert(ticket.run.clone(), now + REQUEST_SECONDS);
        let expiry =
            DateTime::from_timestamp((now + REQUEST_SECONDS + 60) as i64, 0).ok_or_else(invalid)?;
        transaction
            .put_expiring(
                record,
                &Admission {
                    run: ticket.run.clone(),
                    subject,
                    session: ticket.session.clone(),
                    generation,
                    kind: ticket.kind,
                },
                expiry,
            )
            .await?;
        transaction
            .put(key("llm-active", "current"), &active)
            .await?;
        match transaction.commit().await {
            Ok(_) => return Ok(()),
            Err(error) if error.code == ErrorCode::Conflict => continue,
            Err(error) => return Err(error),
        }
    }
    Err(crate::control::conflict())
}

pub(super) async fn release(service: &AuthService, tenant: &str, run: &str) -> RpcResult<()> {
    let repository = service.records()?.tenant(tenant)?;
    for _ in 0..32 {
        let mut transaction = repository.transaction()?;
        let mut active: Active = transaction
            .read(key("llm-active", "current"))
            .await?
            .unwrap_or_default();
        if active.leases.remove(run).is_none() {
            return transaction.validate().await;
        }
        transaction
            .put(key("llm-active", "current"), &active)
            .await?;
        match transaction.commit().await {
            Ok(_) => return Ok(()),
            Err(error) if error.code == ErrorCode::Conflict => continue,
            Err(error) => return Err(error),
        }
    }
    Err(crate::control::conflict())
}

fn add(value: i64, amount: i64) -> RpcResult<i64> {
    value.checked_add(amount).ok_or_else(unavailable)
}

pub(super) async fn record(
    service: &AuthService,
    ticket: &Ticket,
    configuration: &ProviderConfiguration,
    usage: &TokenUsage,
    failed: bool,
) -> RpcResult<()> {
    let repository = service.records()?.tenant(&ticket.tenant)?;
    let purpose = match ticket.kind {
        LiveKind::Chat => "chat",
        LiveKind::DocumentImport => "delivery_note_scan",
    };
    let receipt = UsageReceipt {
        provider: configuration.provider.clone(),
        model: configuration.model.clone(),
        purpose: purpose.into(),
        input_tokens: usage.input_tokens.max(0),
        output_tokens: usage.output_tokens.max(0),
        total_tokens: usage.total_tokens.max(0),
        failed,
    };
    let month = Utc::now().format("%Y-%m").to_string();
    let binding = sortsys_zerotrust::crypto::frame(
        "sortsys/llm-usage/v1",
        &[&receipt.provider, &receipt.model, &receipt.purpose],
    );
    let group = format!("u_{}", URL_SAFE_NO_PAD.encode(Sha256::digest(binding)));
    for _ in 0..32 {
        let mut transaction = repository.transaction()?;
        let admission: Admission = transaction
            .read(run_key("llm-live-admissions", &ticket.run))
            .await?
            .ok_or_else(forbidden)?;
        if admission.run != ticket.run
            || admission.session != ticket.session
            || admission.subject != ticket.subject
            || admission.generation != ticket.generation
            || admission.kind != ticket.kind
        {
            return Err(forbidden());
        }
        let record = run_key("llm-usage-receipts", &ticket.run);
        if let Some(previous) = transaction.read::<UsageReceipt>(record.clone()).await? {
            if previous != receipt {
                return Err(forbidden());
            }
            return transaction.validate().await;
        }
        let aggregate_key = key(&format!("llm-usage-{month}"), &group);
        let mut aggregate: UsageSummary = transaction
            .read(aggregate_key.clone())
            .await?
            .unwrap_or_else(|| UsageSummary {
                tenant: ticket.tenant.clone(),
                provider: receipt.provider.clone(),
                model: receipt.model.clone(),
                purpose: receipt.purpose.clone(),
                request_count: 0,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                failed_requests: 0,
            });
        if aggregate.tenant != ticket.tenant
            || aggregate.provider != receipt.provider
            || aggregate.model != receipt.model
            || aggregate.purpose != receipt.purpose
        {
            return Err(unavailable());
        }
        aggregate.request_count = add(aggregate.request_count, 1)?;
        aggregate.input_tokens = add(aggregate.input_tokens, receipt.input_tokens)?;
        aggregate.output_tokens = add(aggregate.output_tokens, receipt.output_tokens)?;
        aggregate.total_tokens = add(aggregate.total_tokens, receipt.total_tokens)?;
        if failed {
            aggregate.failed_requests = add(aggregate.failed_requests, 1)?;
        }
        let total_key = key("llm-monthly-tokens", &month);
        let total = transaction
            .read::<i64>(total_key.clone())
            .await?
            .unwrap_or(0);
        transaction
            .put(total_key, &add(total, receipt.total_tokens)?)
            .await?;
        transaction.put(aggregate_key, &aggregate).await?;
        transaction.put(record, &receipt).await?;
        match transaction.commit().await {
            Ok(_) => return Ok(()),
            Err(error) if error.code == ErrorCode::Conflict => continue,
            Err(error) => return Err(error),
        }
    }
    Err(crate::control::conflict())
}
