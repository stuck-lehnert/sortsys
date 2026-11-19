import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
assert.equal(process.env.SORTSYS_NATIVE_BROWSER, "1");
const fixturePath = process.argv[2];
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS);
assert.equal(endpoints.length, 2);
const scenario = fixture.artifactName ?? "late-tools";
assert.match(scenario, /^[a-z0-9-]+$/);
const artifacts = join(dirname(fixturePath), "browser-artifacts", scenario);
await mkdir(artifacts, { recursive: true });
const directory = process.env.SORTSYS_E2E_APPLICATION_BUILD ??
  new URL("../../build/client", import.meta.url).pathname;
const server = await applicationServer(directory, endpoints[1]);
let managerServer;
const expect = playwrightExpect.configure({ timeout: 20_000 });
const errors = [];
const leaks = [];
const events = [];
let browser;
let context;
let page;
async function close() {
  await browser?.close();
  await server.close();
  await managerServer?.close();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
const returned = new Promise((resolve, reject) => {
  process.once("message", (message) => {
    if (message === "booking-returned") resolve();
    else reject(new Error("Unexpected return notification"));
  });
});

async function signIn(page, origin, credentials) {
  await page.goto(`${origin}/auth/login`);
  await page.getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${credentials.username}@${fixture.tenant}`);
  await page.getByLabel(/^Passwort/).fill(credentials.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("link", { name: "Einstellungen", exact: true })).toBeVisible();
}

async function returnFromToolDetail() {
  managerServer = await applicationServer(directory, endpoints[0]);
  const manager = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "de-DE" });
  await manager.tracing.start({ screenshots: true, snapshots: true });
  const tool = await manager.newPage();
  tool.on("pageerror", (error) => errors.push(error.message));
  try {
    await signIn(tool, managerServer.origin, fixture.manager);
    await tool.goto(`${managerServer.origin}/tools/${fixture.toolId}`);
    await expect(tool.getByText("gebucht", { exact: true })).toBeVisible();
    const actions = tool.getByRole("button", { name: "Aktionen", exact: true }).first();
    await expect(async () => {
      if (!(await tool.getByRole("menu").count())) await actions.click();
      await expect(tool.getByRole("menuitem", { name: "Zurückbuchen", exact: true })).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 45_000 });
    const rotated = tool.waitForResponse((response) =>
      response.ok() && new URL(response.url()).pathname.includes("zerotrust.access.publish"),
    { timeout: 45_000 });
    await tool.getByRole("menuitem", { name: "Zurückbuchen", exact: true }).click();
    await rotated;
    await expect(tool.getByText("verfügbar", { exact: true })).toBeVisible({ timeout: 45_000 });
    await tool.screenshot({ path: join(artifacts, "manager-after-return.png"), fullPage: true });
  } finally {
    await manager.tracing.stop({ path: join(artifacts, "manager.zip") });
    await manager.close();
  }
}

try {
  browser = await chromium.launch({
    executablePath: process.env.SORTSYS_E2E_CHROMIUM,
    headless: process.env.SORTSYS_E2E_HEADED !== "1",
  });
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: "de-DE",
  });
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v2/")) return;
    const wire = (request.postData() ?? "") + decodeURIComponent(url.search);
    for (const value of [
      fixture.toolBrand,
      fixture.activeLabel,
      fixture.closedLabel,
    ])
      if (value && wire.includes(value))
        leaks.push({ path: url.pathname, value });
  });
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/zerotrust/events")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const event = JSON.parse(payload);
      if (event.type === "changed") events.push(event);
    });
  });
  await signIn(page, server.origin, fixture.member);
  await page.goto(`${server.origin}/tools/trackings`);
  await expect(
    page.getByRole("heading", { name: "Buchungshistorie", exact: true }),
  ).toBeVisible();
  const active = page.getByText(new RegExp(fixture.activeLabel));
  await expect(active).toBeVisible();
  await expect(active).toHaveCount(1);
  if (fixture.closedLabel)
    await expect(page.getByText(new RegExp(fixture.closedLabel))).toHaveCount(
      0,
    );
  await expect(page.locator(`a[href="/tools/${fixture.toolId}"]`)).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("columnheader", { name: /Kosten|Preis/ }),
  ).toHaveCount(0);
  await page.screenshot({
    path: join(artifacts, "member-active-only.png"),
    fullPage: true,
  });
  if (fixture.manager) await returnFromToolDetail();
  process.send("booking-visible");
  await returned;
  if (fixture.selfReturn) {
    const accepted = page.waitForResponse((response) =>
      response.ok() && new URL(response.url()).pathname.includes("zerotrust.toolReturns.publish"),
    );
    await page.getByRole("button", { name: "Zurückbuchen", exact: true }).click();
    await accepted;
  }
  await expect(active).toHaveCount(0);
  const revocation = events.find((event) => event.reset && event.control);
  assert.ok(revocation, "The live stream must invalidate revoked permissions");
  assert.equal(Object.hasOwn(revocation.domains, fixture.bookingDomain), false);
  await expect(
    page.getByText("Keine Einträge vorhanden.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Buchungshistorie", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Keine Einträge vorhanden.", { exact: true }),
  ).toBeVisible();
  await expect(active).toHaveCount(0);
  if (fixture.closedLabel)
    await expect(page.getByText(new RegExp(fixture.closedLabel))).toHaveCount(
      0,
    );
  assert.deepEqual(errors, []);
  assert.deepEqual(leaks, []);
  await page.screenshot({
    path: join(artifacts, "member-after-return.png"),
    fullPage: true,
  });
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify(
      {
        success: true,
        lateBookingVisible: true,
        closedBookingHidden: true,
        toolMasterLinkHidden: true,
        costsHidden: true,
        crossInstanceRevocation: true,
        returnedByScopedManager: Boolean(fixture.manager),
        returnedByResponsibleMember: Boolean(fixture.selfReturn),
        reload: true,
        plaintextLeaks: leaks,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Late tool responsibility UI: active-only visibility, no cost/master access, cross-instance revocation and reload verified",
  );
} catch (error) {
  console.error("Browser errors:", errors);
  await page
    ?.screenshot({ path: join(artifacts, "member-failed.png"), fullPage: true })
    .catch(() => {});
  if (page)
    await writeFile(
      join(artifacts, "member-failed.html"),
      await page.content(),
    );
  throw error;
} finally {
  await context?.tracing
    .stop({ path: join(artifacts, "trace.zip") })
    .catch(() => {});
  await close();
  if (process.connected) process.disconnect();
}
