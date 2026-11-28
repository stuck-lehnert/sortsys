import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "playwright/test";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;

before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch({
    executablePath: process.env.SORTSYS_E2E_CHROMIUM,
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function exercise(run, search = "") {
  const page = await browser.newPage({ timezoneId: "UTC" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === server.origin
      ? route.continue()
      : route.abort("blockedbyclient"),
  );

  try {
    await page.goto(`${server.origin}/crypto.html${search}`);
    await page.waitForFunction(() => window.cryptoFixture?.showOfferNumbering);
    await page.evaluate(() => window.cryptoFixture.showOfferNumbering());

    const tabs = page.getByRole("tablist", { name: "Organisationsverwaltung" });
    const company = tabs.getByRole("tab", { name: "Stammdaten", exact: true });
    const invoiceNumbers = tabs.getByRole("tab", {
      name: "Rechnungsnummern",
      exact: true,
    });
    const offerNumbers = tabs.getByRole("tab", {
      name: "Angebotsnummern",
      exact: true,
    });
    const start = page.getByRole("textbox", { name: "Globale Startnummer" });
    if (!search) {
      await expect(company).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("textbox", { name: "Firmenname" }))
        .toHaveValue("Ausbau Beispiel");

      await invoiceNumbers.click();
      await expect(invoiceNumbers).toHaveAttribute("aria-selected", "true");
      await expect(start).toHaveValue("12");

      await offerNumbers.click();
    }

    await expect(offerNumbers).toHaveAttribute("aria-selected", "true");
    await expect(start).toHaveValue("8");
    await run(page, start);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

for (const tab of ["offers", "offer-numbers"]) {
  test(`the ${tab} link opens only the offer numbering settings`, async () => {
    await exercise(async (page) => {
      const opened = await page.evaluate(
        () => window.cryptoFixture.offerNumbering.opened,
      );

      assert.deepEqual(opened, ["offerNumbering"]);
    }, `?tab=${tab}`);
  });
}

test("offer numbers use the three organization-wide schemes and keep exact starting values", async () => {
  await exercise(async (page, start) => {
    const scheme = page.getByRole("button", { name: /Angebotsnummer-Schema/ });
    await scheme.click();
    const choices = page.getByRole("listbox").getByRole("option");
    await expect(choices).toHaveText([
      "Global fortlaufend",
      "Datumsbasiert mit Trennzeichen",
      "Datumsbasiert kompakt",
    ]);
    await choices.last().click();
    await start.fill("9007199254741001");

    const examples = page.getByRole("status", {
      name: "Beispiel-Angebotsnummern",
    }).locator("code");
    await expect(examples.nth(0)).toHaveText(/^\d{6}9007199254741001$/);
    await expect(examples.nth(1)).toHaveText(/^\d{6}9007199254741002$/);

    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByText("Angebotsnummern gespeichert", { exact: true }))
      .toBeVisible();
    const saved = await page.evaluate(() => window.cryptoFixture.offerNumbering.saved());
    assert.deepEqual(saved, {
      scheme: "dateCompact",
      startNumber: "9007199254741001",
    });
  });
});

test("a stale offer setting cannot overwrite a newer starting value", async () => {
  await exercise(async (page, start) => {
    await start.fill("12");
    await page.evaluate(() => window.cryptoFixture.offerNumbering.saveAhead({
      scheme: "sequential",
      startNumber: "24",
    }));

    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    const reload = page.getByRole("button", { name: "Aktuellen Stand laden" });
    await expect(reload).toBeVisible();
    await expect(start).toHaveValue("12");
    await reload.click();
    await expect(start).toHaveValue("24");

    const saved = await page.evaluate(() => window.cryptoFixture.offerNumbering.saved());
    assert.deepEqual(saved, {
      scheme: "sequential",
      startNumber: "24",
    });
  });
});
