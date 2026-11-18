//! Operator access to closed copies of encrypted tenant files. This module has
//! no decryption key, SQL console or facility for rolling security heads back.
use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    auth::AuthService,
    control::{Repository, key, tenants, unavailable},
    error::{ErrorCode, RpcResult, bad_request, not_found},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const COLLECTION: &str = "storage-snapshots";

#[derive(Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotSummary {
    id: String,
    tenant: String,
    #[ts(type = "Date")]
    created_at: DateTime<Utc>,
    #[ts(type = "number | null")]
    bytes: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotRecord {
    summary: SnapshotSummary,
    file_id: Option<String>,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct CreateInput {
    tenant: String,
    operation: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ListInput {
    tenant: String,
    #[ts(optional)]
    after: Option<String>,
    #[ts(optional)]
    version: Option<String>,
}

#[derive(Serialize, TS)]
struct SnapshotPage {
    rows: Vec<SnapshotSummary>,
    after: Option<String>,
    version: String,
}

fn record_key(tenant: &str, operation: &str) -> sortsys_zerotrust::metadata::RecordKey {
    key(COLLECTION, &format!("{tenant}:{operation}"))
}

async fn create(system: &Repository, input: CreateInput) -> RpcResult<SnapshotSummary> {
    let tenant = tenants::normalized_name(&input.tenant)?;
    let expected_file = sortsys_store::snapshot_id(&tenant, &input.operation)
        .map_err(|_| bad_request("Invalid snapshot operation"))?;
    tenants::published_repository(system, &tenant).await?;
    let record_key = record_key(&tenant, &input.operation);

    // Publish the intent before copying. A lost response or another replica can
    // resume this operation; the store also deduplicates the physical copy.
    for attempt in 0..8 {
        let mut transaction = system.transaction()?;
        let current: Option<SnapshotRecord> = transaction.read(record_key.clone()).await?;
        if let Some(current) = current {
            if current.summary.tenant != tenant || current.summary.id != input.operation {
                return Err(unavailable());
            }
            if current.file_id.is_some() {
                return Ok(current.summary);
            }
            break;
        }
        let pending = SnapshotRecord {
            summary: SnapshotSummary {
                id: input.operation.clone(),
                tenant: tenant.clone(),
                created_at: Utc::now(),
                bytes: None,
            },
            file_id: None,
        };
        transaction.put(record_key.clone(), &pending).await?;
        match transaction.commit().await {
            Ok(_) => break,
            Err(error) if error.code == ErrorCode::Conflict && attempt < 7 => continue,
            Err(error) => return Err(error),
        }
    }

    let snapshot = system
        .storage()
        .snapshot_for_operation(&tenant, &input.operation)
        .await
        .map_err(|_| unavailable())?;
    if snapshot.tenant != sortsys_store::tenant_id(&tenant).map_err(|_| unavailable())?
        || snapshot.id != expected_file
    {
        return Err(unavailable());
    }
    for attempt in 0..8 {
        let mut transaction = system.transaction()?;
        let mut current: SnapshotRecord = transaction
            .read(record_key.clone())
            .await?
            .ok_or_else(unavailable)?;
        if current.summary.id != input.operation || current.summary.tenant != tenant {
            return Err(unavailable());
        }
        if let Some(file_id) = &current.file_id {
            if file_id != &snapshot.id || current.summary.bytes != Some(snapshot.bytes) {
                return Err(unavailable());
            }
            return Ok(current.summary);
        }
        current.file_id = Some(snapshot.id.clone());
        current.summary.bytes = Some(snapshot.bytes);
        transaction.put(record_key.clone(), &current).await?;
        match transaction.commit().await {
            Ok(_) => return Ok(current.summary),
            Err(error) if error.code == ErrorCode::Conflict && attempt < 7 => continue,
            Err(error) => return Err(error),
        }
    }
    Err(unavailable())
}

pub(crate) fn register(
    mut builder: ProcedureRegistryBuilder,
    service: Arc<AuthService>,
) -> ProcedureRegistryBuilder {
    let create_service = Arc::clone(&service);
    builder = builder.mutation(
        "admin.storage.snapshots.create",
        move |ctx: RequestContext, input: CreateInput| {
            let service = Arc::clone(&create_service);
            async move {
                service.require_global_operator(&ctx.headers).await?;
                create(service.records()?, input).await
            }
        },
    );
    builder.query(
        "admin.storage.snapshots.list",
        move |ctx: RequestContext, input: ListInput| {
            let service = Arc::clone(&service);
            async move {
                service.require_global_operator(&ctx.headers).await?;
                if input.after.is_some() != input.version.is_some() {
                    return Err(bad_request(
                        "A snapshot cursor requires its collection version",
                    ));
                }
                let tenant = tenants::normalized_name(&input.tenant)?;
                let system = service.records()?;
                tenants::published_repository(system, &tenant).await?;
                let prefix = format!("{tenant}:");
                let page = system
                    .scan_prefix::<SnapshotRecord>(
                        COLLECTION,
                        Some(&prefix),
                        input.after,
                        input.version,
                        100,
                    )
                    .await?;
                let mut rows = Vec::with_capacity(page.records.len());
                for record in page.records {
                    let record = record.value.ok_or_else(unavailable)?;
                    if record.summary.tenant != tenant {
                        return Err(unavailable());
                    }
                    rows.push(record.summary);
                }
                Ok(SnapshotPage {
                    rows,
                    after: page.after,
                    version: page.version,
                })
            }
        },
    )
}

pub(crate) fn router(service: Arc<AuthService>) -> Router {
    Router::new()
        .route("/operator/snapshots/{tenant}/{operation}", get(download))
        .with_state(service)
}

async fn download(
    State(service): State<Arc<AuthService>>,
    Path((tenant, operation)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    match download_checked(&service, tenant, operation, headers).await {
        Ok(response) => response,
        Err(error) => {
            let code = match error.code {
                ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
                ErrorCode::Forbidden => StatusCode::FORBIDDEN,
                ErrorCode::NotFound => StatusCode::NOT_FOUND,
                ErrorCode::BadRequest => StatusCode::BAD_REQUEST,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            (
                code,
                [(header::CACHE_CONTROL, "no-store")],
                "Snapshot unavailable",
            )
                .into_response()
        }
    }
}

async fn download_checked(
    service: &AuthService,
    tenant: String,
    operation: String,
    headers: HeaderMap,
) -> RpcResult<Response> {
    service.require_global_operator(&headers).await?;
    let tenant = tenants::normalized_name(&tenant)?;
    let system = service.records()?;
    tenants::published_repository(system, &tenant).await?;
    let (file_id, bytes) = published_file(system, &tenant, &operation).await?;
    let response = system
        .storage()
        .download_snapshot(&file_id)
        .await
        .map_err(|_| unavailable())?;
    if response.content_length() != Some(bytes) {
        return Err(unavailable());
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CONTENT_LENGTH, bytes.into());
    let filename = format!("attachment; filename=\"{tenant}-{operation}.duckdb\"");
    headers.insert(
        header::CONTENT_DISPOSITION,
        filename.parse().map_err(|_| unavailable())?,
    );
    Ok((headers, Body::from_stream(response.bytes_stream())).into_response())
}

pub(crate) async fn published_file(
    system: &Repository,
    tenant: &str,
    operation: &str,
) -> RpcResult<(String, u64)> {
    let expected_file = sortsys_store::snapshot_id(tenant, operation)
        .map_err(|_| bad_request("Invalid snapshot operation"))?;
    let record: SnapshotRecord = system
        .read(record_key(tenant, operation))
        .await?
        .value
        .ok_or_else(not_found)?;
    if record.summary.tenant != tenant || record.summary.id != operation {
        return Err(unavailable());
    }
    let file_id = record.file_id.ok_or_else(not_found)?;
    if file_id != expected_file {
        return Err(unavailable());
    }
    Ok((file_id, record.summary.bytes.ok_or_else(unavailable)?))
}

pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .mutation_stub::<CreateInput, SnapshotSummary>("admin.storage.snapshots.create")
        .query_stub::<ListInput, SnapshotPage>("admin.storage.snapshots.list")
}
