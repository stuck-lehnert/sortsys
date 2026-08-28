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
    pub production: bool,
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

        Ok(Self {
            port,
            jwt_secret: Arc::from(jwt_secret.into_bytes()),
            master_dsn: Arc::from(master_dsn),
            admin_hash: Arc::from(admin_hash),
            job_runner_token: Arc::from(job_runner_token),
            llm_encryption_key,
            llm_mcp_url,
            production,
        })
    }
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
}
