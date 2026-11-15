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
  const plaintextLeaks = [];
  const unsupportedOperations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.startsWith("/api/v2/")) return;
    const body = request.postData() ?? "";
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
      "Antrag vor Standardfreigabe",
      "Antrag mit Standardfreigabe",
    ]) {
      if (body.includes(marker)) plaintextLeaks.push(marker);
    }
  });
  return {
    errors,
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
      await page.goto(`${server.origin}/users`);
      await page.getByText("Frank", { exact: true }).click();
      await page
        .getByRole("main")
        .getByRole("button", { name: "Aktionen", exact: true })
        .click();
      await page
        .getByRole("menuitem", {
          name: "Berechtigungen verwalten",
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Berechtigungen verwalten",
        exact: true,
      });
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
