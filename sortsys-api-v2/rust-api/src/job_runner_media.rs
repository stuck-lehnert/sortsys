//! Media-specific preparation and completion hooks for queued runner jobs.
//!
//! Keeping these details outside the WebSocket state machine makes both pieces
//! easier to audit: this module signs object-storage URLs and updates thumbnail
//! or tenant-logo state, while `job_runners` owns only protocol sequencing.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, types::Json};

use crate::{
    AppState,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    job_queue::{DELIVERY_NOTE_OCR_JOB_TYPE, QueueJob, TENANT_LOGO_JOB_TYPE, THUMBNAIL_JOB_TYPE},
    object_storage::{self, Audience, EnabledStorage},
};

pub async fn prepare(state: &AppState, job: &QueueJob) -> RpcResult<Value> {
    let mut payload = object(job.payload.0.clone())?;

    match job.r#type.as_str() {
        THUMBNAIL_JOB_TYPE => {
            let media: ThumbnailPayload = parse(job.payload.0.clone())?;
            media.validate()?;
            let storage = required_storage(state, &job.tenant_name).await?;

            add_thumbnail_urls(&mut payload, &storage, media)?;
        }
        TENANT_LOGO_JOB_TYPE => {
            let media: LogoPayload = parse(job.payload.0.clone())?;
            media.validate()?;
            let storage = required_storage(state, &job.tenant_name).await?;

            add_logo_urls(&mut payload, &storage, media)?;
        }
        DELIVERY_NOTE_OCR_JOB_TYPE => {
            let media: DeliveryNoteOcrPayload = parse(job.payload.0.clone())?;
            media.validate()?;
            let storage = required_storage(state, &job.tenant_name).await?;

            add_delivery_note_ocr_url(&mut payload, &storage, media)?;
        }
        _ => {}
    }

    Ok(json!({
        "id": job.id.to_string(),
        "type": job.r#type,
        "tenantName": job.tenant_name,
        "attempts": job.attempts,
        "leaseExpiresAt": job.lease_expires_at,
        "payload": payload,
    }))
}

pub async fn mark_processing(state: &AppState, job: &QueueJob) -> RpcResult<()> {
    match job.r#type.as_str() {
        THUMBNAIL_JOB_TYPE => {
            let payload: ThumbnailPayload = parse(job.payload.0.clone())?;
            set_thumbnail_status(state, &job.tenant_name, &payload, "processing", None).await
        }
        TENANT_LOGO_JOB_TYPE => {
            let payload: LogoPayload = parse(job.payload.0.clone())?;
            set_logo_status(state, &job.tenant_name, &payload, "processing", None, None).await
        }
        _ => Ok(()),
    }
}

pub async fn complete(state: &AppState, job: &QueueJob, result: &Value) -> RpcResult<()> {
    match job.r#type.as_str() {
        THUMBNAIL_JOB_TYPE => {
            let payload: ThumbnailPayload = parse(job.payload.0.clone())?;
            set_thumbnail_status(state, &job.tenant_name, &payload, "ready", Some(result)).await
        }
        TENANT_LOGO_JOB_TYPE => {
            let payload: LogoPayload = parse(job.payload.0.clone())?;
            set_logo_status(
                state,
                &job.tenant_name,
                &payload,
                "ready",
                Some(result),
                None,
            )
            .await?;

            // The converted WebP is a different object; the upload source is
            // temporary and can be removed only after state is safely "ready".
            if payload.source_object_key != payload.logo_object_key
                && let Ok(Some(storage)) =
                    object_storage::tenant_config(&state.tenants, &job.tenant_name, false).await
            {
                let _ = object_storage::delete_object(&storage, &payload.source_object_key).await;
            }

            Ok(())
        }
        _ => Ok(()),
    }
}

pub async fn mark_failed(
    state: &AppState,
    job: &QueueJob,
    should_retry: bool,
    error: Option<&str>,
) -> RpcResult<()> {
    let status = if should_retry { "queued" } else { "failed" };

    match job.r#type.as_str() {
        THUMBNAIL_JOB_TYPE => {
            let payload: ThumbnailPayload = parse(job.payload.0.clone())?;
            set_thumbnail_status(state, &job.tenant_name, &payload, status, None).await
        }
        TENANT_LOGO_JOB_TYPE => {
            let payload: LogoPayload = parse(job.payload.0.clone())?;
            set_logo_status(state, &job.tenant_name, &payload, status, None, error).await
        }
        _ => Ok(()),
    }
}

fn add_thumbnail_urls(
    payload: &mut Map<String, Value>,
    storage: &EnabledStorage,
    media: ThumbnailPayload,
) -> RpcResult<()> {
    let source_download = object_storage::create_download_url(
        storage,
        &media.source_object_key,
        media.source_file_name.as_deref(),
        false,
        Audience::Internal,
    )?;
    let source_upload = object_storage::create_upload_url(
        storage,
        &media.source_object_key,
        "image/webp",
        Audience::Internal,
    )?;
    let thumbnail_upload = object_storage::create_upload_url(
        storage,
        &media.thumbnail_object_key,
        "image/webp",
        Audience::Internal,
    )?;

    payload.insert(
        "sourceWebpFileName".to_owned(),
        json!(
            media
                .source_webp_file_name
                .unwrap_or_else(|| webp_file_name(media.source_file_name.as_deref()))
        ),
    );
    payload.insert(
        "sourceUploadUrl".to_owned(),
        json!(source_upload.upload_url),
    );
    payload.insert("sourceUploadMethod".to_owned(), json!("PUT"));
    payload.insert("sourceUploadHeaders".to_owned(), json!({}));
    payload.insert(
        "sourceUploadExpiresAt".to_owned(),
        json!(source_upload.expires_at),
    );
    payload.insert("thumbnailMimeType".to_owned(), json!("image/webp"));
    payload.insert(
        "sourceDownloadUrl".to_owned(),
        json!(source_download.download_url),
    );
    payload.insert(
        "sourceDownloadExpiresAt".to_owned(),
        json!(source_download.expires_at),
    );
    payload.insert(
        "thumbnailUploadUrl".to_owned(),
        json!(thumbnail_upload.upload_url),
    );
    payload.insert("thumbnailUploadMethod".to_owned(), json!("PUT"));
    payload.insert("thumbnailUploadHeaders".to_owned(), json!({}));
    payload.insert(
        "thumbnailUploadExpiresAt".to_owned(),
        json!(thumbnail_upload.expires_at),
    );

    Ok(())
}

fn add_logo_urls(
    payload: &mut Map<String, Value>,
    storage: &EnabledStorage,
    media: LogoPayload,
) -> RpcResult<()> {
    let source_download = object_storage::create_download_url(
        storage,
        &media.source_object_key,
        media.source_file_name.as_deref(),
        false,
        Audience::Internal,
    )?;
    let logo_upload = object_storage::create_upload_url(
        storage,
        &media.logo_object_key,
        "image/webp",
        Audience::Internal,
    )?;

    payload.insert("logoMimeType".to_owned(), json!("image/webp"));
    payload.insert(
        "sourceDownloadUrl".to_owned(),
        json!(source_download.download_url),
    );
    payload.insert(
        "sourceDownloadExpiresAt".to_owned(),
        json!(source_download.expires_at),
    );
    payload.insert("logoUploadUrl".to_owned(), json!(logo_upload.upload_url));
    payload.insert("logoUploadMethod".to_owned(), json!("PUT"));
    payload.insert("logoUploadHeaders".to_owned(), json!({}));
    payload.insert(
        "logoUploadExpiresAt".to_owned(),
        json!(logo_upload.expires_at),
    );

    Ok(())
}

fn add_delivery_note_ocr_url(
    payload: &mut Map<String, Value>,
    storage: &EnabledStorage,
    media: DeliveryNoteOcrPayload,
) -> RpcResult<()> {
    let source_download = object_storage::create_download_url(
        storage,
        &media.source_object_key,
        media.source_file_name.as_deref(),
        false,
        Audience::Internal,
    )?;

    payload.insert(
        "sourceDownloadUrl".to_owned(),
        json!(source_download.download_url),
    );
    payload.insert(
        "sourceDownloadExpiresAt".to_owned(),
        json!(source_download.expires_at),
    );

    Ok(())
}

async fn required_storage(state: &AppState, tenant: &str) -> RpcResult<EnabledStorage> {
    object_storage::tenant_config(&state.tenants, tenant, true)
        .await?
        .ok_or_else(|| internal("Object storage is not configured for tenant"))
}

async fn set_thumbnail_status(
    state: &AppState,
    tenant: &str,
    payload: &ThumbnailPayload,
    status: &str,
    result: Option<&Value>,
) -> RpcResult<()> {
    let pool = state.tenants.tenant_pool(tenant).await.map_err(internal)?;
    let file_id = Id::decode(&payload.project_file_id).map_err(internal)?;
    let result = result.and_then(Value::as_object);

    let thumbnail_object_key =
        result_text(result, "thumbnailObjectKey").unwrap_or(&payload.thumbnail_object_key);
    let thumbnail_mime_type =
        result_text(result, "thumbnailMimeType").unwrap_or(&payload.thumbnail_mime_type);

    sqlx::query(
        r#"
        UPDATE project_files
        SET
            thumbnail_status = $2,
            thumbnail_generated_at = CASE
                WHEN $2 = 'ready' THEN NOW()
                WHEN $2 = 'failed' THEN NULL
                ELSE thumbnail_generated_at
            END,
            thumbnail_object_key = CASE WHEN $2 = 'ready' THEN $3 ELSE thumbnail_object_key END,
            thumbnail_mime_type = CASE WHEN $2 = 'ready' THEN $4 ELSE thumbnail_mime_type END,
            thumbnail_width = COALESCE($5, thumbnail_width),
            thumbnail_height = COALESCE($6, thumbnail_height),
            thumbnail_size_bytes = COALESCE($7, thumbnail_size_bytes),
            thumbnail_etag = COALESCE($8, thumbnail_etag),
            mime_type = COALESCE($9, mime_type),
            file_name = COALESCE($10, file_name),
            size_bytes = COALESCE($11, size_bytes),
            etag = COALESCE($12, etag)
        WHERE id = $1
        "#,
    )
    .bind(file_id.0)
    .bind(status)
    .bind(thumbnail_object_key)
    .bind(thumbnail_mime_type)
    .bind(result_i64(result, "width"))
    .bind(result_i64(result, "height"))
    .bind(result_i64(result, "sizeBytes"))
    .bind(result_text(result, "etag"))
    .bind(result_text(result, "sourceMimeType"))
    .bind(result_text(result, "sourceFileName"))
    .bind(result_i64(result, "sourceSizeBytes"))
    .bind(result_text(result, "sourceEtag"))
    .execute(&pool)
    .await
    .map_err(internal)?;

    Ok(())
}

async fn set_logo_status(
    state: &AppState,
    tenant: &str,
    payload: &LogoPayload,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
) -> RpcResult<()> {
    let pool = state.tenants.tenant_pool(tenant).await.map_err(internal)?;
    let Some(mut logo) = load_logo_state(&pool).await? else {
        return Ok(());
    };

    // A newer upload can supersede a queued job. Never let that stale worker
    // overwrite the current generation's state.
    if logo.generation_id.as_deref() != Some(&payload.generation_id) {
        return Ok(());
    }

    let result = result.and_then(Value::as_object);
    logo.status = status.to_owned();

    if status == "ready" {
        logo.object_key = Some(
            result_text(result, "logoObjectKey")
                .unwrap_or(&payload.logo_object_key)
                .to_owned(),
        );
        logo.mime_type = Some(
            result_text(result, "logoMimeType")
                .unwrap_or(&payload.logo_mime_type)
                .to_owned(),
        );
        logo.generated_at = Some(Utc::now());
    }

    update_optional(&mut logo.width, result_i32(result, "width"));
    update_optional(&mut logo.height, result_i32(result, "height"));
    update_optional(&mut logo.size_bytes, result_i64(result, "sizeBytes"));
    update_owned(&mut logo.etag, result_text(result, "etag"));
    update_owned(
        &mut logo.source_mime_type,
        result_text(result, "sourceMimeType"),
    );
    update_owned(
        &mut logo.source_file_name,
        result_text(result, "sourceFileName"),
    );
    update_optional(
        &mut logo.source_size_bytes,
        result_i64(result, "sourceSizeBytes"),
    );
    update_owned(&mut logo.source_etag, result_text(result, "sourceEtag"));

    logo.error = if status == "failed" {
        Some(
            error
                .unwrap_or("Logo-Konvertierung fehlgeschlagen")
                .to_owned(),
        )
    } else {
        None
    };

    save_logo_state(&pool, &logo).await
}

async fn load_logo_state(pool: &PgPool) -> RpcResult<Option<LogoState>> {
    let value =
        sqlx::query_scalar::<_, Json<Value>>("SELECT name FROM global_settings WHERE key = $1")
            .bind("tenant_logo")
            .fetch_optional(pool)
            .await
            .map_err(internal)?
            .map(|value| value.0);

    let Some(mut value) = value else {
        return Ok(None);
    };

    // Existing installations may contain JSON.stringify(state) in JSONB.
    if let Some(encoded) = value.as_str() {
        value = serde_json::from_str(encoded).map_err(internal)?;
    }

    Ok(serde_json::from_value(value).ok())
}

async fn save_logo_state(pool: &PgPool, logo: &LogoState) -> RpcResult<()> {
    let encoded = serde_json::to_string(logo).map_err(internal)?;

    sqlx::query(
        r#"
        INSERT INTO global_settings (key, name)
        VALUES ('tenant_logo', $1)
        ON CONFLICT (key)
        DO UPDATE SET name = EXCLUDED.name
        "#,
    )
    .bind(Json(Value::String(encoded)))
    .execute(pool)
    .await
    .map_err(internal)?;

    Ok(())
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> RpcResult<T> {
    serde_json::from_value(value).map_err(internal)
}

fn object(value: Value) -> RpcResult<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| internal("Job payload must be an object"))
}

fn result_text<'a>(result: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a str> {
    result?
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn result_i64(result: Option<&Map<String, Value>>, key: &str) -> Option<i64> {
    result?
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
}

fn result_i32(result: Option<&Map<String, Value>>, key: &str) -> Option<i32> {
    result_i64(result, key).and_then(|value| i32::try_from(value).ok())
}

fn update_owned(target: &mut Option<String>, value: Option<&str>) {
    if let Some(value) = value {
        *target = Some(value.to_owned());
    }
}

fn update_optional<T>(target: &mut Option<T>, value: Option<T>) {
    if let Some(value) = value {
        *target = Some(value);
    }
}

fn webp_file_name(file_name: Option<&str>) -> String {
    let file_name = file_name.unwrap_or("").trim();
    if file_name.is_empty() {
        return "image.webp".to_owned();
    }

    let last_separator = file_name.rfind(['/', '\\']).unwrap_or(0);
    let last_dot = file_name.rfind('.');
    let base = match last_dot.filter(|dot| *dot > last_separator) {
        Some(dot) => &file_name[..dot],
        None => file_name,
    }
    .trim();
    let base = if base.is_empty() { "image" } else { base };

    format!("{}.webp", &base[..base.len().min(250)])
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryNoteOcrPayload {
    source_object_key: String,
    source_mime_type: String,
    source_file_name: Option<String>,
}

impl DeliveryNoteOcrPayload {
    fn validate(&self) -> RpcResult<()> {
        if self.source_object_key.trim().is_empty()
            || !matches!(
                self.source_mime_type.as_str(),
                "application/pdf"
                    | "image/jpeg"
                    | "image/png"
                    | "image/webp"
                    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            )
        {
            return Err(internal("Invalid delivery-note OCR job payload"));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailPayload {
    project_id: String,
    project_file_id: String,
    source_object_key: String,
    source_mime_type: String,
    source_file_name: Option<String>,
    source_webp_file_name: Option<String>,
    thumbnail_object_key: String,

    #[serde(default = "default_webp_mime")]
    thumbnail_mime_type: String,

    #[serde(default = "default_thumbnail_dimension")]
    max_width: i32,

    #[serde(default = "default_thumbnail_dimension")]
    max_height: i32,
}

impl ThumbnailPayload {
    fn validate(&self) -> RpcResult<()> {
        for value in [
            &self.project_id,
            &self.project_file_id,
            &self.source_object_key,
            &self.source_mime_type,
            &self.thumbnail_object_key,
            &self.thumbnail_mime_type,
        ] {
            if value.trim().is_empty() {
                return Err(internal("Invalid thumbnail job payload"));
            }
        }

        if !(1..=4096).contains(&self.max_width) || !(1..=4096).contains(&self.max_height) {
            return Err(internal("Invalid thumbnail dimensions"));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogoPayload {
    generation_id: String,
    source_object_key: String,
    source_mime_type: String,
    source_file_name: Option<String>,
    logo_object_key: String,

    #[serde(default = "default_webp_mime")]
    logo_mime_type: String,
}

impl LogoPayload {
    fn validate(&self) -> RpcResult<()> {
        for value in [
            &self.generation_id,
            &self.source_object_key,
            &self.source_mime_type,
            &self.logo_object_key,
            &self.logo_mime_type,
        ] {
            if value.trim().is_empty() {
                return Err(internal("Invalid logo job payload"));
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
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

fn default_webp_mime() -> String {
    "image/webp".to_owned()
}

const fn default_thumbnail_dimension() -> i32 {
    240
}

#[cfg(test)]
mod tests {
    use super::webp_file_name;

    #[test]
    fn creates_runner_webp_names_like_the_legacy_service() {
        assert_eq!(webp_file_name(Some("plan.v2.png")), "plan.v2.webp");
        assert_eq!(webp_file_name(Some("folder/image")), "folder/image.webp");
        assert_eq!(webp_file_name(None), "image.webp");
    }
}
