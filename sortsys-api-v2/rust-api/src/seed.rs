//! Shared randomized data seeding for development and integration tests.
//!
//! A numeric seed makes failures reproducible while retaining the varied,
//! relational datasets that the TypeScript test harness used to create.

use std::{collections::HashSet, env, error::Error};

use bcrypt::hash;
use chrono::{Datelike, Duration, Utc};
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::{AppState, managed_db};

pub type SeedResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedSummary {
    pub users: usize,
    pub projects: usize,
    pub tools: usize,
    pub products: usize,
    pub vendors: usize,
    pub customers: usize,
    pub contacts: usize,
    pub delivery_notes: usize,
    pub daily_reports: usize,
    pub regie_reports: usize,
    pub deployments: usize,
    pub vacations: usize,
    pub unavailability_periods: usize,
    pub financial_entries: usize,
    pub remarks: usize,
}

/// Creates and seeds the managed `test` tenant expected by `scripts/dev`.
pub async fn bootstrap_development(state: &AppState) -> SeedResult<SeedSummary> {
    let tenant_name = optional_env("DEV_TEST_TENANT_NAME", "test");
    let database_name = optional_env("DEV_TEST_DATABASE_NAME", "live_sortsys_api_test");
    let database_user = optional_env("DEV_TEST_DATABASE_USER", "live_sortsys_api_test_app");
    let host_name = optional_env("DEV_LIVE_POSTGRES_HOST_NAME", "dev-local-postgres");

    let postgres_host = required_env("TEST_PG_HOST")?;
    let postgres_port = optional_env("TEST_PG_PORT", "5432").parse::<u16>()?;
    let postgres_user = optional_env("TEST_PG_USER", "postgres");
    let postgres_password = optional_env("TEST_PG_PASSWORD", "dev-postgres");

    let storage_endpoint = required_env("TEST_S3_ENDPOINT")?;
    let storage_public_url = required_env("TEST_S3_PUBLIC_BASE_URL")?;
    let storage_region = optional_env("TEST_S3_REGION", "us-east-1");
    let storage_bucket = required_env("TEST_S3_BUCKET")?;
    let storage_access_key = required_env("TEST_S3_ACCESS_KEY_ID")?;
    let storage_secret_key = required_env("TEST_S3_SECRET_ACCESS_KEY")?;

    let connection_details = json!({
        "host": postgres_host,
        "port": postgres_port,
        "adminDatabase": "postgres",
        "adminUsername": postgres_user,
        "adminPassword": postgres_password,
    });
    let backup_details = json!({
        "enabled": true,
        "bucket": storage_bucket,
        "region": storage_region,
        "endpoint": storage_endpoint,
        "publicBaseUrl": storage_public_url,
        "forcePathStyle": true,
        "accessKeyId": storage_access_key,
        "secretAccessKey": storage_secret_key,
        "keyPrefix": format!("managed/{tenant_name}"),
    });

    let host_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO __postgres_hosts (name, connection_details, backup_details)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE SET
            connection_details = EXCLUDED.connection_details,
            backup_details = EXCLUDED.backup_details,
            updated_at = NOW()
        RETURNING id
        "#,
    )
    .bind(&host_name)
    .bind(&connection_details)
    .bind(&backup_details)
    .fetch_one(state.tenants.master())
    .await?;

    let existing_database = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM __postgres_databases WHERE host_id = $1 AND name = $2",
    )
    .bind(host_id)
    .bind(&database_name)
    .fetch_optional(state.tenants.master())
    .await?;

    let database_id = match existing_database {
        Some(id) => id,
        None => managed_db::create_database_on_host(
            state,
            host_id,
            &database_name,
            Some(&database_user),
            managed_db::Retention {
                daily: 7,
                weekly: 4,
                monthly: 12,
                yearly: 5,
            },
        )
        .await?
        .id
        .parse::<i64>()?,
    };

    let tenant_connection = json!({
        "postgresDatabaseId": database_id.to_string(),
        "objectStorage": {
            "enabled": true,
            "provider": "s3",
            "bucket": storage_bucket,
            "region": storage_region,
            "endpoint": storage_endpoint,
            "publicBaseUrl": storage_public_url,
            "forcePathStyle": true,
            "accessKeyId": storage_access_key,
            "secretAccessKey": storage_secret_key,
            "keyPrefix": format!("tenants/{tenant_name}"),
            "uploadUrlTtlSec": 300,
            "downloadUrlTtlSec": 300,
        },
    });

    sqlx::query(
        r#"
        INSERT INTO __tenants (
            name, admin_hash, disabled, contact_details, connection_details, options
        )
        VALUES ($1, $2, FALSE, $3, $4, '{}'::JSONB)
        ON CONFLICT (name) DO UPDATE SET
            admin_hash = EXCLUDED.admin_hash,
            disabled = FALSE,
            contact_details = EXCLUDED.contact_details,
            connection_details = EXCLUDED.connection_details,
            locked_at = NULL,
            deactivated_at = NULL,
            deleted_at = NULL
        "#,
    )
    .bind(&tenant_name)
    .bind(hash("123456", 4)?)
    .bind(json!({
        "email": "buero@malerbetrieb-beispiel.de",
        "companyName": "Malerbetrieb Beispiel GmbH",
    }))
    .bind(tenant_connection)
    .execute(state.tenants.master())
    .await?;

    // Opening the tenant pool applies all embedded Rust migrations first.
    let tenant_pool = state.tenants.tenant_pool(&tenant_name).await?;
    let existing_users = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
        .fetch_one(&tenant_pool)
        .await?;

    if existing_users == 0 {
        let seed = random_seed();
        tracing::info!(seed, tenant = %tenant_name, "seeding randomized development data");
        seed_randomized_data(&tenant_pool, seed).await?;
    }

    ensure_development_users(&tenant_pool).await?;

    // Include the stable Doe accounts and their planning records in the
    // displayed summary, not only the randomized portion created above.
    current_summary(&tenant_pool).await
}

/// Populates a migrated tenant with the same broad entity graph as the legacy
/// fixture: users, customers, contacts, projects, tools, products, histories,
/// delivery notes, deployments, daily reports, and weekly regie reports.
pub async fn seed_randomized_data(pool: &PgPool, seed: u64) -> SeedResult<SeedSummary> {
    let mut random = SeedRng::new(seed);
    let mut transaction = pool.begin().await?;
    let password_hash = hash("123456", 4)?;

    let user_count = 50 + random.range(5);
    let mut user_ids = Vec::with_capacity(user_count);
    let mut usernames = HashSet::with_capacity(user_count);

    for index in 0..user_count {
        let first_name = FIRST_NAMES[random.range(FIRST_NAMES.len())];
        let last_name = LAST_NAMES[random.range(LAST_NAMES.len())];
        let base_username = format!(
            "{}.{}",
            normalized_identifier(first_name),
            normalized_identifier(last_name),
        );
        let username = unique_username(&mut usernames, base_username, index);
        let cost_per_hour = random
            .chance(4, 5)
            .then(|| 32.0 + random.range(3_600) as f64 / 100.0);
        let contract_type = if random.chance(1, 8) {
            "external"
        } else {
            "internal"
        };

        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO users (
                username, first_name, last_name, email, phone, password,
                deactivated_at, cost_per_hour, contract_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)
            RETURNING id
            "#,
        )
        .bind(&username)
        .bind(first_name)
        .bind(last_name)
        .bind(format!("{username}@malerbetrieb-beispiel.de"))
        .bind(random_mobile_number(&mut random))
        .bind(&password_hash)
        .bind(cost_per_hour)
        .bind(contract_type)
        .fetch_one(&mut *transaction)
        .await?;

        user_ids.push(id);
    }

    sqlx::query("INSERT INTO user_role_assignments (user_id, role_name) VALUES ($1, ':admin')")
        .bind(user_ids[0])
        .execute(&mut *transaction)
        .await?;

    // A shallow reporting hierarchy makes vacation approval and filtered team
    // views useful without creating artificial supervisor loops.
    for index in 1..user_ids.len() {
        let supervisor_index = if index < 7 { 0 } else { 1 + (index % 6) };

        sqlx::query("UPDATE users SET supervisor_user_id = $1 WHERE id = $2")
            .bind(user_ids[supervisor_index])
            .bind(user_ids[index])
            .execute(&mut *transaction)
            .await?;
    }

    let customer_count = 5 + random.range(5);
    let customer_offset = random.range(CUSTOMERS.len());
    let mut customer_ids = Vec::with_capacity(customer_count);

    for index in 0..customer_count {
        let customer = CUSTOMERS[(customer_offset + index) % CUSTOMERS.len()];

        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO customers (name, address, phone_numbers, email_addresses)
            VALUES ($1, $2, $3, $4)
            RETURNING id
            "#,
        )
        .bind(customer.name)
        .bind(random_address(&mut random))
        .bind(json!([{ "number": random_office_number(&mut random), "name": "Zentrale" }]))
        .bind(json!([{ "email": customer.email, "name": "Projektanfragen" }]))
        .fetch_one(&mut *transaction)
        .await?;

        customer_ids.push(id);
    }

    let project_count = 50 + random.range(30);
    let mut project_ids = Vec::with_capacity(project_count);

    for index in 0..project_count {
        let customer_id = random
            .chance(4, 5)
            .then(|| customer_ids[index % customer_ids.len()]);
        let leader_id = (index % 5 != 0).then(|| user_ids[index % 7]);
        let finished_at =
            (index % 5 == 0).then(|| Utc::now() - Duration::days(30 + index as i64 * 11));
        let (address, city, street_address) = random_address_with_label(&mut random);
        let project_description = random_project_description(&mut random);
        let title = format!("{project_description} – {city}, {street_address}");

        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO projects (
                title, address, customer_id, responsible_project_leader_user_id, finished_at
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            "#,
        )
        .bind(title)
        .bind(address)
        .bind(customer_id)
        .bind(leader_id)
        .bind(finished_at)
        .fetch_one(&mut *transaction)
        .await?;

        project_ids.push(id);
    }

    let contact_count = 8 + random.range(5);
    let mut contact_ids = Vec::with_capacity(contact_count);
    let mut contact_names = HashSet::with_capacity(contact_count);

    for index in 0..contact_count {
        let (first_name, last_name) = unique_person_name(&mut random, &mut contact_names, index);
        let email_name = format!(
            "{}.{}",
            normalized_identifier(first_name),
            normalized_identifier(last_name),
        );

        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO contacts (
                first_name, last_name, address, phone_numbers, email_addresses
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            "#,
        )
        .bind(first_name)
        .bind(last_name)
        .bind(random_address(&mut random))
        .bind(json!([{ "number": random_mobile_number(&mut random), "name": "Mobil" }]))
        .bind(json!([{ "email": format!("{email_name}@planung-beispiel.de"), "name": "Geschäftlich" }]))
        .fetch_one(&mut *transaction)
        .await?;

        contact_ids.push(id);
    }

    // At least one relation per project/customer keeps reverse-lookup tests
    // meaningful regardless of the random seed.
    for (index, project_id) in project_ids.iter().enumerate() {
        sqlx::query(
            "INSERT INTO project_contacts (project_id, contact_id, label) VALUES ($1, $2, $3)",
        )
        .bind(project_id)
        .bind(contact_ids[index % contact_ids.len()])
        .bind((index % 2 == 0).then_some("Bauleitung"))
        .execute(&mut *transaction)
        .await?;
    }

    for (index, customer_id) in customer_ids.iter().enumerate() {
        sqlx::query("INSERT INTO customer_contacts (customer_id, contact_id) VALUES ($1, $2)")
            .bind(customer_id)
            .bind(contact_ids[index % contact_ids.len()])
            .execute(&mut *transaction)
            .await?;
    }

    let tool_count = 50 + random.range(30);
    let first_tool_custom_id = next_custom_id(&mut transaction, "tools").await?;
    let mut tool_ids = Vec::with_capacity(tool_count);

    for index in 0..tool_count {
        let brand = TOOL_BRANDS[random.range(TOOL_BRANDS.len())];
        let category = TOOL_CATEGORIES[random.range(TOOL_CATEGORIES.len())];
        let label = random.chance(4, 5).then(|| {
            format!(
                "{}-{:02}-{:04}",
                normalized_identifier(brand).to_uppercase(),
                20 + index % 6,
                1_000 + random.range(9_000),
            )
        });
        let status = random.chance(1, 12).then(|| {
            if random.chance(1, 3) {
                "lost"
            } else {
                "broken"
            }
        });
        let purchase_price = random
            .chance(4, 5)
            .then(|| 149.0 + random.range(135_000) as f64 / 100.0);
        let usage_cost = random
            .chance(3, 4)
            .then(|| 4.0 + random.range(3_100) as f64 / 100.0);

        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO tools (
                custom_id, brand, category, label, purchase_price,
                usage_cost_per_day, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            "#,
        )
        .bind(first_tool_custom_id + index as i32 * 2)
        .bind(brand)
        .bind(category)
        .bind(label)
        .bind(purchase_price)
        .bind(usage_cost)
        .bind(status)
        .fetch_one(&mut *transaction)
        .await?;

        tool_ids.push(id);
    }

    let mut open_tracking_ids = Vec::new();

    for (index, tool_id) in tool_ids.iter().take(30).enumerate() {
        let started_at = Utc::now() - Duration::days((5 + random.range(60)) as i64);
        let ended_at =
            (index % 4 == 0).then(|| started_at + Duration::days(1 + random.range(7) as i64));
        let author_id = user_ids[random.range(user_ids.len())];
        let project_id = (index % 2 == 0).then(|| project_ids[index % project_ids.len()]);

        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO tool_trackings (
                tool_id, responsible_user_id, project_id, started_by_user_id,
                ended_by_user_id, tool_usage_cost_per_day, started_at, ended_at
            )
            SELECT $1, $2, $3, $4, $5, usage_cost_per_day, $6, $7
            FROM tools WHERE id = $1
            RETURNING id
            "#,
        )
        .bind(tool_id)
        .bind(user_ids[index % user_ids.len()])
        .bind(project_id)
        .bind(author_id)
        .bind(ended_at.map(|_| author_id))
        .bind(started_at)
        .bind(ended_at)
        .fetch_one(&mut *transaction)
        .await?;

        if ended_at.is_none() {
            open_tracking_ids.push(id);
        }
    }

    for (index, tracking_id) in open_tracking_ids.iter().take(5).enumerate() {
        sqlx::query(
            r#"
            INSERT INTO tool_tracking_transfer_requests (
                tool_tracking_id, status, transfer_to_user_id, created_by_user_id, notes
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(tracking_id)
        .bind(if index == 4 { "denied" } else { "open" })
        .bind(user_ids[(index + 1) % user_ids.len()])
        .bind(user_ids[index % user_ids.len()])
        .bind(TRANSFER_NOTES[index % TRANSFER_NOTES.len()])
        .execute(&mut *transaction)
        .await?;
    }

    for index in 0..(30 + random.range(30)) {
        let comment = random
            .chance(3, 4)
            .then(|| INVENTORY_NOTES[index % INVENTORY_NOTES.len()]);

        sqlx::query(
            "INSERT INTO tool_inventories (tool_id, comment, created_at) VALUES ($1, $2, $3)",
        )
        .bind(tool_ids[index % tool_ids.len()])
        .bind(comment)
        .bind(Utc::now() - Duration::days(random.range(365) as i64))
        .execute(&mut *transaction)
        .await?;
    }

    let today = Utc::now().date_naive();
    let deployment_count = 80 + random.range(20);

    // Populate the visible planning window: two weeks of history, the current
    // week, and six upcoming weeks. The former seed generated only old rows,
    // which made the default Einsatzplanung screen look empty.
    for index in 0..deployment_count {
        let day_offset = index as i64 % 56 - 14;
        let start_hour = 6 + random.range(4) as u32;
        let from = (today + Duration::days(day_offset))
            .and_hms_opt(start_hour, if index % 3 == 0 { 30 } else { 0 }, 0)
            .expect("fixture deployment time is valid")
            .and_utc();
        let hours = 5 + random.range(5) as i64;

        sqlx::query(
            r#"
            INSERT INTO project_deployments (project_id, user_id, "from", "to", note)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(project_ids[(index * 7) % project_ids.len()])
        .bind(user_ids[(index * 11) % user_ids.len()])
        .bind(from)
        .bind(from + Duration::hours(hours))
        .bind(DEPLOYMENT_NOTES[index % DEPLOYMENT_NOTES.len()])
        .execute(&mut *transaction)
        .await?;
    }

    let vacation_count = 24 + random.range(12);

    for index in 0..vacation_count {
        let from = today + Duration::days(index as i64 * 4 - 35);
        let to = from + Duration::days(1 + random.range(10) as i64);
        let status = match index % 6 {
            0..=2 => "approved",
            3 | 4 => "requested",
            _ => "denied",
        };
        let decided = status != "requested";

        sqlx::query(
            r#"
            INSERT INTO user_vacations (
                user_id, requested_by_user_id, decided_by_user_id,
                "from", "to", status, note, denial_reason, decided_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(user_ids[(index * 5 + 1) % user_ids.len()])
        .bind(user_ids[(index * 5 + 1) % user_ids.len()])
        .bind(decided.then_some(user_ids[0]))
        .bind(from)
        .bind(to)
        .bind(status)
        .bind(VACATION_NOTES[index % VACATION_NOTES.len()])
        .bind((status == "denied").then_some(DENIAL_REASONS[index % DENIAL_REASONS.len()]))
        .bind(decided.then_some(Utc::now() - Duration::days(random.range(14) as i64)))
        .execute(&mut *transaction)
        .await?;
    }

    let unavailability_period_count = 10 + random.range(6);

    for index in 0..unavailability_period_count {
        let from = today + Duration::days(index as i64 * 7 - 14);

        sqlx::query(
            r#"
            INSERT INTO project_unavailability_periods (
                project_id, created_by_user_id, "from", "to", reason, note
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(project_ids[(index * 3) % project_ids.len()])
        .bind(user_ids[0])
        .bind(from)
        .bind(from + Duration::days(1 + random.range(5) as i64))
        .bind(UNAVAILABILITY_REASONS[index % UNAVAILABILITY_REASONS.len()])
        .bind(UNAVAILABILITY_NOTES[index % UNAVAILABILITY_NOTES.len()])
        .execute(&mut *transaction)
        .await?;
    }

    let product_count = 50 + random.range(10);
    let first_product_custom_id = next_custom_id(&mut transaction, "products").await?;
    let product_offset = random.range(PRODUCT_CATALOG.len());
    let mut products = Vec::with_capacity(product_count);

    for index in 0..product_count {
        let template = PRODUCT_CATALOG[(product_offset + index) % PRODUCT_CATALOG.len()];
        let package = product_package(template.base_unit, index / PRODUCT_CATALOG.len());
        let name = format!("{} ({package})", template.name);

        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO products (
                custom_id, name, brand, description, base_unit, other_units
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            "#,
        )
        .bind(first_product_custom_id + index as i32 * 2)
        .bind(name)
        .bind(template.brand)
        .bind(template.description)
        .bind(template.base_unit)
        .bind(product_other_units(template.base_unit, &mut random))
        .fetch_one(&mut *transaction)
        .await?;

        sqlx::query("INSERT INTO product_categories (product_id, category) VALUES ($1, $2)")
            .bind(id)
            .bind(template.category)
            .execute(&mut *transaction)
            .await?;

        if let Some(secondary_category) = template.secondary_category {
            sqlx::query("INSERT INTO product_categories (product_id, category) VALUES ($1, $2)")
                .bind(id)
                .bind(secondary_category)
                .execute(&mut *transaction)
                .await?;
        }

        products.push((id, template.base_unit));
    }

    let vendor_count = 10 + random.range(5);
    let vendor_offset = random.range(VENDORS.len());
    let mut vendor_ids = Vec::with_capacity(vendor_count);

    for index in 0..vendor_count {
        let vendor = VENDORS[(vendor_offset + index) % VENDORS.len()];
        let id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO product_vendors (name, description) VALUES ($1, $2) RETURNING id",
        )
        .bind(vendor.name)
        .bind(vendor.description)
        .fetch_one(&mut *transaction)
        .await?;

        vendor_ids.push(id);
    }

    for (index, (product_id, unit)) in products.iter().enumerate() {
        for history_offset in 0..(2 + random.range(3)) {
            sqlx::query(
                r#"
                INSERT INTO product_price_records (
                    product_id, vendor_id, timestamp, price, is_real_purchase, comment
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                "#,
            )
            .bind(product_id)
            .bind((history_offset % 3 != 2).then(|| vendor_ids[index % vendor_ids.len()]))
            .bind(Utc::now() - Duration::days(history_offset as i64 * 30 + random.range(10) as i64))
            .bind(plausible_unit_price(unit, &mut random))
            .bind(history_offset % 3 != 2)
            .bind(PRICE_NOTES[history_offset % PRICE_NOTES.len()])
            .execute(&mut *transaction)
            .await?;
        }
    }

    let delivery_note_count = 25 + random.range(10);

    for index in 0..delivery_note_count {
        let note_id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO product_delivery_notes (project_id, comment, created_by_user_id)
            VALUES ($1, $2, $3)
            RETURNING id
            "#,
        )
        .bind(project_ids[(index * 3) % project_ids.len()])
        .bind(DELIVERY_NOTE_COMMENTS[index % DELIVERY_NOTE_COMMENTS.len()])
        .bind(user_ids[index % user_ids.len()])
        .fetch_one(&mut *transaction)
        .await?;

        for record_offset in 0..(2 + random.range(4)) {
            let (product_id, unit) = products[(index * 5 + record_offset) % products.len()];

            sqlx::query(
                r#"
                INSERT INTO product_delivery_records (
                    note_id, product_id, quantity, unit, comment
                )
                VALUES ($1, $2, $3, $4, $5)
                "#,
            )
            .bind(note_id)
            .bind(product_id)
            .bind(plausible_delivery_quantity(unit, &mut random))
            .bind(unit)
            .bind(DELIVERY_RECORD_COMMENTS[record_offset % DELIVERY_RECORD_COMMENTS.len()])
            .execute(&mut *transaction)
            .await?;
        }

        if index % 3 == 0 {
            let special = SPECIAL_DELIVERY_RECORDS[index % SPECIAL_DELIVERY_RECORDS.len()];

            sqlx::query(
                r#"
                INSERT INTO product_delivery_special_records (
                    note_id, name, unit, amount, price_per_unit, comment
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                "#,
            )
            .bind(note_id)
            .bind(special.name)
            .bind(special.unit)
            .bind(1.0 + random.range(8) as f64)
            .bind(special.price)
            .bind(special.comment)
            .execute(&mut *transaction)
            .await?;
        }
    }

    let daily_report_count = 20 + random.range(10);

    for index in 0..daily_report_count {
        let day = today - Duration::days(random.range(30) as i64);
        let weather = WEATHER[index % WEATHER.len()];
        let report_id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO daily_project_reports (
                project_id, day, summary, weather, created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            "#,
        )
        .bind(project_ids[index % project_ids.len()])
        .bind(day)
        .bind(DAILY_REPORT_SUMMARIES[index % DAILY_REPORT_SUMMARIES.len()])
        .bind(json!({
            "summary": weather.summary,
            "temperatureC": weather.temperature + random.range(30) as f64 / 10.0,
        }))
        .bind(user_ids[index % user_ids.len()])
        .fetch_one(&mut *transaction)
        .await?;

        for worker_offset in 0..(2 + random.range(3)) {
            sqlx::query(
                r#"
                INSERT INTO daily_project_report_work_hours (
                    report_id, user_id, hours, cost_per_hour, contract_type
                )
                SELECT $1, id, $3, cost_per_hour, contract_type FROM users WHERE id = $2
                "#,
            )
            .bind(report_id)
            .bind(user_ids[(index + worker_offset) % user_ids.len()])
            .bind(4.0 + random.range(450) as f64 / 100.0)
            .execute(&mut *transaction)
            .await?;
        }
    }

    let regie_report_count = 15 + random.range(10);

    for index in 0..regie_report_count {
        let selected_day = today - Duration::days(random.range(60) as i64);
        let monday =
            selected_day - Duration::days(selected_day.weekday().num_days_from_monday() as i64);
        let report_id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO regie_reports (project_id, day, summary, created_by_user_id)
            VALUES ($1, $2, $3, $4)
            RETURNING id
            "#,
        )
        .bind(project_ids[index % project_ids.len()])
        .bind(monday)
        .bind(REGIE_REPORT_SUMMARIES[index % REGIE_REPORT_SUMMARIES.len()])
        .bind(user_ids[index % user_ids.len()])
        .fetch_one(&mut *transaction)
        .await?;

        for product_offset in 0..(1 + random.range(3)) {
            let (product_id, unit) = products[(index + product_offset) % products.len()];

            sqlx::query(
                "INSERT INTO regie_report_products (report_id, product_id, quantity) VALUES ($1, $2, $3)",
            )
            .bind(report_id)
            .bind(product_id)
            .bind(plausible_delivery_quantity(unit, &mut random))
            .execute(&mut *transaction)
            .await?;
        }

        for worker_offset in 0..(1 + random.range(3)) {
            sqlx::query(
                "INSERT INTO regie_report_work_hours (report_id, user_id, day, hours) VALUES ($1, $2, $3, $4)",
            )
            .bind(report_id)
            .bind(user_ids[(index + worker_offset) % user_ids.len()])
            .bind(monday + Duration::days(random.range(5) as i64))
            .bind(1.0 + random.range(700) as f64 / 100.0)
            .execute(&mut *transaction)
            .await?;
        }
    }

    let financial_entry_count = 60 + random.range(30);

    for index in 0..financial_entry_count {
        let entry_type = if index % 3 == 0 { "invoice" } else { "offer" };
        let base_amount = if entry_type == "invoice" {
            2_500.0
        } else {
            8_000.0
        };

        sqlx::query(
            r#"
            INSERT INTO project_financial_entries (
                project_id, type, amount, comment, created_by_user_id, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(project_ids[index % project_ids.len()])
        .bind(entry_type)
        .bind(base_amount + random.range(4_500_000) as f64 / 100.0)
        .bind(FINANCIAL_NOTES[index % FINANCIAL_NOTES.len()])
        .bind(user_ids[index % user_ids.len()])
        .bind(Utc::now() - Duration::days(random.range(540) as i64))
        .execute(&mut *transaction)
        .await?;
    }

    let remark_count = 40 + random.range(20);

    for index in 0..remark_count {
        let body = REMARKS[index % REMARKS.len()];
        let author_id = user_ids[index % user_ids.len()];

        match index % 4 {
            0 => {
                sqlx::query(
                    "INSERT INTO resource_notes (project_id, body, created_by_user_id) VALUES ($1, $2, $3)",
                )
                .bind(project_ids[index % project_ids.len()])
                .bind(body)
                .bind(author_id)
                .execute(&mut *transaction)
                .await?;
            }
            1 => {
                sqlx::query(
                    "INSERT INTO resource_notes (customer_id, body, created_by_user_id) VALUES ($1, $2, $3)",
                )
                .bind(customer_ids[index % customer_ids.len()])
                .bind(body)
                .bind(author_id)
                .execute(&mut *transaction)
                .await?;
            }
            2 => {
                sqlx::query(
                    "INSERT INTO resource_notes (tool_id, body, created_by_user_id) VALUES ($1, $2, $3)",
                )
                .bind(tool_ids[index % tool_ids.len()])
                .bind(body)
                .bind(author_id)
                .execute(&mut *transaction)
                .await?;
            }
            _ => {
                sqlx::query(
                    "INSERT INTO resource_notes (contact_id, body, created_by_user_id) VALUES ($1, $2, $3)",
                )
                .bind(contact_ids[index % contact_ids.len()])
                .bind(body)
                .bind(author_id)
                .execute(&mut *transaction)
                .await?;
            }
        }
    }

    transaction.commit().await?;

    Ok(SeedSummary {
        users: user_count,
        projects: project_count,
        tools: tool_count,
        products: product_count,
        vendors: vendor_count,
        customers: customer_count,
        contacts: contact_count,
        delivery_notes: delivery_note_count,
        daily_reports: daily_report_count,
        regie_reports: regie_report_count,
        deployments: deployment_count,
        vacations: vacation_count,
        unavailability_periods: unavailability_period_count,
        financial_entries: financial_entry_count,
        remarks: remark_count,
    })
}

/// Reconciles the stable accounts documented for local development.
pub async fn ensure_development_users(pool: &PgPool) -> SeedResult<()> {
    let password_hash = hash("123456", 12)?;
    let mut transaction = pool.begin().await?;
    let users = [
        (
            "john.doe",
            "John",
            "Doe",
            "john.doe@malerbetrieb-beispiel.de",
            "+49 171 4827361",
        ),
        (
            "frank.doe",
            "Frank",
            "Doe",
            "frank.doe@malerbetrieb-beispiel.de",
            "+49 160 5938247",
        ),
    ];
    let mut ids = Vec::with_capacity(users.len());

    for (username, first_name, last_name, email, phone) in users {
        let id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO users (
                username, first_name, last_name, email, phone, password, deactivated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, NULL)
            ON CONFLICT (username) DO UPDATE SET
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                password = EXCLUDED.password,
                deactivated_at = NULL,
                archived_at = NULL
            RETURNING id
            "#,
        )
        .bind(username)
        .bind(first_name)
        .bind(last_name)
        .bind(email)
        .bind(phone)
        .bind(&password_hash)
        .fetch_one(&mut *transaction)
        .await?;

        ids.push(id);
    }
    sqlx::query("DELETE FROM user_role_assignments WHERE user_id = ANY($1)")
        .bind(&ids)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("INSERT INTO user_role_assignments (user_id, role_name) VALUES ($1, ':admin')")
        .bind(ids[0])
        .execute(&mut *transaction)
        .await?;

    sqlx::query("UPDATE users SET supervisor_user_id = $1 WHERE id = $2")
        .bind(ids[0])
        .bind(ids[1])
        .execute(&mut *transaction)
        .await?;

    for user_id in &ids {
        let has_visits: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_visit_history WHERE user_id = $1)",
        )
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await?;

        if !has_visits {
            for (offset, (path, title)) in DEVELOPMENT_VISITS.iter().enumerate() {
                sqlx::query(
                    "INSERT INTO user_visit_history (user_id, path, title, visited_at) VALUES ($1, $2, $3, $4)",
                )
                .bind(user_id)
                .bind(path)
                .bind(title)
                .bind(Utc::now() - Duration::minutes(offset as i64 * 17))
                .execute(&mut *transaction)
                .await?;
            }
        }

        let has_actions: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_action_history WHERE user_id = $1)",
        )
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await?;

        if !has_actions {
            for (offset, (action_id, label, href)) in DEVELOPMENT_ACTIONS.iter().enumerate() {
                sqlx::query(
                    "INSERT INTO user_action_history (user_id, action_id, label, href, used_at) VALUES ($1, $2, $3, $4, $5)",
                )
                .bind(user_id)
                .bind(action_id)
                .bind(label)
                .bind(href)
                .bind(Utc::now() - Duration::minutes(offset as i64 * 23))
                .execute(&mut *transaction)
                .await?;
            }
        }
    }

    // Give both documented accounts records in the default planning window.
    // NOT EXISTS keeps repeated development starts idempotent.
    sqlx::query(
        r#"
        INSERT INTO project_deployments (project_id, user_id, "from", "to", note)
        SELECT
            project.id,
            $1,
            date_trunc('day', NOW()) + INTERVAL '1 day 7 hours',
            date_trunc('day', NOW()) + INTERVAL '1 day 15 hours 30 minutes',
            'Innenausbau und Spachtelarbeiten im zweiten Obergeschoss.'
        FROM projects AS project
        WHERE project.finished_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM project_deployments
              WHERE user_id = $1
                AND note = 'Innenausbau und Spachtelarbeiten im zweiten Obergeschoss.'
          )
        ORDER BY project.id
        LIMIT 1
        "#,
    )
    .bind(ids[1])
    .execute(&mut *transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO user_vacations (
            user_id, requested_by_user_id, "from", "to", status, note
        )
        SELECT
            $1,
            $1,
            CURRENT_DATE + 21,
            CURRENT_DATE + 32,
            'requested',
            'Sommerurlaub – bereits mit der Kolonne abgestimmt.'
        WHERE NOT EXISTS (
            SELECT 1 FROM user_vacations
            WHERE user_id = $1
              AND note = 'Sommerurlaub – bereits mit der Kolonne abgestimmt.'
        )
        "#,
    )
    .bind(ids[1])
    .execute(&mut *transaction)
    .await?;

    transaction.commit().await?;
    Ok(())
}

async fn current_summary(pool: &PgPool) -> SeedResult<SeedSummary> {
    let row = sqlx::query(
        r#"
        SELECT
            (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM projects) AS projects,
            (SELECT COUNT(*) FROM tools) AS tools,
            (SELECT COUNT(*) FROM products) AS products,
            (SELECT COUNT(*) FROM product_vendors) AS vendors,
            (SELECT COUNT(*) FROM customers) AS customers,
            (SELECT COUNT(*) FROM contacts) AS contacts,
            (SELECT COUNT(*) FROM product_delivery_notes) AS delivery_notes,
            (SELECT COUNT(*) FROM daily_project_reports) AS daily_reports,
            (SELECT COUNT(*) FROM regie_reports) AS regie_reports,
            (SELECT COUNT(*) FROM project_deployments) AS deployments,
            (SELECT COUNT(*) FROM user_vacations) AS vacations,
            (SELECT COUNT(*) FROM project_unavailability_periods) AS unavailability_periods,
            (SELECT COUNT(*) FROM project_financial_entries) AS financial_entries,
            (SELECT COUNT(*) FROM resource_notes) AS remarks
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(SeedSummary {
        users: row.try_get::<i64, _>("users")? as usize,
        projects: row.try_get::<i64, _>("projects")? as usize,
        tools: row.try_get::<i64, _>("tools")? as usize,
        products: row.try_get::<i64, _>("products")? as usize,
        vendors: row.try_get::<i64, _>("vendors")? as usize,
        customers: row.try_get::<i64, _>("customers")? as usize,
        contacts: row.try_get::<i64, _>("contacts")? as usize,
        delivery_notes: row.try_get::<i64, _>("delivery_notes")? as usize,
        daily_reports: row.try_get::<i64, _>("daily_reports")? as usize,
        regie_reports: row.try_get::<i64, _>("regie_reports")? as usize,
        deployments: row.try_get::<i64, _>("deployments")? as usize,
        vacations: row.try_get::<i64, _>("vacations")? as usize,
        unavailability_periods: row.try_get::<i64, _>("unavailability_periods")? as usize,
        financial_entries: row.try_get::<i64, _>("financial_entries")? as usize,
        remarks: row.try_get::<i64, _>("remarks")? as usize,
    })
}
async fn next_custom_id(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: &str,
) -> SeedResult<i32> {
    let statement = match table {
        "tools" => "SELECT COALESCE(MAX(custom_id), 0)::INT + 1 FROM tools",
        "products" => "SELECT COALESCE(MAX(custom_id), 0)::INT + 1 FROM products",
        _ => return Err(format!("unsupported custom-id table {table}").into()),
    };

    Ok(sqlx::query_scalar(statement)
        .fetch_one(&mut **transaction)
        .await?)
}

fn random_project_description(random: &mut SeedRng) -> String {
    let (work, object) = match random.range(10) {
        0 | 1 => (
            EXTERIOR_PROJECT_WORK[random.range(EXTERIOR_PROJECT_WORK.len())],
            EXTERIOR_PROJECT_OBJECTS[random.range(EXTERIOR_PROJECT_OBJECTS.len())],
        ),
        2 | 3 => (
            INTERIOR_PROJECT_WORK[random.range(INTERIOR_PROJECT_WORK.len())],
            INTERIOR_PROJECT_OBJECTS[random.range(INTERIOR_PROJECT_OBJECTS.len())],
        ),
        _ => (
            GENERAL_PROJECT_WORK[random.range(GENERAL_PROJECT_WORK.len())],
            GENERAL_PROJECT_OBJECTS[random.range(GENERAL_PROJECT_OBJECTS.len())],
        ),
    };

    if random.chance(1, 3) {
        let section = PROJECT_SECTIONS[random.range(PROJECT_SECTIONS.len())];
        format!("{work} {object}, {section}")
    } else {
        format!("{work} {object}")
    }
}

fn random_street(random: &mut SeedRng) -> String {
    match random.range(4) {
        0 => FIXED_STREETS[random.range(FIXED_STREETS.len())].to_owned(),
        1 => DESTINATION_STREETS[random.range(DESTINATION_STREETS.len())].to_owned(),
        _ => format!(
            "{}{}",
            STREET_STEMS[random.range(STREET_STEMS.len())],
            STREET_SUFFIXES[random.range(STREET_SUFFIXES.len())],
        ),
    }
}

fn random_address(random: &mut SeedRng) -> serde_json::Value {
    random_address_with_label(random).0
}

fn random_address_with_label(random: &mut SeedRng) -> (serde_json::Value, &'static str, String) {
    let place = PLACES[random.range(PLACES.len())];
    let street = random_street(random);
    let house_number = 1 + random.range(118);
    let street_address = format!("{street} {house_number}");
    let address = json!({
        "country": "Deutschland",
        "zip": place.zip,
        "city": place.city,
        "streetAddress": street_address,
    });

    (address, place.city, street_address)
}

fn random_mobile_number(random: &mut SeedRng) -> String {
    let prefix = MOBILE_PREFIXES[random.range(MOBILE_PREFIXES.len())];

    format!("+49 {prefix} {:07}", 1_000_000 + random.range(9_000_000))
}

fn random_office_number(random: &mut SeedRng) -> String {
    let place = PLACES[random.range(PLACES.len())];

    format!(
        "+49 {} {:06}",
        place.area_code,
        100_000 + random.range(900_000),
    )
}

fn normalized_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn unique_username(usernames: &mut HashSet<String>, base: String, fallback_index: usize) -> String {
    if usernames.insert(base.clone()) {
        return base;
    }

    for suffix in 2..100 {
        let candidate = format!("{base}.{suffix}");
        if usernames.insert(candidate.clone()) {
            return candidate;
        }
    }

    // The name catalog is much larger than the fixture, so this is only a
    // defensive fallback if that relationship changes later.
    let candidate = format!("{base}.{}", fallback_index + 100);
    usernames.insert(candidate.clone());
    candidate
}

fn unique_person_name(
    random: &mut SeedRng,
    names: &mut HashSet<String>,
    fallback_index: usize,
) -> (&'static str, &'static str) {
    for _ in 0..100 {
        let first_name = FIRST_NAMES[random.range(FIRST_NAMES.len())];
        let last_name = LAST_NAMES[random.range(LAST_NAMES.len())];
        let key = format!("{first_name} {last_name}");

        if names.insert(key) {
            return (first_name, last_name);
        }
    }

    let first_name = FIRST_NAMES[fallback_index % FIRST_NAMES.len()];
    let last_name = LAST_NAMES[(fallback_index / FIRST_NAMES.len()) % LAST_NAMES.len()];
    names.insert(format!("{first_name} {last_name}"));

    (first_name, last_name)
}

fn product_package(base_unit: &str, repetition: usize) -> &'static str {
    let variants = match base_unit {
        "kg" => &["25-kg-Sack", "30-kg-Sack", "5-kg-Eimer"][..],
        "l" => &["10-l-Gebinde", "5-l-Gebinde", "15-l-Eimer"][..],
        "m²" => &["1,25 × 2,00 m", "1,25 × 2,60 m", "0,625 × 1,25 m"][..],
        "Lfm" => &["3,00 m", "4,00 m", "2,60 m"][..],
        "Rolle" => &["50-m-Rolle", "25-m-Rolle", "20-m-Rolle"][..],
        _ => &["Standard", "Großpackung", "Kleinpackung"][..],
    };

    variants[repetition % variants.len()]
}

fn product_other_units(base_unit: &str, random: &mut SeedRng) -> serde_json::Value {
    match base_unit {
        "kg" => json!({ "Sack": 25, "Pal": 40 * 25 }),
        "l" => json!({ "Eimer": 10, "Pal": 44 * 10 }),
        "m²" => json!({ "Stk": 2.5, "Pal": 50.0 + random.range(20) as f64 * 2.5 }),
        "Lfm" => json!({ "Stk": 3, "Bund": 12 * 3 }),
        "Rolle" => json!({ "Karton": 8 }),
        "Stk" => json!({ "Karton": 100, "Pal": 2400 }),
        _ => json!({}),
    }
}

fn plausible_unit_price(unit: &str, random: &mut SeedRng) -> f64 {
    let (minimum_cents, spread_cents) = match unit {
        "kg" => (45, 450),
        "l" => (250, 2_500),
        "m²" => (450, 4_500),
        "Lfm" => (90, 1_800),
        "Rolle" => (350, 5_000),
        "Stk" => (8, 2_500),
        _ => (100, 10_000),
    };

    (minimum_cents + random.range(spread_cents)) as f64 / 100.0
}

fn plausible_delivery_quantity(unit: &str, random: &mut SeedRng) -> f64 {
    match unit {
        "kg" => (10 + random.range(191)) as f64 * 25.0,
        "l" => (2 + random.range(39)) as f64 * 10.0,
        "m²" => 25.0 + random.range(47_500) as f64 / 100.0,
        "Lfm" => (10 + random.range(191)) as f64 * 3.0,
        "Rolle" => (1 + random.range(24)) as f64,
        "Stk" => (10 + random.range(491)) as f64,
        _ => 1.0 + random.range(10_000) as f64 / 100.0,
    }
}

fn required_env(name: &str) -> SeedResult<String> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("missing development seed environment variable {name}").into())
}

fn optional_env(name: &str, fallback: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn random_seed() -> u64 {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).expect("operating system random source must be available");
    u64::from_le_bytes(bytes)
}

struct SeedRng(u64);

impl SeedRng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next(&mut self) -> u64 {
        // xorshift64* is sufficient for fixture variation and is replayable.
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0 = self.0.wrapping_mul(0x2545_f491_4f6c_dd1d);
        self.0
    }

    fn range(&mut self, upper: usize) -> usize {
        debug_assert!(upper > 0);
        (self.next() % upper as u64) as usize
    }

    fn chance(&mut self, numerator: u64, denominator: u64) -> bool {
        self.next() % denominator < numerator
    }
}

#[derive(Clone, Copy)]
struct Place {
    zip: &'static str,
    city: &'static str,
    area_code: &'static str,
}

#[derive(Clone, Copy)]
struct CustomerTemplate {
    name: &'static str,
    email: &'static str,
}

#[derive(Clone, Copy)]
struct ProductTemplate {
    name: &'static str,
    brand: &'static str,
    description: &'static str,
    base_unit: &'static str,
    category: &'static str,
    secondary_category: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct VendorTemplate {
    name: &'static str,
    description: &'static str,
}

#[derive(Clone, Copy)]
struct WeatherTemplate {
    summary: &'static str,
    temperature: f64,
}

#[derive(Clone, Copy)]
struct SpecialDeliveryRecord {
    name: &'static str,
    unit: &'static str,
    price: f64,
    comment: &'static str,
}

const FIRST_NAMES: &[&str] = &[
    "Anna",
    "Benjamin",
    "Clara",
    "Daniel",
    "Elena",
    "Felix",
    "Greta",
    "Hasan",
    "Isabell",
    "Jonas",
    "Katharina",
    "Lukas",
    "Miriam",
    "Nico",
    "Olivia",
    "Paul",
    "Rafael",
    "Sabine",
    "Tobias",
    "Ute",
    "Viktor",
    "Yasemin",
    "Stefan",
    "Maria",
];

const LAST_NAMES: &[&str] = &[
    "Bauer",
    "Beck",
    "Fischer",
    "Graf",
    "Hoffmann",
    "Huber",
    "Klein",
    "Koch",
    "Kraus",
    "Lang",
    "Meyer",
    "Neumann",
    "Richter",
    "Roth",
    "Schmidt",
    "Schneider",
    "Schulz",
    "Vogel",
    "Wagner",
    "Weber",
    "Winter",
    "Wolf",
    "Zimmermann",
    "Yilmaz",
];

const PLACES: &[Place] = &[
    Place {
        zip: "90402",
        city: "Nürnberg",
        area_code: "911",
    },
    Place {
        zip: "90431",
        city: "Nürnberg",
        area_code: "911",
    },
    Place {
        zip: "90762",
        city: "Fürth",
        area_code: "911",
    },
    Place {
        zip: "91052",
        city: "Erlangen",
        area_code: "9131",
    },
    Place {
        zip: "96047",
        city: "Bamberg",
        area_code: "951",
    },
    Place {
        zip: "91522",
        city: "Ansbach",
        area_code: "981",
    },
    Place {
        zip: "91126",
        city: "Schwabach",
        area_code: "9122",
    },
    Place {
        zip: "90513",
        city: "Zirndorf",
        area_code: "911",
    },
    Place {
        zip: "90522",
        city: "Oberasbach",
        area_code: "911",
    },
    Place {
        zip: "91207",
        city: "Lauf a.d. Pegnitz",
        area_code: "9123",
    },
    Place {
        zip: "90518",
        city: "Altdorf b. Nürnberg",
        area_code: "9187",
    },
    Place {
        zip: "91074",
        city: "Herzogenaurach",
        area_code: "9132",
    },
];

const FIXED_STREETS: &[&str] = &[
    "Äußere Bayreuther Straße",
    "Bucher Straße",
    "Fürther Straße",
    "Gibitzenhofstraße",
    "Hallerstraße",
    "Hauptstraße",
    "Kapellenstraße",
    "Königstraße",
    "Lange Straße",
    "Nürnberger Straße",
    "Pegnitzstraße",
    "Rothenburger Straße",
    "Schwabacher Straße",
    "Sieboldstraße",
    "Spitalstraße",
    "Theaterstraße",
    "Ziegelsteinstraße",
];

const STREET_STEMS: &[&str] = &[
    "Acker",
    "Adler",
    "Bach",
    "Beethoven",
    "Berg",
    "Birken",
    "Buchen",
    "Dürer",
    "Eichen",
    "Finken",
    "Flieder",
    "Garten",
    "Goethe",
    "Heide",
    "Kapellen",
    "Kirsch",
    "Lerchen",
    "Lessing",
    "Linden",
    "Mozart",
    "Mühlen",
    "Nelken",
    "Rosen",
    "Schiller",
    "Schul",
    "Sonnen",
    "Tulpen",
    "Wald",
    "Weiher",
    "Wiesen",
];

const STREET_SUFFIXES: &[&str] = &["straße", "weg", "ring", "gasse", "allee"];

const DESTINATION_STREETS: &[&str] = &[
    "Altdorfer Straße",
    "Ansbacher Straße",
    "Bamberger Straße",
    "Bayreuther Straße",
    "Erlanger Straße",
    "Forchheimer Straße",
    "Fürther Straße",
    "Herzogenauracher Straße",
    "Laufer Straße",
    "Neumarkter Straße",
    "Rother Straße",
    "Schwabacher Straße",
    "Würzburger Straße",
    "Zirndorfer Straße",
];

const MOBILE_PREFIXES: &[&str] = &["151", "152", "157", "160", "162", "170", "171", "176"];

const CUSTOMERS: &[CustomerTemplate] = &[
    CustomerTemplate {
        name: "Franken Wohnbau GmbH",
        email: "projekte@franken-wohnbau.example",
    },
    CustomerTemplate {
        name: "WBG Nürnberg Projektentwicklung",
        email: "vergabe@wbg-nuernberg.example",
    },
    CustomerTemplate {
        name: "Hofmann Immobilienverwaltung KG",
        email: "technik@hofmann-immobilien.example",
    },
    CustomerTemplate {
        name: "Roth & Söhne Bauträger GmbH",
        email: "bauleitung@roth-bautraeger.example",
    },
    CustomerTemplate {
        name: "Stadtbau Fürth GmbH",
        email: "instandhaltung@stadtbau-fuerth.example",
    },
    CustomerTemplate {
        name: "Lebenshilfe Erlangen e.V.",
        email: "gebaeude@lebenshilfe-erlangen.example",
    },
    CustomerTemplate {
        name: "Klinikum am Stadtpark",
        email: "bauprojekte@klinikum-stadtpark.example",
    },
    CustomerTemplate {
        name: "Hotel Goldener Adler GmbH",
        email: "direktion@goldener-adler.example",
    },
    CustomerTemplate {
        name: "Schulverband Pegnitztal",
        email: "bauamt@schulverband-pegnitztal.example",
    },
    CustomerTemplate {
        name: "Brauerei Heller & Co. KG",
        email: "technik@brauerei-heller.example",
    },
    CustomerTemplate {
        name: "Evangelische Kirchengemeinde St. Lukas",
        email: "pfarramt@st-lukas.example",
    },
    CustomerTemplate {
        name: "Autohaus König Nürnberg GmbH",
        email: "facility@autohaus-koenig.example",
    },
    CustomerTemplate {
        name: "Praxiszentrum am Plärrer",
        email: "verwaltung@praxiszentrum-plaerrer.example",
    },
    CustomerTemplate {
        name: "Logistikpark Hafen Nürnberg",
        email: "projektbuero@logistikpark-hafen.example",
    },
];

const GENERAL_PROJECT_WORK: &[&str] = &[
    "Ausbau",
    "Bestandssanierung",
    "Brandschutzertüchtigung",
    "Innenausbau",
    "Instandsetzung",
    "Malerarbeiten",
    "Modernisierung",
    "Putz- und Spachtelarbeiten",
    "Renovierung",
    "Sanierung",
    "Trockenbauarbeiten",
    "Umbau",
];

const GENERAL_PROJECT_OBJECTS: &[&str] = &[
    "Altbauvilla",
    "Arztpraxis",
    "Autohaus",
    "Bankfiliale",
    "Berufsschule",
    "Betriebsgebäude",
    "Büroetage",
    "Bürogebäude",
    "Dachgeschoss",
    "Einkaufsmarkt",
    "Feuerwehrhaus",
    "Gastronomiefläche",
    "Gemeindehaus",
    "Hotel",
    "Kindertagesstätte",
    "Kulturzentrum",
    "Laborgebäude",
    "Logistikhalle",
    "Mehrfamilienhaus",
    "Pflegezentrum",
    "Praxiszentrum",
    "Produktionshalle",
    "Reihenhausanlage",
    "Schulgebäude",
    "Seniorenwohnheim",
    "Sporthalle",
    "Studentenwohnheim",
    "Tiefgarage",
    "Verkaufsfläche",
    "Verwaltungsgebäude",
    "Werkstatt",
    "Wohnanlage",
];

const EXTERIOR_PROJECT_WORK: &[&str] = &[
    "Außenputzarbeiten",
    "Energetische Sanierung",
    "Fassadensanierung",
    "Sockelsanierung",
    "Wärmedämmverbundsystem",
];

const EXTERIOR_PROJECT_OBJECTS: &[&str] = &[
    "Bürogebäude",
    "Einkaufsmarkt",
    "Hotel",
    "Kindertagesstätte",
    "Mehrfamilienhaus",
    "Pflegezentrum",
    "Produktionshalle",
    "Reihenhausanlage",
    "Schulgebäude",
    "Seniorenwohnheim",
    "Sporthalle",
    "Verwaltungsgebäude",
    "Wohnanlage",
];

const INTERIOR_PROJECT_WORK: &[&str] = &[
    "Akustikdecken",
    "Deckensanierung",
    "Schallschutzausbau",
    "Trockenbauausbau",
];

const INTERIOR_PROJECT_OBJECTS: &[&str] = &[
    "Arztpraxis",
    "Bankfiliale",
    "Berufsschule",
    "Büroetage",
    "Gastronomiefläche",
    "Gemeindehaus",
    "Hotel",
    "Kindertagesstätte",
    "Kulturzentrum",
    "Pflegebereich",
    "Praxiszentrum",
    "Produktionshalle",
    "Schulgebäude",
    "Sporthalle",
    "Verkaufsraum",
    "Verwaltungsgebäude",
];

const PROJECT_SECTIONS: &[&str] = &[
    "Erdgeschoss",
    "1. Obergeschoss",
    "2. Obergeschoss",
    "Dachgeschoss",
    "Nordflügel",
    "Südflügel",
    "Bauteil A",
    "Bauteil B",
    "Bauabschnitt II",
];

const TOOL_BRANDS: &[&str] = &[
    "Bosch Professional",
    "DeWalt",
    "Festool",
    "Fein",
    "Hilti",
    "Kärcher",
    "Makita",
    "Metabo",
    "Milwaukee",
    "Mirka",
    "Protool",
    "Starmix",
];

const TOOL_CATEGORIES: &[&str] = &[
    "Akkuschrauber",
    "Bohrhammer",
    "Baustellensauger",
    "Exzenterschleifer",
    "Handkreissäge",
    "Kappsäge",
    "Laser-Entfernungsmesser",
    "LED-Baustrahler",
    "Magazinschrauber",
    "Rührwerk",
    "Stichsäge",
    "Trockenbauschleifer",
    "Winkelschleifer",
    "Nagler",
    "Heißluftgebläse",
    "Kompressor",
];

const TRANSFER_NOTES: &[&str] = &[
    "Übergabe nach Feierabend im Lager.",
    "Gerät wird morgen auf der Baustelle benötigt.",
    "Bitte Akku und Ladegerät mit übergeben.",
    "Wechsel zur Kolonne Innenausbau abgestimmt.",
    "Übergabe wurde wegen laufender Reparatur abgelehnt.",
];

const INVENTORY_NOTES: &[&str] = &[
    "Vollständig mit Koffer und Ladegerät geprüft.",
    "Kabel und Gehäuse ohne sichtbare Schäden.",
    "Verschleißteile bei nächster Wartung tauschen.",
    "Inventaraufkleber erneuert.",
    "Gerät zur Elektroprüfung vorgemerkt.",
    "Zubehör laut Bestandsliste vollständig.",
];

const DEPLOYMENT_NOTES: &[&str] = &[
    "Fensterlaibungen vorbereiten und grundieren.",
    "Trockenbauwände stellen, einseitig beplanken.",
    "Spachtelarbeiten Q3 im zweiten Obergeschoss.",
    "Materialanlieferung annehmen, anschließend Deckenmontage.",
    "Restarbeiten und gemeinsame Abnahme mit der Bauleitung.",
    "Fassadenfläche abkleben und Oberputz aufziehen.",
    "Brandschutzbekleidung nach Detailplan herstellen.",
    "Sockelbereiche ausbessern und Schlussbeschichtung auftragen.",
];

const VACATION_NOTES: &[&str] = &[
    "Jahresurlaub",
    "Familienurlaub",
    "Brückentage",
    "Kurzurlaub",
    "Resturlaub aus dem Vorjahr",
    "Bereits mit der Kolonne abgestimmt",
];

const DENIAL_REASONS: &[&str] = &[
    "Zu viele Überschneidungen im beantragten Zeitraum.",
    "Für die Bauabnahme wird die Anwesenheit benötigt.",
    "Bitte einen alternativen Zeitraum mit der Teamleitung abstimmen.",
];

const UNAVAILABILITY_REASONS: &[&str] = &[
    "Bauherrenseitige Sperrung",
    "Trocknungszeit",
    "Fehlende Vorleistung",
    "Betriebsruhe",
    "Gerüstumbau",
    "Materialfreigabe ausstehend",
];

const UNAVAILABILITY_NOTES: &[&str] = &[
    "Zugang zur Etage ist in diesem Zeitraum nicht möglich.",
    "Arbeiten können nach Freigabe durch die Bauleitung fortgesetzt werden.",
    "Keine staubintensiven Arbeiten während des laufenden Betriebs.",
    "Folgetermin ist bereits mit allen Gewerken abgestimmt.",
];

const PRODUCT_CATALOG: &[ProductTemplate] = &[
    ProductTemplate {
        name: "MP 75 Gips-Maschinenputz",
        brand: "Knauf",
        description: "Einlagiger Maschinenputz für Innenwände und Decken.",
        base_unit: "kg",
        category: "Gipsputz",
        secondary_category: Some("Gips"),
    },
    ProductTemplate {
        name: "Rotband Haftputzgips",
        brand: "Knauf",
        description: "Haftputz für glatte und saugende Untergründe im Innenbereich.",
        base_unit: "kg",
        category: "Gipsputz",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Uniflott Fugenspachtel",
        brand: "Knauf",
        description: "Fugenspachtel für Gipsplatten mit hoher Risssicherheit.",
        base_unit: "kg",
        category: "Spachtelmasse",
        secondary_category: Some("Trockenbau"),
    },
    ProductTemplate {
        name: "ProMix Finish",
        brand: "Rigips",
        description: "Verarbeitungsfertige Feinspachtelmasse für Q3- und Q4-Oberflächen.",
        base_unit: "kg",
        category: "Spachtelmasse",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Haftgrund",
        brand: "Sto",
        description: "Pigmentierte Grundierung für mineralische und organische Untergründe.",
        base_unit: "l",
        category: "Grundierung",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Silikat-Innenfarbe",
        brand: "KEIM",
        description: "Diffusionsoffene Innenfarbe für mineralische Untergründe.",
        base_unit: "l",
        category: "Innenfarbe",
        secondary_category: Some("Silikatfarbe"),
    },
    ProductTemplate {
        name: "Dispersionsfarbe Premiumweiß",
        brand: "Caparol",
        description: "Hochdeckende, matte Innenfarbe für stark beanspruchte Flächen.",
        base_unit: "l",
        category: "Innenfarbe",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Silikonharz-Fassadenfarbe",
        brand: "Sto",
        description: "Wasserabweisende Fassadenbeschichtung mit hoher Farbtonstabilität.",
        base_unit: "l",
        category: "Fassadenfarbe",
        secondary_category: None,
    },
    ProductTemplate {
        name: "GKB Bauplatte 12,5 mm",
        brand: "Rigips",
        description: "Standard-Gipskartonplatte für Wand- und Deckenkonstruktionen.",
        base_unit: "m²",
        category: "GKB",
        secondary_category: Some("Trockenbauplatten"),
    },
    ProductTemplate {
        name: "GKFI Feuerschutzplatte 12,5 mm",
        brand: "Knauf",
        description: "Imprägnierte Feuerschutzplatte für Feucht- und Brandschutzbereiche.",
        base_unit: "m²",
        category: "GKF",
        secondary_category: Some("Trockenbauplatten"),
    },
    ProductTemplate {
        name: "Diamant Hartgipsplatte 12,5 mm",
        brand: "Knauf",
        description: "Hochfeste Platte für robuste und schallschutzoptimierte Konstruktionen.",
        base_unit: "m²",
        category: "Trockenbauplatten",
        secondary_category: Some("Schallschutz"),
    },
    ProductTemplate {
        name: "Gipsfaserplatte 12,5 mm",
        brand: "Fermacell",
        description: "Homogene Gipsfaserplatte für Wände, Decken und Dachschrägen.",
        base_unit: "m²",
        category: "Gipsfaserplatte",
        secondary_category: Some("Trockenbauplatten"),
    },
    ProductTemplate {
        name: "Akustikplatte Cleaneo",
        brand: "Knauf",
        description: "Gelochte Gipsplatte für schallabsorbierende Deckensysteme.",
        base_unit: "m²",
        category: "Akustikplatte",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Steinwolle Trennwandplatte 040",
        brand: "Rockwool",
        description: "Nichtbrennbare Dämmplatte für Metallständerwände.",
        base_unit: "m²",
        category: "Mineralwolle",
        secondary_category: Some("Dämmplatte"),
    },
    ProductTemplate {
        name: "Klemmfilz Integra ZKF 1-032",
        brand: "ISOVER",
        description: "Wärme- und Schalldämmung für Dach und Holzrahmenbau.",
        base_unit: "m²",
        category: "Mineralwolle",
        secondary_category: Some("Dämmplatte"),
    },
    ProductTemplate {
        name: "CW-Ständerprofil 75",
        brand: "Protektor",
        description: "Verzinktes Metallprofil für nichttragende Trennwände.",
        base_unit: "Lfm",
        category: "CW-Profil",
        secondary_category: Some("Stahlprofil"),
    },
    ProductTemplate {
        name: "UW-Rahmenprofil 75",
        brand: "Protektor",
        description: "Verzinktes Anschlussprofil für Metallständerwände.",
        base_unit: "Lfm",
        category: "UW-Profil",
        secondary_category: Some("Stahlprofil"),
    },
    ProductTemplate {
        name: "CD-Deckenprofil 60/27",
        brand: "Knauf",
        description: "Tragprofil für abgehängte Decken und Vorsatzschalen.",
        base_unit: "Lfm",
        category: "CD-Profil",
        secondary_category: Some("Stahlprofil"),
    },
    ProductTemplate {
        name: "UD-Randprofil 28",
        brand: "Knauf",
        description: "Randanschlussprofil für Deckenunterkonstruktionen.",
        base_unit: "Lfm",
        category: "UD-Profil",
        secondary_category: Some("Stahlprofil"),
    },
    ProductTemplate {
        name: "Trennwandkitt",
        brand: "Rigips",
        description: "Dauerelastische Dichtungsmasse für Anschlussprofile.",
        base_unit: "l",
        category: "Dichtstoff",
        secondary_category: Some("Trockenbau"),
    },
    ProductTemplate {
        name: "Glasfaser-Fugendeckstreifen",
        brand: "Knauf",
        description: "Bewehrungsstreifen für verspachtelte Plattenfugen.",
        base_unit: "Rolle",
        category: "Fugenband",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Papierfugendeckstreifen",
        brand: "Rigips",
        description: "Dimensionsstabiler Bewehrungsstreifen für Innen- und Außenecken.",
        base_unit: "Rolle",
        category: "Fugenband",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Maler-Abdeckvlies",
        brand: "Storch",
        description: "Saugfähiges, rutschhemmendes Schutzvlies für Bodenflächen.",
        base_unit: "Rolle",
        category: "Abdeckmaterial",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Goldband Fertigputzgips",
        brand: "Knauf",
        description: "Handputz für Mauerwerk und Beton im Innenbereich.",
        base_unit: "kg",
        category: "Gipsputz",
        secondary_category: Some("Gips"),
    },
    ProductTemplate {
        name: "Kalk-Zement-Leichtputz",
        brand: "Baumit",
        description: "Mineralischer Unterputz für innen und außen.",
        base_unit: "kg",
        category: "Kalkzementputz",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Armierungsmörtel",
        brand: "Sto",
        description: "Mineralischer Klebe- und Armierungsmörtel für Fassadensysteme.",
        base_unit: "kg",
        category: "Armierung",
        secondary_category: Some("Fassade"),
    },
    ProductTemplate {
        name: "Tiefengrund LF",
        brand: "Caparol",
        description: "Lösemittelfreie Grundierung zur Egalisierung saugender Untergründe.",
        base_unit: "l",
        category: "Grundierung",
        secondary_category: None,
    },
    ProductTemplate {
        name: "Schnellbauschraube TN 25",
        brand: "Knauf",
        description: "Phosphatierte Schraube für Gipsplatten auf Metallunterkonstruktion.",
        base_unit: "Stk",
        category: "Montageschraube",
        secondary_category: Some("Trockenbau"),
    },
    ProductTemplate {
        name: "Schnellbauschraube TN 35",
        brand: "Knauf",
        description: "Phosphatierte Schraube für mehrlagige Gipsplattenbekleidungen.",
        base_unit: "Stk",
        category: "Montageschraube",
        secondary_category: Some("Trockenbau"),
    },
    ProductTemplate {
        name: "Direktabhänger 125 mm",
        brand: "Protektor",
        description: "Abhänger für direkt befestigte Deckenunterkonstruktionen.",
        base_unit: "Stk",
        category: "Deckenabhänger",
        secondary_category: Some("Trockenbau"),
    },
];

const VENDORS: &[VendorTemplate] = &[
    VendorTemplate {
        name: "BAUSTOFF UNION Nürnberg",
        description: "Vollsortiment für Rohbau, Ausbau und Fassade.",
    },
    VendorTemplate {
        name: "B + M Baustoff + Metall Nürnberg",
        description: "Fachhandel für Trockenbau, Dämmung und Bauelemente.",
    },
    VendorTemplate {
        name: "WEGO Systembaustoffe Nürnberg",
        description: "Ausbausysteme mit täglicher Baustellenbelieferung.",
    },
    VendorTemplate {
        name: "Raab Karcher Nürnberg",
        description: "Baustoffhandel mit Abholmarkt und Kranlogistik.",
    },
    VendorTemplate {
        name: "Würth Nürnberg-Höfen",
        description: "Befestigungstechnik, Werkzeuge und Verbrauchsmaterial.",
    },
    VendorTemplate {
        name: "Würth Nürnberg-Mögeldorf",
        description: "Niederlassung für Montage- und Baustellenbedarf.",
    },
    VendorTemplate {
        name: "MEGA eG Nürnberg",
        description: "Farben, Bodenbeläge und Zubehör für das Malerhandwerk.",
    },
    VendorTemplate {
        name: "GIMA Gipser- und Malerbedarf",
        description: "Fachgroßhandel für Putz-, Stuck- und Malerbedarf.",
    },
    VendorTemplate {
        name: "Merkel Baustoffe",
        description: "Regionaler Baustoffhandel mit eigenem Fuhrpark.",
    },
    VendorTemplate {
        name: "Städtler Baustoffhandel",
        description: "Baustoffe und Werkzeuge für Ausbaugewerke.",
    },
    VendorTemplate {
        name: "BayWa Baustoffe Fürth",
        description: "Baustoffzentrum für gewerbliche Kunden.",
    },
    VendorTemplate {
        name: "Kemmler Trockenbau-Fachhandel",
        description: "Spezialist für Platten, Profile und Dämmstoffe.",
    },
    VendorTemplate {
        name: "Farben Schmid Nürnberg",
        description: "Farbenfachhandel mit Mischservice.",
    },
    VendorTemplate {
        name: "Bauzentrum Gebhardt",
        description: "Baustoffe, Bauelemente und Baustellenlogistik.",
    },
];

const PRICE_NOTES: &[&str] = &[
    "Preis laut Auftragsbestätigung.",
    "Rahmenvertragspreis inklusive Baustellenanlieferung.",
    "Vergleichsangebot für die nächste Bestellung.",
    "Aktualisiert nach Lieferantenmitteilung.",
];

const DELIVERY_NOTE_COMMENTS: &[&str] = &[
    "Anlieferung vollständig und ohne sichtbare Schäden.",
    "Material im Erdgeschoss trocken eingelagert.",
    "Teillieferung; Restmenge ist für Freitag angekündigt.",
    "Lieferung durch Polier geprüft und übernommen.",
    "Paletten im Innenhof abgestellt; Rückgabe vormerken.",
    "Direktanlieferung in das zweite Obergeschoss.",
];

const DELIVERY_RECORD_COMMENTS: &[&str] = &[
    "Menge laut Lieferschein geprüft.",
    "Für Bauabschnitt Nord vorgesehen.",
    "Trocken und frostfrei lagern.",
    "Gebinde unbeschädigt übernommen.",
];

const SPECIAL_DELIVERY_RECORDS: &[SpecialDeliveryRecord] = &[
    SpecialDeliveryRecord {
        name: "Kranentladung",
        unit: "Std",
        price: 92.5,
        comment: "Entladung direkt am Baukörper.",
    },
    SpecialDeliveryRecord {
        name: "Europaletten-Pfand",
        unit: "Stk",
        price: 18.0,
        comment: "Rückgabe nach Abschluss des Bauabschnitts.",
    },
    SpecialDeliveryRecord {
        name: "Mindermengenzuschlag",
        unit: "Stk",
        price: 35.0,
        comment: "Zuschlag laut Auftragsbestätigung.",
    },
    SpecialDeliveryRecord {
        name: "Baustellenanfahrt",
        unit: "Stk",
        price: 48.0,
        comment: "Lieferung innerhalb des Stadtgebiets.",
    },
];

const WEATHER: &[WeatherTemplate] = &[
    WeatherTemplate {
        summary: "sonnig",
        temperature: 18.0,
    },
    WeatherTemplate {
        summary: "bewölkt",
        temperature: 14.0,
    },
    WeatherTemplate {
        summary: "leichter Regen",
        temperature: 11.0,
    },
    WeatherTemplate {
        summary: "trocken und windig",
        temperature: 13.0,
    },
    WeatherTemplate {
        summary: "wechselhaft",
        temperature: 15.0,
    },
];

const DAILY_REPORT_SUMMARIES: &[&str] = &[
    "Untergrund geprüft, lose Altbeschichtung entfernt und Wandflächen grundiert.",
    "Metallständerwände gestellt, Türöffnungen verstärkt und Installationsbereiche abgestimmt.",
    "Gipskartonflächen geschlossen und Fugen für die erste Spachtellage vorbereitet.",
    "Fenster und Bodenflächen abgeklebt; Decken und Wände mit erster Lage beschichtet.",
    "Dämmung eingebaut und Anschlüsse gemäß Brandschutzdetail dokumentiert.",
    "Spachtelarbeiten Q3 ausgeführt, geschliffen und für die Abnahme ausgeleuchtet.",
    "Fassadensockel gereinigt, Schadstellen ausgebessert und Armierungsgewebe eingebettet.",
    "Restarbeiten aus der Vorabnahme erledigt und Arbeitsbereich besenrein übergeben.",
];

const REGIE_REPORT_SUMMARIES: &[&str] = &[
    "Bauseitige Klebebänder entfernt, Fensteranschlüsse gereinigt und Anputzleisten montiert.",
    "Zusätzliche Installationsöffnungen hergestellt und nach Leitungsverlegung fachgerecht geschlossen.",
    "Beschädigte Putzflächen außerhalb des Leistungsverzeichnisses abgeschlagen und neu aufgebaut.",
    "Möbel und Türzargen für Fremdgewerke geschützt; Abdeckungen anschließend wieder entfernt.",
    "Wartezeit wegen fehlender Freigabe sowie notwendige Umräumarbeiten auf Weisung der Bauleitung.",
    "Nachträgliche Brandschutzbekleidung an den Deckendurchführungen gemäß Detailplan ausgeführt.",
];

const FINANCIAL_NOTES: &[&str] = &[
    "Angebot gemäß Leistungsverzeichnis und aktuellem Planstand.",
    "Abschlagsrechnung nach gemeinsam festgestelltem Leistungsstand.",
    "Nachtrag für zusätzliche Untergrundvorbereitung.",
    "Schlussrechnung einschließlich freigegebener Regiearbeiten.",
    "Budgetfortschreibung nach Mengenänderung.",
];

const REMARKS: &[&str] = &[
    "Anlieferungen bitte mindestens einen Werktag vorher bei der Bauleitung anmelden.",
    "Schlüssel für den Seiteneingang liegt im Baustellenbüro.",
    "Vor Einsatz erneut auf Vollständigkeit des Zubehörs prüfen.",
    "Abstimmung bevorzugt vormittags; Ansprechpartner ist häufig auf Außenterminen.",
    "Farbmuster wurde freigegeben und befindet sich im Projektordner.",
    "Zufahrt für Fahrzeuge über 7,5 t nur über das Nordtor möglich.",
    "Bitte bei der nächsten Bestellung die vereinbarten Rahmenvertragspreise verwenden.",
    "Arbeitsbereich muss täglich zum Betriebsbeginn staubfrei übergeben werden.",
];

const DEVELOPMENT_VISITS: &[(&str, &str)] = &[
    ("/", "Dashboard"),
    ("/deployments", "Einsatzplanung"),
    ("/users/vacations", "Urlaubsplanung"),
    ("/tools", "Werkzeugverwaltung"),
    ("/tools/trackings", "Buchungshistorie"),
    ("/projects", "Projekte"),
];

const DEVELOPMENT_ACTIONS: &[(&str, &str, &str)] = &[
    ("projects.create", "Projekt anlegen", "/projects/new"),
    ("deployments.open", "Einsatzplanung öffnen", "/deployments"),
    (
        "delivery-notes.create",
        "Lieferschein erfassen",
        "/delivery-notes/new",
    ),
    ("tools.transfer", "Werkzeug übergeben", "/tools/trackings"),
];

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        CUSTOMERS, PLACES, PRODUCT_CATALOG, SeedRng, random_address_with_label,
        random_project_description, random_street,
    };

    #[test]
    fn randomized_seed_sequences_are_reproducible() {
        let mut left = SeedRng::new(42);
        let mut right = SeedRng::new(42);

        assert_eq!(left.next(), right.next());
        assert_eq!(left.range(100), right.range(100));
        assert_eq!(left.chance(1, 2), right.chance(1, 2));
    }

    #[test]
    fn addresses_keep_real_postcodes_and_cities_together() {
        let mut random = SeedRng::new(1234);

        for _ in 0..100 {
            let (address, city, street_address) = random_address_with_label(&mut random);
            let zip = address["zip"].as_str().unwrap();

            assert!(
                PLACES
                    .iter()
                    .any(|place| place.zip == zip && place.city == city)
            );
            assert!(street_address.chars().any(char::is_alphabetic));
        }
    }

    #[test]
    fn visible_catalog_names_are_descriptive_instead_of_numbered_placeholders() {
        assert!(
            CUSTOMERS
                .iter()
                .all(|customer| !customer.name.starts_with("Bauunternehmen "))
        );
        assert!(PRODUCT_CATALOG.iter().all(|product| {
            !product.name.starts_with("Produkt ")
                && !product
                    .description
                    .starts_with("Baumaterial für Anwendung ")
                && product.description.split_whitespace().count() >= 3
        }));
    }

    #[test]
    fn project_descriptions_are_built_from_many_plausible_combinations() {
        let mut random = SeedRng::new(9876);
        let descriptions = (0..500)
            .map(|_| random_project_description(&mut random))
            .collect::<HashSet<_>>();

        assert!(descriptions.len() >= 250);
    }

    #[test]
    fn street_names_offer_broad_combinatorial_variety() {
        let mut random = SeedRng::new(4567);
        let streets = (0..300)
            .map(|_| random_street(&mut random))
            .collect::<HashSet<_>>();

        assert!(streets.len() >= 75);
    }
}
