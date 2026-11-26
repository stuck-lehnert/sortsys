import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { applicationServer } from "./applicationServer.mjs";
import { interactionDiagnostics } from "./interactionDiagnostics.mjs";

test("browser diagnostics count batched calls and WebCrypto without keeping their inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sortsys-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), "<!DOCTYPE html><main>Probe</main>");

  const paths = [];
  const api = createServer((request, response) => {
    paths.push(request.url);
    response.end("ok");
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());

  const server = await applicationServer(directory, `http://127.0.0.1:${api.address().port}/`);
  t.after(() => server.close());

  const browser = await chromium.launch({ executablePath: process.env.SORTSYS_E2E_CHROMIUM });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostics = await interactionDiagnostics(context, page, server.origin);

  await page.goto(server.origin);
  assert.equal(await page.locator("main").textContent(), "Probe");
  const start = await diagnostics.snapshot();

  await page.evaluate(async () => {
    const response = await fetch("/api/v2/projects.list,access.snapshot?input=private");
    await response.text();

    const key = await crypto.subtle.importKey(
      "raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"],
    );
    const parameters = { name: "AES-GCM", iv: new Uint8Array(12) };
    const value = await crypto.subtle.encrypt(parameters, key, new Uint8Array([42]));
    await crypto.subtle.decrypt(parameters, key, value);
  });

  assert.deepEqual(paths, ["/projects.list,access.snapshot?input=private"]);
  const observed = await diagnostics.since(start);
  assert.deepEqual(Object.keys(observed.routes), ["projects.list,access.snapshot"]);
  const batch = observed.routes["projects.list,access.snapshot"];
  assert.equal(batch.started, 1);
  assert.equal(batch.finished, 1);
  assert.equal(batch.transportErrors, 0);
  assert.equal(observed.crypto.importKey.finished, 1);
  assert.equal(observed.crypto.decrypt.finished, 1);
  assert.doesNotMatch(JSON.stringify(observed), /private/);

  const idle = await diagnostics.snapshot();
  assert.deepEqual(await diagnostics.since(idle), {
    routes: Object.create(null),
    crypto: {},
  });
  await page.reload();
  await assert.rejects(diagnostics.since(start), /full page navigation/);
});
