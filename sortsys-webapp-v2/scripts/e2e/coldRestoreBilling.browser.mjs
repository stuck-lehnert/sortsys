import assert from "node:assert/strict";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

const env = process.env;
assert.equal(env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
assert.equal(env.SORTSYS_NATIVE_COLD_RESTORE_PHASE, "restored");
const endpoints = JSON.parse(env.SORTSYS_AUTH_TEST_ENDPOINTS);
const server = await applicationServer(
  env.SORTSYS_E2E_APPLICATION_BUILD ??
    new URL("../../build/client", import.meta.url).pathname,
  endpoints[1],
);
const expect = playwrightExpect.configure({ timeout: 25_000 });
let browser;
try {
  browser = await chromium.launch({ executablePath: env.SORTSYS_E2E_CHROMIUM });
  const page = await browser.newPage({
    locale: "de-DE",
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const leaked = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v2/")) return;
    const wire = decodeURIComponent(url.search) + (request.postData() ?? "");
    if (wire.includes(env.SORTSYS_COLD_BILLING_REFERENCE)) {
      leaked.push(url.pathname);
    }
  });

  await page.goto(server.origin + "/auth/login");
  await page.getByRole("textbox", { name: /^Nutzername/ }).fill(
    `${env.SORTSYS_COLD_BILLING_USER}@${env.SORTSYS_NATIVE_AUTH_TENANT}`,
  );
  await page.getByLabel(/^Passwort/).fill(env.SORTSYS_COLD_BILLING_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("link", { name: "Einstellungen", exact: true }))
    .toBeVisible();
  await page.goto(server.origin + `/gaeb/${env.SORTSYS_COLD_BILLING_CASE}`);
  await expect(page.locator("canvas").first()).toBeVisible();

  const payment = page.getByRole("button", { name: "Zahlungseingang", exact: true });
  await payment.click();
  const payments = page.getByRole("dialog", { name: "Zahlungseingänge" });
  await expect(payments.getByText(/Offener Betrag.*27,60/)).toBeVisible();
  await payments.getByLabel("Betrag (€)").fill(env.SORTSYS_COLD_BILLING_AMOUNT);
  await payments.getByLabel("Zahlungsdatum").fill(env.SORTSYS_COLD_BILLING_DATE);
  await payments.getByLabel("Verwendungszweck").fill(env.SORTSYS_COLD_BILLING_REFERENCE);
  await payments.getByRole("button", { name: "Zahlung erfassen", exact: true }).click();
  await expect(payments).toBeHidden();
  await page.getByRole("button", { name: "Zahlungen ansehen", exact: true }).click();
  await expect(payments.getByText(/Offener Betrag.*0,00/)).toBeVisible();
  await expect(payments.getByText(new RegExp(env.SORTSYS_COLD_BILLING_REFERENCE)))
    .toBeVisible();
  assert.deepEqual(errors, []);
  assert.deepEqual(leaked, []);
  console.log("Chromium recorded the remaining payment in the reopened tenant.");
} finally {
  await browser?.close();
  await server.close();
}
