//! Project files, upload completion, thumbnails, and signed download URLs.

use std::{collections::BTreeMap, sync::Arc};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use ts_rs::TS;

use super::common::{
    authenticated_pool, bad_request, forbidden, internal, not_found, trim_nullable, trim_required,
};
use crate::{
    AppState,
    api::Success,
    auth::AuthResult,
    error::RpcResult,
    ids::Id,
    object_storage::{self, Audience, EnabledStorage},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const THUMBNAIL_JOB_TYPE: &str = "project_file_thumbnail_generate";

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let list_state = Arc::clone(&state);
    let upload_state = Arc::clone(&state);
    let complete_state = Arc::clone(&state);

    builder
        .query(
            "projects.files.list",
            move |context, input: ProjectFilesInput| {
                let state = Arc::clone(&list_state);

                async move { list(&state, &context, input.project_id).await }
            },
        )
        .mutation(
            "projects.files.createUpload",
            move |context, mut input: CreateUploadInput| {
                let state = Arc::clone(&upload_state);

                async move {
                    input.normalize()?;
                    create_upload(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.files.completeUpload",
            move |context, mut input: CompleteUploadInput| {
                let state = Arc::clone(&complete_state);

                async move {
                    trim_nullable(&mut input.etag, "etag", 512)?;
                    complete_upload(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.files.delete",
            move |context, input: DeleteFileInput| {
                let state = Arc::clone(&state);

                async move { delete(&state, &context, input).await }
            },
        )
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    project_id: Id,
) -> RpcResult<Vec<ProjectFile>> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    ensure_access(&pool, &auth, project_id, FileAction::View, None).await?;

    let rows = select_project_files(&pool, project_id).await?;
    build_output_rows(state, &auth.tenant, rows).await
}

pub(crate) async fn load_report_photos(
    state: &AppState,
    tenant_name: &str,
    pool: &PgPool,
    report_ids: &[i64],
) -> RpcResult<Vec<(i64, ProjectFile)>> {
    if report_ids.is_empty() {
        return Ok(Vec::new());
    }

    let rows = sqlx::query_as::<_, ReportPhotoRow>(
        r#"
        SELECT
            relation.report_id,
            file.id,
            file.project_id,
            file.file_name,
            file.mime_type,
            file.kind,
            file.size_bytes,
            file.status,
            file.thumbnail_status,
            file.thumbnail_object_key,
            file.thumbnail_width,
            file.thumbnail_height,
            file.created_by_user_id,
            file.created_at,
            file.uploaded_at,
            file.object_key
        FROM daily_project_report_files AS relation
        INNER JOIN project_files AS file
            ON file.id = relation.project_file_id
        WHERE relation.report_id = ANY($1)
          AND file.status = 'uploaded'
          AND file.kind = 'image'
        ORDER BY relation.created_at, file.id
        "#,
    )
    .bind(report_ids)
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    let report_ids = rows.iter().map(|row| row.report_id).collect::<Vec<_>>();
    let files = rows.into_iter().map(|row| row.file).collect::<Vec<_>>();
    let files = build_output_rows(state, tenant_name, files).await?;

    Ok(report_ids.into_iter().zip(files).collect())
}

async fn select_project_files(pool: &PgPool, project_id: Id) -> RpcResult<Vec<ProjectFileRow>> {
    sqlx::query_as::<_, ProjectFileRow>(
        r#"
        SELECT
            file.id,
            file.project_id,
            file.file_name,
            file.mime_type,
            file.kind,
            file.size_bytes,
            file.status,
            file.thumbnail_status,
            file.thumbnail_object_key,
            file.thumbnail_width,
            file.thumbnail_height,
            file.created_by_user_id,
            file.created_at,
            file.uploaded_at,
            file.object_key
        FROM project_files AS file
        WHERE file.project_id = $1
          AND file.status = 'uploaded'
        ORDER BY file.created_at DESC, file.id DESC
        "#,
    )
    .bind(project_id.0)
    .fetch_all(pool)
    .await
    .map_err(internal)
}

async fn build_output_rows(
    state: &AppState,
    tenant_name: &str,
    rows: Vec<ProjectFileRow>,
) -> RpcResult<Vec<ProjectFile>> {
    let storage = object_storage::tenant_config(&state.tenants, tenant_name, false).await?;

    rows.into_iter()
        .map(|row| build_output_row(storage.as_ref(), row))
        .collect()
}

fn build_output_row(
    storage: Option<&EnabledStorage>,
    row: ProjectFileRow,
) -> RpcResult<ProjectFile> {
    let output_kind = if is_dwg(&row.file_name, &row.mime_type) {
        "file".to_owned()
    } else {
        row.kind.clone()
    };
    let is_image = output_kind == "image";

    let mut download_url = None;
    let mut download_expires_at = None;
    let mut download_attachment_url = None;
    let mut download_attachment_expires_at = None;
    let mut thumbnail_url = None;
    let mut thumbnail_expires_at = None;

    if let Some(storage) = storage {
        let inline = object_storage::create_download_url(
            storage,
            &row.object_key,
            Some(&row.file_name),
            false,
            Audience::Public,
        )?;
        download_url = Some(inline.download_url);
        download_expires_at = Some(inline.expires_at);

        let attachment = object_storage::create_download_url(
            storage,
            &row.object_key,
            Some(&row.file_name),
            true,
            Audience::Public,
        )?;
        download_attachment_url = Some(attachment.download_url);
        download_attachment_expires_at = Some(attachment.expires_at);

        if is_image
            && row.thumbnail_status == "ready"
            && let Some(thumbnail_key) = row.thumbnail_object_key.as_deref()
        {
            let thumbnail = object_storage::create_download_url(
                storage,
                thumbnail_key,
                Some(&row.file_name),
                false,
                Audience::Public,
            )?;
            thumbnail_url = Some(thumbnail.download_url);
            thumbnail_expires_at = Some(thumbnail.expires_at);
        }
    }

    let preview_url = is_image
        .then(|| thumbnail_url.clone().or_else(|| download_url.clone()))
        .flatten();
    let preview_expires_at = is_image
        .then(|| thumbnail_expires_at.or(download_expires_at))
        .flatten();

    Ok(ProjectFile {
        id: Id(row.id),
        project_id: Id(row.project_id),
        file_name: row.file_name,
        mime_type: row.mime_type,
        kind: output_kind,
        size_bytes: row.size_bytes,
        status: row.status,
        thumbnail_status: if is_image {
            row.thumbnail_status
        } else {
            "none".to_owned()
        },
        thumbnail_url,
        thumbnail_expires_at,
        preview_url,
        preview_expires_at,
        thumbnail_width: row.thumbnail_width,
        thumbnail_height: row.thumbnail_height,
        created_by_user_id: row.created_by_user_id.map(Id),
        created_at: row.created_at,
        uploaded_at: row.uploaded_at,
        download_url,
        download_expires_at,
        download_attachment_url,
        download_attachment_expires_at,
    })
}

async fn create_upload(
    state: &AppState,
    context: &RequestContext,
    input: CreateUploadInput,
) -> RpcResult<CreateUploadOutput> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let creator_id = auth.user.id.parse::<i64>().map_err(internal)?;

    ensure_access(&pool, &auth, input.project_id, FileAction::Upload, None).await?;

    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .expect("required storage configuration");
    let object_key =
        object_storage::build_project_object_key(&storage, input.project_id, &input.file_name);
    let kind = file_kind(&input.file_name, &input.mime_type);

    let file_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO project_files (
            project_id,
            storage_bucket,
            object_key,
            file_name,
            mime_type,
            kind,
            size_bytes,
            status,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
        RETURNING id
        "#,
    )
    .bind(input.project_id.0)
    .bind(&storage.bucket)
    .bind(&object_key)
    .bind(&input.file_name)
    .bind(&input.mime_type)
    .bind(kind)
    .bind(input.size_bytes)
    .bind(creator_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    let signed = object_storage::create_upload_url(
        &storage,
        &object_key,
        &input.mime_type,
        Audience::Public,
    )?;
    let upload_headers = BTreeMap::from([("Content-Type".to_owned(), input.mime_type)]);

    Ok(CreateUploadOutput {
        file_id: Id(file_id),
        object_key,
        upload_url: signed.upload_url,
        upload_method: "PUT",
        upload_headers,
        expires_at: signed.expires_at,
    })
}

async fn complete_upload(
    state: &AppState,
    context: &RequestContext,
    input: CompleteUploadInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    let row = sqlx::query_as::<_, UploadCompletionRow>(
        r#"
        SELECT
            id,
            project_id,
            created_by_user_id,
            kind,
            object_key,
            mime_type,
            file_name
        FROM project_files
        WHERE id = $1
          AND project_id = $2
        "#,
    )
    .bind(input.file_id.0)
    .bind(input.project_id.0)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    ensure_access(
        &pool,
        &auth,
        input.project_id,
        FileAction::Upload,
        row.created_by_user_id,
    )
    .await?;

    let is_image = row.kind == "image";
    let thumbnail_key =
        is_image.then(|| object_storage::build_thumbnail_object_key(&row.object_key));

    sqlx::query(
        r#"
        UPDATE project_files
        SET
            status = 'uploaded',
            uploaded_at = NOW(),
            etag = $3,
            thumbnail_status = $4,
            thumbnail_object_key = $5,
            thumbnail_mime_type = $6,
            thumbnail_width = NULL,
            thumbnail_height = NULL,
            thumbnail_size_bytes = NULL,
            thumbnail_etag = NULL,
            thumbnail_generated_at = NULL
        WHERE id = $1
          AND project_id = $2
        "#,
    )
    .bind(row.id)
    .bind(row.project_id)
    .bind(input.etag)
    .bind(if is_image { "queued" } else { "none" })
    .bind(&thumbnail_key)
    .bind(is_image.then_some("image/webp"))
    .execute(&pool)
    .await
    .map_err(internal)?;

    if let Some(thumbnail_key) = thumbnail_key {
        let payload = json!({
            "projectId": Id(row.project_id),
            "projectFileId": Id(row.id),
            "sourceObjectKey": row.object_key,
            "sourceMimeType": row.mime_type,
            "sourceFileName": row.file_name,
            "thumbnailObjectKey": thumbnail_key,
            "thumbnailMimeType": "image/webp",
            "maxWidth": 240,
            "maxHeight": 240,
        });

        if let Err(error) = enqueue_job(state, &auth.tenant, THUMBNAIL_JOB_TYPE, payload).await {
            sqlx::query("UPDATE project_files SET thumbnail_status = 'failed' WHERE id = $1")
                .bind(row.id)
                .execute(&pool)
                .await
                .map_err(internal)?;

            return Err(error);
        }
    }

    Ok(Success { success: true })
}

async fn delete(
    state: &AppState,
    context: &RequestContext,
    input: DeleteFileInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    let row = sqlx::query_as::<_, DeleteFileRow>(
        r#"
        SELECT id, object_key, thumbnail_object_key, created_by_user_id
        FROM project_files
        WHERE id = $1
          AND project_id = $2
        "#,
    )
    .bind(input.file_id.0)
    .bind(input.project_id.0)
    .fetch_optional(&pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    ensure_access(
        &pool,
        &auth,
        input.project_id,
        FileAction::Delete,
        row.created_by_user_id,
    )
    .await?;

    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .expect("required storage configuration");

    cancel_thumbnail_jobs(state, &auth.tenant, input.file_id).await?;
    object_storage::delete_object(&storage, &row.object_key).await?;

    if let Some(thumbnail_key) = row.thumbnail_object_key.as_deref() {
        object_storage::delete_object(&storage, thumbnail_key).await?;
    }

    sqlx::query("DELETE FROM project_files WHERE id = $1 AND project_id = $2")
        .bind(row.id)
        .bind(input.project_id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    Ok(Success { success: true })
}

#[derive(Clone, Copy)]
pub(crate) enum FileAction {
    View,
    Upload,
    Delete,
}

pub(crate) async fn ensure_access(
    pool: &PgPool,
    auth: &AuthResult,
    project_id: Id,
    action: FileAction,
    created_by_user_id: Option<i64>,
) -> RpcResult<()> {
    if access_allowed(pool, auth, project_id, action, created_by_user_id).await? {
        Ok(())
    } else {
        Err(forbidden())
    }
}

pub(crate) async fn access_allowed(
    pool: &PgPool,
    auth: &AuthResult,
    project_id: Id,
    action: FileAction,
    created_by_user_id: Option<i64>,
) -> RpcResult<bool> {
    let project_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1)")
            .bind(project_id.0)
            .fetch_one(pool)
            .await
            .map_err(internal)?;

    if !project_exists {
        return Err(not_found());
    }

    if auth.can_do("manage:projects") {
        return Ok(true);
    }

    if matches!(action, FileAction::View) && auth.can_do("view:projects") {
        return Ok(true);
    }

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let assignment = sqlx::query_scalar::<_, String>(
        r#"
        SELECT type
        FROM project_user_assignments
        WHERE project_id = $1
          AND user_id = $2
        "#,
    )
    .bind(project_id.0)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(internal)?;

    match (action, assignment.as_deref()) {
        (FileAction::View, Some(_)) => Ok(true),
        (FileAction::Upload, Some("leader" | "contributor")) => Ok(true),
        (FileAction::Delete, Some("leader")) => Ok(true),
        (FileAction::Delete, Some("contributor")) if created_by_user_id == Some(user_id) => {
            Ok(true)
        }
        _ => Ok(false),
    }
}

async fn enqueue_job(
    state: &AppState,
    tenant_name: &str,
    job_type: &str,
    payload: Value,
) -> RpcResult<()> {
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
    .bind(job_type)
    .bind(sqlx::types::Json(payload))
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

async fn cancel_thumbnail_jobs(state: &AppState, tenant_name: &str, file_id: Id) -> RpcResult<()> {
    sqlx::query(
        r#"
        UPDATE __jobs
        SET
            state = 'failed',
            finished_at = NOW(),
            acquired_by_runner_id = NULL,
            acquired_at = NULL,
            lease_expires_at = NULL,
            last_error = 'project_file_deleted',
            updated_at = NOW()
        WHERE tenant_name = LOWER($1)
          AND type = $2
          AND payload ->> 'projectFileId' = $3
          AND state IN ('pending', 'processing')
        "#,
    )
    .bind(tenant_name)
    .bind(THUMBNAIL_JOB_TYPE)
    .bind(file_id.encode())
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

fn file_kind(file_name: &str, mime_type: &str) -> &'static str {
    if is_dwg(file_name, mime_type) {
        "file"
    } else if mime_type.to_ascii_lowercase().starts_with("image/") {
        "image"
    } else {
        "file"
    }
}

fn is_dwg(file_name: &str, mime_type: &str) -> bool {
    let file_name = file_name.to_ascii_lowercase();
    let mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    file_name.ends_with(".dwg")
        || matches!(
            mime_type.as_str(),
            "application/acad"
                | "application/x-acad"
                | "application/autocad_dwg"
                | "image/vnd.dwg"
                | "image/x-dwg"
        )
        || mime_type.contains("dwg")
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectFilesInput {
    project_id: Id,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateUploadInput {
    project_id: Id,
    file_name: String,
    mime_type: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    size_bytes: Option<i64>,
}

impl CreateUploadInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.file_name, "fileName", 255)?;
        trim_required(&mut self.mime_type, "mimeType", 255)?;

        if self
            .size_bytes
            .is_some_and(|size| !(0..=512 * 1024 * 1024).contains(&size))
        {
            return Err(bad_request("sizeBytes must be between 0 and 536870912"));
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteUploadInput {
    project_id: Id,
    file_id: Id,

    #[serde(default)]
    #[ts(optional = nullable)]
    etag: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteFileInput {
    project_id: Id,
    file_id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CreateUploadOutput {
    file_id: Id,
    object_key: String,
    upload_url: String,
    upload_method: &'static str,
    upload_headers: BTreeMap<String, String>,

    #[ts(type = "Date")]
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFile {
    id: Id,
    project_id: Id,
    file_name: String,
    mime_type: String,
    kind: String,
    size_bytes: Option<i64>,
    status: String,
    thumbnail_status: String,
    thumbnail_url: Option<String>,

    #[ts(type = "Date | null")]
    thumbnail_expires_at: Option<DateTime<Utc>>,

    preview_url: Option<String>,

    #[ts(type = "Date | null")]
    preview_expires_at: Option<DateTime<Utc>>,

    thumbnail_width: Option<i32>,
    thumbnail_height: Option<i32>,
    created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date | null")]
    uploaded_at: Option<DateTime<Utc>>,

    download_url: Option<String>,

    #[ts(type = "Date | null")]
    download_expires_at: Option<DateTime<Utc>>,

    download_attachment_url: Option<String>,

    #[ts(type = "Date | null")]
    download_attachment_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct ProjectFileRow {
    id: i64,
    project_id: i64,
    file_name: String,
    mime_type: String,
    kind: String,
    size_bytes: Option<i64>,
    status: String,
    thumbnail_status: String,
    thumbnail_object_key: Option<String>,
    thumbnail_width: Option<i32>,
    thumbnail_height: Option<i32>,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    uploaded_at: Option<DateTime<Utc>>,
    object_key: String,
}

#[derive(Debug, FromRow)]
struct ReportPhotoRow {
    report_id: i64,

    #[sqlx(flatten)]
    file: ProjectFileRow,
}

#[derive(Debug, FromRow)]
struct UploadCompletionRow {
    id: i64,
    project_id: i64,
    created_by_user_id: Option<i64>,
    kind: String,
    object_key: String,
    mime_type: String,
    file_name: String,
}

#[derive(Debug, FromRow)]
struct DeleteFileRow {
    id: i64,
    object_key: String,
    thumbnail_object_key: Option<String>,
    created_by_user_id: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::{file_kind, is_dwg};

    #[test]
    fn treats_dwg_uploads_as_files_even_with_image_mime_types() {
        assert!(is_dwg("drawing.DWG", "image/vnd.dwg"));
        assert_eq!(file_kind("drawing.dwg", "image/vnd.dwg"), "file");
        assert_eq!(file_kind("photo.jpg", "image/jpeg"), "image");
    }
}
