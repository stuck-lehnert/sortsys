import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;
const expect = playwrightExpect.configure({ timeout: 5000 });
before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function exercise(operation) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const external = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  try {
    await page.goto(`${server.origin}/crypto.html`);
    await page.waitForFunction(() => window.cryptoFixture);
    await page.evaluate(() => window.cryptoFixture.showModalAccess());
    await operation(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
}

test("data revocation removes open dialog fields and rejects retained handles while new handles work", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", { name: "Dialog öffnen", exact: true })
      .click();
    const field = page.getByRole("textbox", {
      name: "Vertraulicher Entwurf",
      exact: true,
    });
    await field.fill("Privater geänderter Entwurf 927845");
    await page.evaluate(() => window.cryptoFixture.modalAccess.grant());
    await expect(field).toHaveValue("Privater geänderter Entwurf 927845");
    await page.evaluate(() => window.cryptoFixture.modalAccess.revoke());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(field).toHaveCount(0);
    await page.evaluate(() => window.cryptoFixture.modalAccess.staleDialogs());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    assert.equal(new URL(page.url()).pathname, "/crypto.html");
    assert.equal(
      (await page.locator("body").textContent()).includes("927845"),
      false,
    );
    await page
      .getByRole("button", { name: "Dialog öffnen", exact: true })
      .click();
    await expect(field).toHaveValue("Vertraulicher Entwurf 782169");
  });
});

test("a pending form submission cannot reopen private content after data revocation", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", { name: "Formular öffnen", exact: true })
      .click();
    const field = page.getByRole("textbox", {
      name: "Vertrauliches Formular",
      exact: true,
    });
    await field.fill("Privater Formularwert 927845");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(
      () => window.cryptoFixture.modalAccess.state().submitted,
    );
    await page.evaluate(() => window.cryptoFixture.modalAccess.revoke());
    await expect(field).toHaveCount(0);
    await page.evaluate(() => window.cryptoFixture.modalAccess.release());
    await page.waitForFunction(
      () => window.cryptoFixture.modalAccess.state().completed,
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /782169|927845/ }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Dialogseite", { exact: true })).toHaveText(
      "/",
    );
  });
});

test("a current form submission may open its completion dialog and navigate normally", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", { name: "Formular öffnen", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Vertrauliches Formular", exact: true })
      .fill("Privater Formularwert 927845");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(
      () => window.cryptoFixture.modalAccess.state().submitted,
    );
    await page.evaluate(() => window.cryptoFixture.modalAccess.release());
    await page.waitForFunction(
      () => window.cryptoFixture.modalAccess.state().completed,
    );
    await expect(
      page.getByRole("heading", {
        name: "Vertraulicher Dialog 782169",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Dialogseite", { exact: true })).toHaveText(
      "/private-completion",
    );
  });
});

test("a retained form submit callback cannot start an action after its context expired", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", { name: "Formular öffnen", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Vertrauliches Formular", exact: true })
      .fill("Privater Formularwert 927845");
    await page.evaluate(() => window.cryptoFixture.modalAccess.revoke());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(() => window.cryptoFixture.modalAccess.submit());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page.evaluate(
        () => window.cryptoFixture.modalAccess.state().submitted,
      ),
      false,
    );
  });
});

test("a raw dialog cannot change the document address after its context was revoked", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", { name: "Rohdialog öffnen", exact: true })
      .click();
    await expect(
      page.getByText("Rohdialog 618273", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.cryptoFixture.modalAccess.revoke());
    await expect(
      page.getByText("Rohdialog 618273", { exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => window.cryptoFixture.modalAccess.staleLocation());
    assert.equal(new URL(page.url()).pathname, "/crypto.html");
  });
});

test("revocation closes a tracked document address without asking its stale close guard", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", { name: "Dokumentadresse öffnen", exact: true })
      .click();
    await expect(page).toHaveURL(`${server.origin}/gaeb/protected`);
    await page.evaluate(() => window.cryptoFixture.modalAccess.revoke());
    await expect(page).toHaveURL(`${server.origin}/crypto.html`);
    await page.evaluate(() => window.cryptoFixture.modalAccess.staleLocation());
    await expect(page).toHaveURL(`${server.origin}/crypto.html`);
    assert.equal(
      await page.evaluate(
        () => window.cryptoFixture.modalAccess.state().requestedClose,
      ),
      0,
    );
  });
});

test("revocation unwinds every expired document address in a nested dialog stack", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", {
        name: "Verschachtelte Dokumentadressen öffnen",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(`${server.origin}/gaeb/child`);
    await page.evaluate(() => window.cryptoFixture.modalAccess.revoke());
    await expect(page).toHaveURL(`${server.origin}/crypto.html`);
    assert.equal(
      await page.evaluate(
        () => window.cryptoFixture.modalAccess.state().requestedClose,
      ),
      0,
    );
  });
});

test("a queued dialog replacement is discarded when its data context expires", async () => {
  await exercise(async (page) => {
    await page
      .getByRole("button", { name: "Dialog öffnen", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Vertraulicher Entwurf", exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.cryptoFixture.modalAccess.replaceThenRevoke(),
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    assert.equal(
      (await page.locator("body").textContent()).includes("782169"),
      false,
    );
  });
});
