import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { applicationServer } from "./applicationServer.mjs";

const assets = process.env.SORTSYS_UI_ASSETS ??
  new URL("../../build/client", import.meta.url).pathname;

// A marker for the proxy and cache boundaries, not a substitute for the API
// in the authenticated workflows.
const upstream = createServer((request, response) => {
  if (request.url === "/pwa-probe") {
    response.writeHead(200, { "Content-Type": "text/plain" }).end("upstream");
    return;
  }

  response.writeHead(404).end();
});

await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});

let server;
let browser;
try {
  server = await applicationServer(assets, `http://127.0.0.1:${upstream.address().port}`);
  browser = await chromium.launch({ executablePath: process.env.SORTSYS_E2E_CHROMIUM });
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  const appUrl = `${server.origin}/auth/login`;

  const home = await context.request.get(server.origin);
  assert.equal(home.status(), 200);
  const manifest = await context.request.get(`${server.origin}/manifest.webmanifest`);
  assert.match(manifest.headers()["content-type"], /^application\/manifest\+json/);
  assert.equal((await manifest.json()).start_url, "/");

  const response = await page.goto(appUrl);
  assert.equal(response?.status(), 200);
  await page.getByRole("button", { name: "Anmelden", exact: true }).waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 90_000,
  });

  const apiUrl = `${server.origin}/api/v2/pwa-probe`;
  const api = await page.goto(apiUrl);
  assert.equal(await api?.text(), "upstream");
  assert.equal(api?.fromServiceWorker(), false);

  await context.setOffline(true);
  const offline = await page.goto(`${appUrl}?offline=1`);
  assert.equal(offline?.status(), 200);
  assert.equal(offline?.fromServiceWorker(), true);
  await page.getByRole("button", { name: "Anmelden", exact: true }).waitFor();

  for (const pathname of ["/api/v2/pwa-probe", "/pdfjs/viewer.html"]) {
    await assert.rejects(page.goto(`${server.origin}${pathname}`), /ERR_INTERNET_DISCONNECTED/);
  }

  console.log("Production SPA: login renders offline; API and PDF navigations bypass the shell.");
} finally {
  await browser?.close();
  await server?.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
