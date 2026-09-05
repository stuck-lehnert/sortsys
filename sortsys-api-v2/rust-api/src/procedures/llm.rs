//! LLM administration, personal chat history, usage, and proposal review.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use ts_rs::TS;

use super::{
    admin_common::{admin_for, require_global},
    common::{bad_request, forbidden, internal},
};
use crate::{
    AppState,
    api::Success,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    llm::{self, ChatTurn, TokenUsage},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let status_state = Arc::clone(&state);
    builder = builder.query("llm.status", move |context, _input: ()| {
        let state = Arc::clone(&status_state);

        async move { status(&state, &context).await }
    });

    let list_chats_state = Arc::clone(&state);
    builder = builder.query("llm.chats.list", move |context, _input: ()| {
        let state = Arc::clone(&list_chats_state);

        async move { list_chats(&state, &context).await }
    });

    let create_chat_state = Arc::clone(&state);
    builder = builder.mutation(
        "llm.chats.create",
        move |context, input: CreateChatInput| {
            let state = Arc::clone(&create_chat_state);

            async move { create_chat(&state, &context, input).await }
        },
    );

    let get_chat_state = Arc::clone(&state);
    builder = builder.query("llm.chats.get", move |context, input: ChatInput| {
        let state = Arc::clone(&get_chat_state);

        async move { get_chat(&state, &context, input.chat_id).await }
    });

    let delete_chat_state = Arc::clone(&state);
    builder = builder.mutation("llm.chats.delete", move |context, input: ChatInput| {
        let state = Arc::clone(&delete_chat_state);

        async move { delete_chat(&state, &context, input.chat_id).await }
    });

    let send_state = Arc::clone(&state);
    builder = builder.mutation(
        "llm.messages.send",
        move |context, input: SendMessageInput| {
            let state = Arc::clone(&send_state);

            async move { send_message(&state, &context, input).await }
        },
    );

    let review_state = Arc::clone(&state);
    builder = builder.mutation(
        "llm.proposals.review",
        move |context, input: ReviewProposalInput| {
            let state = Arc::clone(&review_state);

            async move { review_proposal(&state, &context, input).await }
        },
    );

    let tenant_usage_state = Arc::clone(&state);
    builder = builder.query("llm.admin.usage", move |context, _input: ()| {
        let state = Arc::clone(&tenant_usage_state);

        async move { tenant_usage(&state, &context).await }
    });

    let settings_get_state = Arc::clone(&state);
    builder = builder.query("admin.llm.settings.get", move |context, _input: ()| {
        let state = Arc::clone(&settings_get_state);

        async move { global_settings(&state, &context).await }
    });

    let settings_update_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.llm.settings.update",
        move |context, input: UpdateSettingsInput| {
            let state = Arc::clone(&settings_update_state);

            async move { update_global_settings(&state, &context, input).await }
        },
    );

    let scan_settings_get_state = Arc::clone(&state);
    builder = builder.query("admin.llm.scanSettings.get", move |context, _input: ()| {
        let state = Arc::clone(&scan_settings_get_state);

        async move { global_scan_settings(&state, &context).await }
    });

    let scan_settings_update_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.llm.scanSettings.update",
        move |context, input: UpdateSettingsInput| {
            let state = Arc::clone(&scan_settings_update_state);

            async move { update_global_scan_settings(&state, &context, input).await }
        },
    );

    let tenants_state = Arc::clone(&state);
    builder = builder.query("admin.llm.tenants.list", move |context, _input: ()| {
        let state = Arc::clone(&tenants_state);

        async move { global_tenants(&state, &context).await }
    });

    let tenant_update_state = Arc::clone(&state);
    builder = builder.mutation(
        "admin.llm.tenants.update",
        move |context, input: UpdateTenantLlmInput| {
            let state = Arc::clone(&tenant_update_state);

            async move { update_tenant(&state, &context, input).await }
        },
    );

    builder.query("admin.llm.usage", move |context, _input: ()| {
        let state = Arc::clone(&state);

        async move { global_usage(&state, &context).await }
    })
}

pub fn register_contract(mut builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder = builder.query_stub::<(), LlmStatus>("llm.status");
    builder = builder.query_stub::<(), Vec<ChatSummary>>("llm.chats.list");
    builder = builder.mutation_stub::<CreateChatInput, ChatSummary>("llm.chats.create");
    builder = builder.query_stub::<ChatInput, ChatDetail>("llm.chats.get");
    builder = builder.mutation_stub::<ChatInput, Success>("llm.chats.delete");
    builder = builder.mutation_stub::<SendMessageInput, ChatDetail>("llm.messages.send");
    builder = builder.mutation_stub::<ReviewProposalInput, Success>("llm.proposals.review");
    builder = builder.query_stub::<(), Vec<UsageSummary>>("llm.admin.usage");
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

async fn status(state: &AppState, context: &RequestContext) -> RpcResult<LlmStatus> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let tenant = state
        .tenants
        .tenant(&auth.tenant)
        .await
        .map_err(internal)?
        .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Tenant not found"))?;
    let (tenant_enabled, monthly_token_quota) = llm::tenant_llm_options(&tenant.options);
    let has_role = auth.can_do(":llm");
    let provider = llm::public_configuration(state).await?;
    let scan_provider_configured = llm::public_scan_configuration(state).await?.is_some();
    let used_tokens = current_month_usage(state, &auth.tenant).await?;

    Ok(LlmStatus {
        available: has_role && tenant_enabled && provider.is_some(),
        has_role,
        tenant_enabled,
        provider_configured: provider.is_some(),
        scan_provider_configured,
        provider: provider.as_ref().map(|value| value.provider.clone()),
        model: provider.map(|value| value.model),
        monthly_token_quota,
        used_tokens,
    })
}

async fn list_chats(state: &AppState, context: &RequestContext) -> RpcResult<Vec<ChatSummary>> {
    let (auth, pool) = authenticated_llm_pool(state, context).await?;
    let user_id = user_id(&auth)?;
    let rows = sqlx::query_as::<_, ChatRow>(
        r#"
        SELECT id, title, created_at, updated_at
        FROM llm_chats
        WHERE user_id = $1
        ORDER BY updated_at DESC, id DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(ChatSummary::from).collect())
}

async fn create_chat(
    state: &AppState,
    context: &RequestContext,
    input: CreateChatInput,
) -> RpcResult<ChatSummary> {
    let (auth, pool) = authenticated_llm_pool(state, context).await?;
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("Neuer Chat");

    if title.len() > 160 {
        return Err(bad_request("title must not exceed 160 characters"));
    }

    let row = sqlx::query_as::<_, ChatRow>(
        r#"
        INSERT INTO llm_chats (user_id, title)
        VALUES ($1, $2)
        RETURNING id, title, created_at, updated_at
        "#,
    )
    .bind(user_id(&auth)?)
    .bind(title)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(ChatSummary::from(row))
}

async fn get_chat(
    state: &AppState,
    context: &RequestContext,
    chat_id: Id,
) -> RpcResult<ChatDetail> {
    let (auth, pool) = authenticated_llm_pool(state, context).await?;

    load_chat(&pool, &auth, chat_id.0).await
}

async fn delete_chat(
    state: &AppState,
    context: &RequestContext,
    chat_id: Id,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_llm_pool(state, context).await?;
    let result = sqlx::query("DELETE FROM llm_chats WHERE id = $1 AND user_id = $2")
        .bind(chat_id.0)
        .bind(user_id(&auth)?)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(RpcError::new(ErrorCode::NotFound, "Chat not found"));
    }

    Ok(Success { success: true })
}

async fn send_message(
    state: &AppState,
    context: &RequestContext,
    input: SendMessageInput,
) -> RpcResult<ChatDetail> {
    let (auth, pool) = authenticated_llm_pool(state, context).await?;
    let content = input.content.trim();

    if content.is_empty() || content.len() > 20_000 {
        return Err(bad_request(
            "content must contain between 1 and 20000 characters",
        ));
    }

    llm::ensure_chat_owner(&pool, input.chat_id.0, user_id(&auth)?).await?;

    let mut transaction = pool.begin().await.map_err(internal)?;
    sqlx::query(
        r#"
        INSERT INTO llm_messages (chat_id, role, content)
        VALUES ($1, 'user', $2)
        "#,
    )
    .bind(input.chat_id.0)
    .bind(content)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    sqlx::query(
        r#"
        UPDATE llm_chats
        SET
          title = CASE WHEN title = 'Neuer Chat' THEN $2 ELSE title END,
          updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(input.chat_id.0)
    .bind(chat_title(content))
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;

    let turns = load_recent_turns(&pool, input.chat_id.0).await?;
    let configuration = llm::load_configuration(state).await?.ok_or_else(|| {
        RpcError::new(
            ErrorCode::PreconditionFailed,
            "No LLM provider has been configured",
        )
    })?;

    let completion = llm::complete(
        state,
        &auth,
        input.chat_id.0,
        &configuration,
        &turns,
        input
            .locale
            .as_ref()
            .map(AssistantLocale::as_str)
            .unwrap_or("de"),
    )
    .await;

    let completion = match completion {
        Ok(completion) => {
            llm::record_usage(
                state,
                &auth,
                input.chat_id.0,
                &configuration,
                &completion.usage,
                None,
            )
            .await?;
            completion
        }
        Err(error) => {
            llm::record_usage(
                state,
                &auth,
                input.chat_id.0,
                &configuration,
                &TokenUsage::default(),
                Some(&error.message),
            )
            .await?;

            return Err(error);
        }
    };

    let mut transaction = pool.begin().await.map_err(internal)?;
    let has_unassigned_proposal: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM llm_change_proposals WHERE chat_id = $1 AND assistant_message_id IS NULL)",
    )
    .bind(input.chat_id.0)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;
    let assistant_content =
        if has_unassigned_proposal && completion.content.trim() == llm::PROPOSAL_ONLY_MARKER {
            ""
        } else {
            completion.content.as_str()
        };

    let message_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO llm_messages (chat_id, role, content)
        VALUES ($1, 'assistant', $2)
        RETURNING id
        "#,
    )
    .bind(input.chat_id.0)
    .bind(assistant_content)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;

    // Proposals may have been created through native MCP while the provider
    // request was running. Attaching only unassigned proposals is safe because
    // one chat message is processed synchronously per browser interaction.
    sqlx::query(
        r#"
        UPDATE llm_change_proposals
        SET assistant_message_id = $2
        WHERE chat_id = $1
          AND assistant_message_id IS NULL
        "#,
    )
    .bind(input.chat_id.0)
    .bind(message_id)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    sqlx::query("UPDATE llm_chats SET updated_at = NOW() WHERE id = $1")
        .bind(input.chat_id.0)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;

    load_chat(&pool, &auth, input.chat_id.0).await
}

async fn review_proposal(
    state: &AppState,
    context: &RequestContext,
    input: ReviewProposalInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_llm_pool(state, context).await?;
    let status = match input.decision {
        ProposalDecision::Accept => "accepted",
        ProposalDecision::Decline => "declined",
        ProposalDecision::RequestRevision => "revision_requested",
    };
    let comment = input
        .comment
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if matches!(input.decision, ProposalDecision::RequestRevision) && comment.is_none() {
        return Err(bad_request(
            "a comment is required when requesting a revision",
        ));
    }
    if comment.is_some_and(|value| value.len() > 2_000) {
        return Err(bad_request("comment must not exceed 2000 characters"));
    }

    let execution_results = input
        .execution_results
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(internal)?;

    if !matches!(input.decision, ProposalDecision::Accept) && execution_results.is_some() {
        return Err(bad_request(
            "executionResults are only valid when accepting a proposal",
        ));
    }

    let result = sqlx::query(
        r#"
        UPDATE llm_change_proposals AS proposal
        SET
          status = $3,
          review_comment = $4,
          execution_results = $5,
          reviewed_at = NOW()
        FROM llm_chats AS chat
        WHERE proposal.id = $1
          AND proposal.chat_id = chat.id
          AND chat.user_id = $2
          AND proposal.status IN ('pending', 'revision_requested')
        "#,
    )
    .bind(input.proposal_id.0)
    .bind(user_id(&auth)?)
    .bind(status)
    .bind(comment)
    .bind(execution_results)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(RpcError::new(
            ErrorCode::Conflict,
            "Proposal does not exist or has already been reviewed",
        ));
    }

    Ok(Success { success: true })
}

async fn tenant_usage(state: &AppState, context: &RequestContext) -> RpcResult<Vec<UsageSummary>> {
    let auth = state.auth.authenticate(&context.headers).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }

    usage_rows(state, Some(&auth.tenant)).await
}

async fn global_settings(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<Option<GlobalSettings>> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    Ok(llm::public_configuration(state)
        .await?
        .map(GlobalSettings::from))
}

async fn update_global_settings(
    state: &AppState,
    context: &RequestContext,
    input: UpdateSettingsInput,
) -> RpcResult<GlobalSettings> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    llm::save_configuration(
        state,
        input.provider.as_str(),
        &input.model,
        input.base_url.as_deref(),
        input.api_key.as_deref(),
    )
    .await?;

    global_settings(state, context)
        .await?
        .ok_or_else(|| internal("LLM settings were not saved"))
}

async fn global_scan_settings(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<Option<GlobalSettings>> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    Ok(llm::public_scan_configuration(state)
        .await?
        .map(GlobalSettings::from))
}

async fn update_global_scan_settings(
    state: &AppState,
    context: &RequestContext,
    input: UpdateSettingsInput,
) -> RpcResult<GlobalSettings> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    llm::save_scan_configuration(
        state,
        input.provider.as_str(),
        &input.model,
        input.base_url.as_deref(),
        input.api_key.as_deref(),
    )
    .await?;

    global_scan_settings(state, context)
        .await?
        .ok_or_else(|| internal("Scan LLM settings were not saved"))
}

async fn global_tenants(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<Vec<TenantLlmSettings>> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    let rows: Vec<(String, Value)> =
        sqlx::query_as("SELECT name, options FROM __tenants ORDER BY name")
            .fetch_all(state.tenants.master())
            .await
            .map_err(internal)?;

    Ok(rows
        .into_iter()
        .map(|(name, options)| {
            let (enabled, monthly_token_quota) = llm::tenant_llm_options(&options);

            TenantLlmSettings {
                name,
                enabled,
                monthly_token_quota,
            }
        })
        .collect())
}

async fn update_tenant(
    state: &AppState,
    context: &RequestContext,
    input: UpdateTenantLlmInput,
) -> RpcResult<TenantLlmSettings> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    let name = input.name.trim().to_lowercase();
    if name.is_empty() {
        return Err(bad_request("missing tenant name"));
    }
    if input.monthly_token_quota.is_some_and(|value| value <= 0) {
        return Err(bad_request("monthlyTokenQuota must be positive"));
    }

    let options: Option<Value> = sqlx::query_scalar(
        r#"
        UPDATE __tenants
        SET options = JSONB_SET(
          COALESCE(options, '{}'::JSONB),
          '{llm}',
          JSONB_BUILD_OBJECT(
            'enabled', $2::BOOLEAN,
            'monthlyTokenQuota', TO_JSONB($3::BIGINT)
          ),
          TRUE
        )
        WHERE name = $1
        RETURNING options
        "#,
    )
    .bind(&name)
    .bind(input.enabled)
    .bind(input.monthly_token_quota)
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?;
    let options = options.ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Tenant not found"))?;
    let (enabled, monthly_token_quota) = llm::tenant_llm_options(&options);

    Ok(TenantLlmSettings {
        name,
        enabled,
        monthly_token_quota,
    })
}

async fn global_usage(state: &AppState, context: &RequestContext) -> RpcResult<Vec<UsageSummary>> {
    let admin_for = admin_for(state, context).await?;
    require_global(&admin_for)?;

    usage_rows(state, None).await
}

async fn usage_rows(state: &AppState, tenant: Option<&str>) -> RpcResult<Vec<UsageSummary>> {
    let rows = sqlx::query_as::<_, UsageRow>(
        r#"
        SELECT
          usage.tenant_name,
          usage.provider,
          usage.model,
          usage.purpose,
          COUNT(*)::BIGINT AS request_count,
          COALESCE(SUM(usage.input_tokens), 0)::BIGINT AS input_tokens,
          COALESCE(SUM(usage.output_tokens), 0)::BIGINT AS output_tokens,
          COALESCE(SUM(usage.total_tokens), 0)::BIGINT AS total_tokens,
          COUNT(*) FILTER (WHERE usage.status = 'failed')::BIGINT AS failed_requests
        FROM __llm_usage AS usage
        WHERE usage.created_at >= DATE_TRUNC('month', NOW())
          AND ($1::TEXT IS NULL OR usage.tenant_name = $1)
        GROUP BY usage.tenant_name, usage.provider, usage.model, usage.purpose
        ORDER BY usage.tenant_name, usage.provider, usage.model
        "#,
    )
    .bind(tenant)
    .fetch_all(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(UsageSummary::from).collect())
}

async fn current_month_usage(state: &AppState, tenant: &str) -> RpcResult<i64> {
    sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(total_tokens), 0)::BIGINT
        FROM __llm_usage
        WHERE tenant_name = $1
          AND created_at >= DATE_TRUNC('month', NOW())
        "#,
    )
    .bind(tenant)
    .fetch_one(state.tenants.master())
    .await
    .map_err(internal)
}

async fn authenticated_llm_pool(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<(AuthResult, PgPool)> {
    let auth = state.auth.authenticate(&context.headers).await?;
    llm::ensure_user_access(state, &auth).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    Ok((auth, pool))
}

async fn load_chat(pool: &PgPool, auth: &AuthResult, chat_id: i64) -> RpcResult<ChatDetail> {
    let chat = sqlx::query_as::<_, ChatRow>(
        r#"
        SELECT id, title, created_at, updated_at
        FROM llm_chats
        WHERE id = $1
          AND user_id = $2
        "#,
    )
    .bind(chat_id)
    .bind(user_id(auth)?)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Chat not found"))?;
    let messages = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT id, role, content, created_at
        FROM llm_messages
        WHERE chat_id = $1
        ORDER BY created_at, id
        "#,
    )
    .bind(chat_id)
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    let proposals = sqlx::query_as::<_, ProposalRow>(
        r#"
        SELECT
          id,
          assistant_message_id,
          title,
          summary,
          operations,
          execution_results,
          status,
          review_comment,
          created_at,
          reviewed_at
        FROM llm_change_proposals
        WHERE chat_id = $1
        ORDER BY created_at, id
        "#,
    )
    .bind(chat_id)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    Ok(ChatDetail {
        chat: ChatSummary::from(chat),
        messages: messages.into_iter().map(ChatMessage::from).collect(),
        proposals: proposals.into_iter().map(ChangeProposal::from).collect(),
    })
}

async fn load_recent_turns(pool: &PgPool, chat_id: i64) -> RpcResult<Vec<ChatTurn>> {
    let mut rows: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT role, content
        FROM (
          SELECT id, role, content, created_at
          FROM llm_messages
          WHERE chat_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 40
        ) AS recent
        ORDER BY created_at, id
        "#,
    )
    .bind(chat_id)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    // A provider conversation must start with a user turn.
    while rows.first().is_some_and(|row| row.0 != "user") {
        rows.remove(0);
    }

    Ok(rows
        .into_iter()
        .map(|(role, content)| ChatTurn { role, content })
        .collect())
}

fn chat_title(content: &str) -> String {
    let first_line = content.lines().next().unwrap_or(content).trim();
    let mut title = first_line.chars().take(80).collect::<String>();

    if first_line.chars().count() > 80 {
        title.push('…');
    }

    title
}

fn user_id(auth: &AuthResult) -> RpcResult<i64> {
    auth.user.id.parse::<i64>().map_err(internal)
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateChatInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    title: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatInput {
    chat_id: Id,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
enum AssistantLocale {
    #[default]
    De,
    En,
}

impl AssistantLocale {
    fn as_str(&self) -> &'static str {
        match self {
            Self::De => "de",
            Self::En => "en",
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendMessageInput {
    chat_id: Id,
    content: String,
    #[serde(default)]
    #[ts(optional)]
    locale: Option<AssistantLocale>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewProposalInput {
    proposal_id: Id,
    decision: ProposalDecision,
    #[serde(default)]
    #[ts(optional = nullable)]
    comment: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    execution_results: Option<Vec<ProposalExecutionResult>>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalExecutionResult {
    path: String,
    output: Value,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
enum ProposalDecision {
    Accept,
    Decline,
    RequestRevision,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateSettingsInput {
    provider: ProviderName,
    model: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    base_url: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    api_key: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
enum ProviderName {
    Openai,
    Anthropic,
    Deepseek,
    Custom,
}

impl ProviderName {
    const fn as_str(&self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Deepseek => "deepseek",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateTenantLlmInput {
    name: String,
    enabled: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    monthly_token_quota: Option<i64>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LlmStatus {
    available: bool,
    has_role: bool,
    tenant_enabled: bool,
    provider_configured: bool,
    scan_provider_configured: bool,
    provider: Option<String>,
    model: Option<String>,
    monthly_token_quota: Option<i64>,
    used_tokens: i64,
}

#[derive(Debug, FromRow)]
struct ChatRow {
    id: i64,
    title: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ChatSummary {
    id: Id,
    title: String,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    updated_at: DateTime<Utc>,
}

impl From<ChatRow> for ChatSummary {
    fn from(row: ChatRow) -> Self {
        Self {
            id: Id(row.id),
            title: row.title,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Debug, FromRow)]
struct MessageRow {
    id: i64,
    role: String,
    content: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: Id,
    #[ts(type = "\"user\" | \"assistant\"")]
    role: String,
    content: String,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
}

impl From<MessageRow> for ChatMessage {
    fn from(row: MessageRow) -> Self {
        Self {
            id: Id(row.id),
            role: row.role,
            content: row.content,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, FromRow)]
struct ProposalRow {
    id: i64,
    assistant_message_id: Option<i64>,
    title: String,
    summary: String,
    operations: Value,
    execution_results: Option<Value>,
    status: String,
    review_comment: Option<String>,
    created_at: DateTime<Utc>,
    reviewed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ChangeProposal {
    id: Id,
    assistant_message_id: Option<Id>,
    title: String,
    summary: String,
    operations: Value,
    execution_results: Option<Value>,
    #[ts(type = "\"pending\" | \"declined\" | \"revision_requested\" | \"accepted\"")]
    status: String,
    review_comment: Option<String>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    reviewed_at: Option<DateTime<Utc>>,
}

impl From<ProposalRow> for ChangeProposal {
    fn from(row: ProposalRow) -> Self {
        Self {
            id: Id(row.id),
            assistant_message_id: row.assistant_message_id.map(Id),
            title: row.title,
            summary: row.summary,
            operations: row.operations,
            execution_results: row.execution_results,
            status: row.status,
            review_comment: row.review_comment,
            created_at: row.created_at,
            reviewed_at: row.reviewed_at,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ChatDetail {
    chat: ChatSummary,
    messages: Vec<ChatMessage>,
    proposals: Vec<ChangeProposal>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct GlobalSettings {
    provider: String,
    model: String,
    base_url: Option<String>,
    has_api_key: bool,
    mcp_available: bool,
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
struct TenantLlmSettings {
    name: String,
    enabled: bool,
    monthly_token_quota: Option<i64>,
}

#[derive(Debug, FromRow)]
struct UsageRow {
    tenant_name: String,
    provider: String,
    model: String,
    purpose: String,
    request_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    failed_requests: i64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    tenant: String,
    provider: String,
    model: String,
    purpose: String,
    request_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    failed_requests: i64,
}

impl From<UsageRow> for UsageSummary {
    fn from(row: UsageRow) -> Self {
        Self {
            tenant: row.tenant_name,
            provider: row.provider,
            model: row.model,
            purpose: row.purpose,
            request_count: row.request_count,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            total_tokens: row.total_tokens,
            failed_requests: row.failed_requests,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::chat_title;

    #[test]
    fn chat_titles_are_short_and_use_the_first_line() {
        assert_eq!(
            chat_title("Projektstatus prüfen\nMehr Text"),
            "Projektstatus prüfen"
        );
        assert!(chat_title(&"x".repeat(100)).ends_with('…'));
    }
}
