import assert from "node:assert/strict";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

const env = process.env;
assert.equal(env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints = JSON.parse(env.SORTSYS_AUTH_TEST_ENDPOINTS);
assert.equal(endpoints.length, 2);
const build = env.SORTSYS_E2E_APPLICATION_BUILD ??
  new URL("../../build/client", import.meta.url).pathname;
const projectTitle = "Private Fenstersanierung 862451";
const expect = playwrightExpect.configure({ timeout: 25_000 });
const servers = [];
let browser;

async function openProject(endpoint) {
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  return { context, page, url: `${endpoint}/projects/2s` };
}

async function signIn({ page, url }) {
  await page.goto(url);
  await page.getByRole("textbox", { name: /^Nutzername/ }).fill(
    `${env.SORTSYS_BACKUP_E2E_USER}@${env.SORTSYS_NATIVE_AUTH_TENANT}`,
  );
  await page.getByLabel(/^Passwort/).fill(env.SORTSYS_BACKUP_E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

function procedures(url) {
  return url.pathname.startsWith("/api/v2/")
    ? url.pathname.slice("/api/v2/".length).split(",")
    : [];
}

const adoption = "zerotrust.setup.backup.complete";
const initialization = "zerotrust.setup.complete";
const permitAdoption = Promise.withResolvers();
const discardReply = Promise.withResolvers();
const wireLeaks = [];
function observe(page, requests) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    const names = procedures(url);
    if (!names.length) return;
    requests.push(...names);
    const wire = decodeURIComponent(url.search) + (request.postData() ?? "");
    if ([projectTitle, "Private scan error 739182", env.SORTSYS_BACKUP_E2E_PASSWORD]
      .some((marker) => wire.includes(marker))) {
      wireLeaks.push(names);
    }
  });
}

try {
  for (const endpoint of endpoints) servers.push(await applicationServer(build, endpoint));
  browser = await chromium.launch({ executablePath: env.SORTSYS_E2E_CHROMIUM });
  const working = await openProject(servers[1].origin);
  const firstRequests = [];
  observe(working.page, firstRequests);
  let queued = false;
  let accepted;
  await working.page.route((url) => procedures(url).includes(adoption), async (route) => {
    queued = true;
    await permitAdoption.promise;
    try {
      const names = procedures(new URL(route.request().url()));
      const reply = await (await route.fetch()).json();
      accepted = reply[names.indexOf(adoption)]?.result?.data?.json?.success === true;
    } catch {
      accepted = false;
    }
    await discardReply.promise;
    await route.abort("connectionreset").catch(() => undefined);
  });

  await signIn(working);
  await expect.poll(() => queued, { timeout: 120_000 }).toBe(true);
  await expect(working.page.getByRole("heading", { name: "Organisation einrichten" })).toBeVisible();
  await expect(working.page.getByRole("link", { name: "Einstellungen", exact: true })).toHaveCount(0);
  await expect(working.page.getByText(projectTitle, { exact: true })).toHaveCount(0);
  await expect(working.page.locator('input[type="file"]')).toHaveCount(0);
  assert.ok(!firstRequests.includes(initialization));

  permitAdoption.resolve();
  await expect.poll(() => accepted).toBe(true);
  assert.ok(!firstRequests.includes(initialization));
  discardReply.resolve();
  await working.context.close();

  const resumed = await openProject(servers[0].origin);
  const resumedRequests = [];
  observe(resumed.page, resumedRequests);
  await signIn(resumed);
  await expect(resumed.page.getByRole("link", { name: "Einstellungen", exact: true })).toBeVisible();
  await resumed.page.goto(resumed.url);
  await expect(resumed.page.getByText(projectTitle, { exact: true }).first()).toBeVisible();
  assert.ok(resumedRequests.includes(initialization));
  assert.ok(!resumedRequests.includes(adoption));
  assert.deepEqual(wireLeaks, []);
  console.log("Chromium resumed the encrypted import, waited behind the setup gate, and opened the imported project through another API after the lost acknowledgement.");
} finally {
  permitAdoption.resolve();
  discardReply.resolve();
  await browser?.close();
  await Promise.all(servers.map((server) => server.close()));
}
