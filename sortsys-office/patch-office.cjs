const fs = require("node:fs");
const path = require("node:path");

// The pinned integration's generic DOWNLOAD_AS handler feeds the Office binary
// directly into x2t. PDF needs the editor's print buffer as well. Reuse the
// existing browser-only print conversion, returning its Blob to the host.
const target = path.join(process.argv[2], "www/common/onlyoffice/inner.js");
let source = fs.readFileSync(target, "utf8");
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) {
    throw new Error("Pinned CryptPad integration changed");
  }
  source = source.replace(before, after);
}
replaceOnce("APP.printPdf = function (obj, cb) {\n            var bin = getContent();", `APP.printPdf = function (obj, cb) {
            var integrationExport = APP.integrationExportPdf === true;
            delete APP.integrationExportPdf;
            var bin = getContent();`);
replaceOnce("                saveAs(blob, APP.exportPdfName || title+'.pdf');", `                if (integrationExport && integrationChannel) {
                    integrationChannel.event('EV_INTEGRATION_ON_DOWNLOADAS', blob, { raw: true });
                    return;
                }
                saveAs(blob, APP.exportPdfName || title+'.pdf');`);
replaceOnce("sframeChan.on('EV_INTEGRATION_DOWNLOADAS', function (format) {", `sframeChan.on('EV_INTEGRATION_DOWNLOADAS', function (format) {
            if (format === 'pdf') {
                APP.integrationExportPdf = true;
                try { getEditor().asc_Print({}); }
                catch (err) {
                    delete APP.integrationExportPdf;
                    integrationChannel.event('EV_INTEGRATION_ERROR', 'PDF_ERROR');
                }
                return;
            }`);
fs.writeFileSync(target, source);

// Upstream integration rooms self-destruct after the last connection leaves
// and on a storage-process restart. Project collaboration must survive both;
// unsaved export workspaces retain upstream's temporary-room behavior.
const outer = path.join(process.argv[2], "www/common/sframe-common-outer.js");
source = fs.readFileSync(outer, "utf8");
replaceOnce("                if (cfg.integration) {\n                    rtConfig.metadata = rtConfig.metadata || {};\n                    rtConfig.metadata.selfdestruct = true;", `                if (cfg.integration && cfg.integrationConfig?._?.sortsysPersistentRoom !== true) {
                    rtConfig.metadata = rtConfig.metadata || {};
                    rtConfig.metadata.selfdestruct = true;`);
replaceOnce("                if (cfg.integration) { rtConfig.metadata.selfdestruct = true; }", "                if (cfg.integration && cfg.integrationConfig?._?.sortsysPersistentRoom !== true) { rtConfig.metadata.selfdestruct = true; }");

// The host gives the frame its room capability through START. Use it through
// currentPad in memory. The address and session history don't need that key.
replaceOnce(
  "                if (window.history && window.history.replaceState && (currentPad.hash || window.location.hash)) {",
  "                if (!cfg.integration && window.history && window.history.replaceState && (currentPad.hash || window.location.hash)) {",
);
replaceOnce(
  "            if (!Utils.Hash.isValidHref(window.location.href)) {",
  "            if (!Utils.Hash.isValidHref(cfg.integration ? currentPad.href : window.location.href)) {",
);
replaceOnce(
  "                Cryptpad = _Cryptpad;",
  `                Cryptpad = _Cryptpad;
                if (cfg.integration) {
                    // These helpers only update the address of this frame.
                    Cryptpad.setTabHref = function () {};
                    Cryptpad.setTabHash = function () {};
                }`,
);
replaceOnce(
  "                        if (useUnsafe !== true && window.history && window.history.replaceState) {",
  "                        if (!cfg.integration && useUnsafe !== true && window.history && window.history.replaceState) {",
);
replaceOnce(
  "                // No need to store it in memory\n                window.location.hash = hash;",
  "                // No need to store it in memory\n                if (!cfg.integration) { window.location.hash = hash; }",
);
replaceOnce(
  "                var replaceHash = function (hash) {",
  "                var replaceHash = function (hash) {\n                    if (cfg.integration) { return; }",
);
// Upstream registers a login redirect in both the startup and steady state.
for (const indentation of [32, 20]) {
  const indent = " ".repeat(indentation);
  replaceOnce(
    `sframeChan.on('EV_SET_LOGIN_REDIRECT', function (page) {\n${indent}var href`,
    `sframeChan.on('EV_SET_LOGIN_REDIRECT', function (page) {\n${indent}if (cfg.integration) { return; }\n${indent}var href`,
  );
}
fs.writeFileSync(outer, source);

// Diagram rooms use the generic app framework. Its native exporter already
// resolves encrypted images in the browser, but upstream only exposes manual
// SAVE here. Draft recovery also needs an explicit read-only native export.
const framework = path.join(process.argv[2], "www/common/sframe-app-framework.js");
source = fs.readFileSync(framework, "utf8");
replaceOnce(
  "                    if (firstConnection) {\n                        integrationChannel.on('Q_INTEGRATION_NEEDSAVE', function (data, cb) {",
  `                    if (firstConnection) {
                        integrationChannel.on('EV_INTEGRATION_DOWNLOADAS', function (format) {
                            if (type !== 'diagram' || format !== 'drawio') {
                                integrationChannel.event('EV_INTEGRATION_ERROR', 'UNSUPPORTED_EXPORT');
                                return;
                            }
                            var deliver = Util.once(function (blob) {
                                if (!(blob instanceof Blob)) {
                                    integrationChannel.event('EV_INTEGRATION_ERROR', 'EXPORT_ERROR');
                                    return;
                                }
                                integrationChannel.event('EV_INTEGRATION_ON_DOWNLOADAS', blob, { raw: true });
                            });
                            try {
                                var exported = fileExporter(deliver, '.drawio');
                                if (exported) {
                                    deliver(exported);
                                }
                            } catch (err) {
                                deliver(null);
                            }
                        });
                        integrationChannel.on('Q_INTEGRATION_NEEDSAVE', function (data, cb) {`,
);
fs.writeFileSync(framework, source);

// Native Drawio files can compress individual pages. Expand them before
// collecting images so they all use the browser's encrypted image uploader.
const diagramUtil = path.join(process.argv[2], "www/diagram/util.js");
source = fs.readFileSync(diagramUtil, "utf8");
replaceOnce("        var TEXT_NODE = 3;\n\n        var parser", "        var parser");
replaceOnce("        doc.firstChild.removeAttribute('modified');", `        expandDrawioPages(doc);
        return new XMLSerializer().serializeToString(doc);
    };

    const expandDrawioPages = function (doc) {
        const parser = new DOMParser();
        const TEXT_NODE = 3;
        doc.documentElement.removeAttribute('modified');`);
replaceOnce("        doc.firstChild.removeAttribute('agent');", "        doc.documentElement.removeAttribute('agent');");
replaceOnce("        doc.firstChild.removeAttribute('etag');", "        doc.documentElement.removeAttribute('etag');");
replaceOnce("diagram.replaceChild(diagramDoc.firstChild, diagram.firstChild);", "diagram.replaceChild(diagramDoc.documentElement, diagram.firstChild);");
replaceOnce("\n\n        var result = new XMLSerializer().serializeToString(doc);\n        return result;", "");
replaceOnce("        decompressDrawioXml,\n", "        decompressDrawioXml,\n        expandDrawioPages,\n");
fs.writeFileSync(diagramUtil, source);

const diagramImport = path.join(process.argv[2], "www/diagram/import.js");
source = fs.readFileSync(diagramImport, "utf8");
replaceOnce("            doc = DiagramUtil.parseXML(content);", `            doc = DiagramUtil.parseXML(content);
            DiagramUtil.expandDrawioPages(doc);`);
fs.writeFileSync(diagramImport, source);
