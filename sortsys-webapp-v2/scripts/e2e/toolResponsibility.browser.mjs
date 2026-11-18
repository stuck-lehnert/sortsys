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
const artifacts = join(dirname(fixturePath), "browser-artifacts", "late-tools");
await mkdir(artifacts, { recursive: true });
const directory = new URL("../../build/client", import.meta.url).pathname;
const server = await applicationServer(directory, endpoints[1]);
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

try {
  browser = await chromium.launch({
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
      if (wire.includes(value)) leaks.push({ path: url.pathname, value });
  });
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/zerotrust/events")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const event = JSON.parse(payload);
      if (event.type === "changed") events.push(event);
    });
  });
  await page.goto(`${server.origin}/auth/login`);
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${fixture.member.username}@${fixture.tenant}`);
  await page.getByLabel(/^Passwort/).fill(fixture.member.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  await page.goto(`${server.origin}/tools/trackings`);
  await expect(
    page.getByRole("heading", { name: "Buchungshistorie", exact: true }),
  ).toBeVisible();
  const active = page.getByText(new RegExp(fixture.activeLabel));
  await expect(active).toBeVisible();
  await expect(page.getByText(new RegExp(fixture.closedLabel))).toHaveCount(0);
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
  process.send("booking-visible");
  await returned;
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
  await expect(page.getByText(new RegExp(fixture.closedLabel))).toHaveCount(0);
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
