import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

const environment = process.env;
assert.equal(environment.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [first, second] = JSON.parse(environment.SORTSYS_AUTH_TEST_ENDPOINTS);
assert.ok(first && second && first !== second);
const tenant = environment.SORTSYS_NATIVE_AUTH_TENANT;
const oldPhrase = environment.SORTSYS_RECOVERY_E2E_PHRASE;
const password = environment.SORTSYS_RECOVERY_E2E_PASSWORD;
const username = environment.SORTSYS_RECOVERY_E2E_USER;
assert.ok(tenant && oldPhrase && password && username);
const artifacts = join(
  environment.SORTSYS_NATIVE_AUTH_ROOT,
  "browser-artifacts",
  "seed-recovery",
);
await mkdir(artifacts, { recursive: true });
const server = await applicationServer(
  new URL("../../build/client", import.meta.url).pathname,
  first,
);
const expect = playwrightExpect.configure({ timeout: 20_000 });
let browser;
let phase = "startup";
let replacement = "";
const leaks = [];
const errors = [];
try {
  browser = await chromium.launch({
    executablePath: environment.SORTSYS_E2E_CHROMIUM,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  // Do not capture the phrase in screenshots, traces or debugging output.
  page.on("pageerror", () => errors.push(phase));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v2/")) return;
    const wire = (request.postData() ?? "") + decodeURIComponent(url.search);
    for (const secret of [oldPhrase, replacement, password]) {
      if (secret && wire.includes(secret)) leaks.push(url.pathname);
    }
  });

  phase = "recovery form";
  await page.goto(server.origin + "/auth/recovery");
  await page.getByRole("textbox", { name: /^Mandant/ }).fill(tenant);
  await page
    .getByRole("textbox", { name: /^Aktuelle Wiederherstellungsphrase/ })
    .fill(oldPhrase);
  await page.getByLabel(/^Neues Administratorpasswort/).fill(password);
  await page.getByLabel(/^Passwort wiederholen/).fill(password);
  await expect(
    page.getByRole("checkbox", { name: /^Vorhandenes Administratorkonto/ }),
  ).toBeChecked();
  await page
    .getByRole("button", {
      name: "Phrase prüfen und Wiederherstellung vorbereiten",
    })
    .click();

  phase = "replacement phrase backup";
  await expect(
    page.getByRole("heading", {
      name: "Neue Wiederherstellungsphrase sichern",
    }),
  ).toBeVisible();
  const words = page.locator(
    'ol[aria-label="Neue Wiederherstellungsphrase"] li span:last-child',
  );
  await expect(words).toHaveCount(24);
  const replacementWords = await words.allTextContents();
  replacement = replacementWords.join(" ");
  assert.ok(replacement !== oldPhrase);
  phase = "re-enter selected backup words";
  await page
    .getByRole("button", { name: "Sicherung prüfen", exact: true })
    .click();
  const checkWords = page.getByRole("textbox", { name: /^Wort \d+\b/ });
  await expect(checkWords).toHaveCount(3);
  for (const [index, word] of replacementWords.entries()) {
    const field = page.getByRole("textbox", {
      name: new RegExp(`^Wort ${index + 1}\\b`),
    });
    if (await field.count()) await field.fill(word);
  }
  phase = "confirm external backup";
  await page.getByText(/^Die vollständige Phrase/).click();
  await expect(
    page.getByRole("checkbox", { name: /^Die vollständige Phrase/ }),
  ).toBeChecked();
  phase = "publish recovery";
  await page
    .getByRole("button", { name: "Mit gesicherter Phrase fortfahren" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Mandant wiederhergestellt",
      exact: true,
    }),
  ).toBeVisible({
    timeout: 75_000,
  });
  await expect(
    page.getByText(`${username}@${tenant}`, { exact: true }),
  ).toBeVisible();

  phase = "sign in with replacement password";
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${username}@${tenant}`);
  await page.getByLabel(/^Passwort/).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  assert.deepEqual(leaks, []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify({
      success: true,
      retainedAdministrator: true,
      signedInWithNewPassword: true,
      errors,
      leaks,
    }),
  );
  process.stdout.write(JSON.stringify(replacement));
} catch {
  // Playwright failures during phrase entry can include input values.
  process.stderr.write(`Seed recovery browser case failed during ${phase}.\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
