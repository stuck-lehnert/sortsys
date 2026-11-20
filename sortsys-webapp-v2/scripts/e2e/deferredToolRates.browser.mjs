import assert from "node:assert/strict";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

const env = process.env;
assert.equal(env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints = JSON.parse(env.SORTSYS_AUTH_TEST_ENDPOINTS);
const server = await applicationServer(
  new URL("../../build/client", import.meta.url).pathname,
  endpoints[1],
);
const expect = playwrightExpect.configure({ timeout: 25_000 });
let browser;
try {
  browser = await chromium.launch({ executablePath: env.SORTSYS_E2E_CHROMIUM });
  async function logIn(user, password) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      locale: "de-DE",
    });
    await page.goto(server.origin + "/auth/login");
    await page.getByRole("textbox", { name: /^Nutzername/ })
      .fill(`${user}@${env.SORTSYS_NATIVE_AUTH_TENANT}`);
    await page.getByLabel(/^Passwort/).fill(password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("link", { name: "Einstellungen", exact: true }))
      .toBeVisible();
    return page;
  }

  const admin = await logIn(env.SORTSYS_RATE_OWNER, env.SORTSYS_RATE_OWNER_PASSWORD);
  await admin.goto(server.origin + "/projects/costs");
  await expect(admin.getByText(/Für gebuchte Werkzeuge stehen noch Kostensätze aus/).first())
    .toBeVisible();
  await admin.goto(server.origin + `/projects/${env.SORTSYS_RATE_PROJECT}/costs`);
  await expect(admin.getByText(/46,88\s*€/).first()).toBeVisible();

  const booker = await logIn(env.SORTSYS_RATE_MEMBER, env.SORTSYS_RATE_MEMBER_PASSWORD);
  await booker.goto(server.origin + `/tools/${env.SORTSYS_RATE_TOOL}`);
  await expect(booker.getByRole("heading", { name: /Nordflügel/ })).toBeVisible();
  await expect(booker.getByText("gebucht", { exact: true })).toBeVisible();
  await expect(booker.getByText("Kaufpreis", { exact: true })).toHaveCount(0);
  await expect(booker.getByText(/14,13\s*€|32,75\s*€|103,25\s*€/)).toHaveCount(0);
  console.log("Chromium showed pending costs, then the historic total, and hid prices from the booker.");
} finally {
  await browser?.close();
  await server.close();
}
