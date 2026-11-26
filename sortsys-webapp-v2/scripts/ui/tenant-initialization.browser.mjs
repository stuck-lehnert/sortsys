import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;
before(async () => {
  server = await createFixtureServer();
  try {
    browser = await chromium.launch({
      executablePath: process.env.SORTSYS_E2E_CHROMIUM,
    });
  } catch (error) {
    await server.close();
    throw error;
  }
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const locale of ["de", "en"]) {
  test(`a direct business URL stays blocked until signed tenant setup is complete (${locale})`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/crypto.html`);
      await page.waitForFunction(() => window.cryptoFixture);
      await page.evaluate(
        (options) => window.cryptoFixture.showTenantInitialization(options),
        { locale },
      );
      await page
        .getByText(
          locale === "de"
            ? "Die Organisation wird noch eingerichtet. Der Zugang wird anschließend freigegeben."
            : "The organization is still being set up. Access will be available afterwards.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await page
          .getByRole("heading", { name: "Arbeitsbereich bereit" })
          .count(),
        0,
      );
      assert.equal(
        await page.evaluate(() =>
          window.cryptoFixture.tenantInitializationMounts(),
        ),
        0,
      );
      await page.evaluate(() =>
        window.cryptoFixture.publishTenantInitialization(),
      );
      await page
        .getByRole("heading", { name: "Arbeitsbereich bereit" })
        .waitFor();
    } finally {
      await context.close();
    }
  });
}

test("an invalid readiness proof cannot open the workspace", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/crypto.html`);
    await page.waitForFunction(() => window.cryptoFixture);
    await page.evaluate(() =>
      window.cryptoFixture.showTenantInitialization({ invalid: true }),
    );
    await page
      .getByText(
        "Die Einrichtung konnte nicht abgeschlossen werden. Der bisherige Fortschritt bleibt erhalten.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.evaluate(() =>
        window.cryptoFixture.tenantInitializationMounts(),
      ),
      0,
    );
    await page.evaluate(() =>
      window.cryptoFixture.publishTenantInitialization(),
    );
    await page
      .getByRole("heading", { name: "Arbeitsbereich bereit" })
      .waitFor();
  } finally {
    await context.close();
  }
});

for (const operation of [
  "changeInitializationGeneration",
  "invalidateTenantInitialization",
]) {
  test(`an open workspace closes when its readiness changes: ${operation}`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/crypto.html`);
      await page.waitForFunction(() => window.cryptoFixture);
      await page.evaluate(() =>
        window.cryptoFixture.showTenantInitialization(),
      );
      await page.evaluate(() =>
        window.cryptoFixture.publishTenantInitialization(),
      );
      await page
        .getByRole("heading", { name: "Arbeitsbereich bereit" })
        .waitFor();
      await page.evaluate((name) => window.cryptoFixture[name](), operation);
      await page
        .getByRole("heading", { name: "Arbeitsbereich bereit" })
        .waitFor({ state: "hidden" });
      assert.equal(
        await page
          .getByRole("heading", { name: "Arbeitsbereich bereit" })
          .count(),
        0,
      );
    } finally {
      await context.close();
    }
  });
}
