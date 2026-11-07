//! Password-management procedure.

use std::sync::{Arc, LazyLock};

use bcrypt::hash;
use regex::Regex;
use serde::Deserialize;
use ts_rs::TS;

use super::common::{forbidden, internal, not_found};
use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const PASSWORD_COST: u32 = 12;

static PASSWORD_CHARACTERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z0-9_~§$&+,:;=?@#|'<>.^*()%!{}\[\]-]+$")
        .expect("password character regex must be valid")
});

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.mutation(
        "auth.setPassword",
        move |context: RequestContext, input: SetPasswordInput| {
            let state = Arc::clone(&state);

            async move { set_password(&state, &context, input).await }
        },
    )
}

async fn set_password(
    state: &AppState,
    context: &RequestContext,
    mut input: SetPasswordInput,
) -> RpcResult<Success> {
    input.username = input.username.trim().to_lowercase();
    validate_password(&input.password)?;

    let auth = state.auth.authenticate(&context.headers).await?;
    if !auth.is_admin() && auth.user.username != input.username {
        return Err(forbidden());
    }

    // Bcrypt is CPU-intensive, so hashing must not occupy a Tokio worker.
    let password = input.password;
    let password_hash = tokio::task::spawn_blocking(move || hash(password, PASSWORD_COST))
        .await
        .map_err(internal)?
        .map_err(internal)?;

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let mut transaction = pool.begin().await.map_err(internal)?;
    let user_id =
        sqlx::query_scalar::<_, i64>("SELECT id FROM users WHERE username = $1 FOR UPDATE")
            .bind(&input.username)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(internal)?
            .ok_or_else(not_found)?;
    let session_id = auth.session.id.parse::<i64>().map_err(internal)?;
    // Hashing or waiting for the target's lock may have overlapped a password
    // reset. Recheck the caller after the lock, using a fresh statement snapshot.
    let authorized = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM user_sessions AS session \
         JOIN users AS caller ON caller.id = session.user_id \
         WHERE session.id = $1 AND caller.id = $2 AND caller.deactivated_at IS NULL \
           AND session.created_at < statement_timestamp() \
           AND session.expires_at > statement_timestamp() \
           AND (caller.username = $3 OR EXISTS (SELECT 1 FROM user_role_assignments \
                WHERE user_id = caller.id AND role_name = ':admin')))",
    )
    .bind(session_id)
    .bind(auth.user.id.parse::<i64>().map_err(internal)?)
    .bind(&input.username)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;
    if !authorized {
        return Err(
            RpcError::new(ErrorCode::Unauthorized, "Session no longer authorized")
                .with_http_code(401),
        );
    }
    sqlx::query("UPDATE users SET password = $2 WHERE id = $1")
        .bind(user_id)
        .bind(password_hash)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    let keep_session = if user_id.to_string() == auth.user.id {
        Some(session_id)
    } else {
        None
    };
    crate::auth::expire_user_sessions(&mut transaction, user_id, keep_session)
        .await
        .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;

    Ok(Success { success: true })
}

fn validate_password(password: &str) -> RpcResult<()> {
    let has_valid_length = (10..=2_000).contains(&password.len());
    let has_valid_characters = PASSWORD_CHARACTERS.is_match(password);

    if !has_valid_length || !has_valid_characters {
        return Err(RpcError::new(ErrorCode::BadRequest, "invalid password").with_http_code(400));
    }

    Ok(())
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct SetPasswordInput {
    username: String,
    password: String,
}

#[cfg(test)]
mod tests {
    use super::validate_password;

    #[test]
    fn accepts_the_legacy_password_character_set() {
        assert!(validate_password("Long-enough_password!").is_ok());
        assert!(validate_password("§ecure'password").is_ok());
    }

    #[test]
    fn rejects_short_or_whitespace_passwords() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("contains whitespace").is_err());
    }
}
