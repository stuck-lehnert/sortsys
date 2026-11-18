//! Public addresses of browser-only editors. No document content or capability
//! is sent through this endpoint.
use std::sync::Arc;

use crate::{
    auth::AuthService,
    rpc::{ProcedureRegistryBuilder, RequestContext},
};

#[derive(Clone, Default, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    pub office_origin: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("OFFICE_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback)")]
    InvalidOfficeOrigin,
}

impl EditorConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let office_origin = crate::config::optional("OFFICE_PUBLIC_ORIGIN")
            .filter(|value| !value.is_empty())
            .map(office_origin)
            .transpose()?;
        Ok(Self { office_origin })
    }
}

pub(crate) fn office_origin(value: String) -> Result<String, ConfigError> {
    let origin = url::Url::parse(&value).map_err(|_| ConfigError::InvalidOfficeOrigin)?;
    let loopback = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !(origin.scheme() == "https" || loopback && origin.scheme() == "http")
    {
        return Err(ConfigError::InvalidOfficeOrigin);
    }
    Ok(origin.origin().ascii_serialization())
}

pub(crate) fn register(
    builder: ProcedureRegistryBuilder,
    auth: Arc<AuthService>,
    settings: EditorConfig,
) -> ProcedureRegistryBuilder {
    builder.query(
        "zerotrust.editors.config",
        move |ctx: RequestContext, _: ()| {
            let auth = Arc::clone(&auth);
            let settings = settings.clone();
            async move {
                auth.authenticate(&ctx.headers).await?;
                Ok(settings)
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_editors_accept_only_public_addresses_without_secrets() {
        assert_eq!(
            office_origin("http://127.0.0.1:29400/".into()).unwrap(),
            "http://127.0.0.1:29400"
        );
        assert!(office_origin("https://editors.example.test/".into()).is_ok());
        for invalid in [
            "http://editors.example.test/",
            "//editors.example.test/",
            "https://user:secret@editors.example.test/",
            "https://editors.example.test/?key=secret",
            "https://editors.example.test/#secret",
            "https://editors.example.test/editor/",
            "javascript:alert(1)",
        ] {
            assert!(office_origin(invalid.into()).is_err(), "{invalid:?}");
        }
    }
}
