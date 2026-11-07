//! Organization-wide native Typst source and uploaded template assets.
use super::common::{
    authenticated_pool, bad_request, forbidden, internal, not_found, trim_required,
};
use crate::{
    AppState,
    api::Success,
    error::{ErrorCode, RpcError, RpcResult},
    ids::Id,
    object_storage::{self, Audience},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, types::Json};
use std::{collections::BTreeMap, sync::Arc};
use ts_rs::TS;
const KEY: &str = "organization.documentTemplate";
const MAX_ASSET: usize = 20 * 1024 * 1024;
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SavedTemplate {
    source: Option<String>,
    revision: String,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Template {
    source: Option<String>,
    revision: String,
    assets: Vec<Asset>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Asset {
    id: Id,
    name: String,
    mime_type: String,
    size_bytes: u32,
    download_url: Option<String>,
}
#[derive(Debug, FromRow)]
struct AssetRow {
    id: Id,
    name: String,
    mime_type: String,
    size_bytes: i64,
    object_key: String,
    ready: bool,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetTemplate {
    source: String,
    expected_revision: String,
}
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadAsset {
    name: String,
    mime_type: String,
    size_bytes: u32,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Upload {
    id: Id,
    upload_url: String,
    upload_method: &'static str,
    upload_headers: BTreeMap<String, String>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct AssetId {
    id: Id,
}
fn admin(roles: &[String]) -> RpcResult<()> {
    if roles.iter().any(|role| role == ":admin") {
        Ok(())
    } else {
        Err(forbidden())
    }
}
pub fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<(), Template>("settings.documentTemplate.get")
        .mutation_stub::<SetTemplate, SavedTemplate>("settings.documentTemplate.set")
        .mutation_stub::<UploadAsset, Upload>("settings.documentTemplate.assets.createUpload")
        .mutation_stub::<AssetId, Success>("settings.documentTemplate.assets.completeUpload")
        .mutation_stub::<AssetId, Success>("settings.documentTemplate.assets.delete")
}
pub fn register(
    mut builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let current = Arc::clone(&state);
    builder = builder.query(
        "settings.documentTemplate.get",
        move |context, _input: ()| {
            let state = Arc::clone(&current);
            async move { get(&state, &context).await }
        },
    );
    let current = Arc::clone(&state);
    builder = builder.mutation("settings.documentTemplate.set", move |context, input| {
        let state = Arc::clone(&current);
        async move { set(&state, &context, input).await }
    });
    let current = Arc::clone(&state);
    builder = builder.mutation(
        "settings.documentTemplate.assets.createUpload",
        move |context, input| {
            let state = Arc::clone(&current);
            async move { create_upload(&state, &context, input).await }
        },
    );
    let current = Arc::clone(&state);
    builder = builder.mutation(
        "settings.documentTemplate.assets.completeUpload",
        move |context, input| {
            let state = Arc::clone(&current);
            async move { complete_upload(&state, &context, input).await }
        },
    );
    builder.mutation(
        "settings.documentTemplate.assets.delete",
        move |context, input| {
            let state = Arc::clone(&state);
            async move { delete(&state, &context, input).await }
        },
    )
}
async fn get(state: &AppState, context: &RequestContext) -> RpcResult<Template> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    let saved: Option<Json<SavedTemplate>> =
        sqlx::query_scalar("SELECT name FROM global_settings WHERE key=$1")
            .bind(KEY)
            .fetch_optional(&pool)
            .await
            .map_err(internal)?
            .flatten();
    let saved = saved.map(|value| value.0).unwrap_or(SavedTemplate {
        source: None,
        revision: "0".into(),
    });
    let rows=sqlx::query_as::<_,AssetRow>("SELECT id,name,mime_type,size_bytes,object_key,ready FROM document_template_assets WHERE ready ORDER BY name").fetch_all(&pool).await.map_err(internal)?;
    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, false).await?;
    let assets = rows
        .into_iter()
        .map(|row| {
            Ok(Asset {
                id: row.id,
                name: row.name.clone(),
                mime_type: row.mime_type,
                size_bytes: u32::try_from(row.size_bytes).map_err(internal)?,
                download_url: storage
                    .as_ref()
                    .map(|storage| {
                        object_storage::create_download_url(
                            storage,
                            &row.object_key,
                            Some(&row.name),
                            false,
                            Audience::Public,
                        )
                        .map(|signed| signed.download_url)
                    })
                    .transpose()?,
            })
        })
        .collect::<RpcResult<Vec<_>>>()?;
    Ok(Template {
        source: saved.source,
        revision: saved.revision,
        assets,
    })
}
async fn set(
    state: &AppState,
    context: &RequestContext,
    input: SetTemplate,
) -> RpcResult<SavedTemplate> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    admin(&auth.roles)?;
    if input.source.trim().is_empty() || input.source.len() > 512 * 1024 {
        return Err(bad_request("Template source must contain 1–524288 bytes"));
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    sqlx::query("INSERT INTO global_settings(key,name) VALUES($1,$2) ON CONFLICT(key) DO NOTHING")
        .bind(KEY)
        .bind(Json(SavedTemplate {
            source: None,
            revision: "0".into(),
        }))
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    let current: Json<SavedTemplate> =
        sqlx::query_scalar("SELECT name FROM global_settings WHERE key=$1 FOR UPDATE")
            .bind(KEY)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    if current.0.revision != input.expected_revision {
        return Err(RpcError::new(
            ErrorCode::Conflict,
            "The document template was changed by another administrator",
        ));
    }
    let saved = SavedTemplate {
        revision: Sha256::digest(input.source.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        source: Some(input.source),
    };
    sqlx::query("UPDATE global_settings SET name=$2 WHERE key=$1")
        .bind(KEY)
        .bind(Json(saved.clone()))
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(saved)
}
async fn create_upload(
    state: &AppState,
    context: &RequestContext,
    mut input: UploadAsset,
) -> RpcResult<Upload> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    admin(&auth.roles)?;
    trim_required(&mut input.name, "name", 180)?;
    if input.name.contains(['/', '\\', '\0'])
        || input.name.starts_with('.')
        || input.size_bytes == 0
        || input.size_bytes as usize > MAX_ASSET
    {
        return Err(bad_request("Invalid template asset name or size"));
    }
    let expected = match input
        .name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => return Err(bad_request("Only image and PDF assets are supported")),
    };
    if input.mime_type != expected {
        return Err(bad_request("Asset MIME type does not match its extension"));
    }
    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .expect("required storage");
    let id: Id = sqlx::query_scalar("SELECT id64()")
        .fetch_one(&pool)
        .await
        .map_err(internal)?;
    let key = object_storage::build_template_object_key(&storage, id, &input.name);
    sqlx::query("INSERT INTO document_template_assets(id,name,mime_type,size_bytes,object_key,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(&input.name).bind(&input.mime_type).bind(i64::from(input.size_bytes)).bind(&key).bind(auth.user.id.parse::<i64>().map_err(internal)?).execute(&pool).await.map_err(internal)?;
    let signed =
        object_storage::create_upload_url(&storage, &key, &input.mime_type, Audience::Public)?;
    Ok(Upload {
        id,
        upload_url: signed.upload_url,
        upload_method: "PUT",
        upload_headers: BTreeMap::from([("Content-Type".into(), input.mime_type)]),
    })
}
async fn complete_upload(
    state: &AppState,
    context: &RequestContext,
    input: AssetId,
) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    admin(&auth.roles)?;
    let row=sqlx::query_as::<_,AssetRow>("SELECT id,name,mime_type,size_bytes,object_key,ready FROM document_template_assets WHERE id=$1").bind(input.id).fetch_optional(&pool).await.map_err(internal)?.ok_or_else(not_found)?;
    if row.ready {
        return Ok(Success { success: true });
    }
    let storage = object_storage::tenant_config(&state.tenants, &auth.tenant, true)
        .await?
        .expect("required storage");
    let signed = object_storage::create_download_url(
        &storage,
        &row.object_key,
        Some(&row.name),
        false,
        Audience::Internal,
    )?;
    let response = reqwest::Client::new()
        .get(signed.download_url)
        .send()
        .await
        .map_err(internal)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_ASSET as u64)
    {
        return Err(bad_request("Asset upload is missing or too large"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.try_next().await.map_err(internal)? {
        if bytes.len() + chunk.len() > MAX_ASSET {
            return Err(bad_request("Asset is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let valid = match row.mime_type.as_str() {
        "application/pdf" => bytes.windows(5).take(1024).any(|part| part == b"%PDF-"),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[255, 216, 255]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/svg+xml" => {
            String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).contains("<svg")
        }
        _ => false,
    };
    if !valid || bytes.len() as i64 != row.size_bytes {
        return Err(bad_request(
            "Asset content or size does not match its upload",
        ));
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&row.name)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE document_template_assets SET ready=false WHERE name=$1 AND ready")
        .bind(&row.name)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE document_template_assets SET ready=true WHERE id=$1")
        .bind(input.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn delete(state: &AppState, context: &RequestContext, input: AssetId) -> RpcResult<Success> {
    let (auth, pool) = authenticated_pool(state, context).await?;
    admin(&auth.roles)?;
    let deleted = sqlx::query("DELETE FROM document_template_assets WHERE id=$1")
        .bind(input.id)
        .execute(&pool)
        .await
        .map_err(internal)?;
    if deleted.rows_affected() == 0 {
        return Err(not_found());
    }
    // Keep immutable objects available for exports already using a signed URL.
    Ok(Success { success: true })
}
