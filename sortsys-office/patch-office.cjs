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

// Both exporters obtain the confirmed project file version before reading
// their editor state. A delayed export carries that same version to SAVE.
function bindSaveVersion(indent) {
  replaceOnce(
    `${indent}var integrationSave = function (cb) {`,
    `${indent}var integrationSave = common.bindIntegrationSave(function (cb, version) {`,
  );
  replaceOnce(
    `                                blob: _blob\n`,
    `                                blob: _blob, version: version\n`,
  );
  replaceOnce(
    `${indent}};\n${indent}const integrationHasUnsavedChanges`,
    `${indent}});\n${indent}const integrationHasUnsavedChanges`,
  );
}

bindSaveVersion("                    ");
// A channel reply arrives as its second callback argument. Forward a rejected
// file write so CryptPad releases the save lock without announcing success.
replaceOnce(
  `                            }, obj => {\n                                if (!obj?.error) { hasUnsavedChanges = false; }`,
  `                            }, (err, obj) => {\n                                if (err) { return cb({error: err}); }\n                                if (!obj?.error) { hasUnsavedChanges = false; }`,
);
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

// An embedded editor has no CryptDrive. Use the same encrypted upload as
// pasted images when a user chooses a local file from the toolbar.
replaceOnce(
  `            APP.UploadImageFiles = function (files, type, id, jwt, cb) {`,
  `            const uploadImageTypes = ['image/png', 'image/jpeg'];
            APP.UploadImageFiles = function (files, type, id, jwt, cb) {`,
);
replaceOnce(
  `                    return (file.type === 'image/png' || file.type === 'image/jpeg');`,
  `                    return uploadImageTypes.includes(file.type);`,
);
replaceOnce(
  `                var urls = [];
                var remaining = files.length;`,
  `                const images = [];
                var remaining = files.length;`,
);
replaceOnce(
  `                    if (remaining <= 0) { cb(null, urls); }`,
  `                    if (remaining <= 0) {
                        cb(null, images.map(image => image.url), images);
                    }`,
);
replaceOnce(
  `                                if (blobUrl) { urls.push(blobUrl); }`,
  `                                if (blobUrl) { images.push({ name, url: blobUrl }); }`,
);
replaceOnce(
  `            APP.AddImage = function(cb1, cb2) {`,
  `            APP.AddImage = function(cb1, cb2) {
                if (privateData.integrationConfig) {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = uploadImageTypes.join(',');
                    input.addEventListener('change', function () {
                        if (!input.files.length) { return; }
                        APP.UploadImageFiles(input.files, null, null, null, function (err, urls, images) {
                            if (err || !images?.length) {
                                UI.warn(Messages.upload_serverError);
                                return;
                            }
                            cb1(images[0]);
                        });
                    }, { once: true });
                    input.click();
                    return;
                }

`,
);
fs.writeFileSync(target, source);

const common = path.join(process.argv[2], "www/common/sframe-common.js");
source = fs.readFileSync(common, "utf8");
replaceOnce(
  "    funcs.createIntegration = callWithCommon(Integration.create);",
  `    funcs.createIntegration = callWithCommon(Integration.create);
    funcs.bindIntegrationSave = function (save) {
        return function (callback) {
            var config = ctx.metadataMgr.getPrivateData().integrationConfig;
            if (config?._?.sortsysVersionedSaves !== true) {
                save(callback);
                return;
            }
            ctx.sframeChan.query('Q_INTEGRATION_SAVE_VERSION', null, function (err, result) {
                if (err || result?.error || typeof result?.version !== 'string') {
                    callback({error: 'SAVE_VERSION_UNAVAILABLE'});
                    return;
                }
                save(callback, result.version);
            });
        };
    };`,
);
fs.writeFileSync(common, source);

const integration = path.join(process.argv[2], "www/integration/main.js");
source = fs.readFileSync(integration, "utf8");
replaceOnce(
  "                chan.send('SAVE', obj.blob, function (err) {",
  `                var payload = data._config?.sortsysVersionedSaves === true
                    ? {blob: obj.blob, version: obj.version}
                    : obj.blob;
                chan.send('SAVE', payload, function (err) {`,
);
replaceOnce(
  "                        save: save,",
  `                        save: save,
                        saveVersion: function (cb) { chan.send('SAVE_VERSION', null, cb); },`,
);
fs.writeFileSync(integration, source);

// Upstream integration rooms self-destruct after the last connection leaves
// and on a storage-process restart. Project collaboration must survive both;
// unsaved export workspaces retain upstream's temporary-room behavior.
const outer = path.join(process.argv[2], "www/common/sframe-common-outer.js");
source = fs.readFileSync(outer, "utf8");
replaceOnce(
  "                sframeChan.on('Q_INTEGRATION_SAVE', function (obj, cb) {",
  `                sframeChan.on('Q_INTEGRATION_SAVE_VERSION', function (obj, cb) {
                    cfg.integrationUtils.saveVersion(cb);
                });
                sframeChan.on('Q_INTEGRATION_SAVE', function (obj, cb) {`,
);
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
bindSaveVersion("                    ");
replaceOnce(
  `                                blob: _blob, version: version\n                            }, cb, {`,
  `                                blob: _blob, version: version\n                            }, function (err, result) {\n                                cb(err ? {error: err} : result);\n                            }, {`,
);
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
