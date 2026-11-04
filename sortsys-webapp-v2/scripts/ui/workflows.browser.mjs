import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import superjson from "superjson";
import { createFixtureServer, fixtureDirectory } from "./browser-support.mjs";
import { makeMsgFixture } from "../../test-fixtures/msgFixture.mjs";

let browser;
let server;
let context;
let page;
let api;
let errors;

const existingContact = {
  id: "1dag4dqo8npse",
  salutation: null,
  firstName: "Anna",
  lastName: "Müller",
  address: null,
  phoneNumbers: [],
  emailAddresses: [],
  createdAt: new Date("2026-10-27T08:00:00Z"),
  modifiedAt: new Date("2026-10-27T08:00:00Z"),
};
const otherContact = {
  ...existingContact,
  id: "contact-second",
  firstName: "Ben",
  lastName: "Schneider",
};

const importModelOptions = [
  { id: "text-only", name: "Text only", supportsImageInput: false },
  { id: "vision-model", name: "Verified vision", supportsImageInput: true },
  { id: "unknown-model", name: "Unverified model" },
];

function seedAdminModels(provider = "openrouter") {
  api.respond(
    "admin.llm.providers.list",
    ["openrouter", "openai"].map((name) => ({
      provider: name,
      baseUrl: null,
      hasApiKey: true,
    })),
  );
  api.respond(
    "admin.llm.useCases.list",
    ["chat", "documentImport"].map((useCase) => ({
      useCase,
      provider,
      model: "text-only",
    })),
  );
  api.respond("admin.llm.tenants.list", []);
  api.respond("admin.llm.usage", []);
  api.respond("admin.llm.providers.models", importModelOptions);
  api.respond("admin.llm.useCases.update", true);
}

async function openModelDialog(title) {
  const heading = page.getByText(title, { exact: true });
  await heading.waitFor();
  await heading
    .locator("..")
    .locator("..")
    .getByRole("button", { name: /^(Ändern|Change)$/ })
    .click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.waitFor();
  return dialog;
}

function createWorkflowApi() {
  let locale = "en";
  let roles = [":admin"];
  const failures = new Map();
  const injectedErrors = new Set();
  const responses = new Map();
  const heldResponses = new Map();
  const requests = [];
  const unexpected = [];
  let customer = {
    id: "customer-fixture",
    salutation: null,
    name: "Fixture Customer",
    address: { city: "Berlin", streetAddress: "Teststraße 17", zip: "10115" },
    phoneNumbers: [],
    emailAddresses: [],
    createdByUserId: null,
    createdAt: new Date("2026-10-27T08:00:00Z"),
    modifiedAt: new Date("2026-10-27T08:00:00Z"),
  };
  let contacts = [existingContact];
  const date = new Date("2026-10-27T08:00:00Z");
  const chat = {
    id: "fixture-chat",
    title: "Fixture conversation",
    createdAt: date,
    updatedAt: date,
  };
  const archivedChat = {
    id: "archived-chat",
    title: "Archived site discussion",
    createdAt: new Date("2026-09-14T08:00:00Z"),
    updatedAt: new Date("2026-09-15T10:00:00Z"),
  };
  let chats = [chat, archivedChat];
  const chatDetails = new Map([
    [chat.id, { chat, messages: [], proposals: [] }],
    [
      archivedChat.id,
      {
        chat: archivedChat,
        messages: [
          {
            id: "archived-message",
            role: "assistant",
            content: "Saved discussion from last month.",
            createdAt: archivedChat.updatedAt,
          },
        ],
        proposals: [],
      },
    ],
  ]);

  function result(path, input) {
    requests.push({ path, input });
    if (failures.has(path)) {
      throw new Error(failures.get(path));
    }

    if (responses.has(path)) {
      return responses.get(path);
    }

    switch (path) {
      case "auth.sessionInfo":
        return {
          user: {
            id: "fixture-user",
            username: "fixture.user",
            name: "Fixture User",
            locale,
          },
          tenant: {
            id: "fixture-tenant",
            name: "Fixture Tenant",
            companyName: "Fixture Company",
            objectStorageEnabled: true,
          },
          roles,
          hasPassword: true,
        };
      case "customers.get":
        return customer;
      case "customers.contacts.list":
        return contacts;
      case "contacts.list":
        return [existingContact, otherContact].filter((contact) => {
          const query = input?.search?.toLocaleLowerCase() ?? "";
          return `${contact.firstName} ${contact.lastName}`
            .toLocaleLowerCase()
            .includes(query);
        });
      case "customers.update":
        customer = { ...customer, ...input };
        return customer;
      case "customers.contacts.set":
        contacts = [existingContact, otherContact].filter((contact) =>
          input.contactIds.includes(contact.id),
        );
        return true;
      case "remarks.list":
        return [
          {
            id: "fixture-remark",
            body: "Anlieferungen bitte mindestens einen Werktag vorher bei der Bauleitung anmelden.",
            createdByUserId: null,
            createdAt: new Date("2026-10-27T08:00:00Z"),
            modifiedAt: new Date("2026-10-27T08:00:00Z"),
          },
        ];
      case "personalization.visits.list":
        return [
          {
            path: "/customers/customer-fixture",
            title: "Fixture Customer",
            visitedAt: date,
          },
        ];
      case "personalization.actions.list":
      case "personalization.activity.list":
      case "projects.list":
      case "tools.list":
      case "products.list":
      case "llm.admin.usage":
        return [];
      case "customers.list":
        return [customer];
      case "products.vendors.list":
        return [{ id: "vendor-fixture", name: "Fixture Vendor" }].filter(
          (vendor) =>
            vendor.name
              .toLocaleLowerCase()
              .includes(input?.search?.trim().toLocaleLowerCase() ?? ""),
        );
      case "users.list":
        return [];
      case "users.supervisors.getDefault":
        return { userId: null };
      case "settings.tenantLogo.get":
        return { status: "none", downloadUrl: null, error: null };
      case "projects.files.search":
        return input.query === "empty"
          ? []
          : [
              {
                id: "file-fixture",
                projectId: "project-fixture",
                projectTitle: "Fixture Project",
                fileName: "Fixture report.pdf",
                mimeType: "application/pdf",
                textExtractionStatus: "ready",
                excerpt: "Beton <<Müller>> Bauleitung",
                rank: 1,
                modifiedAt: date,
              },
            ];
      case "llm.status":
        return {
          available: roles.includes(":admin"),
          hasRole: roles.includes(":admin"),
          tenantEnabled: true,
        };
      case "llm.chats.list":
        return chats;
      case "llm.chats.create": {
        const created = {
          ...chat,
          id: `created-chat-${chats.length}`,
          title: "New fixture conversation",
        };
        chats = [created, ...chats];
        chatDetails.set(created.id, {
          chat: created,
          messages: [],
          proposals: [],
        });
        return created;
      }
      case "llm.chats.get": {
        const detail = chatDetails.get(input.chatId);

        if (!detail) {
          throw new Error("Synthetic chat not found");
        }

        return detail;
      }
      case "llm.messages.send": {
        const previous = chatDetails.get(input.chatId);

        if (!previous) {
          throw new Error("Synthetic chat not found");
        }

        const updatedChat = {
          ...previous.chat,
          title: previous.messages.length ? previous.chat.title : input.content,
          updatedAt: new Date(date.getTime() + requests.length * 1000),
        };
        const detail = {
          chat: updatedChat,
          proposals: previous.proposals,
          messages: [
            ...previous.messages,
            {
              id: `${input.chatId}-user-${previous.messages.length}`,
              role: "user",
              content: input.content,
              createdAt: date,
            },
            {
              id: `${input.chatId}-assistant-${previous.messages.length}`,
              role: "assistant",
              content:
                "Fixture reply with [source](https://example.invalid/source).",
              createdAt: date,
            },
          ],
        };
        chatDetails.set(input.chatId, detail);
        chats = [
          updatedChat,
          ...chats.filter((item) => item.id !== input.chatId),
        ];
        return detail;
      }
      case "projects.create":
        assert.equal(typeof input.orderReceivedAt, "string");
        assert.equal(input.orderReceivedAt, "2026-10-31T09:30:00.000Z");
        return { id: "created-project", ...input };
      case "llm.proposals.review": {
        const detail = chatDetails.get(chat.id);
        const proposal = detail.proposals.find(
          (item) => item.id === input.proposalId,
        );
        assert.ok(proposal, "Only the seeded proposal can be reviewed");
        detail.proposals = detail.proposals.flatMap((item) => {
          if (item.id !== input.proposalId) {
            return [item];
          }

          if (input.decision === "requestRevision") {
            return [];
          }

          return [
            {
              ...item,
              status: input.decision === "accept" ? "accepted" : "declined",
              executionResults: input.executionResults ?? [],
            },
          ];
        });
        return true;
      }
      case "products.priceImports.apply":
        return true;
      case "errorReports.report":
        if (!injectedErrors.has(input.message)) {
          unexpected.push(`errorReports.report: ${input.message}`);
          throw new Error("Unexpected application error report");
        }

        return { success: true };
      default:
        unexpected.push(path);
        throw new Error(`Unsupported synthetic workflow RPC: ${path}`);
    }
  }

  return {
    requests,
    unexpected,
    seedProposal() {
      chatDetails.get(chat.id).proposals = [
        {
          id: "proposal-fixture",
          chatId: chat.id,
          assistantMessageId: null,
          title: "Dummy-Testprojekt anlegen",
          summary: "Create a project for testing.",
          status: "pending",
          operations: [
            {
              path: "projects.create",
              description: "Create Dummy-Testprojekt",
              input: {
                title: "Dummy-Testprojekt",
                orderReceivedAt: new Date("2026-10-31T09:30:00Z"),
                customerId: null,
                projectLeaderUserId: null,
                address: null,
              },
            },
          ],
          executionResults: [],
          createdAt: date,
        },
      ];
    },
    setLocale(nextLocale) {
      locale = nextLocale;
    },
    setRoles(nextRoles) {
      roles = nextRoles;
    },
    fail(path, message) {
      failures.set(path, message);
      injectedErrors.add(message);
    },
    recover(path) {
      failures.delete(path);
    },
    respond(path, value) {
      responses.set(path, value);
    },
    hold(path) {
      let release;
      const response = new Promise((resolve) => {
        release = resolve;
      });
      heldResponses.set(path, { response, release });
    },
    release(path) {
      heldResponses.get(path)?.release();
      heldResponses.delete(path);
    },
    async handle(route) {
      const request = route.request();
      const headers = {
        "access-control-allow-origin": server.origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers":
          request.headers()["access-control-request-headers"] ??
          "authorization, content-type",
        "cache-control": "no-store",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }

      const url = new URL(request.url());
      const paths = decodeURIComponent(url.pathname.split("/").at(-1)).split(
        ",",
      );
      const inputs = JSON.parse(
        request.method() === "GET"
          ? (url.searchParams.get("input") ?? "{}")
          : (request.postData() ?? "{}"),
      );
      await Promise.all(paths.map((path) => heldResponses.get(path)?.response));

      const results = paths.map((path, index) => {
        try {
          const input = superjson.deserialize(inputs[index]);
          return { result: { data: superjson.serialize(result(path, input)) } };
        } catch (error) {
          return {
            error: superjson.serialize({
              message: error.message,
              data: { code: "BAD_REQUEST" },
            }),
          };
        }
      });
      await route.fulfill({
        status: 200,
        headers,
        contentType: "application/json",
        body: JSON.stringify(results),
      });
    },
  };
}

before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch();
});

beforeEach(async () => {
  context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === server.origin) {
      await route.continue();
      return;
    }

    await route.abort("blockedbyclient");
  });
  api = createWorkflowApi();
  await context.route("http://127.0.0.1:3000/**", api.handle);
  page = await context.newPage();
  page.setDefaultTimeout(6000);
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
});

afterEach(async () => {
  await context.close();
  assert.deepEqual(
    api.unexpected,
    [],
    "Every actual client request needs an explicit fixture",
  );
  assert.deepEqual(
    errors,
    [],
    "Workflow renders must not emit runtime or collection errors",
  );
});

after(async () => {
  await browser.close();
  await server.close();
});

async function openApplication(path, locale = "en", theme = "light") {
  const query = new URLSearchParams({
    screen: "application",
    path,
    locale,
    theme,
  });
  const applicationUrl = new URL(path, server.origin);
  for (const [name, value] of applicationUrl.searchParams) {
    query.set(name, value);
  }

  api.setLocale(locale);
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${server.origin}/controls?${query}`);
  await page.waitForFunction(
    (language) => document.documentElement.lang === language,
    locale,
  );
  await page.evaluate(() => document.fonts.ready);
}

function populateDashboard() {
  const date = new Date("2026-10-27T08:00:00Z");
  const titles = [
    "Fixture Customer",
    "Einsatzplanung",
    "Urlaubsplanung",
    "Werkzeuge",
    "Buchungshistorie",
    "Projekte",
    "Königstraße 23 – Hauseingangstür mit einem langen Projektnamen",
    "LLM",
  ];
  const paths = [
    "/customers/customer-fixture",
    "/deployments",
    "/vacations",
    "/tools",
    "/toolTrackings",
    "/projects",
    "/projects/project-fixture",
    "/llm",
  ];
  api.respond(
    "personalization.visits.list",
    paths.map((path, index) => ({
      path,
      title: titles[index],
      visitedAt: date,
    })),
  );
  api.respond(
    "personalization.actions.list",
    [
      "tools.track",
      "deliveryNotes.create",
      "dailyReports.create",
      "dailyReports.weeklyCreate",
      "regieReports.create",
      "projects.create",
    ].map((actionId) => ({ actionId, usedAt: date })),
  );
}

async function checkDashboardDensity(desktop, zoom = 1) {
  const quickActions = page.locator(".dashboard-quick-actions");
  const visits = page.locator(".dashboard-recent-visits");
  await visits.getByRole("link", { name: /Fixture Customer/ }).waitFor();
  const quickBox = await quickActions.boundingBox();
  const visitsBox = await visits.boundingBox();
  assert.ok(visitsBox.y >= quickBox.y + quickBox.height + 12 * zoom);

  const buttons = await quickActions.getByRole("button").all();
  assert.equal(buttons.length, 6);
  for (const button of buttons) {
    const box = await button.boundingBox();
    assert.ok(
      box.height >= 44 * zoom,
      "Quick actions retain touch-sized targets",
    );
    assert.ok(
      box.width < 300 * zoom,
      "Quick actions must not stretch into grid cells",
    );
  }

  const rows = await visits.locator(".dashboard-visit-row").all();
  assert.equal(rows.length, 8, "Compact layout keeps all recent visits");
  for (const row of rows) {
    const link = await row.getByRole("link").boundingBox();
    const pin = await row.getByRole("button").boundingBox();
    assert.ok(
      link.height >= 44 * zoom,
      "Visit links retain touch-sized targets",
    );
    assert.ok(pin.height >= 44 * zoom && pin.width >= 44 * zoom);
    assert.ok(
      Math.abs(link.y + link.height / 2 - pin.y - pin.height / 2) <= zoom,
      "Pin controls must stay beside their visit, never on a second line",
    );
    assert.ok(
      pin.x >= link.x + link.width,
      "Link and pin targets do not overlap",
    );
  }

  if (desktop) {
    assert.ok(
      visitsBox.height < 230 * zoom,
      "Visits wrap compactly across the card",
    );
    assert.ok(
      quickBox.height < 180 * zoom,
      "Quick actions have no oversized section gaps",
    );
  }
}

for (const [locale, viewport] of [
  ["de", { width: 1400, height: 1000 }],
  ["en", { width: 390, height: 844 }],
]) {
  test(`actual customer editing keeps selected contact IDs unique in ${locale}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/customers/customer-fixture", locale);
    await page
      .getByRole("heading", { name: "Fixture Customer", exact: true })
      .waitFor();
    await page.keyboard.press("Control+e");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog
      .getByRole("button", { name: /(?:Remove|Entfernen) Anna Müller/ })
      .waitFor();
    const input = dialog.getByRole("combobox", {
      name: /Ansprechpartner|Contact/,
    });
    await input.scrollIntoViewIfNeeded();
    await input.click();
    await input.fill("Müll");
    const sameContact = page.getByRole("option", {
      name: "Anna Müller",
      exact: true,
    });
    await sameContact.waitFor();
    assert.equal(await sameContact.count(), 1);
    await input.fill("Schneider");
    await page
      .getByRole("option", { name: "Ben Schneider", exact: true })
      .click();
    await input.press("Escape");
    assert.equal(
      await dialog
        .getByRole("button", {
          name: /(?:Remove|Entfernen) Anna Müller/,
        })
        .count(),
      1,
    );
    assert.equal(
      await dialog
        .getByRole("button", {
          name: /(?:Remove|Entfernen) Ben Schneider/,
        })
        .count(),
      1,
    );
    await dialog.getByRole("button", { name: /^(Speichern|Save)$/ }).click();
    await dialog.waitFor({ state: "hidden" });
    const assignment = api.requests.find(
      (request) => request.path === "customers.contacts.set",
    );
    assert.deepEqual(
      assignment.input.contactIds.sort(),
      [existingContact.id, otherContact.id].sort(),
    );
    assert.equal(
      new URL(page.url()).searchParams.get("path"),
      "/customers/customer-fixture",
    );
  });
}

for (const [layout, viewport] of [
  ["desktop", { width: 1400, height: 1000 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test(`actual password modal stays compact on ${layout}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/fixtures/forms");
    await page
      .getByRole("button", { name: "Set password", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="password"]').first().waitFor();
    const password = await dialog.boundingBox();
    assert.ok(password.height < viewport.height * 0.8);

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  });

  for (const action of ["Create daily report", "Create delivery note"]) {
    test(`actual ${action} sizing and nested Escape on ${layout}`, async () => {
      await page.setViewportSize(viewport);
      await openApplication("/fixtures/forms");
      await page.getByRole("button", { name: action, exact: true }).click();
      const dialog = page
        .getByRole("dialog")
        .and(page.locator("[data-slot=modal-dialog]"));
      await dialog.waitFor();
      await page.waitForFunction(
        () => !document.querySelector("[data-entering]"),
      );
      assert.equal(
        await dialog.evaluate((node) => node === document.activeElement),
        true,
      );
      const firstField = dialog
        .locator(
          ".ss-modal-content input:not([type=hidden]):visible, " +
            ".ss-modal-content select:visible, .ss-modal-content textarea:visible, " +
            ".ss-modal-content button:visible",
        )
        .first();
      await page.keyboard.press("Tab");
      assert.equal(
        await firstField.evaluate((node) => node === document.activeElement),
        true,
      );
      await dialog.getByRole("combobox").first().click();
      const picker = page.getByRole("combobox", { expanded: true }).first();
      await picker.waitFor();
      const form = await dialog.boundingBox();
      assert.ok(
        form.height >= viewport.height - 40,
        `${action} remains a full-size business form`,
      );

      // Deliberate focus opens the picker; Escape dismisses it before its parent form.
      await page.keyboard.press("Escape");
      await dialog.getByRole("combobox", { expanded: false }).first().waitFor();
      assert.equal(await dialog.isVisible(), true);

      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    });
  }
}

async function checkPageLayout(name) {
  const size = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return {
      width,
      scrollWidth: document.documentElement.scrollWidth,
      overflowing: Array.from(document.body.querySelectorAll("*"))
        .filter((element) => element.getBoundingClientRect().right > width + 1)
        .slice(0, 8)
        .map((element) => ({
          tag: element.tagName,
          className: String(element.className),
          width: element.getBoundingClientRect().width,
        })),
    };
  });
  assert.ok(
    size.scrollWidth <= size.width + 1,
    `${name} must fit the viewport: ${JSON.stringify(size)}`,
  );

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  assert.deepEqual(
    accessibility.violations.map(({ id, nodes }) => ({
      id,
      elements: nodes.map(({ target, html, failureSummary }) => ({
        target,
        html,
        failureSummary,
      })),
    })),
    [],
    `${name} must pass the automated WCAG checks`,
  );

  if (process.env.SORTSYS_UI_SCREENSHOTS) {
    await mkdir(process.env.SORTSYS_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({
      path: join(process.env.SORTSYS_UI_SCREENSHOTS, `${name}.png`),
      fullPage: true,
    });
  }
}

for (const [locale, theme, layout, viewport] of [
  ["de", "light", "desktop", { width: 1400, height: 1000 }],
  ["en", "light", "desktop", { width: 1400, height: 1000 }],
  ["de", "dark", "mobile", { width: 390, height: 844 }],
  ["en", "dark", "mobile", { width: 390, height: 844 }],
]) {
  const variant = `${locale}-${theme}-${layout}`;

  test(`actual dashboard stays compact and stacked in ${variant}`, async () => {
    populateDashboard();
    await page.setViewportSize(viewport);
    await openApplication("/dashboard", locale, theme);
    await checkDashboardDensity(layout === "desktop");
    await checkPageLayout(`dashboard-${variant}`);
  });

  test(`actual document results retain search spacing in ${variant}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/documents?q=mueller", locale, theme);
    await page
      .getByRole("link", { name: "Fixture report.pdf", exact: true })
      .waitFor();
    const search = page.getByRole("search");
    const results = page.getByRole("region", {
      name: /Suchergebnisse|Search results/,
    });
    const searchBox = await search.boundingBox();
    const resultBox = await results.boundingBox();
    assert.ok(resultBox.y >= searchBox.y + searchBox.height + 15);
    assert.equal(await results.locator("mark").textContent(), "Müller");
    await checkPageLayout(`documents-${variant}`);

    const input = search.getByRole("searchbox");
    await input.fill("empty");
    await input.press("Enter");
    await page
      .getByRole("status")
      .filter({
        hasText: /Keine passenden Dokumente|No matching documents/,
      })
      .waitFor();
    assert.equal(await page.locator(".documents-search__result").count(), 0);

    api.fail("projects.files.search", "Synthetic document search failure");
    const errorReport = page.waitForResponse((response) =>
      new URL(response.url()).pathname.includes("errorReports.report"),
    );
    await input.fill("failure");
    await input.press("Enter");
    await page.getByText(/Synthetic document search failure/).waitFor();
    await errorReport;
    assert.equal(await page.locator(".documents-search__result").count(), 0);
  });

  test(`actual administration fields stay distinguishable in ${variant}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/admin", locale, theme);
    const company = page.getByRole("textbox", {
      name: /Firmenname|Company name/,
    });
    await company.waitFor();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("input")).some(
        (input) => input.value === "Fixture Company",
      ),
    );
    assert.equal(await company.inputValue(), "Fixture Company");
    await checkPageLayout(`admin-${variant}`);
  });

  test(`actual chat sends once and keeps its composer visible in ${variant}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/llm", locale, theme);
    const composer = page.getByRole("textbox", {
      name: /^(Nachricht|Message)$/,
    });
    await composer.fill("Bitte erkläre den Prüfablauf.");
    await composer.press("Enter");
    const transcript = page.getByRole("log");
    await transcript
      .getByRole("link", { name: "source", exact: true })
      .waitFor();
    const requests = api.requests.filter(
      ({ path }) => path === "llm.messages.send",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input.content, "Bitte erkläre den Prüfablauf.");
    assert.equal(requests[0].input.locale, locale);
    const box = await composer.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= viewport.height);
    await checkPageLayout(`llm-${variant}`);
  });

  test(`actual chat history opens saved conversations in ${variant}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/llm", locale, theme);
    const chatsLabel = "Chats";
    const previousChatsLabel =
      locale === "de" ? "Alte Chats" : "Previous chats";
    const newChatLabel = locale === "de" ? "Neuer Chat" : "New chat";
    const history = page.getByRole("navigation", {
      name: chatsLabel,
      exact: true,
    });
    const archivedLink = () =>
      history.getByRole("link", {
        name: /Archived site discussion/,
      });

    assert.equal(
      await page.getByRole("heading", { name: "LLM", exact: true }).count(),
      0,
    );

    assert.equal(await history.count(), 0);
    assert.equal(await page.locator(".llm-page aside").count(), 0);
    const previousChats = page.getByRole("button", {
      name: previousChatsLabel,
      exact: true,
    });
    const previousChatsBox = await previousChats.boundingBox();
    assert.ok(previousChatsBox.x > viewport.width / 2);
    assert.ok(previousChatsBox.y >= 0 && previousChatsBox.y < 160);
    await previousChats.click();

    await archivedLink().waitFor();
    assert.equal(await history.getByRole("link").count(), 2);
    await archivedLink().click();
    await page
      .getByRole("log")
      .getByText("Saved discussion from last month.")
      .waitFor();
    await page
      .getByRole("heading", {
        name: "Archived site discussion",
        exact: true,
      })
      .waitFor();
    assert.ok(
      api.requests.some(
        ({ path, input }) =>
          path === "llm.chats.get" && input.chatId === "archived-chat",
      ),
    );

    assert.equal(await history.count(), 0);
    const toolbarBox = await page.locator(".llm-page > header").boundingBox();
    assert.ok(
      toolbarBox.height <= 48,
      `Chat toolbar height: ${toolbarBox.height}`,
    );
    await page.getByRole("button", { name: newChatLabel, exact: true }).click();

    await page
      .getByRole("log")
      .getByText("Saved discussion from last month.")
      .waitFor({
        state: "hidden",
      });
    const composer = page.getByRole("textbox", {
      name: /^(Nachricht|Message)$/,
    });
    assert.equal(await composer.inputValue(), "");
    await composer.fill(
      "A new conversation keeps earlier discussions available.",
    );
    await composer.press("Enter");
    await page
      .getByRole("log")
      .getByRole("link", { name: "source", exact: true })
      .waitFor();
    assert.equal(
      api.requests.filter(({ path }) => path === "llm.chats.create").length,
      1,
    );
    const sends = api.requests.filter(
      ({ path }) => path === "llm.messages.send",
    );
    assert.equal(sends.length, 1);
    assert.match(sends[0].input.chatId, /^created-chat-/);
    assert.equal(
      api.requests.filter(({ path }) => /delete|archive/i.test(path)).length,
      0,
    );

    await previousChats.click();

    await history
      .getByRole("link", {
        name: /A new conversation keeps earlier discussions available/,
      })
      .waitFor();
    assert.equal(await history.getByRole("link").count(), 3);
    await archivedLink().click();
    await page
      .getByRole("log")
      .getByText("Saved discussion from last month.")
      .waitFor();
    await checkPageLayout(`llm-saved-history-${variant}`);
  });

  test(`actual chat history searches and expands compactly in ${variant}`, async () => {
    const date = new Date("2026-09-15T10:00:00Z");
    const chats = Array.from({ length: 35 }, (_, index) => ({
      id: `older-chat-${index + 1}`,
      title:
        index === 34
          ? "Older discussion 35 with a very long site and customer reference for mobile layouts"
          : `Older discussion ${index + 1}`,
      createdAt: date,
      updatedAt: date,
    }));
    api.respond("llm.chats.list", chats);
    await page.setViewportSize(viewport);
    await openApplication("/llm/chats", locale, theme);
    const history = page.getByRole("navigation", {
      name: "Chats",
      exact: true,
    });
    const search = history.getByRole("searchbox", {
      name: /Chats durchsuchen|Search chats/,
    });
    const more = history.getByRole("button", {
      name: /^(Mehr anzeigen|Show more)$/,
    });
    await history.getByRole("link").first().waitFor();
    const initialSearchBox = await search.boundingBox();
    assert.equal(await history.getByRole("link").count(), 25);
    assert.equal(
      await more.textContent(),
      locale === "de" ? "Mehr anzeigen" : "Show more",
    );
    await more.click();
    assert.equal(await history.getByRole("link").count(), 35);
    assert.equal(await more.count(), 0);

    const last = history.getByRole("link").last();
    await last.scrollIntoViewIfNeeded();
    const lastBox = await last.boundingBox();
    assert.ok(lastBox.height >= 44, `History row height: ${lastBox.height}`);
    const expandedSearchBox = await search.boundingBox();
    assert.ok(Math.abs(expandedSearchBox.y - initialSearchBox.y) <= 1);
    assert.ok(lastBox.y + lastBox.height <= viewport.height);
    await search.fill("discussion 35");
    assert.equal(await history.getByRole("link").count(), 1);
    assert.equal(await last.getAttribute("title"), chats.at(-1).title);
    await search.fill("nothing matches this title");
    await history
      .getByRole("status")
      .filter({
        hasText: /Keine passenden Chats|No matching chats/,
      })
      .waitFor();
    assert.equal(await history.getByRole("link").count(), 0);
    await search.fill("");
    assert.equal(await history.getByRole("link").count(), 25);
    const first = history.getByRole("link").first();
    await first.hover();
    assert.equal(
      await first.evaluate((element) => getComputedStyle(element).opacity),
      "0.7",
    );
    await checkPageLayout(`llm-search-history-${variant}`);
  });

  test(`actual chat history retries list errors in ${variant}`, async () => {
    api.fail("llm.chats.list", "Synthetic history list failure");
    await page.setViewportSize(viewport);
    await openApplication("/llm/chats", locale, theme);
    const history = page.getByRole("navigation", {
      name: "Chats",
      exact: true,
    });
    await history
      .getByText("Synthetic history list failure", { exact: true })
      .waitFor();
    assert.equal(
      await history.getByText(/Noch keine Chats|No chats yet/).count(),
      0,
    );
    api.recover("llm.chats.list");
    await history
      .getByRole("button", { name: /Chats erneut laden|Reload chats/ })
      .click();
    await history
      .getByRole("link", { name: /Archived site discussion/ })
      .waitFor();
    assert.equal(
      await history.getByText("Synthetic history list failure").count(),
      0,
    );
    assert.ok(
      api.requests.filter(({ path }) => path === "llm.chats.list").length >= 2,
    );
    await checkPageLayout(`llm-history-retry-${variant}`);
  });

  test(`actual empty chat history has one notice in ${variant}`, async () => {
    api.respond("llm.chats.list", []);
    await page.setViewportSize(viewport);
    await openApplication("/llm/chats", locale, theme);
    const history = page.getByRole("navigation", {
      name: "Chats",
      exact: true,
    });
    await history
      .getByRole("status")
      .filter({
        hasText: /Noch keine Chats|No chats yet/,
      })
      .waitFor();
    assert.equal(await history.getByRole("status").count(), 1);
    assert.equal(await history.getByRole("link").count(), 0);
    assert.equal(
      await history
        .getByRole("button", { name: /^(Mehr anzeigen|Show more)$/ })
        .count(),
      0,
    );
    await checkPageLayout(`llm-history-empty-${variant}`);
  });

  test(`actual unavailable chat omits the redundant heading in ${variant}`, async () => {
    api.respond("llm.status", {
      available: false,
      hasRole: true,
      tenantEnabled: true,
    });
    await page.setViewportSize(viewport);
    await openApplication("/llm", locale, theme);
    await page
      .getByText(
        /noch keinen Provider eingerichtet|has not configured a provider/,
      )
      .waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "LLM", exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("textbox", { name: /^(Nachricht|Message)$/ })
        .count(),
      0,
    );
    assert.equal(
      api.requests.filter(({ path }) => path === "llm.chats.create").length,
      0,
    );
  });
}

test("actual chat history distinguishes loading from an empty history", async () => {
  let release;
  let observed;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    observed = resolve;
  });
  await page.route("http://127.0.0.1:3000/**", async (route) => {
    if (
      decodeURIComponent(new URL(route.request().url()).pathname).includes(
        "llm.chats.list",
      )
    ) {
      observed();
      await pending;
    }

    await api.handle(route);
  });

  try {
    await openApplication("/llm/chats");
    await requested;
    const history = page.getByRole("navigation", {
      name: "Chats",
      exact: true,
    });
    await history
      .getByRole("status")
      .filter({ hasText: /Loading/ })
      .waitFor();
    assert.equal(
      await history.getByText("No chats yet", { exact: true }).count(),
      0,
    );
    release();
    await history
      .getByRole("link", { name: /Archived site discussion/ })
      .waitFor();
    assert.equal(
      await history.getByText("Loading", { exact: true }).count(),
      0,
    );
  } finally {
    release();
  }
});

for (const [layout, viewport] of [
  ["desktop", { width: 1400, height: 1000 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test(`actual global search remains top anchored on ${layout}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/fixtures/forms");
    const trigger = page.getByRole("button", {
      name: "Global search",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    const search = dialog.getByRole("searchbox", { name: "Command or search" });
    await search.waitFor();
    await dialog.evaluate(async () => {
      const animations = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        );
      await Promise.all(
        animations.map((animation) =>
          animation.finished.catch(() => undefined),
        ),
      );
    });
    const initialBox = await search.boundingBox();
    await search.fill("Fixture Customer");
    await dialog.getByRole("option", { name: /Fixture Customer/ }).waitFor();
    const searchBox = await search.boundingBox();
    const resultsBox = await dialog.getByRole("listbox").boundingBox();
    assert.ok(
      Math.abs(searchBox.y - initialBox.y) <= 1,
      `Search position changed: ${JSON.stringify({ initialBox, searchBox })}`,
    );
    assert.ok(resultsBox.y >= searchBox.y + searchBox.height);
    await checkPageLayout(`global-search-${layout}`);

    await search.press("ArrowDown");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "Fixture Customer", exact: true })
      .waitFor();
  });

  test(`actual notes keep compact amber cards and icon-only actions on ${layout}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/customers/customer-fixture");
    const body = page.getByText(
      "Anlieferungen bitte mindestens einen Werktag vorher bei der Bauleitung anmelden.",
      { exact: true },
    );
    await body.waitFor();
    const metrics = await body.evaluate((element) => {
      const card = element.closest(".card");
      const time = card.querySelector("time");
      return {
        amber: card.classList.contains("bg-warning-soft"),
        gap:
          element.getBoundingClientRect().top -
          time.getBoundingClientRect().bottom,
      };
    });
    assert.equal(metrics.amber, true);
    assert.ok(metrics.gap >= 0 && metrics.gap <= 8, `Note gap: ${metrics.gap}`);
    const actions = page.getByRole("button", {
      name: "Note actions",
      exact: true,
    });
    assert.equal((await actions.textContent()).trim(), "");
    await checkPageLayout(`customer-notes-${layout}`);
  });

  test(`actual price imports append batches and retain absolute edits on ${layout}`, async () => {
    await page.setViewportSize(viewport);
    await openApplication("/fixtures/forms");
    await page
      .getByRole("button", { name: "Import price list", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const rows = dialog.locator("article.price-import-row");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 10);
    const selectShown = dialog.getByRole("checkbox", {
      name: "All shown rows",
      exact: true,
    });
    await dialog.getByText("All shown rows", { exact: true }).click();
    assert.equal(await selectShown.isChecked(), false);
    const more = dialog.getByRole("button", { name: "Show more", exact: true });
    await more.click();
    assert.equal(await rows.count(), 20);
    assert.equal(
      await dialog
        .getByRole("checkbox", { name: "Include price 1", exact: true })
        .isChecked(),
      false,
    );
    assert.equal(
      await dialog
        .getByRole("checkbox", { name: "Include price 11", exact: true })
        .isChecked(),
      true,
    );

    await dialog
      .getByRole("button", {
        name: "Open details for Fixture material 11",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Edited material 11");
    await dialog.locator('input[id$="-net-price"]').fill("17.5");
    await dialog
      .getByRole("button", { name: "Back to list", exact: true })
      .click();
    assert.equal(await rows.count(), 20);
    const rowTrigger = dialog.getByRole("button", {
      name: "Open details for Edited material 11",
      exact: true,
    });
    assert.equal(
      await rowTrigger.evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(
      await dialog
        .getByRole("combobox", { name: "Vendor", exact: true })
        .getAttribute("aria-expanded"),
      "false",
    );
    await more.click();
    assert.equal(await rows.count(), 23);
    assert.equal(
      await dialog
        .getByRole("button", { name: "Previous", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await dialog.getByRole("button", { name: "Next", exact: true }).count(),
      0,
    );
    await dialog.getByText("All shown rows", { exact: true }).click();
    assert.equal(await selectShown.isChecked(), true);
    const firstPrice = dialog.getByRole("checkbox", {
      name: "Include price 1",
      exact: true,
    });
    await firstPrice.focus();
    await firstPrice.press("Space");
    assert.equal(await firstPrice.isChecked(), false);

    const vendor = dialog.getByRole("combobox", {
      name: "Vendor",
      exact: true,
    });
    await vendor.click();
    await vendor.fill("Fixture");
    await page
      .getByRole("option", { name: "Fixture Vendor", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Save prices", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const submission = api.requests.find(
      ({ path }) => path === "products.priceImports.apply",
    );
    assert.equal(submission.input.rows.length, 22);
    assert.equal(submission.input.rows[0].productName, "Fixture material 2");
    assert.equal(
      submission.input.rows.at(-1).productName,
      "Fixture material 23",
    );
    const edited = submission.input.rows.find(
      ({ productName }) => productName === "Edited material 11",
    );
    assert.equal(edited.pricePerBaseUnit, 17.5);
  });
}

test("actual restricted roles cannot use administration or the LLM composer", async () => {
  api.setRoles([]);
  await openApplication("/admin");
  await page.getByRole("heading", { level: 1 }).waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: /Firmenname|Company name/ })
      .count(),
    0,
  );

  await openApplication("/llm");
  await page
    .getByText("You do not have the :llm role.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Message", exact: true }).count(),
    0,
  );
  assert.equal(
    api.requests.some(({ path }) => path === "llm.messages.send"),
    false,
  );
});

function populatePlanning(employeeCount = 1) {
  const project = { id: "project-fixture", title: "Fixture project" };
  const employee = {
    id: "employee-fixture",
    username: "fixture.employee",
    firstName: "Anna",
    lastName: "Fixture",
    archivedAt: null,
  };
  api.respond("projects.list", [project]);
  api.respond("projects.get", project);
  const employees = Array.from({ length: employeeCount }, (_, index) => ({
    ...employee,
    id: index === 0 ? employee.id : `employee-fixture-${index}`,
    lastName: index === 0 ? employee.lastName : `Fixture ${index}`,
  }));

  api.respond("users.list", employees);
  api.respond("users.get", employee);
  api.respond("users.vacations.list", []);
  api.respond("projects.unavailability.list", []);
  api.respond(
    "projects.deployments.list",
    employees.map((plannedEmployee, index) => ({
      id: index === 0 ? "deployment-fixture" : `deployment-fixture-${index}`,
      projectId: project.id,
      userId: plannedEmployee.id,
      from: new Date("2026-10-27T09:00:00Z"),
      to: new Date("2026-10-27T17:00:00Z"),
      note: "Fixture deployment",
    })),
  );
}

function populateAttachments() {
  const date = new Date("2026-10-27T08:00:00Z");
  const document = {
    id: "file-fixture",
    projectId: "project-fixture",
    folderId: null,
    fileName: "Specification.pdf",
    mimeType: "application/pdf",
    kind: "file",
    sizeBytes: 2048,
    status: "uploaded",
    textExtractionStatus: "ready",
    createdByUserId: "fixture-user",
    createdAt: date,
    modifiedAt: date,
    uploadedAt: date,
  };
  const image =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
    "AAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  api.respond("projects.files.list", [
    document,
    {
      ...document,
      id: "nested-file-fixture",
      folderId: "folder-fixture",
      fileName: "Plan.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      ...document,
      id: "photo-fixture",
      fileName: "Site photo.png",
      kind: "image",
      mimeType: "image/png",
      thumbnailStatus: "ready",
      thumbnailUrl: image,
      downloadUrl: image,
    },
  ]);
  api.respond("projects.files.folders.list", [
    {
      id: "folder-fixture",
      projectId: "project-fixture",
      parentFolderId: null,
      name: "Plans",
      createdAt: date,
      modifiedAt: date,
    },
  ]);
}

test("production email worker reads Outlook MSG and MIME EML messages", async () => {
  const { assets } = JSON.parse(
    await readFile(join(fixtureDirectory, "assets.json"), "utf8"),
  );
  const worker = (await readdir(join(assets, "assets")))
    .find(name => /^emailPreview\.worker-.*\.js$/.test(name));
  assert.ok(worker, "Exercise the actual production worker bundle");
  await page.goto(server.origin);
  for (const [format, bytes, subject] of [
    ["eml", new TextEncoder().encode("From: sender@example.test\r\nSubject: MIME email\r\n\r\nHello email."), "MIME email"],
    ["msg", new Uint8Array(makeMsgFixture()), "Baufortschritt – Grüße"],
    ["msg", new Uint8Array(makeMsgFixture({ rtfOnly: true })), "Baufortschritt – Grüße"],
  ]) {
    const result = await page.evaluate(({ path, format, bytes }) => new Promise((resolve, reject) => {
      const worker = new Worker(path, { type: "module" });
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error("Production email worker timed out"));
      }, 5000);
      worker.onmessage = event => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = event => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message));
      };
      const buffer = new Uint8Array(bytes).buffer;
      worker.postMessage({ bytes: buffer, format }, [buffer]);
    }), { path: `/assets/${worker}`, format, bytes: Array.from(bytes) });
    assert.equal(result.error, undefined);
    assert.equal(result.mail.subject, subject);
    if (format === "msg") assert.equal(result.mail.attachments[0].fileName, "Lieferschein.txt");
  }
});

for (const locale of ["de", "en"]) {
  test(`dashboard wraps six quick actions on one wide row in ${locale}`, async () => {
    populateDashboard();
    await page.setViewportSize({ width: 2200, height: 1000 });
    await openApplication("/dashboard", locale);
    await checkDashboardDensity(true);
    const buttons = await page.locator(".dashboard-quick-actions button").all();
    const boxes = await Promise.all(
      buttons.map((button) => button.boundingBox()),
    );
    assert.ok(boxes.every((box) => Math.abs(box.y - boxes[0].y) <= 1));
    const visits = await page.locator(".dashboard-recent-visits").boundingBox();
    assert.ok(
      visits.height <= 140,
      `Eight visits occupy at most two compact rows: ${JSON.stringify(
        await page.locator(".dashboard-recent-visits").evaluate((card) => {
          return [
            card,
            ...card.querySelectorAll(
              "h3, .dashboard-visit-list, .dashboard-visit-row",
            ),
          ].map((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              className: element.className,
              y: rect.y,
              height: rect.height,
              padding: style.padding,
              gap: style.gap,
              minHeight: style.minHeight,
              fontSize: style.fontSize,
            };
          });
        }),
      )}`,
    );
    await checkPageLayout(`dashboard-wide-${locale}`);
  });
}

test("compact dashboard reflows at 200 percent zoom", async () => {
  populateDashboard();
  await openApplication("/dashboard");
  await page.locator(".dashboard-recent-visits a").first().waitFor();
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await checkDashboardDensity(false, 2);
  await checkPageLayout("dashboard-zoom-200");
});

const dashboardPinningTestName =
  "compact dashboard retains pinning, keyboard reorder, persistence and navigation";

test(dashboardPinningTestName, async () => {
  populateDashboard();
  await openApplication("/dashboard");
  const recent = page.locator(".dashboard-recent-visits");
  await recent.getByRole("link", { name: /Fixture Customer/ }).waitFor();
  const deploymentRow = recent
    .locator(".dashboard-visit-row")
    .filter({ has: page.locator('a[href="/deployments"]') });
  const customerRow = recent
    .locator(".dashboard-visit-row")
    .filter({ has: page.locator('a[href="/customers/customer-fixture"]') });
  await deploymentRow.getByRole("button").click();
  await customerRow.getByRole("button").click();
  const pinned = page.locator(".dashboard-pinned-visits");
  await pinned.locator(".dashboard-visit-row").nth(1).waitFor();
  await pinned.locator(".dashboard-visit-row").first().focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => {
    return (
      document
        .querySelector(".dashboard-pinned-visits a")
        ?.getAttribute("href") === "/deployments"
    );
  });
  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => {
      return key.startsWith("webapp::dashboard.pinnedVisits:");
    });
    return JSON.parse(localStorage.getItem(key) || "[]");
  });
  assert.deepEqual(
    stored.map((visit) => visit.path),
    ["/deployments", "/customers/customer-fixture"],
  );
  await page.reload();
  await pinned.locator(".dashboard-visit-row").nth(1).waitFor();
  assert.equal(
    await pinned.getByRole("link").first().getAttribute("href"),
    "/deployments",
  );
  const deploymentPin = pinned.locator(".dashboard-visit-row").first();
  const customerPin = pinned.locator(".dashboard-visit-row").last();
  const customerBox = await customerPin.boundingBox();
  await deploymentPin.dragTo(customerPin, {
    targetPosition: { x: customerBox.width - 2, y: customerBox.height / 2 },
  });
  await page.waitForFunction(() => {
    return (
      document
        .querySelector(".dashboard-pinned-visits a")
        ?.getAttribute("href") === "/customers/customer-fixture"
    );
  });
  await pinned
    .locator(".dashboard-visit-row")
    .first()
    .getByRole("button")
    .click();
  await page.waitForFunction(() => {
    return (
      document.querySelectorAll(".dashboard-pinned-visits .dashboard-visit-row")
        .length === 1
    );
  });
  await checkPageLayout("dashboard-pins");
  await recent.getByRole("link", { name: /Fixture Customer/ }).click();
  await page
    .getByRole("heading", { name: "Fixture Customer", exact: true })
    .waitFor();
});

for (const [locale, theme, viewport] of [
  ["de", "light", { width: 1400, height: 1000 }],
  ["en", "dark", { width: 1400, height: 1000 }],
  ["de", "dark", { width: 390, height: 844 }],
  ["en", "light", { width: 390, height: 844 }],
]) {
  const variant = `${locale}-${theme}-${viewport.width}`;

  const planningTestName = [
    "actual planning uses native controls and retains views and search",
    variant,
  ].join(" in ");

  test(planningTestName, async () => {
    populatePlanning();
    await page.setViewportSize(viewport);
    await openApplication("/deployments?day=2026-10-27", locale, theme);
    const calendar = page.getByRole("region", {
      name: /Einsatzplanung|Resource planning/,
    });
    await calendar
      .getByRole("button", { name: /Fixture deployment/ })
      .first()
      .waitFor();
    const week = page.getByRole("button", { name: /^(Woche|Week)$/ });
    await page
      .getByRole("button", { name: /^(Woche|Week)$/, pressed: true })
      .waitFor();
    assert.ok((await week.getAttribute("class")).includes("button--primary"));
    await week.hover();
    await checkPageLayout(`planning-week-${variant}`);
    await calendar.focus();
    assert.equal(
      await calendar.evaluate((element) => element === document.activeElement),
      true,
    );
    await page.getByRole("button", { name: /^(Tag|Day)$/ }).click();
    await page
      .getByRole("button", { name: /^(Tag|Day)$/, pressed: true })
      .waitFor();
    await page.locator(".pep-board .pep-entry").first().waitFor();
    await page
      .getByRole("button", { name: /^(Mitarbeitende|Employees)$/ })
      .click();
    await page
      .getByRole("button", {
        name: /^(Mitarbeitende|Employees)$/,
        pressed: true,
      })
      .waitFor();
    const search = page.getByRole("searchbox", {
      name: /Planung durchsuchen|Search planning/,
    });
    await search.fill("no matching planning fixture");
    await page.locator(".pep-empty-row").waitFor();
    await page
      .getByRole("button", { name: /Suche löschen|Clear search/ })
      .click();
    await page.locator(".pep-board .pep-entry").first().waitFor();
    assert.equal(await search.inputValue(), "");
    await page
      .getByRole("button", {
        name: /^(Mitarbeitende|Employees)$/,
        pressed: true,
      })
      .hover();
    const radius = await page
      .locator(".pep-entry")
      .first()
      .evaluate((element) => {
        return parseFloat(getComputedStyle(element).borderTopLeftRadius);
      });
    assert.ok(radius >= 6, "Planning entries follow the rounded shared design");
    await checkPageLayout(`planning-day-${variant}`);
  });

  const attachmentsTestName = [
    "actual attachments retain folders, search, selection and compact controls",
    variant,
  ].join(" in ");

  test(attachmentsTestName, async () => {
    populateAttachments();
    await page.setViewportSize(viewport);
    await openApplication("/projects/project-fixture/files", locale, theme);
    const browser = page.getByRole("region", {
      name: /Dateiablage|File storage/,
    });
    await browser.getByRole("button", { name: /Specification.pdf/ }).waitFor();
    assert.equal(
      await browser.locator(".project-file-browser__row").count(),
      2,
    );
    const search = browser.getByRole("searchbox");
    await search.fill("missing attachment fixture");
    await browser.getByRole("status").waitFor();
    assert.equal(await browser.getByRole("status").count(), 1);
    await search.fill("");
    await browser.getByRole("button", { name: "Plans", exact: true }).click();
    await browser.getByRole("button", { name: /Plan.xlsx/ }).waitFor();
    assert.equal(
      await browser.locator(".project-file-browser__row").count(),
      1,
    );
    await browser
      .getByRole("button", { name: /^(Anhänge|Attachments)$/ })
      .click();
    await browser.getByRole("button", { name: /Specification.pdf/ }).waitFor();
    const fileCheckbox = browser.getByRole("checkbox", {
      name: /Specification.pdf/,
    });
    await fileCheckbox
      .locator("xpath=ancestor::*[@data-slot='checkbox']")
      .click();
    assert.equal(await fileCheckbox.isChecked(), true);
    await page
      .getByRole("button", { name: /Auswahl verschieben|Move selection/ })
      .waitFor();
    const imageSelect = page.locator('[data-image-select-toggle="true"]');
    await imageSelect.waitFor();
    const target = await imageSelect.boundingBox();
    assert.ok(target.width >= 44 && target.height >= 44);
    await imageSelect.click();
    await page
      .locator('[data-image-select-toggle="true"][aria-pressed="true"]')
      .waitFor();
    const card = page.locator(".project-files-image-tile-wrap");
    const geometry = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        radius: parseFloat(style.borderTopLeftRadius),
        ratio: style.aspectRatio,
      };
    });
    assert.ok(geometry.radius >= 8);
    assert.equal(geometry.ratio, "4 / 3");
    await page
      .getByRole("button", { name: /Auswahl aufheben|Clear selection/ })
      .click();
    await page
      .locator('[data-image-select-toggle="true"][aria-pressed="false"]')
      .waitFor();
    await checkPageLayout(`attachments-${variant}`);
    await browser
      .getByRole("button", {
        name: /Datei oder Ordner erstellen|Create file or folder/,
      })
      .click();
    await page.getByRole("menuitem", { name: /^(Ordner|Folder)$/ }).click();
    const dialog = page.getByRole("dialog", {
      name: /^(Neuer Ordner|New folder)$/,
    });
    await dialog.getByRole("textbox").first().waitFor();
    const bounds = await dialog.boundingBox();
    assert.ok(
      bounds.height < viewport.height,
      "One-field folder forms stay compact",
    );
    await dialog.getByRole("button", { name: /Abbrechen|Cancel/ }).click();
    await browser.getByRole("button", { name: /Specification.pdf/ }).waitFor();
  });

  test(`actual email previews decode MSG and EML with compact headers in ${variant}`, async () => {
    const date = new Date("2026-10-27T08:00:00Z");
    const files = ["msg", "eml"].map(format => ({
      id: `email-${format}`,
      projectId: "project-fixture",
      folderId: null,
      fileName: `Correspondence.${format}`,
      mimeType: format === "msg" ? "application/vnd.ms-outlook" : "message/rfc822",
      kind: "file",
      sizeBytes: 2048,
      status: "uploaded",
      textExtractionStatus: "ready",
      createdByUserId: "fixture-user",
      createdAt: date,
      modifiedAt: date,
      uploadedAt: date,
      downloadUrl: `${server.origin}/mail.${format}`,
    }));
    api.respond("projects.files.list", files);
    api.respond("projects.files.folders.list", []);
    await page.route(`${server.origin}/mail.msg`, route => route.fulfill({
      contentType: "application/vnd.ms-outlook", body: Buffer.from(makeMsgFixture()),
    }));
    await page.route(`${server.origin}/mail.eml`, route => route.fulfill({
      contentType: "message/rfc822",
      body: "From: sender@example.test\r\nSubject: MIME email\r\n\r\nHello email.",
    }));
    await page.setViewportSize(viewport);
    await openApplication("/projects/project-fixture/files", locale, theme);
    for (const format of ["msg", "eml"]) {
      const trigger = page.getByRole("button", { name: new RegExp(`Correspondence\\.${format}`) });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: /E-Mail ansehen|View email/ });
      await dialog.locator(".attachment-email-metadata").waitFor();
      assert.equal(await dialog.locator(".ss-modal-label").textContent(), `Correspondence.${format}`);
      const header = await dialog.locator(".ss-modal-header").boundingBox();
      const close = dialog.getByRole("button", { name: /^(Schließen|Close)$/ });
      const bounds = await close.boundingBox();
      assert.ok(header.height <= 44);
      assert.ok(Math.abs(bounds.y + bounds.height / 2 - header.y - header.height / 2) <= 1);
      const body = dialog.frameLocator(".attachment-email-body");
      await body.getByText(format === "msg" ? "Lieferung morgen." : "Hello email.").waitFor();
      if (process.env.SORTSYS_UI_SCREENSHOTS) {
        await mkdir(process.env.SORTSYS_UI_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.SORTSYS_UI_SCREENSHOTS, `email-${format}-${variant}.png`),
          animations: "disabled",
        });
      }
      await close.click();
      await dialog.waitFor({ state: "hidden" });
    }
  });
}

test("actual attachments announce loading and a single empty result", async () => {
  populateAttachments();
  api.respond("projects.files.list", []);
  api.respond("projects.files.folders.list", []);
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("http://127.0.0.1:3000/**", async (route) => {
    const request = route.request();
    const paths = decodeURIComponent(new URL(request.url()).pathname);
    if (
      request.method() !== "OPTIONS" &&
      paths.includes("projects.files.list")
    ) {
      await waiting;
    }

    await api.handle(route);
  });
  try {
    await openApplication("/projects/project-fixture/files");
    await page
      .getByRole("status")
      .filter({ hasText: /Anhänge werden geladen|Loading attachments/ })
      .waitFor();
    assert.equal(await page.locator(".ss-spinner").count(), 1);
    release();
    const browser = page.getByRole("region", {
      name: /Dateiablage|File storage/,
    });
    await browser.getByRole("status").waitFor();
    assert.equal(await page.getByRole("status").count(), 1);
    await checkPageLayout("attachments-empty");
  } finally {
    release();
  }
});

for (const settings of [
  { width: 320, locale: "de", theme: "light" },
  { width: 355, locale: "en", theme: "light" },
  { width: 414, locale: "de", theme: "dark" },
]) {
  const { width, locale, theme } = settings;

  test(`actual absence dates remain adjacent and usable at ${width}px in ${locale}`, async () => {
    await page.setViewportSize({ width, height: 879 });
    api.respond("users.vacations.create", { id: "fixture-absence" });
    await openApplication("/fixtures/forms", locale, theme);
    await page
      .getByRole("button", { name: "Add absence", exact: true })
      .click();
    const dialog = page
      .getByRole("dialog")
      .and(page.locator("[data-slot=modal-dialog]"));
    await dialog.waitFor();
    await page.waitForFunction(
      () => !document.querySelector("[data-entering]"),
    );
    assert.equal(
      await dialog.evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Tab");
    const type = dialog.locator("[data-slot=select-trigger]").first();
    assert.equal(
      await type.evaluate((node) => node === document.activeElement),
      true,
    );
    await type.click();
    await page
      .getByRole("option", { name: /^(Sonstige Abwesenheit|Other absence)$/ })
      .click();
    const label = dialog.getByRole("textbox", {
      name: /^(Bezeichnung|Label)(?: \*)?$/,
    });
    await label.waitFor();
    assert.equal(
      await label.evaluate((node) => node === document.activeElement),
      false,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await label.evaluate((node) => node === document.activeElement),
      true,
    );
    await label.fill("Training");
    await dialog.getByRole("combobox").click();
    await dialog.getByRole("combobox").fill("Fixture");
    await page
      .getByRole("option", { name: "Fixture User", exact: true })
      .click();
    const from = dialog.getByLabel(/^(Von|From)(?: \*)?$/);
    const to = dialog.getByLabel(/^(Bis|To)(?: \*)?$/);
    await from.fill("2026-10-30");
    await to.fill("2026-11-03");
    const boxes = {
      from: await from.boundingBox(),
      to: await to.boundingBox(),
    };
    assert.ok(Math.abs(boxes.from.y - boxes.to.y) <= 1, JSON.stringify(boxes));
    assert.ok(
      boxes.from.x + boxes.from.width <= boxes.to.x,
      JSON.stringify(boxes),
    );
    assert.ok(
      boxes.from.x >= 0 && boxes.to.x + boxes.to.width <= width,
      JSON.stringify(boxes),
    );
    assert.ok(
      boxes.from.width >= 100 && boxes.to.width >= 100,
      JSON.stringify(boxes),
    );
    const body = await dialog.locator(".ss-modal-content").evaluate((node) => ({
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    assert.ok(body.scroll <= body.width + 1, JSON.stringify(body));
    const accessibility = await new AxeBuilder({ page })
      .include("[role=dialog]")
      .analyze();
    assert.deepEqual(accessibility.violations, []);
    await dialog
      .getByRole("button", { name: /^(Eintragen|Add)$/, exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const request = api.requests.find(
      (item) => item.path === "users.vacations.create",
    );
    assert.equal(request.input.userId, "fixture-user");
    assert.equal(request.input.type, "other");
    assert.equal(request.input.label, "Training");
    assert.ok(
      request.input.from instanceof Date && request.input.to instanceof Date,
    );
    assert.ok(request.input.from < request.input.to);
  });
}

for (const settings of [
  { width: 355, locale: "de", theme: "light" },
  { width: 414, locale: "en", theme: "dark" },
]) {
  const { width, locale, theme } = settings;
  const testName = `actual tool options reserve selection space without status chips at ${width}px`;

  test(testName, async () => {
    const tools = [
      {
        id: "tool-eleven",
        customId: 11,
        brand: "Hilti",
        category: "Bohrhammer",
        label: "TE 60 ATC AVR",
        status: null,
        available: false,
      },
      {
        id: "tool-sixty-seven",
        customId: 67,
        brand: "Hilti",
        category: "Kombihammer",
        label: "TE 70 ATC AVR",
        status: null,
        available: true,
      },
    ];
    api.respond("tools.list", tools);
    api.respond("tools.untrack", true);
    api.respond("tools.track", { id: "fixture-tracking" });
    await page.setViewportSize({ width, height: 879 });
    await openApplication("/fixtures/forms", locale, theme);
    await page.getByRole("button", { name: "Book tools", exact: true }).click();
    const dialog = page
      .getByRole("dialog")
      .and(page.locator("[data-slot=modal-dialog]"));
    await dialog.waitFor();
    await page.waitForFunction(
      () => !document.querySelector("[data-entering]"),
    );
    assert.equal(
      await dialog.evaluate((node) => node === document.activeElement),
      true,
    );
    const input = dialog.getByRole("combobox", {
      name: /^(Werkzeuge|Tools)(?: \*)?$/,
    });
    await input.click();
    await input.fill("Hilti");
    const selected = page.getByRole("option", { name: /^11 / });
    const other = page.getByRole("option", { name: /^67 / });
    await other.waitFor();
    assert.equal(await selected.getAttribute("aria-selected"), "true");
    for (const option of [selected, other]) {
      assert.equal(await option.locator(".chip").count(), 0);
      assert.doesNotMatch(
        await option.innerText(),
        /gebucht|verfügbar|booked|available/,
      );
      const content = await option
        .locator(":scope > div")
        .first()
        .boundingBox();
      const indicator = await option
        .locator(".list-box-item__indicator")
        .boundingBox();
      assert.ok(
        content.x + content.width <= indicator.x - 2,
        JSON.stringify({ content, indicator }),
      );
      const bounds = await option.boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width,
        JSON.stringify(bounds),
      );
    }

    await other.click();
    await input.press("Escape");
    await dialog
      .getByRole("button", { name: /^(Remove|Entfernen) 11 / })
      .waitFor();
    await dialog
      .getByRole("button", { name: /^(Remove|Entfernen) 67 / })
      .waitFor();
    await dialog.getByRole("button", { name: /^(Buchen|Book)$/ }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      api.requests
        .filter((request) => request.path === "tools.track")
        .map((request) => request.input.id)
        .sort(),
      ["tool-eleven", "tool-sixty-seven"],
    );
    assert.deepEqual(
      api.requests
        .filter((request) => request.path === "tools.untrack")
        .map((request) => request.input.id),
      ["tool-eleven"],
    );
    const untrackIndex = api.requests.findIndex(
      (request) => request.path === "tools.untrack",
    );
    const trackIndex = api.requests.findIndex(
      (request) => request.path === "tools.track",
    );
    assert.ok(untrackIndex < trackIndex);
    assert.equal(
      api.requests.some((request) => request.path === "errorReports.report"),
      false,
    );
  });
}

async function openScrollablePlanning(width, locale = "de") {
  populatePlanning(24);
  await page.setViewportSize({ width, height: 740 });
  await openApplication("/deployments?day=2026-10-27", locale);
  await page
    .getByRole("button", { name: /^(Mitarbeitende|Employees)$/ })
    .click();
  await page.locator(".pep-week-table tbody tr").nth(23).waitFor();
}

for (const width of [320, 375, 414, 768]) {
  test(`mobile planning columns remain readable at ${width}px`, async () => {
    await openScrollablePlanning(width);
    const matrix = page.locator(".pep-week-wrap");
    const dayColumns = page.locator(
      ".pep-week-table thead th:not(:first-child)",
    );
    assert.equal(await dayColumns.count(), 5);

    for (const day of await dayColumns.all()) {
      const box = await day.boundingBox();
      assert.ok(box.width >= 160, `Day column is only ${box.width}px wide`);
    }

    const firstColumn = page.locator(".pep-week-user-cell").first();
    const before = await firstColumn.boundingBox();
    const scroll = await matrix.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;

      return {
        left: element.scrollLeft,
        horizontal: element.scrollWidth > element.clientWidth,
      };
    });
    assert.ok(scroll.horizontal && scroll.left > 0);

    const after = await firstColumn.boundingBox();
    assert.ok(Math.abs(after.x - before.x) <= 2);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Horizontal scrolling must stay inside the matrix",
    );
  });
}

for (const locale of ["de", "en"]) {
  test(`mobile planning controls scroll away in ${locale}`, async () => {
    await openScrollablePlanning(375, locale);
    await page.mouse.move(300, 650);
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => {
      const controls = document.querySelector(".pep-controls");

      return controls.getBoundingClientRect().bottom <= 64;
    });
    assert.equal(
      await page
        .locator(".pep-week-wrap")
        .evaluate((element) => element.scrollTop),
      0,
      "Mobile planning must not trap vertical scrolling inside the matrix",
    );
  });
}

test("desktop planning retains its contained matrix scrolling", async () => {
  await openScrollablePlanning(1400, "en");
  const controls = page.locator(".pep-controls");
  const before = await controls.boundingBox();
  const scrollTop = await page.locator(".pep-week-wrap").evaluate((element) => {
    element.scrollTop = element.scrollHeight;

    return element.scrollTop;
  });
  assert.ok(scrollTop > 0);

  const after = await controls.boundingBox();
  assert.ok(Math.abs(after.y - before.y) <= 1);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("app locale translates load-more independently of browser language", async () => {
  await page.goto(`${server.origin}/controls?locale=de`);
  await page.waitForFunction(() => document.documentElement.lang === "de");
  await page
    .getByRole("button", { name: "Mehr anzeigen", exact: true })
    .first()
    .waitFor();

  await page.evaluate(() => window.__uiSetLocale("en"));
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await page
    .getByRole("button", { name: "Show more", exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Mehr anzeigen", exact: true })
      .count(),
    0,
  );

  await page.evaluate(() => window.__uiSetLocale("de"));
  await page.waitForFunction(() => document.documentElement.lang === "de");
  await page
    .getByRole("button", { name: "Mehr anzeigen", exact: true })
    .first()
    .waitFor();
});

for (const locale of ["de", "en"]) {
  for (const nested of [false, true]) {
    const name = `project folder creation uses the object menu in ${locale}, nested=${nested}`;

    test(name, async () => {
      populateAttachments();
      api.respond("projects.files.folders.create", {
        id: "created-folder-fixture",
      });
      await page.setViewportSize({ width: 375, height: 812 });
      await openApplication("/projects/project-fixture/files", locale);
      await page.getByRole("button", { name: /Specification.pdf/ }).waitFor();

      if (nested) {
        await page.getByRole("button", { name: "Plans", exact: true }).click();
        await page.getByRole("button", { name: /Plan.xlsx/ }).waitFor();
      }

      const newFolder = locale === "de" ? "Neuer Ordner" : "New folder";
      assert.equal(
        await page
          .getByRole("button", { name: newFolder, exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("button", {
          name:
            locale === "de"
              ? "Datei oder Ordner erstellen"
              : "Create file or folder",
        })
        .click();
      await page
        .getByRole("menuitem", {
          name: locale === "de" ? "Ordner" : "Folder",
          exact: true,
        })
        .click();

      const dialog = page.getByRole("dialog", { name: newFolder });
      await dialog
        .getByRole("textbox", {
          name: locale === "de" ? "Ordnername" : "Folder name",
        })
        .fill("Inspection records");
      await dialog
        .getByRole("button", {
          name: locale === "de" ? "Erstellen" : "Create",
          exact: true,
        })
        .click();
      await dialog.waitFor({ state: "hidden" });
      const requests = api.requests.filter(
        ({ path }) => path === "projects.files.folders.create",
      );
      assert.deepEqual(
        requests.map(({ input }) => input),
        [
          {
            projectId: "project-fixture",
            parentFolderId: nested ? "folder-fixture" : null,
            name: "Inspection records",
          },
        ],
      );
    });
  }
}

function proposalLabels(locale) {
  return locale === "de"
    ? {
        accept: "Annehmen",
        revise: "Überarbeiten",
        decline: "Ablehnen",
        comment: "Änderungswunsch",
        cancel: "Abbrechen",
      }
    : {
        accept: "Accept",
        revise: "Revise",
        decline: "Decline",
        comment: "Requested changes",
        cancel: "Cancel",
      };
}

async function assertProposalColors(accept, decline) {
  async function channels(button) {
    return button.evaluate((node) => {
      const canvas = document.createElement("canvas");
      const drawing = canvas.getContext("2d");
      drawing.fillStyle = getComputedStyle(node).backgroundColor;
      drawing.fillRect(0, 0, 1, 1);
      return Array.from(drawing.getImageData(0, 0, 1, 1).data);
    });
  }

  const green = await channels(accept);
  const red = await channels(decline);
  assert.ok(green[1] > green[0] && green[1] > green[2], String(green));
  assert.ok(red[0] > red[1] && red[0] > red[2], String(red));
}

for (const [locale, theme, width] of [
  ["de", "light", 1400],
  ["en", "dark", 1400],
  ["de", "dark", 390],
  ["en", "light", 390],
]) {
  const variant = `${locale}-${theme}-${width}`;

  test(`proposal acceptance sends revived dates as RFC3339 in ${variant}`, async () => {
    api.seedProposal();
    await page.setViewportSize({ width, height: 900 });
    await openApplication("/llm/fixture-chat", locale, theme);
    const labels = proposalLabels(locale);
    const proposal = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Dummy-Testprojekt anlegen" }),
    });
    const accept = proposal.getByRole("button", {
      name: labels.accept,
      exact: true,
    });
    const decline = proposal.getByRole("button", {
      name: labels.decline,
      exact: true,
    });
    await accept.waitFor();
    const dateLabel = locale === "de" ? "Auftragseingang" : "Order received";
    const dateRow = proposal.locator("dl > div").filter({
      has: page.locator("dt", { hasText: dateLabel }),
    });
    assert.match(await dateRow.locator("dd").innerText(), /2026/);
    assert.equal(await proposal.getByRole("textbox").count(), 0);
    await assertProposalColors(accept, decline);
    await checkPageLayout(`proposal-pending-${variant}`);
    await accept.click();
    await proposal.locator(".assistant-proposal-complete").waitFor();
    const creates = api.requests.filter(
      ({ path }) => path === "projects.create",
    );
    assert.equal(creates.length, 1);
    assert.equal(creates[0].input.orderReceivedAt, "2026-10-31T09:30:00.000Z");
    assert.equal(creates[0].input.customerId, null);
    assert.equal(creates[0].input.projectLeaderUserId, null);
    assert.equal(creates[0].input.address, null);
    const reviews = api.requests.filter(
      ({ path }) => path === "llm.proposals.review",
    );
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].input.decision, "accept");
    assert.equal(reviews[0].input.continueConversation, true);
    assert.equal(
      reviews[0].input.executionResults[0].output.id,
      "created-project",
    );
    const projectLink = proposal.getByRole("link", {
      name: locale === "de" ? "Projekt öffnen" : "Open project",
      exact: true,
    });
    await projectLink.hover();
    assert.equal(
      await projectLink.evaluate((node) => getComputedStyle(node).opacity),
      "0.7",
    );
    await checkPageLayout(`proposal-accepted-${variant}`);
  });

  test(`proposal revision uses a deliberate compact dialog in ${variant}`, async () => {
    api.seedProposal();
    await page.setViewportSize({ width, height: 900 });
    await openApplication("/llm/fixture-chat", locale, theme);
    const labels = proposalLabels(locale);
    const openRevision = page.getByRole("button", {
      name: labels.revise,
      exact: true,
    });
    await openRevision.click();
    const dialog = page.getByRole("dialog", {
      name: labels.revise,
      exact: true,
    });
    await dialog.waitFor();
    await page.waitForFunction(
      () => !document.querySelector("[data-entering]"),
    );
    const field = dialog.getByRole("textbox", {
      name: labels.comment,
      exact: true,
    });
    assert.equal(
      await field.evaluate((node) => node === document.activeElement),
      false,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await field.evaluate((node) => node === document.activeElement),
      true,
    );
    const confirm = dialog.getByRole("button", {
      name: labels.revise,
      exact: true,
    });
    assert.equal(await confirm.isDisabled(), true);
    await field.fill("   ");
    assert.equal(await confirm.isDisabled(), true);
    assert.ok((await dialog.boundingBox()).height < 600);
    await checkPageLayout(`proposal-revision-${variant}`);
    await dialog
      .getByRole("button", { name: labels.cancel, exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      api.requests.some(({ path }) => path === "llm.proposals.review"),
      false,
    );
    assert.equal(
      api.requests.some(({ path }) => path === "llm.messages.send"),
      false,
    );
    assert.equal(
      await page.getByRole("textbox", { name: labels.comment }).count(),
      0,
    );

    await openRevision.click();
    await field.fill("  Set the title to Revised test project.  ");
    api.fail("llm.proposals.review", "Synthetic proposal review failure");
    await confirm.click();
    await dialog
      .getByText("Synthetic proposal review failure", { exact: true })
      .waitFor();
    assert.equal(
      await field.inputValue(),
      "  Set the title to Revised test project.  ",
    );
    assert.equal(
      api.requests.some(({ path }) => path === "llm.messages.send"),
      false,
    );
    assert.equal(
      api.requests.some(({ path }) => path === "projects.create"),
      false,
    );
    api.recover("llm.proposals.review");
    await confirm.click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("log")
      .getByRole("link", { name: "source", exact: true })
      .waitFor();
    const reviews = api.requests.filter(
      ({ path }) => path === "llm.proposals.review",
    );
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].input.decision, "requestRevision");
    assert.equal(
      reviews[1].input.comment,
      "Set the title to Revised test project.",
    );
    const sends = api.requests.filter(
      ({ path }) => path === "llm.messages.send",
    );
    assert.equal(sends.length, 1);
    assert.match(
      sends[0].input.content,
      /Set the title to Revised test project\./,
    );
    assert.equal(
      api.requests.some(({ path }) => path === "projects.create"),
      false,
    );
    await page.waitForFunction(() => !document.querySelector("[data-exiting]"));
    await checkPageLayout(`proposal-revised-${variant}`);
  });

  test(`proposal decline stays a single review without execution in ${variant}`, async () => {
    api.seedProposal();
    await page.setViewportSize({ width, height: 900 });
    await openApplication("/llm/fixture-chat", locale, theme);
    const labels = proposalLabels(locale);
    await page
      .getByRole("button", { name: labels.decline, exact: true })
      .click();
    await page.locator(".assistant-proposal-declined").waitFor();
    const reviews = api.requests.filter(
      ({ path }) => path === "llm.proposals.review",
    );
    assert.equal(reviews.length, 1);
    assert.deepEqual(reviews[0].input, {
      proposalId: "proposal-fixture",
      decision: "decline",
      comment: null,
    });
    assert.equal(
      api.requests.some(({ path }) => path === "projects.create"),
      false,
    );
    assert.equal(
      api.requests.some(({ path }) => path === "llm.messages.send"),
      false,
    );
    await checkPageLayout(`proposal-declined-${variant}`);
  });

  test(`unboxed chat history retains inner padding in ${variant}`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await openApplication("/llm/chats", locale, theme);
    const history = page.getByRole("region", { name: "Chats", exact: true });
    await history
      .getByRole("link", { name: /Archived site discussion/ })
      .waitFor();
    const style = await history.evaluate((node) => {
      const css = getComputedStyle(node);
      return {
        padding: [
          css.paddingTop,
          css.paddingRight,
          css.paddingBottom,
          css.paddingLeft,
        ],
        radius: css.borderRadius,
        shadow: css.boxShadow,
      };
    });
    assert.ok(style.padding.every((value) => parseFloat(value) >= 12));
    assert.equal(style.radius, "0px");
    assert.equal(style.shadow, "none");
    assert.equal(await history.locator(".card").count(), 0);
    await checkPageLayout(`history-unboxed-padded-${variant}`);
  });
}

for (const locale of ["de", "en"]) {
  test(`pending proposal revision blocks duplicate submission in ${locale}`, async () => {
    api.seedProposal();
    api.hold("llm.proposals.review");
    await openApplication("/llm/fixture-chat", locale);
    const labels = proposalLabels(locale);
    await page
      .getByRole("button", { name: labels.revise, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: labels.revise,
      exact: true,
    });
    const field = dialog.getByRole("textbox", {
      name: labels.comment,
      exact: true,
    });
    await field.fill("Change the project title.");
    const confirm = dialog.getByRole("button", {
      name: labels.revise,
      exact: true,
    });
    await confirm.click();

    try {
      await dialog
        .getByText(
          locale === "de"
            ? "Überarbeitung wird angefordert."
            : "Requesting revision.",
          { exact: true },
        )
        .waitFor();
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(await field.isDisabled(), true);
      assert.equal(
        await dialog
          .getByRole("button", { name: labels.cancel, exact: true })
          .isDisabled(),
        true,
      );
      await confirm.dispatchEvent("click");
      await page.keyboard.press("Escape");
      assert.equal(await dialog.isVisible(), true);
      await checkPageLayout(`proposal-pending-review-${locale}`);
    } finally {
      api.release("llm.proposals.review");
    }

    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("log")
      .getByRole("link", { name: "source", exact: true })
      .waitFor();
    assert.equal(
      api.requests.filter(({ path }) => path === "llm.proposals.review").length,
      1,
    );
    assert.equal(
      api.requests.filter(({ path }) => path === "llm.messages.send").length,
      1,
    );
  });
}

test("proposal mutation failure keeps review pending and allows retry", async () => {
  api.seedProposal();
  api.fail("projects.create", "Synthetic project creation failure");
  await openApplication("/llm/fixture-chat");
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await accept.click();
  await page
    .getByText("Create Dummy-Testprojekt: Synthetic project creation failure")
    .waitFor();
  assert.equal(await accept.isEnabled(), true);
  assert.equal(
    api.requests.some(({ path }) => path === "llm.proposals.review"),
    false,
  );
  api.recover("projects.create");
  await accept.click();
  await page.locator(".assistant-proposal-complete").waitFor();
  assert.equal(
    api.requests.filter(({ path }) => path === "projects.create").length,
    2,
  );
  assert.equal(
    api.requests.filter(({ path }) => path === "llm.proposals.review").length,
    1,
  );
});

for (const { locale, theme, width } of [
  { locale: "de", theme: "light", width: 1400 },
  { locale: "en", theme: "dark", width: 390 },
]) {
  test(`admin error details open only in a modal in ${locale}`, async () => {
    const report = {
      id: "synthetic-error",
      tenant: "Fixture Tenant",
      source: "webapp",
      message: "Synthetic error summary",
      createdAt: new Date("2026-10-27T08:00:00Z"),
      username: "fixture.user",
      createdByUserId: null,
      path: `/projects/${"long-path-".repeat(30)}`,
      stack: `Synthetic trace ${"x".repeat(200)}`,
      componentStack: "Synthetic component trace",
      metadata: { fixture: true },
      userAgent: "Synthetic browser agent",
    };
    api.respond("admin.errors.list", [report]);
    await page.setViewportSize({ width, height: 1000 });
    await openApplication("/__admin/errors", locale, theme);
    const message = page.getByRole("button", { name: report.message });
    await message.waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(
      await page.getByText(report.stack, { exact: true }).count(),
      0,
    );

    if (width > 1000) {
      const row = message.locator("xpath=ancestor::tr");
      assert.equal(
        await row.evaluate((node) => getComputedStyle(node).cursor),
        "pointer",
      );
    }

    await message.click();
    const dialog = page.getByRole("dialog", { name: report.message });
    await dialog.getByText(report.stack, { exact: true }).waitFor();
    await dialog.getByText(report.componentStack, { exact: true }).waitFor();
    const trace = dialog.locator("pre").filter({ hasText: report.stack });
    await trace.focus();
    assert.equal(
      await trace.evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
    await checkPageLayout(`admin-error-modal-${locale}`);
    await dialog.getByRole("button", { name: /^(Schließen|Close)$/ }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.getByText(report.stack, { exact: true }).count(),
      0,
    );
  });

  test(`admin import selects verified vision models only in ${locale}`, async () => {
    seedAdminModels();
    api.hold("admin.llm.providers.models");
    await page.setViewportSize({ width, height: 1000 });
    await openApplication("/__admin/llm", locale, theme);
    const title = locale === "de" ? "Einlesen" : "Document import";
    const dialog = await openModelDialog(title);
    const save = dialog.getByRole("button", { name: /^(Speichern|Save)$/ });
    assert.equal(await save.isDisabled(), true);
    api.release("admin.llm.providers.models");
    await dialog.getByText(/gespeicherte Modell|saved model/).waitFor();
    const model = dialog.getByRole("button", { name: /\b(Modell|Model)\b/ });
    await model.click();
    await page
      .getByRole("option", { name: "Verified vision", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("option", { name: "Text only" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("option", { name: "Unverified model" }).count(),
      0,
    );
    await page.waitForFunction(
      () => !document.querySelector("[data-entering]"),
    );
    await checkPageLayout(`admin-import-options-${locale}`);
    await page
      .getByRole("option", { name: "Verified vision", exact: true })
      .click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    await checkPageLayout(`admin-import-model-${locale}`);
    await save.click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      api.requests
        .filter(({ path }) => path === "admin.llm.useCases.update")
        .map(({ input }) => input),
      [
        {
          useCase: "documentImport",
          provider: "openrouter",
          model: "vision-model",
        },
      ],
    );
  });

  test(`client scripts show an editor only after selection in ${locale}`, async () => {
    const script = {
      id: "synthetic-script",
      name: "Fixture script",
      description: "Synthetic preview only",
      enabled: true,
      code: "const fixturePreview = true;",
      createdAt: new Date("2026-10-27T08:00:00Z"),
      modifiedAt: new Date("2026-10-27T08:00:00Z"),
    };
    api.respond("clientScripts.list", [script]);
    api.respond("clientScripts.get", script);
    api.hold("clientScripts.get");
    await page.setViewportSize({ width, height: 1000 });
    await openApplication("/scripts", locale, theme);
    const item = page.getByRole("button", { name: /Fixture script/ });
    await item.waitFor();
    assert.equal(await page.locator(".script-editor-tile").count(), 0);
    assert.equal(
      api.requests.some(({ path }) => path === "clientScripts.get"),
      false,
    );
    await item.click();
    assert.equal(await page.locator(".script-code-preview").count(), 0);
    api.release("clientScripts.get");
    const editor = page.locator(".script-editor-tile");
    await editor.getByRole("textbox", { name: "Name", exact: true }).waitFor();
    await editor
      .locator(".script-code-preview-content")
      .getByText(script.code)
      .waitFor();
    const checkbox = editor.getByRole("checkbox", { name: /^(Aktiv|Active)$/ });
    assert.equal(await checkbox.isChecked(), true);
    const alignment = await checkbox.evaluate((node) => {
      const label = node.closest("label").getBoundingClientRect();
      const field = document
        .querySelector("#script-name")
        .getBoundingClientRect();
      return {
        label: label.y + label.height / 2,
        field: field.y + field.height / 2,
      };
    });

    if (width > 1000) {
      assert.ok(Math.abs(alignment.label - alignment.field) <= 5);
    }

    await checkPageLayout(`client-script-selected-${locale}`);
    const token = editor
      .locator(".script-code-preview-content")
      .getByText("const", { exact: true });
    const initialColor = await token.evaluate(
      (node) => getComputedStyle(node).color,
    );
    const nextTheme = theme === "dark" ? "light" : "dark";
    await page.emulateMedia({ colorScheme: nextTheme });
    await page.evaluate((next) => {
      document.documentElement.classList.toggle("dark", next === "dark");
      document.documentElement.dataset.theme = next;
      document.body.dataset.ssTheme = next;
    }, nextTheme);
    await page.waitForFunction((previous) => {
      const keyword = [
        ...document.querySelectorAll(".script-code-preview-content span"),
      ].find((node) => node.textContent === "const");

      return keyword && getComputedStyle(keyword).color !== previous;
    }, initialColor);
    await page.evaluate(async () => {
      const transitions = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        );
      await Promise.all(
        transitions.map((animation) =>
          animation.finished.catch(() => undefined),
        ),
      );
    });
    await checkPageLayout(`client-script-switched-${locale}`);
    assert.equal(
      api.requests.some(({ path }) => path === "clientScripts.update"),
      false,
    );
  });
}

for (const state of ["empty", "error"]) {
  test(`admin import cannot save with ${state} model metadata`, async () => {
    seedAdminModels();

    if (state === "error") {
      api.fail(
        "admin.llm.providers.models",
        "Synthetic model catalogue failure",
      );
    } else {
      api.respond(
        "admin.llm.providers.models",
        importModelOptions.filter((model) => model.supportsImageInput !== true),
      );
    }

    await openApplication("/__admin/llm");
    const dialog = await openModelDialog("Document import");
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await dialog.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await save.isDisabled(), true);
    assert.equal(
      await dialog.getByRole("button", { name: /\bModel\b/ }).isDisabled(),
      true,
    );
    assert.equal(
      api.requests.some(({ path }) => path === "admin.llm.useCases.update"),
      false,
    );

    api.recover("admin.llm.providers.models");
    api.respond("admin.llm.providers.models", importModelOptions);
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    const model = dialog.getByRole("button", { name: /\bModel\b/ });
    await model.click();
    await page
      .getByRole("option", { name: "Verified vision", exact: true })
      .click();
    assert.equal(await save.isEnabled(), true);
  });
}

test("admin chat still offers text models", async () => {
  seedAdminModels();
  await openApplication("/__admin/llm");
  const dialog = await openModelDialog("Chat");
  await dialog.getByRole("button", { name: /\bModel\b/ }).click();
  await page.getByRole("option", { name: "Text only", exact: true }).waitFor();
  await page
    .getByRole("option", { name: "Verified vision", exact: true })
    .waitFor();
});

test("client scripts do not render a draft editor for an empty listing", async () => {
  api.respond("clientScripts.list", []);
  await openApplication("/scripts");
  await page.getByText("No scripts yet.", { exact: true }).waitFor();
  assert.equal(await page.locator(".script-editor-tile").count(), 0);
  assert.equal(await page.locator(".script-code-preview").count(), 0);
  assert.equal(
    api.requests.some(({ path }) => path === "clientScripts.get"),
    false,
  );
  await checkPageLayout("client-scripts-empty");
});
