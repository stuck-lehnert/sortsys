import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { applicationServer } from "./applicationServer.mjs";
import { interactionDiagnostics } from "./interactionDiagnostics.mjs";

const [beforeDirectory, afterDirectory] = process.argv.slice(2);
const {
  SORTSYS_AUTH_E2E_API: endpoint,
  SORTSYS_AUTH_E2E_USERNAME: username,
  SORTSYS_AUTH_E2E_PASSWORD: password,
  SORTSYS_E2E_CHROMIUM: executablePath,
  SORTSYS_LATENCY_PROJECT: title,
} = process.env;

const samples = Number(process.env.SORTSYS_LATENCY_SAMPLES ?? 10);
const diagnosticsEnabled = process.env.SORTSYS_LATENCY_DIAGNOSTICS === "1";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
assert.ok(beforeDirectory && afterDirectory && endpoint && username && password && title);
assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 30);

async function activityAfterSignIn(browser, origin) {
  const context = await browser.newContext({ locale: "de-DE" });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    const diagnostics = diagnosticsEnabled
      ? await interactionDiagnostics(context, page, origin)
      : undefined;

    await page.goto(`${origin}/auth/login`);
    await page.getByRole("textbox", { name: /^(Nutzername|Username)/ }).fill(username);
    await page.getByLabel(/^(Passwort|Password)/).fill(password);

    const activityTitles = page.locator(".dashboard-activity-title");
    const projectActivity = activityTitles.and(page.getByText(title, { exact: true }));
    const counters = await diagnostics?.snapshot();
    const signInStarted = performance.now();

    await page.getByRole("button", { name: /^(Anmelden|Sign in)$/ }).click();
    await page.waitForURL((url) => url.pathname === "/dashboard", { waitUntil: "commit" });
    const dashboardReached = performance.now();
    await projectActivity.first().waitFor({ state: "visible" });

    const activityVisible = performance.now();
    const measurement = diagnostics
      ? await diagnostics.since(counters)
      : {
          signInToActivityMs: Math.round(activityVisible - signInStarted),
          dashboardToActivityMs: Math.round(activityVisible - dashboardReached),
        };
    const titles = await activityTitles.allTextContents();

    assert.ok(titles.includes(title));
    return { titles, measurement };
  } finally {
    await context.close();
  }
}

const before = await applicationServer(beforeDirectory, endpoint);

try {
  const after = await applicationServer(afterDirectory, endpoint);

  try {
    const browser = await chromium.launch({ executablePath });

    try {
      const targets = { before: before.origin, after: after.origin };
      const rounds = [];
      let titles;

      for (let index = 0; index < samples; index++) {
        const order = index % 2 === 0 ? ["before", "after"] : ["after", "before"];
        const round = {};

        for (const target of order) {
          const result = await activityAfterSignIn(browser, targets[target]).catch((error) => {
            throw new Error(`Dashboard activity: pair ${index + 1}, ${target}`, { cause: error });
          });

          titles ??= result.titles;
          assert.deepEqual(result.titles, titles);
          round[target] = result.measurement;
        }

        rounds.push(round);
      }

      console.log(JSON.stringify({ browser: browser.version(), diagnosticsEnabled, titles, rounds }));
    } finally {
      await browser.close();
    }
  } finally {
    await after.close();
  }
} finally {
  await before.close();
}
