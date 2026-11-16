import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;
before(async () => {
  server = await createFixtureServer();
  try {
    browser = await chromium.launch();
  } catch (error) {
    await server.close();
    server = undefined;
    throw error;
  }
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
});

async function open(options) {
  const context = await browser.newContext();
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`${server.origin}/crypto.html`);
    await page.waitForFunction(() => window.cryptoFixture);
    await page.evaluate(
      (options) => window.cryptoFixture.showAccountLanguage(options),
      options,
    );
    return { context, page, external };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function selectLanguage(page, label) {
  await page.getByRole("button", { name: /Sprache|Language/ }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

for (const [locale, theme] of [
  ["de", "light"],
  ["en", "dark"],
]) {
  test(`account language saves without private-profile access from ${locale} ${theme}`, async () => {
    const { context, page, external } = await open({ locale, theme });
    try {
      const target = locale === "de" ? "en" : "de";
      await selectLanguage(page, locale === "de" ? "Englisch" : "German");
      await page
        .getByRole("button", {
          name: locale === "de" ? "Speichern" : "Save",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        (locale) => document.documentElement.lang === locale,
        target,
      );
      await page
        .getByRole("button", { name: /Sprache|Language/ })
        .filter({ hasText: target === "en" ? "English" : "Deutsch" })
        .waitFor();
      const state = await page.evaluate(() =>
        window.cryptoFixture.languageState(),
      );
      assert.equal(state.locale, target);
      assert.deepEqual(
        state.calls
          .filter((call) => call.path === "settings.language.set")
          .map((call) => call.input),
        [{ locale: target }],
      );
      assert.equal(
        state.calls.some(
          (call) =>
            call.path === "zerotrust.keys.get" ||
            call.path.startsWith("zerotrust.objects.") ||
            call.path === "users.update",
        ),
        false,
      );
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      assert.deepEqual(
        accessibility.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
        [],
      );
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("failed account language writes retain the selection for retry", async () => {
  const { context, page } = await open({ fail: true });
  try {
    await selectLanguage(page, "Englisch");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page
      .getByText("Synthetic language write failed", { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.lang),
      "de",
    );
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.languageState())).locale,
      "de",
    );
    await page
      .getByRole("button", { name: /Sprache/ })
      .filter({ hasText: "Englisch" })
      .waitFor();
    await page.evaluate(() => window.cryptoFixture.allowLanguageSave());
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.lang === "en");
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.languageState())).locale,
      "en",
    );
  } finally {
    await context.close();
  }
});
