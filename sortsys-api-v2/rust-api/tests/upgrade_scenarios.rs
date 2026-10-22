//! Cross-version checks for an instance populated by the exact deploy revision.
//!
//! The upgrade harness explicitly runs the three ignored phases in order. The
//! capture phase uses direct SQL only: candidate bootstrap must not run first.

use std::{collections::BTreeMap, env, fs, time::Duration};

use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use url::Url;

use sortsys_api::{AppState, config::Config, ids::Id};

#[path = "../src/migrations_generated.rs"]
mod embedded_migrations;

type DatabaseSnapshot = BTreeMap<String, Vec<Value>>;

const MASTER_TABLES: &[&str] = &[
    "__tenants",
    "__postgres_hosts",
    "__postgres_databases",
    "__postgres_database_backups",
];

#[derive(Debug, Deserialize, Serialize)]
struct DeployFixture {
    master: DatabaseSnapshot,
    tenant: DatabaseSnapshot,
}

#[tokio::test]
#[ignore = "run by scripts/test-deploy-upgrade before candidate bootstrap"]
async fn capture_deploy_fixture() {
    let (master, tenant) = direct_pools().await;
    let fixture = snapshot(&master, &tenant).await;
    require_populated_fixture(&fixture.tenant).unwrap();

    let manifest = required_env("TEST_UPGRADE_MANIFEST");
    fs::write(manifest, serde_json::to_vec(&fixture).unwrap()).unwrap();

    tenant.close().await;
    master.close().await;
}

#[tokio::test]
#[ignore = "run by scripts/test-deploy-upgrade before candidate server startup"]
async fn migrate_deploy_fixture() {
    let fixture = read_fixture();
    let tenant_name = required_env("DEV_TEST_TENANT_NAME");
    let state = AppState::connect(Config::from_env().unwrap())
        .await
        .unwrap();
    let tenant = state.tenants.tenant_pool(&tenant_name).await.unwrap();

    let migrated = snapshot(state.tenants.master(), &tenant).await;
    assert_preserved(&fixture.master, &migrated.master).unwrap();
    assert_preserved(&fixture.tenant, &migrated.tenant).unwrap();

    let applied: Vec<String> = sqlx::query_scalar("SELECT name FROM __migrations ORDER BY name")
        .fetch_all(&tenant)
        .await
        .unwrap();

    for (name, _) in embedded_migrations::MIGRATIONS {
        assert!(
            applied.iter().any(|applied| applied == name),
            "missing {name}"
        );
    }

    state.tenants.close().await;

    // Reconnect through the production bootstrap and lazy tenant migration path.
    // Reapplying either schema must not change the already-upgraded data.
    let restarted = AppState::connect(Config::from_env().unwrap())
        .await
        .unwrap();
    let tenant = restarted.tenants.tenant_pool(&tenant_name).await.unwrap();
    let reapplied = snapshot(restarted.tenants.master(), &tenant).await;
    assert!(
        migrated.master == reapplied.master,
        "master bootstrap is not idempotent"
    );
    assert!(
        migrated.tenant == reapplied.tenant,
        "tenant migrations are not idempotent"
    );

    restarted.tenants.close().await;
}

#[tokio::test]
#[ignore = "run by scripts/test-deploy-upgrade against the upgraded running API"]
async fn exercise_upgraded_deploy_fixture() {
    let fixture = read_fixture();
    let rpc = UpgradeRpc::new();
    let tenant_name = required_env("DEV_TEST_TENANT_NAME");
    let login = rpc
        .call(
            "auth.login",
            Method::POST,
            json!({
                "tenant": tenant_name,
                "username": "john.doe",
                "password": "123456",
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap();
    let session = rpc
        .call("auth.sessionInfo", Method::GET, Value::Null, Some(token))
        .await;
    assert!(
        session["roles"]
            .as_array()
            .unwrap()
            .contains(&json!(":admin"))
    );

    // These reads must expose the original deploy records, not fresh fixtures.
    for (table, path) in [
        ("projects", "projects.list"),
        ("customers", "customers.list"),
        ("products", "products.list"),
        ("product_delivery_notes", "deliveryNotes.list"),
        ("daily_project_reports", "projects.dailyReports.list"),
        ("regie_reports", "regieReports.list"),
    ] {
        let input = if matches!(table, "daily_project_reports" | "regie_reports") {
            json!({ "limit": 10_000 })
        } else {
            json!({})
        };

        let result = rpc.call(path, Method::GET, input, Some(token)).await;
        let records = result.as_array().unwrap();

        for original in &fixture.tenant[table] {
            let id = Id(original["id"].as_i64().unwrap()).encode();
            assert!(
                records.iter().any(|record| record["id"] == id),
                "{path}: missing {id}"
            );
        }
    }

    let frank_login = rpc
        .call(
            "auth.login",
            Method::POST,
            json!({
                "tenant": tenant_name,
                "username": "frank.doe",
                "password": "123456",
            }),
            None,
        )
        .await;
    let frank_session = rpc
        .call(
            "auth.sessionInfo",
            Method::GET,
            Value::Null,
            frank_login["token"].as_str(),
        )
        .await;
    assert!(frank_session["roles"].as_array().unwrap().is_empty());

    // Update an old project, then create, read and delete a new related project.
    // This also checks sequences, foreign keys and audit triggers after upgrade.
    let original = &fixture.tenant["projects"][0];
    let original_id = Id(original["id"].as_i64().unwrap()).encode();
    rpc.call(
        "projects.update",
        Method::POST,
        json!({ "id": original_id, "data": { "title": "Upgrade write check" } }),
        Some(token),
    )
    .await;
    let updated = rpc
        .call(
            "projects.get",
            Method::GET,
            json!({ "id": original_id }),
            Some(token),
        )
        .await;
    assert_eq!(updated["title"], "Upgrade write check");

    rpc.call(
        "projects.update",
        Method::POST,
        json!({ "id": original_id, "data": { "title": original["title"] } }),
        Some(token),
    )
    .await;

    let customer_id = Id(fixture.tenant["customers"][0]["id"].as_i64().unwrap()).encode();
    let created = rpc
        .call(
            "projects.create",
            Method::POST,
            json!({ "title": "Post-upgrade project", "customerId": customer_id }),
            Some(token),
        )
        .await;
    let created_id = created["id"].as_str().unwrap();
    let project = rpc
        .call(
            "projects.get",
            Method::GET,
            json!({ "id": created_id }),
            Some(token),
        )
        .await;
    assert_eq!(project["customerId"], customer_id);

    rpc.call(
        "projects.delete",
        Method::POST,
        json!({ "id": created_id }),
        Some(token),
    )
    .await;

    let (master, tenant) = direct_pools().await;
    let changes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM entity_changes WHERE entity_table = 'projects' AND entity_id = $1",
    )
    .bind(Id::decode(created_id).unwrap().0.to_string())
    .fetch_one(&tenant)
    .await
    .unwrap();
    assert!(
        changes >= 2,
        "new writes must retain creation and deletion history"
    );

    tenant.close().await;
    master.close().await;
}

fn required_env(name: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("upgrade check requires {name}"))
}

fn read_fixture() -> DeployFixture {
    let bytes = fs::read(required_env("TEST_UPGRADE_MANIFEST")).unwrap();
    let fixture: DeployFixture = serde_json::from_slice(&bytes).unwrap();
    require_populated_fixture(&fixture.tenant).unwrap();

    fixture
}

async fn direct_pools() -> (PgPool, PgPool) {
    let dsn = required_env("PG_MASTER_DSN");
    let master = PgPool::connect(&dsn).await.unwrap();
    let mut tenant_url = Url::parse(&dsn).unwrap();
    tenant_url.set_path(&format!("/{}", required_env("DEV_TEST_DATABASE_NAME")));
    let tenant = PgPool::connect(tenant_url.as_str()).await.unwrap();

    (master, tenant)
}

async fn snapshot(master: &PgPool, tenant: &PgPool) -> DeployFixture {
    let mut master_snapshot = BTreeMap::new();

    for table in MASTER_TABLES {
        master_snapshot.insert((*table).to_owned(), table_rows(master, table).await);
    }

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
    .fetch_all(tenant)
    .await
    .unwrap();
    let mut tenant_snapshot = BTreeMap::new();

    for table in tables {
        tenant_snapshot.insert(table.clone(), table_rows(tenant, &table).await);
    }

    DeployFixture {
        master: master_snapshot,
        tenant: tenant_snapshot,
    }
}

async fn table_rows(pool: &PgPool, table: &str) -> Vec<Value> {
    // Search vectors are derived, whereas all persisted business fields and
    // relation rows participate in preservation checks, including composite keys.
    let quoted = table.replace('"', "\"\"");
    let sql = format!("SELECT to_jsonb(record) - '_search' FROM public.\"{quoted}\" AS record");
    let mut rows: Vec<Value> = sqlx::query_scalar(&sql).fetch_all(pool).await.unwrap();
    rows.sort_by_cached_key(Value::to_string);

    rows
}

fn require_populated_fixture(snapshot: &DatabaseSnapshot) -> Result<(), String> {
    for (table, minimum) in [
        ("users", 50),
        ("projects", 50),
        ("products", 50),
        ("tools", 50),
        ("customers", 1),
        ("contacts", 1),
        ("project_contacts", 1),
        ("daily_project_reports", 1),
        ("daily_project_report_work_hours", 1),
        ("regie_reports", 1),
        ("regie_report_products", 1),
        ("regie_report_work_hours", 1),
        ("product_delivery_notes", 1),
        ("product_delivery_records", 1),
        ("project_deployments", 1),
        ("user_vacations", 1),
        ("project_financial_entries", 1),
        ("entity_changes", 1),
        ("__migrations", 1),
    ] {
        if snapshot.get(table).map_or(0, Vec::len) < minimum {
            return Err(format!(
                "deploy fixture needs at least {minimum} rows in {table}"
            ));
        }
    }

    Ok(())
}

fn assert_preserved(before: &DatabaseSnapshot, after: &DatabaseSnapshot) -> Result<(), String> {
    for (table, originals) in before {
        let current = after
            .get(table)
            .ok_or_else(|| format!("missing table {table}"))?;
        let Some(first) = originals.first() else {
            continue;
        };

        let fields: Vec<&String> = first.as_object().unwrap().keys().collect();
        let mut remaining = BTreeMap::<String, usize>::new();

        for row in current {
            let projected: Map<String, Value> = fields
                .iter()
                .filter_map(|field| {
                    row.get(*field)
                        .map(|value| ((*field).clone(), value.clone()))
                })
                .collect();
            *remaining
                .entry(Value::Object(projected).to_string())
                .or_default() += 1;
        }

        for (index, original) in originals.iter().enumerate() {
            let count = remaining.entry(original.to_string()).or_default();

            if *count == 0 {
                // Do not print complete rows: even synthetic fixtures contain
                // password hashes and database/storage credentials.
                return Err(format!(
                    "{table}: original row {index} changed or disappeared"
                ));
            }

            *count -= 1;
        }
    }

    Ok(())
}

struct UpgradeRpc {
    http: Client,
    base_url: String,
}

impl UpgradeRpc {
    fn new() -> Self {
        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            base_url: required_env("TEST_API_BASE_URL"),
        }
    }

    async fn call(&self, path: &str, method: Method, input: Value, token: Option<&str>) -> Value {
        let envelope = json!({ "0": { "json": input } });
        let mut request = self
            .http
            .request(method.clone(), format!("{}/{path}", self.base_url));

        request = if method == Method::GET {
            request.query(&[("batch", "1"), ("input", &envelope.to_string())])
        } else {
            request.query(&[("batch", "1")]).json(&envelope)
        };

        if let Some(token) = token {
            request = request.bearer_auth(token);
        }

        let response: Value = request
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            response[0].get("error").is_none(),
            "{path}: {}",
            response[0]
        );

        response[0]["result"]["data"]["json"].clone()
    }
}

#[test]
fn preservation_allows_new_columns_tables_and_rows() {
    let before = BTreeMap::from([(
        "projects".to_owned(),
        vec![json!({ "id": 1, "title": "A" })],
    )]);
    let after = BTreeMap::from([
        (
            "projects".to_owned(),
            vec![
                json!({ "id": 1, "title": "A", "newColumn": null }),
                json!({ "id": 2, "title": "B", "newColumn": null }),
            ],
        ),
        ("newTable".to_owned(), vec![]),
    ]);
    assert_preserved(&before, &after).unwrap();
}

#[test]
fn preservation_rejects_data_loss_changes_missing_columns_and_missing_tables() {
    let original = json!({ "id": 1, "title": "Original", "nullable": null });
    let before = BTreeMap::from([("projects".to_owned(), vec![original])]);

    for rows in [
        vec![],
        vec![json!({ "id": 1, "title": "Changed", "nullable": null })],
        vec![json!({ "id": 1, "title": "Original" })],
    ] {
        let after = BTreeMap::from([("projects".to_owned(), rows)]);
        assert!(assert_preserved(&before, &after).is_err());
    }

    assert!(assert_preserved(&before, &BTreeMap::new()).is_err());
}

#[test]
fn preservation_tracks_duplicate_relation_rows() {
    let relation = json!({ "project_id": 1, "contact_id": 2 });
    let before = BTreeMap::from([(
        "relations".to_owned(),
        vec![relation.clone(), relation.clone()],
    )]);
    let after = BTreeMap::from([("relations".to_owned(), vec![relation])]);
    assert!(assert_preserved(&before, &after).is_err());
}

#[test]
fn empty_databases_cannot_satisfy_the_upgrade_check() {
    assert!(require_populated_fixture(&BTreeMap::new()).is_err());
}
