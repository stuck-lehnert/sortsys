import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { createFixtureServer } from "./browser-support.mjs";

let browser, server;
before(async () => { server = await createFixtureServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.close(); });

async function open() {
  const context = await browser.newContext();
  const external = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === server.origin) return route.continue();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${server.origin}/crypto.html`);
  await page.waitForFunction(() => window.cryptoFixture);
  return { context, page, external };
}

async function waitForClosedListboxes(page) {
  // Several portalled popups can coexist during their exit animation.
  await page.waitForFunction(() => [...document.querySelectorAll('[role="listbox"]')].every(node => !node.checkVisibility()));
}

for (const access of ["none", "read", "write"]) test(`the actual tool edit form respects ${access} cost rights without changing hidden prices`, async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(access => window.cryptoFixture.showToolEdit(access), access);
    await page.getByRole("button", { name: "Werkzeug bearbeiten", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Werkzeug bearbeiten" }); await dialog.waitFor();
    await page.waitForFunction(input => input?.value === "Profilfräse", await dialog.getByLabel("Modell", { exact: true }).elementHandle());
    const purchase = dialog.getByLabel("Kaufpreis (EUR)", { exact: true });
    if (access === "none") assert.equal(await purchase.count(), 0);
    else assert.equal(await purchase.isDisabled(), access === "read");
    await dialog.getByLabel("Modell", { exact: true }).fill("Profilfräse überarbeitet");
    await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(() => window.cryptoFixture.toolEdits().length === 1);
    const [mutation] = await page.evaluate(() => window.cryptoFixture.toolEdits());
    assert.equal(mutation.id, "4"); assert.equal(mutation.data.label, "Profilfräse überarbeitet");
    if (access === "write") { assert.equal(mutation.data.purchasePrice, 1537.87654321); assert.equal(mutation.data.usageCostPerDay, 17.375); }
    else { assert.equal(Object.hasOwn(mutation.data, "purchasePrice"), false); assert.equal(Object.hasOwn(mutation.data, "usageCostPerDay"), false); }
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("the actual price import dialog retains its operation ID on retry and changes it for edited input", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPriceImport());
    await page.getByRole("button", { name: "Preisliste prüfen" }).click();
    const dialog = page.getByRole("dialog", { name: "Preise aus Preisliste übernehmen" });
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('.price-import-fields input')?.value === "Baustoffhandel Browser");
    // The exact supplier is selected after the query-aware provider resolves.
    await dialog.getByText("Händler aus der Trefferliste auswählen.").waitFor({ state: "hidden" });
    await dialog.getByRole("button", { name: "Preise speichern", exact: true }).click();
    await dialog.getByText("Verbindung unterbrochen", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Preise speichern", exact: true }).click();
    await page.waitForFunction(() => window.cryptoFixture.priceImportAttempts().length === 2);
    let attempts = await page.evaluate(() => window.cryptoFixture.priceImportAttempts());
    assert.ok(attempts[0].requestId); assert.equal(attempts[0].requestId, attempts[1].requestId);
    await dialog.getByLabel("Preisstand", { exact: true }).fill("2026-11-12");
    await dialog.getByRole("button", { name: "Preise speichern", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    attempts = await page.evaluate(() => window.cryptoFixture.priceImportAttempts());
    assert.equal(attempts.length, 3); assert.notEqual(attempts[1].requestId, attempts[2].requestId);
    assert.notEqual(attempts[1].effectiveAt, attempts[2].effectiveAt);
  } finally { await context.close(); }
});

test("actual session menus use signed grants even when legacy roles claim administrator access", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showMenuAccess());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Menüfreigaben"]')?.textContent ?? "{}").supplierRead === true);
    assert.equal(await page.getByRole("button", { name: "Produkt bearbeiten", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Lieferant bearbeiten", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Preis bearbeiten", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page.getByRole("button", { name: "Preis bearbeiten", exact: true }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "Preis bearbeiten").disabled);
    const rights = JSON.parse(await page.locator('output[aria-label="Menüfreigaben"]').textContent());
    assert.equal(rights.admin, true); assert.equal(rights.createOffer, true); assert.equal(rights.createProject, false);
    assert.equal(rights.project4, true); assert.equal(rights.project5, false); assert.equal(rights.offers, true);
    assert.equal(rights.productRead, false); assert.ok(!rights.roles.includes("manage:products"));
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("revoked and replaced accounts cannot regain menu actions from a delayed policy response", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showMenuAccess());
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Menüfreigaben"]')?.textContent ?? "{}").priceEdit === true);
    await page.evaluate(() => window.cryptoFixture.menuCaptureAction());
    await page.evaluate(() => window.cryptoFixture.menuHold());
    assert.equal(await page.evaluate(() => window.cryptoFixture.oldMenuCanEdit()), false);
    assert.equal(await page.getByRole("button", { name: "Preis bearbeiten", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.cryptoFixture.menuChange("none"));
    await page.evaluate(() => window.cryptoFixture.menuRelease());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Menüfreigaben"]').textContent).priceEdit === false);
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Menüfreigaben"]').textContent).priceEdit === true);
    await page.evaluate(() => window.cryptoFixture.menuCaptureAction());
    await page.evaluate(() => window.cryptoFixture.menuSwitchAccount());
    assert.equal(await page.evaluate(() => window.cryptoFixture.oldMenuCanEdit()), false);
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Menüfreigaben"]')?.textContent ?? "{}").id === "2");
    assert.equal(await page.getByRole("button", { name: "Preis bearbeiten", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Angebot erstellen", exact: true }).isDisabled(), true);
  } finally { await context.close(); }
});

test("failed menu signature checks keep content actions disabled and the actual retry control recovers", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showMenuAccess());
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Menüfreigaben"]')?.textContent ?? "{}").priceEdit === true);
    await page.evaluate(() => window.cryptoFixture.menuTamper());
    const alert = page.getByRole("alert").filter({ hasText: "Die Datenfreigaben konnten nicht geladen werden." });
    await alert.waitFor();
    assert.equal(await page.getByRole("button", { name: "Preis bearbeiten", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.cryptoFixture.menuRepair());
    await alert.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "Preis bearbeiten").disabled);
    await alert.waitFor({ state: "hidden" });
  } finally { await context.close(); }
});

test("the actual view-preference hook flushes pending settings on dialog close and restores them on reopen", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showViewPreferences());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Ansichtseinstellungen"]').textContent).view?.outlineWidth === 320);
    await page.evaluate(() => { window.cryptoFixture.editViewPreference(511); window.cryptoFixture.closeViewPreferences(); });
    await page.waitForFunction(() => window.cryptoFixture.viewPreferenceState().calls.length === 1);
    await page.evaluate(() => window.cryptoFixture.openViewPreferences());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Ansichtseinstellungen"]').textContent).view?.outlineWidth === 511);
  } finally { await context.close(); }
});

test("queued view settings cannot be written under a newly opened account", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showViewPreferences());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Ansichtseinstellungen"]').textContent).view?.outlineWidth === 320);
    await page.evaluate(() => { window.cryptoFixture.pauseViewPreferences(); window.cryptoFixture.editViewPreference(511); void window.cryptoFixture.flushViewPreference(); });
    await page.waitForFunction(() => window.cryptoFixture.viewPreferenceState().calls.length === 1);
    await page.evaluate(() => { window.cryptoFixture.editViewPreference(588); void window.cryptoFixture.flushViewPreference(); });
    await page.evaluate(() => window.cryptoFixture.switchViewPreferenceAccount());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Ansichtseinstellungen"]').textContent).view?.outlineWidth === 407);
    await page.evaluate(() => window.cryptoFixture.releaseViewPreferences());
    await page.evaluate(() => window.cryptoFixture.flushViewPreference());
    const state = await page.evaluate(() => window.cryptoFixture.viewPreferenceState());
    assert.equal(state.calls.length, 1); assert.equal(state.calls[0].scope, 0); assert.equal(state.stored[1][1].outlineWidth, 407);
  } finally { await context.close(); }
});

test("failed automatic view saves remain pending and retry after the browser comes online", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showViewPreferences());
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Ansichtseinstellungen"]').textContent).view?.outlineWidth === 320);
    await page.evaluate(async () => { window.cryptoFixture.failViewPreferences(); window.cryptoFixture.editViewPreference(522); await window.cryptoFixture.flushViewPreference(); });
    await page.getByLabel("Ansichtseinstellungen").filter({ hasText: /nicht gespeichert/ }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => window.cryptoFixture.viewPreferenceState().stored[0][1].outlineWidth === 522);
    await page.waitForFunction(() => JSON.parse(document.querySelector('output[aria-label="Ansichtseinstellungen"]').textContent).error === "");
  } finally { await context.close(); }
});

test("position descriptions are extracted in the actual local XML worker without external requests", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() => window.cryptoFixture.positionTexts('<g:GAEB xmlns:g="http://www.gaeb.de/GAEB_DA_XML/DA84/3.3"><g:Item><g:QU>m²</g:QU><g:UP>87531.2468</g:UP><g:Description><g:OutlTxt><g:p>Fensterlaibung</g:p></g:OutlTxt><g:DetailTxt><g:p>Fensterlaibung</g:p><g:p>Vorhandene Oberflächen schützen.</g:p><g:p>Mehrlagig verputzen.</g:p></g:DetailTxt></g:Description></g:Item></g:GAEB>'));
    assert.deepEqual(result, [{ shortText: "Fensterlaibung", description: "Vorhandene Oberflächen schützen.\nMehrlagig verputzen.", unit: "m²" }]);
    assert.equal(await page.evaluate(async () => { try { await window.cryptoFixture.positionTexts('<!DOCTYPE GAEB [<!ENTITY remote SYSTEM "https://outside.example/private">]><GAEB>&remote;</GAEB>'); return false; } catch { return true; } }), true);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("position autocomplete accepts description matches and removes stale suggestions after a failed search", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPositionSearch());
    const input = page.getByRole("combobox", { name: "Bisherige Positionen durchsuchen" });
    await input.fill("Oberflächen");
    await page.getByRole("option").filter({ hasText: "Fensterlaibung" }).waitFor();
    await input.fill("Fehler");
    await page.waitForFunction(() => window.cryptoFixture.lastPositionQuery === "Fehler");
    await page.getByRole("option").filter({ hasText: "Fensterlaibung" }).waitFor({ state: "hidden" });
    await input.fill("Oberflächen");
    await page.getByRole("option").filter({ hasText: "Fensterlaibung" }).click();
    assert.equal((await page.evaluate(() => window.cryptoFixture.selectedPosition)).description, "Oberflächen sorgfältig vorbereiten");
  } finally { await context.close(); }
});

test("a newer position query cancels the actual XML worker and returns only current suggestions", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() => window.cryptoFixture.replacePositionQuery());
    assert.equal(result.old, "AbortError"); assert.equal(result.latest.items[0].shortText, "Fensterlaibung"); assert.equal(result.latest.indexing, false);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("trade position text survives scope-only browser rendering while quantities, prices and extensions remain hidden", async () => {
  const { context, page, external } = await open();
  try {
    for (const phase of ["93", "94", "96", "97"]) {
      const result = await page.evaluate(phase => window.cryptoFixture.positionScopeTexts(`<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA${phase}/3.3"><GAEBInfo><Version>3.3</Version><VersDate>2021-05</VersDate></GAEBInfo><Order><DP>${phase}</DP><OrderItem ID="item"><Qty>312.50</Qty><QU>m²</QU><Description><DetailTxt><Text><p><span>Fassadenplatte</span></p><p><span>Witterungsbeständige Außenbekleidung.</span></p></Text></DetailTxt></Description><NetPrice>592.51</NetPrice><PriceBasis>777.77</PriceBasis><VendorPrice>GEHEIM-345</VendorPrice></OrderItem></Order></GAEB>`), phase);
      assert.equal(result.complete, false);
      assert.deepEqual(result.positions, [{ shortText: "Fassadenplatte", description: "Witterungsbeständige Außenbekleidung.", unit: "m²" }]);
      for (const hidden of ["312.50", "592.51", "777.77", "GEHEIM-345"]) assert.ok(!result.xml.includes(hidden));
    }
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("the organization form supplies the complete locally validated sender address", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showOrganization());
    await page.waitForFunction(() => document.querySelector('input[name="companyName"]')?.value === "Musterbetrieb Browser");
    await page.getByRole("textbox", { name: /^Firmenname/ }).fill("Privater Musterbetrieb");
    await page.getByRole("textbox", { name: "Straße und Hausnummer", exact: true }).fill("Handwerkerstraße 23");
    await page.getByRole("textbox", { name: "Ort", exact: true }).fill("Bamberg");
    await page.getByRole("textbox", { name: "PLZ", exact: true }).fill("96047");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(() => window.cryptoFixture.organizationState().requests.length === 1);
    const state = await page.evaluate(() => window.cryptoFixture.organizationState());
    assert.deepEqual(state.profile, { companyName: "Privater Musterbetrieb", address: { streetAddress: "Handwerkerstraße 23", city: "Bamberg", zip: "96047", country: "DE" } });
    assert.ok(state.invalidations.includes("settings.organization.get"));
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("invoice numbering settings retain large decimal counters in the existing form", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showOrganization("numbering"));
    const scheme = page.getByRole("button", { name: /Rechnungsnummer-Schema/ });
    await scheme.and(page.locator(":enabled")).waitFor();
    await scheme.click();
    await page.getByRole("option", { name: "Projektbasiert, lokal fortlaufend", exact: true }).click();
    await page.getByRole("textbox", { name: /^Startnummer je Projekt/ }).fill("1234567890123456789");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(() => window.cryptoFixture.organizationState().requests.length === 1);
    const state = await page.evaluate(() => window.cryptoFixture.organizationState());
    assert.deepEqual(state.numbering, { scheme: "projectLocal", startNumber: "1234567890123456789" });
    assert.ok(state.invalidations.includes("settings.invoiceNumbering.get"));
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

for (const kind of ["profile", "numbering"]) test(`a stale ${kind} form keeps its input and requires a deliberate reload`, async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(kind => window.cryptoFixture.showOrganization(kind), kind);
    const input = page.getByRole("textbox", { name: kind === "profile" ? /^Firmenname/ : /^Globale Startnummer/ });
    await input.and(page.locator(":enabled")).waitFor();
    await page.waitForFunction(kind => document.querySelector(`input[name="${kind === 'profile' ? 'companyName' : 'startNumber'}"]`)?.value === (kind === 'profile' ? 'Musterbetrieb Browser' : '5368'), kind);
    const typed = kind === "profile" ? "Eigene noch ungespeicherte Anschrift" : "1234567890123456789";
    await input.fill(typed);
    await page.evaluate(async kind => {
      window.cryptoFixture.changeOrganization(kind, kind === "profile"
        ? { companyName: "Anderer gespeicherter Stand", address: { streetAddress: "Neuer Bauweg 8", city: "Bamberg", zip: "96047", country: "DE" } }
        : { scheme: "sequential", startNumber: "987654321012345678" });
      await window.cryptoFixture.readOrganization(kind);
    }, kind);
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.getByText(/Die Einstellungen wurden inzwischen geändert/).waitFor();
    assert.equal(await input.inputValue(), typed);
    assert.equal((await page.evaluate(() => window.cryptoFixture.organizationState())).requests.length, 0);
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    assert.equal((await page.evaluate(() => window.cryptoFixture.organizationState())).requests.length, 0);
    await page.getByRole("button", { name: "Aktuellen Stand laden", exact: true }).click();
    await page.waitForFunction(kind => document.querySelector(`input[name="${kind === 'profile' ? 'companyName' : 'startNumber'}"]`)?.value === (kind === 'profile' ? 'Anderer gespeicherter Stand' : '987654321012345678'), kind);
    await input.fill(typed);
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(() => window.cryptoFixture.organizationState().requests.length === 1);
    await input.fill(kind === "profile" ? "Zweite bestätigte Änderung" : "876543210123456789");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(() => window.cryptoFixture.organizationState().requests.length === 2);
  } finally { await context.close(); }
});

test("private print pixels and prepared buffers follow the current access context even for identical asset identifiers", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPrintTemplates("cache"));
    const first = await page.evaluate(() => window.cryptoFixture.preparePrintAssets());
    assert.deepEqual(first.pixel, [255, 0, 0, 255]);
    await page.evaluate(() => window.cryptoFixture.preparePrintAssets());
    assert.equal((await page.evaluate(() => window.cryptoFixture.printState())).calls.length, 1);
    await page.evaluate(() => window.cryptoFixture.switchPrintContext());
    assert.equal((await page.evaluate(() => window.cryptoFixture.printState())).cleared, true);
    const next = await page.evaluate(() => window.cryptoFixture.preparePrintAssets());
    assert.deepEqual(next.pixel, [0, 0, 255, 255]);
    assert.equal((await page.evaluate(() => window.cryptoFixture.printState())).calls.length, 2);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("a late print asset cannot return pixels or enter the next access context's cache", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPrintTemplates("cache"));
    await page.evaluate(() => { window.cryptoFixture.pausePrintAssets(); window.cryptoFixture.beginLatePrintAssets(); });
    await page.waitForFunction(() => window.cryptoFixture.printState().pending === 1);
    await page.evaluate(async () => { await window.cryptoFixture.switchPrintContext(); window.cryptoFixture.releasePrintAssets(); });
    await page.waitForFunction(() => window.cryptoFixture.printState().late === "rejected");
    assert.deepEqual((await page.evaluate(() => window.cryptoFixture.preparePrintAssets())).pixel, [0, 0, 255, 255]);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("SVG print pixels use a canonical static document and reject foreign embedded browsing contexts", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(async () => { await window.cryptoFixture.showPrintTemplates("cache"); await window.cryptoFixture.setPrintSvg(false); });
    assert.deepEqual((await page.evaluate(() => window.cryptoFixture.preparePrintAssets())).pixel, [255, 0, 0, 255]);
    await page.evaluate(() => window.cryptoFixture.setPrintSvg(true));
    assert.equal(await page.evaluate(async () => { try { await window.cryptoFixture.preparePrintAssets(); return false; } catch { return true; } }), true);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("a template draft survives an unrelated access refresh but is removed after read revocation and identity change", { timeout: 60000 }, async () => {
  const { context, page } = await open(); page.setDefaultTimeout(15000);
  try {
    await page.evaluate(() => window.cryptoFixture.showPrintTemplates());
    await page.getByRole("textbox", { name: "Typst-Vorlagencode", exact: true }).waitFor();
    await page.evaluate(async () => { const source = window.cryptoFixture.printState().template.source; await window.cryptoFixture.setTemplateSource(source + "\n// PRIVATE UNSAVED DRAFT 48931\n"); });
    await page.evaluate(() => window.cryptoFixture.switchPrintContext());
    await page.waitForFunction(async () => (await window.cryptoFixture.printDrafts()).some(value => value.includes("PRIVATE UNSAVED DRAFT 48931")));
    await page.evaluate(() => window.cryptoFixture.revokePrintRead());
    await page.getByText("Vorlage nicht geladen", { exact: true }).waitFor();
    await page.waitForFunction(async () => (await window.cryptoFixture.printDrafts()).length === 0);
    await page.evaluate(() => window.cryptoFixture.switchPrintIdentity());
    await page.waitForFunction(async () => (await window.cryptoFixture.printDrafts()).some(value => value.includes("OTHER TENANT")));
    assert.equal((await page.evaluate(() => window.cryptoFixture.printDrafts())).some(value => value.includes("PRIVATE UNSAVED DRAFT 48931")), false);
  } finally { await context.close(); }
});

test("the actual Typst editor compiles private header/footer/table styles with images and PDF pages and clears compiler shadows", { timeout: 90000 }, async () => {
  const { context, page, external } = await open(); page.setDefaultTimeout(20000);
  try {
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.evaluate(() => window.cryptoFixture.showPrintTemplates());
    await page.getByRole("textbox", { name: "Typst-Vorlagencode", exact: true }).waitFor();
    await page.getByRole("region", { name: "PDF-Vorschau", exact: true }).locator("iframe").waitFor();
    const before = await page.evaluate(() => window.cryptoFixture.compilePrint());
    assert.match(before.text, /HEADER Musterbetrieb Browser/); assert.match(before.text, /FOOTER/); assert.ok(before.images >= 1);
    const pdf = await readFile(new URL("../../../sortsys-api-v2/test-files/searchable-project-document.pdf", import.meta.url));
    await page.locator('input[type="file"]').setInputFiles({ name: "Bauplan.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByText("Bauplan.pdf", { exact: true }).waitFor();
    const source = (await page.evaluate(() => window.cryptoFixture.printState())).template.source.replace("HEADER", "KOPF PRIVAT").replace("  body\n", '  body\n  attachment("Bauplan.pdf", width: 100%)\n');
    await page.evaluate(source => window.cryptoFixture.setTemplateSource(source), source);
    await page.getByRole("button", { name: "Vorlage speichern", exact: true }).and(page.locator(":enabled")).waitFor();
    await page.getByRole("button", { name: "Vorlage speichern", exact: true }).click();
    await page.waitForFunction(() => window.cryptoFixture.printState().template.source.includes("KOPF PRIVAT"));
    const after = await page.evaluate(() => window.cryptoFixture.compilePrint());
    assert.match(after.text, /KOPF PRIVAT Musterbetrieb Browser/); assert.ok(after.images >= 2); assert.ok(after.pages >= 2);
    await page.evaluate(() => window.cryptoFixture.setTemplateSource("#let broken = ("));
    await page.getByText("Typst-Vorlage prüfen", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Vorlage speichern", exact: true }).isDisabled(), true);
    assert.match((await page.evaluate(() => window.cryptoFixture.printState())).template.source, /KOPF PRIVAT/);
    const count = (await page.evaluate(() => window.cryptoFixture.printState())).mutations.length;
    await page.getByRole("textbox", { name: "Typst-Vorlagencode", exact: true }).press("ControlOrMeta+s");
    await page.getByText("Aktion nicht abgeschlossen", { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.cryptoFixture.printState())).mutations.length, count, "Keyboard saving must also compile before publishing");
    await page.locator('input[type="file"]').setInputFiles({ name: "Remote.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg><image href="https://outside.example/logo.png"/></svg>') });
    await page.getByText(/Die Datei ist ungültig oder enthält externe Verweise/).waitFor();
    assert.equal((await page.evaluate(() => window.cryptoFixture.printState())).template.assets.length, 2);
    const shadows = await page.evaluate(() => window.cryptoFixture.probePrintShadows());
    assert.equal(shadows.rejected, true, JSON.stringify(shadows));
    // A removed shadow has no filesystem capability. The WASM loader may
    // report either a missing file or a denied path outside its virtual root.
    assert.match(shadows.error, /failed to load file.*(?:access denied|file not found)/i);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("commercial lists stream all loaded pages, accept query results and clear old account data", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showCommercialCases());
    const list = page.getByRole("region", { name: "Angebotsübersicht" });
    await list.getByText("Vertrauliches Angebot 1", { exact: true }).waitFor();
    await list.getByRole("button", { name: "Mehr anzeigen" }).click();
    await list.getByText("Vertrauliches Angebot 55", { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.cryptoFixture.commercialState())).streams, 2);
    await page.evaluate(() => window.cryptoFixture.changeCommercialCase("Gemeinsam geändertes Angebot"));
    await list.getByText("Gemeinsam geändertes Angebot", { exact: true }).waitFor();
    assert.equal(await list.getByText("Vertrauliches Angebot 55", { exact: true }).count(), 1);
    await list.getByLabel("Suchen", { exact: true }).fill("Beschreibungstreffer");
    await list.getByText("Gemeinsam geändertes Angebot", { exact: true }).waitFor();
    const state = await page.evaluate(() => window.cryptoFixture.commercialState());
    assert.equal(state.streams, 1); assert.equal(state.requests.at(-1).search, "Beschreibungstreffer");
    await page.evaluate(() => window.cryptoFixture.resetCommercialCases());
    await list.getByText("Gemeinsam geändertes Angebot", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await list.getByText("Vertrauliches Angebot 55", { exact: true }).count(), 0);
    await list.getByText(/Noch keine Angebote/).waitFor();
    assert.equal((await page.evaluate(() => window.cryptoFixture.commercialState())).streams, 1);
  } finally { await context.close(); }
});

test("an invitation opens the ordinary password form and removes its secret fragment in StrictMode", async () => {
  const { context, page, external } = await open();
  try {
    const link = await page.evaluate(() => window.cryptoFixture.showInvitation());
    await page.getByRole("heading", { name: "Einladung annehmen" }).waitFor();
    await page.getByLabel(/^Passwort/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Anmelden", exact: true }).count(), 1);
    assert.equal(new URL(page.url()).hash, "");
    assert.equal((await page.locator("body").innerText()).includes(link.secret), false);
    assert.equal(await page.locator('input[type="password"]').count(), 1);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("a new member sets an ordinary password after local invitation verification", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showInvitation(false, false));
    await page.getByLabel(/^Passwort festlegen/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Zugang einrichten", exact: true }).count(), 1);
    assert.equal(await page.locator('input[type="password"]').getAttribute("autocomplete"), "new-password");
    assert.equal(new URL(page.url()).hash, ""); assert.deepEqual(external, []);
  } finally { await context.close(); }
});
test("an operator-substituted invitation authority cannot open a password form", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showInvitation(false, false, true));
    await page.getByText("Die Einladung konnte nicht geprüft werden.", { exact: false }).waitFor();
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.equal(new URL(page.url()).hash, ""); assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("a malformed invitation shows a fixed error without reflecting its fragment", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showInvitation(true));
    await page.getByText("Die Einladung ist unvollständig.", { exact: false }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal((await page.locator("body").innerText()).includes("invalid-fragment"), false);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("an accepted invitation opens the workspace action when approval arrives without a manual refresh", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showInvitation(false, true, false, true));
    await page.getByRole("button", { name: "Freigabe prüfen", exact: true }).waitFor();
    await page.evaluate(() => window.cryptoFixture.completeInvitation());
    await page.getByRole("button", { name: "Arbeitsbereich öffnen", exact: true }).waitFor();
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("project value and subcontract grants remain independent in the actual access form", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
    await page.getByRole("option", { name: "frank.doe", exact: true }).click();
    const project = page.getByRole("combobox", { name: "Projekt", exact: true });
    await project.fill("Fenster"); await page.getByRole("option", { name: "Fenstersanierung", exact: true }).click();
    await waitForClosedListboxes(page);
    const values = page.getByRole("button", { name: /Auftragswerte/ }), awards = page.getByRole("button", { name: /Weitervergaben/ }), master = page.getByRole("button", { name: /Projektgrunddaten/ });
    assert.match(await values.innerText(), /Lesen/); assert.match(await awards.innerText(), /Lesen und bearbeiten/); assert.match(await master.innerText(), /Lesen/);
    await values.click(); await page.getByRole("option", { name: "Kein Zugriff", exact: true }).click();
    await waitForClosedListboxes(page);
    assert.match(await values.innerText(), /Kein Zugriff/); assert.match(await awards.innerText(), /Lesen und bearbeiten/); assert.match(await master.innerText(), /Lesen/);
    await project.fill("Innenputz"); await page.getByRole("option", { name: "Innenputz", exact: true }).click();
    await waitForClosedListboxes(page);
    assert.match(await values.innerText(), /Kein Zugriff/); assert.match(await awards.innerText(), /Kein Zugriff/); assert.match(await master.innerText(), /Kein Zugriff/);
  } finally { await context.close(); }
});

test("the access form distinguishes editing a certified member from inviting a new account", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    const account = page.getByRole("combobox", { name: "Benutzerkonto" });
    await account.fill("frank");
    await page.getByRole("option", { name: "frank.doe", exact: true }).click();
    await page.getByRole("button", { name: "Berechtigungen speichern", exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Persönlichen KI-Verlauf bereitstellen" }).isChecked(), true);
    const prices = page.getByRole("button", { name: /Preisaufzeichnungen/ });
    const suppliers = page.getByRole("button", { name: /Lieferanten/ });
    assert.match(await prices.innerText(), /Kein Zugriff/);
    assert.match(await suppliers.innerText(), /Kein Zugriff/);
    await page.locator('[role="listbox"]').waitFor({ state: "hidden" });
    const customers = page.getByRole("button", { name: /Kunden/ });
    const contacts = page.getByRole("button", { name: /Ansprechpartner/ });
    assert.match(await customers.innerText(), /Kein Zugriff/);
    assert.match(await contacts.innerText(), /Kein Zugriff/);
    await prices.click();
    await page.getByRole("option", { name: "Lesen und bearbeiten", exact: true }).click();
    await waitForClosedListboxes(page);
    assert.match(await prices.innerText(), /Lesen und bearbeiten/);
    assert.match(await suppliers.innerText(), /Kein Zugriff/);
    await suppliers.click();
    await page.getByRole("option", { name: "Lesen", exact: true }).click();
    await waitForClosedListboxes(page);
    assert.match(await suppliers.innerText(), /Lesen/);
    assert.match(await prices.innerText(), /Lesen und bearbeiten/);
    await customers.click();
    await page.getByRole("option", { name: "Lesen", exact: true }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.match(await customers.innerText(), /Lesen/);
    assert.match(await contacts.innerText(), /Kein Zugriff/);
    const project = page.getByRole("combobox", { name: "Projekt", exact: true });
    await project.fill("Fenster");
    await page.getByRole("option", { name: "Fenstersanierung", exact: true }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    const projectLevel = page.getByRole("button", { name: /Projektgrunddaten/ });
    assert.match(await projectLevel.innerText(), /Lesen/);
    await project.fill("Innenputz");
    await page.getByRole("option", { name: "Innenputz", exact: true }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.match(await projectLevel.innerText(), /Kein Zugriff/);
    const creation = page.getByRole("checkbox", { name: "Neue Projekte anlegen", exact: true });
    const saveCreation = page.getByRole("button", { name: "Anlageberechtigung speichern", exact: true });
    assert.equal(await creation.isChecked(), false);
    assert.equal(await saveCreation.isDisabled(), true);
    await page.getByText("Neue Projekte anlegen", { exact: true }).click();
    assert.equal(await creation.isChecked(), true);
    assert.equal(await saveCreation.isEnabled(), true);
    await creation.focus(); await page.keyboard.press("Space");
    assert.equal(await creation.isChecked(), false);
    assert.equal(await saveCreation.isDisabled(), true);
    const commercial = page.getByRole("checkbox", { name: "Neue Angebote und Aufträge anlegen", exact: true });
    assert.equal(await commercial.isChecked(), false);
    await commercial.focus(); await page.keyboard.press("Space");
    assert.equal(await commercial.isChecked(), true);
    assert.equal(await creation.isChecked(), false, "Offer creation must not toggle project creation");
    assert.equal(await saveCreation.isEnabled(), true);
    await page.keyboard.press("Space");
    assert.equal(await commercial.isChecked(), false);
    assert.equal(await saveCreation.isDisabled(), true);
    await page.screenshot({ path: "/tmp/sortsys-user-access.png", fullPage: true });
    await account.fill("neues");
    await page.getByRole("option", { name: "neues.konto", exact: true }).click();
    await page.getByRole("button", { name: "Einladung erstellen", exact: true }).waitFor();
    assert.match(await customers.innerText(), /Kein zusätzlicher Zugriff/);
    assert.equal(await page.getByRole("heading", { name: "Projektzugriff", exact: true }).count(), 0);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("encrypted device keys survive refresh, reject tampering and are erased on sign-out", async () => {
  const { context, page, external } = await open();
  try {
    const original = await page.evaluate(() => window.cryptoFixture.remember());
    assert.equal(original.stored, true);
    await page.reload();
    await page.waitForFunction(() => window.cryptoFixture);
    assert.equal((await page.evaluate(() => window.cryptoFixture.restore())).signingKey, original.signingKey);
    const record = await page.evaluate(() => window.cryptoFixture.cachedRecord());
    assert.equal(record.nonExtractable, true);
    assert.equal(record.ciphertextLength, 80);
    assert.deepEqual(record.storedFields, ["ciphertext", "id", "key", "nonce", "tenant", "username", "vault"]);
    await page.evaluate(() => window.cryptoFixture.cachedRecord(true));
    assert.equal(await page.evaluate(() => window.cryptoFixture.restore()), null);
    assert.equal(await page.evaluate(() => window.cryptoFixture.protectedAccount()), true);
    await page.evaluate(() => window.cryptoFixture.remember());
    await page.evaluate(() => window.cryptoFixture.forget());
    assert.equal((await page.evaluate(() => window.cryptoFixture.cachedRecord())).count, 0);
    assert.equal(await page.evaluate(() => window.cryptoFixture.restore()), null);
    assert.equal(await page.evaluate(() => window.cryptoFixture.protectedAccount()), true);
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.storageFailure()), { protectedAccount: true, deletionReported: true });
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("the real DuckDB worker loads only local assets and returns exact amounts", async () => {
  const { context, page, external } = await open();
  try {
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.duck()), { id: "9223372036854775807", amount: "1234567890.45", enabled: true });
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("DuckDB worker parameters preserve Unicode, newlines and exact lists of identifiers",async()=>{
  const {context,page,external}=await open();
  try {
    assert.deepEqual(await page.evaluate(()=>window.cryptoFixture.duckLists()),{fields:["Fensteröffnung","line\nbreak","literal\\n"],ids:["9223372036854775807"],empty:[]});
    assert.deepEqual(external,[]);
  } finally {await context.close();}
});

test("catalogue rows cross the real worker boundary with UTC microseconds and exact IDs", async () => {
  const { context, page, external } = await open();
  try {
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.catalogueTime()), {
      id: "9223372036854775807", created: "2026-11-09T11:30:22.123456Z", modified: "2026-11-09T11:30:22.654321Z", description: "Äußere Fensterlaibung",
    });
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("recovery backup requires three correct words before continuing", async () => {
  const { context, page } = await open();
  try {
    await page.getByRole("button", { name: /Sicherung prüfen|Check backup/ }).click();
    const fields = page.getByRole("textbox");
    assert.equal(await fields.count(), 3);
    for (const field of await fields.all()) {
      const wordNumber = Number(await field.evaluate(el => el.labels[0].textContent.match(/\d+/)[0]));
      await field.fill(wordNumber === 24 ? "art" : "abandon");
    }
    await page.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await fields.first().fill("wrong-word");
    await page.getByRole("button", { name: /Mit gesicherter Phrase fortfahren|Continue with backed-up phrase/ }).click();
    await page.getByText(/Die Wörter stimmen nicht|The words do not match/).waitFor();
    assert.equal(await page.getByLabel("Backup confirmed").count(), 0);
    const firstNumber = Number(await fields.first().evaluate(el => el.labels[0].textContent.match(/\d+/)[0]));
    await fields.first().fill(firstNumber === 24 ? "art" : "abandon");
    await page.getByRole("button", { name: /Mit gesicherter Phrase fortfahren|Continue with backed-up phrase/ }).click();
    await page.getByLabel("Backup confirmed").waitFor();
  } finally { await context.close(); }
});

test("recovery words remain contained on a phone and a desktop", async () => {
  const { context, page } = await open();
  try {
    for (const width of [320, 1365]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const words = page.getByRole("listitem");
      assert.equal(await words.count(), 24);
      assert.equal(await words.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true);
    }
  } finally { await context.close(); }
});

test("import processing has no close control and ignores Escape and backdrop clicks", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const dialog = page.getByRole("dialog", { name: /Dokumente werden eingelesen|Reading documents/ });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("button").count(), 0);
    await dialog.getByText(/Neuladen oder Schließen|Reloading or closing/).waitFor();
    await page.keyboard.press("Escape"); await page.mouse.click(3, 3);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    }), true);
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    }), false);
  } finally { await context.close(); }
});

test("internal navigation keeps chat work alive while leaving the document cancels it", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Chat starten" }).click();
    await page.getByRole("link", { name: "Andere Seite öffnen" }).click();
    await page.getByRole("heading", { name: "Andere Seite" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.llmState()), { pending: 1, aborted: false });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.llmState()), { pending: 0, aborted: true });
  } finally { await context.close(); }
});

test("the import dialog and operation survive an internal route change", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const progress = page.getByRole("dialog", { name: /Dokumente werden eingelesen|Reading documents/ });
    await progress.waitFor();
    // The modal blocks pointer navigation; a router change can still arrive
    // through history or application code while the request is in progress.
    await page.locator('a[href="/other"]').evaluate(link => link.click());
    await page.getByRole("heading", { name: "Andere Seite", includeHidden: true }).waitFor({ state: "attached" });
    assert.equal(await progress.isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.llmState()), { pending: 1, aborted: false });
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await progress.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Andere Seite" }).waitFor();
  } finally { await context.close(); }
});

test("cancelling an actual reload keeps the import and its progress dialog alive", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const progress = page.getByRole("dialog", { name: /Dokumente werden eingelesen|Reading documents/ });
    await progress.waitFor();
    const warning = page.waitForEvent("dialog");
    const reload = page.reload().catch(() => null);
    const dialog = await warning;
    assert.equal(dialog.type(), "beforeunload");
    await dialog.dismiss(); await reload;
    assert.equal(await progress.isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.llmState()), { pending: 1, aborted: false });
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await progress.waitFor({ state: "hidden" });
  } finally { await context.close(); }
});

test("accepting an actual reload interrupts the import before the new document opens", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    await page.getByRole("dialog", { name: /Dokumente werden eingelesen|Reading documents/ }).waitFor();
    await page.evaluate(() => window.addEventListener("pagehide", () => {
      // Record only test lifecycle flags, never document contents or keys.
      sessionStorage.setItem("llm-lifetime-check", JSON.stringify(window.cryptoFixture.llmState()));
    }, { once: true }));
    const warning = page.waitForEvent("dialog");
    const reload = page.reload();
    const dialog = await warning;
    assert.equal(dialog.type(), "beforeunload");
    await dialog.accept(); await reload;
    await page.waitForFunction(() => window.cryptoFixture);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("llm-lifetime-check"))), { pending: 0, aborted: true });
    assert.equal(await page.getByRole("dialog").count(), 0);
  } finally { await context.close(); }
});

test("remounting the progress host keeps the import alive and a failed import releases the dialog", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const dialog = page.getByRole("dialog", { name: /Dokumente werden eingelesen|Reading documents/ });
    await dialog.waitFor();
    await page.evaluate(() => window.cryptoFixture.remountLLMHost());
    await dialog.waitFor();
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.llmState()), { pending: 1, aborted: false });
    await page.evaluate(() => window.cryptoFixture.failLLM());
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    }), false);
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await dialog.waitFor({ state: "hidden" });
  } finally { await context.close(); }
});


test("spreadsheet import runs in the real browser worker without external requests", async () => {
  const { context, page, external } = await open();
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Material").addRow(["Perlfix", 7.29, "Sack"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const result = await page.evaluate(data => window.cryptoFixture.spreadsheet(data), Array.from(buffer));
    assert.equal(result.originals, 0);
    assert.deepEqual(result.names, ["preisliste.xlsx"]);
    assert.ok(result.text.includes("Perlfix | 7.29 | Sack"));
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});


test("camera EXIF orientation is resolved before the model receives JPEG pixels", async () => {
  const { context, page, external } = await open();
  try {
    const jpeg = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 40; canvas.height = 20;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "red"; ctx.fillRect(0, 0, 40, 20);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    // Synthetic APP1 Exif/TIFF entry: orientation=6 (90 degrees clockwise).
    const exif = [0xff,0xe1,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,0x12,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0];
    const oriented = [...jpeg.slice(0, 2), ...exif, ...jpeg.slice(2)];
    const result = await page.evaluate(data => window.cryptoFixture.orientedPhoto(data), oriented);
    assert.deepEqual(result, { width: 20, height: 40, mime: "image/jpeg" });
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("private PDF preview resolves local bytes and releases its object URL when closed", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(new URL("../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf", import.meta.url));
    const requests = []; page.on("request", request => requests.push(request.url()));
    await page.evaluate(data => window.cryptoFixture.showPrivateFile(data), Array.from(bytes));
    const frame = page.frameLocator('iframe[title="PDF ansehen"],iframe[title="View PDF"]');
    await frame.locator(".page").first().waitFor();
    assert.equal(await page.evaluate(() => window.privateFileStats.active), 1);
    assert.equal(requests.some(url => url.includes("sortsys-private:") || url.includes("Vertraulich")), false);
    await page.getByRole("button", { name: "Vorschau schließen" }).click();
    await page.waitForFunction(() => window.privateFileStats.active === 0);
    assert.equal(await page.evaluate(() => window.privateFileStats.disposed), 1);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("new PDF text is extracted locally without OCR or document uploads", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(new URL("../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf", import.meta.url));
    const result = await page.evaluate(data => window.cryptoFixture.inspectFile(data), Array.from(bytes));
    assert.ok(result.text.length > 20); assert.ok(result.pages > 0);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("an encrypted EML opens through the browser resource loader with its attachment intact", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(new URL("../../../sortsys-api-v2/seed-assets/materialfreigabe.eml", import.meta.url));
    const requests = []; page.on("request", request => requests.push(request.url()));
    await page.evaluate(data => window.cryptoFixture.showPrivateFile(data, "email"), Array.from(bytes));
    await page.getByRole("heading", { name: "Materialfreigabe - Innenanstrich" }).waitFor();
    await page.frameLocator('iframe[title="Nachricht"],iframe[title="Message"]').getByText(/die Musterfläche ist freigegeben/).waitFor();
    assert.equal(await page.getByRole("button", { name: /materialfreigabe.pdf.*herunterladen|Download materialfreigabe.pdf/ }).count(), 1);
    assert.equal(await page.evaluate(() => window.privateFileStats.reads), 1);
    assert.equal(requests.some(url => url.includes("sortsys-private:") || url.includes("materialfreigabe.eml")), false);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("private PDF pixels disappear on access reset and late leases cannot cross an account switch", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(new URL("../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf", import.meta.url));
    await page.evaluate(data => window.cryptoFixture.showPrivateFile(data), Array.from(bytes));
    const frame = () => page.frameLocator('iframe[title="PDF ansehen"],iframe[title="View PDF"]');
    await frame().locator(".page").first().waitFor();
    await page.evaluate(async () => { window.cryptoFixture.pausePrivateFiles(); await window.cryptoFixture.resetPrivateFiles(); });
    await page.waitForFunction(() => window.privateFileStats.pending === 1 && window.privateFileStats.active === 0);
    assert.equal(await page.locator('iframe[title="PDF ansehen"],iframe[title="View PDF"]').isVisible(), false);
    await page.evaluate(() => window.cryptoFixture.switchFileAccount());
    await page.waitForFunction(() => window.privateFileStats.pending === 2);
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    await frame().locator(".page").first().waitFor();
    await page.waitForFunction(() => window.privateFileStats.active === 1 && window.privateFileStats.disposed === 2);
    await page.evaluate(async () => { window.cryptoFixture.pausePrivateFiles(); await window.cryptoFixture.lockFileAccount(); });
    await page.waitForFunction(() => window.privateFileStats.active === 0);
    assert.equal(await page.locator('iframe[title="PDF ansehen"],iframe[title="View PDF"]').isVisible(), false);
    await page.getByRole("button", { name: "Vorschau schließen" }).click();
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    await page.waitForFunction(() => window.privateFileStats.pending === 0);
    assert.equal(await page.evaluate(() => window.privateFileStats.active), 0);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("the project preview download button saves private bytes without navigating to the resource identifier", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = new TextEncoder().encode("Private file preview download");
    const requests = []; page.on("request", request => requests.push(request.url()));
    await page.evaluate(data => window.cryptoFixture.showPrivateFile(data, "download"), Array.from(bytes));
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: /^(Herunterladen|Download)$/ }).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), "Vertraulich.bin");
    assert.deepEqual(new Uint8Array(await readFile(await download.path())), bytes);
    assert.equal(requests.some(url => url.includes("sortsys-private:") || url.includes("Vertraulich.bin")), false);
    assert.equal(await page.evaluate(() => window.privateFileStats.reads), 1);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});

test("an email with identical document identifiers cannot retain the previous account's decoded body", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(new URL("../../../sortsys-api-v2/seed-assets/materialfreigabe.eml", import.meta.url));
    await page.evaluate(data => window.cryptoFixture.showPrivateFile(data, "email"), Array.from(bytes));
    const oldMail = page.getByRole("heading", { name: "Materialfreigabe - Innenanstrich" });
    await oldMail.waitFor();
    await page.evaluate(async () => { window.cryptoFixture.pausePrivateFiles(); await window.cryptoFixture.resetPrivateFiles(); });
    await page.waitForFunction(() => window.privateFileStats.pending === 1);
    assert.equal(await oldMail.count(), 0);
    assert.equal(await page.locator(".attachment-email-body").count(), 0);
    await page.evaluate(async () => {
      window.cryptoFixture.replacePrivateFile(Array.from(new TextEncoder().encode("From: other@example.test\r\nTo: owner@example.test\r\nSubject: Neuer Mandant\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nNeue vertrauliche Nachricht.")));
      await window.cryptoFixture.switchFileAccount();
    });
    await page.waitForFunction(() => window.privateFileStats.pending === 2);
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    await page.getByRole("heading", { name: "Neuer Mandant" }).waitFor();
    await page.frameLocator('iframe[title="Nachricht"],iframe[title="Message"]').getByText("Neue vertrauliche Nachricht.").waitFor();
    assert.equal(await oldMail.count(), 0);
    await page.evaluate(async () => { window.cryptoFixture.pausePrivateFiles(); await window.cryptoFixture.lockFileAccount(); });
    await page.waitForFunction(() => document.querySelector(".attachment-email-body") === null);
    assert.equal(await page.getByRole("heading", { name: "Neuer Mandant" }).count(), 0);
    await page.getByRole("button", { name: "Vorschau schließen" }).click();
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});
