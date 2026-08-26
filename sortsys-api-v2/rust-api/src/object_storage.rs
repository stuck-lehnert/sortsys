//! Tenant-scoped S3-compatible object storage.
//!
//! The API only needs presigned PUT/GET URLs and object deletion. Implementing
//! this focused SigV4 surface keeps storage behavior independent from a large
//! provider SDK while remaining compatible with AWS S3 and MinIO.

use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Datelike, Timelike, Utc};
use hmac::{Hmac, Mac};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

use crate::{
    database::TenantStore,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
};

type HmacSha256 = Hmac<Sha256>;

const AWS_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

static OBJECT_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStorageConfig {
    #[serde(default)]
    pub enabled: bool,

    #[serde(default = "default_provider")]
    pub provider: String,

    pub bucket: Option<String>,
    pub region: Option<String>,
    pub endpoint: Option<String>,

    #[serde(default)]
    pub force_path_style: bool,

    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
    pub public_base_url: Option<String>,
    pub key_prefix: Option<String>,

    #[serde(default = "default_upload_ttl")]
    pub upload_url_ttl_sec: u64,

    #[serde(default = "default_download_ttl")]
    pub download_url_ttl_sec: u64,
}

#[derive(Debug, Clone)]
pub struct EnabledStorage {
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub force_path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub public_base_url: Option<String>,
    pub key_prefix: Option<String>,
    pub upload_url_ttl_sec: u64,
    pub download_url_ttl_sec: u64,
}

#[derive(Debug, Clone, Copy)]
pub enum Audience {
    Internal,
    Public,
}

#[derive(Debug)]
pub struct SignedUpload {
    pub upload_url: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct SignedDownload {
    pub download_url: String,
    pub expires_at: DateTime<Utc>,
}

pub async fn tenant_config(
    tenants: &TenantStore,
    tenant_name: &str,
    required: bool,
) -> RpcResult<Option<EnabledStorage>> {
    let tenant = tenants
        .tenant(tenant_name)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            RpcError::new(ErrorCode::Unauthorized, "Unauthorized").with_http_code(401)
        })?;

    let raw_config = tenant
        .connection_details
        .get("objectStorage")
        .cloned()
        .filter(|value| !value.is_null());

    let Some(raw_config) = raw_config else {
        return if required {
            Err(failed_dependency(
                "Object storage is not configured for this tenant",
            ))
        } else {
            Ok(None)
        };
    };

    let config: ObjectStorageConfig = serde_json::from_value(raw_config).map_err(internal)?;

    if !config.enabled {
        return if required {
            Err(failed_dependency(
                "Object storage is not configured for this tenant",
            ))
        } else {
            Ok(None)
        };
    }

    if config.provider != "s3" {
        return Err(failed_dependency("Unsupported object storage provider"));
    }

    let enabled = EnabledStorage {
        bucket: required_text(config.bucket, "bucket")?,
        region: required_text(config.region, "region")?,
        endpoint: nonempty(config.endpoint),
        force_path_style: config.force_path_style,
        access_key_id: required_text(config.access_key_id, "accessKeyId")?,
        secret_access_key: required_text(config.secret_access_key, "secretAccessKey")?,
        session_token: nonempty(config.session_token),
        public_base_url: nonempty(config.public_base_url),
        key_prefix: nonempty(config.key_prefix),
        upload_url_ttl_sec: config.upload_url_ttl_sec.clamp(1, 604_800),
        download_url_ttl_sec: config.download_url_ttl_sec.clamp(1, 604_800),
    };

    Ok(Some(enabled))
}

pub fn build_project_object_key(
    config: &EnabledStorage,
    project_id: Id,
    file_name: &str,
) -> String {
    let prefix = clean_path(config.key_prefix.as_deref().unwrap_or_default());
    let safe_name = normalize_file_name(file_name);
    let now = Utc::now();
    let timestamp = now.format("%Y-%m-%dT%H-%M-%S-%3fZ");
    let nonce = unique_nonce();

    let path = format!(
        "projects/{}/files/{timestamp}-{nonce}-{safe_name}",
        project_id.encode()
    );

    if prefix.is_empty() {
        path
    } else {
        format!("{prefix}/{path}")
    }
}

pub fn build_thumbnail_object_key(source_object_key: &str) -> String {
    format!("{}.thumb.webp", clean_path(source_object_key))
}

pub fn create_upload_url(
    config: &EnabledStorage,
    object_key: &str,
    mime_type: &str,
    audience: Audience,
) -> RpcResult<SignedUpload> {
    let now = Utc::now();
    let upload_url = presign(
        config,
        "PUT",
        object_key,
        config.upload_url_ttl_sec,
        audience,
        &[],
        now,
    )?;

    // Content-Type deliberately remains outside SignedHeaders. Browsers still
    // send the required value, while MinIO and S3 can accept common client-side
    // MIME normalization without invalidating the signature.
    let _ = mime_type;

    Ok(SignedUpload {
        upload_url,
        expires_at: now + chrono::Duration::seconds(config.upload_url_ttl_sec as i64),
    })
}

pub fn create_download_url(
    config: &EnabledStorage,
    object_key: &str,
    file_name: Option<&str>,
    attachment: bool,
    audience: Audience,
) -> RpcResult<SignedDownload> {
    let disposition = match (attachment, file_name) {
        (true, Some(name)) => format!("attachment; filename=\"{}\"", name.replace('"', "")),
        (false, Some(name)) => format!("inline; filename=\"{}\"", name.replace('"', "")),
        (true, None) => "attachment".to_owned(),
        (false, None) => "inline".to_owned(),
    };
    let extra_query = [("response-content-disposition", disposition)];
    let now = Utc::now();

    let download_url = presign(
        config,
        "GET",
        object_key,
        config.download_url_ttl_sec,
        audience,
        &extra_query,
        now,
    )?;

    Ok(SignedDownload {
        download_url,
        expires_at: now + chrono::Duration::seconds(config.download_url_ttl_sec as i64),
    })
}

pub async fn delete_object(config: &EnabledStorage, object_key: &str) -> RpcResult<()> {
    let url = presign(
        config,
        "DELETE",
        object_key,
        60,
        Audience::Internal,
        &[],
        Utc::now(),
    )?;

    let response = reqwest::Client::new()
        .delete(url)
        .send()
        .await
        .map_err(bad_gateway)?;

    if response.status().is_success() || response.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(bad_gateway(format!(
            "Object storage delete failed with status {}",
            response.status()
        )))
    }
}

fn presign(
    config: &EnabledStorage,
    method: &str,
    object_key: &str,
    expires_in_seconds: u64,
    audience: Audience,
    extra_query: &[(&str, String)],
    now: DateTime<Utc>,
) -> RpcResult<String> {
    let (scheme, authority, canonical_uri) = signing_target(config, object_key, audience)?;
    let date = format!("{:04}{:02}{:02}", now.year(), now.month(), now.day());
    let timestamp = format!(
        "{date}T{:02}{:02}{:02}Z",
        now.hour(),
        now.minute(),
        now.second()
    );
    let scope = format!("{date}/{}/s3/aws4_request", config.region);

    let mut query = vec![
        ("X-Amz-Algorithm".to_owned(), "AWS4-HMAC-SHA256".to_owned()),
        (
            "X-Amz-Credential".to_owned(),
            format!("{}/{}", config.access_key_id, scope),
        ),
        ("X-Amz-Date".to_owned(), timestamp.clone()),
        (
            "X-Amz-Expires".to_owned(),
            expires_in_seconds.clamp(1, 604_800).to_string(),
        ),
        ("X-Amz-SignedHeaders".to_owned(), "host".to_owned()),
    ];

    if let Some(session_token) = &config.session_token {
        query.push(("X-Amz-Security-Token".to_owned(), session_token.clone()));
    }

    query.extend(
        extra_query
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone())),
    );

    let canonical_query = canonical_query_string(query);
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\nhost:{authority}\n\nhost\nUNSIGNED-PAYLOAD"
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let date_key = hmac(
        format!("AWS4{}", config.secret_access_key).as_bytes(),
        date.as_bytes(),
    );
    let region_key = hmac(&date_key, config.region.as_bytes());
    let service_key = hmac(&region_key, b"s3");
    let signing_key = hmac(&service_key, b"aws4_request");
    let signature = hex::encode(hmac(&signing_key, string_to_sign.as_bytes()));

    Ok(format!(
        "{scheme}://{authority}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"
    ))
}

fn signing_target(
    config: &EnabledStorage,
    object_key: &str,
    audience: Audience,
) -> RpcResult<(String, String, String)> {
    let configured_endpoint = match audience {
        Audience::Public => config.public_base_url.as_ref().or(config.endpoint.as_ref()),
        Audience::Internal => config.endpoint.as_ref(),
    };

    let endpoint = configured_endpoint
        .cloned()
        .unwrap_or_else(|| format!("https://s3.{}.amazonaws.com", config.region));
    let parsed = Url::parse(endpoint.trim_end_matches('/')).map_err(internal)?;
    let scheme = parsed.scheme().to_owned();
    let host = parsed
        .host_str()
        .ok_or_else(|| internal("object storage endpoint has no host"))?;

    let endpoint_authority = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let endpoint_path = clean_path(parsed.path());
    let object_path = encode_object_key(object_key);

    let use_path_style = config.force_path_style || host.parse::<std::net::IpAddr>().is_ok();
    let (authority, resource_path) = if use_path_style {
        (
            endpoint_authority,
            join_path(&[&endpoint_path, &config.bucket, &object_path]),
        )
    } else {
        (
            format!("{}.{}", config.bucket, endpoint_authority),
            join_path(&[&endpoint_path, &object_path]),
        )
    };

    Ok((scheme, authority, format!("/{resource_path}")))
}

fn canonical_query_string(query: Vec<(String, String)>) -> String {
    let mut encoded = query
        .into_iter()
        .map(|(key, value)| {
            (
                aws_encode(&key).into_owned(),
                aws_encode(&value).into_owned(),
            )
        })
        .collect::<Vec<_>>();

    encoded.sort();

    encoded
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn encode_object_key(key: &str) -> String {
    clean_path(key)
        .split('/')
        .map(|segment| aws_encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn aws_encode(value: &str) -> std::borrow::Cow<'_, str> {
    utf8_percent_encode(value, AWS_ENCODE_SET).into()
}

fn join_path(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|part| clean_path(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn clean_path(value: &str) -> String {
    value.trim_matches('/').to_owned()
}

fn normalize_file_name(file_name: &str) -> String {
    let mut normalized = String::new();
    let mut previous_separator = false;

    for character in file_name.trim().chars() {
        let safe = match character {
            character if character.is_ascii_alphanumeric() || "._-".contains(character) => {
                character
            }
            character if character.is_whitespace() => '-',
            character if character.is_control() => continue,
            _ => '_',
        };

        let separator = safe == '_' || safe == '-';
        if separator && previous_separator {
            continue;
        }

        normalized.push(safe);
        previous_separator = separator;

        if normalized.len() >= 120 {
            break;
        }
    }

    let normalized = normalized.trim_matches(['-', '_', '.']);

    if normalized.is_empty() {
        "file".to_owned()
    } else {
        normalized.to_owned()
    }
}

fn unique_nonce() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = OBJECT_NONCE.fetch_add(1, Ordering::Relaxed);

    format!("{timestamp:x}{sequence:x}")
}

fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn hmac(key: &[u8], value: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts arbitrary key lengths");
    mac.update(value);
    mac.finalize().into_bytes().to_vec()
}

fn required_text(value: Option<String>, field: &str) -> RpcResult<String> {
    nonempty(value).ok_or_else(|| {
        failed_dependency(format!("Object storage is enabled but {field} is missing"))
    })
}

fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
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

fn default_provider() -> String {
    "s3".to_owned()
}

const fn default_upload_ttl() -> u64 {
    15 * 60
}

const fn default_download_ttl() -> u64 {
    15 * 60
}

#[cfg(test)]
mod tests {
    use super::{Audience, EnabledStorage, normalize_file_name, presign};
    use chrono::{TimeZone, Utc};

    fn config() -> EnabledStorage {
        EnabledStorage {
            bucket: "test-bucket".to_owned(),
            region: "us-east-1".to_owned(),
            endpoint: Some("http://127.0.0.1:9000".to_owned()),
            force_path_style: true,
            access_key_id: "test-key".to_owned(),
            secret_access_key: "test-secret".to_owned(),
            session_token: None,
            public_base_url: Some("https://files.example.test".to_owned()),
            key_prefix: None,
            upload_url_ttl_sec: 900,
            download_url_ttl_sec: 900,
        }
    }

    #[test]
    fn creates_stable_sigv4_urls_for_public_and_internal_audiences() {
        let now = Utc
            .with_ymd_and_hms(2026, 8, 25, 12, 30, 0)
            .single()
            .expect("valid timestamp");
        let config = config();

        let internal = presign(
            &config,
            "GET",
            "projects/10/file name.pdf",
            300,
            Audience::Internal,
            &[],
            now,
        )
        .expect("internal URL");
        let public = presign(
            &config,
            "GET",
            "projects/10/file name.pdf",
            300,
            Audience::Public,
            &[],
            now,
        )
        .expect("public URL");

        assert!(internal.starts_with("http://127.0.0.1:9000/test-bucket/"));
        assert!(public.starts_with("https://files.example.test/test-bucket/"));
        assert!(internal.contains("X-Amz-Signature="));
        assert!(internal.contains("file%20name.pdf"));
    }

    #[test]
    fn normalizes_unsafe_file_names_without_losing_extensions() {
        assert_eq!(
            normalize_file_name("  build plan (final).pdf  "),
            "build-plan-final_.pdf"
        );
        assert_eq!(normalize_file_name("..."), "file");
    }
}
