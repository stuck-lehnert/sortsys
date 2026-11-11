//! Derive the browser's logical row model from a fresh, migrated test database.
//! The supplied DSN is only used to create and drop an isolated temporary DB.
use std::{env, fs, path::PathBuf};

use sqlx::PgPool;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dsn = env::var("BROWSER_SCHEMA_PG_DSN")?;
    let path = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("rust-api/schema/business.generated.json"));
    let admin = PgPool::connect(&dsn).await?;
    let mut random = [0u8; 8];
    getrandom::fill(&mut random)?;
    let name = format!("sortsys_schema_{:016x}", u64::from_be_bytes(random));
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await?;
    let result = generate(&dsn, &name).await;
    let cleanup = sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await;
    let schema = result?;
    cleanup?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&schema)?),
    )?;
    println!("generated {}", path.display());
    Ok(())
}

async fn generate(dsn: &str, name: &str) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut url = url::Url::parse(dsn)?;
    url.set_path(&format!("/{name}"));
    let pool = PgPool::connect(url.as_str()).await?;
    let result = async {
        sortsys_api::migrations::apply(pool.clone()).await?;
        sortsys_api::browser_schema::describe(&pool).await
    }
    .await;
    pool.close().await;
    Ok(result?)
}
