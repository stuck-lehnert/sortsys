//! Managed PostgreSQL hosts, databases, and streaming S3-compatible backups.

use std::{
    collections::HashSet,
    fs::File as StdFile,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Datelike, Utc};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions, types::Json};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use ts_rs::TS;
use url::Url;

use crate::{
    AppState,
    error::{ErrorCode, RpcError, RpcResult},
    object_storage::{self, Audience, EnabledStorage},
};

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostConnection {
    pub host: String,

    #[serde(default = "default_postgres_port")]
    pub port: u16,

    #[serde(default = "default_admin_database")]
    pub admin_database: String,

    pub admin_username: String,
    pub admin_password: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostBackup {
    #[serde(default)]
    pub enabled: bool,

    pub bucket: Option<String>,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub public_base_url: Option<String>,

    #[serde(default)]
    pub force_path_style: bool,

    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
    pub key_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ManagedHost {
    pub id: String,
    pub name: String,
    pub connection_details: HostConnection,
    pub backup_details: HostBackup,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ManagedDatabase {
    pub id: String,
    pub host_id: String,
    pub host_name: String,
    pub name: String,
    pub username: String,
    pub password: String,
    pub retention_daily: i32,
    pub retention_weekly: i32,
    pub retention_monthly: i32,
    pub retention_yearly: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub host: ManagedHost,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub database_id: String,
    pub kind: String,
    pub state: String,
    pub object_key: Option<String>,
    pub size_bytes: Option<i64>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

pub async fn list_hosts(state: &AppState) -> RpcResult<Vec<ManagedHost>> {
    let rows = sqlx::query_as::<_, HostRow>("SELECT * FROM __postgres_hosts ORDER BY name")
        .fetch_all(state.tenants.master())
        .await
        .map_err(internal)?;

    rows.into_iter().map(ManagedHost::try_from).collect()
}

pub async fn host(state: &AppState, id: i64) -> RpcResult<ManagedHost> {
    let row = sqlx::query_as::<_, HostRow>("SELECT * FROM __postgres_hosts WHERE id = $1")
        .bind(id)
        .fetch_optional(state.tenants.master())
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;

    ManagedHost::try_from(row)
}

pub async fn list_databases(state: &AppState) -> RpcResult<Vec<ManagedDatabase>> {
    let rows = database_query()
        .fetch_all(state.tenants.master())
        .await
        .map_err(internal)?;

    rows.into_iter().map(ManagedDatabase::try_from).collect()
}

pub async fn database(state: &AppState, id: i64) -> RpcResult<ManagedDatabase> {
    let row = sqlx::query_as::<_, DatabaseRow>(
        r#"
        SELECT
            database.*,
            host.name AS host_name,
            host.connection_details AS host_connection_details,
            host.backup_details AS host_backup_details,
            host.created_at AS host_created_at,
            host.updated_at AS host_updated_at
        FROM __postgres_databases AS database
        INNER JOIN __postgres_hosts AS host
            ON host.id = database.host_id
        WHERE database.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(state.tenants.master())
    .await
    .map_err(internal)?
    .ok_or_else(not_found)?;

    ManagedDatabase::try_from(row)
}

fn database_query()
-> sqlx::query::QueryAs<'static, sqlx::Postgres, DatabaseRow, sqlx::postgres::PgArguments> {
    sqlx::query_as::<_, DatabaseRow>(
        r#"
        SELECT
            database.*,
            host.name AS host_name,
            host.connection_details AS host_connection_details,
            host.backup_details AS host_backup_details,
            host.created_at AS host_created_at,
            host.updated_at AS host_updated_at
        FROM __postgres_databases AS database
        INNER JOIN __postgres_hosts AS host
            ON host.id = database.host_id
        ORDER BY host.name, database.name
        "#,
    )
}

pub async fn create_database_on_host(
    state: &AppState,
    host_id: i64,
    name: &str,
    requested_username: Option<&str>,
    retention: Retention,
) -> RpcResult<CreatedDatabase> {
    validate_identifier(name)?;
    let host = host(state, host_id).await?;
    let username = requested_username
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{name}_app").chars().take(63).collect());
    validate_identifier(&username)?;
    let password = super_password()?;

    let admin_pool = host_admin_pool(&host).await?;
    let database_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)",
    )
    .bind(name)
    .fetch_one(&admin_pool)
    .await
    .map_err(internal)?;
    let role_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)")
            .bind(&username)
            .fetch_one(&admin_pool)
            .await
            .map_err(internal)?;

    if database_exists || role_exists {
        return Err(conflict("database or role already exists on the host"));
    }

    let create_role = format!(
        "CREATE ROLE {} LOGIN PASSWORD {}",
        quote_identifier(&username)?,
        quote_literal(&password)
    );
    sqlx::query(&create_role)
        .execute(&admin_pool)
        .await
        .map_err(internal)?;

    let create_database = format!(
        "CREATE DATABASE {} OWNER {}",
        quote_identifier(name)?,
        quote_identifier(&username)?
    );
    if let Err(error) = sqlx::query(&create_database).execute(&admin_pool).await {
        let cleanup = format!("DROP ROLE IF EXISTS {}", quote_identifier(&username)?);
        let _ = sqlx::query(&cleanup).execute(&admin_pool).await;

        return Err(internal(error));
    }

    let inserted = sqlx::query_as::<_, CreatedDatabaseRow>(
        r#"
        INSERT INTO __postgres_databases (
            host_id,
            name,
            username,
            password,
            retention_daily,
            retention_weekly,
            retention_monthly,
            retention_yearly
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, host_id, name, username, password
        "#,
    )
    .bind(host_id)
    .bind(name)
    .bind(&username)
    .bind(&password)
    .bind(retention.daily)
    .bind(retention.weekly)
    .bind(retention.monthly)
    .bind(retention.yearly)
    .fetch_one(state.tenants.master())
    .await;

    match inserted {
        Ok(row) => Ok(CreatedDatabase::from(row)),
        Err(error) => {
            let drop_database = format!("DROP DATABASE IF EXISTS {}", quote_identifier(name)?);
            let drop_role = format!("DROP ROLE IF EXISTS {}", quote_identifier(&username)?);
            let _ = sqlx::query(&drop_database).execute(&admin_pool).await;
            let _ = sqlx::query(&drop_role).execute(&admin_pool).await;

            Err(internal(error))
        }
    }
}

pub async fn rotate_credentials(
    state: &AppState,
    database_id: i64,
) -> RpcResult<RotatedCredentials> {
    let database = database(state, database_id).await?;
    let password = super_password()?;
    let admin_pool = host_admin_pool(&database.host).await?;
    let statement = format!(
        "ALTER ROLE {} WITH PASSWORD {}",
        quote_identifier(&database.username)?,
        quote_literal(&password)
    );

    sqlx::query(&statement)
        .execute(&admin_pool)
        .await
        .map_err(internal)?;

    sqlx::query("UPDATE __postgres_databases SET password = $2, updated_at = NOW() WHERE id = $1")
        .bind(database_id)
        .bind(&password)
        .execute(state.tenants.master())
        .await
        .map_err(internal)?;

    Ok(RotatedCredentials {
        id: database.id,
        username: database.username,
        password,
    })
}

pub async fn list_backups(
    state: &AppState,
    database_id: i64,
    include_failed: bool,
) -> RpcResult<Vec<Backup>> {
    let rows = sqlx::query_as::<_, BackupRow>(
        r#"
        SELECT *
        FROM __postgres_database_backups
        WHERE database_id = $1
          AND ($2 OR state = 'uploaded')
        ORDER BY created_at DESC
        "#,
    )
    .bind(database_id)
    .bind(include_failed)
    .fetch_all(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(rows.into_iter().map(Backup::from).collect())
}

pub async fn backup(state: &AppState, backup_id: i64) -> RpcResult<Backup> {
    sqlx::query_as::<_, BackupRow>("SELECT * FROM __postgres_database_backups WHERE id = $1")
        .bind(backup_id)
        .fetch_optional(state.tenants.master())
        .await
        .map_err(internal)?
        .map(Backup::from)
        .ok_or_else(not_found)
}

pub async fn create_backup(state: &AppState, database_id: i64, kind: &str) -> RpcResult<Backup> {
    if !matches!(kind, "manual" | "auto") {
        return Err(bad_request("invalid backup kind"));
    }

    let database = database(state, database_id).await?;
    let storage = backup_storage(&database.host)?;
    let backup_id = insert_processing_backup(state, database_id, kind, None).await?;
    let temp = TempDirectory::create("sortsys-db-backup").await?;
    let sql_path = temp.path.join("backup.sql");
    let gzip_path = temp.path.join("backup.sql.gz");

    let result = async {
        dump_database(&database, &sql_path).await?;
        gzip_file(&sql_path, &gzip_path).await?;

        let object_key = backup_object_key(&database, Utc::now(), ".sql.gz");
        let size = tokio::fs::metadata(&gzip_path)
            .await
            .map_err(internal)?
            .len() as i64;
        upload_file(&storage, &object_key, "application/gzip", &gzip_path).await?;

        mark_backup_uploaded(state, backup_id, &object_key, size).await?;
        apply_retention(state, &database, &storage).await?;

        backup(state, backup_id).await
    }
    .await;

    if let Err(error) = &result {
        mark_backup_failed(state, backup_id, error.to_string()).await;
    }

    temp.remove().await;
    result
}

pub async fn upload_backup(
    state: &AppState,
    database_id: i64,
    file_name: &str,
    file_base64: &str,
) -> RpcResult<Backup> {
    let database = database(state, database_id).await?;
    let storage = backup_storage(&database.host)?;
    let payload = decode_backup_payload(file_base64)?;
    let extension = backup_extension(file_name);
    let object_key = backup_object_key(&database, Utc::now(), extension);
    let backup_id =
        insert_processing_backup(state, database_id, "manual", Some(&object_key)).await?;

    let result = async {
        let content_type = if extension == ".sql" {
            "application/sql"
        } else {
            "application/gzip"
        };
        upload_bytes(&storage, &object_key, content_type, payload.clone()).await?;
        mark_backup_uploaded(state, backup_id, &object_key, payload.len() as i64).await?;
        apply_retention(state, &database, &storage).await?;

        backup(state, backup_id).await
    }
    .await;

    if let Err(error) = &result {
        mark_backup_failed(state, backup_id, error.to_string()).await;
    }

    result
}

pub async fn download_url(
    state: &AppState,
    backup_id: i64,
    expires_in_seconds: u64,
) -> RpcResult<(Backup, String)> {
    let backup = backup(state, backup_id).await?;
    if backup.state != "uploaded" {
        return Err(conflict("backup is not available for download"));
    }

    let object_key = backup
        .object_key
        .as_deref()
        .ok_or_else(|| conflict("backup has no object key"))?;
    let database = database(state, backup.database_id.parse::<i64>().map_err(internal)?).await?;
    let mut storage = backup_storage(&database.host)?;
    storage.download_url_ttl_sec = expires_in_seconds.clamp(60, 24 * 60 * 60);
    let extension = backup_extension(object_key);
    let timestamp = backup.created_at.format("%Y-%m-%dT%H-%M-%S-%3fZ");
    let file_name = format!("{}-{timestamp}{extension}", database.name);
    let signed = object_storage::create_download_url(
        &storage,
        object_key,
        Some(&file_name),
        true,
        Audience::Public,
    )?;

    Ok((backup, signed.download_url))
}

pub async fn restore_backup(
    state: &AppState,
    backup_id: i64,
    target_database_id: Option<i64>,
) -> RpcResult<RestoreOutput> {
    let backup = backup(state, backup_id).await?;
    if backup.state != "uploaded" {
        return Err(conflict("backup is not available for restore"));
    }

    let source_database_id = backup.database_id.parse::<i64>().map_err(internal)?;
    let source_database = database(state, source_database_id).await?;
    let target_database = database(state, target_database_id.unwrap_or(source_database_id)).await?;
    let storage = backup_storage(&source_database.host)?;
    let object_key = backup
        .object_key
        .as_deref()
        .ok_or_else(|| conflict("backup has no object key"))?;

    let temp = TempDirectory::create("sortsys-db-restore").await?;
    let source_path = temp.path.join("restore.source");
    let sql_path = temp.path.join("restore.sql");

    let result = async {
        download_file(&storage, object_key, &source_path).await?;
        prepare_restore_sql(&source_path, &sql_path, &target_database).await?;
        restore_database(&target_database, &sql_path).await?;

        Ok(RestoreOutput {
            backup_id: backup.id,
            target_database_id: target_database.id,
        })
    }
    .await;

    temp.remove().await;
    result
}

pub async fn fork_from_backup(state: &AppState, input: ForkInput) -> RpcResult<ForkOutput> {
    let backup = backup(state, input.backup_id).await?;
    if backup.state != "uploaded" {
        return Err(conflict("backup is not available for restore"));
    }

    let source_database =
        database(state, backup.database_id.parse::<i64>().map_err(internal)?).await?;
    let target_host_id = input
        .host_id
        .unwrap_or_else(|| source_database.host_id.parse().unwrap_or_default());
    let retention = Retention {
        daily: input
            .retention_daily
            .unwrap_or(source_database.retention_daily),
        weekly: input
            .retention_weekly
            .unwrap_or(source_database.retention_weekly),
        monthly: input
            .retention_monthly
            .unwrap_or(source_database.retention_monthly),
        yearly: input
            .retention_yearly
            .unwrap_or(source_database.retention_yearly),
    };

    let created = create_database_on_host(
        state,
        target_host_id,
        &input.name,
        input.username.as_deref(),
        retention,
    )
    .await?;

    let created_id = created.id.parse::<i64>().map_err(internal)?;
    if let Err(error) = restore_backup(state, input.backup_id, Some(created_id)).await {
        let _ = sqlx::query("DELETE FROM __postgres_databases WHERE id = $1")
            .bind(created_id)
            .execute(state.tenants.master())
            .await;
        let _ = drop_database_and_role(
            &host(state, target_host_id).await?,
            &created.name,
            &created.username,
        )
        .await;

        return Err(error);
    }

    Ok(ForkOutput {
        id: created.id,
        host_id: created.host_id,
        name: created.name,
        username: created.username,
        password: created.password,
        restored_from_backup_id: backup.id,
    })
}

async fn host_admin_pool(host: &ManagedHost) -> RpcResult<PgPool> {
    let details = &host.connection_details;
    let mut url = Url::parse("postgresql://localhost/postgres").expect("static PostgreSQL URL");
    url.set_host(Some(&details.host))
        .map_err(|_| bad_request("invalid PostgreSQL host"))?;
    url.set_port(Some(details.port))
        .map_err(|_| bad_request("invalid PostgreSQL port"))?;
    url.set_username(&details.admin_username)
        .map_err(|_| bad_request("invalid PostgreSQL admin username"))?;
    url.set_password(Some(&details.admin_password))
        .map_err(|_| bad_request("invalid PostgreSQL admin password"))?;
    url.set_path(&format!("/{}", details.admin_database));

    PgPoolOptions::new()
        .min_connections(0)
        .max_connections(1)
        .connect(url.as_str())
        .await
        .map_err(internal)
}

async fn drop_database_and_role(
    host: &ManagedHost,
    database_name: &str,
    username: &str,
) -> RpcResult<()> {
    let pool = host_admin_pool(host).await?;
    let terminate = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()";
    let _ = sqlx::query(terminate)
        .bind(database_name)
        .execute(&pool)
        .await;

    let drop_database = format!(
        "DROP DATABASE IF EXISTS {}",
        quote_identifier(database_name)?
    );
    let drop_role = format!("DROP ROLE IF EXISTS {}", quote_identifier(username)?);

    sqlx::query(&drop_database)
        .execute(&pool)
        .await
        .map_err(internal)?;
    sqlx::query(&drop_role)
        .execute(&pool)
        .await
        .map_err(internal)?;

    Ok(())
}

async fn dump_database(database: &ManagedDatabase, output: &Path) -> RpcResult<()> {
    let output_path = output
        .to_str()
        .ok_or_else(|| internal("backup path is not valid UTF-8"))?;
    let status = tokio::process::Command::new("pg_dump")
        .args([
            "--host",
            &database.host.connection_details.host,
            "--port",
            &database.host.connection_details.port.to_string(),
            "--username",
            &database.username,
            "--dbname",
            &database.name,
            "--no-owner",
            "--no-privileges",
            "--file",
            output_path,
        ])
        .env("PGPASSWORD", &database.password)
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(internal)?;

    if status.status.success() {
        Ok(())
    } else {
        Err(internal(format!(
            "pg_dump failed: {}",
            String::from_utf8_lossy(&status.stderr).trim()
        )))
    }
}

async fn gzip_file(source: &Path, target: &Path) -> RpcResult<()> {
    let source = source.to_owned();
    let target = target.to_owned();

    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut input = BufReader::new(StdFile::open(source)?);
        let output = BufWriter::new(StdFile::create(target)?);
        let mut encoder = GzEncoder::new(output, Compression::best());

        std::io::copy(&mut input, &mut encoder)?;
        encoder.finish()?;

        Ok(())
    })
    .await
    .map_err(internal)?
    .map_err(internal)
}

async fn upload_file(
    storage: &EnabledStorage,
    object_key: &str,
    content_type: &str,
    path: &Path,
) -> RpcResult<()> {
    let signed =
        object_storage::create_upload_url(storage, object_key, content_type, Audience::Internal)?;
    let size = tokio::fs::metadata(path).await.map_err(internal)?.len();
    let file = tokio::fs::File::open(path).await.map_err(internal)?;
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));

    let response = reqwest::Client::new()
        .put(signed.upload_url)
        .header("Content-Type", content_type)
        .header(reqwest::header::CONTENT_LENGTH, size)
        .body(body)
        .send()
        .await
        .map_err(internal)?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(internal(format!(
            "backup upload failed with status {}",
            response.status()
        )))
    }
}

async fn upload_bytes(
    storage: &EnabledStorage,
    object_key: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> RpcResult<()> {
    let signed =
        object_storage::create_upload_url(storage, object_key, content_type, Audience::Internal)?;
    let response = reqwest::Client::new()
        .put(signed.upload_url)
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(internal)?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(internal(format!(
            "backup upload failed with status {}",
            response.status()
        )))
    }
}

async fn download_file(storage: &EnabledStorage, object_key: &str, target: &Path) -> RpcResult<()> {
    let signed =
        object_storage::create_download_url(storage, object_key, None, false, Audience::Internal)?;
    let response = reqwest::Client::new()
        .get(signed.download_url)
        .send()
        .await
        .map_err(internal)?;

    if !response.status().is_success() {
        return Err(internal(format!(
            "backup download failed with status {}",
            response.status()
        )));
    }

    let mut file = tokio::fs::File::create(target).await.map_err(internal)?;
    let mut body = response.bytes_stream();

    while let Some(chunk) = body.next().await {
        file.write_all(&chunk.map_err(internal)?)
            .await
            .map_err(internal)?;
    }

    file.flush().await.map_err(internal)
}

async fn prepare_restore_sql(
    source: &Path,
    target: &Path,
    database: &ManagedDatabase,
) -> RpcResult<()> {
    let source = source.to_owned();
    let target = target.to_owned();
    let username = quote_identifier(&database.username)?;

    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let source_file = StdFile::open(source)?;
        let mut probe = BufReader::new(source_file);
        let prefix = probe.fill_buf()?;
        let gzip = prefix.starts_with(&[0x1f, 0x8b]);

        let input: Box<dyn Read> = if gzip {
            Box::new(GzDecoder::new(probe))
        } else {
            Box::new(probe)
        };
        let mut reader = BufReader::new(input);
        let mut writer = BufWriter::new(StdFile::create(target)?);

        writeln!(writer, "SET client_min_messages TO WARNING;")?;
        writeln!(writer, "DROP SCHEMA public CASCADE;")?;
        writeln!(writer, "CREATE SCHEMA public AUTHORIZATION {username};")?;

        let mut line = String::new();
        while reader.read_line(&mut line)? != 0 {
            if line
                .trim()
                .eq_ignore_ascii_case("SELECT pg_catalog.set_config('search_path', '', false);")
            {
                writeln!(
                    writer,
                    "SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);"
                )?;
            } else {
                writer.write_all(line.as_bytes())?;
            }

            line.clear();
        }

        writer.flush()
    })
    .await
    .map_err(internal)?
    .map_err(internal)
}

async fn restore_database(database: &ManagedDatabase, sql_path: &Path) -> RpcResult<()> {
    let admin_pool = host_admin_pool(&database.host).await?;
    sqlx::query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    )
    .bind(&database.name)
    .execute(&admin_pool)
    .await
    .map_err(internal)?;

    let input = StdFile::open(sql_path).map_err(internal)?;
    let output = tokio::process::Command::new("psql")
        .args([
            "--host",
            &database.host.connection_details.host,
            "--port",
            &database.host.connection_details.port.to_string(),
            "--username",
            &database.username,
            "--dbname",
            &database.name,
            "--set",
            "ON_ERROR_STOP=1",
        ])
        .env("PGPASSWORD", &database.password)
        .stdin(Stdio::from(input))
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(internal)?;

    if output.status.success() {
        Ok(())
    } else {
        Err(internal(format!(
            "psql failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

async fn insert_processing_backup(
    state: &AppState,
    database_id: i64,
    kind: &str,
    object_key: Option<&str>,
) -> RpcResult<i64> {
    sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO __postgres_database_backups (
            database_id,
            kind,
            state,
            object_key
        )
        VALUES ($1, $2, 'processing', $3)
        RETURNING id
        "#,
    )
    .bind(database_id)
    .bind(kind)
    .bind(object_key)
    .fetch_one(state.tenants.master())
    .await
    .map_err(internal)
}

async fn mark_backup_uploaded(
    state: &AppState,
    backup_id: i64,
    object_key: &str,
    size: i64,
) -> RpcResult<()> {
    sqlx::query(
        r#"
        UPDATE __postgres_database_backups
        SET
            state = 'uploaded',
            object_key = $2,
            size_bytes = $3,
            error = NULL,
            completed_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(backup_id)
    .bind(object_key)
    .bind(size)
    .execute(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(())
}

async fn mark_backup_failed(state: &AppState, backup_id: i64, error: String) {
    let _ = sqlx::query(
        r#"
        UPDATE __postgres_database_backups
        SET state = 'failed', error = $2, completed_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(backup_id)
    .bind(error)
    .execute(state.tenants.master())
    .await;
}

async fn apply_retention(
    state: &AppState,
    database: &ManagedDatabase,
    storage: &EnabledStorage,
) -> RpcResult<()> {
    let backups = list_backups(state, database.id.parse::<i64>().map_err(internal)?, true).await?;
    let mut keep = HashSet::new();
    let mut daily = 0;
    let mut weeks = HashSet::new();
    let mut months = HashSet::new();
    let mut years = HashSet::new();

    for backup in backups.iter().filter(|backup| backup.state == "uploaded") {
        let date = backup.created_at;
        let week = format!("{}-{:02}", date.iso_week().year(), date.iso_week().week());
        let month = format!("{}-{:02}", date.year(), date.month());
        let year = date.year();

        if daily < database.retention_daily {
            daily += 1;
            keep.insert(backup.id.clone());
            continue;
        }
        if weeks.len() < database.retention_weekly as usize && weeks.insert(week) {
            keep.insert(backup.id.clone());
        }
        if months.len() < database.retention_monthly as usize && months.insert(month) {
            keep.insert(backup.id.clone());
        }
        if years.len() < database.retention_yearly as usize && years.insert(year) {
            keep.insert(backup.id.clone());
        }
    }

    for backup in backups
        .into_iter()
        .filter(|backup| backup.state == "uploaded" && !keep.contains(&backup.id))
    {
        if let Some(object_key) = backup.object_key.as_deref() {
            let _ = object_storage::delete_object(storage, object_key).await;
        }

        sqlx::query("DELETE FROM __postgres_database_backups WHERE id = $1")
            .bind(backup.id.parse::<i64>().map_err(internal)?)
            .execute(state.tenants.master())
            .await
            .map_err(internal)?;
    }

    Ok(())
}

fn backup_storage(host: &ManagedHost) -> RpcResult<EnabledStorage> {
    let backup = &host.backup_details;
    if !backup.enabled {
        return Err(conflict("backup is not enabled on the selected host"));
    }

    Ok(EnabledStorage {
        bucket: required_backup_value(&backup.bucket, "bucket")?,
        region: required_backup_value(&backup.region, "region")?,
        endpoint: backup.endpoint.clone(),
        force_path_style: backup.force_path_style,
        access_key_id: required_backup_value(&backup.access_key_id, "accessKeyId")?,
        secret_access_key: required_backup_value(&backup.secret_access_key, "secretAccessKey")?,
        session_token: backup.session_token.clone(),
        public_base_url: backup.public_base_url.clone(),
        key_prefix: backup.key_prefix.clone(),
        upload_url_ttl_sec: 15 * 60,
        download_url_ttl_sec: 15 * 60,
    })
}

fn backup_object_key(database: &ManagedDatabase, now: DateTime<Utc>, extension: &str) -> String {
    let prefix = database
        .host
        .backup_details
        .key_prefix
        .as_deref()
        .unwrap_or_default()
        .trim_matches('/');
    let timestamp = now.format("%Y-%m-%dT%H-%M-%S-%3fZ");
    let key = format!(
        "{}/{}/{}{}",
        database.host.name, database.name, timestamp, extension
    );

    if prefix.is_empty() {
        key
    } else {
        format!("{prefix}/{key}")
    }
}

fn backup_extension(file_name: &str) -> &'static str {
    let file_name = file_name.trim().to_ascii_lowercase();

    if file_name.ends_with(".sql") && !file_name.ends_with(".sql.gz") {
        ".sql"
    } else {
        ".sql.gz"
    }
}

fn decode_backup_payload(value: &str) -> RpcResult<Vec<u8>> {
    let value = value.trim();
    let payload = if value.starts_with("data:") {
        value
            .split_once(',')
            .map(|(_, payload)| payload)
            .ok_or_else(|| bad_request("invalid data URL"))?
    } else {
        value
    };
    let bytes = STANDARD
        .decode(payload)
        .map_err(|_| bad_request("invalid backup base64"))?;

    if bytes.is_empty() {
        Err(bad_request("backup payload is empty"))
    } else {
        Ok(bytes)
    }
}

fn required_backup_value(value: &Option<String>, field: &str) -> RpcResult<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| conflict(format!("backup {field} is missing")))
}

fn validate_identifier(value: &str) -> RpcResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 63
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');

    if valid {
        Ok(())
    } else {
        Err(bad_request("invalid PostgreSQL identifier"))
    }
}

fn quote_identifier(value: &str) -> RpcResult<String> {
    validate_identifier(value)?;

    Ok(format!("\"{value}\""))
}

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn super_password() -> RpcResult<String> {
    procedures_password()
}

fn default_postgres_port() -> u16 {
    5432
}

fn default_admin_database() -> String {
    "postgres".to_owned()
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::BadRequest, message).with_http_code(400)
}

fn conflict(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::Conflict, message).with_http_code(409)
}

fn not_found() -> RpcError {
    RpcError::new(ErrorCode::NotFound, "Not found").with_http_code(404)
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InternalServerError, error.to_string()).with_http_code(500)
}

pub fn procedures_password() -> RpcResult<String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(internal)?;

    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub daily: i32,
    pub weekly: i32,
    pub monthly: i32,
    pub yearly: i32,
}

#[derive(Debug)]
pub struct ForkInput {
    pub backup_id: i64,
    pub host_id: Option<i64>,
    pub name: String,
    pub username: Option<String>,
    pub retention_daily: Option<i32>,
    pub retention_weekly: Option<i32>,
    pub retention_monthly: Option<i32>,
    pub retention_yearly: Option<i32>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabase {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RotatedCredentials {
    pub id: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutput {
    pub backup_id: String,
    pub target_database_id: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ForkOutput {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub username: String,
    pub password: String,
    pub restored_from_backup_id: String,
}

#[derive(FromRow)]
struct HostRow {
    id: i64,
    name: String,
    connection_details: Json<Value>,
    backup_details: Json<Value>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl TryFrom<HostRow> for ManagedHost {
    type Error = RpcError;

    fn try_from(row: HostRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id.to_string(),
            name: row.name,
            connection_details: serde_json::from_value(row.connection_details.0)
                .map_err(internal)?,
            backup_details: serde_json::from_value(row.backup_details.0).map_err(internal)?,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

#[derive(FromRow)]
struct DatabaseRow {
    id: i64,
    host_id: i64,
    name: String,
    username: String,
    password: String,
    retention_daily: i32,
    retention_weekly: i32,
    retention_monthly: i32,
    retention_yearly: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    host_name: String,
    host_connection_details: Json<Value>,
    host_backup_details: Json<Value>,
    host_created_at: DateTime<Utc>,
    host_updated_at: DateTime<Utc>,
}

impl TryFrom<DatabaseRow> for ManagedDatabase {
    type Error = RpcError;

    fn try_from(row: DatabaseRow) -> Result<Self, Self::Error> {
        let host = ManagedHost {
            id: row.host_id.to_string(),
            name: row.host_name.clone(),
            connection_details: serde_json::from_value(row.host_connection_details.0)
                .map_err(internal)?,
            backup_details: serde_json::from_value(row.host_backup_details.0).map_err(internal)?,
            created_at: row.host_created_at,
            updated_at: row.host_updated_at,
        };

        Ok(Self {
            id: row.id.to_string(),
            host_id: row.host_id.to_string(),
            host_name: row.host_name,
            name: row.name,
            username: row.username,
            password: row.password,
            retention_daily: row.retention_daily,
            retention_weekly: row.retention_weekly,
            retention_monthly: row.retention_monthly,
            retention_yearly: row.retention_yearly,
            created_at: row.created_at,
            updated_at: row.updated_at,
            host,
        })
    }
}

#[derive(FromRow)]
struct BackupRow {
    id: i64,
    database_id: i64,
    kind: String,
    state: String,
    object_key: Option<String>,
    size_bytes: Option<i64>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
}

impl From<BackupRow> for Backup {
    fn from(row: BackupRow) -> Self {
        Self {
            id: row.id.to_string(),
            database_id: row.database_id.to_string(),
            kind: row.kind,
            state: row.state,
            object_key: row.object_key,
            size_bytes: row.size_bytes,
            error: row.error,
            created_at: row.created_at,
            completed_at: row.completed_at,
        }
    }
}

#[derive(FromRow)]
struct CreatedDatabaseRow {
    id: i64,
    host_id: i64,
    name: String,
    username: String,
    password: String,
}

impl From<CreatedDatabaseRow> for CreatedDatabase {
    fn from(row: CreatedDatabaseRow) -> Self {
        Self {
            id: row.id.to_string(),
            host_id: row.host_id.to_string(),
            name: row.name,
            username: row.username,
            password: row.password,
        }
    }
}

struct TempDirectory {
    path: PathBuf,
}

impl TempDirectory {
    async fn create(prefix: &str) -> RpcResult<Self> {
        let suffix = procedures_password()?;
        let path = std::env::temp_dir().join(format!("{prefix}-{suffix}"));

        tokio::fs::create_dir(&path).await.map_err(internal)?;

        Ok(Self { path })
    }

    async fn remove(self) {
        let _ = tokio::fs::remove_dir_all(self.path).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{backup_extension, decode_backup_payload, validate_identifier};

    #[test]
    fn validates_identifiers_and_uploaded_backup_formats() {
        assert!(validate_identifier("tenant_app").is_ok());
        assert!(validate_identifier("Tenant-App").is_err());

        assert_eq!(backup_extension("snapshot.sql"), ".sql");
        assert_eq!(backup_extension("snapshot.sql.gz"), ".sql.gz");
        assert_eq!(
            decode_backup_payload("data:application/sql;base64,U0VMRUNUIDE7")
                .expect("valid payload"),
            b"SELECT 1;"
        );
    }
}
