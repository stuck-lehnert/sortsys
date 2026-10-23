pub(super) struct Configuration {
    pub(super) provider: &'static str,
    pub(super) model: String,
    pub(super) api_key: String,
    pub(super) base_url: Option<&'static str>,
}

pub(super) fn select_configuration(
    mut variable: impl FnMut(&str) -> Option<String>,
) -> Option<Configuration> {
    let providers = [
        (
            "openrouter",
            "OPENROUTER_API_KEY",
            "OPENROUTER_MODEL",
            "deepseek/deepseek-v4.1-flash-1017",
            None,
        ),
        (
            "openai",
            "OPENAI_API_KEY",
            "OPENAI_MODEL",
            "gpt-6-luna",
            None,
        ),
        (
            "anthropic",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
            "claude-haiku-4-5",
            None,
        ),
        (
            "meta",
            "LLAMA_API_KEY",
            "LLAMA_MODEL",
            "Llama-4-Scout-17B-16E-Instruct-FP8",
            None,
        ),
        (
            "meta",
            "META_API_KEY",
            "META_MODEL",
            "Llama-4-Scout-17B-16E-Instruct-FP8",
            None,
        ),
        (
            "deepseek",
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_MODEL",
            "deepseek-v4-flash",
            Some("https://api.deepseek.com"),
        ),
    ];

    for (provider, key_name, model_name, default_model, base_url) in providers {
        let Some(api_key) = variable(key_name).filter(|value| !value.trim().is_empty()) else {
            continue;
        };

        let model = variable(model_name)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default_model.to_owned());

        return Some(Configuration {
            provider,
            model,
            api_key,
            base_url,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{Configuration, select_configuration};

    fn configuration(values: &[(&str, &str)]) -> Option<Configuration> {
        select_configuration(|name| {
            values
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
    }

    #[test]
    fn openrouter_key_selects_deepseek_flash_1017() {
        let selected = configuration(&[("OPENROUTER_API_KEY", "fixture-router-key")]).unwrap();

        assert_eq!(selected.provider, "openrouter");
        assert_eq!(selected.model, "deepseek/deepseek-v4.1-flash-1017");
        assert_eq!(selected.api_key, "fixture-router-key");
        assert_eq!(selected.base_url, None);
    }

    #[test]
    fn openrouter_takes_precedence_over_openai_and_other_provider_keys() {
        let selected = configuration(&[
            ("OPENAI_API_KEY", "fixture-openai-key"),
            ("OPENAI_MODEL", "openai-override"),
            ("ANTHROPIC_API_KEY", "fixture-anthropic-key"),
            ("DEEPSEEK_API_KEY", "fixture-deepseek-key"),
            ("OPENROUTER_API_KEY", "fixture-router-key"),
        ])
        .unwrap();

        assert_eq!(selected.provider, "openrouter");
        assert_eq!(selected.model, "deepseek/deepseek-v4.1-flash-1017");
        assert_eq!(selected.api_key, "fixture-router-key");
    }

    #[test]
    fn openrouter_model_override_is_preserved() {
        let selected = configuration(&[
            ("OPENROUTER_API_KEY", "fixture-router-key"),
            ("OPENROUTER_MODEL", "custom/router-model"),
        ])
        .unwrap();

        assert_eq!(selected.provider, "openrouter");
        assert_eq!(selected.model, "custom/router-model");
    }

    #[test]
    fn openai_key_selects_gpt_6_luna_without_openrouter() {
        let selected = configuration(&[("OPENAI_API_KEY", "fixture-openai-key")]).unwrap();

        assert_eq!(selected.provider, "openai");
        assert_eq!(selected.model, "gpt-6-luna");
        assert_eq!(selected.api_key, "fixture-openai-key");
        assert_eq!(selected.base_url, None);
    }

    #[test]
    fn openai_model_override_is_preserved() {
        let selected = configuration(&[
            ("OPENAI_API_KEY", "fixture-openai-key"),
            ("OPENAI_MODEL", "custom-openai-model"),
        ])
        .unwrap();

        assert_eq!(selected.provider, "openai");
        assert_eq!(selected.model, "custom-openai-model");
    }

    #[test]
    fn blank_openrouter_key_falls_back_to_openai() {
        for key in ["", " \t "] {
            let selected = configuration(&[
                ("OPENROUTER_API_KEY", key),
                ("OPENAI_API_KEY", "fixture-openai-key"),
            ])
            .unwrap();

            assert_eq!(selected.provider, "openai");
            assert_eq!(selected.model, "gpt-6-luna");
        }
    }

    #[test]
    fn blank_model_overrides_use_the_corresponding_provider_default() {
        for (key_name, model_name, expected) in [
            (
                "OPENROUTER_API_KEY",
                "OPENROUTER_MODEL",
                "deepseek/deepseek-v4.1-flash-1017",
            ),
            ("OPENAI_API_KEY", "OPENAI_MODEL", "gpt-6-luna"),
        ] {
            let selected =
                configuration(&[(key_name, "fixture-key"), (model_name, " \t ")]).unwrap();

            assert_eq!(selected.model, expected);
        }
    }

    #[test]
    fn absent_or_blank_keys_do_not_enable_a_provider() {
        assert!(configuration(&[]).is_none());
        assert!(
            configuration(&[
                ("OPENROUTER_API_KEY", " \t "),
                ("OPENROUTER_MODEL", "custom/router-model"),
                ("OPENAI_API_KEY", ""),
                ("OPENAI_MODEL", "custom-openai-model"),
            ])
            .is_none()
        );
    }

    #[test]
    fn other_development_provider_defaults_remain_unchanged() {
        for (key_name, provider, model, base_url) in [
            ("ANTHROPIC_API_KEY", "anthropic", "claude-haiku-4-5", None),
            (
                "LLAMA_API_KEY",
                "meta",
                "Llama-4-Scout-17B-16E-Instruct-FP8",
                None,
            ),
            (
                "META_API_KEY",
                "meta",
                "Llama-4-Scout-17B-16E-Instruct-FP8",
                None,
            ),
            (
                "DEEPSEEK_API_KEY",
                "deepseek",
                "deepseek-v4-flash",
                Some("https://api.deepseek.com"),
            ),
        ] {
            let selected = configuration(&[(key_name, "fixture-key")]).unwrap();

            assert_eq!(selected.provider, provider);
            assert_eq!(selected.model, model);
            assert_eq!(selected.base_url, base_url);
        }
    }
}
