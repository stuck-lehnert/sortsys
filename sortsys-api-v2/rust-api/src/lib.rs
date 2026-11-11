//! Native sortsys API library and application-state assembly.

pub mod api;
pub mod audit;
pub mod auth;
mod auth_limits;
pub mod backup_scheduler;
pub mod browser_schema;
pub mod config;
mod contract_generated;
pub mod database;
pub mod drawio;
pub mod error;
mod hex_encoding;
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
pub mod xml_documents;
pub mod xml_live;
pub mod zerotrust;

pub mod managed_db;
pub mod migrations;
mod migrations_generated;
pub mod procedures;
pub mod quack_store;
use std::sync::Arc;

use auth::AuthService;
use config::Config;
use database::{DatabaseError, TenantStore};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub tenants: TenantStore,
    pub auth: AuthService,
    pub xml_live: Arc<xml_live::Hub>,
    pub ciphertexts: Option<quack_store::CipherStore>,
    pub live_llm: Arc<llm::live::Hub>,
    pub encrypted_events: Arc<zerotrust::events::Hub>,
}

impl AppState {
    pub async fn connect(config: Config) -> Result<Arc<Self>, DatabaseError> {
        let tenants = TenantStore::connect(&config.master_dsn).await?;
        let auth = AuthService::new(&config, tenants.clone());
        let ciphertexts = config
            .quack
            .clone()
            .map(quack_store::CipherStore::new)
            .transpose()
            .map_err(|_| DatabaseError::InvalidCipherStore)?;
        Ok(Arc::new(Self {
            config,
            tenants,
            auth,
            xml_live: Arc::new(xml_live::Hub::default()),
            ciphertexts,
            live_llm: Arc::new(llm::live::Hub::default()),
            encrypted_events: Arc::new(zerotrust::events::Hub::default()),
        }))
    }
}

pub async fn backfill_pdf_text_extraction_jobs(state: &AppState) {
    procedures::project_files::backfill_pdf_text_extraction_jobs(state).await;
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
        .merge(xml_live::router(Arc::clone(&state)))
        .merge(llm::mcp_router(Arc::clone(&state)))
        .merge(llm::live::router(Arc::clone(&state)))
        .merge(zerotrust::events::router(state))
        .layer(axum::middleware::from_fn(xml_documents::request_body_limit))
        .layer(axum::middleware::from_fn(audit::middleware))
}
pub fn app() -> axum::Router {
    rpc::http_router(registry())
}
