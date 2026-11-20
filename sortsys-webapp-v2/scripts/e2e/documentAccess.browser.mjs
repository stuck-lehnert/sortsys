import assert from "node:assert/strict";
import { once } from "node:events";
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
  await page.addInitScript(() => {
    const messages = [];
    const searchWorkers = new WeakSet();
    window.documentSearchMessages = messages;
    window.documentSearchStops = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      const [message] = args;
      if (typeof message?.query === "string" && Array.isArray(message.batches)) {
        for (const { batch, source } of message.batches) {
          messages.push({ batch, hasSource: !!source });
        }
        searchWorkers.add(this);
      }
      return Reflect.apply(post, this, args);
    };
    const terminate = Worker.prototype.terminate;
    Worker.prototype.terminate = function () {
      if (searchWorkers.delete(this)) window.documentSearchStops++;
      return Reflect.apply(terminate, this, []);
    };
  });
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
  const documentsPage = `${server.origin}/documents`;
  const pagedQuery = "Pfostenanker";
  const textQuery = "Suchfenster OR Rückbau Asbest Genehmigung";
  const fileNameQuery = "Freigegebener Plan";
  const searchRequests = [];
  page.on("request", (request) => {
    searchRequests.push(
      decodeURIComponent(request.url()),
      request.postData() ?? "",
    );
  });
  await page.goto(documentsPage);
  const search = page.getByRole("searchbox", { name: "Dokumente durchsuchen" });
  await search.fill(pagedQuery);
  await search.press("Enter");
  const pagedResults = page.locator(".documents-search__result");
  await expect(pagedResults).toHaveCount(1);
  await expect(pagedResults.getByRole("link")).toHaveAttribute(
    "href",
    `/projects/${fixture.projectId}/files/${fixture.pagedFileId}`,
  );
  const workerMessages = () => page.evaluate(() => window.documentSearchMessages);
  const cold = await workerMessages();
  assert.ok(cold.length >= 2 && cold.every(({ hasSource }) => hasSource));

  await search.fill(textQuery);
  await search.press("Enter");
  const hit = page.getByRole("link", { name: fixture.fileName, exact: true });
  await expect(hit).toBeVisible();
  await expect(page.locator(".documents-search__excerpt mark"))
    .toHaveText("Suchfenster");
  const warm = (await workerMessages()).slice(cold.length);
  assert.equal(warm.length, cold.length);
  assert.ok(warm.every(({ hasSource }) => !hasSource));
  await search.fill("Wärmebrückennachweis");
  await search.press("Enter");
  const excerpt = page.locator(".documents-search__excerpt");
  await expect(excerpt).toContainText("Wärmebrückennachweis Erstfassung");
  const beforeVersionChange = (await workerMessages()).length;
  const stopsBeforeVersionChange = await page.evaluate(() => window.documentSearchStops);
  assert.ok(process.send);
  const replacement = once(process, "message", {
    signal: AbortSignal.timeout(20_000),
  });
  process.send("replace-document-search-version");
  const [replacementMessage] = await replacement;
  assert.equal(replacementMessage, "document-search-version-replaced");
  await expect(excerpt).toContainText("Wärmebrückennachweis Prüffassung");
  await expect(excerpt).not.toContainText("Erstfassung");
  const refreshedBatches = (await workerMessages()).slice(beforeVersionChange);
  const receivedAgain = new Set(refreshedBatches
    .filter(({ hasSource }) => hasSource)
    .map(({ batch }) => batch));
  assert.equal(receivedAgain.size, 1, "Only the revised project's batch is transferred");
  assert.ok(refreshedBatches.some(({ hasSource }) => !hasSource));
  assert.equal(
    await page.evaluate(() => window.documentSearchStops),
    stopsBeforeVersionChange,
    "A file revision does not restart the worker",
  );
  await expect(page).toHaveURL(documentsPage);
  await search.fill(fileNameQuery);
  await search.press("Enter");
  await expect(hit).toBeVisible();
  await expect(page.locator(".documents-search__excerpt")).toHaveCount(0);
  await expect(page).toHaveURL(documentsPage);
  await page.reload();
  await expect(search).toHaveValue("");
  await expect(hit).toHaveCount(0);
  await search.fill(fileNameQuery);
  await search.press("Enter");
  await expect(hit).toBeVisible();
  assert.ok((await workerMessages()).some(({ hasSource }) => hasSource));
  assert.ok(searchRequests.length > 0);
  const privateQueries = [pagedQuery, textQuery, fileNameQuery];
  assert.ok(
    searchRequests.every(
      (request) => privateQueries.every((query) => !request.includes(query)),
    ),
    "Document search terms must stay out of browser requests, including on reload",
  );
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

  await page.goto(documentsPage);
  await search.fill(fileNameQuery);
  await search.press("Enter");
  await expect(hit).toBeVisible();
  const initialStops = await page.evaluate(() => window.documentSearchStops);
  const acknowledgement = once(process, "message", {
    signal: AbortSignal.timeout(20_000),
  });
  process.send("revoke-document-search");
  const [message] = await acknowledgement;
  assert.equal(message, "document-search-revoked");
  await expect(hit).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.documentSearchStops))
    .toBeGreaterThan(initialStops);
  assert.deepEqual(errors, []);
  console.log(`Chromium reused ${warm.length} document batches, replaced only one project's batch after a file change, and discarded the worker on live revocation.`);
} finally {
  await browser?.close();
  await server.close();
}
