import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const fixturePath = process.argv[2];
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS);
assert.equal(endpoints.length, 2);
const artifacts = join(
  dirname(fixturePath),
  "browser-artifacts",
  "own-planning",
);
await mkdir(artifacts, { recursive: true });
const directory = new URL("../../build/client", import.meta.url).pathname;
const servers = [
  await applicationServer(directory, endpoints[0]),
  await applicationServer(directory, endpoints[1]),
];
const expect = playwrightExpect.configure({ timeout: 20_000 });
const contexts = [];
const pages = [];
const errors = [];
const leaks = [];
const events = [];
let browser;
async function close() {
  await browser?.close();
  await Promise.all(servers.map((server) => server.close()));
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });

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
  page.setDefaultTimeout(20_000);
  pages.push({ name, page });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v2/")) return;
    const wire = (request.postData() ?? "") + decodeURIComponent(url.search);
    for (const value of [
      fixture.note,
      fixture.changedNote,
      fixture.hiddenNote,
      fixture.project.title,
    ])
      if (wire.includes(value)) leaks.push({ name, path: url.pathname, value });
  });
  if (name === "member")
    page.on("websocket", (socket) => {
      if (!new URL(socket.url()).pathname.endsWith("/zerotrust/events")) return;
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        const value = JSON.parse(payload);
        if (value.type === "changed") events.push(value);
      });
    });
  return page;
}

async function login(page, origin, credentials) {
  await page.goto(`${origin}/auth/login`);
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${credentials.username}@${fixture.tenant}`);
  await page.getByLabel(/^Passwort/).fill(credentials.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
}

try {
  browser = await chromium.launch({
    headless: process.env.SORTSYS_E2E_HEADED !== "1",
  });
  const owner = await pageFor("owner");
  const member = await pageFor("member");
  await login(owner, servers[0].origin, fixture.owner);
  await login(member, servers[1].origin, fixture.member);
  const route = "/deployments?view=day&day=2026-11-18";
  await member
    .getByRole("button", { name: "Projektarbeit", exact: true })
    .click();
  await member
    .getByRole("link", { name: "Einsatzplanung", exact: true })
    .click();
  await member.goto(servers[1].origin + route);
  const ownEntry = member
    .locator(".pep-entry")
    .filter({ hasText: fixture.note });
  await expect(ownEntry).toBeVisible();
  await expect(
    member.getByText(fixture.project.title, { exact: true }),
  ).toBeVisible();
  await expect(
    member.getByText(fixture.hiddenNote, { exact: true }),
  ).toHaveCount(0);
  await expect(
    member.getByRole("button", { name: "Einsatz hinzufügen", exact: true }),
  ).toHaveCount(0);
  await expect(
    member.getByRole("button", { name: "Baustelle sperren", exact: true }),
  ).toHaveCount(0);
  await expect(member.locator(".pep-entry--clickable")).toHaveCount(0);
  await expect(member.locator('nav a[href="/projects"]')).toHaveCount(0);
  await member.screenshot({
    path: join(artifacts, "member-own-only.png"),
    fullPage: true,
  });
  console.log(
    "Own planning UI: own assignment and encrypted project caption visible; foreign assignment and planning actions absent",
  );

  await owner.goto(servers[0].origin + route);
  await owner
    .locator(".pep-entry--clickable")
    .filter({ hasText: fixture.note })
    .click();
  let dialog = owner.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Einsatz bearbeiten", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Kommentar", exact: true })
    .fill(fixture.changedNote);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    member.locator(".pep-entry").filter({ hasText: fixture.changedNote }),
  ).toBeVisible();
  await expect(member.getByText(fixture.note, { exact: true })).toHaveCount(0);
  assert.ok(
    events.some((event) =>
      Object.hasOwn(
        event.domains ?? {},
        `project:${fixture.project.id}:planning:master-data`,
      ),
    ),
  );
  await member.screenshot({
    path: join(artifacts, "member-live-update.png"),
    fullPage: true,
  });

  await owner
    .locator(".pep-entry--clickable")
    .filter({ hasText: fixture.changedNote })
    .click();
  dialog = owner.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Einsatz löschen", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(member.locator(".pep-entry")).toHaveCount(0);
  await expect(
    member.getByText(fixture.hiddenNote, { exact: true }),
  ).toHaveCount(0);
  await member.reload();
  await expect(
    member.getByRole("heading", { name: "Einsatzplanung", exact: true }),
  ).toBeVisible();
  await expect(member.locator(".pep-entry")).toHaveCount(0);
  await expect(
    member.getByText(fixture.hiddenNote, { exact: true }),
  ).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(leaks, []);
  await member.screenshot({
    path: join(artifacts, "member-after-deletion.png"),
    fullPage: true,
  });
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify(
      {
        success: true,
        privateOwnVisibility: true,
        foreignRecordsHidden: true,
        planningActionsHidden: true,
        crossInstanceUpdate: true,
        crossInstanceDeletion: true,
        reload: true,
        plaintextLeaks: leaks,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Own planning UI: update and deletion reached the second browser without refresh; reload, privacy and transport checks passed",
  );
} catch (error) {
  console.error("Browser errors:", errors);
  for (const { name, page } of pages) {
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
  for (const [index, context] of contexts.entries())
    await context.tracing
      .stop({ path: join(artifacts, `trace-${index}.zip`) })
      .catch(() => {});
  await close();
}
