pub(super) fn supports_mcp(provider: &str) -> bool {
    matches!(provider, "openai" | "anthropic" | "openrouter")
}

#[cfg(test)]
mod tests {}
