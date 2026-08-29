//! Native sortsys API library and application-state assembly.

pub mod api;
pub mod auth;
pub mod config;
mod contract_generated;
pub mod database;
pub mod error;
pub mod ids;
pub mod job_queue;
mod job_runner_media;
pub mod job_runners;
pub mod llm;
pub mod object_storage;
pub mod office_exports;
pub mod onlyoffice;
pub mod rpc;
pub mod seed;
pub mod superjson;
pub mod webauthn;

pub mod managed_db;
pub mod migrations;
mod migrations_generated;
pub mod procedures;
use std::sync::Arc;

use auth::AuthService;
use config::Config;
use database::{DatabaseError, TenantStore};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub tenants: TenantStore,
    pub auth: AuthService,
}

impl AppState {
    pub async fn connect(config: Config) -> Result<Arc<Self>, DatabaseError> {
        let tenants = TenantStore::connect(&config.master_dsn).await?;
        let auth = AuthService::new(&config, tenants.clone());
        Ok(Arc::new(Self {
            config,
            tenants,
            auth,
        }))
    }
}

use rpc::{ProcedureRegistry, RequestContext};

pub fn registry() -> ProcedureRegistry {
    ProcedureRegistry::builder()
        .query("ping", |_ctx: RequestContext, _input: ()| async move {
            Ok("pong".to_owned())
        })
        .build()
}

pub fn registry_with_state(state: Arc<AppState>) -> ProcedureRegistry {
    api::registry(state)
}

pub fn app_with_state(state: Arc<AppState>) -> axum::Router {
    rpc::http_router(registry_with_state(Arc::clone(&state)))
        .merge(job_runners::router(Arc::clone(&state)))
        .merge(onlyoffice::router(Arc::clone(&state)))
        .merge(office_exports::router(Arc::clone(&state)))
        .merge(llm::mcp_router(state))
}
pub fn app() -> axum::Router {
    rpc::http_router(registry())
}
