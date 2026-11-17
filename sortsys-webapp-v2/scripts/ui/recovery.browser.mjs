import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createFixtureServer } from "./browser-support.mjs";

let browser, server;
before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

test("recovery defaults to the existing administrator and requires an explicit choice when that account is unavailable", async () => {
  const context = await browser.newContext();
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${server.origin}/crypto.html`);
    await page.waitForFunction(() => window.cryptoFixture);
    const values = await page.evaluate(() =>
      window.cryptoFixture.showRecoveryPage(),
    );
    const existing = page.getByRole("checkbox", {
      name: "Vorhandenes Administratorkonto wiederherstellen",
    });
    await existing.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('input[name="restoreAdministrator"]')?.checked,
    );
    assert.equal(await existing.isChecked(), true);
    await page.getByLabel(/^Mandant/).fill(values.tenant);
    await page
      .getByLabel(/^Aktuelle Wiederherstellungsphrase/)
      .fill(values.phrase);
    await page
      .getByLabel(/^Neues Administratorpasswort/)
      .fill("Typed-recovery-test-password-2026!");
    await page
      .getByLabel(/^Passwort wiederholen/)
      .fill("Typed-recovery-test-password-2026!");
    await page
      .getByRole("button", {
        name: "Phrase prüfen und Wiederherstellung vorbereiten",
        exact: true,
      })
      .click();
    await page
      .getByText(
        "Das bisherige Administratorkonto kann nicht wiederhergestellt werden.",
        { exact: false },
      )
      .waitFor();
    assert.equal(await existing.isChecked(), true);
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.recoveryRequests()),
      [
        {
          path: "zerotrust.recovery.account",
          seedProofValid: true,
          secretUploaded: false,
        },
      ],
    );
    await existing.focus();
    await existing.press("Space");
    assert.equal(await existing.isChecked(), false);
    await page
      .getByRole("button", {
        name: "Phrase prüfen und Wiederherstellung vorbereiten",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Sicherung prüfen", exact: true })
      .waitFor();
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.recoveryRequests()))
        .length,
      1,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});
