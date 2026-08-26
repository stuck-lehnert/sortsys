//! Cross-tenant administrator user management.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use email_address::EmailAddress;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;

use super::{
    admin_common::{
        admin_for, ensure_not_locked, ensure_tenant_access, generated_password, password_hash,
        tenant, tenant_pool_for_admin, validate_admin_password,
    },
    common::{bad_request, conflict, internal, not_found, trim_nullable, trim_required},
};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    ids::Id,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let create_state = Arc::clone(&state);
    let set_admin_state = Arc::clone(&state);

    builder
        .query(
            "admin.users.list",
            move |context, mut input: UserListInput| {
                let state = Arc::clone(&list_state);

                async move {
                    input.normalize();
                    list(&state, &context, input).await
                }
            },
        )
        .mutation(
            "admin.users.create",
            move |context, mut input: UserCreateInput| {
                let state = Arc::clone(&create_state);

                async move {
                    input.normalize()?;
                    create(&state, &context, input).await
                }
            },
        )
        .mutation(
            "admin.users.setAdmin",
            move |context, input: UserSetAdminInput| {
                let state = Arc::clone(&set_admin_state);

                async move { set_admin(&state, &context, input).await }
            },
        )
        .mutation(
            "admin.users.resetPassword",
            move |context, input: UserResetPasswordInput| {
                let state = Arc::clone(&state);

                async move { reset_password(&state, &context, input).await }
            },
        )
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    input: UserListInput,
) -> RpcResult<Vec<AdminUserSummary>> {
    let admin_for = admin_for(state, context).await?;
    ensure_tenant_access(&admin_for, &input.tenant)?;
    tenant(state, &input.tenant).await?;

    let pool = tenant_pool_for_admin(state, &input.tenant, &admin_for).await?;
    let rows = sqlx::query_as::<_, AdminUserRow>(
        r#"
        SELECT
            user_account.id,
            user_account.username,
            user_account.first_name,
            user_account.last_name,
            user_account.email,
            user_account.deactivated_at,
            user_account.archived_at,
            EXISTS (
                SELECT 1
                FROM user_role_assignments AS assignment
                WHERE assignment.user_id = user_account.id
                  AND assignment.role_name = ':admin'
            ) AS is_admin
        FROM users AS user_account
        WHERE ($1 OR user_account.archived_at IS NULL)
          AND (
              $2::text IS NULL
              OR LOWER(CONCAT_WS(
                  ' ',
                  user_account.username,
                  user_account.first_name,
                  user_account.last_name,
                  user_account.email
              )) LIKE '%' || $2 || '%'
          )
        ORDER BY
            LOWER(user_account.username),
            LOWER(user_account.last_name),
            LOWER(user_account.first_name)
        "#,
    )
    .bind(input.include_archived)
    .bind(input.search)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(AdminUserSummary::from).collect())
}

async fn create(
    state: &AppState,
    context: &RequestContext,
    input: UserCreateInput,
) -> RpcResult<UserCreateOutput> {
    let admin_for = admin_for(state, context).await?;
    ensure_tenant_access(&admin_for, &input.tenant)?;

    let tenant_row = tenant(state, &input.tenant).await?;
    ensure_not_locked(&admin_for, &tenant_row)?;

    let password = match input.password {
        Some(password) => {
            validate_admin_password(&password)?;
            password
        }
        None => generated_password(24)?,
    };
    let hash = password_hash(&password).await?;
    let pool = tenant_pool_for_admin(state, &input.tenant, &admin_for).await?;
    let mut transaction = pool.begin().await.map_err(internal)?;

    let user_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO users (
            salutation,
            first_name,
            last_name,
            username,
            email,
            phone,
            contract_type,
            password,
            deactivated_at,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)
        RETURNING id
        "#,
    )
    .bind(input.salutation)
    .bind(input.first_name)
    .bind(input.last_name)
    .bind(input.username)
    .bind(input.email)
    .bind(input.phone)
    .bind(input.contract_type)
    .bind(hash)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_write_error)?;

    sqlx::query(
        r#"
        INSERT INTO user_role_assignments (user_id, role_name)
        VALUES ($1, ':admin')
        "#,
    )
    .bind(user_id)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(UserCreateOutput {
        user_id: Id(user_id),
        password,
    })
}

async fn set_admin(
    state: &AppState,
    context: &RequestContext,
    mut input: UserSetAdminInput,
) -> RpcResult<Success> {
    input.tenant = input.tenant.trim().to_lowercase();

    let admin_for = admin_for(state, context).await?;
    ensure_tenant_access(&admin_for, &input.tenant)?;
    let tenant_row = tenant(state, &input.tenant).await?;
    ensure_not_locked(&admin_for, &tenant_row)?;

    let pool = tenant_pool_for_admin(state, &input.tenant, &admin_for).await?;
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(input.user_id.0)
        .fetch_one(&pool)
        .await
        .map_err(internal)?;

    if !exists {
        return Err(not_found());
    }

    if input.admin {
        sqlx::query(
            r#"
            INSERT INTO user_role_assignments (user_id, role_name)
            VALUES ($1, ':admin')
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(input.user_id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;
    } else {
        sqlx::query(
            "DELETE FROM user_role_assignments WHERE user_id = $1 AND role_name = ':admin'",
        )
        .bind(input.user_id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;
    }

    Ok(Success { success: true })
}

async fn reset_password(
    state: &AppState,
    context: &RequestContext,
    mut input: UserResetPasswordInput,
) -> RpcResult<UserResetPasswordOutput> {
    input.tenant = input.tenant.trim().to_lowercase();

    let admin_for = admin_for(state, context).await?;
    ensure_tenant_access(&admin_for, &input.tenant)?;
    let tenant_row = tenant(state, &input.tenant).await?;
    ensure_not_locked(&admin_for, &tenant_row)?;

    let password = match input.password {
        Some(password) => {
            validate_admin_password(&password)?;
            password
        }
        None => generated_password(24)?,
    };
    let hash = password_hash(&password).await?;
    let pool = tenant_pool_for_admin(state, &input.tenant, &admin_for).await?;

    let is_admin = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM users AS user_account
            INNER JOIN user_role_assignments AS assignment
                ON assignment.user_id = user_account.id
               AND assignment.role_name = ':admin'
            WHERE user_account.id = $1
        )
        "#,
    )
    .bind(input.user_id.0)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    if !is_admin {
        let user_exists =
            sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
                .bind(input.user_id.0)
                .fetch_one(&pool)
                .await
                .map_err(internal)?;

        return if user_exists {
            Err(super::common::forbidden())
        } else {
            Err(not_found())
        };
    }

    sqlx::query("UPDATE users SET password = $2 WHERE id = $1")
        .bind(input.user_id.0)
        .bind(hash)
        .execute(&pool)
        .await
        .map_err(internal)?;

    Ok(UserResetPasswordOutput { password })
}

fn map_write_error(error: sqlx::Error) -> crate::error::RpcError {
    if error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
    {
        conflict()
    } else {
        internal(error)
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserListInput {
    tenant: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    search: Option<String>,

    #[serde(default)]
    include_archived: bool,
}

impl UserListInput {
    fn normalize(&mut self) {
        self.tenant = self.tenant.trim().to_lowercase();
        self.search = self
            .search
            .take()
            .map(|search| search.trim().to_lowercase())
            .filter(|search| !search.is_empty());
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserCreateInput {
    tenant: String,
    username: String,
    first_name: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    last_name: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    email: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    phone: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    salutation: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    contract_type: Option<String>,

    #[serde(default)]
    #[ts(optional = nullable)]
    password: Option<String>,
}

impl UserCreateInput {
    fn normalize(&mut self) -> RpcResult<()> {
        self.tenant = self.tenant.trim().to_lowercase();
        self.username = self.username.trim().to_lowercase();

        trim_required(&mut self.username, "username", usize::MAX)?;
        trim_required(&mut self.first_name, "firstName", usize::MAX)?;
        trim_nullable(&mut self.last_name, "lastName", usize::MAX)?;
        trim_nullable(&mut self.phone, "phone", usize::MAX)?;
        trim_nullable(&mut self.salutation, "salutation", usize::MAX)?;

        if let Some(email) = &mut self.email {
            *email = email.trim().to_lowercase();
            if !EmailAddress::is_valid(email) {
                return Err(bad_request("invalid email"));
            }
        }

        let contract_type = self
            .contract_type
            .get_or_insert_with(|| "internal".to_owned());
        if !matches!(
            contract_type.as_str(),
            "internal" | "external" | "subcontractor"
        ) {
            return Err(bad_request("invalid contractType"));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserSetAdminInput {
    tenant: String,
    user_id: Id,
    admin: bool,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserResetPasswordInput {
    tenant: String,
    user_id: Id,

    #[serde(default)]
    #[ts(optional = nullable)]
    password: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct UserCreateOutput {
    user_id: Id,
    password: String,
}

#[derive(Debug, Serialize, TS)]
struct UserResetPasswordOutput {
    password: String,
}

#[derive(FromRow)]
struct AdminUserRow {
    id: i64,
    username: String,
    first_name: String,
    last_name: Option<String>,
    email: Option<String>,
    deactivated_at: Option<DateTime<Utc>>,
    archived_at: Option<DateTime<Utc>>,
    is_admin: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AdminUserSummary {
    id: Id,
    username: String,
    first_name: String,
    last_name: Option<String>,
    email: Option<String>,

    #[ts(type = "Date | null")]
    deactivated_at: Option<DateTime<Utc>>,

    #[ts(type = "Date | null")]
    archived_at: Option<DateTime<Utc>>,

    is_admin: bool,
}

impl From<AdminUserRow> for AdminUserSummary {
    fn from(row: AdminUserRow) -> Self {
        Self {
            id: Id(row.id),
            username: row.username,
            first_name: row.first_name,
            last_name: row.last_name,
            email: row.email,
            deactivated_at: row.deactivated_at,
            archived_at: row.archived_at,
            is_admin: row.is_admin,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::UserCreateInput;

    #[test]
    fn normalizes_admin_created_users() {
        let mut input = UserCreateInput {
            tenant: " ACME ".to_owned(),
            username: " Admin ".to_owned(),
            first_name: "Alice".to_owned(),
            last_name: None,
            email: Some("ALICE@EXAMPLE.TEST".to_owned()),
            phone: None,
            salutation: None,
            contract_type: None,
            password: None,
        };

        input.normalize().expect("valid input");

        assert_eq!(input.tenant, "acme");
        assert_eq!(input.username, "admin");
        assert_eq!(input.email.as_deref(), Some("alice@example.test"));
        assert_eq!(input.contract_type.as_deref(), Some("internal"));
    }
}
