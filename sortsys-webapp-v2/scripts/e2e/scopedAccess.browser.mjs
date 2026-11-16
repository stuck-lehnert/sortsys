import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
assert.ok(root);
const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS);
assert.equal(endpoints.length, 2);
const tenant = process.env.SORTSYS_NATIVE_AUTH_TENANT;
assert.equal(tenant, "administration-tenant");
const artifacts = join(root, "browser-artifacts", "scoped-access");
await mkdir(artifacts, { recursive: true });
const directory = new URL("../../build/client", import.meta.url).pathname;
const ownerServer = await applicationServer(directory, endpoints[0]);
const managerServer = await applicationServer(directory, endpoints[1]);
const expect = playwrightExpect.configure({ timeout: 20_000 });
let browser;
const errors = [];
const leaks = [];
const contexts = [];
const pages = [];
async function close() {
  await browser?.close();
  await Promise.all([ownerServer.close(), managerServer.close()]);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

async function pageFor(name) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  contexts.push(context);
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const page = await context.newPage();
  pages.push({ page, name });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v2/")) return;
    const wire = (request.postData() ?? "") + decodeURIComponent(url.search);
    for (const secret of [
      "VERTRAULICHES_PRODUKT_681942",
      "VERTRAULICHE_BESCHREIBUNG_681942",
    ])
      if (wire.includes(secret)) leaks.push(url.pathname);
  });
  return page;
}
async function login(page, origin, username, password) {
  await page.goto(`${origin}/auth/login`);
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${username}@${tenant}`);
  await page.getByLabel(/^Passwort/).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
}
async function selectMember(page, username, label = "Benutzer") {
  const picker = page.getByRole("combobox", { name: label, exact: true });
  await expect(picker).toBeEnabled();
  await picker.fill(username);
  await page.getByRole("option").filter({ hasText: username }).click();
}
async function save(page, ready) {
  const button = page.getByRole("button", {
    name: "Berechtigungen speichern",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(ready).toBeEnabled();
  await expect(button).toBeDisabled();
}

try {
  browser = await chromium.launch({
    headless: process.env.SORTSYS_E2E_HEADED !== "1",
  });
  console.log("Scoped access UI: starting isolated browser sessions");
  const owner = await pageFor("owner");
  const manager = await pageFor("manager");
  const member = await pageFor("member");
  await login(
    manager,
    managerServer.origin,
    "permission.manager",
    "Private-password-permission.manager-2026!",
  );
  await manager.goto(`${managerServer.origin}/admin`);
  await expect(
    manager.getByRole("heading", { name: "Datenfreigaben", exact: true }),
  ).toBeVisible();
  await expect(manager.getByRole("tab")).toHaveCount(0);
  await expect(
    manager.getByRole("button", { name: "Benutzer anlegen", exact: true }),
  ).toHaveCount(0);
  await expect(
    manager.getByRole("link", { name: /Wiederherstellungsphrase/ }),
  ).toHaveCount(0);
  await selectMember(manager, "key.reader");
  const read = manager.getByRole("checkbox", { name: "Lesen", exact: true });
  await expect(read).toBeEnabled();
  await expect(read).not.toBeChecked();
  await expect(
    manager.getByRole("checkbox", { name: "Löschen", exact: true }),
  ).toHaveCount(0);
  await expect(
    manager.getByRole("checkbox", { name: "Freigaben verwalten", exact: true }),
  ).toHaveCount(0);
  await expect(
    manager.getByRole("combobox", { name: "Bereich", exact: true }),
  ).toHaveValue("Produktkatalog");
  console.log("Scoped access UI: manager sees only delegated controls");

  await login(
    member,
    ownerServer.origin,
    "key.reader",
    "Private-password-key.reader-2026!",
  );
  await member.goto(`${ownerServer.origin}/products`);
  await expect(
    member.getByText("VERTRAULICHES_PRODUKT_681942", { exact: true }),
  ).toHaveCount(0);
  await expect(member.locator('nav a[href="/admin"]')).toHaveCount(0);
  await manager.getByText("Lesen", { exact: true }).click();
  await expect(read).toBeChecked();
  await save(manager, read);
  await expect(
    member.getByText("VERTRAULICHES_PRODUKT_681942", { exact: true }),
  ).toBeVisible();
  await expect(member.locator('nav a[href="/products"]')).toHaveCount(1);
  console.log("Scoped access UI: delegated read grant reached the other API");
  await manager.screenshot({
    path: join(artifacts, "manager-grant.png"),
    fullPage: true,
  });
  await member.screenshot({
    path: join(artifacts, "member-readable.png"),
    fullPage: true,
  });
  await manager.getByText("Lesen", { exact: true }).click();
  await expect(read).not.toBeChecked();
  await save(manager, read);
  await expect(
    member.getByText("VERTRAULICHES_PRODUKT_681942", { exact: true }),
  ).toHaveCount(0);
  await expect(member.locator('nav a[href="/products"]')).toHaveCount(0);
  console.log("Scoped access UI: delegated revocation cleared visible content");

  await login(
    owner,
    ownerServer.origin,
    "builder",
    "Only-owner-knows-this-password-2026!",
  );
  await owner.goto(`${ownerServer.origin}/admin?tab=security`);
  await selectMember(owner, "permission.manager", "Benutzerkonto");
  const catalogue = owner.getByRole("group", {
    name: "Einzelrechte für Produktkatalog",
    exact: true,
  });
  const grant = catalogue.getByRole("checkbox", {
    name: "Freigaben verwalten",
    exact: true,
  });
  await expect(grant).toBeChecked();
  await owner.screenshot({
    path: join(artifacts, "primary-management-control.png"),
    fullPage: true,
  });
  await catalogue.getByText("Freigaben verwalten", { exact: true }).click();
  await expect(grant).not.toBeChecked();
  await save(owner, grant);
  await expect(
    manager.getByRole("heading", { name: "Datenfreigaben", exact: true }),
  ).toHaveCount(0);
  await expect(manager.locator('nav a[href="/admin"]')).toHaveCount(0);
  await manager.screenshot({
    path: join(artifacts, "manager-revoked.png"),
    fullPage: true,
  });
  await catalogue.getByText("Freigaben verwalten", { exact: true }).click();
  await expect(grant).toBeChecked();
  await save(owner, grant);
  await expect(manager.locator('nav a[href="/admin"]')).toHaveCount(1);
  await manager.reload();
  await expect(
    manager.getByRole("heading", { name: "Datenfreigaben", exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  assert.deepEqual(leaks, []);
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify(
      { passed: true, twoApiInstances: true, plaintextLeaks: leaks },
      null,
      2,
    ),
  );
  console.log(
    "Scoped access UI verified: real delegated grant/revocation, member visibility, primary management controls and live administrative revocation across two APIs.",
  );
} catch (error) {
  console.error("Browser errors:", errors);
  for (const { page, name } of pages) {
    await page
      .screenshot({
        path: join(artifacts, `${name}-failed.png`),
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      join(artifacts, `${name}-failed.html`),
      await page.content(),
    ).catch(() => {});
  }
  throw error;
} finally {
  for (let index = 0; index < contexts.length; index++) {
    await contexts[index].tracing
      .stop({ path: join(artifacts, `trace-${index}.zip`) })
      .catch(() => {});
  }
  await close();
}
