//! Ordered, transactional execution of the embedded tenant schema migrations.

use std::{collections::HashSet, future::Future, pin::Pin};

use sqlx::{Executor, PgPool};

use crate::migrations_generated::MIGRATIONS;

pub fn apply(
    pool: PgPool,
) -> Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'static>> {
    Box::pin(async move { apply_inner(pool).await })
}

async fn apply_inner(pool: PgPool) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS __migrations (\
         name TEXT PRIMARY KEY, \
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    )
    .execute(&mut *transaction)
    .await?;
    let applied: HashSet<String> = sqlx::query_scalar("SELECT name FROM __migrations")
        .fetch_all(&mut *transaction)
        .await?
        .into_iter()
        .collect();

    for &(name, sql) in MIGRATIONS {
        if applied.contains(name) {
            continue;
        }
        (&mut *transaction).execute(sqlx::raw_sql(sql)).await?;
        sqlx::query("INSERT INTO __migrations (name) VALUES ($1)")
            .bind(name)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await
}

#[cfg(test)]
mod tests {
    use super::MIGRATIONS;

    #[test]
    fn migration_names_are_ordered_and_unique() {
        let mut previous = "";
        for (name, sql) in MIGRATIONS {
            assert!(*name > previous);
            assert!(!sql.trim().is_empty());
            previous = name;
        }
        assert_eq!(MIGRATIONS.len(), 43);
    }
}
