//! Independent encrypted API runtime. Startup opens no PostgreSQL connection
//! and runs neither old schema migrations nor background plaintext jobs.
use std::sync::Arc;

use crate::{
    auth::AuthService,
    control::{Repository, key},
    quack_store::{CipherStore, QuackConfig},
    rpc::{self, ProcedureRegistryBuilder, RequestContext},
};
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request},
    middleware::Next,
    response::Response,
};

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub jwt_secret: Arc<[u8]>,
    pub admin_hash: Arc<str>,
    pub store: QuackConfig,
    pub editors: crate::editors::EditorConfig,
}
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing environment variable or secret for {0}")]
    Missing(&'static str),
    #[error("PORT must be an unsigned 16-bit number")]
    InvalidPort,
    #[error("JWT_SECRET must contain at least 32 bytes")]
    InvalidJwtSecret,
    #[error("ADMIN_HASH must contain a valid bcrypt hash")]
    InvalidAdminHash,
    #[error("a complete DuckDB service configuration is required")]
    InvalidStore,
    #[error(transparent)]
    InvalidEditors(#[from] crate::editors::ConfigError),
}
impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let port = crate::config::optional("PORT")
            .unwrap_or_else(|| "3000".into())
            .parse::<u16>()
            .map_err(|_| ConfigError::InvalidPort)?;
        let jwt_secret = required("JWT_SECRET")?;
        let admin_hash = required("ADMIN_HASH")?;
        validate_credentials(&jwt_secret, &admin_hash)?;
        let store = QuackConfig::from_env()
            .map_err(|_| ConfigError::InvalidStore)?
            .ok_or(ConfigError::InvalidStore)?;
        Ok(Self {
            port,
            jwt_secret: Arc::from(jwt_secret.into_bytes()),
            admin_hash: Arc::from(admin_hash),
            store,
            editors: crate::editors::EditorConfig::from_env()?,
        })
    }
}
fn required(name: &'static str) -> Result<String, ConfigError> {
    crate::config::optional(name)
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError::Missing(name))
}
fn validate_credentials(jwt_secret: &str, admin_hash: &str) -> Result<(), ConfigError> {
    if jwt_secret.len() < 32 {
        return Err(ConfigError::InvalidJwtSecret);
    }
    admin_hash
        .parse::<bcrypt::HashParts>()
        .map_err(|_| ConfigError::InvalidAdminHash)?;
    Ok(())
}

pub async fn connect(config: &Config) -> crate::error::RpcResult<Router> {
    connect_at(
        config,
        std::net::SocketAddr::from(([0, 0, 0, 0], config.port)),
    )
    .await
}

pub async fn connect_at(
    config: &Config,
    address: std::net::SocketAddr,
) -> crate::error::RpcResult<Router> {
    let store =
        CipherStore::new(config.store.clone()).map_err(|_| crate::control::unavailable())?;
    let repository = Repository::system(store);
    // Verify the actual control service before accepting requests. The marker
    // need not exist: an empty new installation is a valid initial state.
    repository
        .read::<serde_json::Value>(key("runtime", "ready"))
        .await?;
    let service = Arc::new(AuthService::from_credentials(
        Arc::clone(&config.jwt_secret),
        Arc::clone(&config.admin_hash),
        Some(repository),
    ));
    let settings = Arc::new(crate::llm::control::Settings::from_env());
    let runtime = crate::llm::live::Runtime::new(Arc::clone(&service), settings);
    runtime
        .live_llm
        .bind_to(
            runtime.settings.internal_url.as_deref(),
            Some(config.store.control_url.as_ref()),
            address,
        )
        .await?;
    Ok(router_with_runtime(
        service,
        runtime,
        config.editors.clone(),
    ))
}

/// Integration tests and the executable use exactly the same native handlers.
/// A procedure is added here only after it uses the shared tenant transaction.
#[cfg(test)]
pub(crate) fn router(service: Arc<AuthService>) -> Router {
    router_with_llm(service, Arc::new(crate::llm::control::Settings::default()))
}

#[cfg(test)]
pub(crate) fn router_with_llm(
    service: Arc<AuthService>,
    settings: Arc<crate::llm::control::Settings>,
) -> Router {
    let runtime = crate::llm::live::Runtime::new(Arc::clone(&service), settings);
    router_with_runtime(service, runtime, crate::editors::EditorConfig::default())
}

pub(crate) fn router_with_runtime(
    service: Arc<AuthService>,
    runtime: Arc<crate::llm::live::Runtime>,
    editors: crate::editors::EditorConfig,
) -> Router {
    let builder = ProcedureRegistryBuilder::default()
        .query("ping", |_: RequestContext, _: ()| async {
            Ok("pong".to_owned())
        });
    let builder = crate::api::register_session_auth(builder, Arc::clone(&service));
    let builder = crate::operator::register_operator(builder, Arc::clone(&service));
    let builder = crate::telemetry::register(builder, Arc::clone(&service));
    let builder = crate::storage::register(builder, Arc::clone(&service));
    let builder = crate::zerotrust::register_native(builder, Arc::clone(&service));
    let builder = crate::editors::register(builder, Arc::clone(&service), editors);
    let builder =
        crate::llm::control::register(builder, Arc::clone(&service), Arc::clone(&runtime.settings));
    let builder = crate::llm::live::register_native(builder, Arc::clone(&runtime));
    let storage = crate::storage::router(Arc::clone(&service));
    let events = crate::zerotrust::events::router_metadata(service, Arc::clone(&runtime.events));
    rpc::http_router(builder.build())
        .merge(events)
        .merge(storage)
        .merge(crate::llm::live::router_native(runtime))
        .layer(axum::middleware::from_fn(body_limit))
}
async fn body_limit(mut request: Request, next: Next) -> Response {
    if request.method() == axum::http::Method::POST
        && request
            .uri()
            .path()
            .trim_start_matches('/')
            .split(',')
            .any(|path| {
                matches!(
                    path,
                    "zerotrust.objects.save"
                        | "zerotrust.fileChunks.put"
                        | "zerotrust.objects.stage"
                        | "zerotrust.objects.batch"
                        | "zerotrust.domains.put"
                        | "zerotrust.domains.putMany"
                        | "zerotrust.recovery.begin"
                )
            })
    {
        DefaultBodyLimit::max(32 * 1024 * 1024).apply(&mut request);
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_credentials_reject_weak_or_invalid_configuration() {
        let hash = bcrypt::hash("Disposable-operator-password-2026!", 4).unwrap();
        assert!(validate_credentials("short", &hash).is_err());
        assert!(
            validate_credentials("disposable-long-enough-runtime-secret-2026", "plaintext")
                .is_err()
        );
        assert!(validate_credentials("disposable-long-enough-runtime-secret-2026", &hash).is_ok());
    }
}
