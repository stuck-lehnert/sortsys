//! One-shot development tenant bootstrap invoked by `scripts/dev`.

use sortsys_api::{AppState, config::Config, seed};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = AppState::connect(Config::from_env()?).await?;
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
    println!("Development users: john.doe / 123456 (admin), frank.doe / 123456");

    state.tenants.close().await;
    Ok(())
}
