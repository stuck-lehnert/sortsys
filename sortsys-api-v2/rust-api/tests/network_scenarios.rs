//! End-to-end compatibility scenarios for the running Rust service.
//!
//! `scripts/test-api` starts PostgreSQL, MinIO, the API, and job runners before
//! executing this test. Local `cargo test` runs without that environment and
//! intentionally skips this network-only suite.

use std::{
    env,
    io::Read,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{Json, Router, extract::State, routing::post};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use bcrypt::hash;
use ciborium::value::Value as CborValue;
use flate2::read::GzDecoder;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use p256::{
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::rand_core::OsRng,
};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{
    net::TcpListener,
    sync::Mutex,
    time::{Duration, sleep},
};
use url::Url;

use sortsys_api::{ids::Id, migrations, seed};

static DATABASE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn network_suite_tracks_every_generated_contract_procedure() {
    let contract = include_str!("../src/contract_generated.rs");
    let suite = include_str!("network_scenarios.rs");
    let mut procedure_count = 0;

    for line in contract.lines() {
        let Some(path) = line
            .trim()
            .strip_prefix("path: \"")
            .and_then(|line| line.strip_suffix("\","))
        else {
            continue;
        };

        procedure_count += 1;

        let has_named_scenario = suite.contains(&format!("\"{path}\""));
        let has_batched_ping_scenario = path == "ping" && suite.contains("/ping,ping");

        assert!(
            has_named_scenario || has_batched_ping_scenario,
            "generated procedure {path} has no named network scenario",
        );
    }

    assert_eq!(procedure_count, 199, "unexpected generated contract size");
}

#[tokio::test]
async fn core_legacy_scenarios_work_over_the_batched_wire_protocol() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: PG_MASTER_DSN is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);

    rpc.assert_batching().await;

    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"]
        .as_str()
        .expect("login response must contain a token")
        .to_owned();

    assert_eq!(
        rpc.query("auth.sessionInfo", Value::Null, Some(&token))
            .await["user"]["username"],
        fixture.admin_username,
    );

    settings_scenarios(&rpc, &token).await;
    let user_id = user_scenarios(&rpc, &token).await;
    let customer_id = customer_scenarios(&rpc, &token).await;
    let contact_id = contact_scenarios(&rpc, &token).await;
    let project_id = project_scenarios(&rpc, &token, &customer_id, &contact_id).await;
    product_scenarios(&rpc, &token).await;
    tool_scenarios(&rpc, &token, &user_id, &project_id).await;
    regie_report_timezone_scenario(&rpc, &token, &user_id, &project_id).await;
    script_and_remark_scenarios(&rpc, &token, &project_id).await;

    rpc.mutation("auth.logout", Value::Null, Some(&token)).await;
    rpc.expect_error(
        "auth.check",
        Method::GET,
        Value::Null,
        Some(&token),
        "UNAUTHORIZED",
    )
    .await;
}

#[tokio::test]
async fn randomized_legacy_seed_uses_real_postgres_and_remains_login_capable() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: PG_MASTER_DSN is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let replay_seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    eprintln!("randomized fixture replay seed: {replay_seed}");

    let summary = seed::seed_randomized_data(&fixture.tenant_pool, replay_seed)
        .await
        .unwrap();
    seed::ensure_development_users(&fixture.tenant_pool)
        .await
        .unwrap();

    assert!((50..=54).contains(&summary.users));
    assert!((50..=79).contains(&summary.projects));
    assert!((50..=79).contains(&summary.tools));
    assert!((50..=59).contains(&summary.products));
    assert!((25..=34).contains(&summary.delivery_notes));
    assert!((80..=99).contains(&summary.deployments));
    assert!((24..=35).contains(&summary.vacations));
    assert!((10..=15).contains(&summary.unavailability_periods));
    assert!((60..=89).contains(&summary.financial_entries));
    assert!((40..=59).contains(&summary.remarks));

    let counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64)>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM projects),
            (SELECT COUNT(*) FROM tools),
            (SELECT COUNT(*) FROM products),
            (SELECT COUNT(*) FROM product_delivery_notes),
            (SELECT COUNT(*) FROM daily_project_reports),
            (SELECT COUNT(*) FROM regie_reports),
            (SELECT COUNT(*) FROM project_deployments),
            (SELECT COUNT(*) FROM user_vacations),
            (SELECT COUNT(*) FROM project_unavailability_periods),
            (SELECT COUNT(*) FROM project_financial_entries),
            (SELECT COUNT(*) FROM resource_notes)
        "#,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(counts.0, summary.projects as i64);
    assert_eq!(counts.1, summary.tools as i64);
    assert_eq!(counts.2, summary.products as i64);
    assert_eq!(counts.3, summary.delivery_notes as i64);
    assert_eq!(counts.4, summary.daily_reports as i64);
    assert_eq!(counts.5, summary.regie_reports as i64);
    assert_eq!(counts.6, summary.deployments as i64 + 1);
    assert_eq!(counts.7, summary.vacations as i64 + 1);
    assert_eq!(counts.8, summary.unavailability_periods as i64);
    assert_eq!(counts.9, summary.financial_entries as i64);
    assert_eq!(counts.10, summary.remarks as i64);

    let poor_placeholder_rows = sqlx::query_as::<_, (i64, i64)>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM customers WHERE name LIKE 'Bauunternehmen %'),
            (SELECT COUNT(*) FROM products WHERE description LIKE 'Baumaterial für Anwendung %')
        "#,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(poor_placeholder_rows, (0, 0));

    let project_variety = sqlx::query_as::<_, (i64, i64)>(
        r#"
        SELECT
            COUNT(DISTINCT SPLIT_PART(title, ' – ', 1)),
            COUNT(DISTINCT REGEXP_REPLACE(address->>'streetAddress', ' [0-9]+$', ''))
        FROM projects
        "#,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert!(
        project_variety.0 >= summary.projects as i64 * 3 / 4,
        "expected varied project work and building combinations"
    );
    assert!(
        project_variety.1 >= summary.projects as i64 / 2,
        "expected varied generated street names"
    );

    let planning_rows = sqlx::query_as::<_, (i64, i64, i64)>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM project_deployments WHERE "to" > NOW()),
            (SELECT COUNT(*) FROM user_vacations WHERE status = 'requested' AND "to" >= CURRENT_DATE),
            (SELECT COUNT(*) FROM project_unavailability_periods WHERE "to" >= CURRENT_DATE)
        "#,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert!(
        planning_rows.0 > 20,
        "expected useful upcoming deployment data"
    );
    assert!(planning_rows.1 > 0, "expected pending vacation requests");
    assert!(
        planning_rows.2 > 0,
        "expected current or future project blocks"
    );

    let rpc = RpcClient::new(environment.api_base_url);
    let john_login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": "john.doe",
                "password": "123456",
            }),
            None,
        )
        .await;
    let john_token = john_login["token"].as_str().unwrap();
    let john_session = rpc
        .query("auth.sessionInfo", Value::Null, Some(john_token))
        .await;
    assert_eq!(john_session["user"]["firstName"], "John");
    assert!(
        john_session["roles"]
            .as_array()
            .unwrap()
            .contains(&json!(":admin"))
    );

    let frank_login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": "frank.doe",
                "password": "123456",
            }),
            None,
        )
        .await;
    let frank_token = frank_login["token"].as_str().unwrap();
    let frank_session = rpc
        .query("auth.sessionInfo", Value::Null, Some(frank_token))
        .await;
    assert_eq!(frank_session["user"]["firstName"], "Frank");
    assert!(frank_session["roles"].as_array().unwrap().is_empty());

    assert_eq!(
        rpc.query("products.list", json!({}), Some(john_token))
            .await
            .as_array()
            .unwrap()
            .len(),
        summary.products,
    );
    assert_eq!(
        rpc.query("deliveryNotes.list", json!({}), Some(john_token))
            .await
            .as_array()
            .unwrap()
            .len(),
        summary.delivery_notes,
    );
    assert_eq!(
        rpc.query(
            "regieReports.list",
            json!({ "limit": 100 }),
            Some(john_token)
        )
        .await
        .as_array()
        .unwrap()
        .len(),
        summary.regie_reports,
    );
}

#[tokio::test]
async fn project_files_and_tenant_logo_use_real_postgres_and_s3() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap().to_owned();

    let project = rpc
        .mutation(
            "projects.create",
            json!({ "title": "Real S3 integration project" }),
            Some(&token),
        )
        .await;
    let project_id = project["id"].as_str().unwrap();
    let fetched_project = rpc
        .query("projects.get", json!({ "id": project_id }), Some(&token))
        .await;
    assert_eq!(fetched_project["title"], "Real S3 integration project");
    rpc.mutation(
        "projects.update",
        json!({ "id": project_id, "data": { "title": "Updated project lifecycle integration" } }),
        Some(&token),
    )
    .await;

    let file_bytes = include_bytes!("../../test-files/thispersondoesnotexist01.jpg");
    let created_file = rpc
        .mutation(
            "projects.files.createUpload",
            json!({
                "projectId": project_id,
                "fileName": "integration.jpg",
                "mimeType": "image/jpeg",
                "sizeBytes": file_bytes.len(),
            }),
            Some(&token),
        )
        .await;

    let upload_response = rpc
        .http
        .put(created_file["uploadUrl"].as_str().unwrap())
        .header("Content-Type", "image/jpeg")
        .body(file_bytes.as_slice())
        .send()
        .await
        .unwrap();
    assert!(upload_response.status().is_success());
    let file_etag = upload_response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    rpc.mutation(
        "projects.files.completeUpload",
        json!({
            "projectId": project_id,
            "fileId": created_file["fileId"],
            "etag": file_etag,
        }),
        Some(&token),
    )
    .await;

    let file_id = sortsys_api::ids::Id::decode(created_file["fileId"].as_str().unwrap())
        .unwrap()
        .0;
    let stored_file = sqlx::query_as::<_, (String, Option<i64>)>(
        "SELECT status, size_bytes FROM project_files WHERE id = $1",
    )
    .bind(file_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(stored_file.0, "uploaded");
    assert_eq!(stored_file.1, Some(file_bytes.len() as i64));

    let listed_files = rpc
        .query(
            "projects.files.list",
            json!({ "projectId": project_id }),
            Some(&token),
        )
        .await;
    let listed_file = listed_files
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["id"] == created_file["fileId"])
        .expect("uploaded file must be returned from PostgreSQL");
    let downloaded_file = rpc
        .http
        .get(listed_file["downloadUrl"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert!(downloaded_file.status().is_success());
    assert_eq!(downloaded_file.bytes().await.unwrap().as_ref(), file_bytes);

    // The editor session is exercised without a Document Server process here:
    // its signed source request and save callbacks still traverse the real API,
    // PostgreSQL, and MinIO paths used in production.
    let document_bytes = include_bytes!("../../test-files/blank.pdf");
    let created_document = rpc
        .mutation(
            "projects.files.createUpload",
            json!({
                "projectId": project_id,
                "fileName": "Baustellenbericht.pdf",
                "mimeType": "application/pdf",
                "sizeBytes": document_bytes.len(),
            }),
            Some(&token),
        )
        .await;
    let document_upload = rpc
        .http
        .put(created_document["uploadUrl"].as_str().unwrap())
        .header("Content-Type", "application/pdf")
        .body(document_bytes.as_slice())
        .send()
        .await
        .unwrap();
    assert!(document_upload.status().is_success());
    let document_etag = document_upload
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    rpc.mutation(
        "projects.files.completeUpload",
        json!({
            "projectId": project_id,
            "fileId": created_document["fileId"],
            "etag": document_etag,
        }),
        Some(&token),
    )
    .await;

    let office_config = rpc
        .query(
            "projects.files.officeConfig",
            json!({
                "projectId": project_id,
                "fileId": created_document["fileId"],
            }),
            Some(&token),
        )
        .await;
    assert_eq!(office_config["canEdit"], true);
    assert_eq!(office_config["config"]["documentType"], "pdf");
    assert_eq!(office_config["config"]["document"]["fileType"], "pdf");
    assert!(office_config["config"]["token"].is_string());
    assert_eq!(
        office_config["config"]["editorConfig"]["customization"]["autosave"],
        true
    );
    assert_eq!(
        office_config["config"]["editorConfig"]["customization"]["forcesave"],
        false
    );

    let onlyoffice_secret = env::var("ONLYOFFICE_JWT_SECRET").unwrap();
    let source_url = office_config["config"]["document"]["url"].as_str().unwrap();
    let source_request_token = encode(
        &Header::new(Algorithm::HS256),
        &json!({ "payload": { "url": source_url } }),
        &EncodingKey::from_secret(onlyoffice_secret.as_bytes()),
    )
    .unwrap();
    let office_source = rpc
        .http
        .get(source_url)
        .bearer_auth(source_request_token)
        .send()
        .await
        .unwrap();
    assert!(office_source.status().is_success());
    assert_eq!(
        office_source.bytes().await.unwrap().as_ref(),
        document_bytes
    );

    let document_key = office_config["config"]["document"]["key"].as_str().unwrap();
    let callback_url = office_config["config"]["editorConfig"]["callbackUrl"]
        .as_str()
        .unwrap();
    let replacement_url = listed_file["downloadUrl"].as_str().unwrap();
    let force_save_payload = json!({
        "key": document_key,
        "status": 6,
        "url": replacement_url,
    });
    let force_save_token = encode(
        &Header::new(Algorithm::HS256),
        &json!({ "payload": force_save_payload }),
        &EncodingKey::from_secret(onlyoffice_secret.as_bytes()),
    )
    .unwrap();
    let force_save = rpc
        .http
        .post(callback_url)
        .bearer_auth(force_save_token)
        .json(&force_save_payload)
        .send()
        .await
        .unwrap();
    assert!(force_save.status().is_success());
    assert_eq!(force_save.json::<Value>().await.unwrap()["error"], 0);

    let document_file_id = Id::decode(created_document["fileId"].as_str().unwrap())
        .unwrap()
        .0;
    let saved_document = sqlx::query_as::<_, (i64, Option<i64>, Option<i64>)>(
        r#"
        SELECT office_version, size_bytes, office_modified_by_user_id
        FROM project_files
        WHERE id = $1
        "#,
    )
    .bind(document_file_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(saved_document.0, 1);
    assert_eq!(saved_document.1, Some(file_bytes.len() as i64));
    assert!(saved_document.2.is_some());

    let files_after_force_save = rpc
        .query(
            "projects.files.list",
            json!({ "projectId": project_id }),
            Some(&token),
        )
        .await;
    let saved_file = files_after_force_save
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["id"] == created_document["fileId"])
        .unwrap();
    let saved_bytes = rpc
        .http
        .get(saved_file["downloadUrl"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert!(saved_bytes.status().is_success());
    assert_eq!(saved_bytes.bytes().await.unwrap().as_ref(), file_bytes);

    let final_save_payload = json!({
        "key": document_key,
        "status": 2,
        "url": replacement_url,
    });
    let final_save_token = encode(
        &Header::new(Algorithm::HS256),
        &json!({ "payload": final_save_payload }),
        &EncodingKey::from_secret(onlyoffice_secret.as_bytes()),
    )
    .unwrap();
    let final_save = rpc
        .http
        .post(callback_url)
        .bearer_auth(final_save_token)
        .json(&final_save_payload)
        .send()
        .await
        .unwrap();
    assert!(final_save.status().is_success());
    assert_eq!(final_save.json::<Value>().await.unwrap()["error"], 0);

    let final_version: i64 =
        sqlx::query_scalar("SELECT office_version FROM project_files WHERE id = $1")
            .bind(document_file_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(final_version, 2);

    // Browser-generated workbooks use a temporary, user-owned S3 object. The
    // source request below exercises the signed handoff that Document Server
    // performs without requiring that large service in CI.
    let export_bytes = b"PK-sortsys-test-workbook";
    let created_export = rpc
        .mutation(
            "office.exports.createUpload",
            json!({
                "fileName": "Projektkosten.xlsx",
                "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "sizeBytes": export_bytes.len(),
            }),
            Some(&token),
        )
        .await;
    let export_upload = rpc
        .http
        .put(created_export["uploadUrl"].as_str().unwrap())
        .header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .body(export_bytes.as_slice())
        .send()
        .await
        .unwrap();
    assert!(export_upload.status().is_success());

    let export_config = rpc
        .query(
            "office.exports.officeConfig",
            json!({ "sessionToken": created_export["sessionToken"] }),
            Some(&token),
        )
        .await;
    assert_eq!(export_config["canEdit"], false);
    assert_eq!(export_config["config"]["documentType"], "cell");
    assert_eq!(export_config["config"]["document"]["fileType"], "xlsx");
    assert_eq!(export_config["config"]["editorConfig"]["mode"], "view");
    assert_eq!(
        export_config["config"]["document"]["permissions"]["edit"],
        false
    );
    assert_eq!(
        export_config["config"]["document"]["permissions"]["comment"],
        false
    );
    assert_eq!(
        export_config["config"]["document"]["permissions"]["download"],
        true
    );
    assert!(
        export_config["config"]["editorConfig"]
            .get("callbackUrl")
            .is_none()
    );

    let export_source_url = export_config["config"]["document"]["url"].as_str().unwrap();
    let export_source_token = encode(
        &Header::new(Algorithm::HS256),
        &json!({ "payload": { "url": export_source_url } }),
        &EncodingKey::from_secret(onlyoffice_secret.as_bytes()),
    )
    .unwrap();
    let export_source = rpc
        .http
        .get(export_source_url)
        .bearer_auth(&export_source_token)
        .send()
        .await
        .unwrap();
    assert!(export_source.status().is_success());
    assert_eq!(export_source.bytes().await.unwrap().as_ref(), export_bytes);

    let removed_export_callback = rpc
        .http
        .post(format!(
            "{}/internal/onlyoffice/export-callback",
            rpc.base_url
        ))
        .json(&json!({
            "key": export_config["config"]["document"]["key"],
            "status": 6,
            "url": replacement_url,
        }))
        .send()
        .await
        .unwrap();
    let removed_export_callback: Value = removed_export_callback.json().await.unwrap();
    assert_eq!(
        removed_export_callback["error"]["json"]["data"]["code"],
        "NOT_FOUND"
    );

    let photo_day = "2026-08-24T00:00:00.000+02:00";
    rpc.mutation(
        "projects.dailyReports.create",
        json!({ "projectId": project_id, "day": photo_day, "summary": "Photo relation test" }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "projects.dailyReports.photos.add",
        json!({ "projectId": project_id, "day": photo_day, "fileId": created_file["fileId"] }),
        Some(&token),
    )
    .await;
    let report_with_photo = rpc
        .query(
            "projects.dailyReports.get",
            json!({ "projectId": project_id, "day": photo_day }),
            Some(&token),
        )
        .await;
    assert_eq!(report_with_photo["photos"][0]["id"], created_file["fileId"]);
    rpc.mutation(
        "projects.dailyReports.photos.remove",
        json!({ "projectId": project_id, "day": photo_day, "fileId": created_file["fileId"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "projects.files.delete",
        json!({ "projectId": project_id, "fileId": created_document["fileId"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "projects.files.delete",
        json!({ "projectId": project_id, "fileId": created_file["fileId"] }),
        Some(&token),
    )
    .await;
    let deleted_file_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM project_files WHERE id = $1")
            .bind(file_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(deleted_file_count, 0);

    let logo_bytes = include_bytes!("../../test-files/thispersondoesnotexist01.jpg");
    let created_logo = rpc
        .mutation(
            "settings.tenantLogo.createUpload",
            json!({
                "fileName": "integration-logo.jpg",
                "mimeType": "image/jpeg",
                "sizeBytes": logo_bytes.len(),
            }),
            Some(&token),
        )
        .await;
    let logo_upload_response = rpc
        .http
        .put(created_logo["uploadUrl"].as_str().unwrap())
        .header("Content-Type", "image/jpeg")
        .body(logo_bytes.as_slice())
        .send()
        .await
        .unwrap();
    assert!(logo_upload_response.status().is_success());
    let logo_etag = logo_upload_response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    rpc.mutation(
        "settings.tenantLogo.completeUpload",
        json!({
            "generationId": created_logo["generationId"],
            "etag": logo_etag,
        }),
        Some(&token),
    )
    .await;

    let stored_logo = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT name FROM global_settings WHERE key = 'tenant_logo'",
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap()
    .0;
    let stored_logo: Value = serde_json::from_str(stored_logo.as_str().unwrap()).unwrap();
    assert_eq!(stored_logo["generationId"], created_logo["generationId"]);
    assert!(matches!(
        stored_logo["status"].as_str(),
        Some("queued" | "processing" | "ready")
    ));

    let master = PgPool::connect(&environment.master_dsn).await.unwrap();
    let logo_job_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM __jobs WHERE tenant_name = $1 AND type = 'tenant_logo_generate'",
    )
    .bind(&fixture.tenant)
    .fetch_one(&master)
    .await
    .unwrap();
    assert_eq!(logo_job_count, 1);

    let mut ready_logo = None;
    for _ in 0..40 {
        let current = rpc
            .query("settings.tenantLogo.get", Value::Null, Some(&token))
            .await;

        match current["status"].as_str() {
            Some("ready") => {
                ready_logo = Some(current);
                break;
            }
            Some("failed") => panic!("logo job failed: {}", current["error"]),
            _ => sleep(Duration::from_millis(250)).await,
        }
    }

    let ready_logo = ready_logo.expect("job runner did not produce the tenant logo in time");
    assert_eq!(ready_logo["mimeType"], "image/webp");
    assert!(ready_logo["width"].as_i64().unwrap() > 0);
    assert!(ready_logo["height"].as_i64().unwrap() > 0);

    let generated_logo = rpc
        .http
        .get(ready_logo["downloadUrl"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert!(generated_logo.status().is_success());
    let generated_logo = generated_logo.bytes().await.unwrap();
    assert!(generated_logo.len() > 12);
    assert_eq!(&generated_logo[0..4], b"RIFF");
    assert_eq!(&generated_logo[8..12], b"WEBP");

    // The session row proves this test used the public login endpoint rather
    // than constructing an authenticated request in-process.
    let session_user_id = sqlx::query_scalar::<_, i64>(
        "SELECT user_id FROM user_sessions ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(session_user_id, fixture.user_id);
}

#[tokio::test]
async fn users_roles_and_vacations_use_real_postgres() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let admin_login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let admin_token = admin_login["token"].as_str().unwrap().to_owned();

    let employee_password = "Employee-Password-123!";
    let employee_hash = hash(employee_password, 4).unwrap();
    let employee_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO users (
            username,
            first_name,
            password,
            contract_type,
            cost_per_hour,
            supervisor_user_id,
            deactivated_at
        )
        VALUES ('integration.employee', 'Integration Employee', $1, 'internal', 37.5, $2, NULL)
        RETURNING id
        "#,
    )
    .bind(employee_hash)
    .bind(fixture.user_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    let employee_id = sortsys_api::ids::Id(employee_id).encode();

    let employee_login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": "integration.employee",
                "password": employee_password,
            }),
            None,
        )
        .await;
    let employee_token = employee_login["token"].as_str().unwrap().to_owned();

    rpc.expect_error("users.list", Method::GET, json!({}), None, "UNAUTHORIZED")
        .await;
    rpc.expect_error(
        "users.list",
        Method::GET,
        json!({ "includeArchived": true }),
        Some(&employee_token),
        "FORBIDDEN",
    )
    .await;

    let employee_before_role = rpc
        .query(
            "users.get",
            json!({ "id": employee_id }),
            Some(&employee_token),
        )
        .await;
    assert!(employee_before_role["costPerHour"].is_null());

    rpc.mutation(
        "users.roles.set",
        json!({
            "userId": employee_id,
            "assignments": { "view:users": true },
        }),
        Some(&admin_token),
    )
    .await;
    let roles = rpc
        .query(
            "users.roles.get",
            json!({ "userId": employee_id }),
            Some(&admin_token),
        )
        .await;
    assert!(roles.as_array().unwrap().contains(&json!("view:users")));

    let employee_after_role = rpc
        .query(
            "users.get",
            json!({ "id": employee_id }),
            Some(&employee_token),
        )
        .await;
    assert_eq!(employee_after_role["costPerHour"], 37.5);

    let vacation = rpc
        .mutation(
            "users.vacations.create",
            json!({
                "from": "2026-09-14T00:00:00.000+02:00",
                "to": "2026-09-18T00:00:00.000+02:00",
                "note": "Database integration vacation",
            }),
            Some(&employee_token),
        )
        .await;
    assert_eq!(vacation["status"], "requested");

    rpc.expect_error(
        "users.vacations.approve",
        Method::POST,
        json!({ "id": vacation["id"] }),
        Some(&employee_token),
        "FORBIDDEN",
    )
    .await;
    rpc.mutation(
        "users.vacations.approve",
        json!({ "id": vacation["id"] }),
        Some(&admin_token),
    )
    .await;

    let vacation_status =
        sqlx::query_scalar::<_, String>("SELECT status FROM user_vacations WHERE id = $1")
            .bind(
                sortsys_api::ids::Id::decode(vacation["id"].as_str().unwrap())
                    .unwrap()
                    .0,
            )
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(vacation_status, "approved");

    let created_user = rpc
        .mutation(
            "users.create",
            json!({
                "username": "integration.lifecycle",
                "firstName": "Lifecycle",
                "contractType": "external",
                "costPerHour": 48,
            }),
            Some(&admin_token),
        )
        .await;
    rpc.mutation(
        "users.update",
        json!({
            "id": created_user["id"],
            "data": { "firstName": "Updated Lifecycle", "costPerHour": 52.5 },
        }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "users.deactivate",
        json!({ "id": created_user["id"] }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "users.activate",
        json!({ "id": created_user["id"] }),
        Some(&admin_token),
    )
    .await;
    rpc.expect_error(
        "users.archive",
        Method::POST,
        json!({ "id": created_user["id"] }),
        Some(&admin_token),
        "CONFLICT",
    )
    .await;
    rpc.mutation(
        "users.deactivate",
        json!({ "id": created_user["id"] }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "users.archive",
        json!({ "id": created_user["id"] }),
        Some(&admin_token),
    )
    .await;

    let lifecycle_row = sqlx::query_as::<_, (String, Option<f64>, bool, bool)>(
        r#"
        SELECT
            first_name,
            cost_per_hour,
            deactivated_at IS NULL,
            archived_at IS NOT NULL
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(
        sortsys_api::ids::Id::decode(created_user["id"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(lifecycle_row.0, "Updated Lifecycle");
    assert_eq!(lifecycle_row.1, Some(52.5));
    assert!(!lifecycle_row.2);
    assert!(lifecycle_row.3);

    rpc.mutation(
        "users.unarchive",
        json!({ "id": created_user["id"] }),
        Some(&admin_token),
    )
    .await;
    let archived_at = sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
        "SELECT archived_at FROM users WHERE id = $1",
    )
    .bind(
        sortsys_api::ids::Id::decode(created_user["id"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert!(archived_at.is_none());

    let available_roles = rpc
        .query("users.roles.list", Value::Null, Some(&admin_token))
        .await;
    assert!(
        available_roles
            .as_array()
            .unwrap()
            .contains(&json!(":admin"))
    );

    rpc.mutation(
        "users.supervisors.setDefault",
        json!({ "userId": sortsys_api::ids::Id(fixture.user_id).encode() }),
        Some(&admin_token),
    )
    .await;
    let default_supervisor = rpc
        .query(
            "users.supervisors.getDefault",
            Value::Null,
            Some(&admin_token),
        )
        .await;
    assert_eq!(
        default_supervisor["userId"],
        sortsys_api::ids::Id(fixture.user_id).encode()
    );

    let denied_vacation = rpc
        .mutation(
            "users.vacations.create",
            json!({
                "from": "2026-10-05T00:00:00.000+02:00",
                "to": "2026-10-06T00:00:00.000+02:00",
                "note": "Deny this request",
            }),
            Some(&employee_token),
        )
        .await;
    rpc.mutation(
        "users.vacations.deny",
        json!({ "id": denied_vacation["id"], "reason": "Coverage conflict" }),
        Some(&admin_token),
    )
    .await;
    let vacations = rpc
        .query(
            "users.vacations.list",
            json!({ "userId": employee_id, "includeDenied": true }),
            Some(&admin_token),
        )
        .await;
    assert!(
        vacations
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["id"] == denied_vacation["id"] && entry["status"] == "denied" })
    );
    rpc.mutation(
        "users.vacations.delete",
        json!({ "id": denied_vacation["id"] }),
        Some(&admin_token),
    )
    .await;

    rpc.mutation(
        "auth.setPassword",
        json!({
            "username": "integration.employee",
            "password": "Replacement-Password-123!",
        }),
        Some(&employee_token),
    )
    .await;
    let relogin = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": "integration.employee",
                "password": "Replacement-Password-123!",
            }),
            None,
        )
        .await;
    assert!(relogin["token"].as_str().is_some());

    let deletable_user = rpc
        .mutation(
            "users.create",
            json!({ "username": "integration.delete", "firstName": "Delete Me" }),
            Some(&admin_token),
        )
        .await;
    rpc.mutation(
        "users.delete",
        json!({ "id": deletable_user["id"] }),
        Some(&admin_token),
    )
    .await;
    let deleted_user_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE id = $1")
            .bind(
                sortsys_api::ids::Id::decode(deletable_user["id"].as_str().unwrap())
                    .unwrap()
                    .0,
            )
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(deleted_user_count, 0);
}

#[tokio::test]
async fn products_delivery_notes_and_project_costs_use_real_postgres() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap().to_owned();

    rpc.expect_error(
        "products.create",
        Method::POST,
        json!({ "customId": 9101, "name": "Forbidden", "baseUnit": "Stk" }),
        None,
        "UNAUTHORIZED",
    )
    .await;

    let project = rpc
        .mutation(
            "projects.create",
            json!({ "title": "Delivery cost integration" }),
            Some(&token),
        )
        .await;
    let product = rpc
        .mutation(
            "products.create",
            json!({
                "customId": 9101,
                "name": "Integration mortar",
                "baseUnit": "kg",
                "brand": "Ferris",
                "otherUnits": { "Sack": 25 },
            }),
            Some(&token),
        )
        .await;
    rpc.mutation(
        "products.categories.set",
        json!({
            "id": product["id"],
            "categories": ["Baustoff", "Integration"],
        }),
        Some(&token),
    )
    .await;

    let vendor = rpc
        .mutation(
            "products.vendors.create",
            json!({
                "name": "Integration Vendor",
                "description": "Stored in PostgreSQL",
            }),
            Some(&token),
        )
        .await;
    let price = rpc
        .mutation(
            "products.priceRecords.create",
            json!({
                "productId": product["id"],
                "vendorId": vendor["id"],
                "pricePerBaseUnit": 12.5,
                "timestamp": "2026-01-01T10:00:00.000Z",
                "isRealPurchase": true,
                "comment": "Integration price",
            }),
            Some(&token),
        )
        .await;

    let delivery_note = rpc
        .mutation(
            "deliveryNotes.create",
            json!({
                "projectId": project["id"],
                "effectiveTimestamp": "2026-02-01T10:00:00.000Z",
                "comment": "Integration delivery",
                "records": [{
                    "productId": product["id"],
                    "quantity": 3,
                    "unit": "kg",
                    "comment": "Three kilograms",
                }],
                "specialRecords": [{
                    "name": "Freight",
                    "unit": "Stk",
                    "amount": 2,
                    "pricePerUnit": 4,
                    "comment": "Two freight units",
                }],
            }),
            Some(&token),
        )
        .await;

    let costs = rpc
        .query(
            "deliveryNotes.costs.get",
            json!({ "id": delivery_note["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(costs["totalCost"], 45.5);
    assert_eq!(costs["records"][0]["priceRecord"]["id"], price["id"]);

    let project_costs = rpc
        .query(
            "projects.costs.get",
            json!({ "projectId": project["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(project_costs["deliveryNotes"][0]["totalCost"], 45.5);

    let stored_counts = sqlx::query_as::<_, (i64, i64, i64, i64)>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM products WHERE id = $1),
            (SELECT COUNT(*) FROM product_vendors WHERE id = $2),
            (SELECT COUNT(*) FROM product_price_records WHERE id = $3),
            (SELECT COUNT(*) FROM product_delivery_notes WHERE id = $4)
        "#,
    )
    .bind(
        sortsys_api::ids::Id::decode(product["id"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .bind(
        sortsys_api::ids::Id::decode(vendor["id"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .bind(
        sortsys_api::ids::Id::decode(price["id"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .bind(
        sortsys_api::ids::Id::decode(delivery_note["id"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(stored_counts, (1, 1, 1, 1));

    rpc.mutation(
        "deliveryNotes.update",
        json!({
            "id": delivery_note["id"],
            "data": { "comment": "Updated integration delivery" },
        }),
        Some(&token),
    )
    .await;
    let updated_note = rpc
        .query(
            "deliveryNotes.get",
            json!({ "id": delivery_note["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(updated_note["comment"], "Updated integration delivery");

    let listed_products = rpc
        .query(
            "products.list",
            json!({ "search": "Integration mortar" }),
            Some(&token),
        )
        .await;
    assert!(
        listed_products
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == product["id"])
    );
    assert!(
        rpc.query("products.brands.list", Value::Null, Some(&token))
            .await
            .as_array()
            .unwrap()
            .contains(&json!("Ferris"))
    );
    assert!(
        rpc.query("products.categories.list", Value::Null, Some(&token))
            .await
            .as_array()
            .unwrap()
            .contains(&json!("Integration"))
    );
    assert!(
        rpc.query("products.units.list", Value::Null, Some(&token))
            .await
            .as_array()
            .unwrap()
            .contains(&json!("kg"))
    );
    assert!(
        rpc.query("products.suggestNextCustomId", Value::Null, Some(&token))
            .await
            .as_i64()
            .unwrap()
            > 9101
    );

    rpc.mutation(
        "products.update",
        json!({
            "id": product["id"],
            "data": { "name": "Updated integration mortar", "description": "Updated through HTTP" },
        }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "products.categories.untag",
        json!({ "id": product["id"], "category": "Integration" }),
        Some(&token),
    )
    .await;

    let vendor_before_update = rpc
        .query(
            "products.vendors.get",
            json!({ "id": vendor["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(vendor_before_update["name"], "Integration Vendor");
    rpc.mutation(
        "products.vendors.update",
        json!({ "id": vendor["id"], "data": { "name": "Updated Integration Vendor" } }),
        Some(&token),
    )
    .await;
    let listed_vendors = rpc
        .query(
            "products.vendors.list",
            json!({ "search": "Updated Integration" }),
            Some(&token),
        )
        .await;
    assert!(
        listed_vendors
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == vendor["id"])
    );

    let listed_prices = rpc
        .query(
            "products.priceRecords.list",
            json!({ "productId": product["id"], "vendorId": vendor["id"] }),
            Some(&token),
        )
        .await;
    assert!(
        listed_prices
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == price["id"])
    );
    rpc.mutation(
        "products.priceRecords.update",
        json!({ "id": price["id"], "data": { "pricePerBaseUnit": 12.5, "comment": "Updated integration price" } }),
        Some(&token),
    )
    .await;

    let filter_options = rpc
        .query("projects.costs.filterOptions", Value::Null, Some(&token))
        .await;
    assert!(filter_options["finishingYears"].is_array());
    let overview = rpc
        .query(
            "projects.costs.overview",
            json!({ "status": "all" }),
            Some(&token),
        )
        .await;
    assert!(
        overview
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["projectId"] == project["id"])
    );

    rpc.mutation(
        "deliveryNotes.delete",
        json!({ "id": delivery_note["id"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "products.priceRecords.delete",
        json!({ "id": price["id"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "products.vendors.delete",
        json!({ "id": vendor["id"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "products.delete",
        json!({ "id": product["id"] }),
        Some(&token),
    )
    .await;

    let remaining =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM product_delivery_notes WHERE id = $1")
            .bind(
                sortsys_api::ids::Id::decode(delivery_note["id"].as_str().unwrap())
                    .unwrap()
                    .0,
            )
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn tool_tracking_transfers_and_inventories_use_real_postgres() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap().to_owned();

    rpc.expect_error(
        "tools.create",
        Method::POST,
        json!({ "customId": 9201, "brand": "No", "category": "Auth" }),
        None,
        "UNAUTHORIZED",
    )
    .await;

    let recipient = rpc
        .mutation(
            "users.create",
            json!({
                "username": "integration.tool.recipient",
                "firstName": "Tool Recipient",
            }),
            Some(&token),
        )
        .await;
    let project = rpc
        .mutation(
            "projects.create",
            json!({ "title": "Tool transfer integration" }),
            Some(&token),
        )
        .await;
    let tool = rpc
        .mutation(
            "tools.create",
            json!({
                "customId": 9201,
                "brand": "Integration Brand",
                "category": "Integration Category",
                "label": "Database Tool",
                "purchasePrice": 250,
                "usageCostPerDay": 15,
            }),
            Some(&token),
        )
        .await;

    let fetched_tool = rpc
        .query("tools.get", json!({ "id": tool["id"] }), Some(&token))
        .await;
    assert_eq!(fetched_tool["label"], "Database Tool");
    rpc.mutation(
        "tools.update",
        json!({ "id": tool["id"], "data": { "label": "Updated Database Tool", "purchasePrice": 275 } }),
        Some(&token),
    )
    .await;
    let listed_tools = rpc
        .query(
            "tools.list",
            json!({ "search": "Updated Database Tool" }),
            Some(&token),
        )
        .await;
    assert!(
        listed_tools
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == tool["id"])
    );
    assert!(
        rpc.query("tools.suggestNextCustomId", Value::Null, Some(&token))
            .await
            .as_i64()
            .unwrap()
            > 9201
    );

    let tracking = rpc
        .mutation(
            "tools.track",
            json!({
                "id": tool["id"],
                "data": {
                    "projectId": project["id"],
                    "responsibleUserId": sortsys_api::ids::Id(fixture.user_id).encode(),
                    "comment": "Initial database tracking",
                },
            }),
            Some(&token),
        )
        .await;
    let transfer = rpc
        .mutation(
            "tools.trackings.transfers.request",
            json!({
                "toolTrackingId": tracking["trackingId"],
                "transferToUserId": recipient["id"],
                "projectId": project["id"],
                "notes": "Transfer through PostgreSQL",
            }),
            Some(&token),
        )
        .await;

    let open_transfers = rpc
        .query(
            "tools.trackings.transfers.list",
            json!({ "toolId": tool["id"], "status": "open" }),
            Some(&token),
        )
        .await;
    assert_eq!(open_transfers.as_array().unwrap().len(), 1);

    rpc.mutation(
        "tools.trackings.transfers.accept",
        json!({ "id": transfer["id"] }),
        Some(&token),
    )
    .await;

    let tracking_id = sortsys_api::ids::Id::decode(tracking["trackingId"].as_str().unwrap())
        .unwrap()
        .0;
    let transfer_id = sortsys_api::ids::Id::decode(transfer["id"].as_str().unwrap())
        .unwrap()
        .0;
    let transfer_state = sqlx::query_as::<_, (String, bool, i64)>(
        r#"
        SELECT
            transfer.status,
            original.ended_at IS NOT NULL,
            COUNT(continuation.id)
        FROM tool_tracking_transfer_requests AS transfer
        JOIN tool_trackings AS original ON original.id = transfer.tool_tracking_id
        LEFT JOIN tool_trackings AS continuation ON continuation.continuation_of = original.id
        WHERE transfer.id = $1 AND original.id = $2
        GROUP BY transfer.status, original.ended_at
        "#,
    )
    .bind(transfer_id)
    .bind(tracking_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(transfer_state, ("accepted".to_owned(), true, 1));

    let deny_tool = rpc
        .mutation(
            "tools.create",
            json!({ "customId": 9202, "brand": "Integration Brand", "category": "Transfer denial" }),
            Some(&token),
        )
        .await;
    let deny_tracking = rpc
        .mutation(
            "tools.track",
            json!({ "id": deny_tool["id"], "data": { "responsibleUserId": recipient["id"] } }),
            Some(&token),
        )
        .await;
    let denied_transfer = rpc
        .mutation(
            "tools.trackings.transfers.request",
            json!({ "toolTrackingId": deny_tracking["trackingId"], "transferToUserId": sortsys_api::ids::Id(fixture.user_id).encode() }),
            Some(&token),
        )
        .await;
    rpc.mutation(
        "tools.trackings.transfers.deny",
        json!({ "id": denied_transfer["id"] }),
        Some(&token),
    )
    .await;
    let denied_status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM tool_tracking_transfer_requests WHERE id = $1",
    )
    .bind(
        sortsys_api::ids::Id::decode(denied_transfer["id"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(denied_status, "denied");

    let inventory = rpc
        .mutation(
            "tools.inventories.create",
            json!({
                "toolId": tool["id"],
                "comment": "Physically counted in integration test",
            }),
            Some(&token),
        )
        .await;
    let inventories = rpc
        .query(
            "tools.inventories.list",
            json!({ "toolId": tool["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(inventories.as_array().unwrap().len(), 1);
    let inventory_overview = rpc
        .query(
            "tools.inventories.overview",
            json!({ "hadInventory": true, "days": 30 }),
            Some(&token),
        )
        .await;
    assert!(
        inventory_overview
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == tool["id"])
    );
    assert_eq!(
        inventories[0]["comment"],
        "Physically counted in integration test"
    );

    let brands = rpc.query("tools.brands", Value::Null, Some(&token)).await;
    let categories = rpc
        .query("tools.categories", Value::Null, Some(&token))
        .await;
    assert!(
        brands
            .as_array()
            .unwrap()
            .contains(&json!("Integration Brand"))
    );
    assert!(
        categories
            .as_array()
            .unwrap()
            .contains(&json!("Integration Category"))
    );

    rpc.mutation(
        "tools.inventories.delete",
        json!({ "id": inventory["id"] }),
        Some(&token),
    )
    .await;
    rpc.mutation("tools.untrack", json!({ "id": tool["id"] }), Some(&token))
        .await;
    rpc.mutation("tools.archive", json!({ "id": tool["id"] }), Some(&token))
        .await;

    let tool_id = sortsys_api::ids::Id::decode(tool["id"].as_str().unwrap())
        .unwrap()
        .0;
    let stored_tool = sqlx::query_as::<_, (bool, i64, i64)>(
        r#"
        SELECT
            archived_since IS NOT NULL,
            (SELECT COUNT(*) FROM tool_trackings WHERE tool_id = tools.id),
            (SELECT COUNT(*) FROM tool_inventories WHERE tool_id = tools.id)
        FROM tools
        WHERE id = $1
        "#,
    )
    .bind(tool_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(stored_tool, (true, 2, 0));

    rpc.mutation("tools.unarchive", json!({ "id": tool["id"] }), Some(&token))
        .await;
    let archived =
        sqlx::query_scalar::<_, bool>("SELECT archived_since IS NOT NULL FROM tools WHERE id = $1")
            .bind(tool_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert!(!archived);

    let deletable_tool = rpc
        .mutation(
            "tools.create",
            json!({ "customId": 9203, "brand": "Delete", "category": "Delete" }),
            Some(&token),
        )
        .await;
    rpc.mutation(
        "tools.delete",
        json!({ "id": deletable_tool["id"] }),
        Some(&token),
    )
    .await;
}
#[tokio::test]
async fn project_schedule_reports_and_financial_entries_use_real_postgres() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap().to_owned();
    let admin_user_id = sortsys_api::ids::Id(fixture.user_id).encode();

    let project = rpc
        .mutation(
            "projects.create",
            json!({ "title": "Project lifecycle integration" }),
            Some(&token),
        )
        .await;
    let project_id = project["id"].as_str().unwrap();
    let decoded_project_id = sortsys_api::ids::Id::decode(project_id).unwrap().0;

    let deployment = rpc
        .mutation(
            "projects.deployments.create",
            json!({
                "projectId": project_id,
                "userId": admin_user_id,
                "from": "2026-08-20T08:00:00.000Z",
                "to": "2026-08-20T16:00:00.000Z",
                "note": "Initial deployment",
            }),
            Some(&token),
        )
        .await;

    let deployments = rpc
        .query(
            "projects.deployments.list",
            json!({
                "projectId": project_id,
                "from": "2026-08-20T00:00:00.000Z",
                "to": "2026-08-21T00:00:00.000Z",
            }),
            Some(&token),
        )
        .await;
    assert_eq!(deployments.as_array().unwrap().len(), 1);
    assert_eq!(deployments[0]["note"], "Initial deployment");

    rpc.mutation(
        "projects.deployments.update",
        json!({
            "id": deployment["id"],
            "data": {
                "to": "2026-08-20T17:00:00.000Z",
                "note": "Extended deployment",
            },
        }),
        Some(&token),
    )
    .await;

    let unavailable = rpc
        .mutation(
            "projects.unavailability.create",
            json!({
                "projectId": project_id,
                "from": "2026-08-20T00:00:00.000+02:00",
                "to": "2026-08-21T00:00:00.000+02:00",
                "reason": "Site closed",
                "note": "Calendar dates retain their explicit offset",
            }),
            Some(&token),
        )
        .await;

    let unavailable_periods = rpc
        .query(
            "projects.unavailability.list",
            json!({
                "projectId": project_id,
                "from": "2026-08-20T00:00:00.000+02:00",
                "to": "2026-08-21T00:00:00.000+02:00",
            }),
            Some(&token),
        )
        .await;
    assert_eq!(unavailable_periods.as_array().unwrap().len(), 1);
    assert_eq!(unavailable_periods[0]["from"], "2026-08-20T00:00:00.000Z");

    rpc.mutation(
        "projects.unavailability.update",
        json!({
            "id": unavailable["id"],
            "data": { "reason": "Weather closure" },
        }),
        Some(&token),
    )
    .await;

    let report_day = "2026-08-20T00:00:00.000+02:00";
    rpc.mutation(
        "projects.dailyReports.create",
        json!({
            "projectId": project_id,
            "day": report_day,
            "summary": "Foundation completed",
            "weather": {
                "summary": "Sunny",
                "temperatureC": 24,
                "precipitationMm": 0,
                "windKph": 8,
            },
            "workHours": [{
                "userId": admin_user_id,
                "hours": 7.5,
                "costPerHour": 42,
                "contractType": "internal",
            }],
        }),
        Some(&token),
    )
    .await;

    let report = rpc
        .query(
            "projects.dailyReports.get",
            json!({ "projectId": project_id, "day": report_day }),
            Some(&token),
        )
        .await;
    assert_eq!(report["day"], "2026-08-20T00:00:00.000Z");
    assert_eq!(report["summary"], "Foundation completed");
    assert_eq!(report["workHours"][0]["hours"], 7.5);

    rpc.mutation(
        "projects.dailyReports.update",
        json!({
            "projectId": project_id,
            "day": report_day,
            "data": {
                "summary": "Foundation and drainage completed",
                "workHours": [{
                    "userId": admin_user_id,
                    "hours": 8,
                    "costPerHour": 42,
                    "contractType": "internal",
                }],
            },
        }),
        Some(&token),
    )
    .await;

    let reports = rpc
        .query(
            "projects.dailyReports.list",
            json!({
                "projectId": project_id,
                "from": report_day,
                "to": report_day,
            }),
            Some(&token),
        )
        .await;
    assert_eq!(reports.as_array().unwrap().len(), 1);
    assert_eq!(reports[0]["summary"], "Foundation and drainage completed");
    assert_eq!(reports[0]["workHours"][0]["hours"], 8.0);

    rpc.mutation(
        "projects.costs.entries.create",
        json!({
            "projectId": project_id,
            "type": "offer",
            "amount": 1000,
            "comment": "Original offer",
        }),
        Some(&token),
    )
    .await;

    let financial_entry_id = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM project_financial_entries WHERE project_id = $1",
    )
    .bind(decoded_project_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    let financial_entry_id = sortsys_api::ids::Id(financial_entry_id).encode();

    rpc.mutation(
        "projects.costs.entries.update",
        json!({
            "projectId": project_id,
            "id": financial_entry_id,
            "data": { "amount": 1200, "comment": "Accepted offer" },
        }),
        Some(&token),
    )
    .await;

    let costs = rpc
        .query(
            "projects.costs.get",
            json!({ "projectId": project_id }),
            Some(&token),
        )
        .await;
    assert_eq!(costs["offers"][0]["amount"], 1200.0);
    assert_eq!(costs["offers"][0]["comment"], "Accepted offer");
    assert_eq!(costs["totalCosts"]["offers"], 1200.0);
    assert_eq!(costs["workHours"][0]["totalCost"], 336.0);

    let regie_product = rpc
        .mutation(
            "products.create",
            json!({ "customId": 9401, "name": "Regie material", "baseUnit": "kg" }),
            Some(&token),
        )
        .await;
    rpc.mutation(
        "products.priceRecords.create",
        json!({
            "productId": regie_product["id"],
            "pricePerBaseUnit": 10,
            "timestamp": "2026-08-01T00:00:00.000Z",
            "isRealPurchase": true,
        }),
        Some(&token),
    )
    .await;
    let regie = rpc
        .mutation(
            "regieReports.create",
            json!({
                "projectId": project_id,
                "day": "2026-08-17T00:00:00.000+02:00",
                "summary": "Regie lifecycle",
                "products": [{ "productId": regie_product["id"], "quantity": 2 }],
                "workHours": [{ "userId": admin_user_id, "day": "2026-08-18T00:00:00.000+02:00", "hours": 3 }],
            }),
            Some(&token),
        )
        .await;
    let regie_costs = rpc
        .query(
            "regieReports.costs.get",
            json!({ "id": regie["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(regie_costs["products"][0]["priceRecord"]["price"], 10.0);
    rpc.mutation(
        "regieReports.update",
        json!({ "id": regie["id"], "data": { "summary": "Updated regie lifecycle" } }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "regieReports.delete",
        json!({ "id": regie["id"] }),
        Some(&token),
    )
    .await;

    rpc.mutation("projects.finish", json!({ "id": project_id }), Some(&token))
        .await;
    let finished =
        sqlx::query_scalar::<_, bool>("SELECT finished_at IS NOT NULL FROM projects WHERE id = $1")
            .bind(decoded_project_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert!(finished);

    rpc.mutation("projects.resume", json!({ "id": project_id }), Some(&token))
        .await;
    let finished =
        sqlx::query_scalar::<_, bool>("SELECT finished_at IS NOT NULL FROM projects WHERE id = $1")
            .bind(decoded_project_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert!(!finished);

    rpc.mutation(
        "projects.costs.entries.delete",
        json!({ "projectId": project_id, "id": financial_entry_id }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "projects.dailyReports.delete",
        json!({ "projectId": project_id, "day": report_day }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "projects.unavailability.delete",
        json!({ "id": unavailable["id"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "projects.deployments.delete",
        json!({ "id": deployment["id"] }),
        Some(&token),
    )
    .await;

    let remaining = sqlx::query_as::<_, (i64, i64, i64, i64)>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM project_deployments WHERE project_id = $1),
            (SELECT COUNT(*) FROM project_unavailability_periods WHERE project_id = $1),
            (SELECT COUNT(*) FROM daily_project_reports WHERE project_id = $1),
            (SELECT COUNT(*) FROM project_financial_entries WHERE project_id = $1)
        "#,
    )
    .bind(decoded_project_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(remaining, (0, 0, 0, 0));

    let deletable_project = rpc
        .mutation(
            "projects.create",
            json!({ "title": "Delete project integration" }),
            Some(&token),
        )
        .await;
    rpc.mutation(
        "projects.delete",
        json!({ "id": deletable_project["id"] }),
        Some(&token),
    )
    .await;
}

#[tokio::test]
async fn settings_relationships_personalization_and_scripts_use_real_postgres() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap().to_owned();

    rpc.expect_error(
        "personalization.visits.list",
        Method::GET,
        json!({ "limit": 1 }),
        None,
        "UNAUTHORIZED",
    )
    .await;

    rpc.mutation(
        "settings.costs.set",
        json!({
            "type": "fgk",
            "effectiveAt": "2026-05-01T00:00:00.000Z",
            "relativeFactor": 0.25,
            "constant": 10,
        }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "settings.costs.update",
        json!({
            "productOverheadFactor": 1.4,
            "specialRecordOverheadFactor": 1.2,
            "workHourOverheadFactor": 1.5,
        }),
        Some(&token),
    )
    .await;

    let common_costs = rpc
        .query("settings.costs.get", Value::Null, Some(&token))
        .await;
    assert_eq!(common_costs["fgk"]["relativeFactor"], 0.5);
    let mgk_factor = common_costs["mgk"]["relativeFactor"].as_f64().unwrap();
    assert!((mgk_factor - 0.3).abs() < f64::EPSILON * 4.0);
    assert!(common_costs["history"].as_array().unwrap().len() >= 3);

    rpc.mutation(
        "settings.global.set",
        json!({ "key": "dashboard", "name": { "title": "Internal" } }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "settings.publicGlobal.set",
        json!({ "key": "branding", "name": { "title": "Public" } }),
        Some(&token),
    )
    .await;

    let global = rpc
        .query(
            "settings.global.get",
            json!({ "key": "dashboard" }),
            Some(&token),
        )
        .await;
    let public = rpc
        .query(
            "settings.publicGlobal.get",
            json!({ "key": "branding" }),
            Some(&token),
        )
        .await;
    assert_eq!(global["name"]["title"], "Internal");
    assert_eq!(public["name"]["title"], "Public");

    let customer = rpc
        .mutation(
            "customers.create",
            json!({ "name": "Relationship customer" }),
            Some(&token),
        )
        .await;
    let first_contact = rpc
        .mutation(
            "contacts.create",
            json!({ "firstName": "First", "lastName": "Contact" }),
            Some(&token),
        )
        .await;
    let second_contact = rpc
        .mutation(
            "contacts.create",
            json!({ "firstName": "Second", "lastName": "Contact" }),
            Some(&token),
        )
        .await;
    let project = rpc
        .mutation(
            "projects.create",
            json!({ "title": "Relationship and activity project" }),
            Some(&token),
        )
        .await;

    rpc.mutation(
        "customers.contacts.add",
        json!({
            "customerId": customer["id"],
            "contactId": first_contact["id"],
        }),
        Some(&token),
    )
    .await;
    let customer_contacts = rpc
        .query(
            "customers.contacts.list",
            json!({ "customerId": customer["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(customer_contacts[0]["id"], first_contact["id"]);

    let contact_customers = rpc
        .query(
            "contacts.customers.list",
            json!({ "contactId": first_contact["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(contact_customers[0]["id"], customer["id"]);

    rpc.mutation(
        "customers.contacts.set",
        json!({
            "customerId": customer["id"],
            "contactIds": [second_contact["id"], second_contact["id"]],
        }),
        Some(&token),
    )
    .await;

    rpc.mutation(
        "projects.contacts.add",
        json!({
            "projectId": project["id"],
            "contactId": first_contact["id"],
            "label": "Planning",
        }),
        Some(&token),
    )
    .await;
    let contact_projects = rpc
        .query(
            "contacts.projects.list",
            json!({ "contactId": first_contact["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(contact_projects[0]["id"], project["id"]);

    rpc.mutation(
        "projects.contacts.set",
        json!({
            "projectId": project["id"],
            "contacts": [{
                "contactId": second_contact["id"],
                "label": "Site management",
            }],
        }),
        Some(&token),
    )
    .await;
    let project_contacts = rpc
        .query(
            "projects.contacts.list",
            json!({ "projectId": project["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(project_contacts.as_array().unwrap().len(), 1);
    assert_eq!(project_contacts[0]["id"], second_contact["id"]);
    assert_eq!(project_contacts[0]["label"], "Site management");

    let remark = rpc
        .mutation(
            "remarks.create",
            json!({
                "resourceType": "project",
                "resourceId": project["id"],
                "body": "Initial integration note",
            }),
            Some(&token),
        )
        .await;
    rpc.mutation(
        "remarks.update",
        json!({ "id": remark["id"], "body": "Updated integration note" }),
        Some(&token),
    )
    .await;
    let remarks = rpc
        .query(
            "remarks.list",
            json!({ "resourceType": "project", "resourceId": project["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(remarks[0]["body"], "Updated integration note");

    let script = rpc
        .mutation(
            "clientScripts.create",
            json!({
                "name": "Integration enhancer",
                "description": "Stored executable customization",
                "code": "window.__integration = true;",
                "enabled": true,
            }),
            Some(&token),
        )
        .await;
    assert_eq!(script["code"], "window.__integration = true;");

    let fetched_script = rpc
        .query(
            "clientScripts.get",
            json!({ "id": script["id"] }),
            Some(&token),
        )
        .await;
    assert_eq!(fetched_script["code"], "window.__integration = true;");

    let script_summaries = rpc
        .query(
            "clientScripts.list",
            json!({ "search": "Integration enhancer", "includeDisabled": true }),
            Some(&token),
        )
        .await;
    assert_eq!(script_summaries.as_array().unwrap().len(), 1);
    assert!(script_summaries[0].get("code").is_none());

    let updated_script = rpc
        .mutation(
            "clientScripts.update",
            json!({
                "id": script["id"],
                "data": { "description": null, "enabled": false },
            }),
            Some(&token),
        )
        .await;
    assert_eq!(updated_script["description"], Value::Null);
    assert_eq!(updated_script["enabled"], false);

    rpc.mutation(
        "personalization.visits.append",
        json!({ "path": "/projects", "title": "Projekte" }),
        Some(&token),
    )
    .await;
    for index in 0..105 {
        rpc.mutation(
            "personalization.visits.append",
            json!({
                "path": format!("/projects/{index}"),
                "title": format!("Projekt {index}"),
            }),
            Some(&token),
        )
        .await;
    }
    let visits = rpc
        .query(
            "personalization.visits.list",
            json!({ "limit": 100 }),
            Some(&token),
        )
        .await;
    assert_eq!(visits.as_array().unwrap().len(), 100);
    assert!(
        !visits
            .as_array()
            .unwrap()
            .iter()
            .any(|visit| visit["path"] == "/projects")
    );

    rpc.mutation(
        "personalization.actions.append",
        json!({ "actionId": "tools.track", "label": "Werkzeuge einbuchen" }),
        Some(&token),
    )
    .await;
    for index in 0..205 {
        rpc.mutation(
            "personalization.actions.append",
            json!({
                "actionId": format!("integration.action.{index}"),
                "label": format!("Aktion {index}"),
                "href": format!("/actions/{index}"),
            }),
            Some(&token),
        )
        .await;
    }
    let actions = rpc
        .query(
            "personalization.actions.list",
            json!({ "limit": 200 }),
            Some(&token),
        )
        .await;
    assert_eq!(actions.as_array().unwrap().len(), 200);
    assert!(
        !actions
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action["actionId"] == "tools.track")
    );

    let activity = rpc
        .query(
            "personalization.activity.list",
            json!({
                "limit": 10,
                "resourceType": "project",
                "resourceId": project["id"],
                "includeProjectContext": true,
            }),
            Some(&token),
        )
        .await;
    assert!(!activity.as_array().unwrap().is_empty());
    assert!(
        activity.as_array().unwrap().iter().all(
            |entry| entry["resourceId"] == project["id"] || entry["contextId"] == project["id"]
        )
    );

    let project_id = sortsys_api::ids::Id::decode(project["id"].as_str().unwrap())
        .unwrap()
        .0;
    let relation_and_history_counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
        r#"
        SELECT
            (SELECT COUNT(*) FROM customer_contacts),
            (SELECT COUNT(*) FROM project_contacts),
            (SELECT COUNT(*) FROM resource_notes WHERE project_id = $1),
            (SELECT COUNT(*) FROM client_scripts),
            (SELECT COUNT(*) FROM user_visit_history WHERE user_id = $2),
            (SELECT COUNT(*) FROM user_action_history WHERE user_id = $2)
        "#,
    )
    .bind(project_id)
    .bind(fixture.user_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(relation_and_history_counts, (1, 1, 1, 1, 100, 200));

    rpc.mutation(
        "remarks.delete",
        json!({ "id": remark["id"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "clientScripts.delete",
        json!({ "id": script["id"] }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "projects.contacts.remove",
        json!({
            "projectId": project["id"],
            "contactId": second_contact["id"],
        }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "customers.contacts.remove",
        json!({
            "customerId": customer["id"],
            "contactId": second_contact["id"],
        }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "settings.global.delete",
        json!({ "key": "dashboard" }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "settings.publicGlobal.delete",
        json!({ "key": "branding" }),
        Some(&token),
    )
    .await;
    rpc.mutation(
        "settings.costs.delete",
        json!({
            "type": "fgk",
            "effectiveAt": "2026-05-01T00:00:00.000Z",
        }),
        Some(&token),
    )
    .await;
}

#[tokio::test]
async fn global_admin_tenants_users_and_errors_use_real_databases() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let admin_password = env::var("TEST_ADMIN_PASSWORD")
        .expect("scripts/test-api must provide the global test admin password");
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);

    rpc.expect_error(
        "admin.tenants.list",
        Method::GET,
        Value::Null,
        None,
        "UNAUTHORIZED",
    )
    .await;

    let admin_login = rpc
        .mutation(
            "admin.login",
            json!({ "tenant": null, "password": admin_password }),
            None,
        )
        .await;
    let admin_token = admin_login["token"].as_str().unwrap().to_owned();

    let tenants_before = rpc
        .query("admin.tenants.list", Value::Null, Some(&admin_token))
        .await;
    assert!(
        tenants_before
            .as_array()
            .unwrap()
            .iter()
            .any(|tenant| tenant["name"] == fixture.tenant)
    );

    let temporary_tenant = format!("admin-integration-{}", unique_suffix());
    let created_tenant = rpc
        .mutation(
            "admin.tenants.create",
            json!({
                "name": temporary_tenant,
                "contact_details": {
                    "email": format!("{temporary_tenant}@example.test"),
                    "companyName": "Temporary integration tenant",
                },
                "connection_details": {},
                "options": { "integration": true },
            }),
            Some(&admin_token),
        )
        .await;
    assert!(created_tenant["adminPassword"].as_str().unwrap().len() >= 72);

    let created_tenant = rpc
        .query(
            "admin.tenants.get",
            json!({ "name": temporary_tenant }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(
        created_tenant["contact_details"]["companyName"],
        "Temporary integration tenant"
    );

    rpc.mutation(
        "admin.tenants.update",
        json!({
            "name": temporary_tenant,
            "data": {
                "contact_details": {
                    "email": format!("updated-{temporary_tenant}@example.test"),
                    "companyName": "Updated integration tenant",
                },
            },
        }),
        Some(&admin_token),
    )
    .await;

    rpc.mutation(
        "admin.tenants.deactivate",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;
    let tenant_state = rpc
        .query(
            "admin.tenants.get",
            json!({ "name": temporary_tenant }),
            Some(&admin_token),
        )
        .await;
    assert!(!tenant_state["deactivated_at"].is_null());

    rpc.mutation(
        "admin.tenants.activate",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "admin.tenants.lock",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "admin.tenants.unlock",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "admin.tenants.activate",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "admin.tenants.delete",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;
    rpc.mutation(
        "admin.tenants.undelete",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;

    let created_admin = rpc
        .mutation(
            "admin.users.create",
            json!({
                "tenant": fixture.tenant,
                "username": "cross.tenant.admin",
                "firstName": "Cross Tenant",
                "lastName": "Administrator",
                "email": "cross.tenant.admin@example.test",
                "contractType": "internal",
                "password": "Initial-Admin-Password-2026",
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(created_admin["password"], "Initial-Admin-Password-2026");

    let admin_users = rpc
        .query(
            "admin.users.list",
            json!({
                "tenant": fixture.tenant,
                "search": "cross.tenant.admin",
                "includeArchived": true,
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(admin_users.as_array().unwrap().len(), 1);
    assert_eq!(admin_users[0]["isAdmin"], true);

    rpc.mutation(
        "admin.users.setAdmin",
        json!({
            "tenant": fixture.tenant,
            "userId": created_admin["userId"],
            "admin": false,
        }),
        Some(&admin_token),
    )
    .await;
    rpc.expect_error(
        "admin.users.resetPassword",
        Method::POST,
        json!({
            "tenant": fixture.tenant,
            "userId": created_admin["userId"],
            "password": "Rejected-Admin-Password-2026",
        }),
        Some(&admin_token),
        "FORBIDDEN",
    )
    .await;

    rpc.mutation(
        "admin.users.setAdmin",
        json!({
            "tenant": fixture.tenant,
            "userId": created_admin["userId"],
            "admin": true,
        }),
        Some(&admin_token),
    )
    .await;
    let reset = rpc
        .mutation(
            "admin.users.resetPassword",
            json!({
                "tenant": fixture.tenant,
                "userId": created_admin["userId"],
                "password": "Reset-Admin-Password-2026",
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(reset["password"], "Reset-Admin-Password-2026");

    let tenant_login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": "cross.tenant.admin",
                "password": "Reset-Admin-Password-2026",
            }),
            None,
        )
        .await;
    let tenant_token = tenant_login["token"].as_str().unwrap().to_owned();

    rpc.mutation(
        "errorReports.report",
        json!({
            "level": "warning",
            "source": "integration-test",
            "message": "Visible to the global administrator",
            "stack": "integration stack",
            "path": "/projects/integration",
            "componentStack": "ProjectRoute",
            "metadata": { "scenario": "admin-errors" },
        }),
        Some(&tenant_token),
    )
    .await;

    let errors = rpc
        .query(
            "admin.errors.list",
            json!({ "tenant": fixture.tenant, "limit": 10 }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(errors.as_array().unwrap().len(), 1);
    assert_eq!(errors[0]["tenant"], fixture.tenant);
    assert_eq!(errors[0]["message"], "Visible to the global administrator");
    assert_eq!(errors[0]["username"], "cross.tenant.admin");

    let stored_admin_state = sqlx::query_as::<_, (bool, i64, i64)>(
        r#"
        SELECT
            EXISTS (
                SELECT 1
                FROM user_role_assignments
                WHERE user_id = $1 AND role_name = ':admin'
            ),
            (SELECT COUNT(*) FROM user_sessions WHERE user_id = $1),
            (SELECT COUNT(*) FROM client_error_reports WHERE created_by_user_id = $1)
        "#,
    )
    .bind(
        sortsys_api::ids::Id::decode(created_admin["userId"].as_str().unwrap())
            .unwrap()
            .0,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert!(stored_admin_state.0);
    assert!(stored_admin_state.1 >= 1);
    assert_eq!(stored_admin_state.2, 1);

    rpc.mutation(
        "admin.tenants.deleteForever",
        json!({ "name": temporary_tenant }),
        Some(&admin_token),
    )
    .await;

    let master = PgPool::connect(&environment.master_dsn).await.unwrap();
    let temporary_tenant_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM __tenants WHERE name = $1)")
            .bind(&temporary_tenant)
            .fetch_one(&master)
            .await
            .unwrap();
    assert!(!temporary_tenant_exists);
}

#[tokio::test]
async fn llm_configuration_access_chats_proposals_and_usage_use_real_postgres() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let admin_password = env::var("TEST_ADMIN_PASSWORD")
        .expect("scripts/test-api must provide the global test admin password");
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let (openai_base_url, openai_requests) = start_openai_responses_mock().await;

    let admin_login = rpc
        .mutation(
            "admin.login",
            json!({ "tenant": null, "password": admin_password }),
            None,
        )
        .await;
    let admin_token = admin_login["token"].as_str().unwrap();

    let configured = rpc
        .mutation(
            "admin.llm.settings.update",
            json!({
                "provider": "openai",
                "model": "gpt-5.6-luna",
                "baseUrl": openai_base_url,
                "apiKey": "integration-secret-that-must-not-leak",
            }),
            Some(admin_token),
        )
        .await;
    assert_eq!(configured["hasApiKey"], true);

    let public_settings = rpc
        .query("admin.llm.settings.get", Value::Null, Some(admin_token))
        .await;
    assert!(public_settings.get("apiKey").is_none());
    assert_eq!(public_settings["model"], "gpt-5.6-luna");

    let tenants = rpc
        .query("admin.llm.tenants.list", Value::Null, Some(admin_token))
        .await;
    assert!(
        tenants
            .as_array()
            .unwrap()
            .iter()
            .any(|row| { row["name"] == fixture.tenant && row["enabled"] == false })
    );

    rpc.mutation(
        "admin.llm.tenants.update",
        json!({
            "name": fixture.tenant,
            "enabled": true,
            "monthlyTokenQuota": 50_000,
        }),
        Some(admin_token),
    )
    .await;

    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap();

    let status = rpc.query("llm.status", Value::Null, Some(token)).await;
    assert_eq!(status["available"], true);
    assert_eq!(status["monthlyTokenQuota"], 50_000);

    let chat = rpc
        .mutation("llm.chats.create", json!({}), Some(token))
        .await;
    let chat_id = chat["id"].as_str().unwrap();
    let chat_id_sql = Id::decode(chat_id).unwrap().0;

    let chat_id_default: Option<String> = sqlx::query_scalar(
        r#"
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'llm_chats'
          AND column_name = 'id'
        "#,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();

    assert_eq!(chat_id_default.as_deref(), Some("id64()"));
    assert!(chat_id_sql > 0);

    let chats = rpc.query("llm.chats.list", Value::Null, Some(token)).await;
    assert!(
        chats
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == chat_id)
    );

    let chat_detail = rpc
        .query("llm.chats.get", json!({ "chatId": chat_id }), Some(token))
        .await;
    assert_eq!(chat_detail["messages"].as_array().unwrap().len(), 0);

    let cost_project = rpc
        .mutation(
            "projects.create",
            json!({
                "title": "Sanierung Verwaltungsgebäude – Kostenprüfung",
                "address": {
                    "streetAddress": "Prüfstraße 12",
                    "zip": "90402",
                    "city": "Nürnberg",
                    "country": "Deutschland"
                }
            }),
            Some(token),
        )
        .await;
    let cost_project_id = cost_project["id"].clone();
    let admin_user_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
        .bind(&fixture.admin_username)
        .fetch_one(&fixture.tenant_pool)
        .await
        .unwrap();

    rpc.mutation(
        "projects.costs.entries.create",
        json!({
            "projectId": cost_project_id,
            "type": "offer",
            "amount": 12_500,
            "comment": "Beauftragtes Nettoangebot"
        }),
        Some(token),
    )
    .await;
    rpc.mutation(
        "projects.costs.entries.create",
        json!({
            "projectId": cost_project_id,
            "type": "invoice",
            "amount": 6_800,
            "comment": "Bisherige Nettorechnung"
        }),
        Some(token),
    )
    .await;
    rpc.mutation(
        "projects.dailyReports.create",
        json!({
            "projectId": cost_project_id,
            "day": "2026-08-20T00:00:00.000+02:00",
            "summary": "Untergrund vorbereitet und erste Flächen beschichtet.",
            "workHours": [{
                "userId": Id(admin_user_id).encode(),
                "hours": 7.5,
                "costPerHour": 42,
                "contractType": "internal"
            }]
        }),
        Some(token),
    )
    .await;

    let completed_chat = rpc
        .mutation(
            "llm.messages.send",
            json!({
                "chatId": chat_id,
                "content": "Wie ist der aktuelle Kostenstand der Projekte?"
            }),
            Some(token),
        )
        .await;
    assert_eq!(
        completed_chat["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"],
        "Die aktuelle Projektkostenübersicht wurde geladen."
    );

    let requests = openai_requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["model"], "gpt-5.6-luna");
    assert_eq!(requests[0]["max_output_tokens"], 1200);
    assert!(requests[0].get("messages").is_none());
    assert!(requests[0].get("reasoning_effort").is_none());
    assert!(
        requests[0]["instructions"]
            .as_str()
            .unwrap()
            .contains("Ressource project_costs")
    );
    assert!(requests[0]["tools"].as_array().unwrap().iter().any(|tool| {
        tool["type"] == "function"
            && tool["name"] == "sortsys_search"
            && tool.get("function").is_none()
    }));

    let tool_output = requests[1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .and_then(|item| item["output"].as_str())
        .map(|output| serde_json::from_str::<Value>(output).unwrap())
        .expect("the second Responses request must contain the project-cost tool result");
    assert_eq!(tool_output["amountsAreNet"], true);
    assert_eq!(tool_output["scope"], "activeProjects");
    assert!(tool_output["projectCount"].as_u64().unwrap() > 0);
    assert!(tool_output["totals"]["costs"].as_f64().unwrap() > 0.0);
    assert!(!tool_output["records"].as_array().unwrap().is_empty());
    drop(requests);

    let proposed_chat = rpc
        .mutation(
            "llm.messages.send",
            json!({
                "chatId": chat_id,
                "content": "Lege das Projekt „Test Projekt LLM“ mit der Adresse „Musterstr. 42, Musterstadt“ an.",
                "locale": "de"
            }),
            Some(token),
        )
        .await;
    assert_eq!(
        proposed_chat["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"],
        ""
    );
    let proposal = proposed_chat["proposals"]
        .as_array()
        .unwrap()
        .last()
        .expect("the schema-backed proposal must be persisted");
    assert_eq!(proposal["operations"][0]["path"], "projects.create");
    assert_eq!(
        proposal["operations"][0]["input"],
        json!({
            "title": "Test Projekt LLM",
            "address": {
                "streetAddress": "Musterstr. 42",
                "city": "Musterstadt"
            }
        })
    );

    let requests = openai_requests.lock().await;
    assert_eq!(requests.len(), 6);
    let schema_tool = requests[2]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "sortsys_get_schema")
        .expect("the provider must receive the on-demand schema tool");
    assert_eq!(
        schema_tool["parameters"]["properties"]["path"]["type"],
        "string"
    );

    let schema = last_function_output(&requests[3]);
    assert_eq!(schema["path"], "projects.create");
    assert_eq!(schema["kind"], "mutation");
    assert_eq!(
        schema["inputSchema"]["properties"]["address"]["anyOf"][1]["type"],
        "object"
    );
    assert_eq!(
        schema["inputSchema"]["properties"]["address"]["anyOf"][1]["required"],
        json!(["city", "streetAddress"])
    );
    assert!(
        schema["inputType"]
            .as_str()
            .unwrap()
            .contains("title: string")
    );
    assert!(
        !schema["inputType"]
            .as_str()
            .unwrap()
            .contains("name: string")
    );

    let validation_error = last_function_output(&requests[4]);
    assert_eq!(validation_error["error"]["code"], "BAD_REQUEST");
    assert!(
        validation_error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("input.address must be an object")
    );

    let proposal_result = last_function_output(&requests[5]);
    assert!(proposal_result["proposalId"].is_string());
    drop(requests);

    let declined_proposal_id = proposal["id"].as_str().unwrap().to_owned();
    rpc.mutation(
        "llm.proposals.review",
        json!({
            "proposalId": declined_proposal_id,
            "decision": "decline",
            "comment": null,
        }),
        Some(token),
    )
    .await;

    let reloaded_chat = rpc
        .query("llm.chats.get", json!({ "chatId": chat_id }), Some(token))
        .await;
    let declined_proposal = reloaded_chat["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["id"] == declined_proposal_id)
        .expect("declined proposals must remain in the persisted chat history");
    assert_eq!(declined_proposal["status"], "declined");
    assert!(declined_proposal["assistantMessageId"].is_string());

    let tobias_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO users (username, first_name, last_name, password)
        VALUES ('tobias.schneider', 'Tobias', 'Schneider', 'nicht-zum-anmelden')
        RETURNING id
        "#,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    let assigned_tool_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO tools (custom_id, brand, category, label)
        VALUES (9851, 'Bosch Professional', 'Bohrhammer', 'GBH 18V-26')
        RETURNING id
        "#,
    )
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();

    sqlx::query(
        r#"
        INSERT INTO tool_trackings (
          tool_id,
          responsible_user_id,
          started_by_user_id,
          comment
        )
        VALUES ($1, $2, $3, 'Ausgabe für Baustelleneinsatz')
        "#,
    )
    .bind(assigned_tool_id)
    .bind(tobias_id)
    .bind(fixture.user_id)
    .execute(&fixture.tenant_pool)
    .await
    .unwrap();

    let tracking_chat = rpc
        .mutation(
            "llm.messages.send",
            json!({
                "chatId": chat_id,
                "content": "Welches Werkzeug hat Tobias Schneider aktuell?"
            }),
            Some(token),
        )
        .await;
    assert_eq!(
        tracking_chat["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"],
        "Tobias Schneider hat aktuell den Bohrhammer GBH 18V-26 von Bosch Professional."
    );

    let requests = openai_requests.lock().await;
    assert_eq!(requests.len(), 8);
    let tracking_output = last_function_output(&requests[7]);
    assert_eq!(
        tracking_output["records"][0]["responsible_first_name"],
        "Tobias"
    );
    assert_eq!(
        tracking_output["records"][0]["responsible_last_name"],
        "Schneider"
    );
    assert_eq!(
        tracking_output["records"][0]["tool_brand"],
        "Bosch Professional"
    );
    assert_eq!(tracking_output["records"][0]["tool_label"], "GBH 18V-26");
    drop(requests);
    rpc.mutation(
        "tools.inventories.create",
        json!({
            "toolId": Id(assigned_tool_id).encode(),
            "comment": "Inventurprüfung durch Integrationstest"
        }),
        Some(token),
    )
    .await;

    let inventory_chat = rpc
        .mutation(
            "llm.messages.send",
            json!({
                "chatId": chat_id,
                "content": "Wurde der Bosch-Bohrhammer in den letzten 30 Tagen inventarisiert?"
            }),
            Some(token),
        )
        .await;
    assert_eq!(
        inventory_chat["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"],
        "Der Bosch-Bohrhammer wurde innerhalb der letzten 30 Tage inventarisiert."
    );

    let requests = openai_requests.lock().await;
    assert_eq!(requests.len(), 10);
    let inventory_output = last_function_output(&requests[9]);
    assert_eq!(inventory_output["days"], 30);
    assert_eq!(inventory_output["hadInventory"], true);
    assert_eq!(
        inventory_output["records"][0]["tool_brand"],
        "Bosch Professional"
    );
    assert_eq!(
        inventory_output["records"][0]["last_inventory_comment"],
        "Inventurprüfung durch Integrationstest"
    );
    drop(requests);

    for (cost_type, relative_factor, constant) in
        [("fgk", 0.15, 12.0), ("mgk", 0.08, 5.0), ("ngk", 0.04, 3.0)]
    {
        rpc.mutation(
            "settings.costs.set",
            json!({
                "type": cost_type,
                "effectiveAt": "2026-08-25T00:00:00.000+02:00",
                "relativeFactor": relative_factor,
                "constant": constant
            }),
            Some(token),
        )
        .await;
    }

    let common_costs_chat = rpc
        .mutation(
            "llm.messages.send",
            json!({
                "chatId": chat_id,
                "content": "Wie hoch sind die aktuellen Gemeinkosten?"
            }),
            Some(token),
        )
        .await;
    assert_eq!(
        common_costs_chat["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"],
        "Die aktuellen Gemeinkosten wurden aus den Mandanteneinstellungen geladen."
    );

    let requests = openai_requests.lock().await;
    assert_eq!(requests.len(), 14);

    let catalog_output = last_function_output(&requests[11]);
    assert!(
        catalog_output["procedures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|procedure| procedure["path"] == "settings.costs.get")
    );

    let common_cost_schema = last_function_output(&requests[12]);
    assert_eq!(common_cost_schema["path"], "settings.costs.get");
    assert_eq!(common_cost_schema["kind"], "query");

    let common_cost_output = last_function_output(&requests[13]);
    assert_eq!(common_cost_output["path"], "settings.costs.get");
    assert_eq!(common_cost_output["data"]["fgk"]["relativeFactor"], 0.15);
    assert_eq!(common_cost_output["data"]["fgk"]["constant"], 12.0);
    assert_eq!(common_cost_output["data"]["mgk"]["relativeFactor"], 0.08);
    assert_eq!(common_cost_output["data"]["mgk"]["constant"], 5.0);
    assert_eq!(common_cost_output["data"]["ngk"]["relativeFactor"], 0.04);
    assert_eq!(common_cost_output["data"]["ngk"]["constant"], 3.0);
    drop(requests);

    // Keep covering failed provider requests and their quota records separately.
    rpc.mutation(
        "admin.llm.settings.update",
        json!({
            "provider": "custom",
            "model": "integration-unavailable-model",
            "baseUrl": "http://127.0.0.1:9",
            "apiKey": "integration-secret-that-must-not-leak",
        }),
        Some(admin_token),
    )
    .await;
    rpc.expect_error(
        "llm.messages.send",
        Method::POST,
        json!({ "chatId": chat_id, "content": "Zeige meine Projekte." }),
        Some(token),
        "INTERNAL_SERVER_ERROR",
    )
    .await;

    let proposal_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO llm_change_proposals (
          chat_id,
          title,
          summary,
          operations
        )
        VALUES (
          $1,
          'Projekt anlegen',
          'Legt ein Projekt über die normale Benutzer-API an.',
          '[{"path":"projects.create","input":{"title":"Prüfprojekt"},"description":"Projekt anlegen"}]'::JSONB
        )
        RETURNING id
        "#,
    )
    .bind(chat_id_sql)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();

    rpc.mutation(
        "llm.proposals.review",
        json!({
            "proposalId": Id(proposal_id).encode(),
            "decision": "requestRevision",
            "comment": "Bitte eine Adresse ergänzen.",
        }),
        Some(token),
    )
    .await;

    let reviewed_status: String =
        sqlx::query_scalar("SELECT status FROM llm_change_proposals WHERE id = $1")
            .bind(proposal_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(reviewed_status, "revision_requested");

    let accepted_proposal_id: i64 = sqlx::query_scalar(
        r#"
        INSERT INTO llm_change_proposals (
          chat_id,
          title,
          summary,
          operations
        )
        VALUES (
          $1,
          'Projekt anlegen',
          'Vorschau für einen Schreibvorgang im Benutzerkontext.',
          '[{"path":"projects.create","input":{"title":"LLM Prüfprojekt"},"description":"Projekt anlegen"}]'::JSONB
        )
        RETURNING id
        "#,
    )
    .bind(chat_id_sql)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();

    // This mirrors the browser's accept flow: execute the ordinary mutation
    // with the user's token first, then mark the preview as accepted.
    let created_project = rpc
        .mutation(
            "projects.create",
            json!({ "title": "LLM Prüfprojekt" }),
            Some(token),
        )
        .await;
    let created_project = rpc
        .query(
            "projects.get",
            json!({ "id": created_project["id"] }),
            Some(token),
        )
        .await;
    assert_eq!(created_project["title"], "LLM Prüfprojekt");

    rpc.mutation(
        "llm.proposals.review",
        json!({
            "proposalId": Id(accepted_proposal_id).encode(),
            "decision": "accept",
            "comment": null,
            "executionResults": [{
                "path": "projects.create",
                "output": { "id": created_project["id"] }
            }],
        }),
        Some(token),
    )
    .await;

    let accepted_status: String =
        sqlx::query_scalar("SELECT status FROM llm_change_proposals WHERE id = $1")
            .bind(accepted_proposal_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(accepted_status, "accepted");

    let execution_results: Value =
        sqlx::query_scalar("SELECT execution_results FROM llm_change_proposals WHERE id = $1")
            .bind(accepted_proposal_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(execution_results[0]["path"], "projects.create");
    assert_eq!(execution_results[0]["output"]["id"], created_project["id"]);

    let tenant_usage = rpc.query("llm.admin.usage", Value::Null, Some(token)).await;
    assert!(tenant_usage.as_array().unwrap().iter().any(|row| {
        row["provider"] == "openai"
            && row["model"] == "gpt-5.6-luna"
            && row["requestCount"] == 5
            && row["failedRequests"] == 0
    }));
    assert!(tenant_usage.as_array().unwrap().iter().any(|row| {
        row["provider"] == "custom"
            && row["model"] == "integration-unavailable-model"
            && row["failedRequests"] == 1
    }));

    let global_usage = rpc
        .query("admin.llm.usage", Value::Null, Some(admin_token))
        .await;
    assert!(
        global_usage
            .as_array()
            .unwrap()
            .iter()
            .any(|row| { row["tenant"] == fixture.tenant && row["failedRequests"] == 1 })
    );

    rpc.mutation(
        "llm.chats.delete",
        json!({ "chatId": chat_id }),
        Some(token),
    )
    .await;
}

#[tokio::test]
async fn managed_database_backups_restore_and_fork_use_real_postgres_and_s3() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let admin_password = env::var("TEST_ADMIN_PASSWORD")
        .expect("scripts/test-api must provide the global test admin password");
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let login = rpc
        .mutation(
            "admin.login",
            json!({ "tenant": null, "password": admin_password }),
            None,
        )
        .await;
    let admin_token = login["token"].as_str().unwrap().to_owned();

    let master_url = Url::parse(&environment.master_dsn).unwrap();
    let postgres_host = master_url.host_str().unwrap();
    let postgres_port = master_url.port().unwrap_or(5432);
    let postgres_user = master_url.username();
    let postgres_password = master_url.password().unwrap_or("dev-postgres");
    let suffix = unique_suffix();

    let host = rpc
        .mutation(
            "admin.databases.hosts.create",
            json!({
                "name": format!("backup-host-{suffix}"),
                "connectionDetails": {
                    "host": postgres_host,
                    "port": postgres_port,
                    "adminDatabase": "postgres",
                    "adminUsername": postgres_user,
                    "adminPassword": postgres_password,
                },
                "backupDetails": {
                    "enabled": true,
                    "bucket": environment.s3_bucket,
                    "region": environment.s3_region,
                    "endpoint": environment.s3_endpoint,
                    "publicBaseUrl": environment.s3_public_base_url,
                    "forcePathStyle": true,
                    "accessKeyId": environment.s3_access_key_id,
                    "secretAccessKey": environment.s3_secret_access_key,
                    "keyPrefix": format!("integration/backups/{suffix}"),
                },
            }),
            Some(&admin_token),
        )
        .await;

    let disposable_host = rpc
        .mutation(
            "admin.databases.hosts.create",
            json!({
                "name": format!("disposable-host-{suffix}"),
                "connectionDetails": {
                    "host": postgres_host,
                    "port": postgres_port,
                    "adminDatabase": "postgres",
                    "adminUsername": postgres_user,
                    "adminPassword": postgres_password,
                },
                "backupDetails": { "enabled": false },
            }),
            Some(&admin_token),
        )
        .await;
    let updated_disposable_host = rpc
        .mutation(
            "admin.databases.hosts.update",
            json!({
                "hostId": disposable_host["id"],
                "data": { "name": format!("updated-disposable-host-{suffix}") },
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(
        updated_disposable_host["name"],
        format!("updated-disposable-host-{suffix}")
    );
    let hosts = rpc
        .query(
            "admin.databases.hosts.list",
            Value::Null,
            Some(&admin_token),
        )
        .await;
    assert!(
        hosts
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == host["id"])
    );
    rpc.mutation(
        "admin.databases.hosts.delete",
        json!({ "hostId": disposable_host["id"] }),
        Some(&admin_token),
    )
    .await;

    let database_name = format!("backup_{suffix}");
    let database_username = format!("backup_user_{suffix}");
    let database = rpc
        .mutation(
            "admin.databases.create",
            json!({
                "hostId": host["id"],
                "name": database_name,
                "username": database_username,
                "retentionDaily": 7,
                "retentionWeekly": 4,
                "retentionMonthly": 12,
                "retentionYearly": 1,
            }),
            Some(&admin_token),
        )
        .await;

    let databases = rpc
        .query("admin.databases.list", Value::Null, Some(&admin_token))
        .await;
    assert!(
        databases
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == database["id"])
    );
    let retention = rpc
        .mutation(
            "admin.databases.updateRetention",
            json!({
                "databaseId": database["id"],
                "data": {
                    "retentionDaily": 8,
                    "retentionWeekly": 5,
                    "retentionMonthly": 13,
                    "retentionYearly": 2,
                },
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(retention["retentionDaily"], 8);

    let database_dsn = managed_database_dsn(
        &environment.master_dsn,
        database["name"].as_str().unwrap(),
        database["username"].as_str().unwrap(),
        database["password"].as_str().unwrap(),
    );
    let database_pool = PgPool::connect(&database_dsn).await.unwrap();
    sqlx::query("CREATE TABLE backup_probe (id BIGINT PRIMARY KEY, value TEXT NOT NULL)")
        .execute(&database_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO backup_probe (id, value) VALUES (1, 'baseline')")
        .execute(&database_pool)
        .await
        .unwrap();

    let backup = rpc
        .mutation(
            "admin.databases.backups.createNow",
            json!({ "databaseId": database["id"], "kind": "manual" }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(backup["state"], "uploaded");
    assert!(backup["sizeBytes"].as_i64().unwrap() > 0);

    let backups = rpc
        .query(
            "admin.databases.backups.list",
            json!({ "databaseId": database["id"], "includeFailed": true }),
            Some(&admin_token),
        )
        .await;
    assert!(
        backups
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == backup["id"])
    );

    let download = rpc
        .query(
            "admin.databases.backups.downloadUrl",
            json!({ "backupId": backup["id"], "expiresInSec": 300 }),
            Some(&admin_token),
        )
        .await;
    let downloaded_backup = rpc
        .http
        .get(download["downloadUrl"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert!(downloaded_backup.status().is_success());
    let downloaded_backup = downloaded_backup.bytes().await.unwrap();
    assert!(downloaded_backup.starts_with(&[0x1f, 0x8b]));
    let mut dumped_sql = String::new();
    GzDecoder::new(downloaded_backup.as_ref())
        .read_to_string(&mut dumped_sql)
        .unwrap();
    assert!(
        dumped_sql.contains("backup_probe"),
        "downloaded dump did not contain the probe table:\n{dumped_sql}"
    );
    assert!(dumped_sql.contains("baseline"));

    sqlx::query("DELETE FROM backup_probe")
        .execute(&database_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO backup_probe (id, value) VALUES (2, 'changed')")
        .execute(&database_pool)
        .await
        .unwrap();
    database_pool.close().await;

    let restore = rpc
        .mutation(
            "admin.databases.backups.restore",
            json!({
                "backupId": backup["id"],
                "targetDatabaseId": database["id"],
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(restore["backupId"], backup["id"]);
    assert_eq!(restore["targetDatabaseId"], database["id"]);

    let restored_pool = PgPool::connect(&database_dsn).await.unwrap();
    let restored_tables = sqlx::query_as::<_, (String, String)>(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2",
    )
    .fetch_all(&restored_pool)
    .await
    .unwrap();
    assert!(
        restored_tables
            .iter()
            .any(|(schema, table)| schema == "public" && table == "backup_probe"),
        "restored tables: {restored_tables:?}"
    );

    let restored_rows =
        sqlx::query_as::<_, (i64, String)>("SELECT id, value FROM backup_probe ORDER BY id")
            .fetch_all(&restored_pool)
            .await
            .unwrap();
    assert_eq!(restored_rows, vec![(1, "baseline".to_owned())]);
    restored_pool.close().await;

    let fork_name = format!("backup_fork_{suffix}");
    let fork_username = format!("backup_fork_user_{suffix}");
    let fork = rpc
        .mutation(
            "admin.databases.forkFromBackup",
            json!({
                "backupId": backup["id"],
                "name": fork_name,
                "username": fork_username,
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(fork["restoredFromBackupId"], backup["id"]);

    let fork_dsn = managed_database_dsn(
        &environment.master_dsn,
        fork["name"].as_str().unwrap(),
        fork["username"].as_str().unwrap(),
        fork["password"].as_str().unwrap(),
    );
    let fork_pool = PgPool::connect(&fork_dsn).await.unwrap();
    let fork_rows =
        sqlx::query_as::<_, (i64, String)>("SELECT id, value FROM backup_probe ORDER BY id")
            .fetch_all(&fork_pool)
            .await
            .unwrap();
    assert_eq!(fork_rows, vec![(1, "baseline".to_owned())]);
    fork_pool.close().await;

    let uploaded_sql = b"CREATE TABLE uploaded_probe (value TEXT NOT NULL);\n\
INSERT INTO uploaded_probe (value) VALUES ('uploaded backup');\n";
    let uploaded = rpc
        .mutation(
            "admin.databases.backups.upload",
            json!({
                "databaseId": database["id"],
                "fileName": "manual.sql",
                "fileBase64": STANDARD.encode(uploaded_sql),
            }),
            Some(&admin_token),
        )
        .await;
    assert_eq!(uploaded["state"], "uploaded");

    let upload_fork_name = format!("upload_fork_{suffix}");
    let upload_fork_username = format!("upload_fork_user_{suffix}");
    let upload_fork = rpc
        .mutation(
            "admin.databases.forkFromBackup",
            json!({
                "backupId": uploaded["id"],
                "name": upload_fork_name,
                "username": upload_fork_username,
            }),
            Some(&admin_token),
        )
        .await;

    let upload_fork_dsn = managed_database_dsn(
        &environment.master_dsn,
        upload_fork["name"].as_str().unwrap(),
        upload_fork["username"].as_str().unwrap(),
        upload_fork["password"].as_str().unwrap(),
    );
    let upload_fork_pool = PgPool::connect(&upload_fork_dsn).await.unwrap();
    let uploaded_value = sqlx::query_scalar::<_, String>("SELECT value FROM uploaded_probe")
        .fetch_one(&upload_fork_pool)
        .await
        .unwrap();
    assert_eq!(uploaded_value, "uploaded backup");
    upload_fork_pool.close().await;

    let master = PgPool::connect(&environment.master_dsn).await.unwrap();
    let stored_backup_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM __postgres_database_backups WHERE database_id = $1",
    )
    .bind(database["id"].as_str().unwrap().parse::<i64>().unwrap())
    .fetch_one(&master)
    .await
    .unwrap();
    assert_eq!(stored_backup_count, 2);

    let rotated = rpc
        .mutation(
            "admin.databases.rotateCredentials",
            json!({ "databaseId": database["id"] }),
            Some(&admin_token),
        )
        .await;
    assert_ne!(rotated["password"], database["password"]);
    let rotated_dsn = managed_database_dsn(
        &environment.master_dsn,
        database["name"].as_str().unwrap(),
        database["username"].as_str().unwrap(),
        rotated["password"].as_str().unwrap(),
    );
    let rotated_pool = PgPool::connect(&rotated_dsn).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM backup_probe WHERE id = 1")
            .fetch_one(&rotated_pool)
            .await
            .unwrap(),
        "baseline",
    );
    rotated_pool.close().await;
}

#[tokio::test]
async fn passkey_registration_and_both_login_modes_use_real_postgres() {
    let Some(environment) = TestEnvironment::from_env() else {
        eprintln!("skipping network scenarios: live infrastructure is not configured");
        return;
    };

    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url.clone());
    let origin = environment.api_base_url;

    rpc.expect_error(
        "auth.passkeys.list",
        Method::GET,
        Value::Null,
        None,
        "UNAUTHORIZED",
    )
    .await;

    let login = rpc
        .mutation(
            "auth.login",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
                "password": fixture.admin_password,
            }),
            None,
        )
        .await;
    let token = login["token"].as_str().unwrap().to_owned();

    let initial = rpc
        .query("auth.passkeys.list", Value::Null, Some(&token))
        .await;
    assert!(initial.as_array().unwrap().is_empty());

    let registration_start = rpc
        .mutation_with_origin(
            "auth.passkeys.registerOptions",
            Value::Null,
            Some(&token),
            &origin,
        )
        .await;
    let rp_id = registration_start["options"]["rp"]["id"].as_str().unwrap();
    assert_eq!(rp_id, "127.0.0.1");

    let passkey = PasskeyFixture::new();
    rpc.mutation_with_origin(
        "auth.passkeys.register",
        json!({
            "challengeToken": registration_start["challengeToken"],
            "label": "Integration Passkey",
            "credential": passkey.registration_credential(
                registration_start["options"]["challenge"].as_str().unwrap(),
                &origin,
                rp_id,
            ),
        }),
        Some(&token),
        &origin,
    )
    .await;

    let registered = rpc
        .query("auth.passkeys.list", Value::Null, Some(&token))
        .await;
    assert_eq!(registered.as_array().unwrap().len(), 1);
    assert_eq!(registered[0]["label"], "Integration Passkey");

    let login_start = rpc
        .mutation_with_origin(
            "auth.passkeys.loginOptions",
            json!({
                "tenant": fixture.tenant,
                "username": fixture.admin_username,
            }),
            None,
            &origin,
        )
        .await;
    assert_eq!(
        login_start["options"]["allowCredentials"][0]["id"],
        passkey.credential_id
    );

    let passkey_login = rpc
        .mutation_with_origin(
            "auth.passkeys.login",
            json!({
                "challengeToken": login_start["challengeToken"],
                "credential": passkey.assertion_credential(
                    login_start["options"]["challenge"].as_str().unwrap(),
                    &origin,
                    login_start["options"]["rpId"].as_str().unwrap(),
                    1,
                    None,
                ),
            }),
            None,
            &origin,
        )
        .await;
    let passkey_token = passkey_login["token"].as_str().unwrap();
    let session = rpc
        .query("auth.sessionInfo", Value::Null, Some(passkey_token))
        .await;
    assert_eq!(session["user"]["username"], fixture.admin_username);

    let discoverable_start = rpc
        .mutation_with_origin("auth.passkeys.loginOptions", Value::Null, None, &origin)
        .await;
    assert!(
        discoverable_start["options"]["allowCredentials"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let discoverable_login = rpc
        .mutation_with_origin(
            "auth.passkeys.login",
            json!({
                "challengeToken": discoverable_start["challengeToken"],
                "credential": passkey.assertion_credential(
                    discoverable_start["options"]["challenge"].as_str().unwrap(),
                    &origin,
                    discoverable_start["options"]["rpId"].as_str().unwrap(),
                    2,
                    registration_start["options"]["user"]["id"].as_str(),
                ),
            }),
            None,
            &origin,
        )
        .await;
    assert!(discoverable_login["token"].as_str().is_some());

    let stored_passkey = sqlx::query_as::<_, (String, i64, bool)>(
        "SELECT credential_id, sign_count, last_used_at IS NOT NULL FROM user_passkeys WHERE user_id = $1",
    )
    .bind(fixture.user_id)
    .fetch_one(&fixture.tenant_pool)
    .await
    .unwrap();
    assert_eq!(stored_passkey.0, passkey.credential_id);
    assert_eq!(stored_passkey.1, 2);
    assert!(stored_passkey.2);

    rpc.mutation(
        "auth.passkeys.delete",
        json!({ "id": registered[0]["id"] }),
        Some(&token),
    )
    .await;
    let remaining =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_passkeys WHERE user_id = $1")
            .bind(fixture.user_id)
            .fetch_one(&fixture.tenant_pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
}

async fn settings_scenarios(rpc: &RpcClient, token: &str) {
    let mut session = rpc
        .query("auth.sessionInfo", Value::Null, Some(token))
        .await;
    assert_eq!(session["user"]["locale"], "de");

    rpc.mutation(
        "settings.language.set",
        json!({ "locale": "en" }),
        Some(token),
    )
    .await;

    session = rpc
        .query("auth.sessionInfo", Value::Null, Some(token))
        .await;
    assert_eq!(session["user"]["locale"], "en");

    rpc.expect_error(
        "settings.language.set",
        Method::POST,
        json!({ "locale": "fr" }),
        Some(token),
        "BAD_REQUEST",
    )
    .await;

    rpc.mutation(
        "settings.tenantName.set",
        json!({ "companyName": "Rust Scenario GmbH" }),
        Some(token),
    )
    .await;

    let tenant_name = rpc
        .query("settings.tenantName.get", Value::Null, Some(token))
        .await;

    assert_eq!(tenant_name["companyName"], "Rust Scenario GmbH");
}

async fn user_scenarios(rpc: &RpcClient, token: &str) -> String {
    let created = rpc
        .mutation(
            "users.create",
            json!({
                "username": "scenario.user",
                "firstName": "Scenario",
                "lastName": "User",
                "email": "scenario.user@example.test",
                "contractType": "internal",
                "costPerHour": 42.5,
            }),
            Some(token),
        )
        .await;
    let id = created["id"].as_str().unwrap().to_owned();

    let user = rpc
        .query("users.get", json!({ "id": id }), Some(token))
        .await;
    assert_eq!(user["username"], "scenario.user");
    assert_eq!(user["costPerHour"], 42.5);

    rpc.mutation(
        "users.update",
        json!({
            "id": id,
            "data": {
                "firstName": "Updated",
                "phone": "+49 123 456",
            },
        }),
        Some(token),
    )
    .await;

    let users = rpc
        .query(
            "users.list",
            json!({
                "search": "scenario.user",
                "includeArchived": true,
            }),
            Some(token),
        )
        .await;
    assert_eq!(users.as_array().unwrap().len(), 1);
    assert_eq!(users[0]["firstName"], "Updated");

    id
}

async fn customer_scenarios(rpc: &RpcClient, token: &str) -> String {
    let created = rpc
        .mutation(
            "customers.create",
            json!({
                "name": "Scenario Customer",
                "address": {
                    "streetAddress": "Rustweg 1",
                    "zip": "12345",
                    "city": "Berlin",
                    "country": "DE",
                },
                "phoneNumbers": [{ "name": "Büro", "number": "+49 30 123" }],
                "emailAddresses": [{ "name": "Büro", "email": "customer@example.test" }],
            }),
            Some(token),
        )
        .await;
    let id = created["id"].as_str().unwrap().to_owned();

    let listed = rpc
        .query(
            "customers.list",
            json!({ "search": "Scenario Customer" }),
            Some(token),
        )
        .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);

    rpc.mutation(
        "customers.update",
        json!({
            "id": id,
            "data": { "salutation": "Firma" },
        }),
        Some(token),
    )
    .await;
    let fetched = rpc
        .query("customers.get", json!({ "id": id }), Some(token))
        .await;
    assert_eq!(fetched["salutation"], "Firma");

    let deletable = rpc
        .mutation(
            "customers.create",
            json!({ "name": "Delete Customer" }),
            Some(token),
        )
        .await;
    rpc.mutation(
        "customers.delete",
        json!({ "id": deletable["id"] }),
        Some(token),
    )
    .await;

    id
}

async fn contact_scenarios(rpc: &RpcClient, token: &str) -> String {
    let created = rpc
        .mutation(
            "contacts.create",
            json!({
                "firstName": "Ferris",
                "lastName": "Rust",
                "emailAddresses": [{ "email": "ferris@example.test" }],
            }),
            Some(token),
        )
        .await;
    let id = created["id"].as_str().unwrap().to_owned();

    let contact = rpc
        .query("contacts.get", json!({ "id": id }), Some(token))
        .await;
    assert_eq!(contact["lastName"], "Rust");

    rpc.mutation(
        "contacts.update",
        json!({ "id": id, "data": { "firstName": "Updated Ferris" } }),
        Some(token),
    )
    .await;
    let listed = rpc
        .query(
            "contacts.list",
            json!({ "search": "Updated Ferris" }),
            Some(token),
        )
        .await;
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == id)
    );

    let deletable = rpc
        .mutation(
            "contacts.create",
            json!({ "firstName": "Delete", "lastName": "Contact" }),
            Some(token),
        )
        .await;
    rpc.mutation(
        "contacts.delete",
        json!({ "id": deletable["id"] }),
        Some(token),
    )
    .await;

    id
}

async fn project_scenarios(
    rpc: &RpcClient,
    token: &str,
    customer_id: &str,
    contact_id: &str,
) -> String {
    let created = rpc
        .mutation(
            "projects.create",
            json!({
                "title": "Rust Migration Scenario",
                "customerId": customer_id,
                "address": {
                    "streetAddress": "Borrow Checker 7",
                    "city": "Leipzig",
                },
            }),
            Some(token),
        )
        .await;
    let id = created["id"].as_str().unwrap().to_owned();

    rpc.mutation(
        "projects.contacts.add",
        json!({
            "projectId": id,
            "contactId": contact_id,
            "label": "Bauleitung",
        }),
        Some(token),
    )
    .await;

    let contacts = rpc
        .query(
            "projects.contacts.list",
            json!({ "projectId": id }),
            Some(token),
        )
        .await;
    assert_eq!(contacts.as_array().unwrap().len(), 1);

    let projects = rpc
        .query(
            "projects.list",
            json!({ "search": "Rust Migration" }),
            Some(token),
        )
        .await;
    assert_eq!(projects.as_array().unwrap().len(), 1);

    id
}

async fn product_scenarios(rpc: &RpcClient, token: &str) {
    let created = rpc
        .mutation(
            "products.create",
            json!({
                "customId": 7001,
                "name": "Rust Schraube",
                "baseUnit": "Stk",
                "brand": "Ferris",
                "otherUnits": { "Karton": 100 },
            }),
            Some(token),
        )
        .await;
    let id = created["id"].as_str().unwrap();

    rpc.mutation(
        "products.categories.tag",
        json!({
            "id": id,
            "category": "Migration",
        }),
        Some(token),
    )
    .await;

    let product = rpc
        .query("products.get", json!({ "id": id }), Some(token))
        .await;
    assert_eq!(product["name"], "Rust Schraube");
    assert_eq!(product["categories"], json!(["Migration"]));
}

async fn tool_scenarios(rpc: &RpcClient, token: &str, user_id: &str, project_id: &str) {
    let created = rpc
        .mutation(
            "tools.create",
            json!({
                "customId": 8001,
                "brand": "Rust",
                "category": "Compiler",
                "label": "Clippy",
                "usageCostPerDay": 12.5,
            }),
            Some(token),
        )
        .await;
    let tool_id = created["id"].as_str().unwrap().to_owned();

    let tracking = rpc
        .mutation(
            "tools.track",
            json!({
                "id": tool_id,
                "data": {
                    "responsibleUserId": user_id,
                    "projectId": project_id,
                    "comment": "Network scenario",
                },
            }),
            Some(token),
        )
        .await;
    assert!(tracking["trackingId"].as_str().is_some());

    let listed = rpc
        .query(
            "tools.trackings.list",
            json!({
                "toolId": tool_id,
                "finished": false,
            }),
            Some(token),
        )
        .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);

    rpc.mutation("tools.untrack", json!({ "id": tool_id }), Some(token))
        .await;
}

async fn regie_report_timezone_scenario(
    rpc: &RpcClient,
    token: &str,
    user_id: &str,
    project_id: &str,
) {
    // The browser sends local midnight together with the offset that applied
    // on that specific day. The UTC API container must preserve the selected
    // Monday-through-Wednesday calendar dates.
    let input = json!({
        "json": {
            "projectId": project_id,
            "day": "2026-08-17T00:00:00.000+02:00",
            "summary": "Timezone regression scenario",
            "products": [],
            "specialRecords": [],
            "workHours": [
                {
                    "userId": user_id,
                    "day": "2026-08-17T00:00:00.000+02:00",
                    "hours": 2,
                },
                {
                    "userId": user_id,
                    "day": "2026-08-18T00:00:00.000+02:00",
                    "hours": 1,
                },
                {
                    "userId": user_id,
                    "day": "2026-08-19T00:00:00.000+02:00",
                    "hours": 3.5,
                },
            ],
        },
    });

    let created = rpc
        .mutation_envelope("regieReports.create", input, Some(token))
        .await;
    let report_id = created["id"].as_str().unwrap();

    let report = rpc
        .query("regieReports.get", json!({ "id": report_id }), Some(token))
        .await;

    assert_eq!(report["day"], "2026-08-17T00:00:00.000Z");

    let mut stored_days = report["workHours"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["day"].as_str().unwrap())
        .collect::<Vec<_>>();
    stored_days.sort_unstable();

    assert_eq!(
        stored_days,
        [
            "2026-08-17T00:00:00.000Z",
            "2026-08-18T00:00:00.000Z",
            "2026-08-19T00:00:00.000Z",
        ],
    );
}

async fn script_and_remark_scenarios(rpc: &RpcClient, token: &str, project_id: &str) {
    let script = rpc
        .mutation(
            "clientScripts.create",
            json!({
                "name": "Scenario Script",
                "description": "Created by the Rust network suite",
                "code": "return true;",
                "enabled": true,
            }),
            Some(token),
        )
        .await;
    assert_eq!(script["name"], "Scenario Script");

    let remark = rpc
        .mutation(
            "remarks.create",
            json!({
                "resourceType": "project",
                "resourceId": project_id,
                "body": "The native Rust wire path works.",
            }),
            Some(token),
        )
        .await;
    assert!(remark["id"].is_string());

    let remarks = rpc
        .query(
            "remarks.list",
            json!({
                "resourceType": "project",
                "resourceId": project_id,
            }),
            Some(token),
        )
        .await;
    assert_eq!(remarks.as_array().unwrap().len(), 1);
}

#[derive(Clone)]
struct TestEnvironment {
    master_dsn: String,
    api_base_url: String,
    s3_endpoint: String,
    s3_public_base_url: String,
    s3_region: String,
    s3_bucket: String,
    s3_access_key_id: String,
    s3_secret_access_key: String,
}

impl TestEnvironment {
    fn from_env() -> Option<Self> {
        let s3_endpoint = env::var("TEST_S3_ENDPOINT").ok()?;

        Some(Self {
            master_dsn: env::var("PG_MASTER_DSN").ok()?,
            api_base_url: env::var("TEST_API_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:3000".to_owned()),
            s3_public_base_url: env::var("TEST_S3_PUBLIC_BASE_URL")
                .unwrap_or_else(|_| s3_endpoint.clone()),
            s3_endpoint,
            s3_region: env::var("TEST_S3_REGION").ok()?,
            s3_bucket: env::var("TEST_S3_BUCKET").ok()?,
            s3_access_key_id: env::var("TEST_S3_ACCESS_KEY_ID").ok()?,
            s3_secret_access_key: env::var("TEST_S3_SECRET_ACCESS_KEY").ok()?,
        })
    }
}

struct Fixture {
    tenant: String,
    admin_username: String,
    admin_password: String,
    tenant_pool: PgPool,
    user_id: i64,
}

impl Fixture {
    async fn create(environment: &TestEnvironment) -> Self {
        let unique = unique_suffix();
        let tenant = format!("rust-scenario-{unique}");
        let database_name = format!("rust_scenario_{unique}");
        let admin_username = "scenario.admin".to_owned();
        let admin_password = "Scenario-Password-123!".to_owned();

        let master = PgPoolOptions::new()
            .max_connections(2)
            .connect(&environment.master_dsn)
            .await
            .unwrap();
        let mut postgres_url = Url::parse(&environment.master_dsn).unwrap();
        postgres_url.set_path("/postgres");
        let postgres = PgPoolOptions::new()
            .max_connections(1)
            .connect(postgres_url.as_str())
            .await
            .unwrap();

        sqlx::query(&format!("CREATE DATABASE \"{database_name}\""))
            .execute(&postgres)
            .await
            .unwrap();

        let mut tenant_url = Url::parse(&environment.master_dsn).unwrap();
        tenant_url.set_path(&format!("/{database_name}"));
        let tenant_dsn = tenant_url.to_string();
        let tenant_pool = PgPool::connect(&tenant_dsn).await.unwrap();

        migrations::apply(tenant_pool.clone()).await.unwrap();

        sqlx::query(
            r#"
            INSERT INTO __tenants (
                name,
                admin_hash,
                disabled,
                contact_details,
                connection_details,
                options
            )
            VALUES ($1, $2, FALSE, $3, $4, '{}'::JSONB)
            "#,
        )
        .bind(&tenant)
        .bind("not-used-by-user-login")
        .bind(json!({
            "email": "scenario@example.test",
            "companyName": "Initial Scenario GmbH",
        }))
        .bind(json!({
            "postgresDSN": tenant_dsn,
            "objectStorage": {
                "enabled": true,
                "provider": "s3",
                "bucket": environment.s3_bucket,
                "region": environment.s3_region,
                "endpoint": environment.s3_endpoint,
                "publicBaseUrl": environment.s3_public_base_url,
                "forcePathStyle": true,
                "accessKeyId": environment.s3_access_key_id,
                "secretAccessKey": environment.s3_secret_access_key,
                "keyPrefix": format!("integration/{tenant}"),
                "uploadUrlTtlSec": 300,
                "downloadUrlTtlSec": 300,
            },
        }))
        .execute(&master)
        .await
        .unwrap();

        let password_hash = hash(&admin_password, 4).unwrap();
        let user_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO users (
                username,
                first_name,
                password,
                deactivated_at
            )
            VALUES ($1, 'Scenario Admin', $2, NULL)
            RETURNING id
            "#,
        )
        .bind(&admin_username)
        .bind(password_hash)
        .fetch_one(&tenant_pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO user_role_assignments (user_id, role_name) VALUES ($1, ':admin')")
            .bind(user_id)
            .execute(&tenant_pool)
            .await
            .unwrap();

        Self {
            tenant,
            admin_username,
            admin_password,
            tenant_pool,
            user_id,
        }
    }
}

type OpenAiRequestLog = std::sync::Arc<Mutex<Vec<Value>>>;

async fn start_openai_responses_mock() -> (String, OpenAiRequestLog) {
    let requests = OpenAiRequestLog::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/responses", post(mock_openai_response))
        .with_state(std::sync::Arc::clone(&requests));

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{address}"), requests)
}

async fn mock_openai_response(
    State(requests): State<OpenAiRequestLog>,
    Json(request): Json<Value>,
) -> Json<Value> {
    let input = request["input"].as_array().unwrap();
    let latest_user_content = input
        .iter()
        .rev()
        .find(|item| item["role"] == "user")
        .and_then(|item| item["content"].as_str());
    let is_proposal_request = latest_user_content
        == Some(
            "Lege das Projekt „Test Projekt LLM“ mit der Adresse „Musterstr. 42, Musterstadt“ an.",
        );
    let is_tracking_request =
        latest_user_content == Some("Welches Werkzeug hat Tobias Schneider aktuell?");
    let is_inventory_request = latest_user_content
        == Some("Wurde der Bosch-Bohrhammer in den letzten 30 Tagen inventarisiert?");
    let is_common_costs_request =
        latest_user_content == Some("Wie hoch sind die aktuellen Gemeinkosten?");
    let last_tool_output = input
        .iter()
        .rev()
        .find(|item| item["type"] == "function_call_output")
        .and_then(|item| item["output"].as_str())
        .and_then(|output| serde_json::from_str::<Value>(output).ok());
    requests.lock().await.push(request);

    let output = if is_proposal_request {
        match last_tool_output {
            None => json!([{
                "type": "function_call",
                "id": "fc_project_schema",
                "call_id": "call_project_schema",
                "name": "sortsys_get_schema",
                "arguments": r#"{"path":"projects.create"}"#
            }]),
            Some(result) if result["path"] == "projects.create" => json!([{
                "type": "function_call",
                "id": "fc_invalid_address_proposal",
                "call_id": "call_invalid_address_proposal",
                "name": "sortsys_propose_change",
                "arguments": serde_json::to_string(&json!({
                    "title": "Test Projekt LLM",
                    "summary": "Legt das gewünschte Projekt nach Freigabe an.",
                    "operations": [{
                        "path": "projects.create",
                        "input": {
                            "title": "Test Projekt LLM",
                            "address": "Musterstr. 42, Musterstadt"
                        },
                        "description": "Projekt mit Adresse anlegen"
                    }]
                })).unwrap()
            }]),
            Some(result) if result.get("error").is_some() => json!([{
                "type": "function_call",
                "id": "fc_corrected_address_proposal",
                "call_id": "call_corrected_address_proposal",
                "name": "sortsys_propose_change",
                "arguments": serde_json::to_string(&json!({
                    "title": "Test Projekt LLM",
                    "summary": "Legt das gewünschte Projekt nach Freigabe an.",
                    "operations": [{
                        "path": "projects.create",
                        "input": {
                            "title": "Test Projekt LLM",
                            "address": {
                                "streetAddress": "Musterstr. 42",
                                "city": "Musterstadt"
                            }
                        },
                        "description": "Projekt mit Adresse anlegen"
                    }]
                })).unwrap()
            }]),
            Some(result) if result.get("proposalId").is_some() => json!([{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<proposal-only>"
                }]
            }]),
            Some(result) => panic!("unexpected proposal tool result: {result}"),
        }
    } else if is_tracking_request {
        match last_tool_output {
            None => json!([{
                "type": "function_call",
                "id": "fc_tool_trackings",
                "call_id": "call_tool_trackings",
                "name": "sortsys_search",
                "arguments": r#"{"resource":"tool_trackings","query":"Tobias Schneider","limit":10}"#
            }]),
            Some(result) if !result["records"].as_array().unwrap().is_empty() => json!([{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "Tobias Schneider hat aktuell den Bohrhammer GBH 18V-26 von Bosch Professional."
                }]
            }]),
            Some(result) => panic!("unexpected tool-tracking result: {result}"),
        }
    } else if is_inventory_request {
        match last_tool_output {
            None => json!([{
                "type": "function_call",
                "id": "fc_tool_inventories",
                "call_id": "call_tool_inventories",
                "name": "sortsys_search",
                "arguments": r#"{"resource":"tool_inventories","query":"Bosch","limit":10,"days":30,"hadInventory":true}"#
            }]),
            Some(result) if !result["records"].as_array().unwrap().is_empty() => json!([{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "Der Bosch-Bohrhammer wurde innerhalb der letzten 30 Tage inventarisiert."
                }]
            }]),
            Some(result) => panic!("unexpected tool-inventory result: {result}"),
        }
    } else if is_common_costs_request {
        match last_tool_output {
            None => json!([{
                "type": "function_call",
                "id": "fc_common_cost_catalog",
                "call_id": "call_common_cost_catalog",
                "name": "sortsys_find_procedures",
                "arguments": r#"{"query":"Gemeinkosten","kind":"query"}"#
            }]),
            Some(result) if result.get("procedures").is_some() => json!([{
                "type": "function_call",
                "id": "fc_common_cost_schema",
                "call_id": "call_common_cost_schema",
                "name": "sortsys_get_schema",
                "arguments": r#"{"path":"settings.costs.get"}"#
            }]),
            Some(result)
                if result["path"] == "settings.costs.get"
                    && result.get("inputSchema").is_some() =>
            {
                json!([{
                    "type": "function_call",
                    "id": "fc_common_cost_query",
                    "call_id": "call_common_cost_query",
                    "name": "sortsys_query",
                    "arguments": r#"{"path":"settings.costs.get"}"#
                }])
            }
            Some(result)
                if result["path"] == "settings.costs.get" && result.get("data").is_some() =>
            {
                json!([{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "Die aktuellen Gemeinkosten wurden aus den Mandanteneinstellungen geladen."
                    }]
                }])
            }
            Some(result) => panic!("unexpected common-cost result: {result}"),
        }
    } else if last_tool_output.is_some() {
        json!([{
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": "Die aktuelle Projektkostenübersicht wurde geladen."
            }]
        }])
    } else {
        json!([{
            "type": "function_call",
            "id": "fc_project_costs",
            "call_id": "call_project_costs",
            "name": "sortsys_search",
            "arguments": "{\"resource\":\"project_costs\",\"limit\":25}"
        }])
    };

    Json(json!({
        "id": "resp_test",
        "object": "response",
        "model": "gpt-5.6-luna",
        "output": output,
        "usage": {
            "input_tokens": 100,
            "output_tokens": 20,
            "total_tokens": 120
        }
    }))
}

fn last_function_output(request: &Value) -> Value {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|item| item["type"] == "function_call_output")
        .and_then(|item| item["output"].as_str())
        .map(|output| serde_json::from_str(output).unwrap())
        .expect("request must contain a function output")
}

struct RpcClient {
    http: Client,
    base_url: String,
}

impl RpcClient {
    fn new(base_url: String) -> Self {
        Self {
            http: Client::new(),
            base_url: base_url.trim_end_matches('/').to_owned(),
        }
    }

    async fn assert_batching(&self) {
        let input = json!({
            "0": { "json": null },
            "1": { "json": null },
        });

        let response: Value = self
            .http
            .get(format!("{}/ping,ping", self.base_url))
            .query(&[
                ("batch", "1"),
                ("input", &serde_json::to_string(&input).unwrap()),
            ])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(response[0]["result"]["data"]["json"], "pong");
        assert_eq!(response[1]["result"]["data"]["json"], "pong");
    }

    async fn query(&self, path: &str, input: Value, token: Option<&str>) -> Value {
        self.call(path, Method::GET, input, token)
            .await
            .unwrap_or_else(|error| panic!("{path} failed: {error}"))
    }

    async fn mutation(&self, path: &str, input: Value, token: Option<&str>) -> Value {
        self.call(path, Method::POST, input, token)
            .await
            .unwrap_or_else(|error| panic!("{path} failed: {error}"))
    }

    async fn mutation_with_origin(
        &self,
        path: &str,
        input: Value,
        token: Option<&str>,
        origin: &str,
    ) -> Value {
        self.call_envelope_with_origin(
            path,
            Method::POST,
            json!({ "json": input }),
            token,
            Some(origin),
        )
        .await
        .unwrap_or_else(|error| panic!("{path} failed: {error}"))
    }

    async fn mutation_envelope(&self, path: &str, envelope: Value, token: Option<&str>) -> Value {
        self.call_envelope_with_origin(path, Method::POST, envelope, token, None)
            .await
            .unwrap_or_else(|error| panic!("{path} failed: {error}"))
    }

    async fn expect_error(
        &self,
        path: &str,
        method: Method,
        input: Value,
        token: Option<&str>,
        expected_code: &str,
    ) {
        let error = self
            .call(path, method, input, token)
            .await
            .expect_err("RPC call unexpectedly succeeded");

        assert_eq!(error.code, expected_code);
    }

    async fn call(
        &self,
        path: &str,
        method: Method,
        input: Value,
        token: Option<&str>,
    ) -> Result<Value, RpcFailure> {
        self.call_envelope_with_origin(path, method, json!({ "json": input }), token, None)
            .await
    }

    async fn call_envelope_with_origin(
        &self,
        path: &str,
        method: Method,
        input_envelope: Value,
        token: Option<&str>,
        origin: Option<&str>,
    ) -> Result<Value, RpcFailure> {
        let envelope = json!({ "0": input_envelope });
        let mut request = self
            .http
            .request(method.clone(), format!("{}/{path}", self.base_url));

        request = if method == Method::GET {
            request.query(&[
                ("batch", "1"),
                ("input", &serde_json::to_string(&envelope).unwrap()),
            ])
        } else {
            request.query(&[("batch", "1")]).json(&envelope)
        };

        if let Some(origin) = origin {
            request = request.header("Origin", origin);
        }

        if let Some(token) = token {
            request = request.bearer_auth(token);
        }

        let response: Value = request.send().await.unwrap().json().await.unwrap();
        let response = &response[0];

        if let Some(error) = response.get("error") {
            return Err(RpcFailure {
                code: error["json"]["data"]["code"]
                    .as_str()
                    .unwrap_or("UNKNOWN")
                    .to_owned(),
                message: error["json"]["message"]
                    .as_str()
                    .unwrap_or("unknown RPC error")
                    .to_owned(),
            });
        }

        Ok(response["result"]["data"]["json"].clone())
    }
}

#[derive(Debug)]
struct RpcFailure {
    code: String,
    message: String,
}

impl std::fmt::Display for RpcFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

struct PasskeyFixture {
    credential_id: String,
    credential_id_bytes: Vec<u8>,
    signing_key: SigningKey,
}

impl PasskeyFixture {
    fn new() -> Self {
        let signing_key = SigningKey::random(&mut OsRng);
        let mut credential_id_bytes = vec![0_u8; 32];
        getrandom::fill(&mut credential_id_bytes).unwrap();
        let credential_id = URL_SAFE_NO_PAD.encode(&credential_id_bytes);

        Self {
            credential_id,
            credential_id_bytes,
            signing_key,
        }
    }

    fn registration_credential(&self, challenge: &str, origin: &str, rp_id: &str) -> Value {
        let encoded_point = self.signing_key.verifying_key().to_encoded_point(false);
        let cose_public_key = encode_cbor(&CborValue::Map(vec![
            (cbor_integer(1), cbor_integer(2)),
            (cbor_integer(3), cbor_integer(-7)),
            (cbor_integer(-1), cbor_integer(1)),
            (
                cbor_integer(-2),
                CborValue::Bytes(encoded_point.x().unwrap().to_vec()),
            ),
            (
                cbor_integer(-3),
                CborValue::Bytes(encoded_point.y().unwrap().to_vec()),
            ),
        ]));
        let authenticator_data = test_authenticator_data(
            rp_id,
            0,
            Some((&self.credential_id_bytes, &cose_public_key)),
        );
        let attestation = encode_cbor(&CborValue::Map(vec![
            (
                CborValue::Text("fmt".to_owned()),
                CborValue::Text("none".to_owned()),
            ),
            (
                CborValue::Text("attStmt".to_owned()),
                CborValue::Map(Vec::new()),
            ),
            (
                CborValue::Text("authData".to_owned()),
                CborValue::Bytes(authenticator_data),
            ),
        ]));
        let client_data = credential_client_data("webauthn.create", challenge, origin);

        json!({
            "id": self.credential_id,
            "rawId": self.credential_id,
            "type": "public-key",
            "response": {
                "clientDataJSON": URL_SAFE_NO_PAD.encode(client_data),
                "attestationObject": URL_SAFE_NO_PAD.encode(attestation),
            },
            "transports": ["internal"],
        })
    }

    fn assertion_credential(
        &self,
        challenge: &str,
        origin: &str,
        rp_id: &str,
        counter: u32,
        user_handle: Option<&str>,
    ) -> Value {
        let authenticator_data = test_authenticator_data(rp_id, counter, None);
        let client_data = credential_client_data("webauthn.get", challenge, origin);
        let mut signed_data = authenticator_data.clone();
        signed_data.extend_from_slice(&Sha256::digest(&client_data));
        let signature: Signature = self.signing_key.sign(&signed_data);

        json!({
            "id": self.credential_id,
            "rawId": self.credential_id,
            "type": "public-key",
            "response": {
                "clientDataJSON": URL_SAFE_NO_PAD.encode(client_data),
                "authenticatorData": URL_SAFE_NO_PAD.encode(authenticator_data),
                "signature": URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes()),
                "userHandle": user_handle,
            },
        })
    }
}

fn credential_client_data(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "type": kind,
        "challenge": challenge,
        "origin": origin,
    }))
    .unwrap()
}

fn test_authenticator_data(
    rp_id: &str,
    counter: u32,
    attested_credential: Option<(&[u8], &[u8])>,
) -> Vec<u8> {
    let mut data = Sha256::digest(rp_id.as_bytes()).to_vec();
    data.push(if attested_credential.is_some() {
        0x45
    } else {
        0x05
    });
    data.extend_from_slice(&counter.to_be_bytes());

    if let Some((credential_id, cose_public_key)) = attested_credential {
        data.extend_from_slice(&[0_u8; 16]);
        data.extend_from_slice(&(credential_id.len() as u16).to_be_bytes());
        data.extend_from_slice(credential_id);
        data.extend_from_slice(cose_public_key);
    }

    data
}

fn cbor_integer(value: i64) -> CborValue {
    CborValue::Integer(value.into())
}

fn encode_cbor(value: &CborValue) -> Vec<u8> {
    let mut encoded = Vec::new();
    ciborium::ser::into_writer(value, &mut encoded).unwrap();

    encoded
}

fn managed_database_dsn(
    master_dsn: &str,
    database: &str,
    username: &str,
    password: &str,
) -> String {
    let mut url = Url::parse(master_dsn).expect("valid master PostgreSQL URL");
    url.set_path(&format!("/{database}"));
    url.set_username(username).expect("valid managed username");
    url.set_password(Some(password))
        .expect("valid managed password");

    url.to_string()
}

fn unique_suffix() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let sequence = DATABASE_SEQUENCE.fetch_add(1, Ordering::Relaxed);

    format!("{:x}{sequence:x}", timestamp % 0xffff_ffff)
}
