//! Environment and Docker-secret configuration loading.

use std::{env, fs, sync::Arc};

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub jwt_secret: Arc<[u8]>,
    pub master_dsn: Arc<str>,
    pub admin_hash: Arc<str>,
    pub job_runner_token: Arc<str>,
    pub llm_encryption_key: Option<Arc<[u8]>>,
    pub llm_mcp_url: Option<Arc<str>>,
    pub onlyoffice: Option<OnlyOfficeConfig>,
    pub production: bool,
}

#[derive(Clone)]
pub struct OnlyOfficeConfig {
    pub public_url: Arc<str>,
    pub internal_url: Arc<str>,
    pub callback_url: Arc<str>,
    pub jwt_secret: Arc<[u8]>,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let production = env::var("NODE_ENV").is_ok_and(|value| value == "production");
        let port = env::var("PORT")
            .unwrap_or_else(|_| "3000".to_owned())
            .parse::<u16>()
            .map_err(|_| ConfigError::InvalidPort(env::var("PORT").unwrap_or_default()))?;
        let jwt_secret = required("JWT_SECRET")?;
        let master_dsn = required("PG_MASTER_DSN")?;
        let admin_hash = required("ADMIN_HASH")?;
        let job_runner_token = optional("JOB_RUNNER_TOKEN")
            .filter(|value| !value.is_empty())
            .or_else(|| (!production).then(|| "dev-job-runner-token".to_owned()))
            .ok_or(ConfigError::Missing("JOB_RUNNER_TOKEN"))?;
        let llm_encryption_key = optional("LLM_ENCRYPTION_KEY")
            .filter(|value| !value.is_empty())
            .map(|value| Arc::from(value.into_bytes()));
        let llm_mcp_url = optional("LLM_MCP_URL")
            .filter(|value| !value.is_empty())
            .map(Arc::from);
        let onlyoffice = onlyoffice_config()?;

        Ok(Self {
            port,
            jwt_secret: Arc::from(jwt_secret.into_bytes()),
            master_dsn: Arc::from(master_dsn),
            admin_hash: Arc::from(admin_hash),
            job_runner_token: Arc::from(job_runner_token),
            llm_encryption_key,
            llm_mcp_url,
            onlyoffice,
            production,
        })
    }
}

fn onlyoffice_config() -> Result<Option<OnlyOfficeConfig>, ConfigError> {
    let public_url = optional("ONLYOFFICE_PUBLIC_URL").filter(|value| !value.is_empty());
    let internal_url = optional("ONLYOFFICE_INTERNAL_URL").filter(|value| !value.is_empty());
    let callback_url = optional("ONLYOFFICE_CALLBACK_URL").filter(|value| !value.is_empty());
    let jwt_secret = optional("ONLYOFFICE_JWT_SECRET").filter(|value| !value.is_empty());

    if public_url.is_none()
        && internal_url.is_none()
        && callback_url.is_none()
        && jwt_secret.is_none()
    {
        return Ok(None);
    }

    let public_url = validate_public_url(
        "ONLYOFFICE_PUBLIC_URL",
        public_url.ok_or(ConfigError::Missing("ONLYOFFICE_PUBLIC_URL"))?,
    )?;
    let callback_url = validate_absolute_http_url(
        "ONLYOFFICE_CALLBACK_URL",
        callback_url.ok_or(ConfigError::Missing("ONLYOFFICE_CALLBACK_URL"))?,
    )?;
    let jwt_secret = jwt_secret.ok_or(ConfigError::Missing("ONLYOFFICE_JWT_SECRET"))?;
    let internal_url = validate_absolute_http_url(
        "ONLYOFFICE_INTERNAL_URL",
        internal_url.unwrap_or_else(|| public_url.clone()),
    )?;

    Ok(Some(OnlyOfficeConfig {
        public_url: Arc::from(public_url.trim_end_matches('/')),
        internal_url: Arc::from(internal_url.trim_end_matches('/')),
        callback_url: Arc::from(callback_url),
        jwt_secret: Arc::from(jwt_secret.into_bytes()),
    }))
}

fn validate_public_url(name: &'static str, value: String) -> Result<String, ConfigError> {
    let relative_path = value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains('?')
        && !value.contains('#');
    if relative_path || is_absolute_http_url(&value) {
        return Ok(value);
    }

    Err(ConfigError::InvalidPublicUrl { name, value })
}

fn validate_absolute_http_url(name: &'static str, value: String) -> Result<String, ConfigError> {
    if !is_absolute_http_url(&value) {
        return Err(ConfigError::InvalidAbsoluteUrl { name, value });
    }

    Ok(value)
}

fn is_absolute_http_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

fn required(name: &'static str) -> Result<String, ConfigError> {
    optional(name)
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError::Missing(name))
}

fn optional(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .or_else(|| fs::read_to_string(format!("/run/secrets/SORTSYS_API_V2_{name}")).ok())
        .map(|value| value.trim().to_owned())
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing environment variable or secret for {0}")]
    Missing(&'static str),
    #[error("invalid PORT value: {0:?}")]
    InvalidPort(String),
    #[error("{name} must be an absolute HTTP(S) URL, got {value:?}")]
    InvalidAbsoluteUrl { name: &'static str, value: String },
    #[error("{name} must be an absolute HTTP(S) URL or a root-relative path, got {value:?}")]
    InvalidPublicUrl { name: &'static str, value: String },
}

#[cfg(test)]
mod tests {
    use super::{ConfigError, validate_absolute_http_url, validate_public_url};

    #[test]
    fn onlyoffice_server_urls_must_have_an_http_origin() {
        assert!(
            validate_absolute_http_url(
                "ONLYOFFICE_PUBLIC_URL",
                "https://app.sortsys.de/office".to_owned(),
            )
            .is_ok()
        );
        assert!(
            validate_absolute_http_url("ONLYOFFICE_INTERNAL_URL", "http://onlyoffice".to_owned(),)
                .is_ok()
        );
        assert!(matches!(
            validate_public_url("ONLYOFFICE_PUBLIC_URL", "office".to_owned()),
            Err(ConfigError::InvalidPublicUrl { .. })
        ));
        assert!(validate_public_url("ONLYOFFICE_PUBLIC_URL", "/office".to_owned()).is_ok());
        assert!(
            validate_public_url(
                "ONLYOFFICE_PUBLIC_URL",
                "https://app.sortsys.de/office".to_owned()
            )
            .is_ok()
        );
    }
}
