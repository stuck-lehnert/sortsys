import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { applicationServer } from "./applicationServer.mjs";
import { interactionDiagnostics } from "./interactionDiagnostics.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function target(branch, serveBuilds) {
  const key = `SORTSYS_LATENCY_${branch}`;
  const account = {
    branch,
    username: required(`${key}_USER`),
    password: required(`${key}_PASSWORD`),
  };

  if (serveBuilds) {
    if (process.env[`${key}_URL`]) {
      throw new Error(`Unset ${key}_URL when serving builds`);
    }

    return {
      ...account,
      client: required(`${key}_CLIENT_DIR`),
      api: new URL(required(`${key}_API_URL`)),
    };
  }

  const url = new URL(required(`${key}_URL`));
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${key}_URL must point to a local HTTP test deployment`);
  }

  return { ...account, url };
}

function percentile(values, p) {
  const ordered = values.toSorted((a, b) => a - b);
  return Math.round(ordered[Math.ceil(p * ordered.length) - 1]);
}

function summarize(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function summarizePairs({ master, zerotrust }) {
  return Object.fromEntries(Object.keys(master[0]).map((step) => {
    const masterTimes = master.map((run) => run[step]);
    const zerotrustTimes = zerotrust.map((run) => run[step]);
    const pairedDifference = zerotrustTimes.map((time, round) => time - masterTimes[round]);

    return [step, {
      master: summarize(masterTimes),
      zerotrust: summarize(zerotrustTimes),
      pairedDifference: summarize(pairedDifference),
    }];
  }));
}

const serveBuilds = ["MASTER", "ZT"].some((branch) =>
  ["CLIENT_DIR", "API_URL"].some(
    (suffix) => process.env[`SORTSYS_LATENCY_${branch}_${suffix}`],
  ),
);
const master = target("MASTER", serveBuilds);
const zerotrust = target("ZT", serveBuilds);

if (!serveBuilds && master.url.origin === zerotrust.url.origin) {
  throw new Error("Master and Zero Trust must use different local origins");
}

if (serveBuilds && master.api.origin === zerotrust.api.origin) {
  throw new Error("Master and Zero Trust must use different local APIs");
}

const title = required("SORTSYS_LATENCY_PROJECT");
const searchTerm = required("SORTSYS_LATENCY_SEARCH");
const offerTitle = required("SORTSYS_LATENCY_OFFER");
const configuredContacts = process.env.SORTSYS_LATENCY_PROJECT_CONTACTS;
const projectContacts =
  configuredContacts === undefined ? undefined : Number(configuredContacts);
const samples = Number(process.env.SORTSYS_LATENCY_SAMPLES ?? "12");
const actionTimeout = Number(process.env.SORTSYS_LATENCY_ACTION_TIMEOUT_MS ?? "30000");
const diagnosticsEnabled = process.env.SORTSYS_LATENCY_DIAGNOSTICS === "1";
const waitForDashboard = process.env.SORTSYS_LATENCY_WAIT_DASHBOARD === "1";

if (
  projectContacts !== undefined &&
  (!Number.isSafeInteger(projectContacts) || projectContacts < 1)
) {
  throw new Error("SORTSYS_LATENCY_PROJECT_CONTACTS must be a positive integer");
}
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error("SORTSYS_LATENCY_SAMPLES must be an integer between 1 and 100");
}
if (!Number.isSafeInteger(actionTimeout) || actionTimeout < 1) {
  throw new Error("SORTSYS_LATENCY_ACTION_TIMEOUT_MS must be a positive integer");
}

async function scenario(browser, target) {
  const context = await browser.newContext({
    locale: "de-DE",
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(actionTimeout);
    const diagnostics = diagnosticsEnabled
      ? await interactionDiagnostics(context, page, target.url.origin)
      : undefined;
    const steps = {};
    const record = async (name, start) => {
      steps[name] = diagnostics
        ? await diagnostics.since(start)
        : performance.now() - start;
    };
    const measure = async (name, open) => {
      const start = diagnostics ? await diagnostics.snapshot() : performance.now();
      await open();
      await record(name, start);
    };

    const nav = (path) => page.locator(`nav a[href="${path}"]`).filter({ visible: true });
    const projects = nav("/projects");
    const projectRow = page.getByRole("row").filter({
      has: page.getByText(title, { exact: true }),
    });
    const projectHeading = page.getByRole("heading", { name: title, exact: true, level: 1 });
    const ready = (locator) => locator.waitFor({ state: "visible" });

    await page.goto(new URL("/auth/login", target.url).href);
    await page.getByRole("textbox", { name: /^(Nutzername|Username)/ }).fill(target.username);
    await page.getByLabel(/^(Passwort|Password)/).fill(target.password);

    await measure("login", async () => {
      await page.getByRole("button", { name: /^(Anmelden|Sign in)$/ }).click();
      await ready(nav("/settings"));
    });

    if (waitForDashboard) {
      await measure("dashboardAfterLogin", async () => {
        await page.waitForURL((url) => url.pathname === "/dashboard");
        await ready(page.locator(".dashboard-activity"));

        await page
          .locator(".dashboard-loading:visible, .dashboard-activity-loading:visible")
          .first()
          .waitFor({ state: "hidden" });
      });
    }

    // The default dashboard leaves this group collapsed on both branches.
    // Opening the navigation is separate from signing in and loading the list.
    const projectWork = page.getByRole("button", { name: /^(Projektarbeit|Project work)$/ });
    if (await projectWork.getAttribute("aria-expanded") === "false") await projectWork.click();
    await ready(projects);

    await measure("firstList", async () => {
      await projects.click();
      await page.waitForURL((url) => url.pathname === "/projects");
      await ready(projectRow);
    });
    const detailStart = diagnostics ? await diagnostics.snapshot() : performance.now();
    await projectRow.press("Enter");
    await page.waitForURL((url) => /^\/projects\/[0-9a-v]+$/.test(url.pathname));
    await ready(projectHeading);
    await record("detail", detailStart);

    if (projectContacts !== undefined) {
      const name = new RegExp(`^(Ansprechpartner|Contacts) \\(${projectContacts}\\)$`);
      await ready(page.getByRole("button", { name }));
      await record("detailWithContacts", detailStart);
    }

    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    await measure("revisitedList", async () => {
      await projects.click();
      await page.waitForURL((url) => url.pathname === "/projects");
      await ready(projectRow);
    });

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: /^(Befehlspalette|Command palette)$/ });
    const search = palette.getByRole("searchbox");
    const match = palette.getByRole("option")
      .filter({ has: page.getByText(title, { exact: true }) })
      .filter({ has: page.getByText(/^(Projekt|Project)$/) });
    await ready(search);

    if (await match.count()) {
      throw new Error(`${target.branch}: the search result is already present before typing`);
    }

    await measure("searchResult", async () => {
      await search.fill(searchTerm);
      await ready(match);
    });
    const closeLabel = /^(Schließen|Close)$/;
    await palette
      .getByRole("button", { name: closeLabel })
      .filter({ hasText: closeLabel })
      .click();
    await palette.waitFor({ state: "hidden" });

    const offerList = page.getByRole("region", { name: /^(Angebotsübersicht|Offers list)$/ })
      .and(page.locator('[aria-busy="false"]'));
    const offerRow = offerList.getByRole("row").filter({
      has: page.getByText(offerTitle, { exact: true }),
    });
    await measure("offers", async () => {
      await nav("/offers").click();
      await page.waitForURL((url) => url.pathname === "/offers");
      await ready(offerRow);
    });
    const offerNumber = (await offerRow.getByRole("rowheader").innerText()).trim();
    if (!offerNumber) throw new Error(`${target.branch}: missing offer number`);

    // Master opens the editor with the full document. Zero Trust can first
    // render its shell while the remaining authorized content is decrypted.
    const editorRoot = target.branch === "ZT"
      ? '.gaeb-editor[data-content-complete="true"]'
      : ".gaeb-editor";
    const document = page.locator(editorRoot).locator(".gaeb-document-paper");
    await measure("editor", async () => {
      await offerRow.press("Enter");
      await ready(document);
    });

    return { fixture: { projectId, offerNumber }, steps };
  } finally {
    await context.close();
  }
}

const servers = [];
let browser;
try {
  if (serveBuilds) {
    for (const target of [master, zerotrust]) {
      const server = await applicationServer(target.client, target.api);
      servers.push(server);
      target.url = new URL(server.origin);

      // Master treats the literal IPv4 loopback hostname as a development
      // deployment with its API fixed at port 3000. Keep both SPAs same-origin.
      target.url.hostname = "localhost";
    }
  }

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SORTSYS_E2E_CHROMIUM,
  });

  const results = { master: [], zerotrust: [] };
  let fixture;
  for (let i = 0; i < samples; i++) {
    // Alternate order so neither build always benefits from running second.
    const order = i % 2 === 0 ? ["master", "zerotrust"] : ["zerotrust", "master"];
    for (const branch of order) {
      const sample = await scenario(browser, branch === "master" ? master : zerotrust);
      fixture ??= sample.fixture;
      if (
        fixture.projectId !== sample.fixture.projectId ||
        fixture.offerNumber !== sample.fixture.offerNumber
      ) {
        throw new Error(`${branch}: fixture identifiers differ from the first sample`);
      }
      results[branch].push(sample.steps);
    }
  }

  const measurement = diagnosticsEnabled
    ? { diagnostics: true }
    : { unit: "ms", summary: summarizePairs(results) };

  console.log(JSON.stringify({
    browser: browser.version(),
    hosting: serveBuilds ? "shared-test-proxy" : "local-deployments",
    samples,
    fixture,
    ...measurement,
    results,
  }, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
}
