import assert from "node:assert/strict";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

const env = process.env;
assert.equal(env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints = JSON.parse(env.SORTSYS_AUTH_TEST_ENDPOINTS);
const backup = env.SORTSYS_ABSENCE_RESTORE_BACKUP;
assert.match(backup ?? "", /^[a-zA-Z0-9_-]+$/);

const server = await applicationServer(
  new URL("../../build/client", import.meta.url).pathname,
  endpoints[1],
);
const expect = playwrightExpect.configure({ timeout: 25_000 });
let browser;
try {
  browser = await chromium.launch({ executablePath: env.SORTSYS_E2E_CHROMIUM });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  let activations = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/zerotrust.content.activate")) {
      activations++;
    }
  });

  const backupsUrl = server.origin + "/admin?tab=backups";
  await page.goto(backupsUrl);
  const username = `${env.SORTSYS_ABSENCE_RESTORE_USER}@${env.SORTSYS_NATIVE_AUTH_TENANT}`;
  await page.getByRole("textbox", { name: /^Nutzername/ }).fill(username);
  await page.getByLabel(/^Passwort/).fill(env.SORTSYS_ABSENCE_RESTORE_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  await page.goto(backupsUrl);

  await page
    .locator(`button[aria-describedby="backup-date-${backup}"]`)
    .click();
  const dialog = page.getByRole("dialog", { name: "Sicherung wiederherstellen" });
  await expect(dialog.getByRole("alert")).toContainText(
    "In dieser Sicherung ist ein Abwesenheitsantrag ungültig oder eine Entscheidung passt nicht zum zugehörigen Antrag.",
  );
  await expect(
    dialog.getByRole("button", { name: "Fachdaten wiederherstellen" }),
  ).toHaveCount(0);
  assert.equal(activations, 0);
  console.log("Chromium blocked activation and showed the absence conflict.");
} finally {
  await browser?.close();
  await server.close();
}
