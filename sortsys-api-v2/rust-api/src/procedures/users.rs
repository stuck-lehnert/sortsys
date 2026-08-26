//! User lifecycle, supervisor, and role procedures.
//!
//! Registration is split by responsibility so the wire surface is easy to
//! audit independently from the user mutation and hierarchy logic.

use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::{FromRow, PgPool, types::Json};

use super::common::{
    authenticated_pool, bad_request, conflict, forbidden, input_id, input_object, internal,
    not_found, optional_input_id, optional_input_string, require_role,
};
use crate::{
    AppState,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const DEFAULT_SUPERVISOR_KEY: &str = "users.defaultSupervisorUserId";

const USER_SELECT: &str = r#"
    SELECT
        id,
        salutation,
        first_name,
        last_name,
        username,
        email,
        phone,
        contract_type,
        cost_per_hour,
        supervisor_user_id,
        created_at,
        modified_at,
        deactivated_at,
        archived_at
    FROM users
"#;

static USERNAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9_]+(\.[a-z0-9_]+)*$").expect("username regex must be valid")
});

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let builder = register_user_records(builder, Arc::clone(&state));
    let builder = register_lifecycle(builder, Arc::clone(&state));
    let builder = register_supervisors(builder, Arc::clone(&state));

    register_roles(builder, state)
}

fn register_user_records(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    builder = builder.query_json("users.list", move |context, input| {
        let state = Arc::clone(&list_state);

        async move { list(&state, &context, input).await }
    });

    let get_state = Arc::clone(&state);
    builder = builder.query_json("users.get", move |context, input| {
        let state = Arc::clone(&get_state);

        async move { get(&state, &context, input).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation_json("users.create", move |context, input| {
        let state = Arc::clone(&create_state);

        async move { create(&state, &context, input).await }
    });

    let update_state = Arc::clone(&state);
    builder = builder.mutation_json("users.update", move |context, input| {
        let state = Arc::clone(&update_state);

        async move { update(&state, &context, input).await }
    });

    builder
}

fn register_lifecycle(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    for (path, action) in [
        ("users.delete", LifecycleAction::Delete),
        ("users.archive", LifecycleAction::Archive),
        ("users.unarchive", LifecycleAction::Unarchive),
        ("users.activate", LifecycleAction::Activate),
        ("users.deactivate", LifecycleAction::Deactivate),
    ] {
        let lifecycle_state = Arc::clone(&state);
        builder = builder.mutation_json(path, move |context, input| {
            let state = Arc::clone(&lifecycle_state);

            async move { change_lifecycle(&state, &context, input, action).await }
        });
    }

    builder
}

fn register_supervisors(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let get_default_state = Arc::clone(&state);
    builder = builder.query_json("users.supervisors.getDefault", move |context, input| {
        let state = Arc::clone(&get_default_state);

        async move { get_default_supervisor(&state, &context, input).await }
    });

    let set_default_state = Arc::clone(&state);
    builder = builder.mutation_json("users.supervisors.setDefault", move |context, input| {
        let state = Arc::clone(&set_default_state);

        async move { set_default_supervisor(&state, &context, input).await }
    });

    builder
}

fn register_roles(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_roles_state = Arc::clone(&state);
    builder = builder.query_json("users.roles.list", move |context, input| {
        let state = Arc::clone(&list_roles_state);

        async move { list_roles(&state, &context, input).await }
    });

    let get_roles_state = Arc::clone(&state);
    builder = builder.query_json("users.roles.get", move |context, input| {
        let state = Arc::clone(&get_roles_state);

        async move { get_roles(&state, &context, input).await }
    });

    builder.mutation_json("users.roles.set", move |context, input| {
        let state = Arc::clone(&state);

        async move { set_roles(&state, &context, input).await }
    })
}

#[derive(FromRow)]
struct UserRow {
    id: i64,
    salutation: Option<String>,
    first_name: String,
    last_name: Option<String>,
    username: String,
    email: Option<String>,
    phone: Option<String>,
    contract_type: String,
    cost_per_hour: Option<f64>,
    supervisor_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    deactivated_at: Option<DateTime<Utc>>,
    archived_at: Option<DateTime<Utc>>,
}

impl UserRow {
    fn into_wire_value(self, show_cost: bool) -> Value {
        json!({
            "id": Id(self.id),
            "salutation": self.salutation,
            "firstName": self.first_name,
            "lastName": self.last_name,
            "username": self.username,
            "email": self.email,
            "phone": self.phone,
            "contractType": self.contract_type,
            "costPerHour": show_cost.then_some(self.cost_per_hour).flatten(),
            "supervisorUserId": self.supervisor_user_id.map(Id),
            "createdAt": self.created_at,
            "modifiedAt": self.modified_at,
            "deactivatedAt": self.deactivated_at,
            "archivedAt": self.archived_at,
        })
    }
}

async fn list(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let input = input_object(&input)?;

    let search = optional_input_string(input, "search")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let deactivated = input.get("deactivated").and_then(Value::as_bool);
    let include_archived = input
        .get("includeArchived")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let may_view_users = auth.can_do("view:users");
    if include_archived && !may_view_users {
        return Err(forbidden());
    }

    // Users without the view role may still select active colleagues in forms.
    // Their result deliberately hides hourly costs and deactivated accounts.
    let sql = format!(
        r#"
        {USER_SELECT}
        WHERE ($1::text IS NULL OR _search @@ create_query($1))
          AND ($2 OR archived_at IS NULL)
          AND (
              CASE
                  WHEN $3::bool IS NOT NULL
                      THEN (deactivated_at IS NOT NULL) = $3
                  WHEN NOT $4
                      THEN deactivated_at IS NULL
                  ELSE TRUE
              END
          )
        ORDER BY LOWER(last_name), LOWER(first_name)
        "#
    );

    let rows = sqlx::query_as::<_, UserRow>(&sql)
        .bind(search)
        .bind(include_archived)
        .bind(deactivated)
        .bind(may_view_users)
        .fetch_all(&pool)
        .await
        .map_err(internal)?;

    let users = rows
        .into_iter()
        .map(|row| row.into_wire_value(may_view_users))
        .collect();

    Ok(Value::Array(users))
}

async fn get(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let user_id = input_id(input_object(&input)?, "id")?;
    let may_view_users = auth.can_do("view:users");

    let sql = format!(
        r#"
        {USER_SELECT}
        WHERE id = $1
          AND ($2 OR deactivated_at IS NULL)
        "#
    );

    let user = sqlx::query_as::<_, UserRow>(&sql)
        .bind(user_id)
        .bind(may_view_users)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;

    Ok(user.into_wire_value(may_view_users))
}

async fn create(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    require_role(&auth, "manage:users")?;

    let input = input_object(&input)?;
    let username = required_trimmed(input, "username")?.to_lowercase();
    validate_username(&username)?;

    let first_name = required_trimmed(input, "firstName")?;
    let supervisor_user_id = if input.contains_key("supervisorUserId") {
        optional_input_id(input, "supervisorUserId")?
    } else {
        default_supervisor_id(&pool).await?
    };
    ensure_valid_supervisor(&pool, -1, supervisor_user_id).await?;

    let contract_type = optional_input_string(input, "contractType").unwrap_or("internal");
    validate_contract_type(contract_type)?;

    let cost_per_hour = input.get("costPerHour").and_then(Value::as_f64);
    validate_hourly_cost(cost_per_hour)?;

    let created_by_user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let user_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO users (
            username,
            first_name,
            last_name,
            email,
            phone,
            contract_type,
            cost_per_hour,
            supervisor_user_id,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        "#,
    )
    .bind(username)
    .bind(first_name)
    .bind(nullable_trimmed(input, "lastName"))
    .bind(nullable_trimmed(input, "email"))
    .bind(nullable_trimmed(input, "phone"))
    .bind(contract_type)
    .bind(cost_per_hour)
    .bind(supervisor_user_id)
    .bind(created_by_user_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    Ok(json!({ "id": Id(user_id) }))
}

async fn update(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    require_role(&auth, "manage:users")?;

    let input = input_object(&input)?;
    let user_id = input_id(input, "id")?;
    let changes = input
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing data"))?;

    if changes.is_empty() {
        return Ok(success());
    }

    let sql = format!("{USER_SELECT} WHERE id = $1");
    let current = sqlx::query_as::<_, UserRow>(&sql)
        .bind(user_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;

    let username = optional_input_string(changes, "username")
        .map(str::trim)
        .unwrap_or(&current.username)
        .to_lowercase();
    validate_username(&username)?;

    let first_name = optional_input_string(changes, "firstName")
        .map(str::trim)
        .unwrap_or(&current.first_name)
        .to_owned();
    if first_name.is_empty() {
        return Err(bad_request("invalid firstName"));
    }

    let last_name = changed_nullable_text(changes, "lastName", current.last_name);
    let email = changed_nullable_text(changes, "email", current.email);
    let phone = changed_nullable_text(changes, "phone", current.phone);

    let contract_type = optional_input_string(changes, "contractType")
        .unwrap_or(&current.contract_type)
        .to_owned();
    validate_contract_type(&contract_type)?;

    let cost_per_hour = if changes.contains_key("costPerHour") {
        changes.get("costPerHour").and_then(Value::as_f64)
    } else {
        current.cost_per_hour
    };
    validate_hourly_cost(cost_per_hour)?;

    let supervisor_user_id = if changes.contains_key("supervisorUserId") {
        optional_input_id(changes, "supervisorUserId")?
    } else {
        current.supervisor_user_id
    };
    ensure_valid_supervisor(&pool, user_id, supervisor_user_id).await?;

    sqlx::query(
        r#"
        UPDATE users
        SET
            username = $2,
            first_name = $3,
            last_name = $4,
            email = $5,
            phone = $6,
            contract_type = $7,
            cost_per_hour = $8,
            supervisor_user_id = $9
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(username)
    .bind(first_name)
    .bind(last_name)
    .bind(email)
    .bind(phone)
    .bind(contract_type)
    .bind(cost_per_hour)
    .bind(supervisor_user_id)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if changes.contains_key("costPerHour") {
        // Existing report rows keep an explicit historical cost. Only rows
        // that were waiting for a user default inherit the new value.
        sqlx::query(
            r#"
            UPDATE daily_project_report_work_hours
            SET cost_per_hour = $2
            WHERE user_id = $1
              AND cost_per_hour IS NULL
            "#,
        )
        .bind(user_id)
        .bind(cost_per_hour)
        .execute(&pool)
        .await
        .map_err(internal)?;
    }

    Ok(success())
}

fn required_trimmed(input: &Map<String, Value>, key: &str) -> RpcResult<String> {
    let value = optional_input_string(input, key)
        .ok_or_else(|| bad_request(format!("missing {key}")))?
        .trim()
        .to_owned();

    if value.is_empty() {
        Err(bad_request(format!("invalid {key}")))
    } else {
        Ok(value)
    }
}

fn nullable_trimmed(input: &Map<String, Value>, key: &str) -> Option<String> {
    optional_input_string(input, key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn changed_nullable_text(
    changes: &Map<String, Value>,
    key: &str,
    current: Option<String>,
) -> Option<String> {
    if changes.contains_key(key) {
        nullable_trimmed(changes, key)
    } else {
        current
    }
}

fn validate_username(username: &str) -> RpcResult<()> {
    if username.is_empty() || !USERNAME_PATTERN.is_match(username) {
        return Err(bad_request("invalid username"));
    }

    Ok(())
}

fn validate_contract_type(contract_type: &str) -> RpcResult<()> {
    if !["internal", "external", "subcontractor"].contains(&contract_type) {
        return Err(bad_request("invalid contractType"));
    }

    Ok(())
}

fn validate_hourly_cost(cost_per_hour: Option<f64>) -> RpcResult<()> {
    if cost_per_hour.is_some_and(|cost| cost < 0.0) {
        return Err(bad_request("invalid costPerHour"));
    }

    Ok(())
}

async fn ensure_valid_supervisor(
    pool: &PgPool,
    user_id: i64,
    supervisor_user_id: Option<i64>,
) -> RpcResult<()> {
    let Some(supervisor_user_id) = supervisor_user_id else {
        return Ok(());
    };

    if user_id == supervisor_user_id {
        return Err(conflict());
    }

    let supervisor_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(supervisor_user_id)
            .fetch_one(pool)
            .await
            .map_err(internal)?;

    if !supervisor_exists {
        return Err(not_found());
    }

    // A supervisor may not be one of the user's descendants. Without this
    // recursive check, an update could create a cycle in the hierarchy.
    let creates_cycle: bool = sqlx::query_scalar(
        r#"
        WITH RECURSIVE subordinate(id) AS (
            SELECT id
            FROM users
            WHERE supervisor_user_id = $1

            UNION ALL

            SELECT users.id
            FROM users
            JOIN subordinate
              ON users.supervisor_user_id = subordinate.id
        )
        SELECT EXISTS(
            SELECT 1
            FROM subordinate
            WHERE id = $2
        )
        "#,
    )
    .bind(user_id)
    .bind(supervisor_user_id)
    .fetch_one(pool)
    .await
    .map_err(internal)?;

    if creates_cycle {
        Err(conflict())
    } else {
        Ok(())
    }
}

async fn default_supervisor_id(pool: &PgPool) -> RpcResult<Option<i64>> {
    let setting: Option<Json<Value>> =
        sqlx::query_scalar("SELECT name FROM global_settings WHERE key = $1")
            .bind(DEFAULT_SUPERVISOR_KEY)
            .fetch_optional(pool)
            .await
            .map_err(internal)?
            .flatten();

    let configured_id = setting.and_then(|setting| {
        setting
            .0
            .as_str()
            .and_then(|value| value.parse::<i64>().ok())
    });

    let Some(configured_id) = configured_id else {
        return Ok(None);
    };

    // Stale settings are treated as unset, matching the legacy behavior.
    let user_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(configured_id)
        .fetch_one(pool)
        .await
        .map_err(internal)?;

    Ok(user_exists.then_some(configured_id))
}

#[derive(Clone, Copy)]
enum LifecycleAction {
    Delete,
    Archive,
    Unarchive,
    Activate,
    Deactivate,
}

async fn change_lifecycle(
    state: &AppState,
    context: &RequestContext,
    input: Value,
    action: LifecycleAction,
) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    match action {
        LifecycleAction::Delete => require_role(&auth, "delete:users")?,
        LifecycleAction::Archive | LifecycleAction::Unarchive => {
            require_role(&auth, "manage:users")?;
        }
        LifecycleAction::Activate | LifecycleAction::Deactivate => {
            if !auth.is_admin() {
                return Err(forbidden());
            }
        }
    }

    let user_id = input_id(input_object(&input)?, "id")?;
    let sql = match action {
        LifecycleAction::Delete => "DELETE FROM users WHERE id = $1",
        LifecycleAction::Archive => "UPDATE users SET archived_at = NOW() WHERE id = $1",
        LifecycleAction::Unarchive => "UPDATE users SET archived_at = NULL WHERE id = $1",
        LifecycleAction::Activate => {
            "UPDATE users
             SET deactivated_at = NULL, archived_at = NULL
             WHERE id = $1"
        }
        LifecycleAction::Deactivate => "UPDATE users SET deactivated_at = NOW() WHERE id = $1",
    };

    let result = sqlx::query(sql)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|error| {
            // Database checks protect the last active administrator and other
            // lifecycle invariants. Expose those violations as a conflict.
            if error
                .as_database_error()
                .is_some_and(|database_error| database_error.is_check_violation())
            {
                conflict()
            } else {
                internal(error)
            }
        })?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(success())
}

async fn get_default_supervisor(
    state: &AppState,
    context: &RequestContext,
    _input: Value,
) -> RpcResult<Value> {
    let (_, pool) = authenticated_pool(state, context).await?;
    let user_id = default_supervisor_id(&pool).await?.map(Id);

    Ok(json!({ "userId": user_id }))
}

async fn set_default_supervisor(
    state: &AppState,
    context: &RequestContext,
    input: Value,
) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }

    let default_user_id = optional_input_id(input_object(&input)?, "userId")?;
    let mut transaction = pool.begin().await.map_err(internal)?;

    if let Some(default_user_id) = default_user_id {
        let user_exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
                .bind(default_user_id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(internal)?;

        if !user_exists {
            return Err(not_found());
        }

        sqlx::query(
            r#"
            INSERT INTO global_settings (key, name)
            VALUES ($1, to_jsonb($2::text))
            ON CONFLICT (key)
            DO UPDATE SET name = EXCLUDED.name
            "#,
        )
        .bind(DEFAULT_SUPERVISOR_KEY)
        .bind(default_user_id.to_string())
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;

        // The default supervisor cannot supervise themselves. Existing users
        // without a supervisor are attached to the new default in one update.
        sqlx::query("UPDATE users SET supervisor_user_id = NULL WHERE id = $1")
            .bind(default_user_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;

        sqlx::query(
            r#"
            UPDATE users
            SET supervisor_user_id = $1
            WHERE supervisor_user_id IS NULL
              AND id <> $1
            "#,
        )
        .bind(default_user_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    } else {
        sqlx::query("DELETE FROM global_settings WHERE key = $1")
            .bind(DEFAULT_SUPERVISOR_KEY)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
    }

    transaction.commit().await.map_err(internal)?;

    Ok(success())
}

async fn list_roles(state: &AppState, context: &RequestContext, _input: Value) -> RpcResult<Value> {
    let (_, pool) = authenticated_pool(state, context).await?;
    let roles: Vec<String> = sqlx::query_scalar("SELECT name FROM user_roles ORDER BY name")
        .fetch_all(&pool)
        .await
        .map_err(internal)?;

    Ok(json!(roles))
}

async fn get_roles(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }

    let user_id = input_id(input_object(&input)?, "userId")?;
    let user_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .map_err(internal)?;

    if !user_exists {
        return Err(not_found());
    }

    let roles: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT role_name
        FROM user_role_assignments
        WHERE user_id = $1
        ORDER BY LOWER(role_name)
        "#,
    )
    .bind(user_id)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(json!(roles))
}

async fn set_roles(state: &AppState, context: &RequestContext, input: Value) -> RpcResult<Value> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    if !auth.is_admin() {
        return Err(forbidden());
    }

    let input = input_object(&input)?;
    let user_id = input_id(input, "userId")?;
    let assignments = input
        .get("assignments")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("missing assignments"))?;

    let mut transaction = pool.begin().await.map_err(internal)?;
    let user_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(internal)?;

    if !user_exists {
        return Err(not_found());
    }

    for (role, assigned) in assignments {
        let Some(assigned) = assigned.as_bool() else {
            // Null and undefined assignments mean "leave unchanged".
            continue;
        };

        if assigned {
            sqlx::query(
                r#"
                INSERT INTO user_role_assignments (user_id, role_name)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
                "#,
            )
            .bind(user_id)
            .bind(role)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
        } else {
            sqlx::query(
                r#"
                DELETE FROM user_role_assignments
                WHERE user_id = $1
                  AND role_name = $2
                "#,
            )
            .bind(user_id)
            .bind(role)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
        }
    }

    transaction.commit().await.map_err(internal)?;

    Ok(success())
}

fn success() -> Value {
    json!({ "success": true })
}

#[cfg(test)]
mod tests {
    use super::{validate_contract_type, validate_hourly_cost, validate_username};

    #[test]
    fn validates_usernames_like_the_legacy_schema() {
        assert!(validate_username("first.last_2").is_ok());
        assert!(validate_username("Uppercase").is_err());
        assert!(validate_username("double..dot").is_err());
    }

    #[test]
    fn validates_contract_types_and_hourly_costs() {
        assert!(validate_contract_type("internal").is_ok());
        assert!(validate_contract_type("temporary").is_err());
        assert!(validate_hourly_cost(Some(0.0)).is_ok());
        assert!(validate_hourly_cost(Some(-0.01)).is_err());
    }
}
