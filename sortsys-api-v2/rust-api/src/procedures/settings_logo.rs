//! Tenant logo upload, generation state, and signed download URLs.

use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, types::Json};
use ts_rs::TS;

use super::common::{bad_request, conflict, forbidden, internal, trim_nullable, trim_required};
use crate::{
    AppState,
    api::Success,
    error::RpcResult,
    object_storage::{self, Audience, EnabledStorage},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const LOGO_SETTING_KEY: &str = "tenant_logo";
const LOGO_JOB_TYPE: &str = "tenant_logo_generate";
static LOGO_NONCE: AtomicU64 = AtomicU64::new(0);

pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let get_state = Arc::clone(&state);
    builder = builder.query("settings.tenantLogo.get", move |context, _input: ()| {
        let state = Arc::clone(&get_state);

        async move { get(&state, &context).await }
    });

    let create_state = Arc::clone(&state);
    builder = builder.mutation(
        "settings.tenantLogo.createUpload",
        move |context, mut input: LogoCreateUploadInput| {
            let state = Arc::clone(&create_state);

            async move {
                input.normalize()?;
                create_upload(&state, &context, input).await
            }
        },
    );

    builder.mutation(
        "settings.tenantLogo.completeUpload",
        move |context, mut input: LogoCompleteUploadInput| {
            let state = Arc::clone(&state);

            async move {
                trim_required(&mut input.generation_id, "generationId", usize::MAX)?;
                trim_nullable(&mut input.etag, "etag", 512)?;

                complete_upload(&state, &context, input).await
            }
        },
    )
}

async fn get(state: &AppState, context: &RequestContext) -> RpcResult<LogoOutput> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let logo = load_state(&pool).await?;

    let (download_url, download_expires_at) = if logo.status == "ready" {
        match logo.object_key.as_deref() {
            Some(object_key) => {
                let storage =
                    object_storage::tenant_config(&state.tenants, &auth.tenant, false).await?;

                if let Some(storage) = storage {
                    let signed = object_storage::create_download_url(
                        &storage,
                        object_key,
                        logo.file_name.as_deref().or(Some("logo.webp")),
                        false,
                        Audience::Public,
                    )?;

                    (Some(signed.download_url), Some(signed.expires_at))
                } else {
                    (None, None)
                }
            }
            None => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(LogoOutput {
        status: logo.status,
        mime_type: logo.mime_type,
        file_name: logo.file_name,
        width: logo.width,
        height: logo.height,
        download_url,
        download_expires_at,
        error: logo.error,
    })
}

async fn create_upload(
    state: &AppState,
    context: &RequestContext,
    input: LogoCreateUploadInput,
) -> RpcResult<LogoCreateUploadOutput> {
    let auth = state.auth.authenticate(&context.headers).await?;
    require_admin(&auth)?;

    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .expect("required object storage");
    let keys = build_logo_keys(&storage, &input.file_name, &input.mime_type);
    let generation_id = generation_id();
    let upload = object_storage::create_upload_url(
        &storage,
        &keys.source_object_key,
        &input.mime_type,
        Audience::Public,
    )?;

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let logo = LogoState {
        generation_id: Some(generation_id.clone()),
        status: "uploading".to_owned(),
        source_object_key: Some(keys.source_object_key),
        source_mime_type: Some(input.mime_type.clone()),
        source_file_name: Some(input.file_name),
        source_size_bytes: input.size_bytes,
        source_etag: None,
        object_key: Some(keys.logo_object_key),
        mime_type: Some("image/webp".to_owned()),
        file_name: Some(keys.logo_file_name),
        uploaded_at: Some(Utc::now()),
        ..LogoState::default()
    };
    save_state(&pool, &logo).await?;

    Ok(LogoCreateUploadOutput {
        generation_id,
        upload_url: upload.upload_url,
        upload_method: "PUT",
        upload_headers: BTreeMap::from([("Content-Type".to_owned(), input.mime_type)]),
        expires_at: upload.expires_at,
    })
}

async fn complete_upload(
    state: &AppState,
    context: &RequestContext,
    input: LogoCompleteUploadInput,
) -> RpcResult<Success> {
    let auth = state.auth.authenticate(&context.headers).await?;
    require_admin(&auth)?;

    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    let mut logo = load_state(&pool).await?;

    if logo.status != "uploading" {
        return Err(bad_request("No tenant logo upload is currently pending."));
    }
    if logo.generation_id.as_deref() != Some(&input.generation_id) {
        return Err(conflict());
    }

    let source_object_key = logo
        .source_object_key
        .clone()
        .ok_or_else(|| bad_request("Tenant logo upload metadata is incomplete."))?;
    let logo_object_key = logo
        .object_key
        .clone()
        .ok_or_else(|| bad_request("Tenant logo upload metadata is incomplete."))?;

    logo.status = "queued".to_owned();
    logo.source_etag = input.etag.or(logo.source_etag);
    logo.error = None;
    save_state(&pool, &logo).await?;

    let payload = json!({
        "generationId": input.generation_id,
        "sourceObjectKey": source_object_key,
        "sourceMimeType": logo.source_mime_type.as_deref().unwrap_or("application/octet-stream"),
        "sourceFileName": logo.source_file_name,
        "logoObjectKey": logo_object_key,
        "logoMimeType": "image/webp",
    });

    if let Err(error) = enqueue_job(state, &auth.tenant, payload).await {
        // Only mark the state failed when this is still the active generation;
        // a newer upload may have replaced it while the master insert failed.
        let current = load_state(&pool).await?;
        if current.generation_id == logo.generation_id {
            let mut failed = current;
            failed.status = "failed".to_owned();
            failed.error = Some(error.to_string().chars().take(5_000).collect());
            let _ = save_state(&pool, &failed).await;
        }

        return Err(error);
    }

    Ok(Success { success: true })
}

async fn load_state(pool: &PgPool) -> RpcResult<LogoState> {
    let value =
        sqlx::query_scalar::<_, Json<Value>>("SELECT name FROM global_settings WHERE key = $1")
            .bind(LOGO_SETTING_KEY)
            .fetch_optional(pool)
            .await
            .map_err(internal)?
            .map(|value| value.0);

    let Some(mut value) = value else {
        return Ok(LogoState::default());
    };

    // The former service stored JSON.stringify(state) in a JSONB column, so
    // deployed databases may contain either a JSON string or a direct object.
    if let Some(encoded) = value.as_str() {
        value = match serde_json::from_str(encoded) {
            Ok(value) => value,
            Err(_) => return Ok(LogoState::default()),
        };
    }

    Ok(serde_json::from_value(value).unwrap_or_default())
}

async fn save_state(pool: &PgPool, logo: &LogoState) -> RpcResult<()> {
    let encoded = serde_json::to_string(logo).map_err(internal)?;

    sqlx::query(
        r#"
        INSERT INTO global_settings (key, name)
        VALUES ($1, $2)
        ON CONFLICT (key)
        DO UPDATE SET name = EXCLUDED.name
        "#,
    )
    .bind(LOGO_SETTING_KEY)
    .bind(Json(Value::String(encoded)))
    .execute(pool)
    .await
    .map_err(internal)?;

    Ok(())
}

async fn enqueue_job(state: &AppState, tenant_name: &str, payload: Value) -> RpcResult<()> {
    sqlx::query(
        r#"
        INSERT INTO __jobs (
            tenant_name,
            type,
            payload,
            max_attempts,
            available_at,
            state,
            updated_at
        )
        VALUES (LOWER($1), $2, $3, 20, NOW(), 'pending', NOW())
        "#,
    )
    .bind(tenant_name)
    .bind(LOGO_JOB_TYPE)
    .bind(Json(payload))
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

fn require_admin(auth: &crate::auth::AuthResult) -> RpcResult<()> {
    if auth.is_admin() {
        Ok(())
    } else {
        Err(forbidden())
    }
}

fn normalize_mime_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

struct LogoKeys {
    source_object_key: String,
    logo_object_key: String,
    logo_file_name: String,
}

fn build_logo_keys(storage: &EnabledStorage, file_name: &str, mime_type: &str) -> LogoKeys {
    let prefix = storage
        .key_prefix
        .as_deref()
        .unwrap_or_default()
        .trim_matches('/');
    let safe_base = safe_file_base(file_name);
    let extension = match mime_type {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    };
    let stamp = Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ");
    let nonce = generation_id();
    let relative_base = format!("organization/logo/{stamp}-{nonce}-{safe_base}");
    let relative_source = format!("{relative_base}.upload.{extension}");
    let relative_logo = format!("{relative_base}.webp");

    let with_prefix = |path: String| {
        if prefix.is_empty() {
            path
        } else {
            format!("{prefix}/{path}")
        }
    };

    LogoKeys {
        source_object_key: with_prefix(relative_source),
        logo_object_key: with_prefix(relative_logo),
        logo_file_name: format!("{safe_base}.webp"),
    }
}

fn safe_file_base(file_name: &str) -> String {
    let final_component = file_name
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    let without_extension = final_component
        .rsplit_once('.')
        .map(|(base, _)| base)
        .unwrap_or(final_component);
    let mut output = String::new();
    let mut previous_separator = false;

    for character in without_extension.chars() {
        let safe = match character {
            character if character.is_ascii_alphanumeric() || "._-".contains(character) => {
                character
            }
            character if character.is_whitespace() => '-',
            character if character.is_control() => continue,
            _ => '_',
        };
        let is_separator = safe == '_' || safe == '-';

        if is_separator && previous_separator {
            continue;
        }

        output.push(safe);
        previous_separator = is_separator;

        if output.len() >= 80 {
            break;
        }
    }

    let output = output.trim_matches(['-', '_', '.']);

    if output.is_empty() {
        "logo".to_owned()
    } else {
        output.to_owned()
    }
}

fn generation_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = LOGO_NONCE.fetch_add(1, Ordering::Relaxed);

    format!("{timestamp:x}-{sequence:x}")
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct LogoState {
    generation_id: Option<String>,
    status: String,
    source_object_key: Option<String>,
    source_mime_type: Option<String>,
    source_file_name: Option<String>,
    source_size_bytes: Option<i64>,
    source_etag: Option<String>,
    object_key: Option<String>,
    mime_type: Option<String>,
    file_name: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    size_bytes: Option<i64>,
    etag: Option<String>,
    uploaded_at: Option<DateTime<Utc>>,
    generated_at: Option<DateTime<Utc>>,
    error: Option<String>,
}

impl Default for LogoState {
    fn default() -> Self {
        Self {
            generation_id: None,
            status: "none".to_owned(),
            source_object_key: None,
            source_mime_type: None,
            source_file_name: None,
            source_size_bytes: None,
            source_etag: None,
            object_key: None,
            mime_type: None,
            file_name: None,
            width: None,
            height: None,
            size_bytes: None,
            etag: None,
            uploaded_at: None,
            generated_at: None,
            error: None,
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogoCreateUploadInput {
    file_name: String,
    mime_type: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    size_bytes: Option<i64>,
}

impl LogoCreateUploadInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.file_name, "fileName", 255)?;

        self.mime_type = normalize_mime_type(&self.mime_type)
            .ok_or_else(|| {
                bad_request("Unsupported MIME type. Allowed: image/png, image/jpeg, image/webp")
            })?
            .to_owned();

        if self
            .size_bytes
            .is_some_and(|size| !(0..=100 * 1024 * 1024).contains(&size))
        {
            return Err(bad_request("invalid sizeBytes"));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogoCompleteUploadInput {
    generation_id: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    etag: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LogoCreateUploadOutput {
    generation_id: String,
    upload_url: String,
    upload_method: &'static str,
    upload_headers: BTreeMap<String, String>,

    #[ts(type = "Date")]
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LogoOutput {
    status: String,
    mime_type: Option<String>,
    file_name: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    download_url: Option<String>,

    #[ts(type = "Date | null")]
    download_expires_at: Option<DateTime<Utc>>,

    error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{LogoCreateUploadInput, LogoState, safe_file_base};

    #[test]
    fn normalizes_logo_mime_aliases_and_file_names() {
        let mut input = LogoCreateUploadInput {
            file_name: "  Acme Logo.JPG  ".to_owned(),
            mime_type: "IMAGE/JPG".to_owned(),
            size_bytes: Some(10),
        };

        input.normalize().expect("valid logo input");

        assert_eq!(input.mime_type, "image/jpeg");
        assert_eq!(safe_file_base(&input.file_name), "Acme-Logo");
    }

    #[test]
    fn missing_logo_state_uses_the_explicit_none_status() {
        assert_eq!(LogoState::default().status, "none");
    }
}
