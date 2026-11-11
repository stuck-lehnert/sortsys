//! Build-time description of business rows; never exposed as a business RPC.
use serde_json::Value;
use sha2_10::{Digest, Sha256};
use sqlx::PgPool;

pub fn fingerprint() -> String {
    let mut hash = Sha256::new();
    hash.update(b"sortsys/browser-schema/v2\0");
    hash.update(include_bytes!("../schema/browser_catalog.sql"));
    hash.update([0]);
    for (name, sql) in crate::migrations_generated::MIGRATIONS {
        if name
            .split_once('_')
            .is_some_and(|(_, suffix)| suffix == "zerotrust" || suffix.starts_with("zerotrust_"))
        {
            continue;
        }
        hash.update(name.as_bytes());
        hash.update(b".sql");
        hash.update([0]);
        hash.update(sql.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

pub async fn describe(pool: &PgPool) -> Result<Value, sqlx::Error> {
    let mut schema = sqlx::query_scalar::<_, Value>(include_str!("../schema/browser_catalog.sql"))
        .fetch_one(pool)
        .await?;
    schema["format"] = Value::String("sortsys-browser-schema-v2".into());
    schema["fingerprint"] = Value::String(fingerprint());
    Ok(schema)
}

#[cfg(test)]
mod tests {
    #[test]
    fn compiled_business_rows_keep_the_same_fingerprint_when_crypto_metadata_grows() {
        let catalogue: serde_json::Value =
            serde_json::from_str(include_str!("../schema/business.generated.json")).unwrap();
        assert_eq!(catalogue["fingerprint"], super::fingerprint());
    }
}
