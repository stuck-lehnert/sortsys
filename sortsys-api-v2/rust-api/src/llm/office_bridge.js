"use strict";

// Bootstrap the built-in AI plugin through its editor events. All requests go
// to sortsys; the supplied key is a restricted session delegation, not a
// provider credential. This plugin has no access to the upstream API key.
(function () {
    function configureAI() {
        const settings = window.Asc.plugin.info.options?.settings;

        if (settings) {
            // The vendor plugin mutates model IDs during initialization.
            window.Asc.plugin.sendEvent("ai_onCustomInit", structuredClone(settings));
        }
    }

    window.Asc.plugin.init = function () {
        window.Asc.plugin.attachEditorEvent("ai_onInit", configureAI);
        configureAI();
    };

    window.Asc.plugin.onUpdateOptions = configureAI;
})();
