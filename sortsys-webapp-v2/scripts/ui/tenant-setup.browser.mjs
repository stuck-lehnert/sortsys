import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;
before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(options = {}) {
  const context = await browser.newContext(options);
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${server.origin}/crypto.html`);
  await page.waitForFunction(() => window.cryptoFixture);
  return { context, page, external };
}

test("an incomplete setup link offers sign-in without opening the account form", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showTenantSetup({ invalid: true }),
    );
    await page
      .getByText("Der Einrichtungslink ist unvollständig.", { exact: false })
      .waitFor();
    assert.equal(await page.getByRole("textbox").count(), 0);
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.tenantSetupCalls()),
      [],
    );
    await page
      .getByRole("link", { name: "Zur Anmeldung", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Anmeldung", exact: true })
      .waitFor();
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

for (const width of [390, 1440]) {
  test(`first ownership waits for a verified recovery backup at ${width}px`, async () => {
    const { context, page, external } = await open({
      viewport: { width, height: 1000 },
    });
    try {
      await page.evaluate(() => window.cryptoFixture.showTenantSetup());
      await page
        .getByLabel("Nutzername", { exact: false })
        .fill("muster-admin");
      await page
        .getByLabel("Passwort festlegen", { exact: false })
        .fill("Only-in-the-browser-2026!");
      await page
        .getByLabel("Passwort wiederholen", { exact: false })
        .fill("different");
      await page.getByRole("button", { name: "Weiter", exact: true }).click();
      await page
        .getByText("Die Passwörter stimmen nicht überein.", { exact: true })
        .waitFor();
      assert.deepEqual(
        await page.evaluate(() => window.cryptoFixture.tenantSetupCalls()),
        [],
      );
      await page
        .getByLabel("Passwort wiederholen", { exact: false })
        .fill("Only-in-the-browser-2026!");
      await page.getByRole("button", { name: "Weiter", exact: true }).click();
      await page
        .getByRole("heading", { name: "Notfallzugang sichern", exact: true })
        .waitFor();
      const words = page.getByRole("list", {
        name: "Neue Wiederherstellungsphrase",
        exact: true,
      });
      assert.equal(await words.getByRole("listitem").count(), 24);
      assert.deepEqual(
        await page.evaluate(() =>
          window.cryptoFixture.tenantSetupCalls().map((call) => call.path),
        ),
        ["auth.owner.inspect"],
      );
      assert.equal(await page.locator('input[type="password"]').count(), 0);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      if (process.env.SORTSYS_UI_SCREENSHOT_DIRECTORY) {
        await mkdir(process.env.SORTSYS_UI_SCREENSHOT_DIRECTORY, {
          recursive: true,
        });
        await page.screenshot({
          path: `${process.env.SORTSYS_UI_SCREENSHOT_DIRECTORY}/tenant-setup-${width}.png`,
          fullPage: true,
        });
      }
      await page
        .getByRole("button", { name: "Sicherung prüfen", exact: true })
        .click();
      assert.equal(await page.getByRole("textbox").count(), 3);
      await page
        .getByRole("button", { name: "Wörter erneut anzeigen", exact: true })
        .click();
      await words.waitFor();
      assert.deepEqual(
        await page.evaluate(() =>
          window.cryptoFixture.tenantSetupCalls().map((call) => call.path),
        ),
        ["auth.owner.inspect"],
      );
      await page
        .getByRole("button", { name: "Abbrechen", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Organisation einrichten", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("list", {
            name: "Neue Wiederherstellungsphrase",
            exact: true,
          })
          .count(),
        0,
      );
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("a local SQL backup preserves the selected owner ID before registration", async () => {
  const { context, page, external } = await open();
  page.setDefaultTimeout(30000);
  try {
    await page.evaluate(() => window.cryptoFixture.showTenantSetup());
    const sql = await page.evaluate(() =>
      window.cryptoFixture.tenantBackupSql(),
    );
    await page
      .getByLabel("Vorhandene Sicherung übernehmen (optional)", { exact: true })
      .setInputFiles({
        name: "bestand.sql",
        mimeType: "application/sql",
        buffer: Buffer.from(sql),
      });
    await page
      .getByLabel("Bisheriges Benutzerkonto für den ersten Administrator", {
        exact: true,
      })
      .selectOption("2n");
    assert.equal(
      await page.getByLabel("Nutzername", { exact: false }).count(),
      0,
    );
    for (const label of ["Passwort festlegen", "Passwort wiederholen"])
      await page
        .getByLabel(label, { exact: false })
        .fill("Only-in-the-browser-2026!");
    await page.getByRole("button", { name: "Weiter", exact: true }).click();
    await page
      .getByRole("heading", { name: "Notfallzugang sichern", exact: true })
      .waitFor();
    const calls = await page.evaluate(() =>
      window.cryptoFixture.tenantSetupCalls(),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "auth.owner.inspect");
    assert.equal(calls[0].input.userId, "2n");
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("an unsupported local backup cannot consume a setup link", async () => {
  const { context, page, external } = await open();
  page.setDefaultTimeout(30000);
  try {
    await page.evaluate(() => window.cryptoFixture.showTenantSetup());
    const source = page.getByLabel(
      "Vorhandene Sicherung übernehmen (optional)",
      { exact: true },
    );
    await source.setInputFiles({
      name: "unknown.sql",
      mimeType: "application/sql",
      buffer: Buffer.from(
        "COPY public.unknown_business_table (id) FROM stdin;\n1\n\\.\n",
      ),
    });
    await page
      .getByText("Die Sicherung enthält eine unbekannte Geschäftstabelle.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Weiter", exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.tenantSetupCalls()),
      [],
    );
    await source.setInputFiles([]);
    await page.waitForFunction(
      () => !document.querySelector('button[type="submit"]').disabled,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

for (const kind of ["create", "renew"]) {
  test(`an interrupted ${kind} keeps its operation and secret after reloading`, async () => {
    const { context, page, external } = await open();
    const writes = [];
    try {
      await page.route(
        `${server.origin}/api/v2/admin.tenants.*`,
        async (route) => {
          const path = new URL(route.request().url()).pathname.replace(
            /^\/api\/v2/,
            "",
          );
          if (path === "/admin.tenants.list") {
            return route.fulfill({
              json: [{ result: { data: { json: [] } } }],
            });
          }
          const request = route.request().postDataJSON()["0"].json;
          writes.push({ path, request });
          await route.fulfill({
            json: [{ result: { data: { json: { name: request.name } } } }],
          });
        },
      );
      const pending = {
        name: "musterbetrieb",
        operation: "retry_same_operation",
        secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        confirmed: false,
        kind,
      };
      await page.evaluate((pending) => {
        sessionStorage.setItem(
          "sortsys.pending-tenant-setup",
          JSON.stringify(pending),
        );
      }, pending);
      await page.reload();
      await page.waitForFunction(() => window.cryptoFixture);
      await page.evaluate(() => window.cryptoFixture.showTenantAdmin());
      await page
        .getByRole("button", { name: "Vorgang fortsetzen", exact: true })
        .click();
      const link = page.getByRole("textbox", {
        name: "Einrichtungslink",
        exact: true,
      });
      await link.waitFor();
      const resumed = new URL(await link.inputValue());
      assert.equal(resumed.search, "");
      const encoded = new URLSearchParams(resumed.hash.slice(1)).get("setup");
      const capability = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      assert.equal(capability.tenant, pending.name);
      assert.equal(capability.secret, pending.secret);
      assert.equal(writes.length, 1);
      assert.equal(
        writes[0].path,
        kind === "renew" ? "/admin.tenants.setupLink" : "/admin.tenants.create",
      );
      assert.equal(writes[0].request.operation, pending.operation);
      const persisted = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("sortsys.pending-tenant-setup")),
      );
      assert.equal(persisted.confirmed, true);
      assert.equal(persisted.kind, kind);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}
