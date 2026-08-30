//! ONLYOFFICE editor sessions, protected source downloads, and save callbacks.

use std::{io, path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use futures_util::TryStreamExt;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::io::{ReaderStream, StreamReader};
use ts_rs::TS;
use url::Url;

use crate::{
    AppState,
    config::OnlyOfficeConfig,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    object_storage::{self, Audience},
    procedures::project_files::{self, FileAction},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const CALLBACK_PATH: &str = "/internal/onlyoffice/callback";
const SOURCE_PATH: &str = "/internal/onlyoffice/files/{token}";
const MAX_DOCUMENT_SIZE: u64 = 512 * 1024 * 1024;
const SOURCE_TOKEN_TTL_SECONDS: i64 = 60 * 60;
const CALLBACK_TOKEN_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    builder.query(
        "projects.files.officeConfig",
        move |context, input: EditorConfigInput| {
            let state = Arc::clone(&state);

            async move { editor_config(&state, &context, input).await }
        },
    )
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder.query_stub::<EditorConfigInput, EditorConfigOutput>("projects.files.officeConfig")
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route(SOURCE_PATH, get(download_source))
        .route(CALLBACK_PATH, post(save_callback))
        .with_state(state)
}

async fn editor_config(
    state: &AppState,
    context: &RequestContext,
    input: EditorConfigInput,
) -> RpcResult<EditorConfigOutput> {
    let configuration = state
        .config
        .onlyoffice
        .as_ref()
        .ok_or_else(|| failed_dependency("ONLYOFFICE is not configured"))?;
    let auth = state.auth.authenticate(&context.headers).await?;
    let pool = state
        .tenants
        .tenant_pool(&auth.tenant)
        .await
        .map_err(internal)?;

    project_files::ensure_access(&pool, &auth, input.project_id, FileAction::View, None).await?;

    let file = select_editor_file(&pool, input.project_id, input.file_id).await?;
    let format = office_format(&file.file_name)
        .ok_or_else(|| bad_request("This file type is not supported by ONLYOFFICE"))?;
    let can_edit = project_files::access_allowed(
        &pool,
        &auth,
        input.project_id,
        FileAction::Upload,
        file.created_by_user_id,
    )
    .await?;
    let document_key = document_key(&auth.tenant, file.id, file.office_version);
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let user_name = [
        Some(auth.user.first_name.as_str()),
        auth.user.last_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");

    let source_claims = FileSessionClaims::new(
        &auth.tenant,
        &file,
        user_id,
        can_edit,
        &document_key,
        SOURCE_TOKEN_TTL_SECONDS,
    );
    let source_token = sign(configuration, &source_claims)?;
    let source_url = sibling_url(
        &configuration.callback_url,
        &format!("files/{source_token}"),
    )?;

    let callback_claims = FileSessionClaims::new(
        &auth.tenant,
        &file,
        user_id,
        can_edit,
        &document_key,
        CALLBACK_TOKEN_TTL_SECONDS,
    );
    let callback_token = sign(configuration, &callback_claims)?;
    let mut callback_url = Url::parse(&configuration.callback_url).map_err(internal)?;
    callback_url
        .query_pairs_mut()
        .append_pair("token", &callback_token);

    let mode = if can_edit { "edit" } else { "view" };
    let mut config = json!({
        "documentType": format.document_type,
        "height": "100%",
        "type": "desktop",
        "width": "100%",
        "document": {
            "fileType": format.file_type,
            "key": document_key,
            "permissions": {
                "comment": can_edit,
                "copy": true,
                "download": true,
                "edit": can_edit,
                "fillForms": can_edit,
                "print": true,
                "review": can_edit
            },
            "title": file.file_name,
            "url": source_url
        },
        "editorConfig": {
            "callbackUrl": callback_url.to_string(),
            "coEditing": {
                "change": true,
                "mode": "fast"
            },
            "customization": {
                "autosave": true,
                "forcesave": false
            },
            "lang": normalized_locale(&auth.user.locale),
            "mode": mode,
            "user": {
                "id": auth.user.id,
                "name": user_name
            }
        }
    });
    let config_token = sign(configuration, &config)?;
    config["token"] = Value::String(config_token);

    Ok(EditorConfigOutput {
        api_url: format!(
            "{}/web-apps/apps/api/documents/api.js",
            configuration.public_url
        ),
        can_edit,
        config,
    })
}

async fn download_source(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    match download_source_inner(&state, &token, &headers).await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(message = %error.message, "ONLYOFFICE source download rejected");
            let status = StatusCode::from_u16(error.http_code.unwrap_or(500))
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (status, "Document is unavailable").into_response()
        }
    }
}

async fn download_source_inner(
    state: &AppState,
    token: &str,
    headers: &HeaderMap,
) -> RpcResult<Response> {
    let configuration = state
        .config
        .onlyoffice
        .as_ref()
        .ok_or_else(|| failed_dependency("ONLYOFFICE is not configured"))?;
    validate_outbox_token(configuration, headers, None)?;
    let claims: FileSessionClaims = decode_session_claims(configuration, token)?;
    let pool = state
        .tenants
        .tenant_pool(&claims.tenant)
        .await
        .map_err(internal)?;

    if !current_user_has_file_access(&pool, &claims, false).await? {
        return Err(forbidden("Project-file access has been revoked"));
    }

    let file = select_callback_file(&pool, &claims).await?;
    let storage = object_storage::tenant_config(&state.tenants, &claims.tenant, true)
        .await?
        .expect("required object storage configuration");
    let signed = object_storage::create_download_url(
        &storage,
        &file.object_key,
        None,
        false,
        Audience::Internal,
    )?;
    let upstream = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(internal)?
        .get(signed.download_url)
        .send()
        .await
        .map_err(bad_gateway)?;

    if !upstream.status().is_success() {
        return Err(bad_gateway(format!(
            "Object storage returned {}",
            upstream.status()
        )));
    }

    if upstream
        .content_length()
        .is_some_and(|size| size > MAX_DOCUMENT_SIZE)
    {
        return Err(payload_too_large());
    }

    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&file.mime_type).map_err(internal)?,
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "inline; filename=\"{}\"",
            file.file_name.replace(['\r', '\n', '"'], "")
        ))
        .map_err(internal)?,
    );

    Ok(response)
}

async fn save_callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CallbackQuery>,
    headers: HeaderMap,
    Json(payload): Json<CallbackPayload>,
) -> Json<CallbackResponse> {
    match save_callback_inner(&state, &query.token, &headers, &payload).await {
        Ok(()) => Json(CallbackResponse { error: 0 }),
        Err(error) => {
            tracing::error!(
                status = payload.status,
                key = %payload.key,
                message = %error.message,
                "ONLYOFFICE callback failed"
            );
            Json(CallbackResponse { error: 1 })
        }
    }
}

async fn save_callback_inner(
    state: &AppState,
    token: &str,
    headers: &HeaderMap,
    payload: &CallbackPayload,
) -> RpcResult<()> {
    let configuration = state
        .config
        .onlyoffice
        .as_ref()
        .ok_or_else(|| failed_dependency("ONLYOFFICE is not configured"))?;
    validate_outbox_token(configuration, headers, Some(payload))?;
    let claims: FileSessionClaims = decode_session_claims(configuration, token)?;

    if claims.key != payload.key {
        return Err(forbidden(
            "Document key does not match the callback session",
        ));
    }

    // Status 1 and 4 are presence notifications. Status 3 and 7 report an
    // error that already occurred inside Document Server; acknowledging them
    // avoids an unnecessary callback retry loop.
    if !matches!(payload.status, 2 | 6) {
        return Ok(());
    }

    if !claims.can_edit {
        return Err(forbidden("The editor session is read-only"));
    }

    let download_url = payload
        .url
        .as_deref()
        .ok_or_else(|| bad_request("Save callback has no document URL"))?;
    let pool = state
        .tenants
        .tenant_pool(&claims.tenant)
        .await
        .map_err(internal)?;

    if !current_user_has_file_access(&pool, &claims, true).await? {
        return Err(forbidden("Project-file editing access has been revoked"));
    }

    // A repeated status-2 callback is already committed once the revision has
    // advanced. It is safe to acknowledge it without downloading again.
    let current_version: Option<i64> =
        sqlx::query_scalar("SELECT office_version FROM project_files WHERE id = $1")
            .bind(claims.file_id)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?;
    if payload.status == 2 && current_version.is_some_and(|version| version > claims.version) {
        return Ok(());
    }

    let file = select_callback_file(&pool, &claims).await?;
    let storage = object_storage::tenant_config(&state.tenants, &claims.tenant, true)
        .await?
        .expect("required object storage configuration");
    let safe_download_url = internal_document_url(configuration, download_url)?;
    let temporary = download_document(&safe_download_url).await?;
    let upload_result = upload_document(&storage, &file, &temporary).await;
    let _ = tokio::fs::remove_file(&temporary.path).await;
    let etag = upload_result?;
    let next_version = if payload.status == 2 {
        claims.version + 1
    } else {
        claims.version
    };

    let result = sqlx::query(
        r#"
        UPDATE project_files
        SET
            office_version = $4,
            office_modified_at = NOW(),
            office_modified_by_user_id = $5,
            size_bytes = $6,
            etag = $7,
            uploaded_at = NOW()
        WHERE id = $1
          AND project_id = $2
          AND office_version = $3
          AND status = 'uploaded'
        "#,
    )
    .bind(file.id)
    .bind(file.project_id)
    .bind(claims.version)
    .bind(next_version)
    .bind(claims.user_id)
    .bind(i64::try_from(temporary.size).map_err(internal)?)
    .bind(etag)
    .execute(&pool)
    .await
    .map_err(internal)?;

    if result.rows_affected() == 0 && payload.status == 6 {
        return Err(conflict(
            "The document revision changed while it was being saved",
        ));
    }

    Ok(())
}

async fn select_editor_file(
    pool: &PgPool,
    project_id: Id,
    file_id: Id,
) -> RpcResult<OfficeFileRow> {
    sqlx::query_as::<_, OfficeFileRow>(
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
    .ok_or_else(not_found)
}

async fn select_callback_file(
    pool: &PgPool,
    claims: &FileSessionClaims,
) -> RpcResult<OfficeFileRow> {
    sqlx::query_as::<_, OfficeFileRow>(
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
          AND office_version = $3
          AND status = 'uploaded'
        "#,
    )
    .bind(claims.file_id)
    .bind(claims.project_id)
    .bind(claims.version)
    .fetch_optional(pool)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)
}

async fn download_document(url: &Url) -> RpcResult<TemporaryDocument> {
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(internal)?
        .get(url.clone())
        .send()
        .await
        .map_err(bad_gateway)?;

    if !response.status().is_success() {
        return Err(bad_gateway(format!(
            "Document Server returned {}",
            response.status()
        )));
    }

    if response
        .content_length()
        .is_some_and(|size| size > MAX_DOCUMENT_SIZE)
    {
        return Err(payload_too_large());
    }

    let path = temporary_path()?;
    let mut file = tokio::fs::File::create(&path).await.map_err(internal)?;
    let stream = response.bytes_stream().map_err(io::Error::other);
    let reader = StreamReader::new(stream);
    let mut limited = reader.take(MAX_DOCUMENT_SIZE + 1);
    let size = tokio::io::copy(&mut limited, &mut file)
        .await
        .map_err(internal)?;
    file.flush().await.map_err(internal)?;

    if size > MAX_DOCUMENT_SIZE {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(payload_too_large());
    }

    Ok(TemporaryDocument { path, size })
}

async fn current_user_has_file_access(
    pool: &PgPool,
    claims: &FileSessionClaims,
    edit: bool,
) -> RpcResult<bool> {
    // Editor callbacks outlive the browser request that created them. Re-read
    // the user's current roles and project assignment so a removed role or a
    // deactivated account cannot keep using an otherwise valid session token.
    let allowed = if edit {
        sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM users AS user_account
                WHERE user_account.id = $1
                  AND (
                      user_account.deactivated_at IS NULL
                      OR user_account.deactivated_at > NOW()
                  )
                  AND (
                      EXISTS (
                          SELECT 1
                          FROM user_role_assignments AS role
                          WHERE role.user_id = user_account.id
                            AND role.role_name IN (':admin', 'manage:projects')
                      )
                      OR EXISTS (
                          SELECT 1
                          FROM project_user_assignments AS assignment
                          WHERE assignment.user_id = user_account.id
                            AND assignment.project_id = $2
                            AND assignment.type IN ('leader', 'contributor')
                      )
                  )
            )
            "#,
        )
        .bind(claims.user_id)
        .bind(claims.project_id)
        .fetch_one(pool)
        .await
        .map_err(internal)?
    } else {
        sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM users AS user_account
                WHERE user_account.id = $1
                  AND (user_account.deactivated_at IS NULL OR user_account.deactivated_at > NOW())
                  AND (
                      EXISTS (
                          SELECT 1 FROM user_role_assignments AS role
                          WHERE role.user_id = user_account.id
                            AND role.role_name IN (':admin', 'manage:projects', 'view:projects')
                      )
                      OR EXISTS (
                          SELECT 1 FROM project_user_assignments AS assignment
                          WHERE assignment.user_id = user_account.id AND assignment.project_id = $2
                      )
                  )
            )
            "#,
        )
        .bind(claims.user_id)
        .bind(claims.project_id)
        .fetch_one(pool)
        .await
        .map_err(internal)?
    };

    Ok(allowed)
}

async fn upload_document(
    storage: &object_storage::EnabledStorage,
    file: &OfficeFileRow,
    temporary: &TemporaryDocument,
) -> RpcResult<Option<String>> {
    let signed = object_storage::create_upload_url(
        storage,
        &file.object_key,
        &file.mime_type,
        Audience::Internal,
    )?;
    let source = tokio::fs::File::open(&temporary.path)
        .await
        .map_err(internal)?;
    let response = reqwest::Client::new()
        .put(signed.upload_url)
        .header(header::CONTENT_TYPE, &file.mime_type)
        .header(header::CONTENT_LENGTH, temporary.size)
        .body(reqwest::Body::wrap_stream(ReaderStream::new(source)))
        .send()
        .await
        .map_err(bad_gateway)?;

    if !response.status().is_success() {
        return Err(bad_gateway(format!(
            "Object storage upload returned {}",
            response.status()
        )));
    }

    Ok(response
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned))
}

fn validate_outbox_token(
    configuration: &OnlyOfficeConfig,
    headers: &HeaderMap,
    callback: Option<&CallbackPayload>,
) -> RpcResult<()> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| forbidden("ONLYOFFICE request has no bearer token"))?;
    let signed: Value = decode_outbox_claims(configuration, raw)?;
    let signed_payload = signed.get("payload").unwrap_or(&signed);

    if let Some(callback) = callback {
        let signed_key = signed_payload.get("key").and_then(Value::as_str);
        let signed_status = signed_payload.get("status").and_then(Value::as_i64);

        if signed_key != Some(callback.key.as_str())
            || signed_status != Some(callback.status.into())
        {
            return Err(forbidden(
                "ONLYOFFICE callback token does not match its body",
            ));
        }

        if let Some(url) = callback.url.as_deref()
            && signed_payload.get("url").and_then(Value::as_str) != Some(url)
        {
            return Err(forbidden("ONLYOFFICE callback URL is not signed"));
        }
    }

    Ok(())
}

fn sign<T: Serialize>(configuration: &OnlyOfficeConfig, value: &T) -> RpcResult<String> {
    encode(
        &Header::new(Algorithm::HS256),
        value,
        &EncodingKey::from_secret(&configuration.jwt_secret),
    )
    .map_err(internal)
}

fn decode_session_claims<T: for<'de> Deserialize<'de>>(
    configuration: &OnlyOfficeConfig,
    token: &str,
) -> RpcResult<T> {
    let validation = Validation::new(Algorithm::HS256);

    decode::<T>(
        token,
        &DecodingKey::from_secret(&configuration.jwt_secret),
        &validation,
    )
    .map(|decoded| decoded.claims)
    .map_err(|_| forbidden("Invalid or expired ONLYOFFICE session token"))
}

fn decode_outbox_claims<T: for<'de> Deserialize<'de>>(
    configuration: &OnlyOfficeConfig,
    token: &str,
) -> RpcResult<T> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;

    decode::<T>(
        token,
        &DecodingKey::from_secret(&configuration.jwt_secret),
        &validation,
    )
    .map(|decoded| decoded.claims)
    .map_err(|_| forbidden("Invalid ONLYOFFICE token"))
}

fn sibling_url(callback_url: &str, sibling: &str) -> RpcResult<String> {
    let callback = Url::parse(callback_url).map_err(internal)?;
    callback
        .join(sibling)
        .map(|url| url.to_string())
        .map_err(internal)
}

fn internal_document_url(configuration: &OnlyOfficeConfig, value: &str) -> RpcResult<Url> {
    let requested = Url::parse(value).map_err(|_| bad_request("Invalid document URL"))?;
    let public = Url::parse(&configuration.public_url).map_err(internal)?;
    let internal_origin = Url::parse(&configuration.internal_url).map_err(internal)?;

    if same_origin(&requested, &internal_origin) {
        return Ok(requested);
    }

    if !same_origin(&requested, &public) {
        return Err(forbidden("Document URL does not belong to ONLYOFFICE"));
    }

    let public_base_path = public.path().trim_end_matches('/');
    // Browser-facing URLs include the reverse proxy's /office prefix. The
    // internal Document Server does not know that prefix, so retain only the
    // path below the configured public base before downloading a saved file.
    let requested_path = requested.path();
    let internal_path = if public_base_path.is_empty() {
        requested_path
    } else if requested_path == public_base_path {
        "/"
    } else {
        requested_path
            .strip_prefix(public_base_path)
            .filter(|path| path.starts_with('/'))
            .ok_or_else(|| forbidden("Document URL is outside the ONLYOFFICE public path"))?
    };
    let internal_base_path = internal_origin.path().trim_end_matches('/');
    let rewritten_path = match internal_base_path {
        "" => internal_path.to_owned(),
        base => format!("{base}{internal_path}"),
    };

    let mut rewritten = requested;
    rewritten
        .set_scheme(internal_origin.scheme())
        .map_err(|_| internal("Could not rewrite ONLYOFFICE URL scheme"))?;
    rewritten
        .set_host(internal_origin.host_str())
        .map_err(internal)?;
    rewritten
        .set_port(internal_origin.port())
        .map_err(|_| internal("Could not rewrite ONLYOFFICE URL port"))?;
    rewritten.set_path(&rewritten_path);

    Ok(rewritten)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn document_key(tenant: &str, file_id: i64, version: i64) -> String {
    let tenant_hash = hex::encode(Sha256::digest(tenant.as_bytes()));
    format!(
        "sortsys-{}-{}-v{version}",
        &tenant_hash[..16],
        Id(file_id).encode()
    )
}

fn normalized_locale(locale: &str) -> &'static str {
    if locale == "en" { "en" } else { "de" }
}

fn office_format(file_name: &str) -> Option<OfficeFormat> {
    let extension = file_name.rsplit_once('.')?.1.to_ascii_lowercase();
    let document_type = match extension.as_str() {
        "doc" | "docm" | "docx" | "dot" | "dotm" | "dotx" | "epub" | "fb2" | "fodt" | "hml"
        | "htm" | "html" | "hwp" | "hwpx" | "md" | "mht" | "mhtml" | "odt" | "ott" | "pages"
        | "rtf" | "stw" | "sxw" | "txt" | "wps" | "wpt" => "word",
        "csv" | "et" | "ett" | "fods" | "numbers" | "ods" | "ots" | "sxc" | "xls" | "xlsb"
        | "xlsm" | "xlsx" | "xlt" | "xltm" | "xltx" => "cell",
        "dps" | "dpt" | "fodp" | "key" | "odg" | "odp" | "otp" | "pot" | "potm" | "potx"
        | "pps" | "ppsm" | "ppsx" | "ppt" | "pptm" | "pptx" | "sxi" => "slide",
        "djvu" | "oxps" | "pdf" | "xps" => "pdf",
        "vsdm" | "vsdx" | "vssm" | "vssx" | "vstm" | "vstx" => "diagram",
        _ => return None,
    };

    Some(OfficeFormat {
        document_type,
        file_type: extension,
    })
}

fn temporary_path() -> RpcResult<PathBuf> {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(internal)?;
    Ok(std::env::temp_dir().join(format!("sortsys-onlyoffice-{}", hex::encode(nonce))))
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message).with_http_code(400)
}

fn forbidden(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::Forbidden, message).with_http_code(403)
}

fn not_found() -> RpcError {
    RpcError::new(ErrorCode::NotFound, "Project file not found").with_http_code(404)
}

fn conflict(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::Conflict, message).with_http_code(409)
}

fn payload_too_large() -> RpcError {
    RpcError::new(ErrorCode::PayloadTooLarge, "Document exceeds 512 MiB").with_http_code(413)
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
struct EditorConfigInput {
    project_id: Id,
    file_id: Id,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct EditorConfigOutput {
    api_url: String,
    can_edit: bool,

    #[ts(type = "Record<string, unknown>")]
    config: Value,
}

#[derive(Debug, FromRow)]
struct OfficeFileRow {
    id: i64,
    project_id: i64,
    object_key: String,
    file_name: String,
    mime_type: String,
    created_by_user_id: Option<i64>,
    office_version: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSessionClaims {
    tenant: String,
    file_id: i64,
    project_id: i64,
    user_id: i64,
    version: i64,
    can_edit: bool,
    key: String,
    exp: usize,
}

impl FileSessionClaims {
    fn new(
        tenant: &str,
        file: &OfficeFileRow,
        user_id: i64,
        can_edit: bool,
        key: &str,
        ttl_seconds: i64,
    ) -> Self {
        Self {
            tenant: tenant.to_owned(),
            file_id: file.id,
            project_id: file.project_id,
            user_id,
            version: file.office_version,
            can_edit,
            key: key.to_owned(),
            exp: (Utc::now().timestamp() + ttl_seconds) as usize,
        }
    }
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    token: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct CallbackPayload {
    key: String,
    status: i32,
    url: Option<String>,
}

#[derive(Debug, Serialize)]
struct CallbackResponse {
    error: i32,
}

struct TemporaryDocument {
    path: PathBuf,
    size: u64,
}

struct OfficeFormat {
    document_type: &'static str,
    file_type: String,
}

#[cfg(test)]
mod tests {
    use super::{document_key, internal_document_url, office_format};
    use crate::config::OnlyOfficeConfig;
    use std::sync::Arc;

    #[test]
    fn maps_supported_office_and_pdf_formats() {
        assert_eq!(office_format("Bericht.DOCX").unwrap().document_type, "word");
        assert_eq!(office_format("Kosten.xlsx").unwrap().document_type, "cell");
        assert_eq!(office_format("Plan.pdf").unwrap().document_type, "pdf");
        assert!(office_format("Zeichnung.dwg").is_none());
    }

    #[test]
    fn document_keys_are_tenant_file_and_revision_specific() {
        let first = document_key("tenant-a", 42, 1);
        let second = document_key("tenant-a", 42, 2);
        let other_tenant = document_key("tenant-b", 42, 1);

        assert_ne!(first, second);
        assert_ne!(first, other_tenant);
        assert!(first.len() <= 128);
        assert!(
            first
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || "-._=".contains(value))
        );
    }

    #[test]
    fn callback_downloads_accept_only_the_configured_document_server() {
        let configuration = OnlyOfficeConfig {
            public_url: Arc::from("https://sortsys.example.test/office"),
            internal_url: Arc::from("http://onlyoffice:80"),
            callback_url: Arc::from("http://api:3000/internal/onlyoffice/callback"),
            jwt_secret: Arc::from(b"test-secret".as_slice()),
        };
        let rewritten = internal_document_url(
            &configuration,
            "https://sortsys.example.test/office/cache/files/document.docx?token=one",
        )
        .unwrap();

        assert_eq!(rewritten.scheme(), "http");
        assert_eq!(rewritten.host_str(), Some("onlyoffice"));
        assert_eq!(rewritten.port_or_known_default(), Some(80));
        assert_eq!(rewritten.path(), "/cache/files/document.docx");
        assert_eq!(rewritten.query(), Some("token=one"));
        assert!(
            internal_document_url(
                &configuration,
                "https://sortsys.example.test/office-other/file"
            )
            .is_err()
        );
        assert!(internal_document_url(&configuration, "https://attacker.invalid/file").is_err());
    }
}
