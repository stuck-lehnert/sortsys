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
    error::{RpcError, RpcResult},
    ids::Id,
    job_queue::PROJECT_FILE_PDF_EXTRACT_JOB_TYPE,
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
    let delete_state = Arc::clone(&state);
    let rename_state = Arc::clone(&state);
    let move_files_state = Arc::clone(&state);
    let list_folders_state = Arc::clone(&state);
    let create_folder_state = Arc::clone(&state);
    let rename_folder_state = Arc::clone(&state);
    let move_folder_state = Arc::clone(&state);
    let search_state = Arc::clone(&state);

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
                let state = Arc::clone(&delete_state);

                async move { delete(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.files.rename",
            move |context, mut input: RenameFileInput| {
                let state = Arc::clone(&rename_state);

                async move {
                    normalize_item_name(&mut input.file_name, "fileName")?;
                    rename_file(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.files.move",
            move |context, input: MoveFilesInput| {
                let state = Arc::clone(&move_files_state);

                async move { move_files(&state, &context, input).await }
            },
        )
        .query(
            "projects.files.folders.list",
            move |context, input: ProjectFilesInput| {
                let state = Arc::clone(&list_folders_state);

                async move { list_folders(&state, &context, input.project_id).await }
            },
        )
        .mutation(
            "projects.files.folders.create",
            move |context, mut input: CreateFolderInput| {
                let state = Arc::clone(&create_folder_state);

                async move {
                    normalize_item_name(&mut input.name, "name")?;
                    create_folder(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.files.folders.rename",
            move |context, mut input: RenameFolderInput| {
                let state = Arc::clone(&rename_folder_state);

                async move {
                    normalize_item_name(&mut input.name, "name")?;
                    rename_folder(&state, &context, input).await
                }
            },
        )
        .mutation(
            "projects.files.folders.move",
            move |context, input: MoveFolderInput| {
                let state = Arc::clone(&move_folder_state);

                async move { move_folder(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.files.folders.delete",
            move |context, input: DeleteFolderInput| {
                let state = Arc::clone(&state);

                async move { delete_folder(&state, &context, input).await }
            },
        )
        .query(
            "projects.files.search",
            move |context, mut input: SearchProjectFilesInput| {
                let state = Arc::clone(&search_state);

                async move {
                    input.normalize()?;
                    search(&state, &context, input).await
                }
            },
        )
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<RenameFileInput, Success>("projects.files.rename")
        .mutation_stub::<MoveFilesInput, Success>("projects.files.move")
        .query_stub::<ProjectFilesInput, Vec<ProjectFileFolder>>("projects.files.folders.list")
        .mutation_stub::<CreateFolderInput, CreateFolderOutput>("projects.files.folders.create")
        .mutation_stub::<RenameFolderInput, Success>("projects.files.folders.rename")
        .mutation_stub::<MoveFolderInput, Success>("projects.files.folders.move")
        .mutation_stub::<DeleteFolderInput, Success>("projects.files.folders.delete")
        .query_stub::<SearchProjectFilesInput, Vec<ProjectFileSearchResult>>(
            "projects.files.search",
        )
}

async fn list(
    state: &AppState,
    context: &RequestContext,
    project_id: Id,
) -> RpcResult<Vec<ProjectFile>> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    ensure_access(&pool, &auth, project_id, FileAction::View, None).await?;

    queue_pending_pdf_extractions(state, &auth.tenant, &pool, Some(project_id)).await?;

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
            file.folder_id,
            file.file_name,
            file.mime_type,
            file.kind,
            file.size_bytes,
            file.status,
            file.thumbnail_status,
            file.thumbnail_object_key,
            file.thumbnail_width,
            file.thumbnail_height,
            file.text_extraction_status,
            file.created_by_user_id,
            file.created_at,
            file.modified_at,
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
            file.folder_id,
            file.file_name,
            file.mime_type,
            file.kind,
            file.size_bytes,
            file.status,
            file.thumbnail_status,
            file.thumbnail_object_key,
            file.thumbnail_width,
            file.thumbnail_height,
            file.text_extraction_status,
            file.created_by_user_id,
            file.created_at,
            file.modified_at,
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
        folder_id: row.folder_id.map(Id),
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
        text_extraction_status: row.text_extraction_status,
        created_by_user_id: row.created_by_user_id.map(Id),
        created_at: row.created_at,
        modified_at: row.modified_at,
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
    ensure_folder_in_project(&pool, input.project_id, input.folder_id).await?;

    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .expect("required storage configuration");
    let object_key =
        object_storage::build_project_object_key(&storage, input.project_id, &input.file_name);
    let kind = file_kind(&input.file_name, &input.mime_type);

    // Photos keep using the dedicated gallery. A selected folder only applies
    // to document-style attachments, including DWG files.
    let folder_id = (kind == "file").then_some(input.folder_id).flatten();

    let file_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO project_files (
            project_id,
            folder_id,
            storage_bucket,
            object_key,
            file_name,
            mime_type,
            kind,
            size_bytes,
            status,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
        RETURNING id
        "#,
    )
    .bind(input.project_id.0)
    .bind(folder_id.map(|id| id.0))
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
            file_name,
            office_version
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
    let is_pdf = is_pdf(&row.file_name, &row.mime_type);
    let thumbnail_key =
        is_image.then(|| object_storage::build_thumbnail_object_key(&row.object_key));

    sqlx::query(
        r#"
        UPDATE project_files
        SET
            status = 'uploaded',
            uploaded_at = NOW(),
            modified_at = NOW(),
            etag = $3,
            thumbnail_status = $4,
            thumbnail_object_key = $5,
            thumbnail_mime_type = $6,
            thumbnail_width = NULL,
            thumbnail_height = NULL,
            thumbnail_size_bytes = NULL,
            thumbnail_etag = NULL,
            thumbnail_generated_at = NULL,
            text_extraction_status = $7,
            extracted_text = NULL,
            text_extraction_method = NULL,
            text_extraction_confidence = NULL,
            text_extraction_page_count = NULL,
            text_extraction_error = NULL,
            text_extraction_version = NULL,
            text_extracted_at = NULL
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
    .bind(if is_pdf { "queued" } else { "not_applicable" })
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

    if is_pdf {
        let payload = pdf_extraction_payload(
            row.project_id,
            row.id,
            &row.object_key,
            &row.mime_type,
            &row.file_name,
            row.office_version,
        );

        if let Err(error) = enqueue_job(
            state,
            &auth.tenant,
            PROJECT_FILE_PDF_EXTRACT_JOB_TYPE,
            payload,
        )
        .await
        {
            set_text_extraction_failed(&pool, row.id, "OCR job could not be queued").await?;
            return Err(error);
        }
    }

    Ok(Success { success: true })
}

async fn list_folders(
    state: &AppState,
    context: &RequestContext,
    project_id: Id,
) -> RpcResult<Vec<ProjectFileFolder>> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    ensure_access(&pool, &auth, project_id, FileAction::View, None).await?;

    let rows = sqlx::query_as::<_, ProjectFileFolderRow>(
        r#"
        SELECT
            id,
            project_id,
            parent_folder_id,
            name,
            created_by_user_id,
            created_at,
            modified_at
        FROM project_file_folders
        WHERE project_id = $1
        ORDER BY LOWER(name), id
        "#,
    )
    .bind(project_id.0)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(ProjectFileFolder::from).collect())
}

async fn create_folder(
    state: &AppState,
    context: &RequestContext,
    input: CreateFolderInput,
) -> RpcResult<CreateFolderOutput> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let creator_id = auth.user.id.parse::<i64>().map_err(internal)?;

    ensure_access(&pool, &auth, input.project_id, FileAction::Upload, None).await?;
    ensure_folder_in_project(&pool, input.project_id, input.parent_folder_id).await?;

    let folder_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO project_file_folders (
            project_id,
            parent_folder_id,
            name,
            created_by_user_id
        )
        VALUES ($1, $2, $3, $4)
        RETURNING id
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.parent_folder_id.map(|id| id.0))
    .bind(input.name)
    .bind(creator_id)
    .fetch_one(&pool)
    .await
    .map_err(item_write_error)?;

    Ok(CreateFolderOutput { id: Id(folder_id) })
}

async fn rename_folder(
    state: &AppState,
    context: &RequestContext,
    input: RenameFolderInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    ensure_access(&pool, &auth, input.project_id, FileAction::Upload, None).await?;

    let updated = sqlx::query(
        r#"
        UPDATE project_file_folders
        SET
            name = $3,
            modified_at = NOW()
        WHERE id = $1
          AND project_id = $2
        "#,
    )
    .bind(input.folder_id.0)
    .bind(input.project_id.0)
    .bind(input.name)
    .execute(&pool)
    .await
    .map_err(item_write_error)?;

    if updated.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn move_folder(
    state: &AppState,
    context: &RequestContext,
    input: MoveFolderInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    ensure_access(&pool, &auth, input.project_id, FileAction::Upload, None).await?;
    ensure_folder_in_project(&pool, input.project_id, Some(input.folder_id)).await?;
    ensure_folder_in_project(&pool, input.project_id, input.parent_folder_id).await?;

    if input.parent_folder_id == Some(input.folder_id) {
        return Err(bad_request("A folder cannot be moved into itself"));
    }

    if let Some(parent_folder_id) = input.parent_folder_id {
        let destination_is_descendant = sqlx::query_scalar::<_, bool>(
            r#"
            WITH RECURSIVE descendants AS (
                SELECT id
                FROM project_file_folders
                WHERE id = $1
                  AND project_id = $2

                UNION ALL

                SELECT child.id
                FROM project_file_folders AS child
                INNER JOIN descendants AS parent
                    ON child.parent_folder_id = parent.id
                WHERE child.project_id = $2
            )
            SELECT EXISTS (
                SELECT 1
                FROM descendants
                WHERE id = $3
            )
            "#,
        )
        .bind(input.folder_id.0)
        .bind(input.project_id.0)
        .bind(parent_folder_id.0)
        .fetch_one(&pool)
        .await
        .map_err(internal)?;

        if destination_is_descendant {
            return Err(bad_request(
                "A folder cannot be moved into one of its subfolders",
            ));
        }
    }

    sqlx::query(
        r#"
        UPDATE project_file_folders
        SET
            parent_folder_id = $3,
            modified_at = NOW()
        WHERE id = $1
          AND project_id = $2
        "#,
    )
    .bind(input.folder_id.0)
    .bind(input.project_id.0)
    .bind(input.parent_folder_id.map(|id| id.0))
    .execute(&pool)
    .await
    .map_err(item_write_error)?;

    Ok(Success { success: true })
}

async fn delete_folder(
    state: &AppState,
    context: &RequestContext,
    input: DeleteFolderInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    let created_by_user_id = sqlx::query_scalar::<_, Option<i64>>(
        r#"
        SELECT created_by_user_id
        FROM project_file_folders
        WHERE id = $1
          AND project_id = $2
        "#,
    )
    .bind(input.folder_id.0)
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
        created_by_user_id,
    )
    .await?;

    let contains_items = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT
            EXISTS (
                SELECT 1
                FROM project_files
                WHERE project_id = $1
                  AND folder_id = $2
            )
            OR EXISTS (
                SELECT 1
                FROM project_file_folders
                WHERE project_id = $1
                  AND parent_folder_id = $2
            )
        "#,
    )
    .bind(input.project_id.0)
    .bind(input.folder_id.0)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    if contains_items {
        return Err(bad_request("Only empty folders can be deleted"));
    }

    sqlx::query("DELETE FROM project_file_folders WHERE id = $1 AND project_id = $2")
        .bind(input.folder_id.0)
        .bind(input.project_id.0)
        .execute(&pool)
        .await
        .map_err(internal)?;

    Ok(Success { success: true })
}

async fn rename_file(
    state: &AppState,
    context: &RequestContext,
    input: RenameFileInput,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    ensure_access(&pool, &auth, input.project_id, FileAction::Upload, None).await?;

    let updated = sqlx::query(
        r#"
        UPDATE project_files
        SET
            file_name = $3,
            modified_at = NOW()
        WHERE id = $1
          AND project_id = $2
          AND status = 'uploaded'
        "#,
    )
    .bind(input.file_id.0)
    .bind(input.project_id.0)
    .bind(input.file_name)
    .execute(&pool)
    .await
    .map_err(item_write_error)?;

    if updated.rows_affected() == 0 {
        return Err(not_found());
    }

    Ok(Success { success: true })
}

async fn move_files(
    state: &AppState,
    context: &RequestContext,
    input: MoveFilesInput,
) -> RpcResult<Success> {
    if input.file_ids.is_empty() || input.file_ids.len() > 200 {
        return Err(bad_request(
            "fileIds must contain between 1 and 200 entries",
        ));
    }

    let (auth, pool) = authenticated_pool(state, context).await?;

    ensure_access(&pool, &auth, input.project_id, FileAction::Upload, None).await?;
    ensure_folder_in_project(&pool, input.project_id, input.folder_id).await?;

    let file_ids = input.file_ids.iter().map(|id| id.0).collect::<Vec<_>>();
    let movable_file_ids = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT id
        FROM project_files
        WHERE project_id = $1
          AND id = ANY($2)
          AND status = 'uploaded'
          AND kind = 'file'
        "#,
    )
    .bind(input.project_id.0)
    .bind(&file_ids)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    if movable_file_ids.len() != file_ids.len() {
        return Err(bad_request(
            "Only existing document attachments can be moved",
        ));
    }

    sqlx::query(
        r#"
        UPDATE project_files
        SET
            folder_id = $3,
            modified_at = NOW()
        WHERE project_id = $1
          AND id = ANY($2)
        "#,
    )
    .bind(input.project_id.0)
    .bind(&file_ids)
    .bind(input.folder_id.map(|id| id.0))
    .execute(&pool)
    .await
    .map_err(item_write_error)?;

    Ok(Success { success: true })
}

async fn ensure_folder_in_project(
    pool: &PgPool,
    project_id: Id,
    folder_id: Option<Id>,
) -> RpcResult<()> {
    let Some(folder_id) = folder_id else {
        return Ok(());
    };

    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM project_file_folders
            WHERE id = $1
              AND project_id = $2
        )
        "#,
    )
    .bind(folder_id.0)
    .bind(project_id.0)
    .fetch_one(pool)
    .await
    .map_err(internal)?;

    if exists { Ok(()) } else { Err(not_found()) }
}

fn normalize_item_name(value: &mut String, field: &str) -> RpcResult<()> {
    trim_required(value, field, 255)?;

    if matches!(value.as_str(), "." | "..") || value.contains(['/', '\\']) {
        return Err(bad_request(format!("invalid {field}")));
    }

    Ok(())
}

fn item_write_error(error: sqlx::Error) -> RpcError {
    if error
        .as_database_error()
        .is_some_and(|database_error| database_error.is_unique_violation())
    {
        bad_request("An item with this name already exists in the destination folder")
    } else {
        internal(error)
    }
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

    cancel_file_jobs(state, &auth.tenant, input.file_id).await?;
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

async fn search(
    state: &AppState,
    context: &RequestContext,
    input: SearchProjectFilesInput,
) -> RpcResult<Vec<ProjectFileSearchResult>> {
    let (auth, pool) = authenticated_pool(state, context).await?;

    queue_pending_pdf_extractions(state, &auth.tenant, &pool, input.project_id).await?;

    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let can_view_all = auth.can_do("view:projects") || auth.can_do("manage:projects");
    let rows = sqlx::query_as::<_, ProjectFileSearchRow>(
        r#"
        WITH document_query AS (
            SELECT
                WEBSEARCH_TO_TSQUERY('german', $1)
                || WEBSEARCH_TO_TSQUERY('english', $1)
                || PLAINTO_TSQUERY('simple', $1) AS value
        )
        SELECT
            file.id,
            file.project_id,
            project.title AS project_title,
            file.file_name,
            file.mime_type,
            file.modified_at,
            file.text_extraction_status,
            NULLIF(
                TS_HEADLINE(
                    'german',
                    COALESCE(file.extracted_text, ''),
                    document_query.value,
                    'StartSel=<<, StopSel=>>, MaxFragments=3, MaxWords=36, MinWords=12'
                ),
                ''
            ) AS excerpt,
            TS_RANK_CD(file.search_vector, document_query.value)::DOUBLE PRECISION AS rank
        FROM project_files AS file
        INNER JOIN projects AS project
            ON project.id = file.project_id
        CROSS JOIN document_query
        WHERE file.status = 'uploaded'
          AND file.search_vector @@ document_query.value
          AND ($2::BIGINT IS NULL OR file.project_id = $2)
          AND (
              $4
              OR EXISTS (
                  SELECT 1
                  FROM project_user_assignments AS assignment
                  WHERE assignment.project_id = file.project_id
                    AND assignment.user_id = $3
              )
          )
        ORDER BY rank DESC, file.modified_at DESC, file.id DESC
        LIMIT $5
        "#,
    )
    .bind(&input.query)
    .bind(input.project_id.map(|id| id.0))
    .bind(user_id)
    .bind(can_view_all)
    .bind(input.limit)
    .fetch_all(&pool)
    .await
    .map_err(internal)?;

    Ok(rows
        .into_iter()
        .map(ProjectFileSearchResult::from)
        .collect())
}

pub async fn backfill_pdf_text_extraction_jobs(state: &AppState) {
    let tenant_names = match state.tenants.live_tenant_names().await {
        Ok(names) => names,
        Err(error) => {
            tracing::warn!(error = %error, "could not list tenants for PDF text extraction backfill");
            return;
        }
    };

    for tenant_name in tenant_names {
        let pool = match state.tenants.tenant_pool(&tenant_name).await {
            Ok(pool) => pool,
            Err(error) => {
                tracing::warn!(tenant = %tenant_name, error = %error, "could not open tenant for PDF text extraction backfill");
                continue;
            }
        };

        loop {
            match queue_pending_pdf_extractions(state, &tenant_name, &pool, None).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(tenant = %tenant_name, error = %error, "could not queue PDF text extraction backfill");
                    break;
                }
            }
        }
    }
}

async fn queue_pending_pdf_extractions(
    state: &AppState,
    tenant_name: &str,
    pool: &PgPool,
    project_id: Option<Id>,
) -> RpcResult<usize> {
    let files = sqlx::query_as::<_, PendingPdfRow>(
        r#"
        SELECT
            id,
            project_id,
            object_key,
            mime_type,
            file_name,
            office_version
        FROM project_files
        WHERE status = 'uploaded'
          AND text_extraction_status = 'pending'
          AND ($1::BIGINT IS NULL OR project_id = $1)
        ORDER BY id
        LIMIT 50
        "#,
    )
    .bind(project_id.map(|id| id.0))
    .fetch_all(pool)
    .await
    .map_err(internal)?;

    let mut queued_count = 0;

    for file in files {
        let claimed = sqlx::query(
            r#"
            UPDATE project_files
            SET text_extraction_status = 'queued'
            WHERE id = $1
              AND text_extraction_status = 'pending'
            "#,
        )
        .bind(file.id)
        .execute(pool)
        .await
        .map_err(internal)?;

        if claimed.rows_affected() == 0 {
            continue;
        }

        let payload = pdf_extraction_payload(
            file.project_id,
            file.id,
            &file.object_key,
            &file.mime_type,
            &file.file_name,
            file.office_version,
        );

        if let Err(error) = enqueue_job(
            state,
            tenant_name,
            PROJECT_FILE_PDF_EXTRACT_JOB_TYPE,
            payload,
        )
        .await
        {
            sqlx::query(
                "UPDATE project_files SET text_extraction_status = 'pending' WHERE id = $1",
            )
            .bind(file.id)
            .execute(pool)
            .await
            .map_err(internal)?;

            tracing::warn!(
                project_file_id = file.id,
                error = %error,
                "could not queue PDF text extraction"
            );
        } else {
            queued_count += 1;
        }
    }

    Ok(queued_count)
}

pub(crate) async fn queue_pdf_extraction_after_edit(
    state: &AppState,
    tenant_name: &str,
    pool: &PgPool,
    file: PdfExtractionFile<'_>,
) -> RpcResult<()> {
    let payload = pdf_extraction_payload(
        file.project_id,
        file.file_id,
        file.object_key,
        file.mime_type,
        file.file_name,
        file.version,
    );

    sqlx::query(
        r#"
        UPDATE project_files
        SET
            text_extraction_status = 'queued',
            extracted_text = NULL,
            text_extraction_method = NULL,
            text_extraction_confidence = NULL,
            text_extraction_page_count = NULL,
            text_extraction_error = NULL,
            text_extraction_version = NULL,
            text_extracted_at = NULL
        WHERE id = $1
        "#,
    )
    .bind(file.file_id)
    .execute(pool)
    .await
    .map_err(internal)?;

    if let Err(error) = enqueue_job(
        state,
        tenant_name,
        PROJECT_FILE_PDF_EXTRACT_JOB_TYPE,
        payload,
    )
    .await
    {
        sqlx::query("UPDATE project_files SET text_extraction_status = 'pending' WHERE id = $1")
            .bind(file.file_id)
            .execute(pool)
            .await
            .map_err(internal)?;

        return Err(error);
    }

    Ok(())
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

async fn cancel_file_jobs(state: &AppState, tenant_name: &str, file_id: Id) -> RpcResult<()> {
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
          AND type = ANY($2)
          AND payload ->> 'projectFileId' = $3
          AND state IN ('pending', 'processing')
        "#,
    )
    .bind(tenant_name)
    .bind([THUMBNAIL_JOB_TYPE, PROJECT_FILE_PDF_EXTRACT_JOB_TYPE])
    .bind(file_id.encode())
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

async fn set_text_extraction_failed(pool: &PgPool, file_id: i64, error: &str) -> RpcResult<()> {
    sqlx::query(
        r#"
        UPDATE project_files
        SET
            text_extraction_status = 'failed',
            text_extraction_error = $2
        WHERE id = $1
        "#,
    )
    .bind(file_id)
    .bind(error)
    .execute(pool)
    .await
    .map_err(internal)?;

    Ok(())
}

fn pdf_extraction_payload(
    project_id: i64,
    file_id: i64,
    object_key: &str,
    mime_type: &str,
    file_name: &str,
    version: i64,
) -> Value {
    json!({
        "projectId": Id(project_id),
        "projectFileId": Id(file_id),
        "sourceObjectKey": object_key,
        "sourceMimeType": "application/pdf",
        "sourceFileName": file_name,
        "contentVersion": version,
        "originalMimeType": mime_type,
    })
}

pub(crate) fn is_pdf(file_name: &str, mime_type: &str) -> bool {
    file_name.to_ascii_lowercase().ends_with(".pdf")
        || mime_type
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/pdf"))
}

pub(crate) struct PdfExtractionFile<'a> {
    pub project_id: i64,
    pub file_id: i64,
    pub object_key: &'a str,
    pub mime_type: &'a str,
    pub file_name: &'a str,
    pub version: i64,
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
struct SearchProjectFilesInput {
    query: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    project_id: Option<Id>,

    #[serde(default = "default_search_limit")]
    limit: i64,
}

impl SearchProjectFilesInput {
    fn normalize(&mut self) -> RpcResult<()> {
        trim_required(&mut self.query, "query", 200)?;

        if self.query.chars().count() < 2 {
            return Err(bad_request("query must contain at least 2 characters"));
        }

        self.limit = self.limit.clamp(1, 100);
        Ok(())
    }
}

fn default_search_limit() -> i64 {
    50
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateUploadInput {
    project_id: Id,
    file_name: String,
    mime_type: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    folder_id: Option<Id>,

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

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameFileInput {
    project_id: Id,
    file_id: Id,
    file_name: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveFilesInput {
    project_id: Id,
    file_ids: Vec<Id>,

    #[serde(default)]
    #[ts(optional = nullable)]
    folder_id: Option<Id>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateFolderInput {
    project_id: Id,
    name: String,

    #[serde(default)]
    #[ts(optional = nullable)]
    parent_folder_id: Option<Id>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameFolderInput {
    project_id: Id,
    folder_id: Id,
    name: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveFolderInput {
    project_id: Id,
    folder_id: Id,

    #[serde(default)]
    #[ts(optional = nullable)]
    parent_folder_id: Option<Id>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteFolderInput {
    project_id: Id,
    folder_id: Id,
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
struct CreateFolderOutput {
    id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFile {
    id: Id,
    project_id: Id,
    folder_id: Option<Id>,
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
    text_extraction_status: String,
    created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,

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
    folder_id: Option<i64>,
    file_name: String,
    mime_type: String,
    kind: String,
    size_bytes: Option<i64>,
    status: String,
    thumbnail_status: String,
    thumbnail_object_key: Option<String>,
    thumbnail_width: Option<i32>,
    thumbnail_height: Option<i32>,
    text_extraction_status: String,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    uploaded_at: Option<DateTime<Utc>>,
    object_key: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ProjectFileSearchResult {
    id: Id,
    project_id: Id,
    project_title: String,
    file_name: String,
    mime_type: String,
    text_extraction_status: String,
    excerpt: Option<String>,
    rank: f64,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}

impl From<ProjectFileSearchRow> for ProjectFileSearchResult {
    fn from(row: ProjectFileSearchRow) -> Self {
        Self {
            id: Id(row.id),
            project_id: Id(row.project_id),
            project_title: row.project_title,
            file_name: row.file_name,
            mime_type: row.mime_type,
            text_extraction_status: row.text_extraction_status,
            excerpt: row.excerpt,
            rank: row.rank,
            modified_at: row.modified_at,
        }
    }
}

#[derive(Debug, FromRow)]
struct ProjectFileSearchRow {
    id: i64,
    project_id: i64,
    project_title: String,
    file_name: String,
    mime_type: String,
    text_extraction_status: String,
    excerpt: Option<String>,
    rank: f64,
    modified_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct PendingPdfRow {
    id: i64,
    project_id: i64,
    object_key: String,
    mime_type: String,
    file_name: String,
    office_version: i64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ProjectFileFolder {
    id: Id,
    project_id: Id,
    parent_folder_id: Option<Id>,
    name: String,
    created_by_user_id: Option<Id>,

    #[ts(type = "Date")]
    created_at: DateTime<Utc>,

    #[ts(type = "Date")]
    modified_at: DateTime<Utc>,
}

impl From<ProjectFileFolderRow> for ProjectFileFolder {
    fn from(row: ProjectFileFolderRow) -> Self {
        Self {
            id: Id(row.id),
            project_id: Id(row.project_id),
            parent_folder_id: row.parent_folder_id.map(Id),
            name: row.name,
            created_by_user_id: row.created_by_user_id.map(Id),
            created_at: row.created_at,
            modified_at: row.modified_at,
        }
    }
}

#[derive(Debug, FromRow)]
struct ProjectFileFolderRow {
    id: i64,
    project_id: i64,
    parent_folder_id: Option<i64>,
    name: String,
    created_by_user_id: Option<i64>,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
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
    office_version: i64,
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
