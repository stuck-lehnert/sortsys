import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const applicationBuild =
  process.env.SORTSYS_E2E_APPLICATION_BUILD ??
  new URL("../../build/client", import.meta.url).pathname;
const server = await applicationServer(
  applicationBuild,
  endpoints[1],
);
let browser;
const servers = new Set([server]);
const results = [];
const selectedScenarios = new Set(
  (process.env.SORTSYS_E2E_SCENARIO ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
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
      "WDVS-Sockelschiene-684217",
      "wdvs-sockelschiene",
      "sockelschiene-wdvs",
      "Verbundwinkel-619047",
      "verbundwinkel-619047",
      "fehlendesmerkmal-619047",
      "pirckheimer-gym",
      "gymnasium-pirckheimer",
      "bauleitung-0@example.invalid",
      "Treppenhausrenovierung Musterstraße",
      "Treppenhaus im Live-Abgleich",
      "Gemeinsam bearbeiteter Leistungsumfang",
      "Altanstrich und lose Beschichtungen entfernen",
      "Fensterbänke und angrenzende Bauteile abdecken",
      "Kanten mit Abdeckband schützen und anschließend reinigen",
      "Antrag vor Standardfreigabe",
      "Antrag mit Standardfreigabe",
      "Gemeinsames Auftrags-LV von John und Frank",
      "Nach dem Entzug ausschließlich für John",
      "Bohrhammer nach Freigabe bearbeitet",
      "Delegierte Werkzeugausgabe im Browser",
      "Gemeinsame Werkzeugausgabe im Browser",
      "Automatisch freigegebene Werkzeugbuchung im Browser",
      "Suchbeleg 519842.pdf",
      "lose Bestandteile",
      "Saugfähigkeit",
      "Rechnung Innenanstrich Vereinsheim",
      "Mitarbeiterzahlung Browserprüfung 682143",
      "Geprüfte Fensterabdichtung 765324",
      "Baustellenfoto 765324.png",
      "Fensteranschlüsse nachgearbeitet 765324",
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
  if (selectedScenarios.size > 0 && !selectedScenarios.has(name)) return;
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
    await run(page, audit);
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

async function selectOfferAccess(
  page,
  title,
  { existingDialog, timeout = 20_000 } = {},
) {
  const dialog = existingDialog ?? (await openMemberPermissions(page));
  const picker = dialog.getByRole("combobox", {
    name: "Angebot oder Dokument",
    exact: true,
  });
  await expect(picker).toBeEnabled();
  await picker.fill(title);
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const option = page.getByRole("option", {
    name: new RegExp(` – ${escapedTitle}$`),
  });
  await expect
    .poll(async () => {
      if ((await picker.getAttribute("aria-expanded")) !== "true")
        await picker.press("ArrowDown");
      return option.isVisible();
    }, { timeout })
    .toBe(true);
  await option.click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: /Bezeichnung und Status/ }),
  ).toBeEnabled();
  return dialog;
}

async function saveOfferAccess(dialog, timeout = 20_000) {
  await saveResourceAccess(
    dialog,
    "Dokumentzugriff speichern",
    "Bezeichnung und Status",
    timeout,
  );
}

async function saveResourceAccess(dialog, label, field, timeout = 20_000) {
  const save = dialog.getByRole("button", {
    name: label,
    exact: true,
  });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toHaveAttribute("data-pending", "true");
  await expect(save).not.toHaveAttribute("data-pending", "true", { timeout });
  await expect(
    dialog.getByRole("button", { name: new RegExp(field) }),
  ).toBeEnabled({ timeout });
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

function gaebField(page, key) {
  return page.locator(`[data-gaeb-field=${JSON.stringify(key)}]`);
}

async function changeGaebText(page, key, value) {
  const field = gaebField(page, key);
  await expect(field).toBeEnabled();
  await field.focus();
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill(value);
  await input.press("Tab");
}

function rpcInput(request, procedure) {
  return rpcInputs(request, procedure)[0];
}

function rpcInputs(request, procedure) {
  const url = new URL(request.url());
  const paths = decodeURIComponent(url.pathname).split("/").at(-1).split(",");
  if (!paths.includes(procedure)) return [];
  const encoded = url.searchParams.get("input");
  const wire = encoded === null ? request.postDataJSON() : JSON.parse(encoded);
  if (url.searchParams.get("batch") !== "1") return [wire?.json];
  return paths.flatMap((path, index) =>
    path === procedure ? [wire?.[String(index)]?.json] : [],
  );
}

async function deferGaebRequests(editors, procedure, shouldWait, work) {
  const gate = Promise.withResolvers();
  const held = new Set();
  const match = (url) =>
    decodeURIComponent(url.pathname)
      .split("/")
      .at(-1)
      .split(",")
      .includes(procedure);
  const handler = async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    if (!Object.values(body).some((entry) => shouldWait(entry?.json, request))) {
      await route.continue();
      return;
    }
    const resume = gate.promise.then(() => route.continue());
    held.add(resume);
    try {
      await resume;
    } finally {
      held.delete(resume);
    }
  };
  await Promise.all(editors.map((editor) => editor.route(match, handler)));
  try {
    await work();
  } finally {
    gate.resolve();
    try {
      await Promise.all(held);
    } finally {
      await Promise.all(editors.map((editor) => editor.unroute(match, handler)));
    }
  }
}

async function shareTextBeforePublication(editors, work, saveTimeout = 20_000) {
  await deferGaebRequests(
    editors,
    "zerotrust.objects.batch",
    (input) => input?.documents?.length > 0,
    work,
  );
  // The production save deadline starts after the test releases its own gate.
  // The earlier ordinary price saves retain their unchanged cold-save deadline.
  await Promise.all(
    editors.map((editor, index) =>
      expect(
        editor.locator(".gaeb-editor"),
        `Editor ${index + 1} confirmed the native document`,
      ).toHaveAttribute("data-save-state", "saved", { timeout: saveTimeout }),
    ),
  );
}

async function changeProjectTitleBeforePublication(writer, peer, value) {
  const editors = [writer, peer];
  const key = "project:title";
  const procedure = "zerotrust.objects.batch";
  const stagesScope = (input) =>
    input?.objects?.some(({ envelope }) =>
      envelope.object.startsWith(`${envelope.scope}:scope:document:`),
    ) === true;
  let writerStaging = false;
  let peerStaging;
  await deferGaebRequests(
    [peer],
    procedure,
    (input, request) => {
      if (!stagesScope(input)) return false;
      peerStaging ??= request;
      return true;
    },
    async () => {
      // Both editors use the same starting sequence. The writer publishes
      // first, so the stale staging request fails the server's version check.
      await deferGaebRequests(
        [writer],
        procedure,
        (input) => {
          if (!stagesScope(input)) return false;
          writerStaging = true;
          return true;
        },
        async () => {
          await changeGaebText(writer, key, value);
          await Promise.all(
            editors.map((editor) =>
              expect(gaebField(editor, key)).toHaveAttribute("aria-description", value),
            ),
          );
          await expect.poll(() => writerStaging && !!peerStaging).toBe(true);
        },
      );
      await expect(writer.locator(".gaeb-editor")).toHaveAttribute(
        "data-save-state",
        "saved",
      );
    },
  );
  await expect(peer.locator(".gaeb-editor")).toHaveAttribute(
    "data-save-state",
    "saved",
  );
  const reply = await (await peerStaging.response()).json();
  assert.ok(reply.some((entry) => entry.error?.json?.data?.code === "CONFLICT"));
}

try {
  browser = await chromium.launch({
    headless: process.env.SORTSYS_E2E_HEADED !== "1",
    executablePath: process.env.SORTSYS_E2E_CHROMIUM,
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
  });
  await scenario("local-database-worker-startup-and-recovery", async (page) => {
    const workerAsset = /\/assets\/duckdb-browser-(eh|mvp)\.worker-[^/]+\.js$/;
    const context = page.context();
    let failedWorkerRequests = 0;
    const failWorker = async (route) => {
      failedWorkerRequests++;
      await route.fulfill({ status: 404, body: "Worker asset unavailable" });
    };
    await context.route(workerAsset, failWorker);
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/products`);
    const failure = page
      .getByRole("main")
      .getByRole("alert")
      .filter({ hasText: "Einträge konnten nicht geladen werden." });
    await expect(failure).toBeVisible();
    await expect(
      page.getByRole("grid", { name: "Einträge" }),
    ).not.toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByText("Einträge werden geladen …", { exact: true }),
    ).toHaveCount(0);
    assert.ok(failedWorkerRequests > 0);
    const product = page.getByText("Haftgrund, manuell angepasst", {
      exact: true,
    });
    await expect(product).toHaveCount(0);

    await context.unroute(workerAsset, failWorker);
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await page.locator('nav a[href="/products"]').click();
    await expect(product).toBeVisible();
    await expect(failure).toHaveCount(0);
    await page.reload();
    await expect(product).toBeVisible();
  });
  await scenario("stable-refresh-and-warm-search", async (page) => {
    let socket;
    let fingerprint;
    await page.routeWebSocket("**/zerotrust/events", (route) => {
      const upstream = route.connectToServer();
      upstream.onMessage((payload) => {
        const frame = JSON.parse(payload.toString());
        if (frame.type === "ready" || frame.type === "changed") {
          socket = route;
          fingerprint = frame.fingerprint;
        }
        route.send(payload);
      });
    });
    let accessSnapshots = 0;
    let menuPages = 0;
    let fullDomainLists = 0;
    let controlReads = 0;
    let objectReads = 0;
    const personnelSearchReads = [];
    const controlProcedures = (request) =>
      ["auth.sessionInfo", "zerotrust.status"].reduce(
        (count, path) => count + rpcInputs(request, path).length,
        0,
      );
    page.on("request", (request) => {
      accessSnapshots += rpcInputs(request, "zerotrust.access.snapshot").length;
      menuPages += rpcInputs(request, "zerotrust.access.page").filter(
        (input) => input?.includeDomains === false,
      ).length;
      fullDomainLists += rpcInputs(request, "zerotrust.domains.list").length;
      controlReads += controlProcedures(request);
      const selections = [
        ...rpcInputs(request, "zerotrust.access.snapshot").flatMap(
          (input) => input?.pages?.selections ?? [],
        ),
        ...rpcInputs(request, "zerotrust.objects.pages").flatMap(
          (input) => input?.selections ?? [],
        ),
        ...rpcInputs(request, "zerotrust.objects.list"),
      ];
      const fullProfiles = new Set(selections.flatMap(({ domain }) => {
        const match = /^(personnel:[^:]+):(calculation|scope)$/.exec(domain ?? "");
        return match ? [match[1]] : [];
      }));
      objectReads += selections.filter(({ domain }) => {
        if (/^(catalog|project|tool):.+:master-data$/.test(domain ?? "")) return true;
        const user = /^(personnel:[^:]+):master-data$/.exec(domain ?? "");
        return user && !fullProfiles.has(user[1]);
      }).length;
      const personnel = selections
        .map((selection) => selection.domain)
        .filter((domain) => domain?.startsWith("personnel:"));
      const subjects = new Set(personnel.map((domain) => domain.split(":")[1]));
      if (subjects.size > 1) personnelSearchReads.push(...personnel);
    });

    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    socket = undefined;
    fingerprint = undefined;
    menuPages = 0;
    fullDomainLists = 0;
    await page.goto(`${server.origin}/products`);
    await expect(
      page.getByText("Haftgrund, manuell angepasst", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => typeof fingerprint).toBe("string");
    await expect(page.locator('nav a[href="/projects"]')).toHaveCount(1);
    assert.equal(menuPages, 0, "The menu's proof inventory fits in the first response");

    personnelSearchReads.length = 0;
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Befehlspalette" });
    const search = palette.getByRole("searchbox", { name: "Befehl oder Suche" });
    const searchPanel = palette.locator("[data-searching]");
    const project = palette.getByRole("option", {
      name: /Fenstersanierung Pirckheimer-Gymnasium/,
    });
    await search.fill("pirckheimer");
    await expect(project).toBeVisible();
    await expect(searchPanel).toHaveAttribute("data-searching", "false");
    assert.equal(fullDomainLists, 0, "Startup and search do not list every domain");
    assert.ok(personnelSearchReads.length > 0);
    assert.ok(
      personnelSearchReads.every((domain) => domain.endsWith(":master-data")),
      "The command palette only opens personnel master data",
    );
    const warmedObjectReads = objectReads;
    for (const term of ["pirckheimer-g", "pirckheimer-gym"]) {
      await search.fill(term);
      await expect(project).toBeVisible();
      await expect(searchPanel).toHaveAttribute("data-searching", "false");
    }
    assert.equal(
      objectReads,
      warmedObjectReads,
      "Refining the search performs no additional business data reads",
    );
    await palette.getByText("Schließen", { exact: true }).click();
    await expect(palette).toBeHidden();

    const product = page.getByText("Haftgrund, manuell angepasst", {
      exact: true,
    });
    const mountedProduct = await product.elementHandle();
    const sendRefresh = (control) =>
      socket.send(
        JSON.stringify({
          type: "changed",
          fingerprint,
          all: true,
          control,
          reset: false,
          domains: {},
        }),
      );
    const previousControlReads = controlReads;
    const previousAccessSnapshots = accessSnapshots;
    sendRefresh(false);
    await expect.poll(() => accessSnapshots).toBeGreaterThan(previousAccessSnapshots);
    assert.equal(controlReads, previousControlReads);
    assert.equal(await mountedProduct.evaluate((node) => node.isConnected), true);

    let failedControlReads = 0;
    await page.route("**/api/v2/**", async (route) => {
      const count = controlProcedures(route.request());
      if (!count) return route.continue();
      await route.fulfill({ status: 503, body: "Temporarily unavailable" });
      failedControlReads += count;
    });
    sendRefresh(true);
    await expect.poll(() => failedControlReads).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(6_000);
    await expect(product).toBeVisible();
    assert.equal(await mountedProduct.evaluate((node) => node.isConnected), true);
    await mountedProduct.dispose();
  });
  await scenario("product-prefix-search", async (page) => {
    const catalogueDomain = "catalog:products:master-data";
    let initialCatalogueBatched = false;
    page.on("request", (request) => {
      if (
        rpcInputs(request, "zerotrust.access.snapshot").some(
          (input) =>
            input?.domains?.includes(catalogueDomain) &&
            input.pages?.selections?.some(
              (selection) =>
                selection.domain === catalogueDomain && !selection.headOnly,
            ),
        )
      )
        initialCatalogueBatched = true;
    });
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/products`);
    await page
      .getByText("Haftgrund, manuell angepasst", { exact: true })
      .click();
    await expect(page).toHaveURL(/\/products\/[^/]+$/);
    assert.equal(
      initialCatalogueBatched,
      true,
      "The catalogue's first encrypted page travels with its access snapshot",
    );
    const productUrl = page.url();
    const edit = async () => {
      await expect(
        page.getByRole("heading", { name: /Haftgrund, manuell angepasst/ }),
      ).toBeVisible();
      await page.keyboard.press("Control+e");
      const editor = page.getByRole("dialog", { name: "Produkt bearbeiten" });
      await expect(editor).toBeVisible();
      return editor;
    };
    const editor = await edit();
    const description = editor.getByRole("textbox", { name: "Beschreibung" });
    const original = await description.inputValue();
    await description.fill("WDVS-Sockelschiene-684217");
    await editor.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(editor).toBeHidden();
    try {
      await expect(page.getByText("WDVS-Sockelschiene-684217")).toBeVisible();
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Befehlspalette" });
      const search = palette.getByRole("searchbox", {
        name: "Befehl oder Suche",
      });
      await search.fill("wdvs-sockelschiene");
      const result = palette.getByRole("option", {
        name: /Haftgrund, manuell angepasst/,
      });
      await expect(result).toBeVisible();
      await search.fill("sockelschiene-wdvs");
      await expect(
        palette.getByText("Keine Treffer.", { exact: true }),
      ).toBeVisible();
      await expect(result).toHaveCount(0);
    } finally {
      await page.goto(productUrl);
      const restore = await edit();
      await restore.getByRole("textbox", { name: "Beschreibung" }).fill(original);
      await restore.getByRole("button", { name: "Speichern", exact: true }).click();
      await expect(restore).toBeHidden();
    }
  });
  await scenario("project-and-address-prefix-search", async (page) => {
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Befehlspalette" });
    const search = palette.getByRole("searchbox", {
      name: "Befehl oder Suche",
    });
    const project = palette.getByRole("option", {
      name: /Fenstersanierung Pirckheimer-Gymnasium/,
    });
    await search.fill("pirckheimer-gym");
    await expect(project).toBeVisible();
    await search.fill("gymnasium-pirckheimer");
    await expect(
      palette.getByText("Keine Treffer.", { exact: true }),
    ).toBeVisible();
    await expect(project).toHaveCount(0);
    await search.fill("bauleitung-0@example.invalid");
    await expect(
      palette.getByRole("option", { name: /Nürnberger Wohnbau GmbH/ }),
    ).toBeVisible();
  });
  await scenario("live-directory-search", async (page) => {
    const editorServer = await applicationServer(applicationBuild, endpoints[0]);
    servers.add(editorServer);
    const editorContext = await applicationContext();
    const editorPage = await editorContext.newPage();
    const editorAudit = auditPage(editorPage);
    try {
      await login(page, "john.doe");
      await expect(page.getByRole("link", { name: "Einstellungen", exact: true }))
        .toBeVisible();
      await login(editorPage, "john.doe", "123456", editorServer.origin);
      await expect(
        editorPage.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await editorPage.goto(`${editorServer.origin}/products`);
      await editorPage.getByText("Haftgrund, manuell angepasst", { exact: true }).click();
      await expect(editorPage).toHaveURL(/\/products\/[^/]+$/);

      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Befehlspalette" });
      const search = palette.getByRole("searchbox", { name: "Befehl oder Suche" });
      const noMatches = palette.getByText("Keine Treffer.", { exact: true });
      const product = palette.getByRole("option", {
        name: /Haftgrund, manuell angepasst/,
      });
      const query = "verbundwinkel-619047";
      await search.fill(query);
      await expect(noMatches).toBeVisible();

      async function openEditor() {
        await editorPage.keyboard.press("Control+e");
        const dialog = editorPage.getByRole("dialog", { name: "Produkt bearbeiten" });
        await expect(dialog).toBeVisible();
        return dialog;
      }
      async function saveDescription(dialog, description) {
        await dialog.getByRole("textbox", { name: "Beschreibung" }).fill(description);
        await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
        await expect(dialog).toBeHidden();
      }
      const editor = await openEditor();
      const original = await editor.getByRole("textbox", { name: "Beschreibung" }).inputValue();
      await saveDescription(editor, "Verbundwinkel-619047");
      try {
        await expect(product).toBeVisible();
        await expect(search).toHaveValue(query);
        await search.fill("fehlendesmerkmal-619047");
        await expect(product).toHaveCount(0);
        await expect(noMatches).toBeVisible();
        await search.fill(query);
        await expect(product).toBeVisible();
      } finally {
        await saveDescription(await openEditor(), original);
      }
      await expect(product).toHaveCount(0);
      await expect(noMatches).toBeVisible();
      await expect(search).toHaveValue(query);
      editorAudit.assertClean();
    } finally {
      await editorContext.close();
      await editorServer.close();
    }
  });
  await scenario("seeded-gaeb-link-and-download", async (page) => {
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/gaeb/${seeded.caseId}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
    await page.screenshot({
      path: join(artifacts, "administrator-document.png"),
      fullPage: true,
    });
    const ready = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Herunterladen", exact: true })
      .click();
    const download = await ready;
    assert.match(download.suggestedFilename(), /\.x84$/i);
    const xml = await readFile(await download.path(), "utf8");
    assert.match(xml, /<GAEB\b/);
    assert.match(xml, /<DP>84<\/DP>/);
    await expect(
      page.getByRole("button", { name: "Auftrag prüfen", exact: true }),
    ).toBeEnabled();
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
      applicationBuild,
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
      const projectTitle = `Treppenhaus im Live-Abgleich ${crypto.randomUUID().slice(0, 8)}`;
      await changeProjectTitleBeforePublication(page, peer, projectTitle);
      console.log("GAEB E2E: live text arrived before native publication");
      await page.reload();
      await expect(
        page.locator('[data-gaeb-field="project:title"]'),
      ).toHaveAttribute("aria-description", projectTitle);
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
  await scenario("daily-report-encrypted-photos", async (page) => {
    const projectTitle = "Fenstersanierung Pirckheimer-Gymnasium";
    const summary = "Geprüfte Fensterabdichtung 765324";
    const photoName = "Baustellenfoto 765324.png";
    const day = "2026-10-21";
    const reportPath = `/projects/${seeded.projectId}/dailyReports/${day}`;
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("group", { name: "Arbeit erfassen", exact: true })
      .getByRole("button", { name: "Bautagesbericht", exact: true })
      .click();
    const form = page.getByRole("dialog", {
      name: "Bautagesbericht erstellen",
      exact: true,
    });
    await form.getByRole("combobox", { name: /^Projekt/ }).fill(projectTitle);
    await page.getByRole("option", { name: projectTitle, exact: true }).click();
    await form.getByLabel("Beschreibung der Arbeiten").fill(summary);
    await form.locator('input[type="date"]').fill(day);
    await form.getByRole("button", { name: "Erstellen", exact: true }).click();
    await expect(form).toBeHidden();
    await page.goto(`${server.origin}${reportPath}`);
    await expect(page.getByText(summary, { exact: true })).toBeVisible();

    const encoded = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 80;
      canvas.height = 48;
      const context = canvas.getContext("2d");
      context.fillStyle = "#54655a";
      context.fillRect(0, 0, 80, 48);
      context.fillStyle = "#f2d383";
      context.fillRect(12, 8, 56, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const original = Buffer.from(encoded, "base64");
    await page.getByRole("button", { name: "Aktionen", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Fotos hinzufügen", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: photoName,
      mimeType: "image/png",
      buffer: original,
    });
    function photoButton(browserPage) {
      return browserPage.getByRole("button", { name: photoName, exact: true });
    }
    async function expectPhoto(image, width) {
      await expect(image).toHaveAttribute("src", /^blob:/);
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((element) => element.naturalWidth))
        .toBe(width);
    }
    await expectPhoto(page.getByRole("img", { name: photoName }), 80);
    await page.reload();
    const tile = photoButton(page);
    await expectPhoto(tile.getByRole("img"), 80);
    await tile.focus();
    await tile.press("Enter");
    const preview = page.getByRole("dialog", { name: "Dateivorschau" });
    await expectPhoto(preview.getByRole("img", { name: photoName }), 80);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      preview.getByRole("button", { name: "Herunterladen", exact: true }).click(),
    ]);
    assert.equal(download.suggestedFilename(), photoName);
    assert.deepEqual(await readFile(await download.path()), original);
    await preview
      .getByRole("button", { name: "Schließen", exact: true })
      .click();
    await expect(preview).toBeHidden();
    await expect(page).toHaveURL(`${server.origin}${reportPath}`);

    const memberServer = await applicationServer(
      applicationBuild,
      endpoints[0],
    );
    servers.add(memberServer);
    const memberContext = await applicationContext();
    const member = await memberContext.newPage();
    const memberAudit = auditPage(member);
    try {
      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await member.goto(`${memberServer.origin}${reportPath}`);
      await expect(
        member.getByText(
          "Die angeforderte Ressource konnte nicht aufgelöst werden.",
        ),
      ).toBeVisible();

      const permissions = await openMemberPermissions(page);
      const projects = permissions
        .getByRole("heading", { name: "Projektzugriff", exact: true })
        .locator("xpath=ancestor::section[1]");
      await projects
        .getByRole("combobox", { name: "Projekt", exact: true })
        .fill(projectTitle);
      await page.getByRole("option", { name: projectTitle, exact: true }).click();
      const reportAccess = "Bautagesberichte und Arbeitszeiten";
      const fileAccess = "Projektdateien";
      const save = (field) =>
        saveResourceAccess(projects, "Projektzugriff speichern", field, 60_000);
      await selectAccess(page, projects, reportAccess, "Lesen");
      await save(reportAccess);
      await expect(member.getByText(summary, { exact: true })).toBeVisible();
      await expect(member.getByText(photoName, { exact: true })).toHaveCount(0);
      await expect(member.getByRole("img", { name: photoName })).toHaveCount(0);

      await selectAccess(page, projects, fileAccess, "Lesen");
      await save(fileAccess);
      await expectPhoto(photoButton(member).getByRole("img"), 80);
      await photoButton(member).click();
      const memberPreview = member.getByRole("dialog", {
        name: "Dateivorschau",
      });
      await expectPhoto(memberPreview.getByRole("img", { name: photoName }), 80);

      await selectAccess(page, projects, fileAccess, "Kein Zugriff");
      await save(fileAccess);
      await expect(memberPreview).toBeHidden();
      await expect(member.getByText(summary, { exact: true })).toBeVisible();
      await expect(member.getByText(photoName, { exact: true })).toHaveCount(0);

      await selectAccess(page, projects, reportAccess, "Kein Zugriff");
      await save(reportAccess);
      await expect(member.getByText(summary, { exact: true })).toHaveCount(0);

      const master = "Projektgrunddaten";
      const regie = "Regieberichte und Material";
      const costs = "Interne Arbeitskosten";
      for (const field of [master, regie, costs]) {
        await expect(
          projects.getByRole("button", { name: new RegExp(field) }),
        ).toContainText("Kein Zugriff");
      }
      await selectAccess(
        page,
        projects,
        "Freigabevorlage",
        "Baustellendokumentation",
      );
      await projects
        .getByRole("button", { name: "Einzelrechte ergänzen", exact: true })
        .click();
      const reportActions = projects.getByRole("group", {
        name: `Einzelrechte für ${reportAccess}`,
        exact: true,
      });
      for (const action of ["Lesen", "Anlegen", "Bearbeiten"]) {
        await expect(
          reportActions.getByRole("checkbox", { name: action, exact: true }),
        ).toBeChecked();
      }
      await expect(
        reportActions.getByRole("checkbox", { name: "Löschen", exact: true }),
      ).not.toBeChecked();
      await expect(
        projects.getByRole("button", { name: new RegExp(costs) }),
      ).toContainText("Kein Zugriff");
      await expect(member.getByText(summary, { exact: true })).toHaveCount(0);

      await save(reportAccess);
      await expect(member.getByText(summary, { exact: true })).toBeVisible();
      await expectPhoto(photoButton(member).getByRole("img"), 80);
      const reportHeader = member.locator(".ss-page-header").filter({
        has: member.getByRole("heading", {
          name: "Bautagesbericht",
          exact: true,
        }),
      });
      await reportHeader
        .getByRole("button", { name: "Aktionen", exact: true })
        .click();
      await expect(
        member.getByRole("menuitem", { name: "Löschen", exact: true }),
      ).toHaveCount(0);
      await member
        .getByRole("menuitem", { name: "Bearbeiten", exact: true })
        .click();
      const editor = member.getByRole("dialog", {
        name: "Bautagesbericht bearbeiten",
        exact: true,
      });
      const revisedSummary = "Fensteranschlüsse nachgearbeitet 765324";
      await editor.getByLabel("Beschreibung der Arbeiten").fill(revisedSummary);
      await editor
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await expect(editor).toBeHidden();
      await expect(member.getByText(revisedSummary, { exact: true })).toBeVisible();

      for (const field of [master, fileAccess, reportAccess, regie]) {
        await selectAccess(page, projects, field, "Kein Zugriff");
      }
      await save(reportAccess);
      await expect(member.getByText(revisedSummary, { exact: true })).toHaveCount(0);
      memberAudit.assertClean();
    } finally {
      await memberContext.close();
      await memberServer.close();
    }
  });
  await scenario("local-document-search", async (page) => {
    await login(page, "john.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/projects/${seeded.projectId}/files`);
    const fileName = "Suchbeleg 519842.pdf";
    const image = await readFile(
      new URL(
        "../../../sortsys-api-v2/test-files/thispersondoesnotexist01.jpg",
        import.meta.url,
      ),
    );
    const pdf = await readFile(
      new URL(
        "../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf",
        import.meta.url,
      ),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "application/pdf",
      buffer: pdf,
    });
    await expect(
      page.getByRole("button", { name: fileName, exact: true }),
    ).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "Suchfoto 519842.jpg",
      mimeType: "image/jpeg",
      buffer: image,
    });
    const thumbnail = page.getByRole("img", {
      name: "Suchfoto 519842.jpg",
      exact: true,
    });
    await expect(thumbnail).toBeVisible();
    await expect
      .poll(() =>
        thumbnail.evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);

    const { default: Zip } = await import("jszip");
    const word = new Zip();
    word.file("word/document.xml", `
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p>
          <w:r><w:t>Wand</w:t></w:r>
          <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">verkleidung freigegeben</w:t></w:r>
        </w:p></w:body>
      </w:document>
    `);
    const slides = new Zip();
    slides.file("ppt/slides/slide1.xml", `
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody>
          <a:p><a:r><a:t>Gerüstanker kontrollieren</a:t></a:r></a:p>
        </p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>
    `);
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Baustelle").getCell("A1").value = "Schachtabdeckung vermessen";
    const officeFiles = [
      {
        name: "Begehung.docx",
        mimeType: "application/octet-stream",
        buffer: await word.generateAsync({ type: "nodebuffer" }),
        phrase: "Wandverkleidung freigegeben",
      },
      {
        name: "Baubesprechung.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        buffer: await slides.generateAsync({ type: "nodebuffer" }),
        phrase: "Gerüstanker kontrollieren",
      },
      {
        name: "Aufstellung.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        phrase: "Schachtabdeckung vermessen",
      },
    ];
    for (const { name, mimeType, buffer } of officeFiles) {
      await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await page.goto(`${server.origin}/documents`);
    const query = page.getByRole("searchbox", {
      name: "Dokumente durchsuchen",
      exact: true,
    });
    for (const { name, phrase } of officeFiles) {
      await query.fill(`"${phrase}"`);
      await page.getByRole("button", { name: "Suchen", exact: true }).click();
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
      await expect(page.locator(".documents-search__excerpt mark")).toHaveText(phrase);
    }
    await query.fill('"lose Bestandteile"');
    await page.getByRole("button", { name: "Suchen", exact: true }).click();
    const result = page.getByRole("link", { name: fileName, exact: true });
    await expect(result).toBeVisible();
    await expect(page.locator(".documents-search__excerpt mark")).toHaveText(
      "lose Bestandteile",
    );
    await query.fill('Saugfähigkeit -"lose Bestandteile"');
    await page.getByRole("button", { name: "Suchen", exact: true }).click();
    await expect(
      page.getByText("Keine passenden Dokumente gefunden.", { exact: true }),
    ).toBeVisible();
    await expect(result).toHaveCount(0);
    await query.fill("Innenwand");
    await page.getByRole("button", { name: "Suchen", exact: true }).click();
    await expect(result).toBeVisible();
    await expect(page.locator(".documents-search__excerpt mark")).toContainText(
      "Innenwände",
    );
    await page.screenshot({
      path: join(artifacts, "local-document-search.png"),
      fullPage: true,
    });
    await result.click();
    await expect(page).toHaveURL(/\/files\/[1-9a-v][0-9a-v]*$/);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page
        .frameLocator('iframe[title="PDF ansehen"]')
        .locator('.page[data-page-number="1"] canvas'),
    ).toBeVisible();

    const peerServer = await applicationServer(
      applicationBuild,
      endpoints[0],
    );
    servers.add(peerServer);
    const peerContext = await applicationContext();
    try {
      const peer = await peerContext.newPage();
      const audit = auditPage(peer);
      await login(peer, "frank.doe", "123456", peerServer.origin);
      await expect(
        peer.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await peer.goto(`${peerServer.origin}/documents`);
      const peerSearch = peer.getByRole("searchbox", {
        name: "Dokumente durchsuchen",
      });
      await peerSearch.fill('"lose Bestandteile"');
      await peerSearch.press("Enter");
      await expect(
        peer.getByText("Keine passenden Dokumente gefunden.", { exact: true }),
      ).toBeVisible();
      await expect(
        peer.getByRole("link", { name: fileName, exact: true }),
      ).toHaveCount(0);
      await expect(peer.locator(".documents-search__excerpt")).toHaveCount(0);
      await peer.screenshot({
        path: join(artifacts, "local-document-search-denied.png"),
        fullPage: true,
      });
      audit.assertClean();
    } finally {
      await peerContext.close();
    }
  });
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
  await scenario("gaeb-attachment-resumes-across-api-instances", async (page) => {
    const peerServer = await applicationServer(applicationBuild, endpoints[0]);
    servers.add(peerServer);
    const peerContext = await applicationContext();
    const peer = await peerContext.newPage();
    const peerAudit = auditPage(peer);
    const timeout = 60_000;
    const projectPath = `/projects/${seeded.projectId}/files`;
    const filename = "Gemeinsames Leistungsverzeichnis.x83";
    await peerContext.tracing.start({ screenshots: true, snapshots: true });
    try {
      await login(page, "john.doe");
      await expect(page.getByRole("link", {
        name: "Einstellungen", exact: true,
      })).toBeVisible();
      await page.goto(server.origin + projectPath);
      const xml = await readFile(new URL(
        "../../../sortsys-gaeb/scripts/fixtures/native-seed/demo.x83",
        import.meta.url,
      ));
      await page.locator('input[type="file"]').setInputFiles(
        { name: filename, mimeType: "application/xml", buffer: xml },
        { timeout },
      );
      await page.getByRole("button", { name: filename, exact: true }).click({ timeout });
      const editor = page.locator(".gaeb-editor");
      await expect(editor).toHaveAttribute("data-connection-state", "online", { timeout });
      const field = editor.locator('[data-gaeb-field^="item-"][data-gaeb-field$=":text:0"]').first();
      const key = await field.getAttribute("data-gaeb-field");
      assert.ok(key);
      const savedText = "Laibung reinigen und Grundierung auftragen.";
      const published = page.waitForResponse((response) => {
        const request = rpcInput(response.request(), "zerotrust.objects.batch");
        return response.ok() && request?.liveCheckpoints?.some((proof) => proof.replay);
      }, { timeout });
      await changeGaebText(page, key, savedText);
      const request = rpcInput((await published).request(), "zerotrust.objects.batch");
      const proof = request.liveCheckpoints.find((entry) => entry.replay);
      assert.ok(request.objects.some((entry) => entry.envelope.object === proof.replay.object));
      await expect(editor).toHaveAttribute("data-save-state", "saved", { timeout });

      await login(peer, "john.doe", "123456", peerServer.origin);
      await expect(peer.getByRole("link", {
        name: "Einstellungen", exact: true,
      })).toBeVisible();
      const cursors = [];
      const watchAttachment = (networkRequest) => {
        const read = rpcInput(networkRequest, "zerotrust.documents.messages.read");
        const pages = rpcInput(networkRequest, "zerotrust.documents.messages.pages");
        for (const selection of read ? [read] : (pages?.selections ?? [])) {
          if (selection.room?.facet === "attachment") cursors.push(selection.after);
        }
      };
      peer.on("request", watchAttachment);
      await peer.goto(peerServer.origin + new URL(page.url()).pathname);
      const peerEditor = peer.locator(".gaeb-editor");
      await expect(peerEditor).toHaveAttribute("data-connection-state", "online", { timeout });
      await expect(gaebField(peer, key)).toHaveAttribute("aria-description", savedText);
      assert.equal(cursors[0], proof.covered);
      assert.ok(BigInt(cursors[0]) > 0n);
      peer.off("request", watchAttachment);

      const continued = "Laibung reinigen, grundieren und bündig verspachteln.";
      await deferGaebRequests(
        [page],
        "zerotrust.objects.batch",
        (input) => input?.liveCheckpoints?.some((entry) => entry.document === proof.document),
        async () => {
          await changeGaebText(page, key, continued);
          await expect(gaebField(peer, key)).toHaveAttribute("aria-description", continued);
        },
      );
      await expect(editor).toHaveAttribute("data-save-state", "saved", { timeout });
      peerAudit.assertClean();
    } finally {
      await peerContext.tracing.stop({ path: join(artifacts, "peer-gaeb-attachment.zip") });
      await peerContext.close();
      await peerServer.close();
    }
  });
  await scenario("member-visibility-and-direct-url-denials", async (page) => {
    await login(page, "frank.doe");
    await expect(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    for (const target of ["/admin", "/offers", "/projects", "/products"]) {
      await expect(page.locator(`nav a[href="${target}"]`)).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Befehle und Suche" }).click();
    const palette = page.getByRole("dialog", { name: "Befehlspalette" });
    const search = palette.getByRole("searchbox", { name: "Befehl oder Suche" });
    for (const [term, deniedResult] of [
      ["Haftgrund", /Haftgrund, manuell angepasst/],
      ["Pirckheimer-Gymnasium", /Fenstersanierung Pirckheimer-Gymnasium/],
    ]) {
      await search.fill(term);
      await expect(
        palette.getByText("Keine Treffer.", { exact: true }),
      ).toBeVisible();
      await expect(
        palette.getByRole("option", { name: deniedResult }),
      ).toHaveCount(0);
    }
    await palette.getByText("Schließen", { exact: true }).click();
    await expect(palette).toBeHidden();
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
      applicationBuild,
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
    async function returnTool(browserPage, origin, path) {
      await browserPage.goto(`${origin}${path}`);
      await browserPage
        .getByRole("main")
        .getByRole("button", { name: "Aktionen", exact: true })
        .click();
      await browserPage
        .getByRole("menuitem", { name: "Zurückbuchen", exact: true })
        .click();
      await expect(
        browserPage.getByText("verfügbar", { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
    }
    async function expectBookingHistory(browserPage, count) {
      // The full history is loaded separately from availability through the
      // unoptimized local API. Assert the result while both sessions are live.
      await expect(
        browserPage.getByText(`Buchungshistorie (${count})`, { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
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
      await expectBookingHistory(peer, 1);

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
      await expectBookingHistory(peer, 0);

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
      await expectBookingHistory(page, 1);
      await peer.goto(`${peerServer.origin}${secondPath}`);
      await expect(peer.getByText("gebucht", { exact: true })).toBeVisible();
      await expectBookingHistory(peer, 2);
      await page.reload();
      await expect(page.getByText("gebucht", { exact: true })).toBeVisible();
      await expectBookingHistory(page, 1);
      await expect(
        page.getByRole("link", { name: "Doe, John", exact: true }),
      ).toHaveCount(2);
      await page.screenshot({
        path: join(artifacts, "tool-batch-booking-completed.png"),
        fullPage: true,
      });
      // Later scenarios reuse these tools. Finish both assignments instead of
      // leaving a successful batch as a hidden prerequisite for the next test.
      await returnTool(page, server.origin, firstPath);
      await returnTool(peer, peerServer.origin, secondPath);
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

  await scenario("tool-responsibility-between-users", async (page, audit) => {
    const memberServer = await applicationServer(
      applicationBuild,
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
      const toolPath = new URL(page.url()).pathname;
      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const memberTools = member.getByRole("link", {
        name: "Werkzeuge",
        exact: true,
      });
      await expect(memberTools).toHaveCount(0);

      const actions = page
        .getByRole("main")
        .getByRole("button", { name: "Aktionen", exact: true });
      async function bookForFrank() {
        await actions.click();
        await page.getByRole("menuitem", { name: "Buchen", exact: true }).click();
        const booking = page.getByRole("dialog", {
          name: "Werkzeuge einbuchen",
          exact: true,
        });
        await booking
          .getByRole("combobox", { name: /^Verantwortlicher/ })
          .fill("Frank");
        await page.getByRole("option", { name: /Frank Doe/ }).click();
        await booking
          .getByLabel("Kommentar", { exact: true })
          .fill("Automatisch freigegebene Werkzeugbuchung im Browser");
        await booking
          .getByRole("button", { name: "Buchen", exact: true })
          .click();
        await expect(booking).toBeHidden();
        await expect(page.getByText("gebucht", { exact: true })).toBeVisible();
      }
      await bookForFrank();

      await member
        .getByRole("button", { name: "Material & Werkzeuge", exact: true })
        .click();
      await expect(memberTools).toHaveAttribute("href", "/tools/trackings");
      await memberTools.click();
      await expect(
        member.getByRole("heading", { name: "Buchungshistorie", exact: true }),
      ).toBeVisible();
      const label = member.getByRole("main").getByText(/Bohrhammer 1/);
      await expect(label).toBeVisible();
      await expect(member.locator(`a[href="${toolPath}"]`)).toHaveCount(0);
      await expect(member.getByText("Kaufpreis", { exact: true })).toHaveCount(
        0,
      );
      await member.screenshot({
        path: join(artifacts, "automatic-tool-responsibility-desktop.png"),
        fullPage: true,
      });
      await member.setViewportSize({ width: 800, height: 1000 });
      const card = member
        .getByRole("main")
        .locator("section")
        .filter({ hasText: "Seit" });
      await expect(card.getByText(/Bohrhammer 1/)).toBeVisible();
      await expect(member.locator(`a[href="${toolPath}"]`)).toHaveCount(0);
      await member.screenshot({
        path: join(artifacts, "automatic-tool-responsibility-card.png"),
        fullPage: true,
      });
      await member.setViewportSize({ width: 1440, height: 1000 });
      await member.reload();
      await expect(label).toBeVisible();

      const returnNotices = audit.eventHints.length;
      await actions.click();
      await page
        .getByRole("menuitem", { name: "Zurückbuchen", exact: true })
        .click();
      await expect(page.getByText("verfügbar", { exact: true })).toBeVisible();
      await expect(label).toHaveCount(0);
      await expect(memberTools).toHaveCount(0);
      assert.deepEqual(
        audit.eventHints
          .slice(returnNotices)
          .filter((notice) => notice.control),
        [],
        "Closing another member's assignment and rotating its keys preserves the owner's unchanged access context",
      );

      await bookForFrank();
      await member.goto(`${memberServer.origin}/tools/trackings`);
      await expect(label).toBeVisible();
      await expect(member.locator(`a[href="${toolPath}"]`)).toHaveCount(0);
      await member.setViewportSize({ width: 800, height: 1000 });
      const publication = member.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/zerotrust.toolReturns.publish"),
      );
      await member.getByRole("button", { name: "Zurückbuchen", exact: true }).click();
      const payload = (await publication).postDataJSON();
      const body = payload["0"].json;
      assert.deepEqual(Object.keys(body).sort(), ["command", "trackingId"]);
      assert.deepEqual(Object.keys(body.command).sort(), [
        "issuedAt", "purpose", "revision", "signature", "tenant", "verificationKey",
      ]);
      await expect(label).toHaveCount(0);
      await expect(member.getByRole("button", { name: "Zurückbuchen", exact: true })).toHaveCount(0);
      await expect(page.getByText("verfügbar", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText("verfügbar", { exact: true })).toBeVisible();
      memberAudit.assertClean();
    } finally {
      await member
        .screenshot({
          path: join(artifacts, "automatic-tool-responsibility-current.png"),
          fullPage: true,
        })
        .catch(() => {});
      await memberContext.tracing.stop({
        path: join(artifacts, "automatic-tool-responsibility.zip"),
      });
      await memberContext.close();
    }
  });

  await scenario("tool-booking-creation-between-users", async (page) => {
    const memberServer = await applicationServer(
      applicationBuild,
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
    const publications = [];
    page.on("request", (request) => {
      const paths = new URL(request.url()).pathname
        .split("/")
        .at(-1)
        .split(",");
      const index = paths.indexOf("zerotrust.access.publish");
      if (index < 0) return;
      const body = request.postDataJSON();
      publications.push(body[String(index)].json);
    });
    let authorization;
    member.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/v2/")) {
        authorization = request.headers().authorization ?? authorization;
      }
    });
    async function memberQuery(path, input) {
      assert.ok(
        authorization,
        "The member must have an authenticated API request",
      );
      const url = new URL(`/api/v2/${path}`, memberServer.origin);
      url.searchParams.set("batch", "1");
      url.searchParams.set("input", JSON.stringify({ 0: { json: input } }));
      const response = await member.request.get(url.href, {
        headers: { authorization },
      });
      assert.equal(response.status(), 200);
      return (await response.json())[0];
    }
    async function capability(subject) {
      return memberQuery("zerotrust.creations.capability", {
        namespace: "tool-tracking",
        ...(subject ? { subject } : {}),
      });
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
      const historyHeading = page.getByRole("button", {
        name: /^Buchungshistorie \(\d+\)$/,
      });
      await expect(historyHeading).toBeVisible();
      const historyLabel = await historyHeading.innerText();
      const historyMatch = /^Buchungshistorie \((\d+)\)$/.exec(
        historyLabel.trim(),
      );
      assert.ok(
        historyMatch,
        "The tool must expose its existing booking count",
      );
      const expectedHistoryCount = Number(historyMatch[1]) + 1;
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
      const publicationStart = publications.length;
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      const published = publications.slice(publicationStart);
      assert.equal(
        published.length,
        1,
        "Both edited areas share one atomic access publication",
      );
      const toolScope = `tool:${path.split("/").at(-1)}`;
      assert.equal(
        published[0].domains.filter((domain) => domain.scope === toolScope)
          .length,
        2,
      );
      assert.ok(
        published[0].grants.filter((grant) =>
          grant.domain.startsWith(`${toolScope}:`),
        ).length >= 2,
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
      const encryptedKeys = await memberQuery("zerotrust.keys.inspect", {
        keys: [
          {
            domain: `${toolScope}:master-data`,
            generation: "1",
            recipient: granted.result.data.json.creator.user,
          },
        ],
      });
      assert.equal(encryptedKeys.error.json.data.httpCode, 403);

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
        page.getByText(`Buchungshistorie (${expectedHistoryCount})`, {
          exact: true,
        }),
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
        page.getByText(`Buchungshistorie (${expectedHistoryCount})`, {
          exact: true,
        }),
      ).toBeVisible();
      await member.screenshot({
        path: join(
          artifacts,
          "member-tool-booking-after-creation-revocation.png",
        ),
        fullPage: true,
      });
      // The following access test starts without a master-data grant. Closing
      // the booking retains its own history, so only the tool grant is removed.
      access = await selectToolAccess(page, "Bohrhammer 1");
      await selectAccess(page, access, "Werkzeugstammdaten", "Kein Zugriff");
      await saveResourceAccess(
        access,
        "Werkzeugzugriff speichern",
        "Werkzeugstammdaten",
      );
      await expect(
        member.getByText(
          "Die angeforderte Ressource konnte nicht aufgelöst werden.",
          { exact: true },
        ),
      ).toBeVisible();
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
      applicationBuild,
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
  await scenario("billing-actions-between-users", async (page) => {
    const memberServer = await applicationServer(
      applicationBuild,
      endpoints[0],
    );
    servers.add(memberServer);
    const memberContext = await applicationContext();
    const member = await memberContext.newPage();
    member.setDefaultTimeout(20_000);
    const memberAudit = auditPage(member);
    await memberContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    const projectTitle = "Innenanstrich Vereinsheim";
    const invoiceTitle = `Rechnung ${projectTitle}`;
    const paymentReference = "Mitarbeiterzahlung Browserprüfung 682143";
    const publicationTimeout = 60_000;
    try {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      const projectsLink = page.getByRole("link", {
        name: "Projekte",
        exact: true,
      });
      if (!(await projectsLink.isVisible())) {
        await page
          .getByRole("button", { name: "Projektarbeit", exact: true })
          .click();
      }
      await projectsLink.click();
      const projectRow = page
        .getByRole("row")
        .filter({ hasText: projectTitle });
      // A cold encrypted inventory verifies the full seeded tenant. Keep its
      // load budget separate from the 20-second limit for individual actions.
      await expect(projectRow).toBeVisible({ timeout: 60_000 });
      await projectRow.click();
      await page
        .getByRole("tab", { name: "Auftrag & Leistungen", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Vorgangsübersicht", exact: true }),
      ).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
      await page
        .getByRole("textbox", { name: "Suchen", exact: true })
        .fill(invoiceTitle);
      await page.getByRole("row").filter({ hasText: invoiceTitle }).click();
      await expect(page.locator(".gaeb-editor")).toBeVisible();
      const invoicePath = new URL(page.url()).pathname;
      console.log("Billing UI: owner invoice opened");

      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await member.goto(`${memberServer.origin}${invoicePath}`);
      await expect(
        member.getByText("Vorgang nicht geladen", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(member.locator('nav a[href="/admin"]')).toHaveCount(0);

      const documentAccess = (dialog) =>
        dialog
          .getByRole("heading", {
            name: "Angebote und Dokumente",
            exact: true,
          })
          .locator("xpath=ancestor::section[1]");
      let access = await selectOfferAccess(page, invoiceTitle);
      for (const [label, value] of [
        ["Bezeichnung und Status", "Lesen und bearbeiten"],
        ["Leistungsbeschreibungen", "Lesen"],
        ["Vertragsmengen", "Lesen"],
        ["Rechnungswerte", "Lesen und bearbeiten"],
      ])
        await selectAccess(page, documentAccess(access), label, value);
      await saveOfferAccess(access, publicationTimeout);
      await expect(member.locator(".gaeb-editor")).toBeVisible();
      await expect(
        member.getByRole("button", {
          name: "Rechnung ausstellen",
          exact: true,
        }),
      ).toHaveCount(0);

      console.log(
        "Billing UI: partial invoice granted without issuance rights",
      );
      access = await selectOfferAccess(page, projectTitle, {
        existingDialog: access,
      });
      await selectAccess(
        page,
        documentAccess(access),
        "Bezeichnung und Status",
        "Lesen",
      );
      await selectAccess(
        page,
        documentAccess(access),
        "Rechnungswerte",
        "Lesen und bearbeiten",
      );
      await saveOfferAccess(access, publicationTimeout);
      const projects = access
        .getByRole("heading", {
          name: "Projektzugriff",
          exact: true,
        })
        .locator("xpath=ancestor::section[1]");
      await projects
        .getByRole("combobox", { name: "Projekt", exact: true })
        .fill(projectTitle);
      await page
        .getByRole("option", { name: projectTitle, exact: true })
        .click();
      await selectAccess(page, projects, "Rechnungswerte", "Individuell");
      const projectActions = projects.getByRole("group", {
        name: "Einzelrechte für Rechnungswerte",
        exact: true,
      });
      for (const name of ["Lesen", "Anlegen"]) {
        const checkbox = projectActions.getByRole("checkbox", {
          name,
          exact: true,
        });
        await expect(checkbox).not.toBeChecked();
        await checkbox.focus();
        await checkbox.press("Space");
        await expect(checkbox).toBeChecked();
      }
      await expect(
        projectActions.getByRole("checkbox", {
          name: "Bearbeiten",
          exact: true,
        }),
      ).not.toBeChecked();
      await saveResourceAccess(
        projects,
        "Projektzugriff speichern",
        "Rechnungswerte",
        publicationTimeout,
      );
      await expect(
        member.getByRole("button", {
          name: "Rechnung ausstellen",
          exact: true,
        }),
      ).toHaveCount(0);

      await selectAccess(
        page,
        access,
        "Mandantenweite Rechnungsnummern",
        "Lesen und bearbeiten",
      );
      await saveResourceAccess(
        access,
        "Rechnungsnummernfreigabe speichern",
        "Mandantenweite Rechnungsnummern",
        publicationTimeout,
      );
      const issue = member.getByRole("button", {
        name: "Rechnung ausstellen",
        exact: true,
      });
      await expect(issue).toBeEnabled();
      console.log(
        "Billing UI: exact invoice, contract, project and numbering grants ready",
      );
      await issue.click();
      await expect(
        member.getByRole("button", { name: "Zahlungseingang", exact: true }),
      ).toBeEnabled({ timeout: publicationTimeout });
      await expect(issue).toHaveCount(0);
      await member.screenshot({
        path: join(artifacts, "member-invoice-issued.png"),
        fullPage: true,
      });

      console.log("Billing UI: partial invoice issued");
      async function pay(amount, reference) {
        await member
          .getByRole("button", { name: "Zahlungseingang", exact: true })
          .click();
        const dialog = member.getByRole("dialog", {
          name: "Zahlungseingänge",
          exact: true,
        });
        await dialog.getByLabel(/^Betrag/).fill(amount);
        await dialog.getByLabel(/^Verwendungszweck/).fill(reference);
        return dialog;
      }
      let payments = await pay(
        "99999999",
        "Zu hohe Zahlung Browserprüfung 682143",
      );
      await payments
        .getByRole("button", { name: "Zahlung erfassen", exact: true })
        .click();
      await expect(payments.getByRole("alert")).toBeVisible();
      await payments
        .getByRole("button", { name: "Schließen", exact: true })
        .click();
      payments = await pay("10,00", paymentReference);
      await payments
        .getByRole("button", { name: "Zahlung erfassen", exact: true })
        .click();
      await expect(payments).toHaveCount(0);
      await member
        .getByRole("button", { name: "Zahlungseingang", exact: true })
        .click();
      payments = member.getByRole("dialog", {
        name: "Zahlungseingänge",
        exact: true,
      });
      await expect(
        payments.getByText(paymentReference, { exact: false }),
      ).toBeVisible();

      console.log("Billing UI: payment recorded and visible");
      access = await selectOfferAccess(page, invoiceTitle, {
        existingDialog: access,
      });
      await selectAccess(
        page,
        documentAccess(access),
        "Rechnungswerte",
        "Kein Zugriff",
      );
      await saveOfferAccess(access, publicationTimeout);
      await expect(
        member.getByText(paymentReference, { exact: false }),
      ).toHaveCount(0);
      await expect(
        member.getByRole("button", { name: "Zahlung erfassen", exact: true }),
      ).toHaveCount(0);
      await expect(
        member.getByRole("dialog", { name: "Zahlungseingänge", exact: true }),
      ).toHaveCount(0);
      await selectAccess(
        page,
        documentAccess(access),
        "Rechnungswerte",
        "Lesen",
      );
      await saveOfferAccess(access, publicationTimeout);
      await member.goto(`${memberServer.origin}${invoicePath}`);
      await expect(member.locator(".gaeb-editor")).toBeVisible({
        timeout: 60_000,
      });
      const view = member.getByRole("button", {
        name: "Zahlungen ansehen",
        exact: true,
      });
      await expect(view).toBeEnabled();
      await view.click();
      payments = member.getByRole("dialog", {
        name: "Zahlungseingänge",
        exact: true,
      });
      await expect(
        payments.getByText(paymentReference, { exact: false }),
      ).toBeVisible();
      await expect(payments.getByLabel(/^Betrag/)).toBeDisabled();
      await expect(
        payments.getByRole("button", { name: "Zahlung erfassen", exact: true }),
      ).toBeDisabled();
      await member.screenshot({
        path: join(artifacts, "member-invoice-readonly-payments.png"),
        fullPage: true,
      });
      memberAudit.assertClean();
    } finally {
      await member
        .screenshot({
          path: join(artifacts, "member-billing-final.png"),
          fullPage: true,
        })
        .catch(() => {});
      await memberContext.tracing.stop({
        path: join(artifacts, "member-billing.zip"),
      });
      await memberContext.close();
      await memberServer.close();
    }
  });
  await scenario("gaeb-editing-between-users", async (page) => {
    const memberServer = await applicationServer(
      applicationBuild,
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
      await changeProjectTitleBeforePublication(
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
      await member.goto(`${memberServer.origin}${path}`);
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
      await member.getByRole("tab", { name: "Einfügen", exact: true }).click();
      await expect(member.getByRole("button", { name: "Teilentwurf öffnen" })).toHaveCount(0);
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
  await scenario("gaeb-position-paragraphs-between-users", async (page) => {
    const memberServer = await applicationServer(applicationBuild, endpoints[0]);
    servers.add(memberServer);
    const memberContext = await applicationContext();
    const member = await memberContext.newPage();
    const memberAudit = auditPage(member);
    await memberContext.tracing.start({ screenshots: true, snapshots: true });
    const title = "Gemeinsam bearbeiteter Leistungsumfang";
    const customerName = "Nürnberger Wohnbau GmbH";
    const caseLoadTimeout = 60_000;
    try {
      await login(page, "john.doe");
      await expect(
        page.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await page.goto(`${server.origin}/offers`);
      await expect(
        page.getByRole("region", { name: "Angebotsübersicht", exact: true }),
      ).toHaveAttribute("aria-busy", "false", { timeout: caseLoadTimeout });
      await page
        .getByRole("main")
        .getByRole("button", { name: "Angebot erstellen", exact: true })
        .click();
      const creation = page.getByRole("dialog", { name: "Angebot erstellen" });
      await creation.getByRole("textbox", { name: /^Bezeichnung/ }).fill(title);
      await creation.getByRole("combobox", { name: /^Kunde/ }).fill(customerName);
      await page.getByRole("option", { name: customerName, exact: true }).click();
      await creation
        .getByRole("button", { name: "Angebot erstellen", exact: true })
        .click();
      const editor = page.locator(".gaeb-editor");
      await expect(editor).toBeVisible({ timeout: caseLoadTimeout });
      const path = new URL(page.url()).pathname;
      assert.match(path, /^\/gaeb\/[1-9a-v][0-9a-v]{0,12}$/);
      await editor.getByRole("tab", { name: "Einfügen", exact: true }).click();
      await editor
        .getByRole("button", { name: "Position hinzufügen", exact: true })
        .click();
      const first = editor.locator(
        '[data-gaeb-field^="item-"][data-gaeb-field$=":text:0"]',
      );
      await expect(first).toBeEnabled();
      const firstKey = await first.getAttribute("data-gaeb-field");
      assert.ok(firstKey);
      await first.focus();
      await editor.getByRole("tab", { name: "Start", exact: true }).click();
      await editor
        .getByRole("button", { name: "Absatz hinzufügen", exact: true })
        .click();
      await expect(first).toHaveAttribute("aria-description", /\n$/);
      const firstParagraph = "Oberfläche vorbereiten.";
      const secondParagraph = "Untergrund prüfen.";
      const initialText = `${firstParagraph}\n${secondParagraph}`;
      await changeGaebText(page, firstKey, initialText);
      await expect(editor).toHaveAttribute("data-save-state", "saved", {
        timeout: caseLoadTimeout,
      });

      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(
        member.getByRole("link", { name: "Einstellungen", exact: true }),
      ).toBeVisible();
      await member.goto(`${memberServer.origin}${path}`);
      await expect(
        member.getByText("Vorgang nicht geladen", { exact: true }),
      ).toBeVisible({ timeout: caseLoadTimeout });

      const access = await selectOfferAccess(page, title, {
        timeout: caseLoadTimeout,
      });
      await selectAccess(page, access, "Bezeichnung und Status", "Lesen");
      await selectAccess(
        page,
        access,
        "Leistungsbeschreibungen",
        "Lesen und bearbeiten",
      );
      await selectAccess(page, access, "Vertragsmengen", "Lesen");
      await saveOfferAccess(access, caseLoadTimeout);
      await page.goto(`${server.origin}${path}`);
      for (const browserPage of [page, member]) {
        await expect(browserPage.locator(".gaeb-editor")).toHaveAttribute(
          "data-connection-state",
          "online",
          { timeout: caseLoadTimeout },
        );
      }
      const quantity = member.locator('[data-gaeb-field$=":Qty"]');
      await expect(quantity).toBeDisabled();
      await member
        .getByRole("tab", { name: "Einfügen", exact: true })
        .click();
      await expect(
        member.getByRole("button", { name: "Position hinzufügen", exact: true }),
      ).toBeDisabled();
      const firstAddition = "Altanstrich und lose Beschichtungen entfernen. ";
      const secondAddition = " Fensterbänke und angrenzende Bauteile abdecken.";
      const agreedText = firstAddition + initialText + secondAddition;
      const editors = [page, member];
      async function insertText(browserPage, position, text, expected) {
        const field = gaebField(browserPage, firstKey);
        await expect(field).toHaveAttribute("aria-description", initialText);
        await field.focus();
        const input = browserPage.locator("textarea.gaeb-canvas-input");
        await input.press(position);
        await browserPage.keyboard.insertText(text);
        await input.press("Tab");
        await expect(field).toHaveAttribute("aria-description", expected);
      }
      const mergeParagraphs = async () => {
        await deferGaebRequests(
          editors,
          "zerotrust.documents.messages.post",
          (input) => input?.kind === "update",
          async () => {
            await Promise.all([
              insertText(
                page,
                "Control+Home",
                firstAddition,
                firstAddition + initialText,
              ),
              insertText(
                member,
                "Control+End",
                secondAddition,
                initialText + secondAddition,
              ),
            ]);
          },
        );
        await Promise.all(
          editors.map((browserPage) =>
            expect(gaebField(browserPage, firstKey)).toHaveAttribute(
              "aria-description",
              agreedText,
            ),
          ),
        );
      };
      await shareTextBeforePublication(
        editors,
        mergeParagraphs,
        caseLoadTimeout,
      );
      await member.reload();
      await expect(gaebField(member, firstKey)).toHaveAttribute(
        "aria-description",
        agreedText,
        { timeout: caseLoadTimeout },
      );
      await expect(quantity).toBeDisabled();
      const received = page.waitForEvent("download", {
        timeout: caseLoadTimeout,
      });
      await page
        .getByRole("button", { name: "Herunterladen", exact: true })
        .click();
      const download = await received;
      assert.match(download.suggestedFilename(), /\.x83$/i);
      const xml = await readFile(await download.path(), "utf8");
      const detail = /<DetailTxt><Text>([\s\S]*?)<\/Text><\/DetailTxt>/.exec(
        xml,
      )?.[1];
      assert.ok(detail);
      const paragraphs = [...detail.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map(
        ([, content]) => content.replace(/<[^>]+>/g, ""),
      );
      assert.deepEqual(paragraphs, [
        firstAddition + firstParagraph,
        secondParagraph + secondAddition,
      ]);
      assert.match(xml, /<Qty>0(?:\.0+)?<\/Qty>/);

      const additionalText =
        " Kanten mit Abdeckband schützen und anschließend reinigen.".repeat(
          1400,
        );
      const longText = agreedText + additionalText;
      let updatePackets = 0;
      const countUpdates = (request) => {
        if (
          request.method() !== "POST" ||
          !new URL(request.url()).pathname.includes(
            "zerotrust.documents.messages.post",
          )
        )
          return;
        updatePackets += Object.values(request.postDataJSON()).filter(
          (entry) => entry?.json?.kind === "update",
        ).length;
      };
      const receivedLongText = () =>
        expect
          .poll(
            async () =>
              (await gaebField(member, firstKey).getAttribute(
                "aria-description",
              )) === longText,
            { timeout: caseLoadTimeout },
          )
          .toBe(true);
      page.on("request", countUpdates);
      try {
        await shareTextBeforePublication(
          editors,
          async () => {
            await changeGaebText(page, firstKey, longText);
            await receivedLongText();
            assert.ok(updatePackets > 1);
          },
          caseLoadTimeout,
        );
      } finally {
        page.off("request", countUpdates);
      }
      const cursors = [];
      const watchScope = (request) => {
        const page = rpcInput(request, "zerotrust.documents.messages.read");
        const batch = rpcInput(request, "zerotrust.documents.messages.pages");
        for (const selection of page ? [page] : (batch?.selections ?? [])) {
          if (selection.room?.facet === "scope") cursors.push(selection.after);
        }
      };
      member.on("request", watchScope);
      try {
        await member.reload();
        await receivedLongText();
        await expect(member.locator(".gaeb-editor")).toHaveAttribute(
          "data-connection-state",
          "online",
          { timeout: caseLoadTimeout },
        );
        assert.ok(cursors.length > 0);
        assert.ok(
          BigInt(cursors[0]) > 0n,
          "The cold editor must start after its verified replay checkpoint",
        );
      } finally {
        member.off("request", watchScope);
      }

      const continued = longText + " Der Untergrund ist jetzt vorbereitet.";
      await shareTextBeforePublication(
        editors,
        async () => {
          await changeGaebText(page, firstKey, continued);
          await expect
            .poll(
              async () =>
                (await gaebField(member, firstKey).getAttribute(
                  "aria-description",
                )) === continued,
              { timeout: caseLoadTimeout },
            )
            .toBe(true);
        },
        caseLoadTimeout,
      );
      memberAudit.assertClean();
    } finally {
      await memberContext.tracing.stop({
        path: join(artifacts, "member-gaeb-paragraphs.zip"),
      });
      await memberContext.close();
      await memberServer.close();
    }
  });
  await scenario("grant-and-revoke-across-api-instances", async (page) => {
    const memberServer = await applicationServer(
      applicationBuild,
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
      await member.keyboard.press("Control+k");
      const palette = member.getByRole("dialog", { name: "Befehlspalette" });
      const search = palette.getByRole("searchbox", { name: "Befehl oder Suche" });
      const result = palette.getByRole("option", { name: /Haftgrund, manuell angepasst/ });
      await search.fill("haftgrund");
      await expect(result).toBeVisible();
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
      await expect(palette).toBeHidden();
      await expect(result).toHaveCount(0);
      await member.keyboard.press("Control+k");
      await search.fill("haftgrund");
      await expect(palette.getByText("Keine Treffer.", { exact: true }))
        .toBeVisible();
      await expect(result).toHaveCount(0);
      await palette.getByText("Schließen", { exact: true }).click();
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
    "office-and-purchasing-roles",
    async (page) => {
      let invitationReads = 0;
      page.on("request", (request) => {
        invitationReads += rpcInputs(request, "zerotrust.invitations.list").length;
      });
      const memberServer = await applicationServer(applicationBuild, endpoints[0]);
      servers.add(memberServer);
      const memberContext = await applicationContext();
      const member = await memberContext.newPage();
      const memberAudit = auditPage(member);
      try {
        await login(member, "frank.doe", "123456", memberServer.origin);
        await expect(member.getByRole("link", { name: "Einstellungen" })).toBeVisible();
        await member.goto(`${memberServer.origin}/products`);
        const product = member.getByText("Haftgrund, manuell angepasst", { exact: true });
        const vendors = member.getByRole("tab", { name: "Händler", exact: true });
        const customers = member.locator('nav a[href="/customers"]');
        await expect(product).toHaveCount(0);
        await expect(customers).toHaveCount(0);

        await login(page, "john.doe");
        await expect(
          page.getByRole("link", { name: "Einstellungen", exact: true }),
        ).toBeVisible();
        const dialog = await openMemberPermissions(page);
        const mountedDialog = await dialog.elementHandle();
        const roles = dialog.getByRole("group", { name: "Fachrollen", exact: true });
        const office = roles.getByRole("checkbox", { name: /^Büro/ });
        const purchasing = roles.getByRole("checkbox", { name: /^Einkauf/ });
        const save = async () => {
          const previousReads = invitationReads;
          await saveResourceAccess(
            dialog,
            "Berechtigungen speichern",
            "Produktkatalog",
            60_000,
          );
          assert.equal(invitationReads, previousReads);
          assert.equal(await mountedDialog.evaluate((node) => node.isConnected), true);
        };

        await expect(office).not.toBeChecked();
        await expect(purchasing).not.toBeChecked();
        await office.press("Space");
        await expect(office).toBeChecked();
        await save();
        await expect(product).toBeVisible();
        await expect(customers).toHaveCount(1);
        await expect(vendors).toHaveCount(0);

        await purchasing.press("Space");
        await expect(purchasing).toBeChecked();
        await save();
        await expect(vendors).toBeVisible();
        await expect(office).toBeChecked();

        await purchasing.press("Space");
        await expect(purchasing).not.toBeChecked();
        await save();
        await expect(vendors).toHaveCount(0);
        await expect(product).toBeVisible();

        await selectAccess(page, dialog, "Produktkatalog", "Kein Zugriff");
        await save();
        await expect(product).toHaveCount(0);
        await expect(office).toBeChecked();
        await expect(customers).toHaveCount(1);
        await office.press("Space");
        await expect(office).not.toBeChecked();
        await save();
        await expect(customers).toHaveCount(0);
        await mountedDialog.dispose();
        memberAudit.assertClean();
      } finally {
        await memberContext.close();
        await memberServer.close();
      }
    },
  );
  await scenario(
    "default-supervisor-controls-approval-across-instances",
    async (page) => {
      const memberServer = await applicationServer(
        applicationBuild,
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
    await page.evaluate(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: undefined,
      });
    });
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
    if (process.env.SORTSYS_E2E_STREAMED_BACKUP === "1") {
      const suggestedName = file.suggestedFilename();
      await page.evaluate(() => {
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          async value({ suggestedName }) {
            if (!navigator.userActivation.isActive) {
              throw new Error("Backup picker must open from a user gesture");
            }
            const directory = await navigator.storage.getDirectory();
            return directory.getFileHandle(suggestedName, { create: true });
          },
        });
      });
      await download.click();
      const digest = createHash("sha256").update(bytes).digest("hex");
      await expect
        .poll(() => page.evaluate(async (name) => {
          try {
            const directory = await navigator.storage.getDirectory();
            const handle = await directory.getFileHandle(name);
            const file = await handle.getFile();
            const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
            return [...new Uint8Array(hash)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
          } catch {
            return null;
          }
        }, suggestedName))
        .toBe(digest);
      console.log("Chromium saved the authenticated stream byte-for-byte.");
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
  await scenario("project-deletion-closes-open-attachment", async (page) => {
    // The final scenario removes a seeded project in this disposable tenant.
    const projectTitle = "Fenstersanierung Pirckheimer-Gymnasium";
    const fileName = "Lageplan für Löschtest 479561.pdf";
    const project = seeded.projectId;
    const projectPath = "/projects/" + project;
    const filesPath = projectPath + "/files";
    await login(page, "john.doe");
    await expect(page.getByRole("link", { name: "Einstellungen", exact: true })).toBeVisible();
    await page.goto(server.origin + filesPath);
    const pdf = await readFile(new URL(
      "../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf",
      import.meta.url,
    ));
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "application/pdf",
      buffer: pdf,
    });
    await expect(page.getByRole("button", { name: fileName, exact: true })).toBeVisible();

    const permissions = await openMemberPermissions(page);
    const access = permissions.getByRole("heading", { name: "Projektzugriff" })
      .locator("xpath=ancestor::section[1]");
    await access.getByRole("combobox", { name: "Projekt", exact: true }).fill(projectTitle);
    await page.getByRole("option", { name: projectTitle, exact: true }).click();
    await selectAccess(page, access, "Projektgrunddaten", "Lesen");
    await selectAccess(page, access, "Projektdateien", "Lesen");
    await saveResourceAccess(access, "Projektzugriff speichern", "Projektdateien", 60_000);

    const memberServer = await applicationServer(applicationBuild, endpoints[0]);
    servers.add(memberServer);
    const memberContext = await applicationContext();
    const member = await memberContext.newPage();
    const audit = auditPage(member);
    const release = Promise.withResolvers();
    const committed = Promise.withResolvers();
    try {
      await login(member, "frank.doe", "123456", memberServer.origin);
      await expect(member.getByRole("link", { name: "Einstellungen", exact: true })).toBeVisible();
      await member.goto(memberServer.origin + filesPath);
      await member.getByRole("button", { name: fileName, exact: true }).click();
      const preview = member.getByRole("dialog", { name: "PDF ansehen" });
      await expect(preview).toBeVisible();
      const attachmentUrl = member.url();

      await page.goto(server.origin + projectPath);
      await page.getByRole("button", { name: "Aktionen", exact: true }).click();
      await page.getByRole("menuitem", { name: "Löschen", exact: true }).click();
      const deleting = page.getByRole("dialog", { name: "Projekt löschen" });
      const confirmation = deleting.getByRole("checkbox");
      await confirmation.press("Space");
      await expect(confirmation).toBeChecked();
      await page.route("**/api/v2/**", async (route) => {
        const deletesProject = rpcInputs(route.request(), "zerotrust.objects.batch")
          .some((input) => input?.objects?.some(({ envelope }) =>
            envelope.object === `project:${project}` &&
            envelope.format === "sortsys-object-tombstone-v1",
          ));
        if (!deletesProject) return route.continue();
        const response = await route.fetch();
        committed.resolve(await response.json());
        await release.promise;
        await route.fulfill({ response });
      });
      await deleting.getByRole("button", { name: "Löschen", exact: true }).click();
      await expect(preview).toBeHidden({ timeout: 40_000 });
      const result = await committed.promise;
      assert.ok(result.some((reply) => reply.result?.data?.json?.success === true));
      const readBack = page.waitForResponse(
        (response) => response.ok() &&
          rpcInputs(response.request(), "zerotrust.objects.get")
            .some((input) => input?.id === `project:${project}`),
      );
      release.resolve();
      await readBack;
      await expect(deleting).toBeHidden();
      await expect(page).toHaveURL(new URL("/projects", server.origin).href);
      await member.goto(attachmentUrl);
      await expect(member.getByRole("heading", { name: "404", exact: true })).toBeVisible();
      await expect(preview).toBeHidden();
      await expect(page.getByText(projectTitle, { exact: true })).toHaveCount(0);
      audit.assertClean();
    } finally {
      release.resolve();
      await memberContext.close();
      await memberServer.close();
    }
  });
  assert.ok(results.length > 0, "The selected browser scenario must exist");
  for (const name of selectedScenarios) {
    assert.ok(
      results.some((result) => result.name === name),
      `Unknown browser scenario: ${name}`,
    );
  }
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify({ results }, null, 2),
  );
  console.log(`Browser artifacts: ${artifacts}`);
} finally {
  await close();
}
