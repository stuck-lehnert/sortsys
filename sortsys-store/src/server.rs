use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as RoutePath, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use duckdb::Connection;
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use super::client::SnapshotInfo;
use super::{
    StoreError, VERSION, extension_directory, prepare, sql_string, tenant_id, valid_id,
    validate_token,
};

pub struct ServiceConfig {
    pub directory: PathBuf,
    pub extensions: PathBuf,
    pub token: String,
    pub quack_address: String,
    pub control_address: SocketAddr,
}
impl ServiceConfig {
    pub fn from_env() -> Result<Self, StoreError> {
        let value = crate::config_value;
        let token = value("DUCKDB_SERVICE_TOKEN")
            .ok_or(StoreError::Configuration("service token is required"))?;
        validate_token(&token)?;
        let quack = quack_listener(
            value("DUCKDB_QUACK_LISTEN").as_deref(),
            value("DUCKDB_QUACK_PORT").as_deref(),
        )?;
        let control = value("DUCKDB_CONTROL_LISTEN")
            .unwrap_or_else(|| "0.0.0.0:9495".into())
            .parse()
            .map_err(|_| StoreError::Configuration("control address"))?;
        Ok(Self {
            directory: PathBuf::from(
                value("DUCKDB_DATA_DIRECTORY").unwrap_or_else(|| "/var/lib/sortsys-duckdb".into()),
            ),
            extensions: extension_directory(),
            token,
            quack_address: quack,
            control_address: control,
        })
    }
}

fn quack_listener(listen: Option<&str>, port: Option<&str>) -> Result<String, StoreError> {
    let address = match listen {
        Some(value) => value
            .parse::<SocketAddr>()
            .map_err(|_| StoreError::Configuration("Quack listen address"))?,
        None => SocketAddr::from((
            [0, 0, 0, 0],
            port.unwrap_or("9494")
                .parse::<u16>()
                .map_err(|_| StoreError::Configuration("Quack port"))?,
        )),
    };
    Ok(format!("quack:{address}"))
}

#[cfg(test)]
mod listener_tests {
    use super::*;
    #[test]
    fn a_local_test_listener_does_not_expose_the_quack_port_on_other_interfaces() {
        assert_eq!(
            quack_listener(Some("127.0.0.1:12345"), Some("invalid")).unwrap(),
            "quack:127.0.0.1:12345"
        );
        assert_eq!(quack_listener(None, None).unwrap(), "quack:0.0.0.0:9494");
        assert_eq!(
            quack_listener(None, Some("12345")).unwrap(),
            "quack:0.0.0.0:12345"
        );
        for value in [
            "https://127.0.0.1:12345",
            "127.0.0.1",
            "hostname:12345",
            "127.0.0.1:99999",
        ] {
            assert!(quack_listener(Some(value), None).is_err());
        }
        assert!(quack_listener(None, Some("invalid")).is_err());
    }
}

#[derive(Clone)]
struct Control {
    connection: Arc<Mutex<Connection>>,
    initialized: Arc<Mutex<HashSet<String>>>,
    directory: Arc<PathBuf>,
    token: Arc<str>,
    changes: Arc<Mutex<HashMap<String, Weak<tokio::sync::watch::Sender<()>>>>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TenantInput {
    tenant: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotInput {
    tenant: String,
    operation: Option<String>,
}

impl IntoResponse for StoreError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Integrity => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::BatchTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            _ => StatusCode::SERVICE_UNAVAILABLE,
        };
        (
            status,
            Json(serde_json::json!({"error":"Datastore operation failed"})),
        )
            .into_response()
    }
}
impl Control {
    fn open(config: &ServiceConfig) -> Result<Self, StoreError> {
        std::fs::create_dir_all(config.directory.join("tenants"))
            .map_err(|_| StoreError::Unavailable("data-directory"))?;
        std::fs::create_dir_all(config.directory.join("snapshots"))
            .map_err(|_| StoreError::Unavailable("snapshot-directory"))?;
        let directory = std::fs::canonicalize(&config.directory)
            .map_err(|_| StoreError::Unavailable("data-directory"))?;
        let connection = Connection::open(directory.join("control.duckdb"))
            .map_err(|_| StoreError::Unavailable("control-file"))?;
        prepare(&connection, &config.extensions)?;
        connection
            .execute_batch("SET memory_limit='2GB'; SET threads=4;")
            .map_err(|_| StoreError::Unavailable("engine-limits"))?;
        super::metadata::initialize(&connection, "control")?;
        super::witness::initialize(&connection)?;
        let result = Self {
            connection: Arc::new(Mutex::new(connection)),
            initialized: Arc::new(Mutex::new(HashSet::new())),
            directory: Arc::new(directory),
            token: Arc::from(config.token.as_str()),
            changes: Arc::new(Mutex::new(HashMap::new())),
        };
        {
            let connection = result
                .connection
                .lock()
                .map_err(|_| StoreError::Unavailable("control-lock"))?;
            for entry in std::fs::read_dir(result.directory.join("tenants"))
                .map_err(|_| StoreError::Unavailable("tenant-directory"))?
            {
                let entry = entry.map_err(|_| StoreError::Unavailable("tenant-directory"))?;
                let name = entry.file_name();
                let name = name.to_str().ok_or(StoreError::Integrity)?;
                if let Some(id) = name.strip_suffix(".duckdb") {
                    if !valid_id(id)
                        || !entry
                            .file_type()
                            .map_err(|_| StoreError::Integrity)?
                            .is_file()
                    {
                        return Err(StoreError::Integrity);
                    }
                    attach(&connection, &result.directory, id)?;
                }
            }
            // Discard the CALL's result: it contains the service token.
            connection
                .execute_batch(&format!(
                    "CALL quack_serve({},token={},allow_other_hostname=true,disable_ssl=true);",
                    sql_string(&config.quack_address),
                    sql_string(&config.token)
                ))
                .map_err(|_| StoreError::Unavailable("quack-listener"))?;
        }
        Ok(result)
    }
    async fn blocking<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Connection, &Path, &mut HashSet<String>) -> Result<T, StoreError>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let connection = state
                .connection
                .lock()
                .map_err(|_| StoreError::Unavailable("control-lock"))?;
            let mut initialized = state
                .initialized
                .lock()
                .map_err(|_| StoreError::Unavailable("attachment-lock"))?;
            operation(&connection, &state.directory, &mut initialized)
        })
        .await
        .map_err(|_| StoreError::Unavailable("control-worker"))?
    }
}

/// Only attachment/schema readiness is cached. Security witnesses are checked
/// on every metadata admission and remain shared by all API instances.
fn attach_cached(
    connection: &Connection,
    directory: &Path,
    id: &str,
    initialized: &mut HashSet<String>,
) -> Result<String, StoreError> {
    if initialized.contains(id) {
        return Ok(format!("t_{id}"));
    }
    let catalog = attach(connection, directory, id)?;
    initialized.insert(id.into());
    Ok(catalog)
}

fn attach(connection: &Connection, directory: &Path, id: &str) -> Result<String, StoreError> {
    if !valid_id(id) {
        return Err(StoreError::Integrity);
    }
    let path = directory.join("tenants").join(format!("{id}.duckdb"));
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| !metadata.is_file())
    {
        return Err(StoreError::Integrity);
    }
    let path = path
        .to_str()
        .ok_or(StoreError::Configuration("data path"))?;
    let catalog = format!("t_{id}");
    connection
        .execute_batch(&format!(
            "ATTACH IF NOT EXISTS {} AS {catalog};",
            sql_string(path)
        ))
        .map_err(|_| StoreError::Unavailable("tenant-attach"))?;
    // Each file owns its schema version. API replicas never perform DDL here.
    let schema = format!(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS {catalog}.__schema(
             version INTEGER PRIMARY KEY CHECK(version=1)
         );
         INSERT INTO {catalog}.__schema VALUES(1) ON CONFLICT DO NOTHING;
         CREATE TABLE IF NOT EXISTS {catalog}.ciphertexts(
             id VARCHAR PRIMARY KEY CHECK(length(id)=64),
             content VARCHAR NOT NULL CHECK(sha256(content)=id),
             created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
         );
         COMMIT;"
    );
    if connection.execute_batch(&schema).is_err() {
        let _ = connection.execute_batch("ROLLBACK");
        return Err(StoreError::Unavailable("tenant-schema"));
    }
    let version: i32 = connection
        .query_row(
            &format!("SELECT version FROM {catalog}.__schema"),
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::Unavailable("tenant-schema"))?;
    if version != 1 {
        return Err(StoreError::Configuration("unsupported tenant schema"));
    }
    super::metadata::initialize(connection, &catalog)?;
    Ok(catalog)
}

async fn authenticate(State(state): State<Control>, request: Request, next: Next) -> Response {
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    if supplied.len() > 512 || !same_token(supplied.as_bytes(), state.token.as_bytes()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}
fn same_token(first: &[u8], second: &[u8]) -> bool {
    let mut mismatch = first.len() ^ second.len();
    for index in 0..first.len().max(second.len()) {
        mismatch |= usize::from(
            first.get(index).copied().unwrap_or(0) ^ second.get(index).copied().unwrap_or(0),
        );
    }
    mismatch == 0
}
async fn health(State(state): State<Control>) -> Result<&'static str, StoreError> {
    state
        .blocking(|connection, _, _| {
            connection
                .query_row::<i32, _, _>("SELECT 1", [], |row| row.get(0))
                .map_err(|_| StoreError::Unavailable("health"))?;
            Ok(())
        })
        .await?;
    Ok("ok")
}
async fn provision(
    State(state): State<Control>,
    Json(input): Json<TenantInput>,
) -> Result<Json<serde_json::Value>, StoreError> {
    let id = tenant_id(&input.tenant)?;
    let catalog = state
        .blocking(move |connection, directory, initialized| {
            attach_cached(connection, directory, &id, initialized)
        })
        .await?;
    Ok(Json(serde_json::json!({"catalog":catalog})))
}
async fn snapshot(
    State(state): State<Control>,
    Json(input): Json<SnapshotInput>,
) -> Result<Json<SnapshotInfo>, StoreError> {
    let tenant = tenant_id(&input.tenant)?;
    let id = match input.operation {
        Some(operation) => super::snapshot_id(&input.tenant, &operation)?,
        None => {
            let mut random = [0u8; 32];
            getrandom::fill(&mut random).map_err(|_| StoreError::Unavailable("snapshot-id"))?;
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        }
    };
    state
        .blocking(move |connection, directory, initialized| {
            let source = metadata_catalog(
                connection,
                directory,
                super::metadata::Target::Tenant {
                    tenant: input.tenant,
                },
                initialized,
            )?;
            let finished = directory.join("snapshots").join(format!("{id}.duckdb"));
            if finished.exists() {
                let bytes = finished
                    .metadata()
                    .map_err(|_| StoreError::Unavailable("snapshot-size"))?
                    .len();
                return Ok(Json(SnapshotInfo { id, tenant, bytes }));
            }
            let target = format!("snapshot_{id}");
            let partial = directory
                .join("snapshots")
                .join(format!("{id}.partial.duckdb"));
            // A process may have stopped before publishing its closed copy.
            // Only the final name identifies a completed, replayable snapshot.
            match std::fs::remove_file(&partial) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(StoreError::Unavailable("snapshot-partial")),
            }
            let path = partial
                .to_str()
                .ok_or(StoreError::Configuration("snapshot path"))?;
            connection
                .execute_batch(&format!("ATTACH {} AS {target};", sql_string(path)))
                .map_err(|_| StoreError::Unavailable("snapshot-open"))?;
            let copied =
                connection.execute_batch(&format!("COPY FROM DATABASE {source} TO {target};"));
            let closed = connection.execute_batch(&format!("DETACH {target};"));
            if copied.is_err() || closed.is_err() {
                return Err(StoreError::Unavailable("snapshot-copy"));
            }
            std::fs::File::open(&partial)
                .and_then(|file| file.sync_all())
                .map_err(|_| StoreError::Unavailable("snapshot-sync"))?;
            std::fs::rename(&partial, &finished)
                .map_err(|_| StoreError::Unavailable("snapshot-publish"))?;
            std::fs::File::open(directory.join("snapshots"))
                .and_then(|directory| directory.sync_all())
                .map_err(|_| StoreError::Unavailable("snapshot-publish-sync"))?;
            let bytes = finished
                .metadata()
                .map_err(|_| StoreError::Unavailable("snapshot-size"))?
                .len();
            Ok(Json(SnapshotInfo { id, tenant, bytes }))
        })
        .await
}

async fn describe_content(
    State(state): State<Control>,
    Json(input): Json<crate::content::DescribeInput>,
) -> Result<Json<crate::content::Description>, StoreError> {
    let directory = state.directory.clone();
    tokio::task::spawn_blocking(move || {
        crate::content::Source::open(&directory, &input).map(|source| Json(source.description))
    })
    .await
    .map_err(|_| StoreError::Unavailable("snapshot-reader"))?
}

async fn prepare_content(
    State(state): State<Control>,
    Json(input): Json<crate::content::PrepareInput>,
) -> Result<Json<crate::content::Preparation>, StoreError> {
    let directory = state.directory.clone();
    let target = super::metadata::Target::Tenant {
        tenant: input.source.tenant.clone(),
    };
    let mut plan = tokio::task::spawn_blocking(move || {
        crate::content::Source::open(
            &directory,
            &crate::content::DescribeInput {
                source: input.source.clone(),
                records: Vec::new(),
            },
        )?
        .plan(input)
    })
    .await
    .map_err(|_| StoreError::Unavailable("snapshot-reader"))??;
    loop {
        let selected = target.clone();
        let (next_plan, preparation) = state
            .blocking(move |connection, directory, initialized| {
                let catalog = metadata_catalog(connection, directory, selected, initialized)?;
                let preparation = crate::content::advance(connection, &catalog, &plan)?;
                Ok((plan, preparation))
            })
            .await?;
        if preparation.phase == crate::content::Phase::Ready {
            return Ok(Json(preparation));
        }
        plan = next_plan;
        tokio::task::yield_now().await;
    }
}
async fn download(
    State(state): State<Control>,
    RoutePath(id): RoutePath<String>,
) -> Result<Response, StoreError> {
    if !valid_id(&id) {
        return Err(StoreError::NotFound);
    }
    let path = state
        .directory
        .join("snapshots")
        .join(format!("{id}.duckdb"));
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| StoreError::NotFound)?;
    let bytes = file
        .metadata()
        .await
        .map_err(|_| StoreError::Unavailable("snapshot-size"))?
        .len();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert(header::CONTENT_LENGTH, bytes.into());
    Ok((headers, Body::from_stream(ReaderStream::new(file))).into_response())
}

fn metadata_catalog(
    connection: &Connection,
    directory: &Path,
    target: super::metadata::Target,
    initialized: &mut HashSet<String>,
) -> Result<String, StoreError> {
    match target {
        super::metadata::Target::System => Ok("control".into()),
        super::metadata::Target::Tenant { tenant } => {
            let catalog = attach_cached(connection, directory, &tenant_id(&tenant)?, initialized)?;
            super::witness::admit(
                connection,
                &catalog,
                &format!("tenant:{}", tenant_id(&tenant)?),
            )?;
            Ok(catalog)
        }
    }
}
async fn journal_read(
    State(state): State<Control>,
    Json(input): Json<super::metadata::JournalRead>,
) -> Result<Json<Option<sortsys_zerotrust::journal::JournalEntry>>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            Ok(Json(crate::journal::get(
                connection,
                &catalog,
                &input.stream,
                &input.id,
            )?))
        })
        .await
}
async fn journal_origins(
    State(state): State<Control>,
    Json(input): Json<super::metadata::JournalOrigins>,
) -> Result<Json<Vec<Option<sortsys_zerotrust::journal::JournalEntry>>>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            Ok(Json(super::journal::origins(
                connection,
                &catalog,
                &input.objects,
            )?))
        })
        .await
}

async fn journal_list(
    State(state): State<Control>,
    Json(input): Json<super::metadata::JournalList>,
) -> Result<Json<sortsys_zerotrust::journal::JournalPage>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            Ok(Json(crate::journal::query(
                connection,
                &catalog,
                &input.query,
            )?))
        })
        .await
}
async fn metadata_read(
    State(state): State<Control>,
    Json(input): Json<super::metadata::ReadRequest>,
) -> Result<Json<Vec<sortsys_zerotrust::metadata::MetadataRecord>>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let context = input.target.context()?;
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            let records = super::metadata::read(connection, &catalog, &input.records)?;
            super::witness::validate_records(connection, &context, &records)?;
            Ok(Json(records))
        })
        .await
}
fn target_identity(target: &super::metadata::Target) -> Result<String, StoreError> {
    match target {
        super::metadata::Target::System => Ok("system".into()),
        super::metadata::Target::Tenant { tenant } => Ok(format!("tenant:{}", tenant_id(tenant)?)),
    }
}
impl Control {
    fn watch_changes(
        &self,
        target: &super::metadata::Target,
    ) -> Result<
        (
            Arc<tokio::sync::watch::Sender<()>>,
            tokio::sync::watch::Receiver<()>,
        ),
        StoreError,
    > {
        let identity = target_identity(target)?;
        let mut changes = self
            .changes
            .lock()
            .map_err(|_| StoreError::Unavailable("change-watch"))?;
        changes.retain(|_, sender| sender.strong_count() > 0);
        if let Some(sender) = changes.get(&identity).and_then(Weak::upgrade) {
            return Ok((Arc::clone(&sender), sender.subscribe()));
        }
        if changes.len() >= 4096 {
            return Err(StoreError::Unavailable("change-watch-limit"));
        }
        let (sender, receiver) = tokio::sync::watch::channel(());
        let sender = Arc::new(sender);
        changes.insert(identity, Arc::downgrade(&sender));
        Ok((sender, receiver))
    }
    fn notify_changes(&self, target: &super::metadata::Target) -> Result<(), StoreError> {
        let identity = target_identity(target)?;
        let changes = self
            .changes
            .lock()
            .map_err(|_| StoreError::Unavailable("change-watch"))?;
        if let Some(sender) = changes.get(&identity).and_then(Weak::upgrade) {
            sender.send_replace(());
        }
        Ok(())
    }
}
async fn metadata_changes(
    State(state): State<Control>,
    Json(input): Json<super::metadata::ChangesRequest>,
) -> Result<Json<super::metadata::ChangesPage>, StoreError> {
    if input.wait_ms > 25_000 {
        return Err(StoreError::Integrity);
    }
    // Subscribe before reading. A commit between the read and wait is retained
    // by watch, so admission never loses a wake-up. Waiting holds no DB mutex.
    let (_sender, mut changed) = state.watch_changes(&input.target)?;
    let read = || {
        let input = input.clone();
        state.blocking(move |connection, directory, initialized| {
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            super::metadata::changes(connection, &catalog, input.after.as_deref())
        })
    };
    let initial = read().await?;
    if input.after.as_deref() != Some(initial.head.as_str())
        || !initial.events.is_empty()
        || input.wait_ms == 0
    {
        return Ok(Json(initial));
    }
    let wait = std::time::Duration::from_millis(u64::from(input.wait_ms));
    if tokio::time::timeout(wait, changed.changed()).await.is_err() {
        return Ok(Json(initial));
    }
    Ok(Json(read().await?))
}

async fn metadata_batch(
    State(state): State<Control>,
    Json(input): Json<super::metadata::BatchRequest>,
) -> Result<Json<sortsys_zerotrust::metadata::MetadataReceipt>, StoreError> {
    let target = input.target.clone();
    let receipt = state
        .blocking(move |connection, directory, initialized| {
            let context = input.target.context()?;
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            Ok(Json(super::witness::transact(
                connection,
                &catalog,
                &context,
                &input.batch,
                false,
            )?))
        })
        .await?;
    state.notify_changes(&target)?;
    Ok(receipt)
}
async fn metadata_prepare(
    State(state): State<Control>,
    Json(input): Json<super::prepared::PartRequest>,
) -> Result<Json<super::prepared::PartReceipt>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            Ok(Json(super::prepared::prepare(
                connection,
                &catalog,
                &input.content,
            )?))
        })
        .await
}
async fn metadata_commit_prepared(
    State(state): State<Control>,
    Json(input): Json<super::prepared::CommitRequest>,
) -> Result<Json<sortsys_zerotrust::metadata::MetadataReceipt>, StoreError> {
    let target = input.target.clone();
    let receipt = state
        .blocking(move |connection, directory, initialized| {
            let context = input.target.context()?;
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            Ok(Json(super::prepared::commit(
                connection,
                &catalog,
                &context,
                &input.manifest,
            )?))
        })
        .await?;
    state.notify_changes(&target)?;
    Ok(receipt)
}
async fn metadata_validate_prepared(
    State(state): State<Control>,
    Json(input): Json<super::prepared::CommitRequest>,
) -> Result<Json<bool>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let context = input.target.context()?;
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            super::prepared::validate_snapshot(connection, &catalog, &context, &input.manifest)?;
            Ok(Json(true))
        })
        .await
}
async fn metadata_scan(
    State(state): State<Control>,
    Json(input): Json<super::metadata::ScanRequest>,
) -> Result<Json<super::metadata::RecordPage>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let context = input.target.context()?;
            let catalog =
                metadata_catalog(connection, directory, input.target.clone(), initialized)?;
            let page = super::metadata::scan(connection, &catalog, &input)?;
            super::witness::validate_records(connection, &context, &page.records)?;
            Ok(Json(page))
        })
        .await
}

async fn metadata_scan_batch(
    State(state): State<Control>,
    Json(inputs): Json<Vec<super::metadata::ScanRequest>>,
) -> Result<Json<Vec<super::metadata::RecordPage>>, StoreError> {
    let target = inputs.first().ok_or(StoreError::Integrity)?.target.clone();
    if inputs.len() > super::metadata::MAX_SCAN_BATCH
        || inputs.iter().any(|input| input.target != target)
    {
        return Err(StoreError::Integrity);
    }
    state
        .blocking(move |connection, directory, initialized| {
            let context = target.context()?;
            let catalog = metadata_catalog(connection, directory, target, initialized)?;
            super::metadata::read_transaction(connection, || {
                let mut pages = Vec::with_capacity(inputs.len());
                let mut bytes = 0_usize;
                for input in inputs {
                    let page = super::metadata::scan(connection, &catalog, &input)?;
                    for row in &page.records {
                        bytes += row.value.as_ref().ok_or(StoreError::Integrity)?.len();
                        if bytes > sortsys_zerotrust::metadata::MAX_BATCH_BYTES {
                            return Err(StoreError::BatchTooLarge);
                        }
                    }
                    pages.push(page);
                }
                let records = pages
                    .iter()
                    .flat_map(|page| page.records.iter().cloned())
                    .collect::<Vec<_>>();
                super::witness::validate_records(connection, &context, &records)?;
                Ok(Json(pages))
            })
        })
        .await
}
async fn metadata_validate(
    State(state): State<Control>,
    Json(input): Json<super::metadata::BatchRequest>,
) -> Result<Json<bool>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let context = input.target.context()?;
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            super::witness::validate_checks(connection, &catalog, &context, &input.batch)?;
            super::metadata::validate_snapshot(connection, &catalog, &input.batch)?;
            Ok(Json(true))
        })
        .await
}
async fn metadata_events(
    State(state): State<Control>,
    Json(input): Json<super::metadata::EventsRequest>,
) -> Result<Json<Vec<super::metadata::MetadataEvent>>, StoreError> {
    state
        .blocking(move |connection, directory, initialized| {
            let catalog = metadata_catalog(connection, directory, input.target, initialized)?;
            Ok(Json(super::metadata::events(
                connection,
                &catalog,
                &input.after,
            )?))
        })
        .await
}

pub async fn run(
    config: ServiceConfig,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(), StoreError> {
    let address = config.control_address;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|_| StoreError::Unavailable("control-listener"))?;
    let (state, quack) = tokio::task::spawn_blocking(move || {
        Control::open(&config).map(|state| (state, config.quack_address))
    })
    .await
    .map_err(|_| StoreError::Unavailable("startup"))??;
    let metadata = Router::new()
        .route("/metadata/read", post(metadata_read))
        .route("/metadata/journal/read", post(journal_read))
        .route("/metadata/journal/origins", post(journal_origins))
        .route("/metadata/journal/list", post(journal_list))
        .route("/metadata/validate", post(metadata_validate))
        .route("/metadata/batch", post(metadata_batch))
        .route("/metadata/prepared/part", post(metadata_prepare))
        .route("/metadata/prepared/commit", post(metadata_commit_prepared))
        .route(
            "/metadata/prepared/validate",
            post(metadata_validate_prepared),
        )
        .route("/metadata/scan", post(metadata_scan))
        .route("/metadata/scan/batch", post(metadata_scan_batch))
        .route("/metadata/events", post(metadata_events))
        .route("/metadata/changes", post(metadata_changes))
        // A byte in a valid record string may become six JSON bytes (\u0000).
        // Keep the logical record budget in MetadataBatch::validate while
        // allowing its worst-case transport encoding and bounded key metadata.
        .layer(DefaultBodyLimit::max(
            6 * sortsys_zerotrust::metadata::MAX_BATCH_BYTES + 2 * 1024 * 1024,
        ));
    let private = Router::new()
        .merge(metadata)
        .merge(
            Router::new()
                .route("/content/describe", post(describe_content))
                .route("/content/prepare", post(prepare_content))
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/tenants", post(provision))
        .route("/snapshots", post(snapshot))
        .route("/snapshots/{id}", get(download))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let router = private
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(1024))
        .with_state(state.clone());
    tracing::info!(version = VERSION, "DuckDB datastore is ready");
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await;
    state
        .blocking(move |connection, _, _| {
            connection
                .execute_batch(&format!("CALL quack_stop({});", sql_string(&quack)))
                .map_err(|_| StoreError::Unavailable("quack-stop"))
        })
        .await?;
    result.map_err(|_| StoreError::Unavailable("control-server"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_authentication_rejects_prefixes_suffixes_and_changed_bytes() {
        assert!(same_token(b"token", b"token"));
        assert!(!same_token(b"toke", b"token"));
        assert!(!same_token(b"tokenx", b"token"));
        assert!(!same_token(b"tokem", b"token"));
    }

    #[test]
    fn cached_schema_readiness_never_caches_the_security_witness_decision() {
        use sortsys_zerotrust::{
            anchors::{ANCHOR_COLLECTION, RecordAnchor},
            metadata::{MetadataBatch, RecordCheck, RecordKey, RecordPut},
        };
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = std::env::temp_dir().join(format!("sortsys-schema-cache-{suffix}"));
        std::fs::create_dir_all(directory.join("tenants")).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("ATTACH ':memory:' AS control")
            .unwrap();
        crate::witness::initialize(&connection).unwrap();
        let mut initialized = HashSet::new();
        let target = crate::metadata::Target::Tenant {
            tenant: "cache-test".into(),
        };
        let catalog =
            metadata_catalog(&connection, &directory, target.clone(), &mut initialized).unwrap();
        assert_eq!(initialized.len(), 1);
        let key = RecordKey {
            collection: ANCHOR_COLLECTION.into(),
            key: "security".into(),
        };
        let batch = MetadataBatch {
            operation: "initial".into(),
            checks: vec![RecordCheck {
                record: key.clone(),
                version: None,
            }],
            collections: vec![],
            puts: vec![RecordPut {
                record: key,
                value: serde_json::to_string(&RecordAnchor::initial("public head".into()).unwrap())
                    .unwrap(),
            }],
            deletes: vec![],
            hints: vec![],
            journal: vec![],
        };
        crate::witness::transact(
            &connection,
            &catalog,
            &target.context().unwrap(),
            &batch,
            false,
        )
        .unwrap();
        metadata_catalog(&connection, &directory, target.clone(), &mut initialized).unwrap();
        connection
            .execute(
                &format!("DELETE FROM {catalog}.metadata_records WHERE collection=?"),
                [ANCHOR_COLLECTION],
            )
            .unwrap();
        assert!(metadata_catalog(&connection, &directory, target, &mut initialized).is_err());
        drop(connection);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
