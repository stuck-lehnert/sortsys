import assert from "node:assert/strict";
import { chromium } from "playwright";
import { applicationServer } from "./applicationServer.mjs";

const [baseline, candidate] = process.argv.slice(2);
assert.ok(baseline && candidate, "Pass the baseline and candidate SPA directories");

const repeats = Number(process.env.SORTSYS_LOGIN_ENTRY_PAIRS ?? 8);
assert.ok(Number.isSafeInteger(repeats) && repeats > 0);

const browser = await chromium.launch({ executablePath: process.env.SORTSYS_E2E_CHROMIUM });
const builds = [];

try {
  for (const [name, directory] of [["baseline", baseline], ["candidate", candidate]]) {
    const procedures = [];
    const server = await applicationServer(directory, "http://127.0.0.1:1", {
      observeRpc: (procedure) => { procedures.push(procedure); },
    });
    builds.push({ name, server, procedures });
  }

  for (const path of ["/auth/login", "/projects"]) {
    for (let pair = 0; pair < repeats; pair++) {
      const order = pair % 2 === 0 ? builds : [...builds].reverse();
      for (const build of order) {
        const sample = await measure(build, path);
        console.log(JSON.stringify({ build: build.name, path, pair, ...sample }));
      }
    }
  }
} finally {
  await browser.close();
  await Promise.all(builds.map(({ server }) => server.close()));
}

async function measure({ server, procedures }, path) {
  procedures.length = 0;
  const context = await browser.newContext({ locale: "de-DE", serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(`${server.origin}${path}`, { waitUntil: "commit" });
    await page.getByRole("textbox", { name: /^Nutzername/ }).waitFor();
    await page.getByLabel(/^Passwort/).waitFor();
    await page.getByRole("button", { name: "Anmelden", exact: true }).waitFor();

    const sample = await page.evaluate(() => {
      const scripts = performance.getEntriesByType("resource").filter((entry) =>
        new URL(entry.name).origin === location.origin && /\.m?js$/.test(new URL(entry.name).pathname),
      );
      return {
        formVisibleMs: Math.round(performance.now()),
        scripts: scripts.length,
        scriptBytes: scripts.reduce((bytes, script) => bytes + script.decodedBodySize, 0),
      };
    });

    assert.equal(new URL(page.url()).pathname, "/auth/login");
    assert.equal(await page.getByRole("button", { name: "Projekt erstellen", exact: true }).count(), 0);
    assert.deepEqual(procedures, []);
    assert.deepEqual(errors, []);
    return sample;
  } finally {
    await context.close();
  }
}
