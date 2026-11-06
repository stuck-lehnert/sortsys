//! One-shot development tenant bootstrap invoked by `scripts/dev`.

use sortsys_api::{AppState, config::Config, seed};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--write-gaeb-fixtures" {
        seed::write_validation_fixtures(std::path::Path::new(&args[2]), 42)?;
        return Ok(());
    }
    let state = AppState::connect(Config::from_env()?).await?;
    if args.len() == 2 && args[1] == "--extend-native-documents" {
        let tenant = std::env::var("DEV_TEST_TENANT_NAME").unwrap_or_else(|_| "test".to_owned());
        let pool = state.tenants.tenant_pool(&tenant).await?;
        let before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM commercial_documents WHERE phase='31'")
                .fetch_one(&pool)
                .await?;
        seed::extend_development(&state, &tenant, &pool, 42).await?;
        let after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM commercial_documents WHERE phase='31'")
                .fetch_one(&pool)
                .await?;
        println!(
            "Added {} native measurement examples for {tenant} ({after} total)",
            after - before
        );
        state.tenants.close().await;
        return Ok(());
    }
    let summary = seed::bootstrap_development(&state).await?;

    println!(
        "Seeded development tenant: {} users, {} projects, {} tools, {} products, {} delivery notes, {} deployments, {} vacations, {} project blocks, {} financial entries, {} remarks",
        summary.users,
        summary.projects,
        summary.tools,
        summary.products,
        summary.delivery_notes,
        summary.deployments,
        summary.vacations,
        summary.unavailability_periods,
        summary.financial_entries,
        summary.remarks,
    );
    println!(
        "Native examples: {} workflows, {} GAEB documents, {} project files",
        summary.commercial_cases, summary.commercial_documents, summary.project_files
    );
    println!("Development users: john.doe / 123456 (admin), frank.doe / 123456");

    state.tenants.close().await;
    Ok(())
}
