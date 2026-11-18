//! Test-only process boundary for the production router. Never a deployment entry point.
use sortsys_api::{
    quack_store::QuackConfig,
    standalone::{self, Config},
};
use std::{env, io::Write, sync::Arc};

fn required(name: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok(env::var(format!("SORTSYS_ISOLATED_API_{name}"))?)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::var("SORTSYS_DISPOSABLE_AUTH_TEST").as_deref() != Ok("1") {
        return Err("a disposable native integration test is required".into());
    }
    let control_url = required("CONTROL_URL")?;
    let control = url::Url::parse(&control_url)?;
    let quack_uri = required("QUACK_URI")?;
    let quack_port = quack_uri
        .strip_prefix("quack:127.0.0.1:")
        .ok_or("a loopback test datastore is required")?
        .parse::<u16>()?;
    let token = required("SERVICE_TOKEN")?;
    if control.scheme() != "http"
        || control.host_str() != Some("127.0.0.1")
        || control.port().is_none()
        || control.path() != "/"
        || control.query().is_some()
        || control.fragment().is_some()
        || !control.username().is_empty()
        || control.password().is_some()
        || quack_port == 0
        || !token.starts_with("sortsys-disposable-")
    {
        return Err("only the isolated test datastore is allowed".into());
    }
    let jwt_secret = required("JWT_SECRET")?;
    let admin_hash = required("ADMIN_HASH")?;
    if jwt_secret.len() < 32 || admin_hash.parse::<bcrypt::HashParts>().is_err() {
        return Err("explicit test credentials are required".into());
    }
    let config = Config {
        port: 0,
        jwt_secret: Arc::from(jwt_secret.into_bytes()),
        admin_hash: admin_hash.into(),
        store: QuackConfig {
            uri: quack_uri.into(),
            control_url: control_url.into(),
            token: token.into(),
            extensions: required("EXTENSIONS")?.into(),
            disable_ssl: true,
        },
        editors: Default::default(),
        passkeys: Default::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let router = standalone::connect_at(&config, address).await?;
    println!(
        "{}",
        serde_json::json!({
            "endpoint": format!("http://{address}/"),
            "pid": std::process::id(),
        })
    );
    std::io::stdout().flush()?;
    axum::serve(listener, router).await?;
    Ok(())
}
