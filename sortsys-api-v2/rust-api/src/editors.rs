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
    pub drawio_url: Option<String>,
    pub office_origin: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("OFFICE_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback)")]
    InvalidOfficeOrigin,
    #[error(
        "DRAWIO_PUBLIC_URL must be an HTTP(S) URL or a root-relative path without credentials, query or fragment"
    )]
    InvalidDrawioUrl,
}

impl EditorConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::parse(
            crate::config::optional("OFFICE_PUBLIC_ORIGIN"),
            crate::config::optional("DRAWIO_PUBLIC_URL"),
        )
    }

    fn parse(office: Option<String>, drawio: Option<String>) -> Result<Self, ConfigError> {
        let office_origin = office
            .filter(|value| !value.is_empty())
            .map(office_origin)
            .transpose()?;
        let drawio_url = drawio
            .filter(|value| !value.is_empty())
            .map(drawio_url)
            .transpose()?;
        Ok(Self {
            office_origin,
            drawio_url,
        })
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

fn drawio_url(value: String) -> Result<String, ConfigError> {
    if value.contains(['?', '#', '\\']) || value.chars().any(char::is_control) {
        return Err(ConfigError::InvalidDrawioUrl);
    }
    if value.starts_with('/') && !value.starts_with("//") {
        if value == "/" {
            return Ok(value);
        }
        return Ok(value.trim_end_matches('/').to_owned());
    }
    let url = url::Url::parse(&value).map_err(|_| ConfigError::InvalidDrawioUrl)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ConfigError::InvalidDrawioUrl);
    }
    Ok(value.trim_end_matches('/').to_owned())
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
        let config = EditorConfig::parse(
            Some("http://127.0.0.1:29400/".into()),
            Some("/drawio/".into()),
        )
        .unwrap();
        assert_eq!(
            config.office_origin.as_deref(),
            Some("http://127.0.0.1:29400")
        );
        assert_eq!(config.drawio_url.as_deref(), Some("/drawio"));
        assert!(EditorConfig::parse(None, None).is_ok());
        assert!(drawio_url("https://diagrams.example.test/editor/".into()).is_ok());
        for invalid in [
            "//remote.example.test/editor",
            "/\\remote.example.test",
            "https://user:secret@diagrams.example.test",
            "https://diagrams.example.test/?key=secret",
            "https://diagrams.example.test/#secret",
            "javascript:alert(1)",
            "/editor\n",
        ] {
            assert!(drawio_url(invalid.into()).is_err(), "{invalid:?}");
        }
    }
}
