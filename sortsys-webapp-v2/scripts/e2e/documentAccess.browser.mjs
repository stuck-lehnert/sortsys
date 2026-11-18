import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const fixture = JSON.parse(await readFile(process.argv[2], "utf8"));
const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS);
const server = await applicationServer(
  process.env.SORTSYS_E2E_APPLICATION_BUILD ??
    new URL("../../build/client", import.meta.url).pathname,
  endpoints[1],
);
const expect = playwrightExpect.configure({ timeout: 20_000 });
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.SORTSYS_E2E_CHROMIUM,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ locale: "de-DE" });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.origin}/auth/login`);
  await page.getByRole("textbox", { name: /^Nutzername/ }).fill(
    `document.reader@${fixture.tenant}`,
  );
  await page.getByLabel(/^Passwort/).fill(process.env.SORTSYS_E2E_READER_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("link", { name: "Einstellungen", exact: true }))
    .toBeVisible();
  await page.goto(`${server.origin}/documents?q=Suchfenster`);
  const hit = page.getByRole("link", { name: fixture.fileName, exact: true });
  await expect(hit).toBeVisible();
  await expect(page.locator(".documents-search__excerpt mark"))
    .toHaveText("Suchfenster");
  await expect(page.getByRole("link", { name: fixture.projectTitle, exact: true }))
    .toHaveCount(0);
  await hit.click();
  const target = `${server.origin}/projects/${fixture.projectId}/files/${fixture.fileId}`;
  await expect(page).toHaveURL(target);
  await expect(page.getByRole("heading", { name: "Projektanhänge", exact: true }))
    .toBeVisible();
  const pdf = page.frameLocator('iframe[title="PDF ansehen"]');
  await expect(pdf.locator('.page[data-page-number="1"] canvas')).toBeVisible();
  await page.reload();
  await expect(pdf.locator('.page[data-page-number="1"] canvas')).toBeVisible();
  await expect(page.getByText(fixture.projectTitle, { exact: true }))
    .toHaveCount(0);
  await page.goto(`${server.origin}/projects/${fixture.projectId}`);
  await expect(page.getByRole("heading", { name: "404", exact: true }))
    .toBeVisible();
  await page.goto(
    `${server.origin}/projects/${fixture.deniedProjectId}/files/${fixture.deniedFileId}`,
  );
  await expect(page.getByRole("heading", { name: "404", exact: true }))
    .toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("Chromium opened an authorized search result without project data and denied the other routes.");
} finally {
  await browser?.close();
  await server.close();
}
