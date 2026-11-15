//! Production server entry point and graceful-shutdown wiring.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use sortsys_api::standalone::{self, Config};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sortsys_api=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env()?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), config.port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    let bound = listener.local_addr()?;
    let app = standalone::connect_at(&config, bound).await?;
    tracing::info!(address = %bound, "sortsys encrypted API listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
