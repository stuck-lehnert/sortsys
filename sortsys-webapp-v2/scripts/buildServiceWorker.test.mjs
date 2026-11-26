import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildServiceWorker } from "./buildServiceWorker.ts";

test("the service worker is built beside the rendered shell and precaches only public app assets", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "sortsys-pwa-"));
  t.after(() => rm(output, { recursive: true, force: true }));

  const client = join(output, "client");
  const files = {
    "registerSW.js": "/* registration */",
    "manifest.webmanifest": "{}",
    "android-chrome-192x192.png": "icon",
    "icon.svg": "<svg/>",
    "assets/entry-A1.js": "export {};",
    "assets/entry-B2.css": "body {}",
    "assets/gaebValidation-C3.js": "export {};",
    "pdfjs/build/pdf.js": "export {};",
    "api/v2/response.js": "export {};",
  };

  for (const [name, content] of Object.entries(files)) {
    const path = join(client, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  await assert.rejects(buildServiceWorker(client), { code: "ENOENT" });
  await assert.rejects(readFile(join(client, "sw.js")), { code: "ENOENT" });

  await writeFile(join(client, "index.html"), "<!doctype html><title>sortsys</title>");
  const result = await buildServiceWorker(client);
  const worker = await readFile(join(client, "sw.js"), "utf8");

  assert.equal(result.count, 7);
  assert.match(worker, /precacheAndRoute\(/);
  assert.match(worker, /index\.html/);
  assert.match(worker, /assets\/entry-A1\.js/);
  assert.doesNotMatch(worker, /pdf\.js|response\.js|gaebValidation/);
  await assert.rejects(readFile(join(output, "sw.js")), { code: "ENOENT" });
});
