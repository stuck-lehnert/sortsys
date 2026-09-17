//! ONLYOFFICE AI uses a restricted gateway, never the upstream provider key.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::cors::CorsLayer;
use url::Url;

use crate::{
    AppState,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    rpc::RequestContext,
};

use super::{ONLYOFFICE_USE_CASE, ProviderConfiguration, provider, tenant_llm_options};

const BASE_PATH: &str = "/internal/onlyoffice/ai";
const BRIDGE_GUID: &str = "asc.{A8D34691-265A-41B8-81D0-291963228DD8}";
const AI_GUID: &str = "asc.{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}";
const MODEL_ALIAS: &str = "sortsys-onlyoffice";
const MAX_INPUT_BYTES: usize = 512 * 1024;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route(
            &format!("{BASE_PATH}/plugin/config.json"),
            get(plugin_config),
        )
        .route(&format!("{BASE_PATH}/plugin/index.html"), get(plugin_html))
        .route(&format!("{BASE_PATH}/plugin/bridge.js"), get(plugin_script))
        .route(&format!("{BASE_PATH}/v1/models"), get(models))
        .route(
            &format!("{BASE_PATH}/v1/chat/completions"),
            post(completion),
        )
        .layer(DefaultBodyLimit::max(MAX_INPUT_BYTES + 64 * 1024))
        // Development serves the editor and API on different local ports.
        // No cookies are used; every AI request needs a scoped bearer token.
        .layer(CorsLayer::permissive())
        .with_state(state)
}

pub async fn configure_editor(
    state: &AppState,
    context: &RequestContext,
    auth: &AuthResult,
    config: &mut Value,
) -> RpcResult<()> {
    let Some(settings) = super::public_use_case_configuration(state, ONLYOFFICE_USE_CASE).await?
    else {
        disable_ai(config);
        return Ok(());
    };

    match ensure_access(state, auth).await {
        Ok(()) => {}
        Err(error)
            if matches!(
                error.code,
                ErrorCode::Forbidden | ErrorCode::TooManyRequests
            ) =>
        {
            disable_ai(config);
            return Ok(());
        }
        Err(error) => return Err(error),
    }

    let office = state.config.onlyoffice.as_ref().expect("configured editor");
    let gateway = browser_gateway_url(context, &office.public_url)?;
    let token = state
        .auth
        .issue_office_ai_token(auth)
        .map_err(super::internal)?;
    let name = format!("sortsys ({})", settings.provider);

    // The key below is only a delegation to sortsys. It cannot authenticate
    // with a provider, ordinary RPC procedures, MCP, or global administration.
    let provider_settings = json!({
        "name": name,
        "url": gateway,
        "key": token,
        "addon": "v1"
    });
    let actions = ["Chat", "Summarization", "Translation", "TextAnalyze"]
        .into_iter()
        .map(|action| (action.to_owned(), json!({ "model": MODEL_ALIAS })))
        .collect::<serde_json::Map<_, _>>();

    config["editorConfig"]["plugins"] = json!({
        "autostart": [BRIDGE_GUID, AI_GUID],
        "pluginsData": [format!("{gateway}/plugin/config.json")],
        "options": {
            BRIDGE_GUID: {
                "settings": {
                    "settingsLock": "removed",
                    "actionsOverride": true,
                    "actions": actions,
                    "providers": { "sortsys": provider_settings },
                    "models": [{
                        "id": MODEL_ALIAS,
                        "name": settings.model,
                        "provider": name,
                        "capabilities": 1,
                        "endpoints": [1]
                    }]
                }
            }
        }
    });

    Ok(())
}

fn disable_ai(config: &mut Value) {
    config["editorConfig"]["plugins"] = json!({ "disable": [AI_GUID] });
}

fn browser_gateway_url(context: &RequestContext, office_url: &str) -> RpcResult<String> {
    let header_value = |name: &str| {
        context
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
    };
    let host = header_value("x-forwarded-host")
        .or_else(|| header_value("host"))
        .ok_or_else(|| super::internal("Missing API host"))?;
    let scheme = header_value("x-forwarded-proto").unwrap_or("http");
    let origin = Url::parse(&format!("{scheme}://{host}")).map_err(super::internal)?;

    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
    {
        return Err(super::internal("Invalid public API origin"));
    }

    // The production webapp proxies the API at /api/v2. Development uses
    // an absolute Document Server URL and calls the API port directly.
    let prefix = if office_url.starts_with('/') {
        "/api/v2"
    } else {
        ""
    };
    Ok(format!(
        "{}{prefix}{BASE_PATH}",
        origin.origin().ascii_serialization()
    ))
}

async fn ensure_access(state: &AppState, auth: &AuthResult) -> RpcResult<()> {
    if !auth.can_do(":llm") {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "The :llm role is required",
        ));
    }

    let tenant = state
        .tenants
        .tenant(&auth.tenant)
        .await
        .map_err(super::internal)?
        .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Tenant not found"))?;
    let (enabled, quota) = tenant_llm_options(&tenant.options);

    if !enabled {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "LLM access is disabled for this tenant",
        ));
    }

    if let Some(quota) = quota {
        let used: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(total_tokens), 0)::BIGINT FROM __llm_usage \
             WHERE tenant_name = $1 AND created_at >= DATE_TRUNC('month', NOW())",
        )
        .bind(&auth.tenant)
        .fetch_one(state.tenants.master())
        .await
        .map_err(super::internal)?;

        if used >= quota {
            return Err(RpcError::new(
                ErrorCode::TooManyRequests,
                "The tenant's monthly LLM quota has been reached",
            ));
        }
    }

    Ok(())
}

async fn authenticate(state: &AppState, headers: &HeaderMap) -> RpcResult<AuthResult> {
    let auth = state.auth.authenticate_office_ai(headers).await?;
    ensure_access(state, &auth).await?;
    Ok(auth)
}

async fn models(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let result = async {
        authenticate(&state, &headers).await?;
        let configuration = configured_provider(&state).await?;

        Ok(json!({ "object": "list", "data": [{
            "id": MODEL_ALIAS, "object": "model", "name": configuration.model
        }] }))
    }
    .await;

    json_response(result)
}

#[derive(Debug, Deserialize)]
struct CompletionInput {
    model: String,
    messages: Vec<provider::OfficeMessage>,
    #[serde(default)]
    stream: bool,
}

impl CompletionInput {
    fn validate(&self) -> RpcResult<()> {
        if self.model != MODEL_ALIAS {
            return Err(super::bad_request(
                "Only the configured ONLYOFFICE model may be used",
            ));
        }

        if self.messages.is_empty()
            || self.messages.len() > 256
            || self
                .messages
                .iter()
                .map(|message| message.content.len())
                .sum::<usize>()
                > MAX_INPUT_BYTES
            || self
                .messages
                .iter()
                .any(|message| !matches!(message.role.as_str(), "system" | "user" | "assistant"))
        {
            return Err(super::bad_request("Invalid document conversation"));
        }

        Ok(())
    }
}

async fn completion(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CompletionInput>,
) -> Response {
    let result = async {
        let auth = authenticate(&state, &headers).await?;
        input.validate()?;
        let configuration = configured_provider(&state).await?;
        let answer = provider::office_completion(&configuration, &input.messages).await;
        let usage = answer.as_ref().map(|answer| answer.usage.clone()).unwrap_or_default();

        // Store no document text, prompts or credentials in usage records.
        record_usage(&state, &auth, &configuration, &usage, answer.is_err()).await?;
        let answer = answer?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(super::internal)?;
        let id = format!("office-{}", URL_SAFE_NO_PAD.encode(random));

        if input.stream {
            // ONLYOFFICE expects chat-completions SSE even when the upstream
            // uses Responses or Messages. Do not expose upstream responses.
            let chunk = json!({ "id": id, "object": "chat.completion.chunk",
                "choices": [{ "index": 0, "delta": { "role": "assistant", "content": answer.content }, "finish_reason": null }] });
            let end = json!({ "id": id, "object": "chat.completion.chunk",
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] });
            return Ok(([(header::CONTENT_TYPE, "text/event-stream"), (header::CACHE_CONTROL, "no-store")],
                format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n")).into_response());
        }

        Ok(Json(json!({ "id": id, "object": "chat.completion", "model": MODEL_ALIAS,
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": answer.content }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": usage.input_tokens, "completion_tokens": usage.output_tokens, "total_tokens": usage.total_tokens }
        })).into_response())
    }.await;

    let response = match result {
        Ok(response) => response,
        Err(error) => json_response(Err(error)),
    };

    ([(header::CACHE_CONTROL, "no-store")], response).into_response()
}

async fn configured_provider(state: &AppState) -> RpcResult<ProviderConfiguration> {
    super::load_use_case_configuration(state, ONLYOFFICE_USE_CASE)
        .await?
        .ok_or_else(|| {
            RpcError::new(
                ErrorCode::PreconditionFailed,
                "No ONLYOFFICE LLM provider has been configured",
            )
        })
}

async fn record_usage(
    state: &AppState,
    auth: &AuthResult,
    configuration: &ProviderConfiguration,
    usage: &provider::TokenUsage,
    failed: bool,
) -> RpcResult<()> {
    sqlx::query(
        "INSERT INTO __llm_usage (tenant_name, user_id, purpose, provider, model, \
         input_tokens, output_tokens, total_tokens, status) VALUES ($1, $2, 'onlyoffice', $3, $4, $5, $6, $7, $8)",
    )
    .bind(&auth.tenant)
    .bind(auth.user.id.parse::<i64>().map_err(super::internal)?)
    .bind(&configuration.provider)
    .bind(&configuration.model)
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.total_tokens)
    .bind(if failed { "failed" } else { "succeeded" })
    .execute(state.tenants.master())
    .await
    .map_err(super::internal)?;

    Ok(())
}

fn json_response(result: RpcResult<Value>) -> Response {
    let response = match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let status = match error.code {
                ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
                ErrorCode::Forbidden => StatusCode::FORBIDDEN,
                ErrorCode::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
                ErrorCode::BadRequest => StatusCode::BAD_REQUEST,
                ErrorCode::PreconditionFailed => StatusCode::PRECONDITION_FAILED,
                _ => StatusCode::BAD_GATEWAY,
            };
            (
                status,
                Json(json!({ "error": { "message": error.message, "type": error.code.name() } })),
            )
                .into_response()
        }
    };

    ([(header::CACHE_CONTROL, "no-store")], response).into_response()
}

async fn plugin_config() -> Json<Value> {
    Json(json!({
        "name": "sortsys LLM", "guid": BRIDGE_GUID, "version": "1.0.0",
        "variations": [{ "description": "sortsys LLM", "url": "index.html",
            "EditorsSupport": ["word", "cell", "slide", "pdf"],
            "isViewer": true, "type": "background", "initDataType": "none", "buttons": [],
            "events": ["ai_onInit"] }]
    }))
}

async fn plugin_html(State(state): State<Arc<AppState>>) -> Response {
    let Some(office) = &state.config.onlyoffice else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let sdk_url = format!("{}/sdkjs-plugins/v1/plugins.js", office.public_url)
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");

    Html(format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>sortsys LLM</title>\
        <script src=\"{sdk_url}\"></script><script src=\"bridge.js\"></script></head><body></body></html>"))
        .into_response()
}

async fn plugin_script() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("office_bridge.js"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_arbitrary_models_roles_and_large_conversations() {
        let mut input: CompletionInput = serde_json::from_value(json!({
            "model": MODEL_ALIAS, "messages": [{ "role": "user", "content": "Summarize this document." }]
        })).unwrap();
        assert!(input.validate().is_ok());
        input.model = "expensive-unapproved-model".to_owned();
        assert!(input.validate().is_err());
        input.model = MODEL_ALIAS.to_owned();
        input.messages[0].role = "tool".to_owned();
        assert!(input.validate().is_err());
        input.messages[0].role = "user".to_owned();
        input.messages[0].content = "x".repeat(MAX_INPUT_BYTES + 1);
        assert!(input.validate().is_err());
    }

    #[test]
    fn public_gateway_handles_production_subpaths_and_development_ports() {
        let mut context = RequestContext {
            headers: HeaderMap::new(),
        };
        context
            .headers
            .insert("host", "app.example.test".parse().unwrap());
        context
            .headers
            .insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(
            browser_gateway_url(&context, "/office").unwrap(),
            "https://app.example.test/api/v2/internal/onlyoffice/ai"
        );
        context
            .headers
            .insert("host", "localhost:3000".parse().unwrap());
        context.headers.remove("x-forwarded-proto");
        assert_eq!(
            browser_gateway_url(&context, "http://localhost:39180").unwrap(),
            "http://localhost:3000/internal/onlyoffice/ai"
        );
    }
}
