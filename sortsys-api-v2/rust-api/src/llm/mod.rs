//! LLM configuration, provider access, MCP transport, and safe data tools.

mod provider;
mod schema;

use std::sync::Arc;

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue},
    routing::post,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

use crate::{
    AppState,
    auth::AuthResult,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    rpc::{ProcedureKind, RequestContext},
};

pub use provider::{ChatTurn, Completion, TokenUsage, complete};

pub(crate) const PROPOSAL_ONLY_MARKER: &str = "<proposal-only>";

const SYSTEM_PROMPT_DE: &str = r#"
Du bist der Arbeitsassistent in sortsys.
Antworte kurz, präzise und professionell auf Deutsch.
Nutze die bereitgestellten Werkzeuge, wenn du aktuelle Daten benötigst.
Du kannst alle fachlichen Daten lesen, die der angemeldete Benutzer auch über die
sortsys-API lesen darf. Verwende sortsys_find_procedures, um den passenden RPC-Pfad zu
finden, sortsys_get_schema für dessen exaktes Schema und sortsys_query für den
berechtigungsgeprüften Lesezugriff. Rate niemals Feldnamen oder Daten auf Basis früherer
Antworten. Gemeinkosten liegen beispielsweise unter settings.costs.get.
Die kompakten sortsys_search-Ressourcen sind für häufige, bereichsübergreifende Suchen
gedacht; sortsys_query erschließt den vollständigen fachlichen API-Vertrag.
Behandle Wörter wie „alles“, „insgesamt“ und offene Fragen nach heutigen
Baustellenaktivitäten als Aufforderung, alle naheliegenden Quellen zu prüfen. Dazu gehören
mindestens Tagesberichte, Regieberichte und Lieferscheine. Fasse die Ergebnisse gemeinsam
zusammen, statt auf einzelne Nachfragen zu warten. Lies bei Lieferscheinen auch die
Positionen und bei Berichten die vorhandenen Inhalte. Nutze für vollständige Zeiträume die
passenden Listenabfragen über sortsys_query; ein begrenztes Suchergebnis ist kein Beleg
dafür, dass keine weiteren Einträge existieren. Behalte bei kurzen Anschlussfragen wie
„und der Lieferschein?“ den Zeitraum und Sachbezug der vorherigen Nachricht bei.
Bei Fragen zu Projektkosten, Angeboten, Rechnungen oder Projektergebnissen musst du
sortsys_search mit der Ressource project_costs aufrufen. Die Ressource projects enthält
keine Finanzdaten und ist dafür kein Ersatz.
Bei Fragen nach dem aktuellen Werkzeug einer Person oder nach laufenden
Werkzeugzuordnungen musst du sortsys_search mit der Ressource tool_trackings aufrufen.
Die Ressource tools enthält den Werkzeugstamm, aber keine verlässliche Aussage über die
aktuell verantwortliche Person.
Bei Fragen zu Werkzeug-Inventuren musst du sortsys_search mit der Ressource
tool_inventories aufrufen. Verwende hadInventory und days, wenn geprüft werden soll,
welche Werkzeuge innerhalb eines Zeitraums erfasst oder nicht erfasst wurden.
Behaupte nicht, Daten gelesen oder geändert zu haben, wenn kein Werkzeug dies bestätigt.
Schreibzugriffe sind verboten. Wenn eine Änderung sinnvoll ist, erstelle ausschließlich
einen Vorschlag mit sortsys_propose_change. Der Benutzer sieht ihn als Vorschau und
entscheidet selbst. Verwende für Vorschläge ausschließlich die exakten RPC-Pfade aus dem
Schema von sortsys_propose_change, niemals URL-Pfade. Wenn ein Werkzeug einen korrigierbaren
Fehler meldet, berichtige die Argumente und rufe es erneut auf.
Rufe vor sortsys_propose_change für jeden verwendeten RPC-Pfad sortsys_get_schema auf.
Übernimm Feldnamen, Verschachtelung und Datentypen exakt aus dessen inputSchema.
Frage knapp nach, wenn wesentliche Angaben fehlen.
Wenn eine Anfrage ausschließlich einen Änderungsvorschlag verlangt, antworte nach dem
erfolgreichen Speichern des Vorschlags exakt mit <proposal-only>. Wiederhole weder Titel,
Zusammenfassung noch einzelne Änderungen und weise nicht darauf hin, dass sie noch nicht
ausgeführt wurden. Verlangt die Anfrage zusätzlich eine Auskunft, beantworte nur diesen
zusätzlichen Teil nach dem Speichern des Vorschlags.
"#;

const SYSTEM_PROMPT_EN: &str = r#"
You are the work assistant in sortsys.
Answer briefly, precisely, and professionally in English.
Use the available tools whenever current data is needed.
You may read all business data available to the signed-in user through the sortsys API.
Use sortsys_find_procedures to find the exact RPC path, sortsys_get_schema to inspect its
schema, and sortsys_query for permission-checked reads. Never guess fields or current data.
Common overhead costs are available through settings.costs.get.
Use sortsys_search with project_costs for project costs, offers, invoices, or project
results. Use tool_trackings for current tool assignments and tool_inventories for
inventory history or coverage. Do not claim to have read or changed data unless a tool
confirmed it.
Treat words such as “all” or “overall” and broad questions about current-day construction-site
activity as requests to check every relevant source. This includes at least daily reports,
regie reports, and delivery notes. Return one combined answer instead of waiting for the
user to ask about each category. Read delivery-note line items and report contents as well.
For complete periods, use the corresponding list queries through sortsys_query; a limited
search result does not prove that no more records exist. Preserve the period and subject
of the previous message in short follow-up questions.
Never execute writes. Create changes only through sortsys_propose_change so the user can
review them. Use exact RPC mutation paths, never URL paths. Before proposing an operation,
call sortsys_get_schema and match its field names, nesting, and types exactly. Correct
recoverable tool errors and retry. Ask a short follow-up question when essential details
are missing.
If a request only requires a change proposal, respond with exactly <proposal-only> after
the proposal was saved. Do not repeat its title, summary, or operations, and do not state
that it has not been executed. If the user also requested information, answer only that
additional part after saving the proposal.
"#;

#[derive(Debug, Clone)]
pub struct ProviderConfiguration {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProviderConfiguration {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub has_api_key: bool,
    pub mcp_available: bool,
}

pub fn mcp_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/internal/llm/mcp", post(handle_mcp))
        .with_state(state)
}

pub fn system_prompt(locale: &str) -> &'static str {
    if locale == "en" {
        SYSTEM_PROMPT_EN.trim()
    } else {
        SYSTEM_PROMPT_DE.trim()
    }
}

pub async fn load_configuration(state: &AppState) -> RpcResult<Option<ProviderConfiguration>> {
    let row = sqlx::query(
        r#"
        SELECT provider, model, base_url, api_key_ciphertext
        FROM __llm_settings
        WHERE singleton
        "#,
    )
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?;

    let Some(row) = row else {
        return Ok(None);
    };

    let ciphertext: String = row.try_get("api_key_ciphertext").map_err(internal)?;
    let api_key = decrypt_secret(state, &ciphertext)?;

    Ok(Some(ProviderConfiguration {
        provider: row.try_get("provider").map_err(internal)?,
        model: row.try_get("model").map_err(internal)?,
        base_url: row.try_get("base_url").map_err(internal)?,
        api_key,
    }))
}

pub async fn public_configuration(
    state: &AppState,
) -> RpcResult<Option<PublicProviderConfiguration>> {
    let row = sqlx::query(
        r#"
        SELECT provider, model, base_url, api_key_ciphertext
        FROM __llm_settings
        WHERE singleton
        "#,
    )
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?;

    let Some(row) = row else {
        return Ok(None);
    };

    let provider: String = row.try_get("provider").map_err(internal)?;

    Ok(Some(PublicProviderConfiguration {
        mcp_available: state.config.llm_mcp_url.is_some()
            && matches!(provider.as_str(), "openai" | "anthropic"),
        provider,
        model: row.try_get("model").map_err(internal)?,
        base_url: row.try_get("base_url").map_err(internal)?,
        has_api_key: row
            .try_get::<String, _>("api_key_ciphertext")
            .is_ok_and(|value| !value.is_empty()),
    }))
}

pub async fn save_configuration(
    state: &AppState,
    provider: &str,
    model: &str,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> RpcResult<()> {
    validate_provider(provider)?;

    if model.trim().is_empty() || model.len() > 255 {
        return Err(bad_request(
            "model must contain between 1 and 255 characters",
        ));
    }

    let existing_ciphertext: Option<String> =
        sqlx::query_scalar("SELECT api_key_ciphertext FROM __llm_settings WHERE singleton")
            .fetch_optional(state.tenants.master())
            .await
            .map_err(internal)?;

    let ciphertext = match api_key.map(str::trim).filter(|value| !value.is_empty()) {
        Some(api_key) => encrypt_secret(state, api_key)?,
        None => existing_ciphertext.ok_or_else(|| bad_request("missing apiKey"))?,
    };

    sqlx::query(
        r#"
        INSERT INTO __llm_settings (
          singleton,
          provider,
          model,
          base_url,
          api_key_ciphertext,
          updated_at
        )
        VALUES (TRUE, $1, $2, $3, $4, NOW())
        ON CONFLICT (singleton) DO UPDATE SET
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          base_url = EXCLUDED.base_url,
          api_key_ciphertext = EXCLUDED.api_key_ciphertext,
          updated_at = NOW()
        "#,
    )
    .bind(provider)
    .bind(model.trim())
    .bind(base_url.map(str::trim).filter(|value| !value.is_empty()))
    .bind(ciphertext)
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

pub fn tenant_llm_options(tenant_options: &Value) -> (bool, Option<i64>) {
    let enabled = tenant_options
        .pointer("/llm/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let monthly_token_quota = tenant_options
        .pointer("/llm/monthlyTokenQuota")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0);

    (enabled, monthly_token_quota)
}

pub async fn ensure_user_access(state: &AppState, auth: &AuthResult) -> RpcResult<Option<i64>> {
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
        .map_err(internal)?
        .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "Tenant not found"))?;
    let (enabled, quota) = tenant_llm_options(&tenant.options);

    if !enabled {
        return Err(RpcError::new(
            ErrorCode::Forbidden,
            "LLM access is disabled for this tenant",
        ));
    }

    if load_configuration(state).await?.is_none() {
        return Err(RpcError::new(
            ErrorCode::PreconditionFailed,
            "No LLM provider has been configured",
        ));
    }

    if let Some(quota) = quota {
        let used: i64 = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(total_tokens), 0)::BIGINT
            FROM __llm_usage
            WHERE tenant_name = $1
              AND created_at >= DATE_TRUNC('month', NOW())
            "#,
        )
        .bind(&auth.tenant)
        .fetch_one(state.tenants.master())
        .await
        .map_err(internal)?;

        if used >= quota {
            return Err(RpcError::new(
                ErrorCode::TooManyRequests,
                "The tenant's monthly LLM quota has been reached",
            ));
        }
    }

    Ok(quota)
}

pub async fn record_usage(
    state: &AppState,
    auth: &AuthResult,
    chat_id: i64,
    configuration: &ProviderConfiguration,
    usage: &TokenUsage,
    error: Option<&str>,
) -> RpcResult<()> {
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    sqlx::query(
        r#"
        INSERT INTO __llm_usage (
          tenant_name,
          user_id,
          chat_id,
          provider,
          model,
          input_tokens,
          output_tokens,
          total_tokens,
          status,
          error
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
    )
    .bind(&auth.tenant)
    .bind(user_id)
    .bind(chat_id)
    .bind(&configuration.provider)
    .bind(&configuration.model)
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.total_tokens)
    .bind(if error.is_some() {
        "failed"
    } else {
        "succeeded"
    })
    .bind(error)
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

pub fn tool_definitions() -> Vec<Value> {
    let mutations = proposable_mutations();

    vec![
        json!({
            "name": "sortsys_search",
            "description": "Search current sortsys records visible to the signed-in user. Use project_costs for current net project costs, tool_trackings for active tool assignments, and tool_inventories for inventory history or period coverage; leave query empty for an overview.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "resource": {
                        "type": "string",
                        "enum": [
                            "projects",
                            "project_costs",
                            "deployments",
                            "vacations",
                            "daily_reports",
                            "regie_reports",
                            "delivery_notes",
                            "customers",
                            "contacts",
                            "products",
                            "tools",
                            "tool_trackings",
                            "tool_inventories",
                            "users"
                        ]
                    },
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 25 },
                    "days": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 3650,
                        "description": "Inventory period in days; only used with resource tool_inventories and hadInventory."
                    },
                    "hadInventory": {
                        "type": "boolean",
                        "description": "For tool_inventories, select tools that were or were not inventoried within days. Omit to search individual inventory records."
                    }
                },
                "required": ["resource"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "sortsys_find_procedures",
            "description": "Discover exact sortsys RPC paths without putting the full contract into every prompt. Search with German or English domain terms such as Gemeinkosten, Urlaub, Einsatzplanung, Inventur, projects, costs, users, or tools. An empty query returns every user-facing procedure.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "maxLength": 120
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["query", "mutation"]
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "sortsys_get_schema",
            "description": "Return the complete authoritative JSON input and output schema for one exact sortsys RPC procedure. Call this before proposing an operation and copy its input field names and nesting exactly.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "description": "Exact RPC procedure path, for example projects.create"
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "sortsys_query",
            "description": "Execute one exact user-facing RPC query with the signed-in user's tenant, session, and permissions. First discover its path and request its schema. This tool cannot execute mutations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                    },
                    "input": {
                        "type": "object",
                        "description": "Plain JSON matching the procedure inputSchema exactly. Omit for void input."
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "sortsys_propose_change",
            "description": "Prepare changes for user review. This never executes a write. First call sortsys_get_schema for every operation path, then match its inputSchema exactly. Every path must be an exact RPC mutation name; URL paths such as /projects are invalid.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "maxLength": 160 },
                    "summary": { "type": "string", "maxLength": 2000 },
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 10,
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {
                                    "type": "string",
                                    "enum": mutations
                                },
                                "input": { "type": "object" },
                                "description": { "type": "string", "maxLength": 500 }
                            },
                            "required": ["path", "input", "description"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["title", "summary", "operations"],
                "additionalProperties": false
            }
        }),
    ]
}

pub async fn execute_tool(
    state: &AppState,
    auth: &AuthResult,
    chat_id: i64,
    name: &str,
    arguments: Value,
) -> RpcResult<Value> {
    ensure_user_access(state, auth).await?;

    match name {
        "sortsys_search" => search_records(state, auth, arguments).await,
        "sortsys_find_procedures" => find_procedures(arguments),
        "sortsys_get_schema" => get_procedure_schema(arguments),
        "sortsys_query" => query_procedure(state, auth, arguments).await,
        "sortsys_propose_change" => create_proposal(state, auth, chat_id, arguments).await,
        _ => Err(bad_request("unknown LLM tool")),
    }
}

fn find_procedures(arguments: Value) -> RpcResult<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let requested_kind = match arguments.get("kind").and_then(Value::as_str) {
        Some("query") => Some(ProcedureKind::Query),
        Some("mutation") => Some(ProcedureKind::Mutation),
        Some(_) => return Err(bad_request("invalid procedure kind")),
        None => None,
    };
    let search_terms = procedure_search_terms(&query);

    let procedures = crate::contract_generated::FULL_CONTRACT
        .iter()
        .filter(|specification| is_user_facing_procedure(specification.path))
        .filter(|specification| requested_kind.is_none_or(|kind| specification.kind == kind))
        .filter(|specification| {
            query.is_empty()
                || search_terms
                    .iter()
                    .any(|term| specification.path.to_lowercase().contains(term))
        })
        .map(|specification| {
            json!({
                "path": specification.path,
                "kind": procedure_kind_name(specification.kind)
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "procedures": procedures,
        "hint": "Call sortsys_get_schema with one exact path before sortsys_query or sortsys_propose_change."
    }))
}

fn procedure_search_terms(query: &str) -> Vec<String> {
    let mut terms = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.len() >= 3)
        .map(str::to_owned)
        .collect::<Vec<_>>();

    for (needle, aliases) in [
        ("gemeinkosten", &["settings.costs", "costs"][..]),
        ("overhead", &["settings.costs", "costs"][..]),
        ("urlaub", &["vacations"][..]),
        ("einsatzplanung", &["deployments"][..]),
        ("inventur", &["inventories"][..]),
        ("werkzeugzuordnung", &["trackings"][..]),
        ("regiebericht", &["regiereports"][..]),
        ("lieferschein", &["deliverynotes"][..]),
        ("tagesbericht", &["dailyreports"][..]),
        ("kunde", &["customers"][..]),
        ("kontakt", &["contacts"][..]),
        ("artikel", &["products"][..]),
        ("projekt", &["projects"][..]),
        ("benutzer", &["users"][..]),
        ("werkzeug", &["tools"][..]),
    ] {
        if query.contains(needle) {
            terms.extend(aliases.iter().map(|alias| (*alias).to_owned()));
        }
    }

    terms
}

async fn query_procedure(
    state: &AppState,
    auth: &AuthResult,
    arguments: Value,
) -> RpcResult<Value> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| bad_request("missing path"))?;
    let specification = contract_specification(path)?;

    if specification.kind != ProcedureKind::Query || !is_user_facing_procedure(path) {
        return Err(bad_request(format!(
            "query {path} is not available to the assistant"
        )));
    }

    let input = arguments.get("input").cloned().unwrap_or(Value::Null);
    schema::validate(specification.input_ts, &input)
        .map_err(|message| bad_request(format!("{path}: {message}")))?;

    // Dispatch through the ordinary API handler with a short-lived token for
    // the same tenant and session. Every existing role check remains active.
    let token = state
        .auth
        .issue_internal_user_token(auth)
        .map_err(internal)?;
    let authorization = HeaderValue::from_str(&format!("Bearer {token}")).map_err(internal)?;
    let mut headers = HeaderMap::new();
    headers.insert(axum::http::header::AUTHORIZATION, authorization);

    let registry = crate::api::registry(Arc::new(state.clone()));
    let data = registry
        .execute_query(path, RequestContext { headers }, input)
        .await?;

    Ok(json!({
        "path": path,
        "data": data
    }))
}

fn get_procedure_schema(arguments: Value) -> RpcResult<Value> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| bad_request("missing path"))?;
    let specification = contract_specification(path)?;
    if !is_user_facing_procedure(path) {
        return Err(bad_request(format!(
            "procedure {path} is not available to the assistant"
        )));
    }
    let kind = match specification.kind {
        crate::rpc::ProcedureKind::Query => "query",
        crate::rpc::ProcedureKind::Mutation => "mutation",
    };
    let input_schema = schema::json_schema(specification.input_ts).map_err(internal)?;
    let output_schema = schema::json_schema(specification.output_ts).map_err(internal)?;

    Ok(json!({
        "path": specification.path,
        "kind": kind,
        "notation": "JSON Schema",
        "inputSchema": input_schema,
        "outputSchema": output_schema,
        "inputType": specification.input_ts,
        "outputType": specification.output_ts
    }))
}

fn contract_specification(path: &str) -> RpcResult<&'static crate::rpc::RawContractSpec> {
    crate::contract_generated::FULL_CONTRACT
        .iter()
        .find(|specification| specification.path == path)
        .ok_or_else(|| bad_request(format!("unknown RPC procedure {path}")))
}

fn procedure_kind_name(kind: ProcedureKind) -> &'static str {
    match kind {
        ProcedureKind::Query => "query",
        ProcedureKind::Mutation => "mutation",
    }
}

fn is_user_facing_procedure(path: &str) -> bool {
    ![
        "admin.",
        "auth.",
        "errorReports.",
        "llm.",
        "passkeys.",
        "personalization.",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

fn proposable_mutations() -> Vec<&'static str> {
    crate::contract_generated::FULL_CONTRACT
        .iter()
        .filter(|specification| specification.kind == ProcedureKind::Mutation)
        .filter(|specification| is_user_facing_procedure(specification.path))
        .map(|specification| specification.path)
        .collect()
}

fn validate_proposal_input(path: &str, input: &Value) -> RpcResult<()> {
    let specification = contract_specification(path)?;

    schema::validate(specification.input_ts, input)
        .map_err(|message| bad_request(format!("{path}: {message}")))
}

async fn search_records(state: &AppState, auth: &AuthResult, arguments: Value) -> RpcResult<Value> {
    let resource = arguments
        .get("resource")
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request("missing resource"))?;
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let default_limit = if resource == "project_costs" { 25 } else { 10 };
    let limit = arguments
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(default_limit)
        .clamp(1, 25);
    let inventory_days = arguments.get("days").and_then(Value::as_i64).unwrap_or(30);

    if !(1..=3_650).contains(&inventory_days) {
        return Err(bad_request("invalid inventory days"));
    }

    let had_inventory = arguments.get("hadInventory").and_then(Value::as_bool);

    if resource == "project_costs" {
        return search_project_costs(state, auth, query, limit).await;
    }

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    match resource {
        "projects" => {
            require_role(auth, "view:projects")?;
            rows_as_json(
                &pool,
                "SELECT id, title, address, finished_at FROM projects WHERE $1 = '' OR _search @@ websearch_to_tsquery('simple', $1) ORDER BY modified_at DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "deployments" => {
            require_role(auth, "view:projectDeployments")?;
            rows_as_json(
                &pool,
                "SELECT deployment.id, deployment.project_id, deployment.user_id, deployment.\"from\", deployment.\"to\", deployment.note, project.title AS project_title, user_account.first_name, user_account.last_name FROM project_deployments AS deployment JOIN projects AS project ON project.id = deployment.project_id JOIN users AS user_account ON user_account.id = deployment.user_id WHERE $1 = '' OR LOWER(CONCAT_WS(' ', project.title, user_account.first_name, user_account.last_name, deployment.note)) LIKE '%' || LOWER($1) || '%' ORDER BY deployment.\"from\" DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "vacations" => {
            require_role(auth, "view:userVacations")?;
            rows_as_json(
                &pool,
                "SELECT vacation.id, vacation.user_id, vacation.\"from\", vacation.\"to\", vacation.status, vacation.note, user_account.first_name, user_account.last_name FROM user_vacations AS vacation JOIN users AS user_account ON user_account.id = vacation.user_id WHERE $1 = '' OR LOWER(CONCAT_WS(' ', user_account.first_name, user_account.last_name, vacation.note, vacation.status)) LIKE '%' || LOWER($1) || '%' ORDER BY vacation.\"from\" DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "daily_reports" => {
            require_role(auth, "view:dailyProjectReports")?;
            rows_as_json(
                &pool,
                "SELECT report.id, report.project_id, report.day, report.summary, report.weather, project.title AS project_title FROM daily_project_reports AS report JOIN projects AS project ON project.id = report.project_id WHERE $1 = '' OR LOWER(CONCAT_WS(' ', project.title, report.summary)) LIKE '%' || LOWER($1) || '%' ORDER BY report.day DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "regie_reports" => {
            require_role(auth, "view:regieReports")?;
            rows_as_json(
                &pool,
                "SELECT report.id, report.project_id, report.day, report.summary, project.title AS project_title FROM regie_reports AS report JOIN projects AS project ON project.id = report.project_id WHERE $1 = '' OR LOWER(CONCAT_WS(' ', project.title, report.summary)) LIKE '%' || LOWER($1) || '%' ORDER BY report.day DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "delivery_notes" => {
            require_role(auth, "view:deliveryNotes")?;
            rows_as_json(
                &pool,
                "SELECT note.id, note.auto_id, note.project_id, note.effective_timestamp, note.comment, project.title AS project_title FROM product_delivery_notes AS note JOIN projects AS project ON project.id = note.project_id WHERE $1 = '' OR LOWER(CONCAT_WS(' ', note.auto_id::TEXT, project.title, note.comment)) LIKE '%' || LOWER($1) || '%' ORDER BY note.effective_timestamp DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "customers" => {
            require_role(auth, "view:customers")?;
            rows_as_json(
                &pool,
                "SELECT id, name, address FROM customers WHERE $1 = '' OR _search @@ websearch_to_tsquery('simple', $1) ORDER BY modified_at DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "contacts" => {
            require_role(auth, "view:contacts")?;
            rows_as_json(
                &pool,
                "SELECT id, first_name, last_name, phone_numbers, email_addresses FROM contacts WHERE $1 = '' OR _search @@ websearch_to_tsquery('simple', $1) ORDER BY modified_at DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "products" => {
            require_role(auth, "view:products")?;
            rows_as_json(
                &pool,
                "SELECT id, custom_id, name, brand, description, base_unit FROM products WHERE $1 = '' OR _search @@ websearch_to_tsquery('simple', $1) ORDER BY modified_at DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "tools" => {
            require_role(auth, "view:tools")?;
            rows_as_json(
                &pool,
                "SELECT id, custom_id, brand, category, label, status FROM tools WHERE $1 = '' OR _search @@ websearch_to_tsquery('simple', $1) ORDER BY modified_at DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        "tool_trackings" => {
            require_role(auth, "view:toolTrackings")?;

            search_active_tool_trackings(&pool, query, limit).await
        }
        "tool_inventories" => {
            require_role(auth, "view:toolInventories")?;

            search_tool_inventories(&pool, query, limit, inventory_days, had_inventory).await
        }
        "users" => {
            require_role(auth, "view:users")?;
            rows_as_json(
                &pool,
                "SELECT id, username, first_name, last_name, email, contract_type FROM users WHERE $1 = '' OR LOWER(CONCAT_WS(' ', username, first_name, last_name, email)) LIKE '%' || LOWER($1) || '%' ORDER BY modified_at DESC LIMIT $2",
                query,
                limit,
            )
            .await
        }
        _ => Err(bad_request("unsupported resource")),
    }
}

const ACTIVE_TOOL_TRACKINGS_SEARCH: &str = r#"
SELECT
  tracking.id,
  tracking.tool_id,
  tool.custom_id AS tool_custom_id,
  tool.brand AS tool_brand,
  tool.category AS tool_category,
  tool.label AS tool_label,
  tracking.responsible_user_id,
  responsible_user.first_name AS responsible_first_name,
  responsible_user.last_name AS responsible_last_name,
  tracking.project_id,
  project.title AS project_title,
  tracking.comment,
  tracking.started_at,
  tracking.deadline_at
FROM tool_trackings AS tracking
JOIN tools AS tool ON tool.id = tracking.tool_id
LEFT JOIN users AS responsible_user
  ON responsible_user.id = tracking.responsible_user_id
LEFT JOIN projects AS project ON project.id = tracking.project_id
WHERE tracking.ended_at IS NULL
  AND (
    $1 = ''
    OR LOWER(CONCAT_WS(
      ' ',
      tool.custom_id::TEXT,
      tool.brand,
      tool.category,
      tool.label,
      responsible_user.first_name,
      responsible_user.last_name,
      project.title,
      tracking.comment
    )) LIKE '%' || LOWER($1) || '%'
  )
ORDER BY tracking.started_at DESC
LIMIT $2
"#;

async fn search_active_tool_trackings(pool: &PgPool, query: &str, limit: i64) -> RpcResult<Value> {
    rows_as_json(pool, ACTIVE_TOOL_TRACKINGS_SEARCH, query, limit).await
}
async fn search_tool_inventories(
    pool: &PgPool,
    query: &str,
    limit: i64,
    days: i64,
    had_inventory: Option<bool>,
) -> RpcResult<Value> {
    let Some(had_inventory) = had_inventory else {
        return rows_as_json(
            pool,
            r#"
            SELECT
              inventory.id,
              inventory.tool_id,
              tool.custom_id AS tool_custom_id,
              tool.brand AS tool_brand,
              tool.category AS tool_category,
              tool.label AS tool_label,
              inventory.comment,
              inventory.created_at
            FROM tool_inventories AS inventory
            JOIN tools AS tool ON tool.id = inventory.tool_id
            WHERE
              $1 = ''
              OR LOWER(CONCAT_WS(
                ' ',
                tool.custom_id::TEXT,
                tool.brand,
                tool.category,
                tool.label,
                inventory.comment
              )) LIKE '%' || LOWER($1) || '%'
            ORDER BY inventory.created_at DESC, inventory.id DESC
            LIMIT $2
            "#,
            query,
            limit,
        )
        .await;
    };

    let rows: Vec<Value> = sqlx::query_scalar(
        r#"
        SELECT TO_JSONB(record)
        FROM (
          SELECT
            tool.id AS tool_id,
            tool.custom_id AS tool_custom_id,
            tool.brand AS tool_brand,
            tool.category AS tool_category,
            tool.label AS tool_label,
            tool.status AS tool_status,
            tool.archived_since,
            latest_inventory.created_at AS last_inventory_at,
            latest_inventory.comment AS last_inventory_comment,
            active_tracking.id IS NULL AS available,
            latest_tracking.responsible_user_id,
            responsible_user.first_name AS responsible_first_name,
            responsible_user.last_name AS responsible_last_name
          FROM tools AS tool
          LEFT JOIN LATERAL (
            SELECT inventory.created_at, inventory.comment
            FROM tool_inventories AS inventory
            WHERE inventory.tool_id = tool.id
            ORDER BY inventory.created_at DESC, inventory.id DESC
            LIMIT 1
          ) AS latest_inventory ON TRUE
          LEFT JOIN LATERAL (
            SELECT tracking.responsible_user_id
            FROM tool_trackings AS tracking
            WHERE tracking.tool_id = tool.id
            ORDER BY tracking.started_at DESC, tracking.id DESC
            LIMIT 1
          ) AS latest_tracking ON TRUE
          LEFT JOIN users AS responsible_user
            ON responsible_user.id = latest_tracking.responsible_user_id
          LEFT JOIN LATERAL (
            SELECT tracking.id
            FROM tool_trackings AS tracking
            WHERE tracking.tool_id = tool.id
              AND tracking.ended_at IS NULL
            LIMIT 1
          ) AS active_tracking ON TRUE
          WHERE $4 = EXISTS (
            SELECT 1
            FROM tool_inventories AS recent_inventory
            WHERE recent_inventory.tool_id = tool.id
              AND recent_inventory.created_at >= NOW() - ($3::int * INTERVAL '1 day')
          )
            AND (
              $1 = ''
              OR LOWER(CONCAT_WS(
                ' ',
                tool.custom_id::TEXT,
                tool.brand,
                tool.category,
                tool.label,
                responsible_user.first_name,
                responsible_user.last_name
              )) LIKE '%' || LOWER($1) || '%'
            )
          ORDER BY tool.custom_id
          LIMIT $2
        ) AS record
        "#,
    )
    .bind(query)
    .bind(limit)
    .bind(days)
    .bind(had_inventory)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    let records = rows
        .into_iter()
        .map(encode_row_ids)
        .collect::<RpcResult<Vec<_>>>()?;

    Ok(json!({
        "days": days,
        "hadInventory": had_inventory,
        "records": records
    }))
}

async fn search_project_costs(
    state: &AppState,
    auth: &AuthResult,
    query: &str,
    limit: i64,
) -> RpcResult<Value> {
    let overview = crate::procedures::project_cost_overview_for_authenticated_user(
        state,
        auth,
        json!({ "status": "active" }),
    )
    .await?;

    project_cost_summary(overview, query, limit)
}

fn project_cost_summary(overview: Value, query: &str, limit: i64) -> RpcResult<Value> {
    let projects = overview
        .as_array()
        .ok_or_else(|| internal("project cost overview returned an invalid result"))?;
    let normalized_query = query.to_lowercase();
    let matching_projects = projects
        .iter()
        .filter(|project| {
            normalized_query.is_empty()
                || project
                    .get("title")
                    .and_then(Value::as_str)
                    .is_some_and(|title| title.to_lowercase().contains(&normalized_query))
        })
        .collect::<Vec<_>>();

    let amount =
        |project: &Value, field: &str| project.get(field).and_then(Value::as_f64).unwrap_or(0.0);
    let costs = matching_projects
        .iter()
        .map(|project| amount(project, "costs"))
        .sum::<f64>();
    let offers_total = matching_projects
        .iter()
        .map(|project| amount(project, "offersTotal"))
        .sum::<f64>();
    let invoices_total = matching_projects
        .iter()
        .map(|project| amount(project, "invoicesTotal"))
        .sum::<f64>();
    let project_count = matching_projects.len();
    let records = matching_projects
        .into_iter()
        .take(limit as usize)
        .cloned()
        .collect::<Vec<_>>();

    Ok(json!({
        "currency": "EUR",
        "amountsAreNet": true,
        "scope": "activeProjects",
        "projectCount": project_count,
        "recordsTruncated": records.len() < project_count,
        "totals": {
            "costs": costs,
            "offersTotal": offers_total,
            "invoicesTotal": invoices_total,
            "invoiceBalance": invoices_total - costs
        },
        "records": records
    }))
}

async fn rows_as_json(pool: &PgPool, sql: &str, query: &str, limit: i64) -> RpcResult<Value> {
    let rows: Vec<Value> =
        sqlx::query_scalar(&format!("SELECT TO_JSONB(record) FROM ({sql}) AS record"))
            .bind(query)
            .bind(limit)
            .fetch_all(pool)
            .await
            .map_err(internal)?;

    let rows = rows
        .into_iter()
        .map(encode_row_ids)
        .collect::<RpcResult<Vec<_>>>()?;

    Ok(json!({ "records": rows }))
}

fn encode_row_ids(mut row: Value) -> RpcResult<Value> {
    if let Some(object) = row.as_object_mut() {
        for (key, value) in object {
            if (key == "id" || key.ends_with("_id"))
                && let Some(raw_id) = value.as_i64()
            {
                *value = Value::String(Id(raw_id).encode());
            }
        }
    }

    Ok(row)
}

async fn create_proposal(
    state: &AppState,
    auth: &AuthResult,
    chat_id: i64,
    arguments: Value,
) -> RpcResult<Value> {
    let title = required_text(&arguments, "title", 160)?;
    let summary = required_text(&arguments, "summary", 2_000)?;
    let operations = arguments
        .get("operations")
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request("missing operations"))?;

    if operations.is_empty() || operations.len() > 10 {
        return Err(bad_request(
            "operations must contain between 1 and 10 entries",
        ));
    }

    for operation in operations {
        let path = operation
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| bad_request("operation is missing path"))?;

        if !is_proposable_mutation(path) {
            return Err(bad_request(format!(
                "mutation {path} cannot be proposed by the assistant"
            )));
        }

        let input = operation
            .get("input")
            .filter(|input| input.is_object())
            .ok_or_else(|| bad_request("operation input must be an object"))?;

        validate_proposal_input(path, input)?;
        required_text(operation, "description", 500)?;
    }

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    ensure_chat_owner(&pool, chat_id, user_id).await?;

    let proposal_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO llm_change_proposals (chat_id, title, summary, operations)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        "#,
    )
    .bind(chat_id)
    .bind(title)
    .bind(summary)
    .bind(arguments.get("operations").cloned().unwrap_or(Value::Null))
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({
        "proposalId": Id(proposal_id).encode(),
        "savedForReview": true
    }))
}

pub async fn ensure_chat_owner(pool: &PgPool, chat_id: i64, user_id: i64) -> RpcResult<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM llm_chats WHERE id = $1 AND user_id = $2)")
            .bind(chat_id)
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(internal)?;

    if exists {
        Ok(())
    } else {
        Err(RpcError::new(ErrorCode::NotFound, "Chat not found"))
    }
}

fn is_proposable_mutation(path: &str) -> bool {
    crate::contract_generated::FULL_CONTRACT
        .iter()
        .any(|specification| {
            specification.path == path
                && specification.kind == ProcedureKind::Mutation
                && is_user_facing_procedure(path)
        })
}

fn require_role(auth: &AuthResult, role: &str) -> RpcResult<()> {
    if auth.can_do(role) {
        Ok(())
    } else {
        Err(RpcError::new(
            ErrorCode::Forbidden,
            "Insufficient permissions",
        ))
    }
}

fn required_text(value: &Value, field: &str, max: usize) -> RpcResult<String> {
    let value = value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request(format!("missing {field}")))?;

    if value.len() > max {
        return Err(bad_request(format!("{field} is too long")));
    }

    Ok(value.to_owned())
}

fn validate_provider(provider: &str) -> RpcResult<()> {
    if matches!(provider, "openai" | "anthropic" | "deepseek" | "custom") {
        Ok(())
    } else {
        Err(bad_request("unsupported provider"))
    }
}

fn encrypt_secret(state: &AppState, plaintext: &str) -> RpcResult<String> {
    let key = encryption_key(state)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(internal)?;
    let mut nonce_bytes = [0_u8; 12];
    getrandom::fill(&mut nonce_bytes).map_err(internal)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(internal)?;

    Ok(format!(
        "v1.{}.{}",
        URL_SAFE_NO_PAD.encode(nonce_bytes),
        URL_SAFE_NO_PAD.encode(ciphertext)
    ))
}

fn decrypt_secret(state: &AppState, encoded: &str) -> RpcResult<String> {
    let mut parts = encoded.split('.');
    if parts.next() != Some("v1") {
        return Err(internal("unsupported encrypted LLM secret format"));
    }

    let nonce = parts
        .next()
        .ok_or_else(|| internal("invalid encrypted LLM secret"))?;
    let ciphertext = parts
        .next()
        .ok_or_else(|| internal("invalid encrypted LLM secret"))?;
    if parts.next().is_some() {
        return Err(internal("invalid encrypted LLM secret"));
    }

    let nonce = URL_SAFE_NO_PAD.decode(nonce).map_err(internal)?;
    let ciphertext = URL_SAFE_NO_PAD.decode(ciphertext).map_err(internal)?;
    if nonce.len() != 12 {
        return Err(internal("invalid encrypted LLM secret nonce"));
    }

    let key = encryption_key(state)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(internal)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| internal("could not decrypt the configured LLM API key"))?;

    String::from_utf8(plaintext).map_err(internal)
}

fn encryption_key(state: &AppState) -> RpcResult<[u8; 32]> {
    let configured = state.config.llm_encryption_key.as_deref().ok_or_else(|| {
        RpcError::new(
            ErrorCode::PreconditionFailed,
            "LLM_ENCRYPTION_KEY must be configured before storing an API key",
        )
    })?;

    Ok(Sha256::digest(configured).into())
}

#[derive(Debug, Deserialize)]
struct McpRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn handle_mcp(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<McpRequest>,
) -> Json<Value> {
    let id = request.id.clone().unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return Json(mcp_error(id, -32600, "Invalid JSON-RPC version"));
    }

    let result = async {
        let (auth, chat_id) = state.auth.authenticate_mcp(&headers).await?;
        ensure_user_access(&state, &auth).await?;

        match request.method.as_str() {
            "initialize" => Ok(json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "sortsys", "version": env!("CARGO_PKG_VERSION") }
            })),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => {
                let name = request
                    .params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad_request("missing tool name"))?;
                let arguments = request
                    .params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let output = execute_tool(&state, &auth, chat_id, name, arguments).await?;

                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string(&output).map_err(internal)?
                    }],
                    "structuredContent": output
                }))
            }
            _ => Err(RpcError::new(ErrorCode::NotFound, "Unknown MCP method")),
        }
    }
    .await;

    match result {
        Ok(result) => Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        Err(error) => Json(mcp_error(id, -32000, &error.message)),
    }
}

fn mcp_error(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message)
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        find_procedures, get_procedure_schema, is_proposable_mutation, project_cost_summary,
        system_prompt, tenant_llm_options,
    };
    use serde_json::json;

    #[test]
    fn tenant_access_is_disabled_by_default() {
        assert_eq!(tenant_llm_options(&json!({})), (false, None));
        assert_eq!(
            tenant_llm_options(&json!({
                "llm": { "enabled": true, "monthlyTokenQuota": 25_000 }
            })),
            (true, Some(25_000))
        );
    }

    #[test]
    fn proposals_exclude_privileged_mutations() {
        assert!(is_proposable_mutation("projects.create"));
        assert!(!is_proposable_mutation("/projects"));
        assert!(is_proposable_mutation("tools.inventories.create"));
        assert!(is_proposable_mutation("users.roles.set"));
        assert!(is_proposable_mutation("settings.costs.set"));
        assert!(is_proposable_mutation("settings.costs.delete"));
        assert!(!is_proposable_mutation("admin.tenants.update"));
    }

    #[test]
    fn system_prompt_requires_short_answers_and_reviewed_writes() {
        let prompt = system_prompt("de");
        assert!(prompt.contains("kurz, präzise und professionell"));
        assert!(prompt.contains("Ressource project_costs"));
        assert!(prompt.contains("Ressource tool_trackings"));
        assert!(prompt.contains("exakten RPC-Pfade"));
        assert!(prompt.contains("tool_inventories"));
        assert!(prompt.contains("sortsys_get_schema"));
        assert!(prompt.contains("sortsys_find_procedures"));
        assert!(prompt.contains("sortsys_query"));
        assert!(prompt.contains("mindestens Tagesberichte, Regieberichte und Lieferscheine"));
        assert!(prompt.contains("statt auf einzelne Nachfragen zu warten"));
        assert!(prompt.contains("ein begrenztes Suchergebnis ist kein Beleg"));
        assert!(prompt.contains("den Zeitraum und Sachbezug"));
        assert!(prompt.contains("settings.costs.get"));
        assert!(prompt.contains("Schreibzugriffe sind verboten"));
        assert!(prompt.contains("<proposal-only>"));

        let english_prompt = system_prompt("en");
        assert!(english_prompt.contains("professionally in English"));
        assert!(english_prompt.contains("daily reports,\nregie reports, and delivery notes"));
        assert!(english_prompt.contains("one combined answer"));
        assert!(english_prompt.contains("<proposal-only>"));
        assert!(english_prompt.contains("do not state"));
    }

    #[test]
    fn procedure_catalog_finds_common_costs_and_other_domain_operations() {
        let common_costs =
            find_procedures(json!({ "query": "aktuelle Gemeinkosten", "kind": "query" })).unwrap();
        let all_mutations = find_procedures(json!({ "kind": "mutation" })).unwrap();

        assert!(
            common_costs["procedures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|procedure| procedure["path"] == "settings.costs.get")
        );
        assert!(
            all_mutations["procedures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|procedure| procedure["path"] == "users.vacations.approve")
        );
        assert!(
            all_mutations["procedures"]
                .as_array()
                .unwrap()
                .iter()
                .all(|procedure| !procedure["path"].as_str().unwrap().starts_with("admin."))
        );
    }

    #[test]
    fn procedure_schema_exposes_the_complete_authoritative_contract_on_demand() {
        let schema = get_procedure_schema(json!({ "path": "projects.create" })).unwrap();

        assert_eq!(schema["kind"], "mutation");
        assert_eq!(schema["notation"], "JSON Schema");
        assert_eq!(schema["inputSchema"]["type"], "object");
        assert_eq!(
            schema["inputSchema"]["properties"]["address"]["anyOf"][1]["type"],
            "object"
        );
        assert!(
            schema["inputType"]
                .as_str()
                .unwrap()
                .contains("title: string")
        );
        assert!(
            !schema["inputType"]
                .as_str()
                .unwrap()
                .contains("name: string")
        );
        assert_eq!(schema["outputType"], "{ id: string; }");
    }

    #[test]
    fn every_generated_contract_has_a_machine_readable_schema() {
        for specification in crate::contract_generated::FULL_CONTRACT {
            super::schema::json_schema(specification.input_ts).unwrap_or_else(|error| {
                panic!(
                    "failed to parse input schema for {}: {error}",
                    specification.path
                )
            });
            super::schema::json_schema(specification.output_ts).unwrap_or_else(|error| {
                panic!(
                    "failed to parse output schema for {}: {error}",
                    specification.path
                )
            });
        }
    }

    #[test]
    fn procedure_schema_rejects_unknown_paths() {
        let error = get_procedure_schema(json!({ "path": "/projects" })).unwrap_err();

        assert_eq!(error.code, crate::error::ErrorCode::BadRequest);
        assert!(error.message.contains("unknown RPC procedure /projects"));
    }

    #[test]
    fn proposal_schema_lists_exact_rpc_mutations() {
        let tools = super::tool_definitions();
        let schema_tool = tools
            .iter()
            .find(|tool| tool["name"] == "sortsys_get_schema")
            .unwrap();
        let search_tool = tools
            .iter()
            .find(|tool| tool["name"] == "sortsys_search")
            .unwrap();
        let catalog_tool = tools
            .iter()
            .find(|tool| tool["name"] == "sortsys_find_procedures")
            .unwrap();
        let query_tool = tools
            .iter()
            .find(|tool| tool["name"] == "sortsys_query")
            .unwrap();
        let proposal_tool = tools
            .iter()
            .find(|tool| tool["name"] == "sortsys_propose_change")
            .unwrap();

        assert_eq!(
            schema_tool["inputSchema"]["properties"]["path"]["type"],
            "string"
        );

        let paths = proposal_tool["inputSchema"]["properties"]["operations"]["items"]["properties"]
            ["path"]["enum"]
            .as_array()
            .unwrap();
        assert!(paths.iter().any(|path| path == "tools.inventories.create"));
        assert!(paths.iter().any(|path| path == "settings.costs.set"));
        assert!(paths.iter().any(|path| path == "users.vacations.approve"));
        assert_eq!(
            catalog_tool["inputSchema"]["properties"]["kind"]["type"],
            "string"
        );
        assert_eq!(
            query_tool["inputSchema"]["properties"]["input"]["type"],
            "object"
        );

        let resources = search_tool["inputSchema"]["properties"]["resource"]["enum"]
            .as_array()
            .unwrap();
        assert!(
            resources
                .iter()
                .any(|resource| resource == "tool_inventories")
        );
        assert_eq!(
            search_tool["inputSchema"]["properties"]["hadInventory"]["type"],
            "boolean"
        );

        assert!(paths.iter().any(|path| path == "projects.create"));
        assert!(!paths.iter().any(|path| path == "/projects"));
    }

    #[test]
    fn project_cost_search_returns_net_totals_and_limited_records() {
        let result = project_cost_summary(
            json!([
                {
                    "projectId": "one",
                    "title": "Schulgebäude",
                    "costs": 1000.0,
                    "offersTotal": 1600.0,
                    "invoicesTotal": 1400.0
                },
                {
                    "projectId": "two",
                    "title": "Arztpraxis",
                    "costs": 750.0,
                    "offersTotal": 900.0,
                    "invoicesTotal": 0.0
                }
            ]),
            "",
            1,
        )
        .unwrap();

        assert_eq!(result["amountsAreNet"], true);
        assert_eq!(result["projectCount"], 2);
        assert_eq!(result["recordsTruncated"], true);
        assert_eq!(result["records"].as_array().unwrap().len(), 1);
        assert_eq!(result["totals"]["costs"], 1750.0);
        assert_eq!(result["totals"]["offersTotal"], 2500.0);
        assert_eq!(result["totals"]["invoicesTotal"], 1400.0);
        assert_eq!(result["totals"]["invoiceBalance"], -350.0);
    }
}
