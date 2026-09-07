//! diagrams.net editor sessions backed by the existing project-file storage.
//!
//! diagrams.net runs in embed mode and never owns a sortsys document. The
//! browser receives XML from this API and sends autosaved XML back through the
//! authenticated project-file procedure.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use ts_rs::TS;

use crate::{
    AppState,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    object_storage::{self, Audience, EnabledStorage},
    procedures::project_files::{self, FileAction},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const DRAWIO_MIME_TYPE: &str = "application/vnd.jgraph.mxfile";
const MAX_DIAGRAM_SIZE: usize = 20 * 1024 * 1024;

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let load_state = Arc::clone(&state);

    builder
        .query(
            "projects.files.drawioConfig",
            move |context, input: DrawioConfigInput| {
                let state = Arc::clone(&load_state);

                async move { editor_config(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.files.drawioSave",
            move |context, input: DrawioSaveInput| {
                let state = Arc::clone(&state);

                async move { save(&state, &context, input).await }
            },
        )
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<DrawioConfigInput, DrawioConfigOutput>("projects.files.drawioConfig")
        .mutation_stub::<DrawioSaveInput, DrawioSaveOutput>("projects.files.drawioSave")
}

async fn editor_config(
    state: &AppState,
    context: &RequestContext,
    input: DrawioConfigInput,
) -> RpcResult<DrawioConfigOutput> {
    let configuration = state
        .config
        .drawio
        .as_ref()
        .ok_or_else(|| failed_dependency("diagrams.net is not configured"))?;
    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    project_files::ensure_access(&pool, &auth, input.project_id, FileAction::View, None).await?;

    let file = select_diagram(&pool, input.project_id, input.file_id).await?;
    let can_edit = project_files::access_allowed(
        &pool,
        &auth,
        input.project_id,
        FileAction::Upload,
        file.created_by_user_id,
    )
    .await?;
    let storage = required_storage(state, &auth.tenant).await?;
    let xml = download_xml(&storage, &file).await?;

    Ok(DrawioConfigOutput {
        editor_url: configuration.public_url.to_string(),
        can_edit,
        file_name: file.file_name,
        version: file.office_version,
        xml,
    })
}

async fn save(
    state: &AppState,
    context: &RequestContext,
    input: DrawioSaveInput,
) -> RpcResult<DrawioSaveOutput> {
    validate_xml(&input.xml)?;

    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    project_files::ensure_access(&pool, &auth, input.project_id, FileAction::Upload, None).await?;

    // Locking the row keeps the object upload and revision increment ordered
    // when two browser tabs happen to autosave the same diagram.
    let mut transaction = pool.begin().await.map_err(internal)?;
    let file = sqlx::query_as::<_, DrawioFileRow>(
        r#"
        SELECT
            id,
            project_id,
            object_key,
            file_name,
            mime_type,
            created_by_user_id,
            office_version
        FROM project_files
        WHERE id = $1
          AND project_id = $2
          AND status = 'uploaded'
        FOR UPDATE
        "#,
    )
    .bind(input.file_id.0)
    .bind(input.project_id.0)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    ensure_drawio_file(&file)?;
    debug_assert_eq!(file.project_id, input.project_id.0);

    if file.office_version != input.version {
        return Err(conflict("The diagram was changed in another editor"));
    }

    let storage = required_storage(state, &auth.tenant).await?;
    let etag = upload_xml(&storage, &file.object_key, &input.xml).await?;
    let next_version = file.office_version + 1;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    sqlx::query(
        r#"
        UPDATE project_files
        SET
            office_version = $2,
            office_modified_at = NOW(),
            office_modified_by_user_id = $3,
            modified_at = NOW(),
            size_bytes = $4,
            etag = $5,
            uploaded_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(file.id)
    .bind(next_version)
    .bind(user_id)
    .bind(i64::try_from(input.xml.len()).map_err(internal)?)
    .bind(etag)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;

    transaction.commit().await.map_err(internal)?;

    Ok(DrawioSaveOutput {
        version: next_version,
        saved_at: Utc::now(),
    })
}

async fn select_diagram(pool: &PgPool, project_id: Id, file_id: Id) -> RpcResult<DrawioFileRow> {
    let file = sqlx::query_as::<_, DrawioFileRow>(
        r#"
        SELECT
            id,
            project_id,
            object_key,
            file_name,
            mime_type,
            created_by_user_id,
            office_version
        FROM project_files
        WHERE id = $1
          AND project_id = $2
          AND status = 'uploaded'
        "#,
    )
    .bind(file_id.0)
    .bind(project_id.0)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    ensure_drawio_file(&file)?;
    Ok(file)
}

fn ensure_drawio_file(file: &DrawioFileRow) -> RpcResult<()> {
    if file.file_name.to_ascii_lowercase().ends_with(".drawio")
        || file.mime_type.eq_ignore_ascii_case(DRAWIO_MIME_TYPE)
    {
        Ok(())
    } else {
        Err(bad_request("This file is not a diagrams.net diagram"))
    }
}

fn validate_xml(xml: &str) -> RpcResult<()> {
    if xml.len() > MAX_DIAGRAM_SIZE {
        return Err(payload_too_large());
    }

    let mut value = xml.trim_start_matches('\u{feff}').trim_start();

    // Browser-created diagrams and files exported by diagrams.net commonly
    // include an XML declaration before the mxfile root element.
    if value.starts_with("<?xml") {
        value = value
            .split_once("?>")
            .map(|(_, document)| document.trim_start())
            .ok_or_else(|| bad_request("Invalid diagrams.net document"))?;
    }

    if !value.starts_with("<mxfile") && !value.starts_with("<mxGraphModel") {
        return Err(bad_request("Invalid diagrams.net document"));
    }

    Ok(())
}

async fn download_xml(storage: &EnabledStorage, file: &DrawioFileRow) -> RpcResult<String> {
    let signed = object_storage::create_download_url(
        storage,
        &file.object_key,
        Some(&file.file_name),
        false,
        Audience::Internal,
    )?;
    let response = reqwest::Client::new()
        .get(signed.download_url)
        .send()
        .await
        .map_err(bad_gateway)?;

    if !response.status().is_success() {
        return Err(bad_gateway(format!(
            "Object storage returned {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DIAGRAM_SIZE as u64)
    {
        return Err(payload_too_large());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.try_next().await.map_err(bad_gateway)? {
        if bytes.len() + chunk.len() > MAX_DIAGRAM_SIZE {
            return Err(payload_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }

    let xml = String::from_utf8(bytes).map_err(|_| bad_request("Diagram is not UTF-8 XML"))?;
    validate_xml(&xml)?;
    Ok(xml)
}

async fn upload_xml(
    storage: &EnabledStorage,
    object_key: &str,
    xml: &str,
) -> RpcResult<Option<String>> {
    let signed = object_storage::create_upload_url(
        storage,
        object_key,
        DRAWIO_MIME_TYPE,
        Audience::Internal,
    )?;
    let response = reqwest::Client::new()
        .put(signed.upload_url)
        .header(reqwest::header::CONTENT_TYPE, DRAWIO_MIME_TYPE)
        .body(xml.to_owned())
        .send()
        .await
        .map_err(bad_gateway)?;

    if !response.status().is_success() {
        return Err(bad_gateway(format!(
            "Object storage returned {}",
            response.status()
        )));
    }

    Ok(response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches('"').to_owned()))
}

async fn required_storage(state: &AppState, tenant: &str) -> RpcResult<EnabledStorage> {
    object_storage::tenant_config(&state.tenants, tenant, true)
        .await?
        .ok_or_else(|| failed_dependency("Object storage is not configured"))
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message).with_http_code(400)
}

fn not_found() -> RpcError {
    RpcError::new(ErrorCode::NotFound, "Project file not found").with_http_code(404)
}

fn conflict(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::Conflict, message).with_http_code(409)
}

fn payload_too_large() -> RpcError {
    RpcError::new(ErrorCode::PayloadTooLarge, "Diagram exceeds 20 MiB").with_http_code(413)
}

fn failed_dependency(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, message).with_http_code(424)
}

fn bad_gateway(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string()).with_http_code(502)
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string()).with_http_code(500)
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DrawioConfigInput {
    project_id: Id,
    file_id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DrawioConfigOutput {
    editor_url: String,
    can_edit: bool,
    file_name: String,
    version: i64,
    xml: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DrawioSaveInput {
    project_id: Id,
    file_id: Id,
    version: i64,
    xml: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct DrawioSaveOutput {
    version: i64,

    #[ts(type = "Date")]
    saved_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct DrawioFileRow {
    id: i64,
    project_id: i64,
    object_key: String,
    file_name: String,
    mime_type: String,
    created_by_user_id: Option<i64>,
    office_version: i64,
}

#[cfg(test)]
mod tests {
    use super::validate_xml;

    #[test]
    fn accepts_diagrams_net_xml_and_rejects_unrelated_documents() {
        assert!(validate_xml("<mxfile><diagram /></mxfile>").is_ok());
        assert!(validate_xml("<mxGraphModel />").is_ok());
        assert!(
            validate_xml(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
                 <mxfile host=\"sortsys\"><diagram /></mxfile>",
            )
            .is_ok()
        );
        assert!(validate_xml("<svg />").is_err());
    }
}
