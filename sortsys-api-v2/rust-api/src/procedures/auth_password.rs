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
    let result = sqlx::query("UPDATE users SET password = $2 WHERE username = $1")
        .bind(input.username)
        .bind(password_hash)
        .execute(&pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(not_found());
    }

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
