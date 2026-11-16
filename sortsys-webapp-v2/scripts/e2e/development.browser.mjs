import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const expect = playwrightExpect.configure({ timeout: 20_000 });
const reportPath = process.argv[2];
const seeded = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(seeded.success, true);
const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS);
const artifacts = join(dirname(reportPath), "browser-artifacts");
await mkdir(artifacts, { recursive: true });
const server = await applicationServer(
  new URL("../../build/client", import.meta.url).pathname,
  endpoints[1],
);
let browser;
const servers = new Set([server]);
const results = [];
let offlineCalendarRequests = 0;

async function applicationContext() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  // Calendar availability must not determine whether ordinary work succeeds.
  // Only this external dependency is replaced; application APIs remain real.
  await context.route(
    /^https:\/\/(alice|bob)\.btc\.calendar\.opentimestamps\.org\//,
    async (route) => {
      offlineCalendarRequests++;
      await route.fulfill({ status: 503, body: "Calendar unavailable" });
    },
  );
  return context;
}
async function close() {
  await browser?.close();
  await Promise.all([...servers].map((server) => server.close()));
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

function auditPage(page) {
  const errors = [];
  const eventHints = [];
  const plaintextLeaks = [];
  const unsupportedOperations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/zerotrust/events")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const value = JSON.parse(payload);
      if (value.type === "changed") {
        eventHints.push({
          type: value.type,
          reset: value.reset,
          all: value.all,
          control: value.control,
          staged: value.staged === true,
          domains: Object.keys(value.domains ?? {}),
        });
      }
    });
  });
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.startsWith("/api/v2/")) return;
    const body = request.postData() ?? "";
    const query = decodeURIComponent(new URL(request.url()).search);
    if (
      new URL(request.url()).pathname.includes("errorReports.report") &&
      body
    ) {
      const entries = JSON.parse(body);
      for (const entry of Object.values(entries)) {
        if (entry?.json?.metadata?.status === 405)
          unsupportedOperations.push(entry.json.source);
      }
    }
    for (const marker of [
      "Musterbau & Ausbau GmbH",
      "Handwerkerstraße 12a",
      "Untergrund vorbereiten",
      "Haftgrund, manuell angepasst",
      "Treppenhausrenovierung Musterstraße",
      "Treppenhaus im Live-Abgleich",
      "Antrag vor Standardfreigabe",
      "Antrag mit Standardfreigabe",
      "Gemeinsames Auftrags-LV von John und Frank",
      "Nach dem Entzug ausschließlich für John",
      "Bohrhammer nach Freigabe bearbeitet",
      "Delegierte Werkzeugausgabe im Browser",
      "Gemeinsame Werkzeugausgabe im Browser",
    ]) {
      if (body.includes(marker) || query.includes(marker))
        plaintextLeaks.push(marker);
    }
  });
  return {
    errors,
    eventHints,
    assertClean() {
      assert.deepEqual(errors, [], "Unhandled browser errors");
      assert.deepEqual(
        plaintextLeaks,
        [],
        "Business plaintext in API requests",
      );
      assert.deepEqual(
        unsupportedOperations,
        [],
        "A visible workflow used an unimplemented client operation",
      );
    },
  };
}

async function scenario(name, run) {
  if (
    process.env.SORTSYS_E2E_SCENARIO &&
    process.env.SORTSYS_E2E_SCENARIO !== name
  )
    return;
  const context = await applicationContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const audit = auditPage(page);
  let failed = false;
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  try {
    await run(page);
    audit.assertClean();
    results.push({ name, passed: true });
    console.log(`Browser E2E passed: ${name}`);
  } catch (error) {
    failed = true;
    console.error(`Browser E2E failed: ${name}`, error);
    console.error("Public change hints:", audit.eventHints);
    if (audit.errors.length)
      console.error("Unhandled browser errors:", audit.errors);
    await page
      .screenshot({
        path: join(artifacts, `${name}-failed.png`),
        fullPage: true,
      })
      .catch((captureError) =>
        console.error("Failure screenshot unavailable:", captureError.message),
      );
    await writeFile(
      join(artifacts, `${name}-failed.html`),
      await page.content().catch(() => "Browser page was already closed"),
    );
    throw error;
  } finally {
    try {
      await context.tracing.stop({ path: join(artifacts, `${name}.zip`) });
    } catch (error) {
      if (!failed) throw error;
      console.error("Failure trace unavailable:", error.message);
    } finally {
      await context.close();
    }
  }
}

async function login(
  page,
  username,
  password = "123456",
  origin = server.origin,
) {
  await page.goto(`${origin}/auth/login`);
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${username}@${seeded.tenant}`);
  await page.getByLabel(/^Passwort/).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

async function loginOperator(page) {
  const password = process.env.SORTSYS_E2E_OPERATOR_PASSWORD;
  assert.ok(password, "The isolated operator password is required");
  await page.goto(`${server.origin}/__admin/login`);
  await page.getByLabel(/^Global Admin Passwort/).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Mandanten", exact: true }),
  ).toBeVisible();
}

async function openMemberPermissions(page) {
  await page.goto(`${server.origin}/users`);
  await page.getByText("Frank", { exact: true }).click();
  await page
    .getByRole("main")
    .getByRole("button", { name: "Aktionen", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Berechtigungen verwalten", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Berechtigungen verwalten",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function selectAccess(page, scope, label, value) {
  const button = scope.getByRole("button", { name: new RegExp(label) });
  await expect(button).toBeEnabled();
  await button.click();
  await page.getByRole("option", { name: value, exact: true }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
}

async function selectOfferAccess(page, title) {
  const dialog = await openMemberPermissions(page);
  const picker = dialog.getByRole("combobox", {
    name: "Angebot oder Dokument",
    exact: true,
  });
  await expect(picker).toBeEnabled();
  await picker.fill(title);
  await page.getByRole("option", { name: new RegExp(title) }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: /Bezeichnung und Status/ }),
  ).toBeEnabled();
  return dialog;
}

async function saveOfferAccess(dialog) {
  await saveResourceAccess(
    dialog,
    "Dokumentzugriff speichern",
    "Bezeichnung und Status",
  );
}

async function saveResourceAccess(dialog, label, field) {
  const save = dialog.getByRole("button", {
    name: label,
    exact: true,
  });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toHaveAttribute("data-pending", "true");
  // Publishing rights also backfills historical keys, rotates affected areas
  // and verifies their durable heads across API instances.
  await expect(save).not.toHaveAttribute("data-pending", "true", {
    timeout: 45_000,
  });
  await expect(
    dialog.getByRole("button", { name: new RegExp(field) }),
  ).toBeEnabled();
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
}

async function selectToolAccess(page, title) {
  const dialog = await openMemberPermissions(page);
  const picker = dialog.getByRole("combobox", {
    name: "Werkzeug",
    exact: true,
  });
  await expect(picker).toBeEnabled();
  await picker.fill(title);
  await page.getByRole("option", { name: new RegExp(title) }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: /Werkzeugstammdaten/ }),
  ).toBeEnabled();
  return dialog;
}

async function saveCreationAccess(dialog) {
  const save = dialog.getByRole("button", {
    name: "Anlageberechtigungen speichern",
    exact: true,
  });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toHaveAttribute("data-pending", "true");
  await expect(save).not.toHaveAttribute("data-pending", "true");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Neue Werkzeugbuchungen anlegen",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
}

function firstPrice(editor) {
  return editor.locator('[data-gaeb-field$=":UP"]').first();
}
async function priceValue(editor) {
  const value = await firstPrice(editor).getAttribute("aria-description");
  return Number(value.replace(/[^0-9,.-]/g, "").replace(",", "."));
}
async function changePrice(editor, value) {
  const price = firstPrice(editor);
  await expect(price).toBeEnabled();
  await price.focus();
  const input = editor.locator("textarea.gaeb-canvas-input");
  await input.fill(value);
  await input.press("Tab");
  await expect
    .poll(() => priceValue(editor))
    .toBe(Number(value.replace(",", ".")));
  await expect(editor.locator(".gaeb-editor")).toHaveAttribute(
    "data-save-state",
    "saved",
  );
}

async function changeTextBeforePublication(writer, reader, value) {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const match = (url) =>
    decodeURIComponent(url.pathname)
      .split("/")
      .at(-1)
      .split(",")
      .includes("zerotrust.objects.batch");
  const handler = async (route) => {
    const body = route.request().postDataJSON();
    const publishesDocument = Object.values(body).some(
      (entry) => entry?.json?.documents?.length > 0,
    );
    if (publishesDocument) {
      await released;
    }
    await route.continue();
  };
  await writer.route(match, handler);
  await reader.route(match, handler);
  const field = (editor) => editor.locator('[data-gaeb-field="project:title"]');
  try {
    await field(writer).focus();
    const input = writer.locator("textarea.gaeb-canvas-input");
    await input.fill(value);
    await input.press("Tab");
    await expect(field(writer)).toHaveAttribute("aria-description", value);
    await expect(field(reader)).toHaveAttribute("aria-description", value);
  } finally {
    release();
    await writer.unroute(match, handler);
    await reader.unroute(match, handler);
  }
  // The production save deadline starts after the test releases its own gate.
  // The earlier ordinary price saves retain their unchanged cold-save deadline.
  await Promise.all(
    [writer, reader].map((editor) =>
      expect(editor.locator(".gaeb-editor")).toHaveAttribute(
        "data-save-state",
        "saved",
      ),
    ),
  );
}

try {
  browser = await chromium.launch({
    headless: process.env.SORTSYS_E2E_HEADED !== "1",
  });
  await scenario("anonymous-and-wrong-password", async (page) => {
    await page.goto(`${server.origin}/admin`);
    await expect(
      page.getByRole("button", { name: "Anmelden", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Stammdaten" })).toHaveCount(0);
    await login(page, "john.doe", "wrong-password");
    await expect(
      page.getByText(/^Anmeldung(?: oder Passwortprüfung)? fehlgeschlagen\.$/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Anmelden", exact: true }),
    ).toBeEnabled();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect(
      page.getByRole("textbox", { name: /^Firmenname/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: join(artifacts, "login-denied.png"),
      fullPage: true,
    });
  });
  await scenario("administrator-and-sample-data", async (page) => {
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/admin`);
    await expect(
      page.getByRole("tab", { name: "Stammdaten", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: /^Firmenname/ }),
    ).toHaveValue("Musterbau & Ausbau GmbH");
    await expect(
      page.getByRole("textbox", { name: "Straße und Hausnummer", exact: true }),
    ).toHaveValue("Handwerkerstraße 12");
    await page.screenshot({
      path: join(artifacts, "administrator-organization.png"),
      fullPage: true,
    });
    const street = page.getByRole("textbox", {
      name: "Straße und Hausnummer",
      exact: true,
    });
    await street.fill("Handwerkerstraße 12a");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(
      page.getByText("Organisation gespeichert", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(street).toHaveValue("Handwerkerstraße 12a");
    await street.fill("Handwerkerstraße 12");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(
      page.getByText("Organisation gespeichert", { exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/products`);
    await expect(
      page.getByText("Haftgrund, manuell angepasst", { exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/offers`);
    await expect(
      page
        .getByRole("main")
        .getByRole("button", { name: "Angebot erstellen", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Treppenhausrenovierung Musterstraße", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: join(artifacts, "administrator-offers.png"),
      fullPage: true,
    });
    await page.goto(`${server.origin}/gaeb/${seeded.caseId}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
    await page.screenshot({
      path: join(artifacts, "administrator-document.png"),
      fullPage: true,
    });
  });
  await scenario("gaeb-autosave-and-reload", async (page) => {
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/offers`);
    await page
      .getByText("Treppenhausrenovierung Musterstraße", { exact: true })
      .click();
    await expect(firstPrice(page)).toBeEnabled();
    await changePrice(page, "61,20");
    await page.reload();
    await expect(firstPrice(page)).toBeEnabled();
    await expect.poll(() => priceValue(page)).toBe(61.2);
    await page.screenshot({
      path: join(artifacts, "gaeb-autosaved-and-reloaded.png"),
      fullPage: true,
    });
  });
  await scenario("gaeb-editing-and-replica-synchronization", async (page) => {
    const peerServer = await applicationServer(
      new URL("../../build/client", import.meta.url).pathname,
      endpoints[0],
    );
    servers.add(peerServer);
    const peerContext = await applicationContext();
    const peer = await peerContext.newPage();
    const peerAudit = auditPage(peer);
    await peerContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    try {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await page.goto(`${server.origin}/offers`);
      await page
        .getByText("Treppenhausrenovierung Musterstraße", { exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(firstPrice(page)).toBeEnabled();
      console.log("GAEB E2E: editable document ready on first API instance");
      const originalEditor = await page.locator(".gaeb-editor").elementHandle();
      assert.ok(originalEditor);
      const path = new URL(page.url()).pathname;
      assert.match(path, /^\/gaeb\/[1-9a-v][0-9a-v]{0,12}$/);
      await login(peer, "john.doe", "123456", peerServer.origin);
      await expect(
        peer.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      assert.equal(
        await originalEditor.evaluate((element) => element.isConnected),
        true,
        "A second sign-in must not tear down an editor with unchanged access",
      );
      await peer.goto(`${peerServer.origin}${path}`);
      await expect(firstPrice(peer)).toBeEnabled();
      console.log("GAEB E2E: editable document ready on second API instance");
      await changePrice(page, "73,25");
      console.log("GAEB E2E: first price change saved");
      await expect.poll(() => priceValue(peer)).toBe(73.25);
      console.log("GAEB E2E: second browser received first price change");
      await changePrice(peer, "84,50");
      console.log("GAEB E2E: second price change saved");
      await expect.poll(() => priceValue(page)).toBe(84.5);
      await page.reload();
      await expect.poll(() => priceValue(page)).toBe(84.5);
      console.log("GAEB E2E: final price survived reloading");
      for (const editor of [page, peer]) {
        await expect(editor.locator(".gaeb-editor")).toHaveAttribute(
          "data-connection-state",
          "online",
        );
      }
      await changeTextBeforePublication(
        page,
        peer,
        "Treppenhaus im Live-Abgleich",
      );
      console.log("GAEB E2E: live text arrived before native publication");
      await page.reload();
      await expect(
        page.locator('[data-gaeb-field="project:title"]'),
      ).toHaveAttribute("aria-description", "Treppenhaus im Live-Abgleich");
      await page.screenshot({
        path: join(artifacts, "gaeb-edited-and-reloaded.png"),
        fullPage: true,
      });
      peerAudit.assertClean();
    } finally {
      await writeFile(
        join(artifacts, "gaeb-peer-change-hints.json"),
        JSON.stringify(peerAudit.eventHints),
      );
      await peer
        .screenshot({
          path: join(artifacts, "gaeb-peer-final.png"),
          fullPage: true,
        })
        .catch((error) => {
          console.error("Peer screenshot unavailable:", error.message);
        });
      await peerContext.tracing.stop({
        path: join(artifacts, "gaeb-peer-live.zip"),
      });
      await peerContext.close();
      await peerServer.close();
    }
  });
  await scenario(
    "seeded-project-workflows-and-native-editors",
    async (page) => {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const projectPath = `/projects/${seeded.projectId}/contract`;
      await page.goto(`${server.origin}${projectPath}`);
      await expect(
        page.getByRole("heading", {
          name: "Auftrag & Leistungen",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("columnheader", { name: "Projekt", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Vorgang erstellen", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "Suchen", exact: true })
        .fill("Fensteraufmaß Erdgeschoss");
      await page
        .getByRole("row")
        .filter({ hasText: "Fensteraufmaß Erdgeschoss" })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/gaeb/${seeded.measurementCaseId}$`),
      );
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.locator(".gaeb-editor")).toHaveAttribute(
        "data-content-complete",
        "true",
      );
      await expect(page.locator(".gaeb-editor")).toHaveAttribute(
        "data-schema-state",
        "valid",
      );
      await expect(page.locator("canvas").first()).toBeVisible();
      await page.screenshot({
        path: join(artifacts, "seeded-measurement.png"),
        fullPage: true,
      });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Schließen", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page).toHaveURL(`${server.origin}${projectPath}`);
      for (const [id, expectedLabel] of [
        [seeded.procurementCaseId, "Preisanfrage"],
        [seeded.finalInvoiceCaseId, "Schlussrechnung"],
      ]) {
        await page.goto(`${server.origin}/gaeb/${id}`);
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect(page.locator(".gaeb-editor")).toHaveAttribute(
          "data-content-complete",
          "true",
        );
        await expect(page.locator(".gaeb-editor")).toHaveAttribute(
          "data-schema-state",
          "valid",
        );
        await expect(page.locator("canvas").first()).toBeVisible();
        await page.screenshot({
          path: join(artifacts, `seeded-${expectedLabel}.png`),
          fullPage: true,
        });
      }
    },
  );
  await scenario(
    "encrypted-project-attachments-and-shareable-dialogs",
    async (page) => {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const base = `${server.origin}/projects/${seeded.projectId}/files`;
      await page.goto(base);
      await page
        .getByRole("button", { name: "grundriss-erdgeschoss.pdf", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page).toHaveURL(/\/files\/[1-9a-v][0-9a-v]*$/);
      await expect(
        page
          .frameLocator('iframe[title="PDF ansehen"]')
          .locator('.page[data-page-number="1"] canvas'),
      ).toBeVisible();
      await page.screenshot({
        path: join(artifacts, "encrypted-project-plan.png"),
        fullPage: true,
      });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Schließen", exact: true })
        .click();
      await expect(page).toHaveURL(base);
      for (const name of ["baubesprechung.eml", "baubesprechung.msg"]) {
        await page.getByRole("button").filter({ hasText: name }).click();
        await expect(
          page.getByRole("heading", {
            name: "Baubesprechung Musterhaus - Protokoll",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.frameLocator('iframe[title="Nachricht"]').locator("body"),
        ).toContainText("Leibungsarbeiten als Nachtragsangebot");
        await expect(
          page.getByRole("region", { name: "Anhänge", exact: true }),
        ).toBeVisible();
        const address = page.url();
        await page.reload();
        await expect(page).toHaveURL(address);
        await expect(
          page.getByRole("heading", {
            name: "Baubesprechung Musterhaus - Protokoll",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.frameLocator('iframe[title="Nachricht"]').locator("body"),
        ).toContainText("Leibungsarbeiten als Nachtragsangebot");
        await page.screenshot({
          path: join(artifacts, `encrypted-${name}.png`),
          fullPage: true,
        });
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Schließen", exact: true })
          .click();
        await expect(page).toHaveURL(base);
      }
    },
  );
  await scenario("member-visibility-and-direct-url-denials", async (page) => {
    await login(page, "frank.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    for (const target of ["/admin", "/offers", "/projects", "/products"]) {
      await expect(page.locator(`nav a[href="${target}"]`)).toHaveCount(0);
    }
    await page.screenshot({
      path: join(artifacts, "member-dashboard.png"),
      fullPage: true,
    });
    await page.goto(`${server.origin}/admin`);
    await expect(
      page.getByRole("heading", { name: "404", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Stammdaten", exact: true }),
    ).toHaveCount(0);
    await page.goto(`${server.origin}/offers`);
    await expect(
      page.getByRole("heading", { name: "Angebote", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Angebot erstellen", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Treppenhausrenovierung Musterstraße", { exact: true }),
    ).toHaveCount(0);
    await page.goto(`${server.origin}/gaeb/${seeded.caseId}`);
    await expect(
      page.getByText("Vorgang nicht geladen", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(
      page.getByText("Fenstersanierung Pirckheimer-Gymnasium", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: join(artifacts, "member-document-denied.png"),
      fullPage: true,
    });
    for (const id of [
      seeded.measurementCaseId,
      seeded.procurementCaseId,
      seeded.finalInvoiceCaseId,
    ]) {
      await page.goto(`${server.origin}/gaeb/${id}`);
      await expect(
        page.getByText("Vorgang nicht geladen", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("canvas")).toHaveCount(0);
    }
    await page.goto(`${server.origin}/projects/${seeded.projectId}/files`);
    await expect(
      page.getByRole("heading", { name: "404", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button").filter({ hasText: "baubesprechung.eml" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".attachment-email-body, .attachment-pdf-frame"),
    ).toHaveCount(0);
  });
  await scenario("tool-batch-booking-dialog", async (page) => {
    const peerServer = await applicationServer(
      new URL("../../build/client", import.meta.url).pathname,
      endpoints[0],
    );
    servers.add(peerServer);
    const peerContext = await applicationContext();
    const peer = await peerContext.newPage();
    const peerAudit = auditPage(peer);
    await peerContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    async function openTool(browserPage, origin, title) {
      await browserPage.goto(`${origin}/tools`);
      await browserPage.getByText(title, { exact: true }).click();
      await expect(
        browserPage.getByRole("heading", { name: new RegExp(title) }),
      ).toBeVisible();
      return new URL(browserPage.url()).pathname;
    }
    async function bookCurrentTool(browserPage) {
      await browserPage
        .getByRole("main")
        .getByRole("button", { name: "Aktionen", exact: true })
        .click();
      await browserPage
        .getByRole("menuitem", { name: "Buchen", exact: true })
        .click();
      const dialog = browserPage.locator('[data-slot="modal-dialog"]');
      await expect(
        dialog.getByRole("heading", {
          name: "Werkzeuge einbuchen",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /^Entfernen 91000[12] / }),
      ).toBeVisible();
      await dialog
        .getByRole("combobox", { name: /^Verantwortlicher/ })
        .fill("John");
      await browserPage.getByRole("option", { name: /John Doe/ }).click();
      await expect(
        dialog.getByRole("combobox", { name: /^Verantwortlicher/ }),
      ).toHaveCount(0);
      return dialog;
    }
    try {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const firstPath = await openTool(page, server.origin, "Bohrhammer 1");
      const dialog = await bookCurrentTool(page);
      const tools = dialog.getByRole("combobox", { name: /^Werkzeuge/ });
      await tools.fill("Rührwerk 2");
      await page.getByRole("option", { name: /^910002 / }).click();
      await tools.press("Escape");
      await expect(
        dialog.getByRole("button", { name: /^Entfernen 910002 / }),
      ).toBeVisible();
      await dialog
        .getByLabel("Kommentar", { exact: true })
        .fill("Gemeinsame Werkzeugausgabe im Browser");

      await login(peer, "john.doe", "123456", peerServer.origin);
      await expect(
        peer.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const secondPath = await openTool(peer, peerServer.origin, "Rührwerk 2");
      const competing = await bookCurrentTool(peer);
      await competing
        .getByRole("button", { name: "Buchen", exact: true })
        .click();
      await expect(competing).toBeHidden({ timeout: 45_000 });
      await expect(
        peer.getByText("Buchungshistorie (1)", { exact: true }),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Buchen", exact: true }).click();
      await expect(
        dialog.locator('[data-slot="alert-root"][role="alert"]'),
      ).toContainText("zwischenzeitlich geändert");
      await expect(
        dialog.getByRole("button", { name: /^Entfernen 910001 / }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /^Entfernen 910002 / }),
      ).toBeVisible();
      await expect(dialog.getByLabel("Kommentar", { exact: true })).toHaveValue(
        "Gemeinsame Werkzeugausgabe im Browser",
      );
      await page.screenshot({
        path: join(artifacts, "tool-batch-booking-conflict.png"),
        fullPage: true,
      });
      await peer.goto(`${peerServer.origin}${firstPath}`);
      await expect(peer.getByText("verfügbar", { exact: true })).toBeVisible();
      await expect(
        peer.getByText("Buchungshistorie (0)", { exact: true }),
      ).toBeVisible();

      await dialog.getByRole("button", { name: /^Entfernen 910002 / }).click();
      await tools.fill("Rührwerk 2");
      const updatedOption = page.getByRole("option", { name: /^910002 / });
      await expect(updatedOption).toBeVisible();
      await expect(updatedOption).toBeEnabled();
      // Live results may move while their popover settles. Keep a real pointer
      // click without requiring two identical animation frames.
      await updatedOption.click({ force: true });
      await tools.press("Escape");
      for (const number of ["910001", "910002"]) {
        await expect(
          dialog.getByRole("button", {
            name: new RegExp(`^Entfernen ${number} `),
          }),
        ).toBeVisible();
      }
      await dialog.getByRole("button", { name: "Buchen", exact: true }).click();
      // Creating the key areas, publishing the whole selection and checking
      // its durable signatures form one asynchronous submission.
      await expect(dialog).toBeHidden({ timeout: 45_000 });
      await expect(page.getByText("gebucht", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Buchungshistorie (1)", { exact: true }),
      ).toBeVisible();
      await peer.goto(`${peerServer.origin}${secondPath}`);
      await expect(peer.getByText("gebucht", { exact: true })).toBeVisible();
      await expect(
        peer.getByText("Buchungshistorie (2)", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(page.getByText("gebucht", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Buchungshistorie (1)", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Doe, John", exact: true }),
      ).toHaveCount(2);
      await page.screenshot({
        path: join(artifacts, "tool-batch-booking-completed.png"),
        fullPage: true,
      });
      peerAudit.assertClean();
    } finally {
      await peer
        .screenshot({
          path: join(artifacts, "tool-batch-booking-peer.png"),
          fullPage: true,
        })
        .catch(() => {});
      await writeFile(
        join(artifacts, "tool-batch-booking-peer.html"),
        await peer.content(),
      ).catch(() => {});
      await peerContext.tracing.stop({
        path: join(artifacts, "tool-batch-booking-peer.zip"),
      });
      await peerContext.close();
    }
  });

  await scenario("tool-booking-creation-between-users", async (page) => {
    const memberServer = await applicationServer(
      new URL("../../build/client", import.meta.url).pathname,
      endpoints[0],
    );
    servers.add(memberServer);
    const memberContext = await applicationContext();
    const member = await memberContext.newPage();
    const memberAudit = auditPage(member);
    await memberContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    let authorization;
    member.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/v2/")) {
        authorization = request.headers().authorization ?? authorization;
      }
    });
    async function capability(subject) {
      assert.ok(
        authorization,
        "The member must have an authenticated API request",
      );
      const input = {
        namespace: "tool-tracking",
        ...(subject ? { subject } : {}),
      };
      const url = new URL(
        "/api/v2/zerotrust.creations.capability",
        memberServer.origin,
      );
      url.searchParams.set("batch", "1");
      url.searchParams.set("input", JSON.stringify({ 0: { json: input } }));
      const response = await member.request.get(url.href, {
        headers: { authorization },
      });
      assert.equal(response.status(), 200);
      return (await response.json())[0];
    }
    try {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await page.goto(`${server.origin}/tools`);
      await page.getByText("Bohrhammer 1", { exact: true }).click();
      await expect(
        page.getByRole("heading", { name: /Bohrhammer 1/ }),
      ).toBeVisible();
      const path = new URL(page.url()).pathname;
      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const unavailable = await capability();
      assert.equal(unavailable.result.data.json, null);

      let access = await selectToolAccess(page, "Bohrhammer 1");
      await selectAccess(
        page,
        access,
        "Werkzeugstammdaten",
        "Lesen und bearbeiten",
      );
      await selectAccess(
        page,
        access,
        "Anschaffung und Nutzungskosten",
        "Lesen",
      );
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await member.goto(`${memberServer.origin}${path}`);
      await expect(
        member.getByRole("heading", { name: /Bohrhammer 1/ }),
      ).toBeVisible();
      const actions = member
        .getByRole("main")
        .getByRole("button", { name: "Aktionen", exact: true });
      await actions.click();
      await expect(
        member.getByRole("menuitem", { name: "Buchen", exact: true }),
      ).toHaveCount(0);
      await member.keyboard.press("Escape");

      access = await openMemberPermissions(page);
      await access
        .getByText("Neue Werkzeugbuchungen anlegen", { exact: true })
        .click();
      await saveCreationAccess(access);
      const granted = await capability();
      assert.equal(granted.result.data.json.namespace, "tool-tracking");
      await expect(
        member.getByText("Werkzeuge einbuchen", { exact: true }),
      ).toBeVisible();
      const denied = await capability(granted.result.data.json.readers[0].user);
      assert.equal(denied.error.json.data.httpCode, 403);
      await actions.click();
      await member
        .getByRole("menuitem", { name: "Buchen", exact: true })
        .click();
      const booking = member.getByRole("dialog", {
        name: "Werkzeuge einbuchen",
        exact: true,
      });
      await booking
        .getByRole("combobox", { name: /^Verantwortlicher/ })
        .fill("Frank");
      await member.getByRole("option", { name: /Frank Doe/ }).click();
      await booking
        .getByLabel("Kommentar", { exact: true })
        .fill("Delegierte Werkzeugausgabe im Browser");
      await booking
        .getByRole("button", { name: "Buchen", exact: true })
        .click();
      await expect(booking).toBeHidden();
      await expect(member.getByText("gebucht", { exact: true })).toBeVisible();
      await member.reload();
      await expect(member.getByText("gebucht", { exact: true })).toBeVisible();
      await page.goto(`${server.origin}${path}`);
      await expect(page.getByText("gebucht", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Buchungshistorie (1)", { exact: true }),
      ).toBeVisible();

      access = await openMemberPermissions(page);
      await access
        .getByText("Neue Werkzeugbuchungen anlegen", { exact: true })
        .click();
      await saveCreationAccess(access);
      const revoked = await capability();
      assert.equal(revoked.result.data.json, null);
      await expect(
        member.getByText("Werkzeuge einbuchen", { exact: true }),
      ).toHaveCount(0);
      await expect(
        member.getByText("Kaufpreis", { exact: true }),
      ).toBeVisible();
      access = await selectToolAccess(page, "Bohrhammer 1");
      await selectAccess(
        page,
        access,
        "Anschaffung und Nutzungskosten",
        "Kein Zugriff",
      );
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await expect(member.getByText("Kaufpreis", { exact: true })).toHaveCount(
        0,
      );
      await actions.click();
      await member
        .getByRole("menuitem", { name: "Zurückbuchen", exact: true })
        .click();
      await expect(
        member.getByText("verfügbar", { exact: true }),
      ).toBeVisible();
      await member.reload();
      await expect(
        member.getByText("Buchungshistorie (1)", { exact: true }),
      ).toBeVisible();
      await actions.click();
      await expect(
        member.getByRole("menuitem", { name: "Buchen", exact: true }),
      ).toHaveCount(0);
      await member.keyboard.press("Escape");
      await page.goto(`${server.origin}${path}`);
      await expect(page.getByText("verfügbar", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Buchungshistorie (1)", { exact: true }),
      ).toBeVisible();
      await member.screenshot({
        path: join(
          artifacts,
          "member-tool-booking-after-creation-revocation.png",
        ),
        fullPage: true,
      });
      memberAudit.assertClean();
    } finally {
      await member
        .screenshot({
          path: join(artifacts, "member-tool-booking-current.png"),
          fullPage: true,
        })
        .catch(() => {});
      await writeFile(
        join(artifacts, "member-tool-booking-current.html"),
        await member.content(),
      ).catch(() => {});
      await memberContext.tracing.stop({
        path: join(artifacts, "member-tool-booking.zip"),
      });
      await memberContext.close();
    }
  });
  await scenario("tool-access-between-users", async (page) => {
    const memberServer = await applicationServer(
      new URL("../../build/client", import.meta.url).pathname,
      endpoints[0],
    );
    servers.add(memberServer);
    const memberContext = await applicationContext();
    const member = await memberContext.newPage();
    const memberAudit = auditPage(member);
    const originalTitle = "Bohrhammer 1";
    const editedTitle = "Bohrhammer nach Freigabe bearbeitet";
    const missingResource =
      "Die angeforderte Ressource konnte nicht aufgelöst werden.";
    const memberActions = member
      .getByRole("main")
      .getByRole("button", { name: "Aktionen", exact: true });
    try {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await page.goto(`${server.origin}/tools`);
      await page.getByText(originalTitle, { exact: true }).click();
      await expect(
        page.getByRole("heading", { name: new RegExp(originalTitle) }),
      ).toBeVisible();
      const toolPath = new URL(page.url()).pathname;
      await expect(page.getByText("Kaufpreis", { exact: true })).toBeVisible();
      const costValues = page
        .locator("dl")
        .filter({ hasText: "Kaufpreis" })
        .getByRole("definition");
      const originalCosts = await costValues.allTextContents();

      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await member.goto(`${memberServer.origin}${toolPath}`);
      await expect(
        member.getByText(missingResource, { exact: true }),
      ).toBeVisible();
      await expect(member.getByText("Kaufpreis", { exact: true })).toHaveCount(
        0,
      );

      let access = await selectToolAccess(page, originalTitle);
      await selectAccess(page, access, "Werkzeugstammdaten", "Lesen");
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await member.reload();
      await expect(
        member.getByRole("heading", { name: new RegExp(originalTitle) }),
      ).toBeVisible();
      await expect(memberActions).toHaveCount(0);
      await expect(member.getByText("Kaufpreis", { exact: true })).toHaveCount(
        0,
      );
      await expect(
        member.getByText("Nutzungskosten pro Tag", { exact: true }),
      ).toHaveCount(0);

      // A write grant for a different tool must not enable this tool's actions.
      access = await selectToolAccess(page, "Rührwerk 2");
      await selectAccess(
        page,
        access,
        "Werkzeugstammdaten",
        "Lesen und bearbeiten",
      );
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await member.goto(`${memberServer.origin}/tools`);
      await member.getByText("Rührwerk 2", { exact: true }).click();
      await expect(memberActions).toBeVisible();
      await member.goto(`${memberServer.origin}${toolPath}`);
      await expect(
        member.getByRole("heading", { name: new RegExp(originalTitle) }),
      ).toBeVisible();
      await expect(memberActions).toHaveCount(0);
      await member.keyboard.press("Control+e");
      await expect(
        member.getByRole("dialog", {
          name: "Werkzeug bearbeiten",
          exact: true,
        }),
      ).toHaveCount(0);

      access = await selectToolAccess(page, originalTitle);
      await selectAccess(
        page,
        access,
        "Werkzeugstammdaten",
        "Lesen und bearbeiten",
      );
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await expect(memberActions).toBeVisible();
      await memberActions.click();
      for (const action of ["Buchen", "Inventur", "Löschen"]) {
        await expect(
          member.getByRole("menuitem", { name: action, exact: true }),
        ).toHaveCount(0);
      }
      await member
        .getByRole("menuitem", { name: "Bearbeiten", exact: true })
        .click();
      const edit = member.getByRole("dialog", {
        name: "Werkzeug bearbeiten",
        exact: true,
      });
      await expect(edit.getByLabel("Modell", { exact: true })).toHaveValue(
        originalTitle,
      );
      await expect(
        edit.getByLabel("Kaufpreis (EUR)", { exact: true }),
      ).toHaveCount(0);
      await edit.getByLabel("Modell", { exact: true }).fill(editedTitle);
      await edit
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await expect(edit).toBeHidden();
      await member.reload();
      await expect(
        member.getByRole("heading", { name: new RegExp(editedTitle) }),
      ).toBeVisible();
      await expect(member.getByText("Kaufpreis", { exact: true })).toHaveCount(
        0,
      );
      await member.screenshot({
        path: join(artifacts, "member-tool-without-cost-access.png"),
        fullPage: true,
      });

      await page.goto(`${server.origin}${toolPath}`);
      await expect(
        page.getByRole("heading", { name: new RegExp(editedTitle) }),
      ).toBeVisible();
      await expect(costValues).toHaveText(originalCosts);

      access = await selectToolAccess(page, editedTitle);
      await selectAccess(page, access, "Werkzeugstammdaten", "Kein Zugriff");
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await expect(
        member.getByText(missingResource, { exact: true }),
      ).toBeVisible();
      await member.reload();
      await expect(
        member.getByText(missingResource, { exact: true }),
      ).toBeVisible();
      await expect(member.getByText(editedTitle, { exact: true })).toHaveCount(
        0,
      );

      access = await selectToolAccess(page, editedTitle);
      await selectAccess(page, access, "Werkzeugstammdaten", "Lesen");
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await member.reload();
      await expect(
        member.getByRole("heading", { name: new RegExp(editedTitle) }),
      ).toBeVisible();
      await expect(memberActions).toHaveCount(0);
      await expect(member.getByText("Kaufpreis", { exact: true })).toHaveCount(
        0,
      );
      memberAudit.assertClean();
    } finally {
      await memberContext.close();
    }
  });
  await scenario("gaeb-editing-between-users", async (page) => {
    const memberServer = await applicationServer(
      new URL("../../build/client", import.meta.url).pathname,
      endpoints[0],
    );
    servers.add(memberServer);
    const memberContext = await applicationContext();
    const member = await memberContext.newPage();
    const memberAudit = auditPage(member);
    await memberContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    const title = "Treppenhausrenovierung Musterstraße";
    let path;
    try {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await page.goto(`${server.origin}/offers`);
      await page.getByText(title, { exact: true }).click();
      await expect(firstPrice(page)).toBeEnabled();
      path = new URL(page.url()).pathname;
      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await member.goto(`${memberServer.origin}${path}`);
      await expect(
        member.getByText("Vorgang nicht geladen", { exact: true }),
      ).toBeVisible();
      await expect(member.locator(".gaeb-editor")).toHaveCount(0);
      await expect(member.locator('nav a[href="/admin"]')).toHaveCount(0);

      let access = await selectOfferAccess(page, title);
      await selectAccess(page, access, "Bezeichnung und Status", "Lesen");
      await selectAccess(
        page,
        access,
        "Leistungsbeschreibungen",
        "Lesen und bearbeiten",
      );
      await selectAccess(page, access, "Vertragsmengen", "Lesen");
      await saveOfferAccess(access);
      await expect(member.locator(".gaeb-editor")).toBeVisible();
      await expect(member.locator('[data-gaeb-field$=":UP"]')).toHaveCount(0);
      await page.goto(`${server.origin}${path}`);
      await expect(firstPrice(page)).toBeEnabled();
      for (const editor of [page, member]) {
        await expect(editor.locator(".gaeb-editor")).toHaveAttribute(
          "data-connection-state",
          "online",
        );
      }
      await changeTextBeforePublication(
        member,
        page,
        "Gemeinsames Auftrags-LV von John und Frank",
      );
      await member.reload();
      await expect(
        member.locator('[data-gaeb-field="project:title"]'),
      ).toHaveAttribute(
        "aria-description",
        "Gemeinsames Auftrags-LV von John und Frank",
      );
      await expect(member.locator('[data-gaeb-field$=":UP"]')).toHaveCount(0);
      await member.screenshot({
        path: join(artifacts, "member-gaeb-text-access.png"),
        fullPage: true,
      });

      access = await selectOfferAccess(page, title);
      for (const label of [
        "Bezeichnung und Status",
        "Leistungsbeschreibungen",
        "Vertragsmengen",
      ]) {
        await selectAccess(page, access, label, "Kein Zugriff");
      }
      await saveOfferAccess(access);
      await expect(member.locator(".gaeb-editor")).toHaveCount(0);
      await expect(member.locator("textarea.gaeb-canvas-input")).toHaveCount(0);
      await page.goto(`${server.origin}${path}`);
      const field = page.locator('[data-gaeb-field="project:title"]');
      await expect(field).toBeEnabled();
      await field.focus();
      await page
        .locator("textarea.gaeb-canvas-input")
        .fill("Nach dem Entzug ausschließlich für John");
      await page.locator("textarea.gaeb-canvas-input").press("Tab");
      await expect(page.locator(".gaeb-editor")).toHaveAttribute(
        "data-save-state",
        "saved",
      );
      await member.reload();
      await expect(
        member.getByText("Vorgang nicht geladen", { exact: true }),
      ).toBeVisible();
      await expect(member.locator(".gaeb-editor")).toHaveCount(0);

      access = await selectOfferAccess(page, title);
      await selectAccess(page, access, "Bezeichnung und Status", "Lesen");
      await selectAccess(page, access, "Leistungsbeschreibungen", "Lesen");
      await saveOfferAccess(access);
      await expect(
        member.locator('[data-gaeb-field="project:title"]'),
      ).toHaveAttribute(
        "aria-description",
        "Nach dem Entzug ausschließlich für John",
      );
      await expect(
        member.locator('[data-gaeb-field="project:title"]'),
      ).toBeDisabled();
      await expect(member.locator('[data-gaeb-field$=":UP"]')).toHaveCount(0);
      await member.screenshot({
        path: join(artifacts, "member-gaeb-readonly-after-regrant.png"),
        fullPage: true,
      });
      memberAudit.assertClean();
    } finally {
      await member
        .screenshot({
          path: join(artifacts, "member-gaeb-final.png"),
          fullPage: true,
        })
        .catch(() => {});
      await memberContext.tracing.stop({
        path: join(artifacts, "member-gaeb.zip"),
      });
      await memberContext.close();
      await memberServer.close();
    }
  });
  await scenario("grant-and-revoke-across-api-instances", async (page) => {
    const memberServer = await applicationServer(
      new URL("../../build/client", import.meta.url).pathname,
      endpoints[0],
    );
    servers.add(memberServer);
    const memberContext = await applicationContext();
    await memberContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    const member = await memberContext.newPage();
    const memberAudit = auditPage(member);
    try {
      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await member.goto(`${memberServer.origin}/products`);
      await expect(
        member.getByRole("heading", { name: "Produkte", exact: true }),
      ).toBeVisible();
      await expect(
        member.getByText("Haftgrund, manuell angepasst", { exact: true }),
      ).toHaveCount(0);
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const dialog = await openMemberPermissions(page);
      const catalogue = dialog.getByRole("button", { name: /Produktkatalog/ });
      const save = dialog.getByRole("button", {
        name: "Berechtigungen speichern",
        exact: true,
      });
      await expect(catalogue).toBeEnabled();
      await catalogue.click();
      await page.getByRole("option", { name: "Lesen", exact: true }).click();
      await expect(save).toBeEnabled();
      await save.click();
      await expect(catalogue).toBeEnabled();
      await expect(save).toBeDisabled();
      await expect(
        member.getByText("Haftgrund, manuell angepasst", { exact: true }),
      ).toBeVisible();
      await expect(member.locator('nav a[href="/products"]')).toHaveCount(1);
      await expect(member.locator('nav a[href="/admin"]')).toHaveCount(0);
      await member.screenshot({
        path: join(artifacts, "member-catalogue-granted.png"),
        fullPage: true,
      });
      await catalogue.click();
      await page
        .getByRole("option", { name: "Kein Zugriff", exact: true })
        .click();
      await save.click();
      await expect(catalogue).toBeEnabled();
      await expect(save).toBeDisabled();
      await expect(member.locator('nav a[href="/products"]')).toHaveCount(0);
      await expect(
        member.getByText("Haftgrund, manuell angepasst", { exact: true }),
      ).toHaveCount(0);
      await member.screenshot({
        path: join(artifacts, "member-catalogue-revoked.png"),
        fullPage: true,
      });
      memberAudit.assertClean();
    } finally {
      await member.screenshot({
        path: join(artifacts, "member-live-permissions.png"),
        fullPage: true,
      });
      await memberContext.tracing.stop({
        path: join(artifacts, "member-live-permissions.zip"),
      });
      await memberContext.close();
      await memberServer.close();
    }
  });
  await scenario(
    "default-supervisor-controls-approval-across-instances",
    async (page) => {
      const memberServer = await applicationServer(
        new URL("../../build/client", import.meta.url).pathname,
        endpoints[0],
      );
      servers.add(memberServer);
      const memberContext = await applicationContext();
      const previousCalendarRequests = offlineCalendarRequests;
      await memberContext.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
      const member = await memberContext.newPage();
      const memberAudit = auditPage(member);
      async function requestLeave(date, note) {
        await member
          .getByRole("button", { name: "Abwesenheit beantragen", exact: true })
          .click();
        const form = member.getByRole("dialog", {
          name: "Abwesenheit beantragen",
          exact: true,
        });
        await form.getByLabel(/^Von/).fill(date);
        await form.getByLabel(/^Bis/).fill(date);
        await form.getByLabel("Kommentar", { exact: true }).fill(note);
        await form
          .getByRole("button", { name: "Beantragen", exact: true })
          .click();
        await expect(form).toBeHidden();
        const row = member.getByRole("row").filter({ hasText: note });
        await expect(row).toBeVisible();
        return row;
      }
      try {
        await login(member, "frank.doe", "123456", memberServer.origin);
        await expect(
          member.getByRole("link", { name: "Einstellungen", exact: true }),
        ).toBeVisible();
        await member.goto(`${memberServer.origin}/vacations`);
        const automatic = await requestLeave(
          "2026-12-14",
          "Antrag vor Standardfreigabe",
        );
        await expect(
          automatic.getByText("Freigegeben", { exact: true }),
        ).toBeVisible();

        await login(page, "john.doe");
        await expect(
          page.getByRole("link", { name: "Einstellungen", exact: true }),
        ).toBeVisible();
        await page.goto(`${server.origin}/admin?tab=staff`);
        const picker = page.getByRole("combobox", {
          name: /^Standard-Vorgesetzter/,
        });
        await picker.fill("John");
        await page.getByRole("option", { name: /John Doe/ }).click();
        await page
          .getByRole("button", { name: "Standard speichern", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Standard entfernen", exact: true }),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole("button", { name: "Standard entfernen", exact: true }),
        ).toBeVisible();
        await expect(page.getByText("John Doe", { exact: true })).toBeVisible();

        const pending = await requestLeave(
          "2026-12-15",
          "Antrag mit Standardfreigabe",
        );
        await expect(
          pending.getByText("Beantragt", { exact: true }),
        ).toBeVisible();
        await expect(
          pending.getByRole("button", { name: "Freigeben", exact: true }),
        ).toHaveCount(0);
        await member.screenshot({
          path: join(artifacts, "member-default-supervisor-pending.png"),
          fullPage: true,
        });
        await page.goto(`${server.origin}/vacations`);
        const request = page
          .getByRole("row")
          .filter({ hasText: "Antrag mit Standardfreigabe" });
        await request
          .getByRole("button", { name: "Freigeben", exact: true })
          .click();
        const approval = page.getByRole("dialog", {
          name: "Abwesenheit freigeben",
          exact: true,
        });
        await approval
          .getByRole("button", { name: "Freigeben", exact: true })
          .click();
        await expect(approval).toBeHidden();
        await expect(
          pending.getByText("Freigegeben", { exact: true }),
        ).toBeVisible();
        await page.goto(`${server.origin}/admin?tab=staff`);
        await page
          .getByRole("button", { name: "Standard entfernen", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Standard entfernen", exact: true }),
        ).toHaveCount(0);
        await member.screenshot({
          path: join(artifacts, "member-default-supervisor-approved.png"),
          fullPage: true,
        });
        memberAudit.assertClean();
        await expect
          .poll(() => offlineCalendarRequests)
          .toBeGreaterThan(previousCalendarRequests);
      } finally {
        await member
          .screenshot({
            path: join(artifacts, "member-supervisor-final.png"),
            fullPage: true,
          })
          .catch((error) =>
            console.error("Member screenshot unavailable:", error.message),
          );
        await memberContext.tracing
          .stop({
            path: join(artifacts, "member-supervisor-live.zip"),
          })
          .catch((error) =>
            console.error("Member trace unavailable:", error.message),
          );
        await memberContext.close();
        await memberServer.close();
      }
    },
  );
  await scenario(
    "operator-diagnostics-without-document-contents",
    async (page) => {
      await page.goto(`${server.origin}/__admin/errors`);
      await expect(page.getByLabel(/^Global Admin Passwort/)).toBeVisible();
      await loginOperator(page);
      await page.goto(`${server.origin}/__admin/errors`);
      await expect(
        page.getByRole("heading", { name: "Technische Fehler", exact: true }),
      ).toBeVisible();
      const report = page
        .getByRole("row")
        .filter({ hasText: "client.query" })
        .filter({ hasText: "/gaeb" })
        .first();
      await expect(report).toBeVisible();
      await report.click();
      const dialog = page.getByRole("dialog", {
        name: "Technische Meldung",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("/gaeb", { exact: true })).toBeVisible();
      await dialog.evaluate(async (element) => {
        const animations = document.getAnimations().filter((animation) => {
          const target = animation.effect?.target;
          return (
            target instanceof Element &&
            (target.contains(element) || element.contains(target))
          );
        });
        await Promise.allSettled(
          animations.map((animation) => animation.finished),
        );
      });
      await expect(
        page.getByText("Fenstersanierung Pirckheimer-Gymnasium", {
          exact: true,
        }),
      ).toHaveCount(0);
      await page.screenshot({
        path: join(artifacts, "operator-technical-report.png"),
        fullPage: true,
      });
    },
  );
  await scenario("operator-encrypted-tenant-snapshot", async (page) => {
    await loginOperator(page);
    await page.getByRole("tab", { name: "Datenspeicher", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Datenspeicher", exact: true }),
    ).toBeVisible();
    const tenantRow = page.getByRole("row").filter({ hasText: seeded.tenant });
    await tenantRow
      .getByRole("button", { name: "Sicherungen", exact: true })
      .click();
    const backups = page.getByRole("region", {
      name: "Sicherungen",
      exact: true,
    });
    await backups
      .getByRole("button", { name: "Sicherung erstellen", exact: true })
      .click();
    const download = backups.getByRole("button", {
      name: "Herunterladen",
      exact: true,
    });
    await expect(download).toBeVisible();
    const received = page.waitForEvent("download");
    await download.click();
    const file = await received;
    assert.match(
      file.suggestedFilename(),
      new RegExp(`^${seeded.tenant}-[a-z0-9-]+\\.duckdb$`),
    );
    await file.saveAs(join(artifacts, "encrypted-tenant.duckdb"));
    assert.equal(await file.failure(), null);
    const bytes = await readFile(join(artifacts, "encrypted-tenant.duckdb"));
    assert.ok(bytes.length > 4096);
    for (const marker of [
      "Musterbau & Ausbau GmbH",
      "Handwerkerstraße 12",
      "Untergrund vorbereiten",
      "Haftgrund, manuell angepasst",
    ]) {
      assert.equal(
        bytes.includes(Buffer.from(marker)),
        false,
        "No business plaintext in the downloaded database",
      );
    }
    await page.reload();
    const reloadedRow = page
      .getByRole("row")
      .filter({ hasText: seeded.tenant });
    await reloadedRow
      .getByRole("button", { name: "Sicherungen", exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Sicherungen", exact: true })
        .getByRole("button", { name: "Herunterladen", exact: true }),
    ).toHaveCount(1);
    await page.screenshot({
      path: join(artifacts, "operator-encrypted-snapshot.png"),
      fullPage: true,
    });
  });
  assert.ok(results.length > 0, "The selected browser scenario must exist");
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify({ results }, null, 2),
  );
  console.log(`Browser artifacts: ${artifacts}`);
} finally {
  await close();
}
