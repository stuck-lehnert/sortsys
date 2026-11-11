//! Resumable browser-side conversion of an already plaintext legacy database.
//! New ciphertext is never decrypted or semantically validated here.
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgConnection};
use ts_rs::TS;

use super::{
    access::{Security, security},
    crypto::{encode, frame, identifier, invalid, revision, verify},
    setup::packet_hash,
    wire::{Action, EncryptedObject, Facet},
};
use crate::{
    AppState,
    api::Success,
    browser_schema,
    error::{ErrorCode, RpcError, RpcResult},
    procedures::common::{authenticated_pool, forbidden, internal, not_found},
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

const CHUNK: usize = 64 * 1024;
const PAGE_ROWS: i64 = 32;
const PAGE_BYTES: usize = 512 * 1024;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceFile {
    file_id: crate::ids::Id,
    thumbnail: bool,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceDocument {
    id: crate::ids::Id,
}
#[derive(FromRow)]
struct LegacyFile {
    storage_bucket: String,
    object_key: String,
    size_bytes: Option<i64>,
    thumbnail_object_key: Option<String>,
    thumbnail_size_bytes: Option<i64>,
}
#[derive(serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct SourceFileUrl {
    url: String,
    size_bytes: Option<i64>,
}

#[derive(Deserialize)]
struct Catalog {
    tables: Vec<Table>,
}
#[derive(Deserialize)]
struct Table {
    name: String,
    columns: Vec<Column>,
    constraints: Vec<Constraint>,
}
#[derive(Deserialize)]
struct Column {
    name: String,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Deserialize)]
struct Constraint {
    kind: String,
    columns: Vec<String>,
}
fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../schema/business.generated.json"))
            .expect("compiled business schema")
    })
}
fn table(name: &str) -> RpcResult<&'static Table> {
    catalog()
        .tables
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(invalid)
}
fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn number(value: &str) -> RpcResult<i64> {
    let parsed: i64 = value.parse().map_err(|_| invalid())?;
    if parsed < 0 || parsed.to_string() != value {
        return Err(invalid());
    }
    Ok(parsed)
}
fn conflict() -> RpcError {
    RpcError::new(ErrorCode::Conflict, "Migration progress changed").with_http_code(409)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin {
    id: String,
    schema: String,
    generation: String,
    proof: String,
}
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    id: String,
    table: String,
    row: String,
    byte: String,
}
#[derive(Serialize, TS, FromRow)]
#[serde(rename_all = "camelCase")]
struct Progress {
    table: String,
    rows: String,
    row: String,
    byte: String,
    parts: String,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Status {
    id: String,
    schema: String,
    phase: String,
    tables: Vec<Progress>,
}
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct Part {
    encoding: String,
    data: String,
    next_row: String,
    next_byte: String,
}
#[derive(Clone, Deserialize, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    tenant: String,
    migration: String,
    schema: String,
    generation: String,
    table: String,
    part: String,
    row: String,
    byte: String,
    next_row: String,
    next_byte: String,
    object: String,
    revision: String,
    ciphertext_hash: String,
    author: String,
    proof: String,
}
impl Receipt {
    fn frame(&self) -> RpcResult<Vec<u8>> {
        for value in [
            &self.tenant,
            &self.migration,
            &self.table,
            &self.object,
            &self.author,
        ] {
            identifier(value)?;
        }
        for value in [
            &self.part,
            &self.row,
            &self.byte,
            &self.next_row,
            &self.next_byte,
        ] {
            number(value)?;
        }
        revision(&self.generation)?;
        revision(&self.revision)?;
        super::crypto::sized::<32>(&self.ciphertext_hash)?;
        Ok(frame(
            "sortsys/migration-receipt/v1",
            &[
                &self.tenant,
                &self.migration,
                &self.schema,
                &self.generation,
                &self.table,
                &self.part,
                &self.row,
                &self.byte,
                &self.next_row,
                &self.next_byte,
                &self.object,
                &self.revision,
                &self.ciphertext_hash,
                &self.author,
            ],
        ))
    }
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
struct ListParts {
    id: String,
    table: String,
    after: String,
}
#[derive(Serialize, TS)]
struct ArchivedPart {
    receipt: Receipt,
    envelope: EncryptedObject,
}

fn source_permission(guard: &Security, tenant: &str) -> RpcResult<()> {
    let scope = format!("tenant:{tenant}");
    if guard.root.phase != "enrolling" {
        return Err(forbidden());
    }
    for facet in [
        Facet::Scope,
        Facet::ContractQuantities,
        Facet::Measurement,
        Facet::OfferPrices,
        Facet::Calculation,
        Facet::Procurement,
        Facet::Billing,
        Facet::MasterData,
        Facet::Personnel,
        Facet::Attachment,
    ] {
        if !guard
            .policy
            .allows(&guard.subject, &scope, facet, Action::Read)
            || !guard
                .policy
                .allows(&guard.subject, &scope, facet, Action::Grant)
        {
            return Err(forbidden());
        }
    }
    Ok(())
}

pub(super) fn register(
    builder: ProcedureRegistryBuilder,
    state: Arc<AppState>,
) -> ProcedureRegistryBuilder {
    let begin_state = Arc::clone(&state);
    let read_state = Arc::clone(&state);
    let status_state = Arc::clone(&state);
    let stage_state = Arc::clone(&state);
    let file_state = Arc::clone(&state);
    let document_state = Arc::clone(&state);
    let template_state = Arc::clone(&state);
    builder
        .query("zerotrust.migration.templateAsset", move |ctx, input: SourceDocument| {
            let state = Arc::clone(&template_state);
            async move {
                let (auth, pool) = authenticated_pool(&state, &ctx).await?;
                if !auth.is_admin() { return Err(forbidden()); }
                let mut tx = pool.begin().await.map_err(internal)?;
                let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
                source_permission(&guard, &auth.tenant)?;
                let (key, size): (String, i64) = sqlx::query_as("SELECT object_key,size_bytes FROM document_template_assets WHERE id=$1 AND ready")
                    .bind(input.id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
                if !(1..=20 * 1024 * 1024).contains(&size) { return Err(invalid()); }
                let storage = crate::object_storage::tenant_config(&state.tenants, &auth.tenant, true).await?.ok_or_else(forbidden)?;
                let signed = crate::object_storage::create_download_url(&storage, &key, None, false, crate::object_storage::Audience::Public)?;
                Ok(SourceFileUrl { url: signed.download_url, size_bytes: Some(size) })
            }
        })
        .query("zerotrust.migration.document", move |ctx, input: SourceDocument| {
            let state = Arc::clone(&document_state);
            async move {
                let (auth, pool) = authenticated_pool(&state, &ctx).await?;
                if !auth.is_admin() { return Err(forbidden()); }
                let mut tx = pool.begin().await.map_err(internal)?;
                let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
                source_permission(&guard, &auth.tenant)?;
                let (key, size): (String, i64) = sqlx::query_as("SELECT object_key,size_bytes FROM commercial_documents WHERE id=$1")
                    .bind(input.id).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(not_found)?;
                if !(1..=20 * 1024 * 1024).contains(&size) { return Err(invalid()); }
                let storage = crate::object_storage::tenant_config(&state.tenants, &auth.tenant, true).await?.ok_or_else(forbidden)?;
                let signed = crate::object_storage::create_download_url(&storage, &key, None, false, crate::object_storage::Audience::Public)?;
                Ok(SourceFileUrl { url: signed.download_url, size_bytes: Some(size) })
            }
        })
        .query("zerotrust.migration.file", move |ctx, input: SourceFile| {
            let state = Arc::clone(&file_state);
            async move {
                let (auth, pool) = authenticated_pool(&state, &ctx).await?;
                if !auth.is_admin() { return Err(forbidden()); }
                let mut tx = pool.begin().await.map_err(internal)?;
                let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
                source_permission(&guard, &auth.tenant)?;
                let row: Option<LegacyFile> = sqlx::query_as("SELECT storage_bucket,object_key,size_bytes,thumbnail_object_key,thumbnail_size_bytes FROM project_files WHERE id=$1 AND status='uploaded'")
                    .bind(input.file_id).fetch_optional(&mut *tx).await.map_err(internal)?;
                let row = row.ok_or_else(not_found)?;
                let (key, size) = if input.thumbnail { (row.thumbnail_object_key.ok_or_else(not_found)?, row.thumbnail_size_bytes) } else { (row.object_key, row.size_bytes) };
                if size.is_some_and(|size| !(0..=512 * 1024 * 1024).contains(&size)) { return Err(invalid()); }
                let storage = crate::object_storage::tenant_config(&state.tenants, &auth.tenant, true).await?.ok_or_else(forbidden)?;
                if row.storage_bucket != storage.bucket { return Err(forbidden()); }
                let signed = crate::object_storage::create_download_url(&storage, &key, None, false, crate::object_storage::Audience::Public)?;
                Ok(SourceFileUrl { url: signed.download_url, size_bytes: size })
            }
        })
        .mutation("zerotrust.migration.begin", move |ctx, input: Begin| {
            let state = Arc::clone(&begin_state);
            async move { begin(&state, &ctx, input).await }
        })
        .query("zerotrust.migration.status", move |ctx, _: ()| {
            let state = Arc::clone(&status_state);
            async move { status(&state, &ctx).await }
        })
        .query("zerotrust.migration.read", move |ctx, input: Read| {
            let state = Arc::clone(&read_state);
            async move { read(&state, &ctx, input).await }
        })
        .mutation("zerotrust.migration.stage", move |ctx, input: Receipt| {
            let state = Arc::clone(&stage_state);
            async move { stage(&state, &ctx, input).await }
        })
        .query("zerotrust.migration.parts", move |ctx, input: ListParts| {
            let state = Arc::clone(&state);
            async move { parts(&state, &ctx, input).await }
        })
}
pub(super) fn register_contract(builder: ProcedureRegistryBuilder) -> ProcedureRegistryBuilder {
    builder
        .query_stub::<SourceDocument, SourceFileUrl>("zerotrust.migration.templateAsset")
        .query_stub::<SourceDocument, SourceFileUrl>("zerotrust.migration.document")
        .query_stub::<SourceFile, SourceFileUrl>("zerotrust.migration.file")
        .mutation_stub::<Begin, Success>("zerotrust.migration.begin")
        .query_stub::<(), Option<Status>>("zerotrust.migration.status")
        .query_stub::<Read, Part>("zerotrust.migration.read")
        .mutation_stub::<Receipt, Success>("zerotrust.migration.stage")
        .query_stub::<ListParts, Vec<ArchivedPart>>("zerotrust.migration.parts")
}

async fn begin(state: &AppState, ctx: &RequestContext, input: Begin) -> RpcResult<Success> {
    identifier(&input.id)?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    if !auth.is_admin() || input.schema != browser_schema::fingerprint() {
        return Err(forbidden());
    }
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, true).await?;
    source_permission(&guard, &auth.tenant)?;
    if input.generation != guard.root.generation.to_string() {
        return Err(conflict());
    }
    verify(
        &guard.signing_key,
        &input.proof,
        &frame(
            "sortsys/migration-start/v1",
            &[&auth.tenant, &input.generation, &input.schema, &input.id],
        ),
    )?;
    if let Some((id, schema)) = sqlx::query_as::<_, (String, String)>(
        "SELECT id,schema_fingerprint FROM __zerotrust_migrations",
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    {
        if id != input.id || schema != input.schema {
            return Err(conflict());
        }
        return Ok(Success { success: true });
    }
    let organization_key = format!("sortsys.legacy.organization.{}", input.id);
    let occupied: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM global_settings WHERE key=$1)")
            .bind(&organization_key)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    if occupied {
        return Err(conflict());
    }
    let users: Vec<i64> = sqlx::query_scalar("SELECT id FROM users ORDER BY id")
        .fetch_all(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query(
        "INSERT INTO __zerotrust_migrations(id,schema_fingerprint,source_users) VALUES($1,$2,$3)",
    )
    .bind(&input.id)
    .bind(&input.schema)
    .bind(&users)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    for table in &catalog().tables {
        let predicate = if table.name == "users" {
            " WHERE id=ANY($1)"
        } else {
            ""
        };
        let sql = format!("SELECT count(*) FROM {}{}", quoted(&table.name), predicate);
        let mut query = sqlx::query_scalar::<_, i64>(&sql);
        if table.name == "users" {
            query = query.bind(&users);
        }
        let count = query.fetch_one(&mut *tx).await.map_err(internal)?;
        // Organization settings used to live in the master database. Preserve
        // them as an additional, collision-checked logical settings row.
        let count = if table.name == "global_settings" {
            count.checked_add(1).ok_or_else(invalid)?
        } else {
            count
        };
        sqlx::query("INSERT INTO __zerotrust_migration_progress(migration_id,table_name,row_count) VALUES($1,$2,$3)").bind(&input.id).bind(&table.name).bind(count).execute(&mut *tx).await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn status(state: &AppState, ctx: &RequestContext) -> RpcResult<Option<Status>> {
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    source_permission(&guard, &auth.tenant)?;
    let Some((id, schema, phase)) = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id,schema_fingerprint,phase FROM __zerotrust_migrations",
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    else {
        return Ok(None);
    };
    let tables=sqlx::query_as::<_,Progress>("SELECT table_name AS \"table\",row_count::text AS rows,row_cursor::text AS row,byte_cursor::text AS byte,parts::text FROM __zerotrust_migration_progress WHERE migration_id=$1 ORDER BY table_name").bind(&id).fetch_all(&mut *tx).await.map_err(internal)?;
    Ok(Some(Status {
        id,
        schema,
        phase,
        tables,
    }))
}

fn row_expression(table: &Table) -> String {
    let mut fields = Vec::new();
    for column in &table.columns {
        let col = format!("t.{}", quoted(&column.name));
        let value = match column.kind.as_str() {
            // JSON is text on the wire too: nested 64-bit numbers must never
            // pass through JavaScript's floating-point JSON representation.
            // SQL NULL remains null; JSON null is the string "null".
            "int2" | "int4" | "int8" | "numeric" | "jsonb" => format!("{col}::text"),
            "_int8" => format!(
                "CASE WHEN {col} IS NULL THEN NULL ELSE ARRAY(SELECT x::text FROM unnest({col}) x) END"
            ),
            _ => col,
        };
        fields.push(format!("'{}',{}", column.name.replace('\'', "''"), value));
    }
    format!(
        "jsonb_build_object('format','sortsys-row-v2','schema',$1::text,'table','{}','values',jsonb_build_object({}))::text",
        table.name,
        fields.join(",")
    )
}
async fn source_users(tx: &mut PgConnection, id: &str) -> RpcResult<Vec<i64>> {
    let Some((schema,users))=sqlx::query_as::<_,(String,Vec<i64>)>("SELECT schema_fingerprint,source_users FROM __zerotrust_migrations WHERE id=$1 AND phase IN ('copying','copied')").bind(id).fetch_optional(tx).await.map_err(internal)? else{return Err(not_found())};
    if schema != browser_schema::fingerprint() {
        return Err(conflict());
    }
    Ok(users)
}
async fn read(state: &AppState, ctx: &RequestContext, input: Read) -> RpcResult<Part> {
    identifier(&input.id)?;
    let table = table(&input.table)?;
    let row = number(&input.row)?;
    let byte = number(&input.byte)?;
    if byte >= i32::MAX as i64 {
        return Err(invalid());
    }
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    source_permission(&guard, &auth.tenant)?;
    let users = source_users(&mut tx, &input.id).await?;
    let count:i64=sqlx::query_scalar("SELECT row_count FROM __zerotrust_migration_progress WHERE migration_id=$1 AND table_name=$2").bind(&input.id).bind(&table.name).fetch_one(&mut *tx).await.map_err(internal)?;
    if row >= count {
        return Err(invalid());
    }
    if table.name == "global_settings" && row == count - 1 {
        let organization: String =
            sqlx::query_scalar("SELECT contact_details::text FROM __tenants WHERE name=$1")
                .bind(&auth.tenant)
                .fetch_one(state.tenants.master())
                .await
                .map_err(internal)?;
        let source=serde_json::json!({"format":"sortsys-row-v2","schema":browser_schema::fingerprint(),"table":"global_settings","values":{"key":format!("sortsys.legacy.organization.{}",input.id),"name":organization}}).to_string();
        let data = source.as_bytes();
        if data.len() <= CHUNK && byte == 0 {
            return Ok(Part {
                encoding: "rows".into(),
                data: encode(&serde_json::to_vec(&vec![source]).map_err(internal)?),
                next_row: (row + 1).to_string(),
                next_byte: "0".into(),
            });
        }
        let start = usize::try_from(byte).map_err(|_| invalid())?;
        if start >= data.len() {
            return Err(invalid());
        }
        let end = start.saturating_add(CHUNK).min(data.len());
        return Ok(Part {
            encoding: "row-chunk".into(),
            data: encode(&data[start..end]),
            next_row: if end == data.len() {
                (row + 1).to_string()
            } else {
                row.to_string()
            },
            next_byte: if end == data.len() {
                "0".into()
            } else {
                end.to_string()
            },
        });
    }
    let keys = table
        .constraints
        .iter()
        .find(|c| c.kind == "p")
        .ok_or_else(invalid)?;
    let predicate = if table.name == "users" {
        " WHERE t.id=ANY($3)"
    } else {
        ""
    };
    // $1/$2/$3 are always bound; using a harmless $3 test also for other tables
    // avoids ambiguous unused parameter types in the prepared statement.
    let predicate = if predicate.is_empty() {
        " WHERE cardinality($3::bigint[])>=0"
    } else {
        predicate
    };
    let source = format!(
        "SELECT {} AS source FROM {} t{} ORDER BY {} OFFSET $2 LIMIT {}",
        row_expression(table),
        quoted(&table.name),
        predicate,
        keys.columns
            .iter()
            .map(|c| format!("t.{}", quoted(c)))
            .collect::<Vec<_>>()
            .join(","),
        PAGE_ROWS
    );
    if byte == 0 {
        let sql = format!(
            "SELECT CASE WHEN octet_length(source)<={} THEN source ELSE NULL END,octet_length(source)::bigint FROM ({source}) s",
            CHUNK
        );
        let rows: Vec<(Option<String>, i64)> = sqlx::query_as(&sql)
            .bind(browser_schema::fingerprint())
            .bind(row)
            .bind(&users)
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
        let mut selected = Vec::new();
        let mut size = 0;
        for (source, _) in &rows {
            let Some(source) = source else { break };
            if size + source.len() > PAGE_BYTES {
                break;
            }
            size += source.len();
            selected.push(source);
        }
        if !selected.is_empty() {
            let next = row.checked_add(selected.len() as i64).ok_or_else(invalid)?;
            return Ok(Part {
                encoding: "rows".into(),
                data: encode(&serde_json::to_vec(&selected).map_err(internal)?),
                next_row: next.to_string(),
                next_byte: "0".into(),
            });
        }
    }
    let source = source.replace(&format!("LIMIT {PAGE_ROWS}"), "LIMIT 1");
    let sql = format!(
        "SELECT substring(convert_to(source,'UTF8') FROM $4::int+1 FOR $5::int),octet_length(source)::bigint FROM ({source}) s"
    );
    let (data, total): (Vec<u8>, i64) = sqlx::query_as(&sql)
        .bind(browser_schema::fingerprint())
        .bind(row)
        .bind(&users)
        .bind(i32::try_from(byte).map_err(|_| invalid())?)
        .bind(CHUNK as i32)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if data.is_empty() || byte >= total {
        return Err(invalid());
    }
    let end = byte.checked_add(data.len() as i64).ok_or_else(invalid)?;
    Ok(Part {
        encoding: "row-chunk".into(),
        data: encode(&data),
        next_row: if end == total {
            (row + 1).to_string()
        } else {
            row.to_string()
        },
        next_byte: if end == total {
            "0".into()
        } else {
            end.to_string()
        },
    })
}

async fn stage(state: &AppState, ctx: &RequestContext, input: Receipt) -> RpcResult<Success> {
    let message = input.frame()?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    source_permission(&guard, &auth.tenant)?;
    if input.tenant != auth.tenant
        || input.generation != guard.root.generation.to_string()
        || input.author != guard.subject
        || input.schema != browser_schema::fingerprint()
    {
        return Err(forbidden());
    }
    verify(&guard.signing_key, &input.proof, &message)?;
    source_users(&mut tx, &input.migration).await?;
    let progress:Option<(i64,i64,i64,i64)>=sqlx::query_as("SELECT row_count,row_cursor,byte_cursor,parts FROM __zerotrust_migration_progress WHERE migration_id=$1 AND table_name=$2 FOR UPDATE").bind(&input.migration).bind(&input.table).fetch_optional(&mut *tx).await.map_err(internal)?;
    let (count, row, byte, part) = progress.ok_or_else(invalid)?;
    let value = serde_json::to_value(&input).map_err(internal)?;
    let index = number(&input.part)?;
    if index < part {
        let prior:Option<Value>=sqlx::query_scalar("SELECT receipt FROM __zerotrust_migration_parts WHERE migration_id=$1 AND table_name=$2 AND part=$3").bind(&input.migration).bind(&input.table).bind(index).fetch_optional(&mut *tx).await.map_err(internal)?;
        return if prior.as_ref() == Some(&value) {
            Ok(Success { success: true })
        } else {
            Err(conflict())
        };
    }
    let next_row = number(&input.next_row)?;
    let next_byte = number(&input.next_byte)?;
    if index != part
        || number(&input.row)? != row
        || number(&input.byte)? != byte
        || next_row > count
        || next_row < row
        || (next_row == row && (next_byte <= byte || next_byte - byte > CHUNK as i64))
        || (next_row > row
            && (next_byte != 0 || next_row - row > PAGE_ROWS || (byte > 0 && next_row - row != 1)))
    {
        return Err(conflict());
    }
    let value_object: Value = sqlx::query_scalar(
        "SELECT envelope FROM __zerotrust_changes WHERE object_id=$1 AND revision=$2",
    )
    .bind(&input.object)
    .bind(revision(&input.revision)?)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;
    let envelope = super::objects::read_envelope(state, &auth.tenant, value_object).await?;
    let scope = format!("migration:{}", input.migration);
    if envelope.scope != scope
        || envelope.facet != Facet::Attachment
        || envelope.tenant != auth.tenant
        || envelope.author != guard.subject
        || !guard
            .policy
            .allows(&guard.subject, &scope, Facet::Attachment, Action::Read)
        || packet_hash(envelope.frame()?, &envelope.signature)? != input.ciphertext_hash
    {
        return Err(forbidden());
    }
    envelope.verify(&guard.signing_key)?;
    sqlx::query("INSERT INTO __zerotrust_migration_parts(migration_id,table_name,part,object_id,object_revision,receipt) VALUES($1,$2,$3,$4,$5,$6)").bind(&input.migration).bind(&input.table).bind(part).bind(&input.object).bind(revision(&input.revision)?).bind(&value).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_migration_progress SET row_cursor=$3,byte_cursor=$4,parts=parts+1 WHERE migration_id=$1 AND table_name=$2").bind(&input.migration).bind(&input.table).bind(next_row).bind(next_byte).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("UPDATE __zerotrust_migrations SET phase='copied' WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM __zerotrust_migration_progress WHERE migration_id=$1 AND (row_cursor<>row_count OR byte_cursor<>0))").bind(&input.migration).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Success { success: true })
}
async fn parts(
    state: &AppState,
    ctx: &RequestContext,
    input: ListParts,
) -> RpcResult<Vec<ArchivedPart>> {
    identifier(&input.id)?;
    table(&input.table)?;
    let after = number(&input.after)?;
    let (auth, pool) = authenticated_pool(state, ctx).await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let guard = security(&mut tx, state.tenants.master(), &auth, false).await?;
    source_permission(&guard, &auth.tenant)?;
    source_users(&mut tx, &input.id).await?;
    let scope = format!("migration:{}", input.id);
    if !guard
        .policy
        .allows(&guard.subject, &scope, Facet::Attachment, Action::Read)
    {
        return Err(forbidden());
    }
    let rows:Vec<(Value,Value)>=sqlx::query_as("SELECT p.receipt,c.envelope FROM __zerotrust_migration_parts p JOIN __zerotrust_changes c ON c.object_id=p.object_id AND c.revision=p.object_revision WHERE p.migration_id=$1 AND p.table_name=$2 AND p.part >= $3 ORDER BY p.part LIMIT 8").bind(&input.id).bind(&input.table).bind(after).fetch_all(&mut *tx).await.map_err(internal)?;
    let mut parts = Vec::with_capacity(rows.len());
    for (receipt, envelope) in rows {
        parts.push(ArchivedPart {
            receipt: serde_json::from_value(receipt).map_err(|_| invalid())?,
            envelope: super::objects::read_envelope(state, &auth.tenant, envelope).await?,
        });
    }
    Ok(parts)
}
