import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [firstApi, secondApi] = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS,
);
assert.notEqual(firstApi, secondApi);
const tenant = process.env.SORTSYS_SIGNING_E2E_TENANT;
const member = "dialog.member";
const previousPassword = process.env.SORTSYS_SIGNING_E2E_PASSWORD;
const renewedPassword = process.env.SORTSYS_SIGNING_E2E_RENEWED;
const operator = process.env.SORTSYS_SIGNING_E2E_ADMIN;
const operatorPassword = process.env.SORTSYS_SIGNING_E2E_ADMIN_PASSWORD;
assert.ok(
  tenant && previousPassword && renewedPassword && operator && operatorPassword,
);

const directory = join(process.argv[2], "browser-artifacts", "signing-renewal");
await mkdir(directory, { recursive: true });
const assets = new URL("../../build/client", import.meta.url).pathname;
const sites = [];
let browser;
const expect = playwrightExpect.configure({ timeout: 25_000 });
const errors = [];
const submissions = [];

async function login(site, path, username, password) {
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v2/")) {
      submissions.push(
        decodeURIComponent(url.search) + (request.postData() ?? ""),
      );
    }
  });
  await page.goto(site.origin + path);
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${username}@${tenant}`);
  await page.getByLabel(/^Passwort/).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  await page.goto(site.origin + path);
  return { context, page };
}

try {
  for (const endpoint of [firstApi, secondApi]) {
    sites.push(await applicationServer(assets, endpoint));
  }
  browser = await chromium.launch({
    executablePath: process.env.SORTSYS_E2E_CHROMIUM,
  });
  const [adminSite, memberSite] = sites;
  const start = await login(memberSite, "/settings", member, previousPassword);
  await start.page
    .getByText("Signaturschlüssel erneuern", { exact: true })
    .click();
  await start.page
    .getByRole("button", { name: "Anfrage erstellen", exact: true })
    .click();
  const requestField = start.page.getByRole("textbox", { name: "Anfragecode" });
  await expect(requestField).toBeVisible();
  const request = await requestField.inputValue();
  await start.context.close();

  const admin = await login(
    adminSite,
    "/admin?tab=security",
    operator,
    operatorPassword,
  );
  await admin.page
    .getByText("Signaturwechsel bestätigen", { exact: true })
    .click();
  const adminInput = admin.page.getByRole("textbox", { name: "Anfragecode" });
  const review = admin.page.getByRole("button", {
    name: "Anfrage prüfen",
    exact: true,
  });
  const confirm = admin.page.getByRole("button", {
    name: "Wechsel bestätigen",
    exact: true,
  });
  await adminInput.fill("{}");
  await review.click();
  await expect(
    admin.page.getByText("Die Anfrage ist ungültig oder nicht mehr aktuell."),
  ).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await adminInput.fill(request);
  await review.click();
  await expect(confirm).toBeEnabled();
  await expect(
    confirm.locator("..").getByText(member, { exact: true }),
  ).toBeVisible();
  await confirm.click();
  const approvalField = admin.page.getByRole("textbox", {
    name: "Bestätigungscode",
  });
  await expect(approvalField).toBeVisible();
  const approval = await approvalField.inputValue();
  await admin.context.close();

  const finish = await login(memberSite, "/settings", member, previousPassword);
  await finish.page
    .getByText("Signaturschlüssel erneuern", { exact: true })
    .click();
  const renewal = finish.page.locator("details", {
    has: finish.page.getByText("Signaturschlüssel erneuern", { exact: true }),
  });
  await renewal
    .getByRole("textbox", { name: "Bestätigungscode" })
    .fill(approval);
  await renewal.locator('[name="renewalPassword"]').fill(renewedPassword);
  await renewal.locator('[name="renewalConfirmation"]').fill(renewedPassword);
  await renewal
    .getByRole("button", { name: "Schlüssel erneuern", exact: true })
    .click();
  await expect(
    finish.page.getByText("Signaturschlüssel erneuert", { exact: true }),
  ).toBeVisible();
  await finish.context.close();

  const next = await login(memberSite, "/settings", member, renewedPassword);
  await expect(
    next.page.getByText("Signaturschlüssel erneuern", { exact: true }),
  ).toBeVisible();
  await next.context.close();
  assert.deepEqual(errors, []);
  for (const marker of [
    previousPassword,
    renewedPassword,
    operatorPassword,
    JSON.parse(request).sealedSeed,
  ]) {
    assert.equal(
      submissions.some((request) => request.includes(marker)),
      false,
    );
  }
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify({
      success: true,
      forgedRequestRejected: true,
      separateApiOrigins: true,
      resumedInNewBrowserContext: true,
      renewedLogin: true,
    }),
  );
} finally {
  await browser?.close();
  for (const site of sites) await site.close();
}
