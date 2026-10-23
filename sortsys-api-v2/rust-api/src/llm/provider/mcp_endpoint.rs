pub(super) fn supports_mcp(provider: &str) -> bool {
    matches!(provider, "openai" | "anthropic" | "openrouter")
}

pub(super) fn resolve(
    configured: Option<&str>,
    provider: &str,
    port: u16,
) -> Result<String, &'static str> {
    if !supports_mcp(provider) {
        return Err("This provider has no MCP transport; select OpenAI, Anthropic, or OpenRouter");
    }

    if let Some(url) = configured.filter(|url| !url.trim().is_empty()) {
        return Ok(url.to_owned());
    }

    // OpenRouter's bridge runs in this API process, not on the model provider.
    // Keep discovery and tool calls on authenticated HTTP MCP over loopback.
    if provider == "openrouter" {
        return Ok(format!("http://127.0.0.1:{port}/internal/llm/mcp"));
    }

    Err("LLM_MCP_URL is required for the selected provider's remote MCP connector")
}

#[cfg(test)]
mod tests {
    use super::{resolve, supports_mcp};

    #[test]
    fn openrouter_defaults_to_local_authenticated_mcp() {
        for configured in [None, Some(""), Some(" \t ")] {
            assert_eq!(
                resolve(configured, "openrouter", 3000).unwrap(),
                "http://127.0.0.1:3000/internal/llm/mcp",
            );
        }
    }

    #[test]
    fn local_endpoint_uses_the_configured_api_port() {
        assert_eq!(
            resolve(None, "openrouter", 4187).unwrap(),
            "http://127.0.0.1:4187/internal/llm/mcp",
        );
    }

    #[test]
    fn openrouter_accepts_an_explicit_private_network_endpoint() {
        let private = "http://sortsys-api:3000/internal/llm/mcp";

        assert_eq!(resolve(Some(private), "openrouter", 3000).unwrap(), private);
    }

    #[test]
    fn explicit_provider_endpoints_are_preserved() {
        let endpoint = "https://sortsys.example.test/internal/llm/mcp";

        for provider in ["openai", "anthropic", "openrouter"] {
            assert_eq!(resolve(Some(endpoint), provider, 3000).unwrap(), endpoint);
        }
    }

    #[test]
    fn remote_native_mcp_still_requires_an_explicit_endpoint() {
        for provider in ["openai", "anthropic"] {
            for configured in [None, Some(""), Some(" \t ")] {
                let error = resolve(configured, provider, 3000).unwrap_err();

                assert!(error.contains("remote MCP connector"));
            }
        }
    }

    #[test]
    fn unsupported_providers_cannot_bypass_the_mcp_transport_guard() {
        for provider in ["meta", "deepseek", "custom", "unknown"] {
            assert!(!supports_mcp(provider));

            for configured in [None, Some("http://127.0.0.1:3000/internal/llm/mcp")] {
                let error = resolve(configured, provider, 3000).unwrap_err();

                assert!(error.contains("MCP transport"));
            }
        }
    }
}
