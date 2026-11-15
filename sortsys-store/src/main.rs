use sortsys_store::server::{ServiceConfig, run};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if std::env::args().any(|argument| argument == "--health") {
        let response = reqwest::Client::new()
            .get("http://127.0.0.1:9495/health")
            .timeout(std::time::Duration::from_secs(4))
            .send()
            .await?;
        return if response.status().is_success() {
            Ok(())
        } else {
            Err("datastore is unavailable".into())
        };
    }
    tracing_subscriber::fmt().with_env_filter("info").init();
    run(ServiceConfig::from_env()?, async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install SIGTERM handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
