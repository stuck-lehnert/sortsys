"use strict";

// Bootstrap the built-in AI plugin through its editor events. All requests go
// to sortsys; the supplied key is a restricted session delegation, not a
// provider credential. This plugin has no access to the upstream API key.
(function () {
    function configureAI() {
        const settings = window.Asc.plugin.info.options?.settings;

        if (settings) {
            const currentSettings = structuredClone(settings);

            for (const provider of Object.values(currentSettings.providers ?? {})) {
                const argumentsJson = [provider.name, provider.url, provider.key, provider.addon]
                    .map(value => JSON.stringify(value ?? ""))
                    .join(", ");

                // ONLYOFFICE reloads providers with credentials from localStorage.
                // Ignore those cached arguments: this editor's delegation wins.
                provider.content = `class Provider extends AI.Provider {
                    constructor() {
                        super(${argumentsJson});
                    }

                    createInstance() {
                        return new Provider();
                    }
                }`;
            }

            // The vendor plugin mutates model IDs during initialization.
            window.Asc.plugin.sendEvent("ai_onCustomInit", currentSettings);
        }
    }

    window.Asc.plugin.init = function () {
        window.Asc.plugin.attachEditorEvent("ai_onInit", configureAI);
        configureAI();
    };

    window.Asc.plugin.onUpdateOptions = configureAI;
})();
