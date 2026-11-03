use serde_json::Value;

// Native provider metadata takes precedence, including an explicit denial.
// Anthropic: https://platform.claude.com/docs/en/api/models/list
// OpenRouter: https://openrouter.ai/docs/api/api-reference/models/get-models
pub(super) fn supports_image_input(provider: &str, record: &Value) -> bool {
    if let Some(supported) = record
        .pointer("/capabilities/image_input/supported")
        .and_then(Value::as_bool)
    {
        return supported;
    }

    for path in ["/architecture/input_modalities", "/input_modalities"] {
        if let Some(modalities) = record.pointer(path).and_then(Value::as_array) {
            return modalities.iter().any(|modality| modality == "image");
        }
    }

    // OpenAI's /models endpoint omits modalities. Keep exact, documented IDs;
    // unknown names and lookalike prefixes remain unavailable for import.
    // https://developers.openai.com/api/docs/models/gpt-6-luna
    // https://developers.openai.com/api/docs/models/gpt-4.1
    // https://developers.openai.com/api/docs/guides/pdf-files
    provider == "openai"
        && matches!(
            record.get("id").and_then(Value::as_str),
            Some("gpt-6-luna" | "gpt-6-astra" | "gpt-4.1" | "gpt-4.1-2025-04-14" | "gpt-4o")
        )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::supports_image_input;

    #[test]
    fn metadata_requires_image_input_and_rejects_output_only_models() {
        for provider in ["openrouter", "anthropic", "openai", "compatible"] {
            assert!(supports_image_input(
                provider,
                &json!({"capabilities": {"image_input": {"supported": true}}}),
            ));
            assert!(supports_image_input(
                provider,
                &json!({"architecture": {"input_modalities": ["text", "image"]}}),
            ));
            assert!(!supports_image_input(
                provider,
                &json!({"architecture": {
                    "input_modalities": ["text"], "output_modalities": ["image"]
                }}),
            ));
            assert!(!supports_image_input(provider, &json!({"id": "unknown"})));
        }
    }

    #[test]
    fn documented_openai_ids_are_exact_and_only_apply_to_the_native_provider() {
        for id in [
            "gpt-6-luna",
            "gpt-6-astra",
            "gpt-4.1",
            "gpt-4.1-2025-04-14",
            "gpt-4o",
        ] {
            assert!(supports_image_input("openai", &json!({"id": id})));
            assert!(!supports_image_input("compatible", &json!({"id": id})));
        }

        for id in [
            "gpt-6-luna-audio",
            "gpt-4.1-made-up",
            "gpt-3.5-turbo",
            "o3-mini",
        ] {
            assert!(!supports_image_input("openai", &json!({"id": id})));
        }
    }

    #[test]
    fn explicit_negative_metadata_overrides_a_known_model_name() {
        assert!(!supports_image_input(
            "openai",
            &json!({"id": "gpt-6-luna", "capabilities": {"image_input": {"supported": false}}}),
        ));
        assert!(!supports_image_input(
            "openai",
            &json!({"id": "gpt-6-luna", "input_modalities": ["text"]}),
        ));
    }
}
