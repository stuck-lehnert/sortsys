//! Temporary, read-only documents created by browser-side export actions.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use url::Url;

use crate::{
    AppState,
    config::OnlyOfficeConfig,
    error::{ErrorCode, RpcError, RpcResult},
    object_storage::{self, Audience},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const EXPORT_SOURCE_PATH: &str = "/internal/onlyoffice/exports/{token}";
const EXCEL_MIME_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_EXPORT_SIZE: u64 = 128 * 1024 * 1024;
const EXPORT_TOKEN_TTL_SECONDS: i64 = 24 * 60 * 60;

pub fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let upload_state = Arc::clone(&state);

    builder
        .mutation(
            "office.exports.createUpload",
            move |context, mut input: CreateExportUploadInput| {
                let state = Arc::clone(&upload_state);

                async move {
                    input.normalize()?;
                    create_upload(&state, &context, input).await
                }
            },
        )
        .query(
            "office.exports.officeConfig",
            move |context, input: ExportConfigInput| {
                let state = Arc::clone(&state);

                async move { editor_config(&state, &context, input).await }
            },
        )
}

pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<CreateExportUploadInput, CreateExportUploadOutput>(
            "office.exports.createUpload",
        )
        .query_stub::<ExportConfigInput, ExportConfigOutput>("office.exports.officeConfig")
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route(EXPORT_SOURCE_PATH, get(download_source))
        .with_state(state)
}

async fn create_upload(
    state: &AppState,
    context: &RequestContext,
    input: CreateExportUploadInput,
) -> RpcResult<CreateExportUploadOutput> {
    let configuration = configured_onlyoffice(state)?;
    let auth = state.auth.authenticate(&context.headers).await?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;
    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .expect("required object storage configuration");
    let object_key = object_storage::build_export_object_key(&storage, user_id, &input.file_name);
    let document_key = export_document_key(&auth.tenant, &object_key);
    let claims = ExportSessionClaims::new(
        &auth.tenant,
        user_id,
        object_key.clone(),
        input.file_name.clone(),
        input.mime_type.clone(),
        document_key,
    );
    let session_token = sign(configuration, &claims)?;
    let signed = object_storage::create_upload_url(
        &storage,
        &object_key,
        &input.mime_type,
        Audience::Public,
    )?;

    Ok(CreateExportUploadOutput {
        upload_url: signed.upload_url,
        upload_method: "PUT",
        upload_headers: BTreeMap::from([("Content-Type".to_owned(), input.mime_type)]),
        expires_at: signed.expires_at,
        session_token,
    })
}

async fn editor_config(
    state: &AppState,
    context: &RequestContext,
    input: ExportConfigInput,
) -> RpcResult<ExportConfigOutput> {
    let configuration = configured_onlyoffice(state)?;
    let auth = state.auth.authenticate(&context.headers).await?;
    let claims: ExportSessionClaims = decode_claims(configuration, &input.session_token)?;
    let user_id = auth.user.id.parse::<i64>().map_err(internal)?;

    if claims.tenant != auth.tenant || claims.user_id != user_id {
        return Err(forbidden("The export belongs to another user"));
    }

    let source_url = sibling_url(
        &configuration.callback_url,
        &format!("exports/{}", input.session_token),
    )?;

    let user_name = [
        Some(auth.user.first_name.as_str()),
        auth.user.last_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let mut config = json!({
        "documentType": "cell",
        "height": "100%",
        "type": "desktop",
        "width": "100%",
        "document": {
            "fileType": "xlsx",
            "key": claims.key,
            "permissions": {
                "comment": false,
                "copy": true,
                "download": true,
                "edit": false,
                "fillForms": false,
                "print": true,
                "review": false
            },
            "title": claims.file_name,
            "url": source_url
        },
        "editorConfig": {
            "lang": normalized_locale(&auth.user.locale),
            "mode": "view",
            "user": {
                "id": auth.user.id,
                "name": user_name
            }
        }
    });
    let config_token = sign(configuration, &config)?;
    config["token"] = Value::String(config_token);

    Ok(ExportConfigOutput {
        api_url: format!(
            "{}/web-apps/apps/api/documents/api.js",
            configuration.public_url
        ),
        can_edit: false,
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
            tracing::warn!(message = %error.message, "ONLYOFFICE export download rejected");
            let status = StatusCode::from_u16(error.http_code.unwrap_or(500))
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (status, "Export is unavailable").into_response()
        }
    }
}

async fn download_source_inner(
    state: &AppState,
    token: &str,
    headers: &HeaderMap,
) -> RpcResult<Response> {
    let configuration = configured_onlyoffice(state)?;
    validate_outbox_token(configuration, headers)?;
    let claims: ExportSessionClaims = decode_claims(configuration, token)?;
    ensure_user_is_active(state, &claims).await?;

    let storage = object_storage::tenant_config(&state.tenants, &claims.tenant, true)
        .await?
        .expect("required object storage configuration");
    let signed = object_storage::create_download_url(
        &storage,
        &claims.object_key,
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
        .is_some_and(|size| size > MAX_EXPORT_SIZE)
    {
        return Err(payload_too_large());
    }

    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&claims.mime_type).map_err(internal)?,
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "inline; filename=\"{}\"",
            claims.file_name.replace(['\r', '\n', '"'], "")
        ))
        .map_err(internal)?,
    );

    Ok(response)
}

async fn ensure_user_is_active(state: &AppState, claims: &ExportSessionClaims) -> RpcResult<()> {
    let pool = state
        .tenants
        .tenant_pool(&claims.tenant)
        .await
        .map_err(internal)?;
    let active = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM users
            WHERE id = $1
              AND (deactivated_at IS NULL OR deactivated_at > NOW())
        )
        "#,
    )
    .bind(claims.user_id)
    .fetch_one(&pool)
    .await
    .map_err(internal)?;

    if active {
        Ok(())
    } else {
        Err(forbidden("Export access has been revoked"))
    }
}

fn validate_outbox_token(configuration: &OnlyOfficeConfig, headers: &HeaderMap) -> RpcResult<()> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| forbidden("ONLYOFFICE request has no bearer token"))?;
    let _: Value = decode_outbox_claims(configuration, raw)?;

    Ok(())
}

fn configured_onlyoffice(state: &AppState) -> RpcResult<&OnlyOfficeConfig> {
    state
        .config
        .onlyoffice
        .as_ref()
        .ok_or_else(|| failed_dependency("ONLYOFFICE is not configured"))
}

fn sign<T: Serialize>(configuration: &OnlyOfficeConfig, value: &T) -> RpcResult<String> {
    encode(
        &Header::new(Algorithm::HS256),
        value,
        &EncodingKey::from_secret(&configuration.jwt_secret),
    )
    .map_err(internal)
}

fn decode_claims<T: for<'de> Deserialize<'de>>(
    configuration: &OnlyOfficeConfig,
    token: &str,
) -> RpcResult<T> {
    decode::<T>(
        token,
        &DecodingKey::from_secret(&configuration.jwt_secret),
        &Validation::new(Algorithm::HS256),
    )
    .map(|decoded| decoded.claims)
    .map_err(|_| forbidden("Invalid or expired ONLYOFFICE export token"))
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

fn export_document_key(tenant: &str, object_key: &str) -> String {
    let digest = Sha256::digest(format!("{tenant}\0{object_key}").as_bytes());
    format!("sortsys-export-{}", &hex::encode(digest)[..32])
}

fn normalized_locale(locale: &str) -> &'static str {
    if locale == "en" { "en" } else { "de" }
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message).with_http_code(400)
}

fn forbidden(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::Forbidden, message).with_http_code(403)
}

fn payload_too_large() -> RpcError {
    RpcError::new(ErrorCode::PayloadTooLarge, "Export exceeds 128 MiB").with_http_code(413)
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
struct CreateExportUploadInput {
    file_name: String,
    mime_type: String,
    #[ts(type = "number")]
    size_bytes: i64,
}

impl CreateExportUploadInput {
    fn normalize(&mut self) -> RpcResult<()> {
        self.file_name = self.file_name.trim().to_owned();
        self.mime_type = self.mime_type.trim().to_ascii_lowercase();

        if self.file_name.is_empty()
            || self.file_name.len() > 255
            || self.file_name.contains(['/', '\\', '\r', '\n'])
            || !self.file_name.to_ascii_lowercase().ends_with(".xlsx")
        {
            return Err(bad_request("fileName must be a safe .xlsx file name"));
        }

        if self.mime_type != EXCEL_MIME_TYPE {
            return Err(bad_request("mimeType must describe an XLSX workbook"));
        }

        if !(1..=MAX_EXPORT_SIZE as i64).contains(&self.size_bytes) {
            return Err(bad_request("sizeBytes must be between 1 and 134217728"));
        }

        Ok(())
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct CreateExportUploadOutput {
    upload_url: String,
    upload_method: &'static str,
    upload_headers: BTreeMap<String, String>,
    expires_at: DateTime<Utc>,
    session_token: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportConfigInput {
    session_token: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct ExportConfigOutput {
    api_url: String,
    can_edit: bool,

    #[ts(type = "Record<string, unknown>")]
    config: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSessionClaims {
    tenant: String,
    user_id: i64,
    object_key: String,
    file_name: String,
    mime_type: String,
    key: String,
    exp: usize,
}

impl ExportSessionClaims {
    fn new(
        tenant: &str,
        user_id: i64,
        object_key: String,
        file_name: String,
        mime_type: String,
        key: String,
    ) -> Self {
        Self {
            tenant: tenant.to_owned(),
            user_id,
            object_key,
            file_name,
            mime_type,
            key,
            exp: (Utc::now().timestamp() + EXPORT_TOKEN_TTL_SECONDS) as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CreateExportUploadInput, export_document_key, sibling_url};

    #[test]
    fn export_document_keys_are_object_specific() {
        let first = export_document_key("test", "exports/one.xlsx");
        let second = export_document_key("test", "exports/two.xlsx");

        assert_ne!(first, second);
        assert!(first.starts_with("sortsys-export-"));
    }

    #[test]
    fn export_source_urls_use_the_internal_api_origin() {
        let source_url = sibling_url(
            "http://api:3000/internal/onlyoffice/callback",
            "exports/session-token",
        )
        .unwrap();

        assert_eq!(
            source_url,
            "http://api:3000/internal/onlyoffice/exports/session-token"
        );
    }

    #[test]
    fn export_uploads_accept_only_safe_xlsx_files() {
        let mut valid = CreateExportUploadInput {
            file_name: "Kostenübersicht.xlsx".to_owned(),
            mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                .to_owned(),
            size_bytes: 1024,
        };
        assert!(valid.normalize().is_ok());

        valid.file_name = "../Kostenübersicht.xlsx".to_owned();
        assert!(valid.normalize().is_err());
    }
}
