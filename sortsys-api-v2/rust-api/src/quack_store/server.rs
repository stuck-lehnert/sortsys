use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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
        let value = crate::config::optional;
        let token = value("DUCKDB_SERVICE_TOKEN")
            .ok_or(StoreError::Configuration("service token is required"))?;
        validate_token(&token)?;
        let port = value("DUCKDB_QUACK_PORT")
            .unwrap_or_else(|| "9494".into())
            .parse::<u16>()
            .map_err(|_| StoreError::Configuration("Quack port"))?;
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
            quack_address: format!("quack:0.0.0.0:{port}"),
            control_address: control,
        })
    }
}

#[derive(Clone)]
struct Control {
    connection: Arc<Mutex<Connection>>,
    directory: Arc<PathBuf>,
    token: Arc<str>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TenantInput {
    tenant: String,
}

impl IntoResponse for StoreError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Integrity => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
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
        let result = Self {
            connection: Arc::new(Mutex::new(connection)),
            directory: Arc::new(directory),
            token: Arc::from(config.token.as_str()),
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
        operation: impl FnOnce(&Connection, &Path) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let connection = state
                .connection
                .lock()
                .map_err(|_| StoreError::Unavailable("control-lock"))?;
            operation(&connection, &state.directory)
        })
        .await
        .map_err(|_| StoreError::Unavailable("control-worker"))?
    }
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
    connection.execute_batch(&format!("BEGIN; CREATE TABLE IF NOT EXISTS {catalog}.__schema(version INTEGER PRIMARY KEY CHECK(version=1)); INSERT INTO {catalog}.__schema VALUES(1) ON CONFLICT DO NOTHING; CREATE TABLE IF NOT EXISTS {catalog}.ciphertexts(id VARCHAR PRIMARY KEY CHECK(length(id)=64),content VARCHAR NOT NULL CHECK(sha256(content)=id),created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp); COMMIT;"))
        .map_err(|_|{let _=connection.execute_batch("ROLLBACK;");StoreError::Unavailable("tenant-schema")})?;
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
        .blocking(|connection, _| {
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
        .blocking(move |connection, directory| attach(connection, directory, &id))
        .await?;
    Ok(Json(serde_json::json!({"catalog":catalog})))
}
async fn snapshot(
    State(state): State<Control>,
    Json(input): Json<TenantInput>,
) -> Result<Json<SnapshotInfo>, StoreError> {
    let tenant = tenant_id(&input.tenant)?;
    state
        .blocking(move |connection, directory| {
            let source = attach(connection, directory, &tenant)?;
            let mut random = [0u8; 32];
            getrandom::fill(&mut random).map_err(|_| StoreError::Unavailable("snapshot-id"))?;
            let id = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let target = format!("snapshot_{id}");
            let partial = directory
                .join("snapshots")
                .join(format!("{id}.partial.duckdb"));
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
            let finished = directory.join("snapshots").join(format!("{id}.duckdb"));
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
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok((headers, Body::from_stream(ReaderStream::new(file))).into_response())
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
    let private = Router::new()
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
        .blocking(move |connection, _| {
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
}
