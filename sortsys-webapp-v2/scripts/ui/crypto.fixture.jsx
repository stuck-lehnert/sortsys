import React, { useState } from "react";
import { Observable } from "rxjs";
import { createRoot } from "react-dom/client";
import { base64, createDomain, createTenantSetup, certifyIdentity, signPolicy, ACTIONS, certifyAuthority, publicSigningKey, createAccountVault, createIdentity, createInvitation, forgetDeviceVaults, hasProtectedAccount, openAccountVault, publicIdentity, rememberDeviceVault, restoreDeviceVault, sign, frame, verify, importSigningKey, signingPair } from "@sortsys/zerotrust";
import { createBusinessDatabase } from "../../app/lib/data/database";
import { readBusinessRows } from "../../app/lib/data/products";
import { RecoveryPhraseBackup } from "../../app/components/RecoveryPhraseBackup";
import { I18nProvider } from "../../app/lib/i18n";
import { LLMActivityHost } from "../../app/components/LLMActivityHost";
import { llmActivity } from "../../app/lib/llmActivity";
import { processImport } from "../../app/lib/importProcessing";
import { prepareImportFiles } from "../../app/lib/importFiles";
import { prepareImportImage } from "../../app/lib/importImage";
import { Link, MemoryRouter, Route, Routes } from "react-router";

const TENANT = "browser-crypto-test";
const USER = "owner";
let finishLLM, failLLM, lastLLMSignal;
function beginLLM(kind) {
  const operation = signal => {
    lastLLMSignal = signal;
    return new Promise((resolve, reject) => { finishLLM = resolve; failLLM = reject; });
  };
  void (kind === "document-import" ? processImport(operation) : llmActivity.run(kind, "fixture", operation)).catch(() => undefined);
}

window.cryptoFixture = {
  async showToolEdit(costAccess = "none") {
    const [{ client, projectFiles }, { MyModalsProvider, useMyModals }, { SessionInfoProvider, useSessionInfo }, { showModifyToolModal }, { createContentAccess }, { acceptVault }] = await Promise.all([
      import("../../app/lib/client"), import("../../app/hooks/useMyModals"), import("../../app/hooks/useSessionInfo"), import("../../app/modals/tools"), import("../../app/lib/data/menuAccess"), import("../../app/lib/crypto/session"),
    ]);
    const identity = await createIdentity(), { setup, authorityKey } = await createTenantSetup("test", "user:1", identity, PHRASE, { scopes: [] }), key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(key, await createAccountVault(key, "test", "owner", identity, { recoveryGeneration: "1", recoverySigningKey: setup.authority.recoverySigningKey }), false);
    const user = { id: "1", username: "owner", locale: "de" }, rule = (facet, actions) => ({ subject: "user:1", scope: "tool:4", facet, actions, effect: "allow" });
    const permissions = await signPolicy({ tenant: "test", version: "1", rules: [rule("master-data", [...ACTIONS]), ...(costAccess === "none" ? [] : [rule("procurement", costAccess === "write" ? [...ACTIONS] : ["read"])])] }, authorityKey.privateKey);
    const raw = { loggedIn: () => true,
      streamQuery: () => new Observable(subscriber => { subscriber.next([{ user, tenant: { objectStorageEnabled: false }, roles: [":admin"] }, null]); }),
      async query(path) {
        if (path === "auth.sessionInfo") return [{ user, roles: [":admin"] }, null];
        if (path === "zerotrust.trust.history") return [{ authorities: [{ certificate: setup.authority, transition: null }], identities: [setup.owner] }, null];
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        throw new Error("Unexpected tool policy query: " + path);
      },
    };
    const access = createContentAccess(raw, projectFiles.context), mutations = [];
    client.query = async path => { if (path === "tools.brands") return [["Muster"], null]; if (path === "tools.categories") return [["Bohrhammer"], null]; throw new Error("Unexpected tool form query: " + path); };
    client.mutate = async (path, input) => { if (path !== "tools.update") throw new Error("Unexpected tool form mutation: " + path); mutations.push(structuredClone(input)); return [{ success: true }, null]; };
    window.cryptoFixture.toolEdits = () => mutations;
    const tool = { id: "4", customId: 73, brand: "Muster", category: "Bohrhammer", label: "Profilfräse", status: null, available: true,
      purchasePrice: costAccess === "none" ? null : 1537.87654321, usageCostPerDay: costAccess === "none" ? null : 17.375, createdByUserId: "1", createdAt: new Date(), modifiedAt: new Date(), archivedSince: null };
    function Launcher() {
      const modals = useMyModals(), session = useSessionInfo();
      return <button disabled={!session.canDo("manage:tools")} onClick={() => showModifyToolModal(modals, tool)}>Werkzeug bearbeiten</button>;
    }
    root.render(<I18nProvider><MemoryRouter><SessionInfoProvider sessionClient={raw} access={access}><MyModalsProvider><Launcher /></MyModalsProvider></SessionInfoProvider></MemoryRouter></I18nProvider>);
  },
  async showPriceImport() {
    const { client } = await import("../../app/lib/client");
    const { MyModalsProvider, useMyModals } = await import("../../app/hooks/useMyModals");
    const { showPriceImportModal } = await import("../../app/modals/priceImports");
    const attempts = [];
    client.query = async path => {
      if (path === "products.vendors.list") return [[{ id: "1", name: "Baustoffhandel Browser", description: null }], null];
      if (path === "products.list") return [[], null];
      throw new Error("Unexpected import query: " + path);
    };
    client.mutate = async (path, input) => {
      if (path !== "products.priceImports.apply") throw new Error("Unexpected import mutation");
      attempts.push(structuredClone(input));
      return attempts.length < 3 ? [null, new Error("Verbindung unterbrochen")] : [{ createdProducts: 1, createdPriceRecords: 1 }, null];
    };
    client.invalidateCascading = async () => {};
    window.cryptoFixture.priceImportAttempts = () => attempts.map(input => ({ requestId: input.requestId, effectiveAt: input.effectiveAt.toISOString() }));
    function Launcher() {
      const modals = useMyModals();
      return <button onClick={() => showPriceImportModal(modals, { supplier: "Baustoffhandel Browser", documentNumber: "Liste 1", effectiveDate: "2026-11-11", warnings: [],
        rows: [{ sourceText: "Anschlussprofil 12,50 EUR/m", productId: null, customId: null, productName: "Anschlussprofil", brand: null, description: null,
          baseUnit: "m", otherUnits: {}, sourceUnit: "m", pricePerBaseUnit: 12.5, confidence: 1, comment: null }] }, "priceList")}>Preisliste prüfen</button>;
    }
    root.render(<I18nProvider><MemoryRouter><MyModalsProvider><Launcher /></MyModalsProvider></MemoryRouter></I18nProvider>);
  },
  async showMenuAccess() {
    const { SessionInfoProvider, useSessionInfo } = await import("../../app/hooks/useSessionInfo");
    const { createContentAccess } = await import("../../app/lib/data/menuAccess");
    const { acceptVault } = await import("../../app/lib/crypto/session");
    const { projectFiles } = await import("../../app/lib/client");
    const owner = await createIdentity(), { setup, authorityKey } = await createTenantSetup("test", "user:1", owner, PHRASE, { scopes: [] });
    let user = { id: "1", username: "owner", locale: "de" }, version = 1, pause = false, entered, release, currentSession;
    const additionalIdentities = [];
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(exportKey, await createAccountVault(exportKey, "test", "owner", owner,
      { recoveryGeneration: "1", recoverySigningKey: setup.authority.recoverySigningKey }), false);
    const rule = (scope, facet, actions) => ({ subject: "user:1", scope, facet, actions, effect: "allow" });
    let permissions = await signPolicy({ tenant: "test", version: String(version), rules: [rule("catalog:vendors", "master-data", ["read"])] }, authorityKey.privateKey);
    const raw = {
      loggedIn: () => true,
      streamQuery: () => new Observable(subscriber => { subscriber.next([{ user, tenant: { objectStorageEnabled: false }, roles: [":admin", "manage:products", "manage:productPriceRecords"] }, null]); }),
      async query(path) {
        if (path === "auth.sessionInfo") return [{ user, roles: [":admin"] }, null];
        if (path === "zerotrust.trust.history") return [{ authorities: [{ certificate: setup.authority, transition: null }], identities: [setup.owner, ...additionalIdentities] }, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.policy.get") { const current = permissions; if (pause) { pause = false; entered(); await new Promise(resolve => { release = resolve; }); } return [current, null]; }
        throw new Error("Unexpected menu query: " + path);
      },
    };
    const access = createContentAccess(raw, projectFiles.context);
    function Rights() {
      const session = useSessionInfo();
      currentSession = session;
      const rights = { admin: session.isAdmin(), productRead: session.canDo("view:products"), productEdit: session.canDo("manage:products"),
        supplierRead: session.hasRole("view:productVendors"), supplierEdit: session.canDo("manage:productVendors"), priceEdit: session.canDo("manage:productPriceRecords"),
        createOffer: session.canCreate("commercial"), createProject: session.canCreate("project"), offers: session.canSeeOffers(), project4: session.canAccess("project:4", "master-data", "update"),
        project5: session.canAccess("project:5", "master-data", "update"), id: session.user.id, roles: session.roles };
      return <><output aria-label="Menüfreigaben">{JSON.stringify(rights)}</output>
        <button disabled={!rights.productEdit}>Produkt bearbeiten</button><button disabled={!rights.supplierEdit}>Lieferant bearbeiten</button>
        <button disabled={!rights.priceEdit}>Preis bearbeiten</button><button disabled={!rights.createOffer}>Angebot erstellen</button></>;
    }
    window.cryptoFixture.menuHold = () => new Promise(resolve => { entered = resolve; pause = true; access.refresh(); });
    window.cryptoFixture.menuRelease = () => release?.();
    window.cryptoFixture.menuCaptureAction = () => { const saved = currentSession; window.cryptoFixture.oldMenuCanEdit = () => saved.canDo("manage:productPriceRecords"); };
    window.cryptoFixture.menuTamper = () => { permissions = { ...permissions, signature: (permissions.signature[0] === "A" ? "B" : "A") + permissions.signature.slice(1) }; access.refresh(); };
    window.cryptoFixture.menuRepair = async () => { permissions = await signPolicy({ tenant: "test", version: String(++version), rules: [rule("catalog:products", "procurement", [...ACTIONS])] }, authorityKey.privateKey); };
    window.cryptoFixture.menuChange = async (kind = "prices") => {
      const rules = kind === "prices" ? [rule("catalog:products", "procurement", [...ACTIONS]), rule("create:commercial", "master-data", ["create"]),
        rule("project:4", "master-data", [...ACTIONS]), rule("project:5", "master-data", ["read"])] : [];
      permissions = await signPolicy({ tenant: "test", version: String(++version), rules }, authorityKey.privateKey); access.refresh();
    };
    window.cryptoFixture.menuSwitchAccount = async () => {
      user = { id: "2", username: "different", locale: "de" };
      const identity = await createIdentity(), key = base64(crypto.getRandomValues(new Uint8Array(64)));
      additionalIdentities.push(await certifyIdentity({ tenant: "test", generation: "1", user: "user:2", ...await publicIdentity(identity) }, authorityKey.privateKey));
      await acceptVault(key, await createAccountVault(key, "test", "different", identity,
        { recoveryGeneration: "1", recoverySigningKey: setup.authority.recoverySigningKey }), false);
    };
    root.render(<I18nProvider><SessionInfoProvider sessionClient={raw} access={access}><Rights /></SessionInfoProvider></I18nProvider>);
  },
  async showViewPreferences() {
    const { client } = await import("../../app/lib/client");
    const { useGaebViewPreferences } = await import("../../app/hooks/useGaebViewPreferences");
    const { DEFAULT_GAEB_VIEW } = await import("@sortsys/gaeb");
    let scope = 0, current, paused = false, fail = false;
    const stored = new Map([[0, { ...DEFAULT_GAEB_VIEW }], [1, { ...DEFAULT_GAEB_VIEW, outlineWidth: 407 }]]), calls = [], releases = [];
    client.query = async path => { if (path !== "personalization.gaebView.get") throw new Error("Unexpected view query"); return [{ ...stored.get(scope) }, null]; };
    client.mutate = async (path, value) => {
      if (path !== "personalization.gaebView.set") throw new Error("Unexpected view write");
      const owner = scope; calls.push({ scope: owner, value: structuredClone(value) });
      if (paused) await new Promise(resolve => releases.push(resolve));
      if (fail) { fail = false; return [null, new Error("Synthetic view storage failure")]; }
      stored.set(owner, structuredClone(value)); return [{ success: true }, null];
    };
    function Preferences() {
      current = useGaebViewPreferences(0);
      return <output aria-label="Ansichtseinstellungen">{JSON.stringify({ view: current.preferences, error: current.error })}</output>;
    }
    const mount = () => root.render(<I18nProvider><Preferences /></I18nProvider>);
    window.cryptoFixture.viewPreferenceState = () => ({ calls, stored: [...stored], scope });
    window.cryptoFixture.editViewPreference = width => current.change({ ...current.preferences, outlineWidth: width });
    window.cryptoFixture.flushViewPreference = () => current.flush();
    window.cryptoFixture.pauseViewPreferences = () => { paused = true; };
    window.cryptoFixture.releaseViewPreferences = () => { paused = false; for (const release of releases.splice(0)) release(); };
    window.cryptoFixture.failViewPreferences = () => { fail = true; };
    window.cryptoFixture.switchViewPreferenceAccount = async () => { scope = 1; await client.clearCache(); };
    window.cryptoFixture.closeViewPreferences = () => root.render(<main>Ansicht geschlossen</main>);
    window.cryptoFixture.openViewPreferences = mount;
    mount();
  },
  async showPositionSearch() {
    const { GaebPositionSearch } = await import("../../../sortsys-gaeb/src/components/GaebPositionSearch");
    window.cryptoFixture.selectedPosition = null;
    window.cryptoFixture.lastPositionQuery = null;
    const search = async query => {
      window.cryptoFixture.lastPositionQuery = query;
      if (query === "Fehler") throw new Error("Corrupt position source");
      return { items: [{ id: "1", shortText: "Fensterlaibung", description: "Oberflächen sorgfältig vorbereiten", unit: "m²", sourceFile: "Leistungen.x84" }], indexing: false };
    };
    root.render(<I18nProvider><main className="p-6"><GaebPositionSearch locale="de" search={search} onSelect={position => { window.cryptoFixture.selectedPosition = position; }} /></main></I18nProvider>);
  },
  async positionTexts(xml) {
    const { browserGaebXml } = await import("@sortsys/gaeb");
    return browserGaebXml.positions(xml, new AbortController().signal);
  },
  async positionScopeTexts(xml) {
    const { browserGaebXml } = await import("@sortsys/gaeb");
    const signal = new AbortController().signal, partition = await browserGaebXml.partition(xml, "procurement", signal);
    const rendered = await browserGaebXml.render(partition.layout, new Map(), signal);
    return { ...rendered, positions: await browserGaebXml.positions(rendered.xml, signal) };
  },
  async replacePositionQuery() {
    const { createPositionIndex } = await import("../../app/lib/data/positionIndex");
    const { browserGaebXml } = await import("@sortsys/gaeb");
    let began; const started = new Promise(resolve => { began = resolve; });
    const xml = '<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.3"><Item><OutlTxt>Fensterlaibung</OutlTxt><DetailTxt>Oberflächen vorbereiten</DetailTxt><QU>m²</QU></Item></GAEB>';
    const index = createPositionIndex(async () => [{ id: "1", version: "1", fileName: "Leistungen.x83", modifiedAt: "2026-11-11T12:00:00Z", async read() { return xml; } }],
      (xml, signal) => { began(); return browserGaebXml.positions(xml, signal); }, new AbortController().signal);
    try {
      const old = index.search({ query: "Alter Suchbegriff" }).catch(error => error.name); await started;
      const latest = await index.search({ query: "vorb" }); return { old: await old, latest };
    } finally { index.close(); }
  },
  async showPrintTemplates(mode = "editor") {
    const { client, templateAssets } = await import("../../app/lib/client");
    const { acceptVault } = await import("../../app/lib/crypto/session");
    const account = async tenant => {
      const identity = await createIdentity(), key = base64(crypto.getRandomValues(new Uint8Array(64)));
      await acceptVault(key, await createAccountVault(key, tenant, "owner", identity, {}), false);
    };
    await account("print-owner");
    const { templateRevision, readTemplateResource, assetDetails, PRINT_ASSET_TYPES } = await import("../../app/lib/data/printTemplateData");
    const { validatePrintAssetBytes } = await import("../../app/lib/data/printAssetBytes");
    const { ProtectedWriteConflict } = await import("../../app/lib/data/atomicWrites");
    const { prepareTemplateAssets, loadPrintContext, previewOffer, renderGaebPdf } = await import("../../app/lib/gaebPrint");
    const { compileTypst } = await import("@sortsys/gaeb");
    const source = `#let document-header(data) = [HEADER #data.sender.name #box(asset("Logo.png", width: 10mm))]
#let document-footer(data) = context [FOOTER #counter(page).display("1")]
#let table-style = (stroke: 0.3pt + blue, inset: 4pt)
#let document-style(data, body) = {
  set page(paper: "a4", margin: 20mm, header: document-header(data), footer: document-footer(data))
  set text(font: "NimbusSanL", size: 10pt)
  body
}
`;
    const image = async color => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2;
      const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, 2, 2);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const bytes = new Uint8Array(512); bytes.set(new Uint8Array(await blob.arrayBuffer()));
      return new Blob([bytes], { type: "image/png" });
    };
    const version = "a".repeat(32), blobs = new Map([["1", await image("red")]]), calls = [], mutations = [];
    let nextId = 2, paused = false, pending = [], lastPrepared, late = "idle", readable = true;
    let template = { source, revision: await templateRevision(source), assets: [{ id: "1", name: "Logo.png", mimeType: "image/png", sizeBytes: 512, downloadUrl: `sortsys-template:1:${version}` }] };
    const profile = { companyName: "Musterbetrieb Browser", address: { streetAddress: "Bauweg 17", city: "Nürnberg", zip: "90408", country: "DE" } };
    client.query = async path => {
      if (!readable) return [null, new Error("Print access revoked")];
      if (path === "settings.documentTemplate.get") return [structuredClone(template), null];
      if (path === "settings.organization.get") return [profile, null];
      throw new Error("Unexpected print query: " + path);
    };
    client.mutate = async (path, input) => {
      mutations.push({ path, input });
      if (path === "settings.documentTemplate.set") {
        if (input.expectedRevision !== template.revision) return [null, new ProtectedWriteConflict()];
        template = { ...template, source: input.source, revision: await templateRevision(input.source) };
        return [{ source: template.source, revision: template.revision }, null];
      }
      if (path === "settings.documentTemplate.assets.delete") { template.assets = template.assets.filter(asset => asset.id !== input.id); return [{ success: true }, null]; }
      throw new Error("Unexpected print mutation: " + path);
    };
    client.invalidate = async () => {};
    templateAssets.blob = async (id, requested, signal) => {
      calls.push(id); signal?.throwIfAborted();
      if (paused) await new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError")); signal?.addEventListener("abort", abort, { once: true });
        pending.push(() => { signal?.removeEventListener("abort", abort); resolve(); });
      });
      signal?.throwIfAborted();
      if (requested !== version || !template.assets.some(asset => asset.id === id)) throw new Error("Missing private asset");
      return blobs.get(id);
    };
    templateAssets.upload = async file => {
      const details = assetDetails(file.name, PRINT_ASSET_TYPES[file.name.split(".").at(-1).toLowerCase()], file.size);
      validatePrintAssetBytes(details.mimeType, new Uint8Array(await file.arrayBuffer()));
      const id = String(nextId++); blobs.set(id, new Blob([file], { type: details.mimeType }));
      template.assets = [...template.assets.filter(asset => asset.name !== file.name), { id, ...details, downloadUrl: `sortsys-template:${id}:${version}` }]; return id;
    };
    window.cryptoFixture.printState = () => ({ template, calls, mutations, pending: pending.length, late,
      cleared: !!lastPrepared && Object.values(lastPrepared.files).every(bytes => bytes.every(value => value === 0)) });
    window.cryptoFixture.setTemplateSource = async value => {
      const monaco = await import("monaco-editor");
      const model = monaco.editor.getModels().find(model => model.getLanguageId() === "typst"); if (!model) throw new Error("Missing actual Monaco model"); model.setValue(value);
    };
    window.cryptoFixture.printDrafts = async () => {
      const monaco = await import("monaco-editor"); return monaco.editor.getModels().filter(model => model.getLanguageId() === "typst").map(model => model.getValue());
    };
    window.cryptoFixture.revokePrintRead = async () => { readable = false; await client.clearCache(); };
    window.cryptoFixture.switchPrintIdentity = async () => {
      readable = true; template = { ...template, source: source.replace("HEADER", "OTHER TENANT"), revision: await templateRevision(source.replace("HEADER", "OTHER TENANT")) };
      await account("print-other");
    };
    window.cryptoFixture.preparePrintAssets = async () => {
      lastPrepared?.dispose(); lastPrepared = await prepareTemplateAssets(template.assets);
      const prepared = lastPrepared, first = Object.values(prepared.files)[0], bitmap = await createImageBitmap(new Blob([first], { type: "image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2;
      const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0); bitmap.close();
      prepared.context.throwIfAborted();
      return { paths: prepared.paths, pixel: [...context.getImageData(0, 0, 1, 1).data] };
    };
    window.cryptoFixture.switchPrintContext = async () => { blobs.set("1", await image("blue")); await client.clearCache(); };
    window.cryptoFixture.setPrintSvg = async malicious => {
      const source = malicious
        ? '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://outside.example/private"/></g></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:vendor="https://vendor.example/ns" width="2" height="2"><metadata><vendor:record>Nonvisual metadata</vendor:record></metadata><s:rect width="2" height="2" fill="red"/></svg>';
      const blob = new Blob([source], { type: "image/svg+xml" }); blobs.set("1", blob);
      template.assets = [{ ...template.assets[0], name: "Logo.svg", mimeType: blob.type, sizeBytes: blob.size }]; await client.clearCache();
    };
    window.cryptoFixture.pausePrintAssets = () => { paused = true; };
    window.cryptoFixture.releasePrintAssets = () => { paused = false; for (const release of pending.splice(0)) release(); };
    window.cryptoFixture.beginLatePrintAssets = () => { late = "pending"; void prepareTemplateAssets(template.assets).then(value => { value.dispose(); late = "accepted"; }, () => { late = "rejected"; }); };
    window.cryptoFixture.compilePrint = async () => {
      const context = await loadPrintContext(), sample = previewOffer(context);
      const bytes = await renderGaebPdf(sample.xml, "Vorschau.x84", "de", sample.reference, undefined, context);
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")).default;
      const task = pdfjs.getDocument({ data: bytes }), pdf = await task.promise;
      try {
        const text = []; let images = 0;
        for (let index = 1; index <= pdf.numPages; index++) {
          const page = await pdf.getPage(index); text.push((await page.getTextContent()).items.map(item => item.str ?? "").join(" "));
          images += (await page.getOperatorList()).fnArray.filter(op => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject].includes(op)).length;
        }
        return { text: text.join("\n"), pages: pdf.numPages, images };
      } finally { await task.destroy(); }
    };
    window.cryptoFixture.probePrintShadows = async () => {
      const prepared = await prepareTemplateAssets(template.assets);
      try { await compileTypst('#image("/private-logo.png")', { "/private-logo.png": prepared.files[prepared.paths["Logo.png"][0]] }); }
      finally { prepared.dispose(); }
      try { await compileTypst('#image("/private-logo.png")'); return { rejected: false, error: null }; }
      catch (error) { return { rejected: true, error: String(error) }; }
    };
    if (mode === "editor") {
      const { default: Editor } = await import("../../app/components/DocumentTemplateEditor");
      root.render(<I18nProvider><main className="p-6"><Editor /></main></I18nProvider>);
    } else root.render(<I18nProvider><main>Private Druckdateien</main></I18nProvider>);
  },
  async showOrganization(kind = "profile") {
    const { NotificationProvider } = await import("@sortsys/react-components");
    const { client, organizationSettings } = await import("../../app/lib/client");
    const { OrganizationDetailsForm } = await import("../../app/components/OrganizationDetailsForm");
    const { InvoiceNumberingForm } = await import("../../app/components/InvoiceNumberingForm");
    const { organizationProfile, organizationNumbering } = await import("../../app/lib/data/organizationData");
    const { OrganizationEditConflict } = await import("../../app/lib/data/organization");
    const requests = [], invalidations = [];
    let profile = { companyName: "Musterbetrieb Browser", address: { streetAddress: "Bauweg 17", city: "Nürnberg", zip: "90408", country: "DE" } };
    let numbering = { scheme: "sequential", startNumber: "5368" };
    const revisions = { profile: 1, numbering: 1 };
    client.query = async path => {
      if (path === "settings.organization.get") return [structuredClone(profile), null];
      if (path === "settings.invoiceNumbering.get") return [structuredClone(numbering), null];
      throw new Error("Unexpected organization query: " + path);
    };
    client.mutate = async (path, input) => {
      requests.push({ path, input });
      if (path === "settings.organization.set") { profile = organizationProfile(input, true); revisions.profile++; }
      else if (path === "settings.invoiceNumbering.set") { numbering = organizationNumbering(input); revisions.numbering++; }
      else throw new Error("Unexpected organization mutation: " + path);
      return [{ success: true }, null];
    };
    client.invalidate = async path => { invalidations.push(path); };
    const edit = async selected => {
      let basis = revisions[selected];
      return { value: structuredClone(selected === "profile" ? profile : numbering), async save(value) {
        if (basis !== revisions[selected]) throw new OrganizationEditConflict();
        await client.mutate(selected === "profile" ? "settings.organization.set" : "settings.invoiceNumbering.set", value);
        basis = revisions[selected];
      } };
    };
    organizationSettings.profile = () => edit("profile");
    organizationSettings.numbering = () => edit("numbering");
    window.cryptoFixture.changeOrganization = (selected, value) => {
      if (selected === "profile") profile = organizationProfile(value, true); else numbering = organizationNumbering(value);
      revisions[selected]++;
    };
    window.cryptoFixture.readOrganization = async selected => {
      const path = selected === "profile" ? "settings.organization.get" : "settings.invoiceNumbering.get";
      await client.invalidate(path); return client.query(path, undefined);
    };
    window.cryptoFixture.organizationState = () => ({ profile, numbering, requests, invalidations });
    root.render(<I18nProvider><NotificationProvider><main className="mx-auto max-w-3xl p-6">{kind === "profile" ? <OrganizationDetailsForm /> : <InvoiceNumberingForm />}</main></NotificationProvider></I18nProvider>);
  },
  async showCommercialCases() {
    const { client } = await import("../../app/lib/client");
    const { CommercialCaseList } = await import("../../app/components/CommercialCaseList");
    const { MyModalsProvider } = await import("../../app/hooks/useMyModals");
    const streams = new Set(), requests = [];
    let rows = Array.from({ length: 55 }, (_, index) => ({ id: (index + 1).toString(32), title: `Vertrauliches Angebot ${index + 1}`,
      reference: `ANG-2026-${index + 1}`, kind: "offer", status: "draft", netAmount: "879.25", currency: "EUR", customerName: "Bauleitung", projectId: null }));
    client.streamQuery = (path, input) => new Observable(subscriber => {
      if (path !== "commercial.cases.list") throw new Error("Unexpected commercial query: " + path);
      requests.push({ search: input.search, offset: String(input.offset) });
      const emit = () => subscriber.next([rows.slice(Number(input.offset), Number(input.offset + input.limit)), null]);
      streams.add(emit); emit(); return () => streams.delete(emit);
    });
    window.cryptoFixture.commercialState = () => ({ requests, streams: streams.size });
    window.cryptoFixture.changeCommercialCase = title => { rows[0] = { ...rows[0], title }; for (const emit of streams) emit(); };
    window.cryptoFixture.resetCommercialCases = async () => { rows = []; await client.clearCache(); };
    root.render(<I18nProvider><MemoryRouter><MyModalsProvider><CommercialCaseList kind="offer" /></MyModalsProvider></MemoryRouter></I18nProvider>);
  },
  async showPrivateFile(data, kind = "pdf") {
    const { client, projectFiles } = await import("../../app/lib/client");
    const { acceptVault, lockCryptoSession } = await import("../../app/lib/crypto/session");
    const account = async tenant => {
      const identity = await createIdentity(), key = base64(crypto.getRandomValues(new Uint8Array(64)));
      await acceptVault(key, await createAccountVault(key, tenant, "owner", identity, {}), false);
    };
    await account("private-file-first");
    const mime = kind === "pdf" ? "application/pdf" : "message/rfc822";
    let blob = new Blob([new Uint8Array(data)], { type: mime }), paused = false;
    const pending = [];
    const stats = { reads: 0, active: 0, disposed: 0, pending: 0 };
    const read = async () => {
      stats.reads++; const captured = blob;
      if (paused) { stats.pending++; await new Promise(resolve => pending.push(resolve)); stats.pending--; }
      return captured;
    };
    projectFiles.blob = read;
    projectFiles.url = async () => {
      const content = await read(); stats.active++; const url = URL.createObjectURL(content); let disposed = false;
      return { url, dispose() { if (disposed) return; disposed = true; stats.active--; stats.disposed++; URL.revokeObjectURL(url); } };
    };
    window.cryptoFixture.pausePrivateFiles = () => { paused = true; };
    window.cryptoFixture.replacePrivateFile = data => { blob = new Blob([new Uint8Array(data)], { type: mime }); };
    window.cryptoFixture.releasePrivateFiles = () => { paused = false; for (const resolve of pending.splice(0)) resolve(); };
    window.cryptoFixture.resetPrivateFiles = () => client.clearCache();
    window.cryptoFixture.switchFileAccount = () => account("private-file-second");
    window.cryptoFixture.lockFileAccount = () => lockCryptoSession();
    window.privateFileStats = stats;
    const { default: Pdf } = await import("../../app/components/PdfAttachmentViewer");
    const { default: Email } = await import("../../app/components/EmailAttachmentViewer");
    const { default: ProjectPreview } = await import("../../app/components/ProjectFilePreviewModal");
    const { SessionInfoProvider } = await import("../../app/hooks/useSessionInfo");
    const { NotificationProvider } = await import("@sortsys/react-components");
    if (kind === "download") {
      client.loggedIn = () => true;
      client.streamQuery = path => new Observable(subscriber => {
        if (path === "auth.sessionInfo") subscriber.next([{ user: { id: "1", username: "owner", locale: "de" }, tenant: { objectStorageEnabled: true }, roles: [] }, null]);
        else if (path === "projects.files.list") subscriber.next([[{ id: "5", projectId: "4", fileName: "Vertraulich.bin", mimeType: "application/octet-stream", kind: "file", status: "uploaded", downloadUrl: "sortsys-private:4/5/1/original" }], null]);
        else throw new Error("Unexpected private preview query: " + path);
      });
    }
    function Preview() {
      const [open, setOpen] = useState(true);
      return <main className="h-screen flex flex-col"><button onClick={() => setOpen(false)}>Vorschau schließen</button>
        {open && <div className="min-h-0 flex-1">{kind === "download"
          ? <ProjectPreview target={{ projectId: "4", fileId: "5" }} onClose={() => setOpen(false)} />
          : kind === "pdf"
          ? <Pdf url="sortsys-private:4/5/1/original" downloadUrl="sortsys-private:4/5/1/original" fileName="Vertraulich.pdf" />
          : <Email url="sortsys-private:4/5/1/original" format="eml" />}</div>}</main>;
    }
    root.render(<I18nProvider>{kind === "download"
      ? <NotificationProvider><SessionInfoProvider><Preview /></SessionInfoProvider></NotificationProvider>
      : <Preview />}</I18nProvider>);
  },
  async inspectFile(data) {
    const { inspectProjectFile } = await import("../../app/lib/fileInspection");
    return inspectProjectFile(new Blob([new Uint8Array(data)], { type: "application/pdf" }));
  },
  async showUserAccess() {
    const { client } = await import("../../app/lib/client");
    const { acceptVault } = await import("../../app/lib/crypto/session");
    const { PRODUCT_COLLECTION, PRICE_COLLECTION } = await import("../../app/lib/data/products");
    const { privateLlmCollection } = await import("../../app/lib/data/privateLlm");
    const owner = await createIdentity(), member = await createIdentity();
    const personal = privateLlmCollection("user:1"), memberPersonal = privateLlmCollection("user:2");
    const { setup, authorityKey } = await createTenantSetup("test", "user:1", owner, PHRASE,
      { scopes: [PRODUCT_COLLECTION, PRICE_COLLECTION, personal] });
    const certificate = await certifyIdentity({ tenant: "test", generation: "1", user: "user:2", ...await publicIdentity(member) }, authorityKey.privateKey);
    const permissions = await signPolicy({ tenant: "test", version: "2", rules: [...setup.policy.rules,
      { subject: "user:2", scope: "project:4", facet: "master-data", actions: ["read"], effect: "allow" },
      { subject: "user:2", scope: "project:4", facet: "offer-prices", actions: ["read"], effect: "allow" },
      { subject: "user:2", scope: "project:4", facet: "procurement", actions: [...ACTIONS], effect: "allow" },
      { subject: "user:2", scope: PRODUCT_COLLECTION.scope, facet: PRODUCT_COLLECTION.facet, actions: ["read"], effect: "allow" },
      { subject: "user:2", scope: memberPersonal.scope, facet: memberPersonal.facet, actions: [...ACTIONS], effect: "allow" }] }, authorityKey.privateKey);
    const definitions = await Promise.all([PRODUCT_COLLECTION, PRICE_COLLECTION, personal, memberPersonal].map(async area => (await createDomain({
      tenant: "test", id: area.domain, scope: area.scope, facet: area.facet, generation: "1", policyVersion: "2", authorityGeneration: "1",
      authorityKey: authorityKey.privateKey, recovery: { encryptionKey: setup.authority.recoveryEncryptionKey, signingKey: setup.authority.recoverySigningKey },
      readers: [{ subject: area === memberPersonal ? "user:2" : "user:1", identity: area === memberPersonal ? certificate : setup.owner }],
    })).definition));
    const history = { authorities: [{ certificate: setup.authority, transition: null }], identities: [setup.owner, certificate] };
    const members = [{ id: "1", username: "owner", enrolled: true, roles: [":admin"] }, { id: "2", username: "frank.doe", enrolled: true, roles: [":llm"] },
      { id: "3", username: "neues.konto", enrolled: false, roles: [] }];
    const replies = {
      "projects.list": ["Fenstersanierung", "Innenputz"].map((title, index) => ({ id: String(index + 4), title, address: null, customerId: null, responsibleProjectLeaderUserId: null,
        createdByUserId: "1", orderReceivedAt: null, finishedAt: null, createdAt: new Date("2026-11-09T12:00:00Z"), modifiedAt: new Date("2026-11-09T12:00:00Z") })),
      "auth.sessionInfo": { user: { id: "1", username: "owner" }, session: { id: "1" }, roles: [":admin"] },
      "zerotrust.creations.list": [], "zerotrust.status": { profile: setup }, "zerotrust.trust.history": history, "zerotrust.policy.get": permissions,
      "zerotrust.members.list": { rows: members, after: null }, "zerotrust.invitations.list": [],
      "zerotrust.identities.list": [setup.owner, certificate].map(cert => ({ subject: cert.user, encryptionKey: cert.encryptionKey, signingKey: cert.signingKey, certificate: cert })),
      "zerotrust.domains.list": definitions.map(def => ({ id: def.id, scope: def.scope, facet: def.facet, generation: def.generation, rotationRequired: false })),
      "zerotrust.objects.list": { objects: [], after: null, snapshot: "0", keyGeneration: "1" },
    };
    client.query = async (path, input) => {
      if (path === "zerotrust.domains.get") return [definitions.find(def => def.id === input.domain), null];
      if (!(path in replies)) throw new Error("Unexpected UI fixture query: " + path);
      return [replies[path], null];
    };
    client.invalidate = async () => {};
    client.mutate = async () => { throw new Error("The access form must not mutate while selecting a member"); };
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(exportKey, await createAccountVault(exportKey, "test", "owner", owner,
      { recoveryGeneration: "1", recoverySigningKey: setup.authority.recoverySigningKey }), false);
    const { default: OrganizationInvitations } = await import("../../app/components/OrganizationInvitations");
    root.render(<I18nProvider><main className="mx-auto max-w-3xl p-6"><OrganizationInvitations /></main></I18nProvider>);
  },
  async showInvitation(malformed = false, enrolled = true, corrupted = false, waiting = false) {
    const authority = await signingPair();
    const draft = await createInvitation({ tenant: "test", generation: "1", user: "user:123", username: "frank.doe", validUntil: (BigInt(Math.floor(Date.now() / 1000)) + 86400n).toString() }, authority.privateKey);
    const recovery = await signingPair(), recoverySigningKey = await publicSigningKey(recovery.publicKey);
    const certificate = await certifyAuthority({ tenant: "test", generation: "1", recoverySigningKey,
      recoveryEncryptionKey: base64(crypto.getRandomValues(new Uint8Array(32))), authoritySigningKey: await publicSigningKey(authority.publicKey) }, recovery.privateKey);
    const link = { ...draft, recoverySigningKey: corrupted ? base64(crypto.getRandomValues(new Uint8Array(32))) : recoverySigningKey };
    const { client } = await import("../../app/lib/client");
    const originalQuery = client.query.bind(client);
    client.query = (path, input, options) => path === "auth.opaque.invitation"
      ? Promise.resolve([{ invitation: draft.invitation, enrolled, history: { authorities: [{ certificate, transition: null }], identities: [] } }, null])
      : originalQuery(path, input, options);
    window.history.replaceState(null, "", window.location.pathname + "#" + (malformed ? "invalid-fragment" : base64(new TextEncoder().encode(JSON.stringify(link)))));
    if (waiting) {
      const { acceptVault } = await import("../../app/lib/crypto/session");
      const identity = await createIdentity(), exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
      const vault = await createAccountVault(exportKey, "test", "frank.doe", identity, { recoveryGeneration: "1", recoverySigningKey });
      let approved = false; const subscribers = new Set();
      client.query = async path => {
        if (path === "auth.opaque.invitation") return [{ invitation: draft.invitation, enrolled: true, history: { authorities: [{ certificate, transition: null }], identities: [] } }, null];
        if (path === "auth.sessionInfo") return [{ user: { id: "123", username: "frank.doe" }, roles: [] }, null];
        if (path === "zerotrust.invitations.get") return [{ entry: { invitation: draft.invitation, accepted: false }, history: { authorities: [{ certificate, transition: null }], identities: [] } }, null];
        if (path === "auth.opaque.vault") return [{ revision: "1", vault }, null];
        if (path === "zerotrust.status") return [{ accessReady: approved }, null];
        throw new Error("Unexpected waiting invitation query: " + path);
      };
      client.invalidate = async () => {};
      client.mutate = async path => { if (path !== "zerotrust.invitations.join") throw new Error("Unexpected invitation mutation"); return [{ success: true }, null]; };
      client.streamQuery = path => new Observable(subscriber => {
        if (path !== "zerotrust.status") throw new Error("Unexpected invitation subscription");
        subscribers.add(subscriber); subscriber.next([{ accessReady: approved }, null]);
        return () => subscribers.delete(subscriber);
      });
      window.cryptoFixture.completeInvitation = () => { approved = true; for (const subscriber of [...subscribers]) subscriber.next([{ accessReady: true }, null]); };
      await acceptVault(exportKey, vault, false);
    }
    const { default: InvitationPage } = await import("../../app/routes/auth/invitation");
    root.render(<React.StrictMode><I18nProvider><MemoryRouter><InvitationPage /></MemoryRouter></I18nProvider></React.StrictMode>);
    return { secret: link.secret };
  },
  async orientedPhoto(bytes) {
    const blob = await prepareImportImage(new File([new Uint8Array(bytes)], "camera.jpg", { type: "image/jpeg" }), new AbortController().signal);
    const pixels = await createImageBitmap(blob);
    try { return { width: pixels.width, height: pixels.height, mime: blob.type }; }
    finally { pixels.close(); }
  },
  async spreadsheet(bytes) {
    const prepared = await prepareImportFiles([new File([new Uint8Array(bytes)], "preisliste.xlsx")], new AbortController().signal);
    return { text: prepared.text, originals: prepared.files.length, names: prepared.fileNames };
  },
  showLLM() { root.render(<I18nProvider><LLMFixture /></I18nProvider>); },
  finishLLM() { finishLLM?.(); },
  failLLM() { failLLM?.(new Error("Fixture processing failure")); },
  llmState() { return { pending: llmActivity.snapshot().length, aborted: lastLLMSignal?.aborted ?? false }; },
  async remember() {
    const identity = await createIdentity();
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    const vault = await createAccountVault(exportKey, TENANT, USER, identity, { recoveryGeneration: "1", recoverySigningKey: base64(crypto.getRandomValues(new Uint8Array(32))) });
    const stored = await rememberDeviceVault(exportKey, vault);
    return { stored, signingKey: (await publicIdentity(identity)).signingKey };
  },
  async restore() {
    const restored = await restoreDeviceVault(TENANT, USER);
    if (!restored) return null;
    const { identity } = await openAccountVault(restored.exportKey, TENANT, USER, restored.vault);
    const publicKeys = await publicIdentity(identity);
    const message = frame("sortsys/browser-cache-test/v1", [TENANT]);
    await verify(await importSigningKey(publicKeys.signingKey), await sign(identity.signingKey.privateKey, message), message);
    return { signingKey: publicKeys.signingKey };
  },
  async cachedRecord(tamper = false) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("sortsys-device-vault-v1");
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("accounts", tamper ? "readwrite" : "readonly");
        const store = tx.objectStore("accounts");
        const req = store.getAll();
        let result;
        req.onsuccess = () => {
          const [record] = req.result;
          result = record ? { count: req.result.length, nonExtractable: record.key.extractable === false, storedFields: Object.keys(record).sort(), ciphertextLength: record.ciphertext.byteLength } : { count: 0 };
          if (tamper && record) {
            const ciphertext = new Uint8Array(record.ciphertext); ciphertext[0] ^= 1;
            record.ciphertext = ciphertext.buffer; store.put(record);
          }
        };
        tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  forget: forgetDeviceVaults,
  protectedAccount: () => hasProtectedAccount(TENANT, USER),
  async storageFailure() {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = () => { throw new DOMException("Test storage failure", "UnknownError"); };
    try {
      const protectedAccount = await hasProtectedAccount(TENANT, USER);
      let deletionReported = false;
      try { await forgetDeviceVaults(); } catch { deletionReported = true; }
      return { protectedAccount, deletionReported };
    } finally { IDBFactory.prototype.open = original; }
  },
  async duck() {
    const db = await createBusinessDatabase();
    try {
      return (await db.query("SELECT '9223372036854775807'::BIGINT::VARCHAR AS id,1234567890.45::DECIMAL(12,2) AS amount,true AS enabled")).rows[0];
    } finally { await db.close(); }
  },
  async duckLists() {
    const db=await createBusinessDatabase();
    try {
      const row=(await db.query("SELECT $1::VARCHAR[] AS fields,$2::BIGINT[] AS ids,$3::BIGINT[] AS empty",[["Fensteröffnung","line\nbreak","literal\\n"],["9223372036854775807"],[]])).rows[0];
      return {fields:Array.from(row.fields),ids:Array.from(row.ids,String),empty:Array.from(row.empty)};
    } finally {await db.close();}
  },
  async catalogueTime() {
    const db = await createBusinessDatabase();
    try {
      await db.exec("INSERT INTO products(id,custom_id,name,brand,description,regie_report_name,base_unit,other_units,created_at,modified_at) VALUES(9223372036854775807,4711,'Profil',NULL,'Äußere Fensterlaibung',NULL,'m','{}','2026-11-09T13:30:22.123456+02:00','2026-11-09T11:30:22.654321Z')");
      const [row] = await readBusinessRows(db, "products");
      return { id: row.values.id, created: row.values.created_at, modified: row.values.modified_at, description: row.values.description };
    } finally { await db.close(); }
  },
};

// Public test vector; never a user's recovery phrase.
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
function Fixture() {
  const [confirmed, setConfirmed] = useState(false);
  return <main className="mx-auto max-w-3xl p-6">
    {confirmed ? <output aria-label="Backup confirmed">confirmed</output> : <RecoveryPhraseBackup phrase={PHRASE} onCancel={() => {}} onConfirmed={async () => setConfirmed(true)} />}
  </main>;
}
function LLMFixture() {
  const [host, setHost] = useState(true);
  window.cryptoFixture.remountLLMHost = async () => {
    setHost(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    setHost(true);
  };
  return <MemoryRouter>{host && <LLMActivityHost />}<Routes>
    <Route path="/" element={<main>
      <button onClick={() => beginLLM("document-import")}>Einlesen starten</button>
      <button onClick={() => beginLLM("chat")}>Chat starten</button>
      <Link to="/other">Andere Seite öffnen</Link>
    </main>} />
    <Route path="/other" element={<h1>Andere Seite</h1>} />
  </Routes></MemoryRouter>;
}
const root = createRoot(document.getElementById("root"));
root.render(<I18nProvider><Fixture /></I18nProvider>);
