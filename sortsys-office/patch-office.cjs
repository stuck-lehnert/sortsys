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
