//! Project-independent, durable offer and alternative numbering.

use chrono::{Datelike, NaiveDate};
use sqlx::{PgConnection, types::Json};

use super::super::{
    common::{bad_request, internal},
    settings::{OfferNumbering, OfferNumberingScheme},
};
use crate::error::RpcResult;

fn format_number(scheme: OfferNumberingScheme, number: i64, date: NaiveDate) -> String {
    match scheme {
        OfferNumberingScheme::Sequential => number.to_string(),
        OfferNumberingScheme::DateSeparated => format!(
            "{:02}-{:02}-{:02}-{number}",
            date.year().rem_euclid(100),
            date.month(),
            date.day()
        ),
        OfferNumberingScheme::DateCompact => format!(
            "{:02}{:02}{:02}{number}",
            date.year().rem_euclid(100),
            date.month(),
            date.day()
        ),
    }
}

/// Must run in the same transaction that inserts the case. The counter upsert
/// locks the single global row until commit, serializing concurrent allocations.
/// Reservations are permanent, including when their case is subsequently deleted.
pub(super) async fn allocate_number(
    connection: &mut PgConnection,
    date: NaiveDate,
) -> RpcResult<String> {
    let config: Option<Json<OfferNumbering>> = sqlx::query_scalar(
        "SELECT name FROM global_settings WHERE key='organization.offerNumbering'",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(internal)?
    .flatten();
    let config = config.map(|value| value.0).unwrap_or_default();
    let start = config.start_number.parse::<i64>().map_err(internal)?;
    if start < 1 {
        return Err(bad_request("startNumber must be a positive integer"));
    }

    loop {
        // NUMERIC allows storing i64::MAX + 1 after allocating the last valid
        // number. Parsing the following allocation then reports exhaustion.
        let next: String = sqlx::query_scalar(
            "INSERT INTO commercial_offer_counters(scope,next_number) \
             VALUES('global',$1::numeric+1) ON CONFLICT(scope) DO UPDATE \
             SET next_number=GREATEST(commercial_offer_counters.next_number,$1::numeric)+1 \
             RETURNING (next_number-1)::text",
        )
        .bind(start.to_string())
        .fetch_one(&mut *connection)
        .await
        .map_err(internal)?;
        let next = next
            .parse::<i64>()
            .map_err(|_| bad_request("Offer counter is exhausted"))?;
        let number = format_number(config.scheme, next, date);
        let reserved: Option<String> = sqlx::query_scalar(
            "INSERT INTO commercial_offer_number_reservations(number) \
             SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM commercial_cases WHERE reference=$1) \
             ON CONFLICT(number) DO NOTHING RETURNING number",
        )
        .bind(&number)
        .fetch_optional(&mut *connection)
        .await
        .map_err(internal)?;
        if reserved.is_some() {
            return Ok(number);
        }
        // No artificial retry cap: historical references may occupy a longer
        // range, especially after switching from compact dates to sequential.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use serde_json::json;
    use sqlx::{PgPool, postgres::PgPoolOptions};
    use std::{
        collections::HashSet,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::task::JoinSet;

    #[test]
    fn offer_numbering_formats_match_project_independent_invoice_schemes() {
        let date = NaiveDate::from_ymd_opt(2026, 1, 9).unwrap();
        assert_eq!(
            format_number(OfferNumberingScheme::Sequential, 5368, date),
            "5368"
        );
        assert_eq!(
            format_number(OfferNumberingScheme::DateSeparated, 5368, date),
            "26-01-09-5368"
        );
        assert_eq!(
            format_number(OfferNumberingScheme::DateCompact, 5368, date),
            "2601095368"
        );
        assert_eq!(
            format_number(OfferNumberingScheme::Sequential, i64::MAX, date),
            "9223372036854775807"
        );
    }

    async fn configure(pool: &PgPool, scheme: &str, start: &str) {
        sqlx::query("INSERT INTO global_settings(key,name) VALUES('organization.offerNumbering',$1) ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name")
            .bind(Json(json!({"scheme":scheme,"startNumber":start})))
            .execute(pool).await.unwrap();
    }

    async fn allocate_case(pool: &PgPool, date: NaiveDate) -> String {
        let mut tx = pool.begin().await.unwrap();
        let number = allocate_number(&mut tx, date).await.unwrap();
        sqlx::query("INSERT INTO commercial_cases(reference,kind,title) VALUES($1,'offer','Numbering test')")
            .bind(&number).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        number
    }

    /// Optional PostgreSQL integration test, following the network scenarios'
    /// environment-gated convention. Uses and drops its own isolated database.
    /// Run with SORTSYS_TEST_POSTGRES_URL=postgres://.../postgres cargo test --lib offer_numbering -- --nocapture
    #[tokio::test]
    async fn offer_numbering_database_invariants() {
        let Ok(dsn) = std::env::var("SORTSYS_TEST_POSTGRES_URL") else {
            eprintln!("Skipping offer numbering DB test: SORTSYS_TEST_POSTGRES_URL is not set");
            return;
        };
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&dsn)
            .await
            .unwrap();
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("offer_numbering_{}_{suffix}", std::process::id());
        sqlx::query(&format!("CREATE DATABASE \"{name}\""))
            .execute(&admin)
            .await
            .unwrap();
        let mut url = url::Url::parse(&dsn).unwrap();
        url.set_path(&format!("/{name}"));
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect(url.as_str())
            .await
            .unwrap();
        crate::migrations::apply(pool.clone()).await.unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 11, 11).unwrap();

        // Recreate the new tables over legacy cases to exercise upgrade backfill
        // without touching their visible references.
        sqlx::raw_sql("DROP TABLE commercial_offer_number_reservations; DROP TABLE commercial_offer_counters;
            INSERT INTO commercial_cases(reference,kind,title) VALUES
            ('ANG-2026-000123','offer','Historical offer'),('1','offer','Historical numeric offer');")
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/261111160000_commercial_offer_numbering.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        let historical: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM commercial_offer_number_reservations WHERE number IN ('ANG-2026-000123','1')")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(historical, 2);
        sqlx::query("DELETE FROM commercial_cases WHERE reference='1'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(allocate_case(&pool, date).await, "2");

        configure(&pool, "dateSeparated", "1").await;
        assert_eq!(allocate_case(&pool, date).await, "26-11-11-3");
        configure(&pool, "dateCompact", "1").await;
        assert_eq!(allocate_case(&pool, date).await, "2611114");
        // A compact-date number remains reserved even after the case is gone
        // and the sequential scheme eventually reaches the same digit string.
        sqlx::query("DELETE FROM commercial_cases WHERE reference='2611114'")
            .execute(&pool)
            .await
            .unwrap();
        configure(&pool, "sequential", "2611114").await;
        assert_eq!(allocate_case(&pool, date).await, "2611115");
        configure(&pool, "dateCompact", "1").await;
        assert_eq!(allocate_case(&pool, date).await, "2611112611116");
        configure(&pool, "sequential", "1").await;
        assert_eq!(allocate_case(&pool, date).await, "2611117");

        // Concurrent committed allocations must form one gap-free global range.
        let mut jobs = JoinSet::new();
        for _ in 0..32 {
            let pool = pool.clone();
            jobs.spawn(async move { allocate_case(&pool, date).await });
        }
        let mut numbers = HashSet::new();
        while let Some(result) = jobs.join_next().await {
            assert!(numbers.insert(result.unwrap()));
        }
        let expected: HashSet<_> = (2611118..2611150).map(|n| n.to_string()).collect();
        assert_eq!(numbers, expected);

        // Failed creation rolls back both high-water mark and reservation.
        let mut tx = pool.begin().await.unwrap();
        let rolled_back = allocate_number(&mut tx, date).await.unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(allocate_case(&pool, date).await, rolled_back);

        // Current references not present in the historical registry are skipped
        // too, including ranges longer than the invoice allocator's retry cap.
        sqlx::query("INSERT INTO commercial_cases(reference,kind,title) SELECT n::text,'offer','Imported offer' FROM generate_series(2611151,2612251) AS n")
            .execute(&pool).await.unwrap();
        assert_eq!(allocate_case(&pool, date).await, "2612252");
        let invoice_counters: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM commercial_invoice_counters")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(invoice_counters, 0);
        let legacy: String = sqlx::query_scalar(
            "SELECT reference FROM commercial_cases WHERE title='Historical offer'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(legacy, "ANG-2026-000123");

        // Exact numbers above JavaScript's safe integer range and the last i64.
        configure(&pool, "sequential", "9007199254740993").await;
        assert_eq!(allocate_case(&pool, date).await, "9007199254740993");
        configure(&pool, "sequential", &i64::MAX.to_string()).await;
        assert_eq!(allocate_case(&pool, date).await, i64::MAX.to_string());
        let mut tx = pool.begin().await.unwrap();
        let exhausted = allocate_number(&mut tx, date).await.unwrap_err();
        assert_eq!(exhausted.code, ErrorCode::BadRequest);
        assert_eq!(exhausted.message, "Offer counter is exhausted");
        tx.rollback().await.unwrap();

        pool.close().await;
        sqlx::query(&format!("DROP DATABASE \"{name}\""))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
    }
}
