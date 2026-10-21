//! Replica-safe execution of due automatic database backups.

use std::{future::Future, sync::Arc, time::Duration};

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use chrono_tz::Europe::Berlin;
use sqlx::FromRow;
use tokio::sync::watch;

use crate::{
    AppState,
    error::{RpcError, RpcResult},
    managed_db::{self, Backup},
};

const CHECK_INTERVAL: Duration = Duration::from_secs(60);
const RETRY_DELAY: chrono::Duration = chrono::Duration::minutes(15);
const EXECUTION_LIMIT: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct BackupSweep {
    pub uploaded: usize,
    pub failed: usize,
    pub skipped: usize,
}

#[derive(Debug, Default, FromRow)]
struct BackupHistory {
    last_success: Option<DateTime<Utc>>,
    last_attempt: Option<DateTime<Utc>>,
}

/// Latest daily 02:00 Europe/Berlin occurrence, including DST gap recovery.
pub fn daily_backup_cutoff(now: DateTime<Utc>) -> DateTime<Utc> {
    let today = now.with_timezone(&Berlin).date_naive();
    let scheduled = daily_backup_time(today);

    if now >= scheduled {
        return scheduled;
    }

    daily_backup_time(today.pred_opt().expect("backup date has a previous day"))
}

fn daily_backup_time(day: NaiveDate) -> DateTime<Utc> {
    let mut local = day
        .and_hms_opt(2, 0, 0)
        .expect("02:00 is a valid clock time");

    loop {
        // The first occurrence also covers the repeated hour in autumn.
        if let Some(scheduled) = Berlin.from_local_datetime(&local).earliest() {
            return scheduled.with_timezone(&Utc);
        }

        // Walk forward through a missing hour so spring still gets a backup.
        local += chrono::Duration::minutes(1);
    }
}

pub async fn run(state: Arc<AppState>, mut stop: watch::Receiver<bool>) {
    tracing::info!(
        time_zone = "Europe/Berlin",
        local_time = "02:00",
        "automatic database backup scheduler started"
    );

    loop {
        if *stop.borrow() {
            break;
        }

        let now = Utc::now();
        let required_since = daily_backup_cutoff(now);
        let result = run_sweep(&state, now, required_since, || *stop.borrow()).await;

        if let Err(error) = result {
            tracing::warn!(
                error_code = ?error.code,
                "automatic database backup sweep failed"
            );
        }

        tokio::select! {
            biased;
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            () = tokio::time::sleep(CHECK_INTERVAL) => {}
        }
    }
}

pub async fn run_due_backups(
    state: &AppState,
    now: DateTime<Utc>,
    required_since: DateTime<Utc>,
) -> RpcResult<BackupSweep> {
    run_sweep(state, now, required_since, || false).await
}

async fn run_sweep<Stop>(
    state: &AppState,
    now: DateTime<Utc>,
    required_since: DateTime<Utc>,
    should_stop: Stop,
) -> RpcResult<BackupSweep>
where
    Stop: Fn() -> bool,
{
    if required_since > now {
        return Err(internal(
            "automatic backup cutoff must not be in the future",
        ));
    }

    let database_ids = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT database.id
        FROM __postgres_databases AS database
        INNER JOIN __postgres_hosts AS host ON host.id = database.host_id
        WHERE host.backup_details->'enabled' = 'true'::jsonb
          AND (
            database.retention_daily > 0 OR database.retention_weekly > 0
            OR database.retention_monthly > 0 OR database.retention_yearly > 0
          )
        ORDER BY database.id
        "#,
    )
    .fetch_all(state.tenants.master())
    .await
    .map_err(internal)?;

    Ok(run_candidates(
        database_ids,
        |database_id| backup_database_if_due(state, database_id, now, required_since),
        should_stop,
    )
    .await)
}

pub async fn backup_database_if_due(
    state: &AppState,
    database_id: i64,
    now: DateTime<Utc>,
    required_since: DateTime<Utc>,
) -> RpcResult<Option<Backup>> {
    let Some(connection) = managed_db::acquire_backup_lock(state, database_id).await? else {
        return Ok(None);
    };

    // Recheck after taking the lock: another API replica may have just finished.
    let result = async {
        let database = managed_db::database(state, database_id).await?;
        let has_retention = database.retention_daily > 0
            || database.retention_weekly > 0
            || database.retention_monthly > 0
            || database.retention_yearly > 0;
        let history = sqlx::query_as::<_, BackupHistory>(
            r#"
            SELECT
                GREATEST(
                    (SELECT last_automatic_backup_at FROM __postgres_databases WHERE id = $1),
                    MAX(created_at) FILTER (WHERE state = 'uploaded')
                ) AS last_success,
                MAX(created_at) AS last_attempt
            FROM __postgres_database_backups
            WHERE database_id = $1 AND kind = 'auto'
            "#,
        )
        .bind(database_id)
        .fetch_one(state.tenants.master())
        .await
        .map_err(internal)?;

        if !backup_is_due(
            database.host.backup_details.enabled,
            has_retention,
            &history,
            now,
            required_since,
        ) {
            return Ok(None);
        }

        // A live backup owns the same advisory lock. Old processing rows here
        // therefore belong to interrupted attempts, not another running replica.
        sqlx::query(
            r#"
            UPDATE __postgres_database_backups
            SET state = 'failed',
                error = 'Automatic backup was interrupted before completion',
                completed_at = NOW()
            WHERE database_id = $1 AND kind = 'auto' AND state = 'processing'
              AND created_at <= $2
            "#,
        )
        .bind(database_id)
        .bind(now - RETRY_DELAY)
        .execute(state.tenants.master())
        .await
        .map_err(internal)?;

        managed_db::create_backup_locked(state, database_id, "auto", Some(EXECUTION_LIMIT))
            .await
            .map(Some)
    }
    .await;

    managed_db::release_backup_lock(connection, database_id).await;

    result
}

fn backup_is_due(
    enabled: bool,
    has_retention: bool,
    history: &BackupHistory,
    now: DateTime<Utc>,
    required_since: DateTime<Utc>,
) -> bool {
    if !enabled || !has_retention {
        return false;
    }

    if history.last_success.is_some_and(|at| at >= required_since) {
        return false;
    }

    if history
        .last_attempt
        .is_some_and(|at| at > now - RETRY_DELAY)
    {
        return false;
    }

    true
}

async fn run_candidates<F, Operation, Stop>(
    database_ids: Vec<i64>,
    mut create: F,
    should_stop: Stop,
) -> BackupSweep
where
    F: FnMut(i64) -> Operation,
    Operation: Future<Output = RpcResult<Option<Backup>>>,
    Stop: Fn() -> bool,
{
    let mut sweep = BackupSweep::default();

    // Keep database dumps sequential to avoid a burst of load after downtime.
    for database_id in database_ids {
        if should_stop() {
            break;
        }

        match create(database_id).await {
            Ok(Some(backup)) => {
                sweep.uploaded += 1;
                tracing::info!(database_id, backup_id = %backup.id, "automatic backup uploaded");
            }
            Ok(None) => {
                sweep.skipped += 1;
            }
            Err(error) => {
                sweep.failed += 1;
                // Provider URLs can contain signatures; do not log raw errors.
                tracing::warn!(
                    database_id,
                    error_code = ?error.code,
                    "automatic database backup failed; inspect its backup record"
                );
            }
        }
    }

    sweep
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(
        crate::error::ErrorCode::InternalServerError,
        error.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use chrono::{DateTime, TimeZone, Utc};

    use super::{
        BackupHistory, BackupSweep, RETRY_DELAY, backup_is_due, daily_backup_cutoff, internal,
        run_candidates,
    };
    use crate::managed_db::Backup;

    #[test]
    fn daily_schedule_uses_berlin_clock_time_in_winter_and_summer() {
        let winter = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).unwrap();
        let summer = Utc.with_ymd_and_hms(2026, 7, 15, 12, 0, 0).unwrap();

        assert_eq!(
            daily_backup_cutoff(winter),
            winter.date_naive().and_hms_opt(1, 0, 0).unwrap().and_utc()
        );
        assert_eq!(
            daily_backup_cutoff(summer),
            summer.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc()
        );
    }

    #[test]
    fn spring_gap_runs_once_at_three_instead_of_missing_the_day() {
        let start = Utc.with_ymd_and_hms(2026, 3, 28, 23, 0, 0).unwrap();
        let previous = Utc.with_ymd_and_hms(2026, 3, 28, 1, 0, 0).unwrap();
        let expected = vec![
            Utc.with_ymd_and_hms(2026, 3, 29, 1, 0, 0).unwrap(),
            Utc.with_ymd_and_hms(2026, 3, 30, 0, 0, 0).unwrap(),
        ];

        assert_eq!(simulate_daily_checks(start, previous, 28 * 60), expected);
    }

    #[test]
    fn autumn_repeated_hour_runs_once_at_the_first_two_oclock() {
        let start = Utc.with_ymd_and_hms(2026, 10, 24, 22, 0, 0).unwrap();
        let previous = Utc.with_ymd_and_hms(2026, 10, 24, 0, 0, 0).unwrap();
        let expected = vec![
            Utc.with_ymd_and_hms(2026, 10, 25, 0, 0, 0).unwrap(),
            Utc.with_ymd_and_hms(2026, 10, 26, 1, 0, 0).unwrap(),
        ];

        assert_eq!(simulate_daily_checks(start, previous, 29 * 60), expected);
    }

    #[test]
    fn restart_in_the_repeated_hour_reuses_durable_history_or_catches_up_once() {
        let second_two = Utc.with_ymd_and_hms(2026, 10, 25, 1, 5, 0).unwrap();
        let first_run = Utc.with_ymd_and_hms(2026, 10, 25, 0, 2, 0).unwrap();
        let required_since = daily_backup_cutoff(second_two);
        let history = BackupHistory {
            last_success: Some(first_run),
            last_attempt: Some(first_run),
        };

        assert!(!backup_is_due(
            true,
            true,
            &history,
            second_two,
            required_since
        ));
        assert!(backup_is_due(
            true,
            true,
            &BackupHistory::default(),
            second_two,
            required_since,
        ));

        let caught_up = BackupHistory {
            last_success: Some(second_two),
            last_attempt: Some(second_two),
        };
        let later = second_two + chrono::Duration::minutes(20);

        assert!(!backup_is_due(
            true,
            true,
            &caught_up,
            later,
            daily_backup_cutoff(later)
        ));
    }

    #[tokio::test]
    async fn shutdown_finishes_the_current_candidate_and_starts_no_more() {
        let attempts = Cell::new(0);
        let result = run_candidates(
            vec![1, 2, 3],
            |_| {
                attempts.set(attempts.get() + 1);

                std::future::ready(Ok(None))
            },
            || attempts.get() > 0,
        )
        .await;

        assert_eq!(attempts.get(), 1);
        assert_eq!(
            result,
            BackupSweep {
                uploaded: 0,
                failed: 0,
                skipped: 1
            }
        );
    }

    fn simulate_daily_checks(
        start: DateTime<Utc>,
        previous_success: DateTime<Utc>,
        minutes: i64,
    ) -> Vec<DateTime<Utc>> {
        let mut history = BackupHistory {
            last_success: Some(previous_success),
            last_attempt: Some(previous_success),
        };
        let mut runs = Vec::new();

        for minute in 0..minutes {
            let now = start + chrono::Duration::minutes(minute);

            if backup_is_due(true, true, &history, now, daily_backup_cutoff(now)) {
                runs.push(now);
                history.last_success = Some(now);
                history.last_attempt = Some(now);
            }
        }

        runs
    }

    #[test]
    fn requires_host_opt_in_and_a_nonempty_retention_policy() {
        let now = Utc.with_ymd_and_hms(2026, 10, 21, 12, 0, 0).unwrap();
        let required_since = now - chrono::Duration::days(1);
        let history = BackupHistory::default();

        assert!(backup_is_due(true, true, &history, now, required_since));
        assert!(!backup_is_due(false, true, &history, now, required_since));
        assert!(!backup_is_due(true, false, &history, now, required_since));
    }

    #[test]
    fn successful_history_suppresses_duplicates_until_the_next_due_boundary() {
        let now = Utc.with_ymd_and_hms(2026, 10, 21, 12, 0, 0).unwrap();
        let required_since = now - chrono::Duration::days(1);
        let mut history = BackupHistory {
            last_success: Some(required_since),
            last_attempt: Some(required_since),
        };

        assert!(!backup_is_due(true, true, &history, now, required_since));

        history.last_success = Some(required_since - chrono::Duration::seconds(1));

        assert!(backup_is_due(true, true, &history, now, required_since));
    }

    #[test]
    fn failed_and_interrupted_attempts_are_retried_after_a_durable_cooldown() {
        let now = Utc.with_ymd_and_hms(2026, 10, 21, 12, 0, 0).unwrap();
        let required_since = now - chrono::Duration::days(1);
        let mut history = BackupHistory {
            last_success: None,
            last_attempt: Some(now - RETRY_DELAY + chrono::Duration::seconds(1)),
        };

        assert!(!backup_is_due(true, true, &history, now, required_since));

        history.last_attempt = Some(now - RETRY_DELAY);

        assert!(backup_is_due(true, true, &history, now, required_since));
    }

    #[tokio::test]
    async fn one_failed_database_does_not_stop_later_backups() {
        let attempts = RefCell::new(Vec::new());
        let now = Utc.with_ymd_and_hms(2026, 10, 21, 12, 0, 0).unwrap();
        let result = run_candidates(
            vec![1, 2, 3],
            |database_id| {
                attempts.borrow_mut().push(database_id);

                async move {
                    match database_id {
                        1 => Err(internal("synthetic upload failure")),
                        2 => Ok(Some(Backup {
                            id: "backup".to_owned(),
                            database_id: "2".to_owned(),
                            kind: "auto".to_owned(),
                            state: "uploaded".to_owned(),
                            object_key: Some("test.sql.gz".to_owned()),
                            size_bytes: Some(42),
                            error: None,
                            created_at: now,
                            completed_at: Some(now),
                        })),
                        _ => Ok(None),
                    }
                }
            },
            || false,
        )
        .await;

        assert_eq!(attempts.into_inner(), vec![1, 2, 3]);
        assert_eq!(
            result,
            BackupSweep {
                uploaded: 1,
                failed: 1,
                skipped: 1
            }
        );
    }
}
