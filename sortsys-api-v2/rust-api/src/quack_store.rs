//! Shared, tenant-file-backed ciphertext storage. Only the service opens files;
//! API replicas use authenticated Quack connections to that service.
use std::{path::PathBuf, sync::Arc};

use duckdb::Connection;
use sha2::{Digest, Sha256};

mod client;
mod remote;
pub mod server;
pub use client::CipherStore;

pub const VERSION: &str = "v2.0.0";
pub const MAX_CIPHERTEXT_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone)]
pub struct QuackConfig {
    pub uri: Arc<str>,
    pub control_url: Arc<str>,
    pub token: Arc<str>,
    pub extensions: PathBuf,
    pub disable_ssl: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("invalid DuckDB service configuration: {0}")]
    Configuration(&'static str),
    #[error("encrypted storage unavailable ({0})")]
    Unavailable(&'static str),
    #[error("encrypted storage integrity check failed")]
    Integrity,
    #[error("encrypted storage object not found")]
    NotFound,
    #[error("concurrent encrypted storage write")]
    Conflict,
    #[error("encrypted storage batch exceeds the read limit")]
    BatchTooLarge,
}

impl QuackConfig {
    pub fn from_env() -> Result<Option<Self>, StoreError> {
        let uri = crate::config::optional("DUCKDB_QUACK_URI");
        let control = crate::config::optional("DUCKDB_CONTROL_URL");
        let token = crate::config::optional("DUCKDB_SERVICE_TOKEN");
        match (uri, control, token) {
            (None, None, None) => Ok(None),
            (Some(uri), Some(control), Some(token)) => {
                let parsed = url::Url::parse(&control)
                    .map_err(|_| StoreError::Configuration("control URL"))?;
                if !matches!(parsed.scheme(), "http" | "https")
                    || parsed.host_str().is_none()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                    || !uri.starts_with("quack:")
                {
                    return Err(StoreError::Configuration("service address"));
                }
                validate_token(&token)?;
                let disable_ssl = crate::config::optional("DUCKDB_QUACK_DISABLE_SSL")
                    .map(|value| value.parse::<bool>())
                    .transpose()
                    .map_err(|_| StoreError::Configuration("Quack TLS flag"))?
                    .unwrap_or(false);
                Ok(Some(Self {
                    uri: Arc::from(uri),
                    control_url: Arc::from(control.trim_end_matches('/')),
                    token: Arc::from(token),
                    extensions: extension_directory(),
                    disable_ssl,
                }))
            }
            _ => Err(StoreError::Configuration(
                "Quack URI, control URL and token are required together",
            )),
        }
    }
}

pub fn extension_directory() -> PathBuf {
    crate::config::optional("DUCKDB_EXTENSION_DIRECTORY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/local/share/sortsys-duckdb/extensions"))
}
pub fn validate_token(token: &str) -> Result<(), StoreError> {
    if token.len() < 32
        || token.len() > 512
        || !token.is_ascii()
        || token.bytes().any(|b| b.is_ascii_control())
    {
        Err(StoreError::Configuration(
            "service token must contain 32 to 512 printable ASCII bytes",
        ))
    } else {
        Ok(())
    }
}
pub fn tenant_id(tenant: &str) -> Result<String, StoreError> {
    if tenant.is_empty() || tenant.len() > 192 || tenant.contains('\0') {
        return Err(StoreError::Integrity);
    }
    let mut digest = Sha256::new();
    digest.update(b"sortsys/tenant-db/v1\0");
    digest.update(tenant.as_bytes());
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
pub fn content_id(data: &str) -> String {
    Sha256::digest(data.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn prepare(connection: &Connection, extensions: &std::path::Path) -> Result<(), StoreError> {
    let version: String = connection
        .query_row("SELECT version()", [], |row| row.get(0))
        .map_err(|_| StoreError::Unavailable("version"))?;
    if version != VERSION {
        return Err(StoreError::Configuration("DuckDB 2.0.0 is required"));
    }
    let path = extensions
        .to_str()
        .ok_or(StoreError::Configuration("extension directory"))?;
    connection.execute_batch(&format!("SET extension_directory={}; SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; LOAD httpfs; LOAD quack;",sql_string(path)))
        .map_err(|_|StoreError::Unavailable("extension-load"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tenant_paths_are_opaque_and_cannot_contain_caller_paths() {
        let id = tenant_id("../../customer's files").unwrap();
        assert!(valid_id(&id));
        assert_ne!(id, tenant_id("another").unwrap());
        assert!(tenant_id("").is_err());
        assert!(tenant_id("a\0b").is_err());
        assert!(!valid_id("../file"));
    }
    #[test]
    fn invalid_service_tokens_are_rejected_before_startup() {
        assert!(validate_token("").is_err());
        assert!(validate_token(&"a".repeat(32)).is_ok());
        assert!(validate_token(&format!("{}\n", "a".repeat(32))).is_err());
    }
}
