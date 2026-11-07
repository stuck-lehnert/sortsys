//! Versioned, authenticated storage for browser-owned XML editors.
//! Document editing, GAEB rules, canvas rendering and XSD validation stay in the browser.

use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Request},
    middleware::Next,
    response::Response,
};
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use ts_rs::TS;

use crate::{
    AppState,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    object_storage::{self, Audience, EnabledStorage},
    procedures::project_files::{self, FileAction},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const XML_MIME_TYPE: &str = "application/xml";
const MAX_XML_SIZE: usize = 20 * 1024 * 1024;

pub async fn request_body_limit(mut request: Request, next: Next) -> Response {
    // Native X31 documents can contain embedded attachments. Allow the document
    // plus JSON string escaping; retain Axum's default for other RPC requests.
    if request.method() == axum::http::Method::POST
        && request
            .uri()
            .path()
            .trim_start_matches('/')
            .split(',')
            .any(|procedure| {
                matches!(
                    procedure,
                    "projects.files.xmlSave"
                        | "commercial.documents.create"
                        | "commercial.documents.save"
                        | "commercial.cases.adoptContract"
                )
            })
    {
        let multiplier = if request
            .uri()
            .path()
            .contains("commercial.cases.adoptContract")
        {
            4
        } else {
            2
        };
        DefaultBodyLimit::max(MAX_XML_SIZE * multiplier + 2 * 1024 * 1024).apply(&mut request);
    }
    next.run(request).await
}

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let load_state = Arc::clone(&state);

    builder
        .query(
            "projects.files.xmlContent",
            move |context, input: XmlDocumentConfigInput| {
                let state = Arc::clone(&load_state);

                async move { editor_config(&state, &context, input).await }
            },
        )
        .mutation(
            "projects.files.xmlSave",
            move |context, input: XmlDocumentSaveInput| {
                let state = Arc::clone(&state);

                async move { save(&state, &context, input).await }
            },
        )
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<XmlDocumentConfigInput, XmlDocumentConfigOutput>("projects.files.xmlContent")
        .mutation_stub::<XmlDocumentSaveInput, XmlDocumentSaveOutput>("projects.files.xmlSave")
}

async fn editor_config(
    state: &AppState,
    context: &RequestContext,
    input: XmlDocumentConfigInput,
) -> RpcResult<XmlDocumentConfigOutput> {
    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    project_files::ensure_access(&pool, &auth, input.project_id, FileAction::View, None).await?;

    let mut transaction = pool.begin().await.map_err(internal)?;
    let file = select_document(&mut transaction, input.project_id, input.file_id).await?;
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
    transaction.commit().await.map_err(internal)?;

    Ok(XmlDocumentConfigOutput {
        recovery_scope: format!("{}:{}", auth.tenant, auth.user.id),
        live_ticket: crate::xml_live::ticket(state, &auth, input.project_id, input.file_id)?,
        live_path: crate::xml_live::WS_PATH.to_owned(),
        can_edit,
        file_name: file.file_name,
        version: file.office_version,
        xml,
    })
}

async fn save(
    state: &AppState,
    context: &RequestContext,
    input: XmlDocumentSaveInput,
) -> RpcResult<XmlDocumentSaveOutput> {
    validate_xml(&input.xml)?;

    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    // Serialize saves and reject stale revisions before writing a new object.
    // New keys keep a failed database update from corrupting the current file.
    let mut transaction = pool.begin().await.map_err(internal)?;
    let file = sqlx::query_as::<_, XmlDocumentFileRow>(
        r#"
        SELECT
            id,
            project_id,
            object_key,
            file_name,
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

    ensure_xml_file(&file)?;
    project_files::ensure_access(
        &pool,
        &auth,
        input.project_id,
        FileAction::Upload,
        file.created_by_user_id,
    )
    .await?;
    debug_assert_eq!(file.project_id, input.project_id.0);

    if file.office_version != input.version {
        return Err(conflict("The document was changed in another editor"));
    }

    let title = internal_document_title(&input.xml)?;
    let storage = required_storage(state, &auth.tenant).await?;
    let new_key =
        object_storage::build_project_object_key(&storage, input.project_id, &file.file_name);
    let etag = upload_xml(&storage, &new_key, &input.xml).await?;
    let next_version = file.office_version + 1;

    let file_name = title
        .map(|title| {
            let extension = file.file_name.rsplit('.').next().unwrap_or("xml");
            format!("{}.{}", title.replace(['/', '\\'], "-"), extension)
        })
        .unwrap_or_else(|| file.file_name.clone());
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    let updated = sqlx::query(
        r#"
        UPDATE project_files
        SET
            office_version = $2,
            office_modified_at = NOW(),
            office_modified_by_user_id = $3,
            modified_at = NOW(),
            size_bytes = $4,
            etag = $5,
            object_key = $6,
            uploaded_at = NOW(),
            file_name = $7
        WHERE id = $1
        "#,
    )
    .bind(file.id)
    .bind(next_version)
    .bind(user_id)
    .bind(i64::try_from(input.xml.len()).map_err(internal)?)
    .bind(etag)
    .bind(&new_key)
    .bind(&file_name)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = updated {
        let _ = object_storage::delete_object(&storage, &new_key).await;
        return Err(internal(error));
    }
    if let Err(error) = transaction.commit().await {
        // A connection failure can leave the commit outcome unknown. Retain the
        // object: the database may already reference it after a successful commit.
        tracing::warn!(%error, object_key = %new_key, "XML save commit outcome is unknown");
        return Err(internal(error));
    }
    if let Err(error) = object_storage::delete_object(&storage, &file.object_key).await {
        tracing::warn!(%error, "Previous XML object could not be removed");
    }

    Ok(XmlDocumentSaveOutput {
        version: next_version,
        saved_at: Utc::now(),
    })
}

pub(crate) async fn live_version(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    project: Id,
    file: Id,
) -> RpcResult<(crate::auth::AuthResult, i64, bool)> {
    let auth = state.auth.authenticate(headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;
    project_files::ensure_access(&pool, &auth, project, FileAction::View, None).await?;
    let mut connection = pool.acquire().await.map_err(internal)?;
    let document = select_document(&mut connection, project, file).await?;
    let editable = project_files::access_allowed(
        &pool,
        &auth,
        project,
        FileAction::Upload,
        document.created_by_user_id,
    )
    .await?;
    Ok((auth, document.office_version, editable))
}

async fn select_document(
    connection: &mut PgConnection,
    project_id: Id,
    file_id: Id,
) -> RpcResult<XmlDocumentFileRow> {
    let file = sqlx::query_as::<_, XmlDocumentFileRow>(
        r#"
        SELECT
            id,
            project_id,
            object_key,
            file_name,
            created_by_user_id,
            office_version
        FROM project_files
        WHERE id = $1
          AND project_id = $2
          AND status = 'uploaded'
        FOR SHARE
        "#,
    )
    .bind(file_id.0)
    .bind(project_id.0)
    .fetch_optional(connection)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    ensure_xml_file(&file)?;
    Ok(file)
}

fn ensure_xml_file(file: &XmlDocumentFileRow) -> RpcResult<()> {
    let extension = file
        .file_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "xml"
            | "x31"
            | "x52"
            | "x80"
            | "x81"
            | "x82"
            | "x83"
            | "x84"
            | "x85"
            | "x86"
            | "x87"
            | "x89"
            | "x93"
            | "x94"
            | "x96"
            | "x97"
    ) {
        Ok(())
    } else {
        Err(bad_request("This file is not an editable XML document"))
    }
}

// The document format and schema are handled by the browser editor. This
// transport limits memory use and stores the original UTF-8 content verbatim.
pub(crate) fn internal_document_title(xml: &str) -> RpcResult<Option<String>> {
    if !xml.contains("sortsys:document-title:v1:") && !xml.contains("sortsys:takeoff-title:v1:") {
        return Ok(None);
    }
    let parsed =
        roxmltree::Document::parse(xml).map_err(|_| bad_request("Invalid document XML"))?;
    for prefix in ["sortsys:takeoff-title:v1:", "sortsys:document-title:v1:"] {
        if let Some(value) = parsed
            .descendants()
            .filter(|node| node.is_comment())
            .filter_map(|node| node.text())
            .find_map(|text| text.strip_prefix(prefix))
        {
            let decoded = percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .map_err(|_| bad_request("Invalid document title"))?;
            let title = decoded.trim();
            if title.is_empty() || title.chars().count() > 127 || title.contains('\0') {
                return Err(bad_request(
                    "Enter a document title with at most 127 characters",
                ));
            }
            return Ok(Some(title.to_owned()));
        }
    }
    Ok(None)
}

pub(crate) fn validate_xml(xml: &str) -> RpcResult<()> {
    if xml.is_empty() {
        return Err(bad_request("The document is empty"));
    }
    if xml.len() > MAX_XML_SIZE {
        return Err(payload_too_large());
    }
    Ok(())
}

async fn download_xml(storage: &EnabledStorage, file: &XmlDocumentFileRow) -> RpcResult<String> {
    download_xml_object(storage, &file.object_key, &file.file_name).await
}
pub(crate) async fn download_xml_object(
    storage: &EnabledStorage,
    object_key: &str,
    file_name: &str,
) -> RpcResult<String> {
    let signed = object_storage::create_download_url(
        storage,
        object_key,
        Some(file_name),
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
        .is_some_and(|size| size > MAX_XML_SIZE as u64)
    {
        return Err(payload_too_large());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.try_next().await.map_err(bad_gateway)? {
        if bytes.len() + chunk.len() > MAX_XML_SIZE {
            return Err(payload_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }

    let xml = String::from_utf8(bytes).map_err(|_| bad_request("Document is not UTF-8 XML"))?;
    validate_xml(&xml)?;
    Ok(xml)
}

pub(crate) async fn upload_xml(
    storage: &EnabledStorage,
    object_key: &str,
    xml: &str,
) -> RpcResult<Option<String>> {
    let signed =
        object_storage::create_upload_url(storage, object_key, XML_MIME_TYPE, Audience::Internal)?;
    let response = reqwest::Client::new()
        .put(signed.upload_url)
        .header(reqwest::header::CONTENT_TYPE, XML_MIME_TYPE)
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

pub(crate) async fn required_storage(state: &AppState, tenant: &str) -> RpcResult<EnabledStorage> {
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
    RpcError::new(ErrorCode::PayloadTooLarge, "Document exceeds 20 MiB").with_http_code(413)
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
struct XmlDocumentConfigInput {
    project_id: Id,
    file_id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct XmlDocumentConfigOutput {
    recovery_scope: String,
    live_ticket: String,
    live_path: String,
    can_edit: bool,
    file_name: String,
    version: i64,
    xml: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct XmlDocumentSaveInput {
    project_id: Id,
    file_id: Id,
    version: i64,
    xml: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct XmlDocumentSaveOutput {
    version: i64,

    #[ts(type = "Date")]
    saved_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct XmlDocumentFileRow {
    id: i64,
    project_id: i64,
    object_key: String,
    file_name: String,
    created_by_user_id: Option<i64>,
    office_version: i64,
}

#[cfg(test)]
mod title_tests {
    use super::internal_document_title;

    #[test]
    fn native_titles_are_decoded_from_comments_and_measurement_titles_take_precedence() {
        let xml = "<GAEB><!--sortsys:document-title:v1:Alte%20Bezeichnung--><!--sortsys:takeoff-title:v1:Aufma%C3%9F%20S%C3%BCd%20%2D%2D%20November--></GAEB>";
        assert_eq!(
            internal_document_title(xml).unwrap().as_deref(),
            Some("Aufmaß Süd -- November")
        );
        assert_eq!(
            internal_document_title("<GAEB><Name>Keine interne Bezeichnung</Name></GAEB>").unwrap(),
            None
        );
        assert_eq!(
            internal_document_title(
                "<GAEB><![CDATA[<!--sortsys:document-title:v1:Falsch-->]]></GAEB>"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn invalid_or_empty_internal_titles_cannot_rename_documents() {
        for value in ["%FF", "%00", "%20", ""] {
            assert!(
                internal_document_title(&format!(
                    "<GAEB><!--sortsys:document-title:v1:{value}--></GAEB>"
                ))
                .is_err()
            );
        }
        assert!(
            internal_document_title(&format!(
                "<GAEB><!--sortsys:document-title:v1:{}--></GAEB>",
                "x".repeat(128)
            ))
            .is_err()
        );
    }
}
