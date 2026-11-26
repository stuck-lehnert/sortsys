import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  assert.equal(observed.rpcTiming.coveredMs, batch.elapsedMs);
  assert.equal(observed.rpcTiming.peakConcurrent, 1);
  assert.equal(observed.crypto.importKey.finished, 1);
  assert.equal(observed.crypto.decrypt.finished, 1);
  assert.doesNotMatch(JSON.stringify(observed), /private/);

  const idle = await diagnostics.snapshot();
  assert.deepEqual(await diagnostics.since(idle), {
    routes: Object.create(null),
    rpcTiming: { coveredMs: 0, peakConcurrent: 0 },
    crypto: {},
  });
  await page.reload();
  await assert.rejects(diagnostics.since(start), /full page navigation/);
});

test("overlapping requests cover time once and late completions stay outside the measurement", async () => {
  const origin = "http://localhost:1234";
  const page = new EventEmitter();
  let afterBoundary = () => {};
  page.evaluate = async () => {
    afterBoundary();
    return { timeOrigin: 0, operations: {} };
  };

  const startRequest = (procedure, startTime, responseEnd) => {
    const request = {
      url: () => `${origin}/api/v2/${procedure}`,
      timing: () => ({ startTime, responseEnd }),
    };
    page.emit("request", request);
    return request;
  };

  const context = { addInitScript: async () => {} };
  const diagnostics = await interactionDiagnostics(context, page, origin);
  const prior = startRequest("prior", 1, 24);
  const start = await diagnostics.snapshot();

  const first = startRequest("access.snapshot", 10, 20);
  const second = startRequest("access.snapshot", 20, 30);
  const third = startRequest("objects.list", 50, 10);
  const failed = startRequest("objects.get", 51, -1);
  const late = startRequest("access.snapshot", 60, 8);
  for (const request of [prior, first, second, third]) {
    page.emit("requestfinished", request);
  }
  page.emit("requestfailed", failed);
  afterBoundary = () => page.emit("requestfinished", late);

  const result = await diagnostics.since(start);
  assert.deepEqual({ ...result.routes }, {
    "access.snapshot": { started: 3, finished: 2, transportErrors: 0, elapsedMs: 50 },
    "objects.list": { started: 1, finished: 1, transportErrors: 0, elapsedMs: 10 },
    "objects.get": { started: 1, finished: 0, transportErrors: 1, elapsedMs: 0 },
  });
  assert.deepEqual(result.rpcTiming, { coveredMs: 50, peakConcurrent: 2 });
});
