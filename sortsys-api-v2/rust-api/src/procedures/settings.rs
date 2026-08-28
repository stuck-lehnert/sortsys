//! Tenant settings and common-cost procedures.

use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool, types::Json};
use ts_rs::TS;

use super::common::{
    authenticated_pool, bad_request, internal, not_found, require_role, trim_required,
};
use crate::{
    AppState,
    api::Success,
    auth::AuthResult,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const GLOBAL_SETTINGS_TABLE: &str = "global_settings";
const PUBLIC_SETTINGS_TABLE: &str = "public_global_settings";

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let set_language_state = Arc::clone(&state);
    builder = builder.mutation("settings.language.set", move |context, input| {
        let state = Arc::clone(&set_language_state);

        async move { set_language(&state, &context, input).await }
    });

    let get_name_state = Arc::clone(&state);
    builder = builder.query("settings.tenantName.get", move |context, _input: ()| {
        let state = Arc::clone(&get_name_state);

        async move { get_tenant_name(&state, &context).await }
    });

    let set_name_state = Arc::clone(&state);
    builder = builder.mutation("settings.tenantName.set", move |context, input| {
        let state = Arc::clone(&set_name_state);

        async move { set_tenant_name(&state, &context, input).await }
    });

    let get_costs_state = Arc::clone(&state);
    builder = builder.query("settings.costs.get", move |context, _input: ()| {
        let state = Arc::clone(&get_costs_state);

        async move { handle_get_costs(&state, &context).await }
    });

    let set_cost_state = Arc::clone(&state);
    builder = builder.mutation("settings.costs.set", move |context, input| {
        let state = Arc::clone(&set_cost_state);

        async move { set_cost(&state, &context, input).await }
    });

    let update_costs_state = Arc::clone(&state);
    builder = builder.mutation("settings.costs.update", move |context, input| {
        let state = Arc::clone(&update_costs_state);

        async move { update_legacy_costs(&state, &context, input).await }
    });

    let delete_cost_state = Arc::clone(&state);
    builder = builder.mutation("settings.costs.delete", move |context, input| {
        let state = Arc::clone(&delete_cost_state);

        async move { delete_cost(&state, &context, input).await }
    });

    let get_global_state = Arc::clone(&state);
    builder = builder.query("settings.global.get", move |context, input| {
        let state = Arc::clone(&get_global_state);

        async move { get_setting(&state, &context, input, GLOBAL_SETTINGS_TABLE, true).await }
    });

    let set_global_state = Arc::clone(&state);
    builder = builder.mutation("settings.global.set", move |context, input| {
        let state = Arc::clone(&set_global_state);

        async move { set_setting(&state, &context, input, GLOBAL_SETTINGS_TABLE).await }
    });

    let delete_global_state = Arc::clone(&state);
    builder = builder.mutation("settings.global.delete", move |context, input| {
        let state = Arc::clone(&delete_global_state);

        async move { delete_setting(&state, &context, input, GLOBAL_SETTINGS_TABLE).await }
    });

    let get_public_state = Arc::clone(&state);
    builder = builder.query("settings.publicGlobal.get", move |context, input| {
        let state = Arc::clone(&get_public_state);

        async move { get_setting(&state, &context, input, PUBLIC_SETTINGS_TABLE, false).await }
    });

    let set_public_state = Arc::clone(&state);
    builder = builder.mutation("settings.publicGlobal.set", move |context, input| {
        let state = Arc::clone(&set_public_state);

        async move { set_setting(&state, &context, input, PUBLIC_SETTINGS_TABLE).await }
    });

    builder.mutation("settings.publicGlobal.delete", move |context, input| {
        let state = Arc::clone(&state);

        async move { delete_setting(&state, &context, input, PUBLIC_SETTINGS_TABLE).await }
    })
}

async fn set_language(
    state: &AppState,
    context: &RequestContext,
    input: LanguageSetInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let result = sqlx::query("UPDATE users SET ui_locale = $1 WHERE id = $2")
        .bind(input.locale.as_str())
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn get_tenant_name(
    state: &AppState,
    context: &RequestContext,
) -> RpcResult<TenantNameOutput> {
    let auth = state.auth.authenticate(&context.headers).await?;
    ensure_admin(&auth)?;

    let tenant = state
        .tenants
        .tenant(&auth.tenant)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    let company_name = tenant
        .contact_details
        .get("companyName")
        .and_then(Value::as_str)
        .map(str::to_owned);

    Ok(TenantNameOutput { company_name })
}

async fn set_tenant_name(
    state: &AppState,
    context: &RequestContext,
    mut input: TenantNameSetInput,
) -> RpcResult<Success> {
    let auth = state.auth.authenticate(&context.headers).await?;
    ensure_admin(&auth)?;
    trim_required(&mut input.company_name, "companyName", 120)?;

    let result = sqlx::query(
        r#"
        UPDATE __tenants
        SET contact_details = jsonb_set(
            contact_details,
            '{companyName}',
            to_jsonb($2::text),
            true
        )
        WHERE name = $1
        "#,
    )
    .bind(&auth.tenant)
    .bind(input.company_name)
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn handle_get_costs(state: &AppState, context: &RequestContext) -> RpcResult<CostsOutput> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    require_role(&auth, "view:projects")?;

    get_costs(&pool).await
}

async fn set_cost(
    state: &AppState,
    context: &RequestContext,
    input: CostSetInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    require_role(&auth, "manage:projects")?;

    if input.relative_factor < 0.0 {
        return Err(bad_request("relativeFactor must be nonnegative"));
    }

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    upsert_cost(
        &pool,
        input.cost_type,
        input.effective_at,
        input.relative_factor,
        input.constant,
        user_id,
    )
    .await?;

    Ok(Success { success: true })
}

async fn update_legacy_costs(
    state: &AppState,
    context: &RequestContext,
    input: LegacyCostUpdateInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    require_role(&auth, "manage:projects")?;
    input.validate()?;

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let effective_at = Utc::now();

    if let Some(factor) = input.work_hour_overhead_factor {
        upsert_cost(
            &pool,
            CommonCostType::Fgk,
            effective_at,
            (factor - 1.0).max(0.0),
            0.0,
            user_id,
        )
        .await?;
    }

    // The legacy endpoint exposed separate product and special-record factors,
    // while the normalized model stores one MGK value. Preserve its averaging.
    let material_factors: Vec<f64> = [
        input.product_overhead_factor,
        input.special_record_overhead_factor,
    ]
    .into_iter()
    .flatten()
    .collect();

    if !material_factors.is_empty() {
        let average = material_factors.iter().sum::<f64>() / material_factors.len() as f64;

        upsert_cost(
            &pool,
            CommonCostType::Mgk,
            effective_at,
            (average - 1.0).max(0.0),
            0.0,
            user_id,
        )
        .await?;
    }

    Ok(Success { success: true })
}

async fn delete_cost(
    state: &AppState,
    context: &RequestContext,
    input: CostDeleteInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    require_role(&auth, "manage:projects")?;

    let result = sqlx::query(
        r#"
        DELETE FROM global_common_cost_entries
        WHERE type = $1
          AND effective_at = $2
        "#,
    )
    .bind(input.cost_type.as_str())
    .bind(input.effective_at)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

fn ensure_admin(auth: &AuthResult) -> RpcResult<()> {
    require_role(auth, ":admin")
}

async fn get_costs(pool: &PgPool) -> RpcResult<CostsOutput> {
    let active_rows = sqlx::query_as::<_, ActiveCostRow>(
        r#"
        SELECT DISTINCT ON (type)
            type,
            effective_at,
            relative_factor,
            constant
        FROM global_common_cost_entries
        WHERE effective_at <= NOW()
        ORDER BY type, effective_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    let mut active_by_type: HashMap<String, ActiveCost> = active_rows
        .into_iter()
        .map(|row| {
            let key = row.cost_type.clone();

            (key, ActiveCost::from(row))
        })
        .collect();

    let epoch = Utc.timestamp_opt(0, 0).single().expect("valid epoch");
    let default_cost = |cost_type| ActiveCost {
        cost_type,
        effective_at: epoch,
        relative_factor: 0.0,
        constant: 0.0,
    };

    let fgk = active_by_type
        .remove("fgk")
        .unwrap_or_else(|| default_cost(CommonCostType::Fgk));
    let mgk = active_by_type
        .remove("mgk")
        .unwrap_or_else(|| default_cost(CommonCostType::Mgk));
    let ngk = active_by_type
        .remove("ngk")
        .unwrap_or_else(|| default_cost(CommonCostType::Ngk));

    let history = sqlx::query_as::<_, CostHistoryRow>(
        r#"
        SELECT
            id,
            type,
            effective_at,
            relative_factor,
            constant,
            created_by_user_id,
            created_at,
            modified_at
        FROM global_common_cost_entries
        ORDER BY type, effective_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(internal)?
    .into_iter()
    .map(CostHistory::from)
    .collect();

    Ok(CostsOutput {
        product_overhead_factor: mgk.relative_factor + 1.0,
        work_hour_overhead_factor: fgk.relative_factor + 1.0,
        special_record_overhead_factor: mgk.relative_factor + 1.0,
        tool_overhead_factor: 1.0,
        fgk,
        mgk,
        ngk,
        history,
    })
}

async fn upsert_cost(
    pool: &PgPool,
    cost_type: CommonCostType,
    effective_at: DateTime<Utc>,
    relative_factor: f64,
    constant: f64,
    user_id: i64,
) -> RpcResult<()> {
    sqlx::query(
        r#"
        INSERT INTO global_common_cost_entries (
            type,
            effective_at,
            relative_factor,
            constant,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (type, effective_at)
        DO UPDATE SET
            relative_factor = EXCLUDED.relative_factor,
            constant = EXCLUDED.constant,
            created_by_user_id = EXCLUDED.created_by_user_id
        "#,
    )
    .bind(cost_type.as_str())
    .bind(effective_at)
    .bind(relative_factor)
    .bind(constant)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(internal)?;

    Ok(())
}

async fn get_setting(
    state: &AppState,
    context: &RequestContext,
    mut input: SettingKeyInput,
    table: &str,
    requires_admin: bool,
) -> RpcResult<SettingOutput> {
    input.normalize()?;

    let (auth, pool) = authenticated_pool(state, context).await?;
    if requires_admin {
        ensure_admin(&auth)?;
    }

    // Only module-private constants are passed as table names.
    let sql = format!("SELECT key, name FROM {table} WHERE key = $1");
    let row = sqlx::query_as::<_, SettingRow>(&sql)
        .bind(&input.key)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;

    Ok(SettingOutput {
        key: row.key,
        name: row.name.map(|value| value.0),
    })
}

async fn set_setting(
    state: &AppState,
    context: &RequestContext,
    mut input: SettingSetInput,
    table: &str,
) -> RpcResult<Success> {
    input.normalize()?;

    let (auth, pool) = authenticated_pool(state, context).await?;
    ensure_admin(&auth)?;

    let sql = format!(
        r#"
        INSERT INTO {table} (key, name)
        VALUES ($1, $2)
        ON CONFLICT (key)
        DO UPDATE SET name = EXCLUDED.name
        "#
    );

    sqlx::query(&sql)
        .bind(input.key)
        .bind(input.name.map(Json))
        .execute(&pool)
        .await
        .map_err(internal)?;

    Ok(Success { success: true })
}

async fn delete_setting(
    state: &AppState,
    context: &RequestContext,
    mut input: SettingKeyInput,
    table: &str,
) -> RpcResult<Success> {
    input.normalize()?;

    let (auth, pool) = authenticated_pool(state, context).await?;
    ensure_admin(&auth)?;

    // Only module-private constants are passed as table names.
    let sql = format!("DELETE FROM {table} WHERE key = $1");
    let result = sqlx::query(&sql)
        .bind(input.key)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
enum UiLocale {
    De,
    En,
}

impl UiLocale {
    fn as_str(self) -> &'static str {
        match self {
            Self::De => "de",
            Self::En => "en",
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct LanguageSetInput {
    locale: UiLocale,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TenantNameSetInput {
    company_name: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct TenantNameOutput {
    company_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
enum CommonCostType {
    Fgk,
    Mgk,
    Ngk,
}
impl CommonCostType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Fgk => "fgk",
            Self::Mgk => "mgk",
            Self::Ngk => "ngk",
        }
    }
}
impl TryFrom<String> for CommonCostType {
    type Error = crate::error::RpcError;

    fn try_from(value: String) -> RpcResult<Self> {
        match value.as_str() {
            "fgk" => Ok(Self::Fgk),
            "mgk" => Ok(Self::Mgk),
            "ngk" => Ok(Self::Ngk),
            _ => Err(internal("invalid cost type in database")),
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CostSetInput {
    #[serde(rename = "type")]
    cost_type: CommonCostType,
    effective_at: DateTime<Utc>,
    relative_factor: f64,
    constant: f64,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CostDeleteInput {
    #[serde(rename = "type")]
    cost_type: CommonCostType,
    effective_at: DateTime<Utc>,
}
#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyCostUpdateInput {
    #[serde(default)]
    #[ts(optional)]
    product_overhead_factor: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    work_hour_overhead_factor: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    special_record_overhead_factor: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    tool_overhead_factor: Option<f64>,
}
impl LegacyCostUpdateInput {
    fn validate(&self) -> RpcResult<()> {
        if [
            self.product_overhead_factor,
            self.work_hour_overhead_factor,
            self.special_record_overhead_factor,
            self.tool_overhead_factor,
        ]
        .into_iter()
        .flatten()
        .any(|factor| factor < 0.0)
        {
            Err(bad_request("factor must be nonnegative"))
        } else {
            Ok(())
        }
    }
}

#[derive(FromRow)]
struct ActiveCostRow {
    #[sqlx(rename = "type")]
    cost_type: String,
    effective_at: DateTime<Utc>,
    relative_factor: f64,
    constant: f64,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ActiveCost {
    #[serde(rename = "type")]
    cost_type: CommonCostType,
    #[ts(type = "Date")]
    effective_at: DateTime<Utc>,
    relative_factor: f64,
    constant: f64,
}
impl From<ActiveCostRow> for ActiveCost {
    fn from(row: ActiveCostRow) -> Self {
        Self {
            cost_type: row.cost_type.try_into().expect("database cost type"),
            effective_at: row.effective_at,
            relative_factor: row.relative_factor,
            constant: row.constant,
        }
    }
}

#[derive(FromRow)]
struct CostHistoryRow {
    id: i64,
    #[sqlx(rename = "type")]
    cost_type: String,
    effective_at: DateTime<Utc>,
    relative_factor: f64,
    constant: f64,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CostHistory {
    id: Id,
    #[serde(rename = "type")]
    cost_type: CommonCostType,
    #[ts(type = "Date")]
    effective_at: DateTime<Utc>,
    relative_factor: f64,
    constant: f64,
    created_by_user_id: Option<Id>,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}
impl From<CostHistoryRow> for CostHistory {
    fn from(row: CostHistoryRow) -> Self {
        Self {
            id: Id(row.id),
            cost_type: row.cost_type.try_into().expect("database cost type"),
            effective_at: row.effective_at,
            relative_factor: row.relative_factor,
            constant: row.constant,
            created_by_user_id: row.created_by_user_id.map(Id),
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CostsOutput {
    fgk: ActiveCost,
    mgk: ActiveCost,
    ngk: ActiveCost,
    history: Vec<CostHistory>,
    product_overhead_factor: f64,
    work_hour_overhead_factor: f64,
    special_record_overhead_factor: f64,
    tool_overhead_factor: f64,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct SettingKeyInput {
    key: String,
}
impl SettingKeyInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.key, "key", 255)
    }
}
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct SettingSetInput {
    key: String,
    name: Option<Value>,
}
impl SettingSetInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.key, "key", 255)
    }
}
#[derive(FromRow)]
struct SettingRow {
    key: String,
    name: Option<Json<Value>>,
}
#[derive(Debug, Serialize, TS)]
struct SettingOutput {
    key: String,
    name: Option<Value>,
}
