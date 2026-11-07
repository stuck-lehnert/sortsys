import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import superjson from "superjson";
import * as Y from "yjs";
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
  let gaebView = {
    showFields: true,
    outlineOpen: true,
    outlineWidth: 320,
    ribbonCollapsed: false,
    zoom: null,
  };
  let documentTemplate = { source: null, revision: "0", assets: [] };
  let invoiceNumbering = { scheme: "sequential", startNumber: "1" };
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
      const response = responses.get(path);
      return typeof response === "function" ? response(input) : response;
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
      case "personalization.gaebView.get":
        return gaebView;
      case "personalization.gaebView.set":
        gaebView = input;
        return { success: true };
      case "settings.documentTemplate.get":
        return documentTemplate;
      case "settings.documentTemplate.set":
        documentTemplate = {
          ...documentTemplate,
          source: input.source,
          revision: "test-revision",
        };
        return { source: input.source, revision: documentTemplate.revision };
      case "settings.invoiceNumbering.get":
        return invoiceNumbering;
      case "settings.invoiceNumbering.set":
        invoiceNumbering = input;
        return { success: true };
      case "settings.organization.get":
        return {
          companyName: "Fixture Company",
          address: {
            streetAddress: "Bauweg 12",
            zip: "06108",
            city: "Halle",
            country: "Deutschland",
          },
        };
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
  await page.goto(
    `${server.origin}${/^\/(?:offers|gaeb|admin|settings|projects|import)(?:\/|$)/.test(applicationUrl.pathname) ? applicationUrl.pathname : "/controls"}?${query}`,
  );
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
  const worker = (await readdir(join(assets, "assets"))).find((name) =>
    /^emailPreview\.worker-.*\.js$/.test(name),
  );
  assert.ok(worker, "Exercise the actual production worker bundle");
  await page.goto(server.origin);
  for (const [format, bytes, subject] of [
    [
      "eml",
      new TextEncoder().encode(
        "From: sender@example.test\r\nSubject: MIME email\r\n\r\nHello email.",
      ),
      "MIME email",
    ],
    ["msg", new Uint8Array(makeMsgFixture()), "Baufortschritt – Grüße"],
    [
      "msg",
      new Uint8Array(makeMsgFixture({ rtfOnly: true })),
      "Baufortschritt – Grüße",
    ],
  ]) {
    const result = await page.evaluate(
      ({ path, format, bytes }) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(path, { type: "module" });
          const timeout = setTimeout(() => {
            worker.terminate();
            reject(new Error("Production email worker timed out"));
          }, 5000);
          worker.onmessage = (event) => {
            clearTimeout(timeout);
            worker.terminate();
            resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timeout);
            worker.terminate();
            reject(new Error(event.message));
          };
          const buffer = new Uint8Array(bytes).buffer;
          worker.postMessage({ bytes: buffer, format }, [buffer]);
        }),
      { path: `/assets/${worker}`, format, bytes: Array.from(bytes) },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.mail.subject, subject);
    if (format === "msg")
      assert.equal(result.mail.attachments[0].fileName, "Lieferschein.txt");
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
    const files = ["msg", "eml"].map((format) => ({
      id: `email-${format}`,
      projectId: "project-fixture",
      folderId: null,
      fileName: `Correspondence.${format}`,
      mimeType:
        format === "msg" ? "application/vnd.ms-outlook" : "message/rfc822",
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
    await page.route(`${server.origin}/mail.msg`, (route) =>
      route.fulfill({
        contentType: "application/vnd.ms-outlook",
        body: Buffer.from(makeMsgFixture()),
      }),
    );
    await page.route(`${server.origin}/mail.eml`, (route) =>
      route.fulfill({
        contentType: "message/rfc822",
        body: "From: sender@example.test\r\nSubject: MIME email\r\n\r\nHello email.",
      }),
    );
    await page.setViewportSize(viewport);
    await openApplication("/projects/project-fixture/files", locale, theme);
    for (const format of ["msg", "eml"]) {
      const trigger = page.getByRole("button", {
        name: new RegExp(`Correspondence\\.${format}`),
      });
      await trigger.click();
      assert.equal(
        new URL(page.url()).pathname,
        `/projects/project-fixture/files/email-${format}`,
      );
      const dialog = page.getByRole("dialog", {
        name: /E-Mail ansehen|View email/,
      });
      await dialog.locator(".attachment-email-metadata").waitFor();
      assert.equal(
        await dialog.locator(".ss-modal-label").textContent(),
        `Correspondence.${format}`,
      );
      const header = await dialog.locator(".ss-modal-header").boundingBox();
      const close = dialog.getByRole("button", { name: /^(Schließen|Close)$/ });
      const bounds = await close.boundingBox();
      assert.ok(header.height <= 44);
      assert.ok(
        Math.abs(bounds.y + bounds.height / 2 - header.y - header.height / 2) <=
          1,
      );
      const body = dialog.frameLocator(".attachment-email-body");
      await body
        .getByText(format === "msg" ? "Lieferung morgen." : "Hello email.")
        .waitFor();
      if (process.env.SORTSYS_UI_SCREENSHOTS) {
        await mkdir(process.env.SORTSYS_UI_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(
            process.env.SORTSYS_UI_SCREENSHOTS,
            `email-${format}-${variant}.png`,
          ),
          animations: "disabled",
        });
      }
      await close.click();
      await dialog.waitFor({ state: "hidden" });
    }
  });
}

for (const canEdit of [true, false]) {
  test(`actual GAEB files open in their native editor and respect canEdit=${canEdit}`, async () => {
    populateAttachments();
    const date = new Date("2026-10-27T08:00:00Z");
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA84/3.3"><GAEBInfo><Version>3.3</Version><VersDate>2021-05</VersDate><Date>2026-11-04</Date></GAEBInfo><Award><DP>84</DP><CTR><Address><Name1>Fixture</Name1><Street>Teststraße 1</Street><PCode>10115</PCode><City>Berlin</City></Address><CntryType>EEA</CntryType></CTR><BoQ ID="boq"><BoQInfo><Name>Fixture bid</Name><BoQBkdn><Type>Item</Type><Length>4</Length><Num>Yes</Num></BoQBkdn></BoQInfo><BoQBody><Itemlist><Item ID="item1" RNoPart="0001"><Qty>2.000</Qty><UP>10.000</UP><IT>20.00</IT></Item></Itemlist></BoQBody></BoQ></Award></GAEB>';
    api.respond("projects.files.list", [
      {
        id: "gaeb-file",
        projectId: "project-fixture",
        folderId: null,
        fileName: "Angebot.x84",
        mimeType: "application/xml",
        kind: "file",
        status: "uploaded",
        sizeBytes: xml.length,
        textExtractionStatus: "none",
        createdAt: date,
        modifiedAt: date,
        uploadedAt: date,
      },
    ]);
    api.respond("projects.files.folders.list", []);
    api.respond("projects.files.xmlContent", {
      xml,
      fileName: "Angebot.x84",
      version: 1n,
      canEdit,
    });
    api.respond("projects.files.xmlSave", { version: 2n, savedAt: date });
    await page.setViewportSize({ width: canEdit ? 1400 : 390, height: 900 });
    await openApplication("/projects/project-fixture/files", "en");
    await page.getByRole("button", { name: /Angebot.x84/ }).click();
    assert.equal(
      new URL(page.url()).pathname,
      "/projects/project-fixture/files/gaeb-file",
    );
    const dialog = page.getByRole("dialog", {
      name: canEdit ? "Edit GAEB" : "View GAEB",
      exact: true,
    });
    const quantityTarget = dialog.getByRole("button", {
      name: "Quantity",
      exact: true,
    });
    await quantityTarget.waitFor();
    if (canEdit) await quantityTarget.and(page.locator(":enabled")).waitFor();
    assert.equal(await quantityTarget.isDisabled(), !canEdit);
    if (canEdit) {
      await quantityTarget.focus();
      const quantity = dialog.getByRole("textbox", {
        name: "Quantity",
        exact: true,
      });
      await quantity.fill("3.500");
      // Autosave must commit while the caret remains inside the quantity field.
      await dialog
        .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
        .waitFor();
      assert.equal(
        await dialog.getByRole("button", { name: "Save", exact: true }).count(),
        0,
      );
      assert.equal(
        await dialog.getByText("Angebot.x84", { exact: true }).count(),
        1,
      );
      const saved = api.requests.find(
        (request) => request.path === "projects.files.xmlSave",
      );
      assert.equal(saved.input.fileId, "gaeb-file");
      assert.equal(saved.input.version, 1n);
      assert.match(saved.input.xml, /<Qty>3.500<\/Qty>/);
      assert.match(saved.input.xml, /<IT>35.00<\/IT>/);
      await quantity.press("Tab");
      const price = dialog.getByRole("textbox", {
        name: "Unit price",
        exact: true,
      });
      await price.waitFor();
      assert.equal(
        await price.evaluate((node) => node === document.activeElement),
        true,
      );
      await price.press("Shift+Tab");
      assert.equal(
        await quantity.evaluate((node) => node === document.activeElement),
        true,
      );
      await quantity.press("Enter");
      assert.equal(
        await price.evaluate((node) => node === document.activeElement),
        true,
      );
      await price.press("Shift+Enter");
      assert.equal(
        await quantity.evaluate((node) => node === document.activeElement),
        true,
      );
      await quantity.press("Tab");
      await price.press("Tab");
      assert.equal(
        await dialog
          .getByRole("button", { name: "Zoom out", exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await dialog.evaluate((node) => node.contains(document.activeElement)),
        true,
      );
    } else {
      assert.equal(
        await dialog.getByRole("button", { name: "Save", exact: true }).count(),
        0,
      );
    }
    await checkPageLayout(`gaeb-integrated-${canEdit ? "edit" : "readonly"}`);
    if (canEdit) {
      api.hold("projects.files.xmlSave");
      const saving = page.waitForRequest((request) =>
        request.url().includes("projects.files.xmlSave"),
      );
      await quantityTarget.focus();
      await dialog
        .getByRole("textbox", { name: "Quantity", exact: true })
        .fill("4.500");
      await saving;
      await page.evaluate(() => history.back());
      await page.waitForTimeout(150);
      assert.equal(
        await dialog.isVisible(),
        true,
        "Back waits for the pending autosave",
      );
      assert.equal(
        new URL(page.url()).pathname,
        "/projects/project-fixture/files/gaeb-file",
      );
      api.release("projects.files.xmlSave");
    } else
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForURL(
      (url) => url.pathname === "/projects/project-fixture/files",
    );
    if (canEdit)
      assert.match(
        api.requests
          .filter((request) => request.path === "projects.files.xmlSave")
          .at(-1).input.xml,
        /<Qty>4.500<\/Qty>/,
      );
  });
}

test("two GAEB editors autosave parallel changes and reconnect without overwriting each other", async () => {
  populateAttachments();
  const date = new Date("2026-10-27T08:00:00Z");
  let xml =
    '<?xml version="1.0" encoding="UTF-8"?><GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA84/3.3"><GAEBInfo><Version>3.3</Version><VersDate>2021-05</VersDate><Date>2026-11-04</Date></GAEBInfo><Award><DP>84</DP><CTR><Address><Name1>Fixture</Name1><Street>Teststraße 1</Street><PCode>10115</PCode><City>Berlin</City></Address><CntryType>EEA</CntryType></CTR><BoQ ID="boq"><BoQInfo><Name>Gemeinsames Angebot</Name><BoQBkdn><Type>Item</Type><Length>4</Length><Num>Yes</Num></BoQBkdn><Totals><Total>30.00</Total></Totals></BoQInfo><BoQBody><Itemlist><Item ID="item1" RNoPart="0001"><Qty>2.000</Qty><UP>10.000</UP><IT>20.00</IT></Item><Item ID="item2" RNoPart="0002"><Qty>1.000</Qty><UP>10.000</UP><IT>10.00</IT></Item></Itemlist></BoQBody></BoQ></Award></GAEB>';
  let version = 1n,
    available = true,
    handshakes = 0;
  const sockets = new Map();
  const peers = () =>
    [...sockets].map(([id, socket]) => ({
      id,
      name: socket.name,
      color: "#2563eb",
      field: socket.field,
    }));
  const presence = () => {
    for (const { route } of sockets.values())
      route.send(JSON.stringify({ type: "presence", participants: peers() }));
  };
  await context.routeWebSocket(
    "ws://127.0.0.1:3000/documents/xml/live",
    (route) => {
      const id = `peer-${Math.random()}`;
      route.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.ticket) {
          handshakes++;
          const name = sockets.size ? "Ben Schneider" : "Anna Müller";
          sockets.set(id, { route, name, field: null });
          route.send(
            JSON.stringify({
              type: "ready",
              clientId: id,
              version: String(version),
            }),
          );
          presence();
        } else if (sockets.has(id)) {
          sockets.get(id).field = message.field;
          presence();
        }
      });
      route.onClose((code, reason) => {
        sockets.delete(id);
        presence();
        void route.close({ code, reason });
      });
    },
  );
  api.respond("projects.files.list", [
    {
      id: "gaeb-file",
      projectId: "project-fixture",
      folderId: null,
      fileName: "Angebot.x84",
      mimeType: "application/xml",
      kind: "file",
      status: "uploaded",
      sizeBytes: xml.length,
      textExtractionStatus: "none",
      createdAt: date,
      modifiedAt: date,
      uploadedAt: date,
    },
  ]);
  api.respond("projects.files.folders.list", []);
  api.respond("projects.files.xmlContent", () => ({
    xml,
    version,
    fileName: "Angebot.x84",
    canEdit: true,
    livePath: "/documents/xml/live",
    liveTicket: "document-scoped-fixture-ticket",
    recoveryScope: "fixture-user",
  }));
  api.respond("projects.files.xmlSave", (input) => {
    if (!available) throw new Error("Fixture is offline");
    if (input.version !== version)
      throw new Error("The document was changed in another editor");
    xml = input.xml;
    version++;
    for (const { route } of sockets.values())
      route.send(JSON.stringify({ type: "changed", version: String(version) }));
    return { version, savedAt: date };
  });
  const originalPage = page;
  const second = await context.newPage();
  second.setDefaultTimeout(10000);
  try {
    await openApplication("/projects/project-fixture/files", "en");
    await page.getByRole("button", { name: /Angebot.x84/ }).click();
    page = second;
    await openApplication("/projects/project-fixture/files", "en");
    await page.getByRole("button", { name: /Angebot.x84/ }).click();
    const firstEditor = originalPage.getByRole("dialog", {
      name: "Edit GAEB",
      exact: true,
    });
    const secondEditor = second.getByRole("dialog", {
      name: "Edit GAEB",
      exact: true,
    });
    await firstEditor.getByLabel("Ben Schneider", { exact: true }).waitFor();
    await secondEditor.getByLabel("Anna Müller", { exact: true }).waitFor();
    const firstQuantity = firstEditor.locator(
      '[data-gaeb-field="item-item1:Qty"]',
    );
    const secondQuantity = secondEditor.locator(
      '[data-gaeb-field="item-item2:Qty"]',
    );
    await firstQuantity.focus();
    await firstEditor
      .getByRole("textbox", { name: "Quantity", exact: true })
      .fill("3.000");
    await secondQuantity.focus();
    await secondEditor
      .getByRole("textbox", { name: "Quantity", exact: true })
      .fill("4.000");
    await firstEditor
      .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
      .waitFor();
    await secondEditor
      .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
      .waitFor();
    await originalPage.waitForFunction(
      () =>
        document
          .querySelector('[data-gaeb-field="item-item2:Qty"]')
          ?.getAttribute("aria-description") === "4.000",
    );
    await second.waitForFunction(
      () =>
        document
          .querySelector('[data-gaeb-field="item-item1:Qty"]')
          ?.getAttribute("aria-description") === "3.000",
    );
    assert.match(xml, /<Total>70.00<\/Total>/);
    assert.match(xml, /<IT>30.00<\/IT>/);
    assert.match(xml, /<IT>40.00<\/IT>/);
    // Simulate a dropped live socket. The fresh handshake must include changes
    // saved while disconnected, without a manual reload or save action.
    const beforeReconnect = handshakes;
    await Promise.all([...sockets.values()].map(({ route }) => route.close()));
    sockets.clear();
    for (
      let attempt = 0;
      attempt < 80 && handshakes < beforeReconnect + 2;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(handshakes >= beforeReconnect + 2);
    await firstEditor
      .getByRole("group", { name: "Together in this document" })
      .getByRole("img")
      .first()
      .waitFor();
    await secondEditor
      .getByRole("group", { name: "Together in this document" })
      .getByRole("img")
      .first()
      .waitFor();
    assert.equal(
      await firstEditor
        .getByRole("button", { name: "Save", exact: true })
        .count(),
      0,
    );
  } finally {
    page = originalPage;
    await second.close();
  }
});

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

const contractorInquiry = `<?xml version="1.0" encoding="UTF-8"?><GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.3"><GAEBInfo><Version>3.3</Version><VersDate>2021-05</VersDate><Date>2026-11-04</Date></GAEBInfo><Award><DP>83</DP><AwardInfo><Cur>EUR</Cur></AwardInfo><BoQ ID="boq"><BoQInfo><Name>School renovation</Name><LblBoQ>School renovation</LblBoQ><OutlCompl>AllTxt</OutlCompl><BoQBkdn><Type>Item</Type><Length>4</Length><Num>Yes</Num></BoQBkdn></BoQInfo><BoQBody><Itemlist><Item ID="item1" RNoPart="0001"><Qty>2.000</Qty><QU>m²</QU><Description><CompleteText><DetailTxt><Text><p><span>Install insulation</span></p></Text></DetailTxt></CompleteText></Description></Item></Itemlist></BoQBody></BoQ></Award></GAEB>`;
function seedContractorWorkflows(canManage = true) {
  const cases = new Map(),
    documents = new Map();
  let sequence = 0;
  api.respond("customers.list", [
    { id: "customer-fixture", name: "Fixture Customer" },
  ]);
  api.respond("commercial.cases.list", (input) =>
    [...cases.values()]
      .map((detail) => detail.case)
      .filter(
        (row) =>
          (!input?.projectId || row.projectId === input.projectId) &&
          (!input?.kind ||
            (input.kind === "sales"
              ? ["offer", "alternative"].includes(row.kind)
              : row.kind === input.kind)) &&
          (!input?.status || row.status === input.status),
      ),
  );
  api.respond("commercial.cases.get", ({ id }) => {
    const detail = cases.get(id);
    assert.ok(detail, `Unknown case ${id}`);
    return {
      ...detail,
      documents: [...documents.values()]
        .filter((doc) => doc.caseId === id)
        .map(({ xml, ...doc }) => ({
          ...doc,
          sourceCurrentVersion: doc.sourceDocumentId
            ? documents.get(doc.sourceDocumentId).version
            : null,
        })),
      canManage,
    };
  });
  api.respond("commercial.cases.create", (input) => {
    const id = `case-${++sequence}`;
    cases.set(id, {
      case: {
        ...input,
        id,
        reference: `ANG-${sequence}`,
        status: "draft",
        existingContract: false,
        projectId: input.projectId ?? null,
        parentCaseId: input.parentCaseId ?? null,
        customerName: "Fixture Customer",
        customerId: "customer-fixture",
        counterpartyName: null,
        currency: "EUR",
        netAmount: null,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      },
      events: [],
    });
    return { id };
  });
  api.respond("commercial.documents.create", (input) => {
    const id = input.replaceDocumentId ?? `doc-${++sequence}`;
    const previous = documents.get(id);
    documents.set(id, {
      ...input,
      id,
      phase: {
        inquiry: "83",
        offer: "84",
        order: "86",
        confirmation: "87",
        measurement: "31",
        alternative: "85",
        calculation: "52",
        invoice: "89",
        price_inquiry: "93",
        supplier_offer: "94",
        purchase_order: "96",
        supplier_confirmation: "97",
      }[input.purpose],
      version: previous ? previous.version + 1n : 1n,
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceVersion: input.sourceVersion ?? null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    });
    if (
      ["offer", "alternative", "invoice"].includes(input.purpose) &&
      !["subcontract", "procurement"].includes(
        cases.get(input.caseId).case.kind,
      )
    )
      cases.get(input.caseId).case.netAmount = input.netAmount;
    return { id };
  });
  api.respond("commercial.documents.get", ({ caseId, id }) => {
    const doc = documents.get(id);
    assert.equal(doc.caseId, caseId);
    const state = cases.get(caseId).case.status;
    const source = documents.get(doc.sourceDocumentId);
    return {
      xml: doc.xml,
      referenceXml: source?.xml ?? null,
      fileName: doc.fileName,
      version: doc.version,
      canEdit: canManage && !doc.readOnly && state === "draft",
      recoveryScope: "contractor-fixture",
    };
  });
  api.respond(
    "commercial.documents.save",
    ({ caseId, id, version, xml, netAmount }) => {
      const doc = documents.get(id);
      assert.equal(version, doc.version);
      doc.xml = xml;
      const title =
        /<!--sortsys:takeoff-title:v1:([\s\S]*?)-->/.exec(xml) ??
        /<!--sortsys:document-title:v1:([\s\S]*?)-->/.exec(xml);
      if (title) cases.get(caseId).case.title = decodeURIComponent(title[1]);
      doc.version++;
      doc.netAmount = netAmount;
      if (
        doc.purpose === "offer" &&
        cases.get(caseId).case.kind !== "subcontract"
      )
        cases.get(caseId).case.netAmount = netAmount;
      return { version: doc.version, savedAt: new Date().toISOString() };
    },
  );
  api.respond(
    "commercial.cases.transition",
    ({ id, expectedStatus, status, ...input }) => {
      const detail = cases.get(id);
      assert.equal(detail.case.status, expectedStatus);
      Object.assign(detail.case, { status, ...input });
      return { success: true };
    },
  );
  api.respond("commercial.cases.createProject", ({ id }) => {
    const detail = cases.get(id);
    assert.equal(detail.case.status, "accepted");
    detail.case.projectId = "project-fixture";
    return { id: "project-fixture" };
  });
  return { cases, documents };
}

for (const [locale, theme, width] of [
  ["en", "light", 1400],
  ["de", "dark", 390],
]) {
  test(`contractor offer starts from X83, autosaves prices and becomes its own project in ${locale}`, async () => {
    const state = seedContractorWorkflows();
    await page.setViewportSize({ width, height: 1000 });
    await openApplication("/offers", locale, theme);
    await page
      .getByRole("button", {
        name: locale === "de" ? "Angebot erstellen" : "Create an offer",
        exact: true,
      })
      .click();
    const creationDialog = page.getByRole("dialog", {
      name: locale === "de" ? "Angebot erstellen" : "Create an offer",
      exact: true,
    });
    await creationDialog.waitFor();
    const persistentDialog = await creationDialog.elementHandle();
    const inquiryXml =
      locale === "de"
        ? contractorInquiry.replace(
            "Install insulation",
            "Vorhandene oberflächenfertige Bauteile mit Klebeband und Folie für die bevorstehenden Arbeiten abkleben. Entfernen alter, einlagiger Tapeten an Leibungsflächen, Leibungstiefe bis 60 cm. Herstellen einer vertikalen Deckenschürze. Unterkonstruktion aus verzinkten Profilen. Beplankung mit GK-Platten, 12,5 mm, Baustoffklasse A2. Kantenschutzprofil an der Deckenkante montieren und einspachteln. Oberfläche Qualitätsstufe Q2 verspachtelt und geschliffen.",
          )
        : contractorInquiry;
    const title = page.getByRole("textbox", {
      name: locale === "de" ? /^Bezeichnung/ : /^Title/,
    });
    await title.fill("School renovation");
    const customer = page.getByRole("combobox", {
      name: locale === "de" ? /^Kunde/ : /^Customer/,
    });
    await customer.fill("Fixture");
    await page
      .getByRole("option", { name: "Fixture Customer", exact: true })
      .click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.ok(
      api.requests.some(
        (request) =>
          request.path === "customers.list" &&
          request.input.search === "fixture",
      ),
      "Customer choices must come from interactive search",
    );
    assert.equal(
      await page.locator('input[type="file"]').count(),
      0,
      "Inquiry files are opened inside the editor",
    );
    await checkPageLayout(`contractor-create-${locale}`);
    await creationDialog
      .getByRole("button", {
        name: locale === "de" ? "Angebot erstellen" : "Create an offer",
        exact: true,
      })
      .click();
    const editorDialog = page
      .getByRole("dialog")
      .filter({ has: page.locator(".gaeb-editor") });
    await editorDialog.waitFor();
    assert.equal(
      await persistentDialog.evaluate(
        (node) => node === document.querySelector('[role="dialog"]'),
      ),
      true,
      "Creating an offer retains the same dialog and focus scope while the editor loads",
    );
    assert.equal(
      await page
        .locator("[data-fixture-path]")
        .getAttribute("data-fixture-path"),
      "/offers",
    );
    assert.equal(
      await page
        .getByRole("region", {
          name: /Workflow documents|Dokumente im Vorgang/,
        })
        .count(),
      0,
    );
    const fileChooser = page.waitForEvent("filechooser");
    await editorDialog
      .getByRole("button", {
        name:
          locale === "de" ? "Leistungsanfrage einlesen" : "Read work inquiry",
        exact: true,
      })
      .click();
    await (
      await fileChooser
    ).setFiles({
      name: "School.x83",
      mimeType: "application/xml",
      buffer: Buffer.from(inquiryXml),
    });
    await editorDialog.getByText("School.x83", { exact: true }).waitFor();
    assert.equal(
      [...state.documents.values()].filter((doc) => doc.purpose === "offer")
        .length,
      0,
      "Reading an inquiry must not start pricing implicitly",
    );
    await editorDialog
      .getByRole("button", {
        name: locale === "de" ? "Kalkulation beginnen" : "Start pricing",
        exact: true,
      })
      .click();
    const price = page.getByRole("button", {
      name: locale === "de" ? "Einheitspreis" : "Unit price",
      exact: true,
    });
    await price.waitFor().catch(async (error) => {
      throw new Error(
        `${error.message}\n${await page.locator("body").innerText()}\n${JSON.stringify({ docs: [...state.documents.values()].map((doc) => ({ id: doc.id, purpose: doc.purpose, fileName: doc.fileName })), requests: api.requests.filter((request) => request.path.startsWith("commercial.")).map((request) => ({ path: request.path, id: request.input.id, purpose: request.input.purpose })) })}`,
      );
    });
    assert.equal(
      api.requests.some(({ path }) => path === "projects.create"),
      false,
    );
    assert.equal(state.cases.size, 1);
    assert.equal(
      [...state.documents.values()]
        .filter((doc) => doc.purpose === "inquiry")
        .at(-1).xml,
      inquiryXml,
    );
    assert.equal(
      [...state.documents.values()]
        .filter((doc) => doc.purpose === "inquiry")
        .at(-1).readOnly,
      true,
    );
    assert.match(
      [...state.documents.values()].find((doc) => doc.purpose === "offer").xml,
      /<Qty>2.000<\/Qty>/,
    );
    await price.focus();
    await price.press("Enter");
    await page.locator("textarea.gaeb-canvas-input").fill("125.500");
    await page
      .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
      .waitFor();
    assert.equal([...state.cases.values()][0].case.netAmount, "251.00");
    assert.equal(
      await page
        .getByRole("button", {
          name: locale === "de" ? "Speichern" : "Save",
          exact: true,
        })
        .count(),
      0,
    );
    assert.equal(await page.locator(".gaeb-document-paper").count(), 1);
    await page.waitForFunction(
      () => !document.querySelector("[data-entering]"),
    );
    const editorBounds = await editorDialog.boundingBox();
    assert.ok(
      editorBounds.width >= width - 2 && editorBounds.height >= 998,
      `Editor must be fullscreen: ${JSON.stringify(editorBounds)}`,
    );
    await page
      .locator(".gaeb-document-scroll")
      .evaluate((node) => node.scrollTo(0, 0));
    // React Aria's transient selection announcement still references the customer
    // search label until its live-region message expires after leaving the form.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="log"] [role="img"]')].every(
          (node) =>
            node
              .getAttribute("aria-labelledby")
              ?.split(" ")
              .some((id) => document.getElementById(id)?.textContent?.trim()),
        ),
      null,
      { timeout: 10000 },
    );
    await checkPageLayout(`contractor-priced-${locale}`);
    await editorDialog
      .getByRole("button", {
        name: locale === "de" ? "Schließen" : "Close",
        exact: true,
      })
      .click();
    await editorDialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.locator(".gaeb-editor").count(),
      0,
      "No inline editor may remain in the workflow",
    );
    await page
      .getByRole("heading", {
        name: locale === "de" ? "Angebote" : "Offers",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByText(
          /Price inquiries, submit offers|Anfragen kalkulieren, Angebote abgeben/,
        )
        .count(),
      0,
    );
    if (width < 1000)
      await page
        .getByRole("button", { name: "Eintrag öffnen", exact: true })
        .click();
    else
      await page
        .getByText("School renovation", { exact: true })
        .first()
        .click();
    await editorDialog.waitFor();
    assert.equal(
      await page
        .locator("[data-fixture-path]")
        .getAttribute("data-fixture-path"),
      "/offers",
    );
    await page
      .getByRole("button", {
        name: locale === "de" ? "Abgabe erfassen" : "Record submission",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: locale === "de" ? "Annahme erfassen" : "Record acceptance",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name:
        locale === "de"
          ? "Annahme des Angebots erfassen"
          : "Record offer acceptance",
      exact: true,
    });
    await dialog
      .getByRole("button", {
        name: locale === "de" ? "Annahme erfassen" : "Record acceptance",
        exact: true,
      })
      .click();
    await page.waitForFunction(() => !document.querySelector("[data-exiting]"));
    await page
      .getByRole("button", {
        name:
          locale === "de"
            ? "Projekt aus Angebot anlegen"
            : "Create project from offer",
        exact: true,
      })
      .click();
    await page
      .getByRole("heading", {
        name: locale === "de" ? "Auftrag & Leistungen" : "Contract & work",
        exact: true,
      })
      .waitFor();
    assert.equal(
      [...state.cases.values()][0].case.projectId,
      "project-fixture",
    );
    await page.getByText("School renovation", { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="log"] [role="img"]')].every(
          (node) =>
            node
              .getAttribute("aria-labelledby")
              ?.split(" ")
              .some((id) => document.getElementById(id)?.textContent?.trim()),
        ),
      null,
      { timeout: 10000 },
    );
    assert.equal(
      await page
        .getByRole("region", {
          name: locale === "de" ? "Vorgangsübersicht" : "Workflows list",
          exact: true,
        })
        .getByText(locale === "de" ? "Projekt" : "Project", { exact: true })
        .count(),
      0,
      "The current project's list omits its redundant Project column",
    );
    await checkPageLayout(`contractor-project-${locale}`);
    const newDocument = page.getByRole("button", {
      name: locale === "de" ? "Vorgang erstellen" : "Create document",
      exact: true,
    });
    await newDocument.waitFor();
    const primary = await newDocument.evaluate((node) => ({
      color: getComputedStyle(node).backgroundColor,
      primary: node.className.includes("primary"),
    }));
    assert.ok(primary.primary, "New uses the primary button style");
    assert.notEqual(primary.color, "rgba(0, 0, 0, 0)");
    await newDocument.click();
    await page
      .getByRole("menuitem", {
        name: locale === "de" ? "Aufmaß" : "Measurement",
        exact: true,
      })
      .click();
    const measurementDialog = page.getByRole("dialog");
    await measurementDialog
      .getByRole("textbox", {
        name: locale === "de" ? /^Bezeichnung/ : /^Title/,
      })
      .fill("First measured work");
    const measuredItem = measurementDialog.getByRole("checkbox").first();
    await measuredItem.waitFor();
    assert.equal(await measuredItem.isChecked(), true);
    await measuredItem
      .locator("xpath=ancestor::*[@data-slot='checkbox']")
      .click();
    assert.equal(
      await measuredItem.isChecked(),
      false,
      "A measurement item can be unchecked individually",
    );
    const measuredRow = measuredItem.locator(
      "xpath=ancestor::*[@data-slot='checkbox']",
    );
    await measuredRow.locator('[data-slot="label"]').click();
    assert.equal(
      await measuredItem.isChecked(),
      true,
      "The label also selects the position",
    );
    await measuredRow.locator('[data-slot="checkbox-control"]').click();
    assert.equal(
      await measuredItem.isChecked(),
      false,
      "The checkbox itself deselects the position",
    );
    const startMeasurement = measurementDialog.getByRole("button", {
      name: locale === "de" ? "Aufmaß beginnen" : "Start measurement",
      exact: true,
    });
    assert.equal(
      await startMeasurement.isDisabled(),
      true,
      "An empty scope cannot be submitted",
    );
    await measuredItem.focus();
    await page.keyboard.press("Space");
    assert.equal(
      await measuredItem.isChecked(),
      true,
      "Space restores an individual item",
    );
    await measurementDialog
      .getByRole("button", {
        name: locale === "de" ? "Aufmaß beginnen" : "Start measurement",
        exact: true,
      })
      .click();
    await page.getByRole("dialog").locator(".gaeb-editor").waitFor();
    const measurement = [...state.documents.values()].find(
      (doc) => doc.purpose === "measurement",
    );
    assert.ok(measurement);
    assert.match(measurement.xml, /<Qty>0.000<\/Qty>/);
    const measurementCase = state.cases.get(measurement.caseId).case;
    assert.equal(
      measurementCase.parentCaseId,
      [...state.cases.values()][0].case.id,
    );
    assert.equal(measurementCase.projectId, "project-fixture");
    await page
      .getByRole("dialog")
      .filter({ has: page.locator(".gaeb-editor") })
      .waitFor();
    await page
      .getByRole("button", {
        name: locale === "de" ? "Gesamtaufmaß" : "Measured quantity",
        exact: true,
      })
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector("[data-entering],[data-exiting]"),
    );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="log"] [role="img"]')].every(
          (node) =>
            node
              .getAttribute("aria-labelledby")
              ?.split(" ")
              .some((id) => document.getElementById(id)?.textContent?.trim()),
        ),
      null,
      { timeout: 10000 },
    );
    const measuredEditor = page
      .getByRole("dialog")
      .filter({ has: page.locator(".gaeb-editor") });
    assert.equal(
      await measuredEditor
        .getByRole("button", {
          name: locale === "de" ? "Vorgang anzeigen" : "Show workflow",
          exact: true,
        })
        .count(),
      0,
    );
    await measuredEditor
      .getByRole("button", {
        name: locale === "de" ? "Einreichung erfassen" : "Record submission",
        exact: true,
      })
      .click();
    await measuredEditor
      .getByRole("button", {
        name: locale === "de" ? "Aufmaß freigeben" : "Approve measurement",
        exact: true,
      })
      .waitFor();
    assert.equal(measurementCase.status, "submitted");
    await measuredEditor
      .getByRole("button", {
        name: locale === "de" ? "Überarbeiten" : "Revise",
        exact: true,
      })
      .click();
    await measuredEditor
      .getByRole("button", {
        name: locale === "de" ? "Einreichung erfassen" : "Record submission",
        exact: true,
      })
      .waitFor();
    assert.equal(measurementCase.status, "draft");
    await checkPageLayout(`contractor-measurement-${locale}`);
  });
}

test("contractor offer listing has localized empty, failed and permission-restricted states", async () => {
  seedContractorWorkflows(false);
  api.setRoles(["view:projects"]);
  await openApplication("/offers", "en", "dark");
  await page
    .getByText("No offers yet. Start with a work inquiry or your own offer.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Create an offer", exact: true })
      .count(),
    0,
  );
  await checkPageLayout("contractor-list-restricted-empty");
  api.fail("commercial.cases.list", "Synthetic list failure");
  await page
    .getByRole("textbox", { name: "Search", exact: true })
    .fill("School");
  await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
  api.recover("commercial.cases.list");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByText("No offers yet. Start with a work inquiry or your own offer.", {
      exact: true,
    })
    .waitFor();
});

test("contractor subcontract package selects contract work, compares purchase bids and creates a native order", async () => {
  const { cases, documents } = seedContractorWorkflows();
  const bidXml =
    '<?xml version="1.0" encoding="UTF-8"?><GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA84/3.3"><GAEBInfo><Version>3.3</Version><VersDate>2021-05</VersDate><Date>2026-11-04</Date></GAEBInfo><Award><DP>84</DP><AwardInfo><Cur>EUR</Cur></AwardInfo><CTR><Address><Name1>Contractor</Name1><Street>Test Street 1</Street><PCode>10115</PCode><City>Berlin</City></Address><CntryType>EEA</CntryType></CTR><BoQ ID="boq"><BoQInfo><Name>School renovation</Name><BoQBkdn><Type>Item</Type><Length>4</Length><Num>Yes</Num></BoQBkdn><Totals><Total>251.00</Total></Totals></BoQInfo><BoQBody><Itemlist><Item ID="item1" RNoPart="0001"><Qty>2.000</Qty><UP>125.500</UP><IT>251.00</IT></Item></Itemlist></BoQBody></BoQ></Award></GAEB>';
  const contract = {
    id: "main-contract",
    reference: "ANG-1",
    title: "School renovation",
    kind: "offer",
    status: "accepted",
    existingContract: false,
    projectId: "project-fixture",
    customerId: "customer-fixture",
    customerName: "Fixture Customer",
    currency: "EUR",
    netAmount: "251.00",
    scopeItemIds: [],
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };
  cases.set(contract.id, { case: contract, events: [] });
  documents.set("contract-inquiry", {
    id: "contract-inquiry",
    caseId: contract.id,
    purpose: "inquiry",
    phase: "83",
    fileName: "School.x83",
    xml: contractorInquiry,
    version: 1n,
    readOnly: true,
    sourceDocumentId: null,
    sourceVersion: null,
  });
  documents.set("contract-bid", {
    id: "contract-bid",
    caseId: contract.id,
    purpose: "offer",
    phase: "84",
    fileName: "School.x84",
    xml: bidXml,
    version: 1n,
    readOnly: true,
    sourceDocumentId: "contract-inquiry",
    sourceVersion: 1n,
    netAmount: "251.00",
  });
  await openApplication("/projects/project-fixture/contract", "en", "light");
  await page
    .getByRole("button", { name: "Create document", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Subcontract", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Subcontract work",
    exact: true,
  });
  await form
    .getByRole("textbox", { name: /^Title/ })
    .fill("Electrical package");
  const packageItem = form.getByRole("checkbox").first();
  await packageItem.waitFor();
  assert.equal(await packageItem.isChecked(), false);
  await packageItem
    .locator("xpath=ancestor::*[@data-slot='checkbox']")
    .locator('[data-slot="checkbox-control"]')
    .click();
  assert.equal(
    await packageItem.isChecked(),
    true,
    "An individual item can be selected for subcontracting",
  );
  await packageItem.focus();
  await page.keyboard.press("Space");
  assert.equal(await packageItem.isChecked(), false);
  assert.equal(
    await form
      .getByRole("button", { name: "Create work package", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Space");
  assert.equal(await packageItem.isChecked(), true);
  await form
    .getByRole("button", { name: "Create work package", exact: true })
    .click();
  const editor = page
    .getByRole("dialog")
    .filter({ has: page.locator(".gaeb-editor") });
  await editor.waitFor().catch(async (error) => {
    throw new Error(
      `${error.message}\n${await page.locator("body").innerText()}\n${api.requests.map((request) => request.path).join(", ")}`,
    );
  });
  await editor.getByRole("button", { name: "Quantity", exact: true }).waitFor();
  const inquiry = [...documents.values()].find(
    (doc) => doc.caseId !== contract.id && doc.purpose === "inquiry",
  );
  assert.ok(inquiry);
  assert.doesNotMatch(inquiry.xml, /<UP>|125.500|251.00/);
  assert.match(inquiry.xml, /Install insulation/);
  assert.equal(
    await editor
      .getByRole("button", { name: "Show workflow", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("region", { name: "Workflow documents", exact: true })
      .count(),
    0,
  );
  await editor
    .getByRole("button", { name: "Record inquiry", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Open subcontractor offer", exact: true })
    .click();
  const importOffer = page.getByRole("dialog", {
    name: "Open subcontractor offer",
    exact: true,
  });
  await importOffer
    .getByRole("textbox", { name: "Subcontractor / company", exact: true })
    .fill("Electrical Ltd");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    importOffer
      .getByRole("button", { name: "Choose file", exact: true })
      .click(),
  ]);
  await chooser.setFiles({
    name: "Supplier.x84",
    mimeType: "application/xml",
    buffer: Buffer.from(
      bidXml.replaceAll("125.500", "80.000").replaceAll("251.00", "160.00"),
    ),
  });
  await editor.waitFor();
  await editor.getByText("Read only", { exact: true }).waitFor();
  await importOffer.waitFor({ state: "hidden" });
  assert.equal(
    await editor.locator(".gaeb-editor").count(),
    1,
    "The editor stays open without a workflow overview",
  );
  await editor
    .getByRole("button", { name: "Compare purchase offers", exact: true })
    .click();
  await page.getByRole("button", { name: /Select an offer/ }).click();
  await page.getByRole("option", { name: /Electrical Ltd/ }).click();
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Award work package", exact: true })
    .click();
  const award = page.getByRole("dialog", {
    name: "Award work package",
    exact: true,
  });
  await award
    .getByRole("button", { name: "Confirm award", exact: true })
    .click();
  await award.waitFor({ state: "hidden" });
  const order = [...documents.values()].find(
    (doc) => doc.caseId === inquiry.caseId && doc.purpose === "order",
  );
  assert.ok(order);
  assert.match(order.xml, /<DP>86<\/DP>/);
  assert.match(order.xml, /<UP>80.000<\/UP>/);
  assert.doesNotMatch(order.xml, /125.500/);
  assert.equal(cases.get(inquiry.caseId).case.status, "awarded");
  assert.equal(
    api.requests.filter(({ path }) => path === "commercial.cases.createProject")
      .length,
    0,
  );
  await editor.getByText(/Beauftragung\.x86/, { exact: false }).waitFor();
  assert.equal(
    await editor
      .getByRole("button", { name: "Show workflow", exact: true })
      .count(),
    0,
  );
  await page.waitForFunction(
    () => !document.querySelector("[data-entering],[data-exiting]"),
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="log"] [role="img"]')].every(
        (node) =>
          node
            .getAttribute("aria-labelledby")
            ?.split(" ")
            .some((id) => document.getElementById(id)?.textContent?.trim()),
      ),
    null,
    { timeout: 10000 },
  );
  await checkPageLayout("contractor-subcontract-awarded");
});

for (const [locale, width] of [
  ["en", 1400],
  ["de", 390],
]) {
  test(`organization administration groups details, logo, staff and LLM usage in persistent tabs in ${locale}`, async () => {
    let profile = {
      companyName: "Bau GmbH",
      address: {
        streetAddress: "Altweg 1",
        zip: "06108",
        city: "Halle",
        country: "Deutschland",
      },
    };
    api.respond("settings.organization.get", () => profile);
    api.respond("settings.organization.set", (input) => {
      profile = input;
      return { success: true };
    });
    await page.setViewportSize({ width, height: 1000 });
    await openApplication("/admin", locale);
    const street = () =>
      page.getByRole("textbox", {
        name: locale === "de" ? "Straße und Hausnummer" : "Street and number",
        exact: true,
      });
    const details = page.getByRole("tab", {
      name: locale === "de" ? "Stammdaten" : "Company details",
      exact: true,
    });
    await street().fill("Neuweg 2");
    await page.getByRole("tab", { name: "Logo", exact: true }).click();
    await page
      .getByRole("button", {
        name: locale === "de" ? "Logo hochladen" : "Upload logo",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await street().count(),
      0,
      "Inactive forms stay out of the focus and accessibility order",
    );
    await checkPageLayout(`organization-logo-${locale}`);
    await page
      .getByRole("tab", {
        name: locale === "de" ? "Personal" : "Staff",
        exact: true,
      })
      .click();
    await page
      .getByRole("combobox", {
        name:
          locale === "de" ? /^Standard-Vorgesetzter/ : /^Default supervisor/,
      })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("tab"), "staff");
    await checkPageLayout(`organization-staff-${locale}`);
    await page
      .getByRole("tab", {
        name: locale === "de" ? "LLM-Verbrauch" : "LLM usage",
        exact: true,
      })
      .click();
    await page.waitForFunction(() =>
      document.querySelector('[role="tabpanel"]')?.textContent?.includes("LLM"),
    );
    await checkPageLayout(`organization-usage-${locale}`);
    await page.reload();
    await page
      .getByRole("tab", {
        name: locale === "de" ? "LLM-Verbrauch" : "LLM usage",
        selected: true,
      })
      .waitFor();
    await details.click();
    // Reload restores saved data; ordinary tab switching retains unsaved form values.
    await street().fill("Neuweg 2");
    await page.getByRole("tab", { name: "Logo", exact: true }).click();
    await details.click();
    assert.equal(await street().inputValue(), "Neuweg 2");
    await page
      .getByRole("button", {
        name: locale === "de" ? "Speichern" : "Save",
        exact: true,
      })
      .click();
    await page
      .getByText(
        locale === "de" ? "Organisation gespeichert" : "Organization saved",
        { exact: true },
      )
      .waitFor();
    assert.equal(profile.address.streetAddress, "Neuweg 2");
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelector('input[name="streetAddress"]')?.value ===
        "Neuweg 2",
    );
    await checkPageLayout(`organization-details-${locale}`);
    await openApplication("/settings/organization", locale);
    await page.waitForURL((url) => url.pathname === "/admin");
    await street().waitFor();
    await openApplication("/settings", locale);
    assert.equal(await page.getByRole("tab").count(), 3);
    assert.equal(
      await page
        .getByRole("tab", {
          name: locale === "de" ? "Organisation" : "Organization",
          exact: true,
        })
        .count(),
      0,
    );
  });
}

for (const [locale, width] of [
  ["de", 390],
  ["en", 1400],
]) {
  test(`organization invoice numbering dropdown explains each scheme and persists exact starting numbers in ${locale}`, async () => {
    await page.setViewportSize({ width, height: 1000 });
    await openApplication("/admin?tab=invoices", locale);
    const scheme = page.getByRole("button", {
      name:
        locale === "de" ? /Rechnungsnummer-Schema/ : /Invoice numbering scheme/,
    });
    await scheme.and(page.locator(":enabled")).waitFor();
    const output = page.getByRole("status", {
      name:
        locale === "de"
          ? "Beispiel-Rechnungsnummern"
          : "Example invoice numbers",
      exact: true,
    });
    const choices =
      locale === "de"
        ? [
            "Global fortlaufend",
            "Datumsbasiert mit Trennzeichen",
            "Datumsbasiert kompakt",
            "Projektbasiert, lokal fortlaufend",
            "Projektbasiert, global fortlaufend",
          ]
        : [
            "Global sequence",
            "Date with separators",
            "Compact date",
            "Project with local sequence",
            "Project with global sequence",
          ];
    const descriptions =
      locale === "de"
        ? [
            "Ein gemeinsamer Zähler für alle Rechnungen.",
            "JJ-MM-TT und globale Nummer. Der Zähler läuft über Datumsgrenzen weiter.",
            "JJMMTT direkt vor der global fortlaufenden Nummer.",
            "Die achtstellige Nummer aus der Projekt-ID steht vor einem eigenen Zähler je Projekt.",
            "Die achtstellige Nummer aus der Projekt-ID steht vor einem gemeinsamen Zähler für alle Projekte.",
          ]
        : [
            "One shared counter for all invoices.",
            "YY-MM-DD and a global number. The counter continues across dates.",
            "YYMMDD followed directly by the global sequence.",
            "The eight-digit number derived from the project ID precedes a separate counter per project.",
            "The eight-digit number derived from the project ID precedes one shared counter across all projects.",
          ];
    for (let i = 0; i < choices.length; i++) {
      await scheme.click();
      assert.equal(await page.getByRole("option").count(), 5);
      await page.getByRole("option", { name: choices[i], exact: true }).click();
      assert.ok((await scheme.innerText()).includes(choices[i]));
      await page.getByText(descriptions[i], { exact: true }).waitFor();
      for (let other = 0; other < descriptions.length; other++) {
        if (other !== i)
          assert.equal(
            await page.getByText(descriptions[other], { exact: true }).count(),
            0,
          );
      }
      await page
        .getByRole("textbox", {
          name:
            locale === "de"
              ? /^(Globale Startnummer|Startnummer je Projekt)/
              : /^(Global starting number|Starting number per project)/,
        })
        .fill(i === 3 ? "1" : "5368");
      const expected = [
        /^5368$/,
        /^\d{2}-\d{2}-\d{2}-5368$/,
        /^\d{6}5368$/,
        /^00238427-1$/,
        /^00238427-5368$/,
      ][i];
      const numbers = await output.locator("code").allTextContents();
      assert.equal(numbers.length, 5);
      assert.match(numbers[0], expected);
      const firstCounter = i === 3 ? "1" : "5368";
      const prefix = numbers[0].slice(0, -firstCounter.length);
      assert.deepEqual(
        numbers,
        Array.from(
          { length: 5 },
          (_, index) => `${prefix}${BigInt(firstCounter) + BigInt(index)}`,
        ),
      );
    }
    const start = page.getByRole("textbox", {
      name:
        locale === "de" ? /^Globale Startnummer/ : /^Global starting number/,
    });
    await start.fill("9007199254740993");
    const save = page.getByRole("button", {
      name: locale === "de" ? "Speichern" : "Save",
      exact: true,
    });
    await save.click();
    await page
      .getByText(
        locale === "de"
          ? "Rechnungsnummern gespeichert"
          : "Invoice numbering saved",
        { exact: true },
      )
      .waitFor();
    const request = api.requests
      .filter(({ path }) => path === "settings.invoiceNumbering.set")
      .at(-1);
    assert.deepEqual(request.input, {
      scheme: "projectGlobal",
      startNumber: "9007199254740993",
    });
    await page.reload();
    await scheme.getByText(choices[4], { exact: true }).waitFor();
    assert.equal(await start.inputValue(), "9007199254740993");
    assert.equal(
      await output.locator("code").first().innerText(),
      "00238427-9007199254740993",
    );
    assert.equal(await output.locator("code").count(), 5);
    await checkPageLayout(`invoice-numbering-${locale}`);
    await start.fill("0");
    await save.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('input[name="startNumber"]')
          ?.getAttribute("aria-invalid") === "true",
    );
    assert.equal(
      api.requests.filter(
        ({ path }) => path === "settings.invoiceNumbering.set",
      ).length,
      1,
    );
  });
}

async function createOfferInEditor(title) {
  const state = seedContractorWorkflows();
  await openApplication("/offers", "en");
  await page
    .getByRole("button", { name: "Create an offer", exact: true })
    .click();
  const creation = page.getByRole("dialog", {
    name: "Create an offer",
    exact: true,
  });
  await creation.getByRole("textbox", { name: /^Title/ }).fill(title);
  await page.getByRole("combobox", { name: /^Customer/ }).fill("Fixture");
  await page
    .getByRole("option", { name: "Fixture Customer", exact: true })
    .click();
  await creation
    .getByRole("button", { name: "Create an offer", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Offer", exact: true })
    .locator(".gaeb-editor")
    .waitFor();
  return state;
}

test("editor view preferences persist on the server across closing and a browser reload", async () => {
  seedOverlayOffers(1, true);
  await openApplication("/offers", "en");
  const open = async () => {
    await page.getByText("Offer 0", { exact: true }).click();
    await page.getByRole("dialog").locator(".gaeb-editor").waitFor();
  };
  await open();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "View", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Show editable fields", exact: true })
    .click();
  const separator = dialog.getByRole("separator", {
    name: "Outline width",
    exact: true,
  });
  await separator.focus();
  await separator.press("End");
  await dialog
    .getByRole("button", { name: "Collapse ribbon", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const settings = api.requests
    .filter(({ path }) => path === "personalization.gaebView.set")
    .at(-1)?.input;
  assert.equal(settings.showFields, false);
  assert.equal(settings.outlineWidth, 600);
  assert.equal(settings.ribbonCollapsed, true);
  await page.reload();
  await open();
  assert.equal(await dialog.getByRole("tabpanel").count(), 0);
  await dialog.getByRole("tab", { name: "View", exact: true }).click();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Show editable fields", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(await separator.getAttribute("aria-valuenow"), "600");
  assert.equal(await page.locator(".gaeb-status").count(), 0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

test(
  "organization Typst split editor compiles previews, embeds images and PDF pages and retains invalid drafts",
  { timeout: 60000 },
  async () => {
    const source = `#let document-header(data) = [HEADER #data.sender.name]
#let document-footer(data) = context [FOOTER #counter(page).display("1")]
#let table-style = (stroke: 0.3pt + blue, inset: 4pt)
#let document-style(data, body) = {
  set page(paper: "a4", margin: 20mm, header: document-header(data), footer: document-footer(data))
  set text(font: "NimbusSanL", size: 10pt)
  body
}
`;
    let template = { source, revision: "0", assets: [] };
    const uploaded = new Map();
    api.respond("settings.documentTemplate.get", () => template);
    api.respond("settings.documentTemplate.set", (input) => {
      template = {
        ...template,
        source: input.source,
        revision: "saved-revision",
      };
      return { source: template.source, revision: template.revision };
    });
    api.respond("settings.documentTemplate.assets.createUpload", (input) => {
      const id = `asset-${uploaded.size}`;
      const url = `${server.origin}/template-test/${id}`;
      uploaded.set(id, { ...input, id, downloadUrl: url });
      return {
        id,
        uploadUrl: url,
        uploadMethod: "PUT",
        uploadHeaders: { "Content-Type": input.mimeType },
      };
    });
    api.respond("settings.documentTemplate.assets.completeUpload", ({ id }) => {
      const { buffer, ...asset } = uploaded.get(id);
      template.assets.push(asset);
      return { success: true };
    });
    await context.route("**/template-test/*", async (route) => {
      const asset = uploaded.get(
        new URL(route.request().url()).pathname.split("/").at(-1),
      );
      if (route.request().method() === "PUT") {
        asset.buffer = route.request().postDataBuffer();
        await route.fulfill({ status: 200, body: "" });
      } else
        await route.fulfill({
          status: 200,
          contentType: asset.mimeType,
          body: asset.buffer,
        });
    });
    await page.setViewportSize({ width: 1600, height: 1100 });
    await openApplication("/admin?tab=templates", "en");
    const code = page.getByRole("textbox", { name: /Typst template source/ });
    await code.waitFor();
    const tabs = await page.getByRole("tab").evaluateAll((nodes) =>
      nodes.map((node) => ({
        x: node.getBoundingClientRect().x,
        width: node.getBoundingClientRect().width,
      })),
    );
    assert.equal(tabs.length, 6);
    assert.ok(
      tabs.every((tab) => tab.width < 250 && tab.x + tab.width <= 1600),
      JSON.stringify(tabs),
    );
    const pdfText = async () => {
      const frame = await page
        .getByTitle("View PDF", { exact: true })
        .elementHandle();
      const content = await frame.contentFrame();
      await content.waitForFunction(
        () => !!window.PDFViewerApplication?.pdfDocument,
      );
      return content.evaluate(async () => {
        const pdf = window.PDFViewerApplication.pdfDocument;
        const result = [];
        for (let i = 1; i <= pdf.numPages; i++)
          result.push(
            (await (await pdf.getPage(i)).getTextContent()).items
              .map((item) => item.str)
              .join(" "),
          );
        return result.join("\n");
      });
    };
    await page
      .getByTitle("View PDF", { exact: true })
      .waitFor({ timeout: 20000 });
    assert.match(await pdfText(), /HEADER Fixture Company/);
    const geometry = await page
      .getByRole("region", { name: "Typst source", exact: true })
      .boundingBox();
    const right = await page
      .getByRole("region", { name: "PDF preview", exact: true })
      .boundingBox();
    assert.ok(
      right.x > geometry.x + geometry.width,
      JSON.stringify({ geometry, right }),
    );
    const setCode = async (text) => {
      await code.focus();
      await page.keyboard.press("Control+a");
      await page.keyboard.insertText(text);
    };
    await setCode(source.replace("HEADER", "CUSTOM HEADER"));
    const save = page.getByRole("button", {
      name: "Save template",
      exact: true,
    });
    await save.and(page.locator(":enabled")).waitFor({ timeout: 20000 });
    assert.match(await pdfText(), /CUSTOM HEADER Fixture Company/);
    const saved = page.waitForResponse((response) =>
      response.url().includes("settings.documentTemplate.set"),
    );
    await save.click();
    await saved;
    assert.match(template.source, /CUSTOM HEADER/);
    // Upload a real PNG, then use the compiled preview PDF as a PDF asset.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1kAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = async (name, mimeType, buffer) => {
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "Add image or PDF", exact: true })
        .click();
      await (await chooser).setFiles({ name, mimeType, buffer });
      await page
        .getByText(name, { exact: true })
        .waitFor()
        .catch(async (cause) => {
          throw new Error(
            `${cause.message}\n${await page.locator("body").innerText()}\n${JSON.stringify(api.requests.filter(({ path }) => path.startsWith("settings.documentTemplate.assets")))}`,
          );
        });
    };
    const bytes = await page
      .getByTitle("View PDF", { exact: true })
      .evaluate(async (node) => {
        const pdf = node.contentWindow.PDFViewerApplication.pdfDocument;
        return Array.from(await pdf.getData());
      });
    await upload("logo.png", "image/png", png);
    await upload("terms.pdf", "application/pdf", Buffer.from(bytes));
    await setCode(
      template.source +
        '\n#asset("logo.png", width: 10mm)\n#attachment("terms.pdf", width: 100%)\n',
    );
    await save
      .and(page.locator(":enabled"))
      .waitFor({ timeout: 20000 })
      .catch(async (cause) => {
        throw new Error(
          `${cause.message}\n${await page.locator("body").innerText()}`,
        );
      });
    assert.match(await pdfText(), /CUSTOM HEADER/);
    assert.equal(template.assets.length, 2);
    const savedAssets = page.waitForResponse((response) =>
      response.url().includes("settings.documentTemplate.set"),
    );
    await save.click();
    await savedAssets;
    const validSource = template.source;
    await page.screenshot({
      path: join(
        process.env.SORTSYS_UI_SCREENSHOTS ?? "/tmp",
        "typst-split-editor.png",
      ),
    });
    await setCode(validSource + "\n#this-function-does-not-exist()\n");
    await page
      .getByText("The last valid preview remains visible.", { exact: true })
      .waitFor();
    assert.equal(await save.isDisabled(), true);
    assert.match(await pdfText(), /CUSTOM HEADER/);
    assert.equal(template.source, validSource);
    await page.screenshot({
      path: join(
        process.env.SORTSYS_UI_SCREENSHOTS ?? "/tmp",
        "typst-split-editor-invalid.png",
      ),
    });
    seedOverlayOffers(1, true);
    await openApplication("/offers", "en");
    await page.getByText("Offer 0", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    const editor = dialog.locator(".gaeb-editor");
    await editor.waitFor();
    await editor.focus();
    const downloaded = page.waitForEvent("download");
    await page.keyboard.press("Control+p");
    const file = await downloaded;
    assert.match(file.suggestedFilename(), /\.pdf$/i);
    const printed = await readFile(await file.path());
    assert.equal(printed.subarray(0, 5).toString(), "%PDF-");
    const text = await page.evaluate(
      async (data) => {
        const pdfjs = await import("/pdfjs/6.4.299/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc =
          "/pdfjs/6.4.299/build/pdf.worker.mjs";
        const task = pdfjs.getDocument({ data: new Uint8Array(data) });
        const pdf = await task.promise;
        try {
          const text = [];
          for (let index = 1; index <= pdf.numPages; index++)
            text.push(
              (await (await pdf.getPage(index)).getTextContent()).items
                .map((item) => item.str)
                .join(" "),
            );
          return text.join("\n");
        } finally {
          await task.destroy();
        }
      },
      [...printed],
    );
    assert.match(text, /CUSTOM HEADER Fixture Company/);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  },
);

test("offer scope autosaves before pricing and changed quantities reuse the existing calculation", async () => {
  const state = await createOfferInEditor("Own offer");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const persistentDialog = await dialog.elementHandle();
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  const input = dialog.locator("textarea.gaeb-canvas-input");
  await input.fill("Install the new insulation");
  await input.press("Tab");
  await input.fill("4.500");
  await dialog
    .getByRole("button", { name: "Start pricing", exact: true })
    .click();
  const price = dialog.getByRole("button", { name: "Unit price", exact: true });
  await price.waitFor();
  assert.equal(
    await persistentDialog.evaluate(
      (node) => node === document.querySelector('[role="dialog"]'),
    ),
    true,
    "Pricing replaces document content within the existing dialog",
  );
  await price.and(page.locator(":enabled")).waitFor();
  const inquiry = [...state.documents.values()].find(
    (doc) => doc.purpose === "inquiry",
  );
  const offer = [...state.documents.values()].find(
    (doc) => doc.purpose === "offer",
  );
  assert.match(inquiry.xml, /Install the new insulation/);
  assert.match(inquiry.xml, /<Qty>4.500<\/Qty>/);
  assert.match(offer.xml, /<Street>Bauweg 12<\/Street>/);
  assert.match(offer.xml, /<PCode>06108<\/PCode>/);
  assert.match(offer.xml, /<City>Halle<\/City>/);
  assert.equal(
    await dialog
      .getByRole("button", { name: "More offer actions", exact: true })
      .count(),
    0,
  );
  await dialog.getByRole("button", { name: "Download", exact: true }).waitFor();
  await dialog
    .getByRole("button", { name: "Workflow history", exact: true })
    .click();
  const history = page.getByRole("dialog", {
    name: "Workflow history",
    exact: true,
  });
  await history.waitFor();
  await history.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(offer.sourceDocumentId, inquiry.id);
  assert.equal(offer.sourceVersion, inquiry.version);
  await price.focus();
  await input.fill("7.250");
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await dialog
    .getByRole("button", { name: "Edit scope of work", exact: true })
    .click();
  const quantity = dialog.getByRole("button", {
    name: "Quantity",
    exact: true,
  });
  await quantity.and(page.locator(":enabled")).waitFor();
  await quantity.focus();
  await input.fill("6.000");
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await dialog
    .getByRole("button", { name: "Update pricing", exact: true })
    .click();
  await price.and(page.locator(":enabled")).waitFor();
  const updated = state.documents.get(offer.id);
  assert.equal(
    [...state.documents.values()].filter((doc) => doc.purpose === "offer")
      .length,
    1,
  );
  assert.match(updated.xml, /<UP>7.250<\/UP>/);
  assert.match(updated.xml, /<Qty>6.000<\/Qty>/);
  assert.equal(updated.netAmount, "43.50");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("heading", { name: "Offers", exact: true }).waitFor();
  assert.equal(await page.locator(".gaeb-editor").count(), 0);
});

test("invalid units identify the field, retain drafts and stop retrying until corrected", async () => {
  const state = seedOverlayOffers(1, true);
  api.respond("errorReports.report", { success: true });
  await openApplication("/offers", "en");
  await page.getByText("Offer 0", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const unit = dialog.getByRole("button", { name: "Unit", exact: true });
  await unit.and(page.locator(":enabled")).waitFor();
  await unit.focus();
  const input = dialog.locator("textarea.gaeb-canvas-input");
  const diagnostic = page.waitForResponse((response) =>
    response.url().includes("errorReports.report"),
  );
  await input.fill("unknown-unit");
  await dialog
    .getByText("Saving waits for correction", { exact: true })
    .waitFor();
  assert.match(
    await dialog.getByRole("alert").innerText(),
    /Units may contain up to four characters/,
  );
  assert.equal(
    await dialog
      .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
      .count(),
    0,
  );
  assert.equal(await input.inputValue(), "unknown-unit");
  await dialog
    .locator(".gaeb-document-scroll")
    .click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  await unit.focus();
  assert.equal(
    await input.inputValue(),
    "unknown-unit",
    "Deselecting preserves an invalid draft for correction",
  );
  const attempts = () =>
    api.requests.filter(
      (request) =>
        request.path === "errorReports.report" &&
        request.input.source === "gaeb.autosave",
    );
  await page.waitForFunction(() =>
    document
      .querySelector(".gaeb-status")
      ?.textContent?.includes("Saving waits for correction"),
  );
  await diagnostic;
  const before = attempts().length;
  assert.ok(before > 0);
  assert.equal(attempts()[0].input.message, "unit-too-long");
  assert.equal(attempts()[0].input.metadata.stage, "drafts");
  await page.waitForTimeout(5500);
  assert.equal(
    attempts().length,
    before,
    "Invalid input must not cause an automatic retry loop",
  );
  assert.equal(
    api.requests.filter(
      (request) => request.path === "commercial.documents.save",
    ).length,
    0,
  );
  await checkPageLayout("gaeb-invalid-unit");
  await page.setViewportSize({ width: 390, height: 900 });
  await checkPageLayout("gaeb-invalid-unit-mobile");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const pending = page.getByRole("dialog", {
    name: "Saving has not completed",
    exact: true,
  });
  await pending
    .getByRole("button", { name: "Continue editing", exact: true })
    .click();
  await unit.focus();
  assert.equal(await input.inputValue(), "unknown-unit");
  await input.fill("Stück");
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.match(state.documents.get("scope-0").xml, /<QU>Stk<\/QU>/);
  assert.equal(await input.inputValue(), "Stk");
  await dialog
    .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
    .waitFor();
  assert.equal(await dialog.getByRole("alert").count(), 0);
});

test("live offer text and cursors synchronize before autosave and workflow updates never poll the case", async () => {
  const state = seedOverlayOffers(1, true);
  const document = state.documents.get("scope-0");
  const shared = new Y.Doc();
  const sockets = new Map();
  let holdUpdates = false;
  const updates = [];
  const broadcast = (message) => {
    const text = JSON.stringify(message);
    for (const { route } of sockets.values()) route.send(text);
  };
  const presence = () =>
    broadcast({
      type: "presence",
      participants: [...sockets].map(([id, peer]) => ({
        id,
        name: peer.name,
        color: "#9333ea",
        field: peer.field ?? null,
        start: peer.start,
        end: peer.end,
        anchor: peer.anchor,
        head: peer.head,
      })),
    });
  const caseDetail = () => ({
    ...state.cases.get("overlay-0"),
    canManage: true,
    documents: [...state.documents.values()].map(({ xml, ...item }) => ({
      ...item,
      version: String(item.version),
      sourceVersion: null,
      sourceCurrentVersion: null,
    })),
  });
  await context.routeWebSocket(
    "ws://127.0.0.1:3000/documents/xml/live",
    (route) => {
      const id = `peer-${sockets.size}`;
      route.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.ticket) {
          sockets.set(id, {
            route,
            name: sockets.size ? "Ben Schneider" : "Anna Müller",
            field: null,
          });
          route.send(
            JSON.stringify({
              type: "ready",
              clientId: id,
              version: String(document.version),
              collaboration: true,
            }),
          );
          route.send(
            JSON.stringify({
              type: "sync",
              data: Buffer.from(Y.encodeStateAsUpdate(shared)).toString(
                "base64",
              ),
            }),
          );
          presence();
        } else if (message.type === "initialize") {
          const keys = shared.getMap("__fields");
          if (keys.has(message.key)) return;
          const vector = Y.encodeStateVector(shared);
          shared.transact(() => {
            keys.set(message.key, true);
            shared.getText(message.key).insert(0, message.value);
          });
          broadcast({
            type: "sync",
            data: Buffer.from(Y.encodeStateAsUpdate(shared, vector)).toString(
              "base64",
            ),
          });
        } else if (message.type === "update") {
          const apply = () => {
            Y.applyUpdate(shared, Buffer.from(message.data, "base64"));
            broadcast({ type: "sync", data: message.data });
          };
          if (holdUpdates) updates.push(apply);
          else apply();
        } else if (sockets.has(id)) {
          Object.assign(sockets.get(id), message);
          presence();
        }
      });
      route.onClose(() => {
        sockets.delete(id);
        presence();
      });
    },
  );
  api.respond("commercial.documents.get", () => ({
    ...document,
    canEdit: true,
    livePath: "/documents/xml/live",
    liveTicket: "fixture-ticket",
    recoveryScope: "live-offer-fixture",
  }));
  api.respond("commercial.documents.save", (input) => {
    if (input.version !== document.version)
      throw new Error("The document was changed in another editor");
    document.xml = input.xml;
    document.version++;
    broadcast({ type: "changed", version: String(document.version) });
    broadcast({ type: "case", detail: caseDetail() });
    return { version: document.version, savedAt: new Date().toISOString() };
  });
  api.hold("commercial.documents.save");
  const first = page,
    second = await context.newPage();
  second.setDefaultTimeout(10000);
  try {
    await openApplication("/offers", "en");
    await page.getByText("Offer 0", { exact: true }).click();
    page = second;
    await openApplication("/offers", "en");
    await page.getByText("Offer 0", { exact: true }).click();
    const firstEditor = first.getByRole("dialog", {
      name: "Offer",
      exact: true,
    });
    const secondEditor = second.getByRole("dialog", {
      name: "Offer",
      exact: true,
    });
    await firstEditor.getByLabel("Ben Schneider", { exact: true }).waitFor();
    await secondEditor.getByLabel("Anna Müller", { exact: true }).waitFor();
    for (const editor of [firstEditor, secondEditor])
      await editor
        .locator('[data-gaeb-field="item-item1:text:0"]')
        .and(editor.locator(":enabled"))
        .focus();
    const one = firstEditor.locator("textarea.gaeb-canvas-input"),
      two = secondEditor.locator("textarea.gaeb-canvas-input");
    await one.fill("Hallo Welt");
    await second.waitForFunction(
      () =>
        document.querySelector("textarea.gaeb-canvas-input").value ===
        "Hallo Welt",
    );
    assert.match(
      document.xml,
      /Install insulation/,
      "The peer sees edits before the file has been saved",
    );
    await one.press("End");
    await one.press("Control+Shift+ArrowLeft");
    await first.waitForFunction(
      () =>
        document.querySelector("textarea.gaeb-canvas-input").selectionStart ===
        6,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      [...sockets.values()].some((peer) => peer.start === 6 && peer.end === 10),
    );
    holdUpdates = true;
    await Promise.all([one.fill("Hallo A Welt"), two.fill("Hallo B Welt")]);
    holdUpdates = false;
    updates.splice(0).forEach((apply) => apply());
    const converged = () => {
      const value = document.querySelector("textarea.gaeb-canvas-input").value;
      return value.includes("A ") && value.includes("B ");
    };
    await first.waitForFunction(converged);
    await second.waitForFunction(converged);
    const value = await one.inputValue();
    assert.equal(await two.inputValue(), value);
    assert.equal((value.match(/Hallo/g) ?? []).length, 1);
    const calls = api.requests.filter(
      (request) => request.path === "commercial.cases.get",
    ).length;
    api.release("commercial.documents.save");
    await firstEditor
      .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
      .waitFor({ timeout: 15000 });
    await secondEditor
      .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
      .waitFor({ timeout: 15000 });
    assert.ok(document.xml.includes(value));
    await new Promise((resolve) => setTimeout(resolve, 5500));
    assert.equal(
      api.requests.filter((request) => request.path === "commercial.cases.get")
        .length,
      calls,
      "Typing, saving and idle editors never reload the entire case",
    );
    state.cases.get("overlay-0").case.status = "sent";
    broadcast({ type: "case", detail: caseDetail() });
    await firstEditor
      .getByRole("button", { name: "Revise offer", exact: true })
      .waitFor();
    await secondEditor
      .getByRole("button", { name: "Revise offer", exact: true })
      .waitFor();
    assert.equal(
      api.requests.filter((request) => request.path === "commercial.cases.get")
        .length,
      calls,
    );
    page = first;
    await checkPageLayout("gaeb-live-text-and-cursors");
  } finally {
    api.release("commercial.documents.save");
    page = first;
    await second.close();
  }
});

test("temporary storage errors still retry autosave and report their original cause", async () => {
  const state = seedOverlayOffers(1, true);
  api.fail("commercial.documents.save", "Temporary storage unavailable");
  await openApplication("/offers", "en");
  await page.getByText("Offer 0", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const quantity = dialog.getByRole("button", {
    name: "Quantity",
    exact: true,
  });
  await quantity.and(page.locator(":enabled")).waitFor();
  await quantity.focus();
  await dialog.locator("textarea.gaeb-canvas-input").fill("9.000");
  await dialog
    .getByText("Save failed — retrying automatically", { exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByText("Saving waits for correction", { exact: true })
      .count(),
    0,
  );
  api.recover("commercial.documents.save");
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.match(state.documents.get("scope-0").xml, /<Qty>9.000<\/Qty>/);
});

test("clicking empty editor space releases focus inside fullscreen and autosaves the last input", async () => {
  const state = await createOfferInEditor("Blurred offer");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const editor = dialog.getByRole("region", {
    name: "GAEB editor",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  await dialog
    .locator("textarea.gaeb-canvas-input")
    .fill("Saved after clicking blank space");
  await editor
    .locator(".gaeb-document-scroll")
    .click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(
    await editor.locator('.gaeb-outline [aria-selected="true"]').count(),
    0,
  );
  assert.equal(
    await editor
      .getByRole("button", { name: "Bold", exact: true })
      .isDisabled(),
    true,
  );
  const scope = [...state.documents.values()].find(
    (doc) => doc.purpose === "inquiry",
  );
  assert.match(scope.xml, /Saved after clicking blank space/);
  const outline = editor.getByRole("navigation", {
    name: "Document outline",
    exact: true,
  });
  await outline
    .getByText("Saved after clicking blank space", { exact: true })
    .click();
  const tree = outline.getByRole("treegrid");
  const box = await tree.boundingBox();
  await tree.click({ position: { x: 140, y: box.height - 10 } });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  assert.equal(await outline.locator('[aria-selected="true"]').count(), 0);
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
    true,
    "Keyboard focus remains in the fullscreen dialog after deselection",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

test("previous-position autocomplete searches descriptions and reuses the complete text inside fullscreen", async () => {
  const state = await createOfferInEditor("Library offer");
  api.respond("gaeb.positions.search", ({ query }) => {
    return {
      items: query.toLowerCase().includes("fire")
        ? [
            {
              id: "catalog-hatch",
              shortText: "Inspection hatch",
              description: "Fit fire-rated plasterboard.",
              unit: "m²",
              sourceFile: "Previous scope.x83",
            },
          ]
        : [],
      indexing: false,
    };
  });
  api.hold("gaeb.positions.search");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const search = dialog.getByRole("combobox", {
    name: "Search previous items",
    exact: true,
  });
  const request = page.waitForRequest((request) =>
    request.url().includes("gaeb.positions.search"),
  );
  await search.fill("fire");
  await request;
  await dialog
    .locator(".gaeb-document-scroll")
    .click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(
    () =>
      document.activeElement?.classList.contains("gaeb-editor") &&
      !document.querySelector('.gaeb-position-search [aria-busy="true"]'),
  );
  const response = page.waitForResponse((response) =>
    response.url().includes("gaeb.positions.search"),
  );
  api.release("gaeb.positions.search");
  await response;
  await search.fill("fire");
  await page
    .getByRole("option", { name: /Inspection hatch.*fire-rated/ })
    .waitFor();
  await checkPageLayout("gaeb-position-autocomplete");
  await dialog
    .locator(".gaeb-document-scroll")
    .click({ position: { x: 4, y: 4 } });
  await page
    .getByRole("option", { name: /Inspection hatch.*fire-rated/ })
    .waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  await search.fill("fire");
  await page
    .getByRole("option", { name: /Inspection hatch.*fire-rated/ })
    .click();
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  const scope = [...state.documents.values()].find(
    (doc) => doc.purpose === "inquiry",
  );
  assert.match(scope.xml, /Inspection hatch/);
  assert.match(scope.xml, /Fit fire-rated plasterboard/);
  assert.match(scope.xml, /<QU>m²<\/QU>/);
  assert.match(scope.xml, /<Qty>0.000<\/Qty>/);
  assert.equal(await page.getByRole("dialog").count(), 1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

test("offer ribbon groups workflow and editing commands with a compact title bar on desktop and mobile", async () => {
  seedOverlayOffers(1, true);
  await openApplication("/offers", "en");
  await page.getByText("Offer 0", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  await dialog.locator(".gaeb-editor").waitFor();
  await dialog.getByRole("tabpanel", { name: "Home", exact: true }).waitFor();
  const heading = await dialog.locator(".ss-modal-heading").boundingBox();
  const label = await dialog.locator(".ss-modal-label").boundingBox();
  assert.ok(
    heading.x < 24 && label.x > heading.x + heading.width,
    `Title and filename are aligned together at the left ${JSON.stringify({ heading, label })}`,
  );
  await checkPageLayout("offer-ribbon-desktop");
  assert.equal(
    await dialog.getByRole("tab", { name: "Review", exact: true }).count(),
    0,
  );
  await dialog
    .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
    .waitFor();
  await dialog.getByRole("tab", { name: "Home", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 900 });
  await checkPageLayout("offer-ribbon-mobile");
  await dialog
    .getByRole("button", { name: "Collapse ribbon", exact: true })
    .click();
  assert.equal(await dialog.getByRole("tabpanel").count(), 0);
  await checkPageLayout("offer-ribbon-mobile-collapsed");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

for (const locale of ["de", "en"]) {
  test(`offer header shows scope and pricing clearly with compact labels in ${locale}`, async () => {
    seedOverlayOffers(1, true);
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApplication("/offers", locale);
    await page.getByText("Offer 0", { exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: locale === "de" ? "Angebot" : "Offer",
      exact: true,
    });
    await dialog.locator(".gaeb-editor").waitFor();
    const header = async (name) => {
      if (!process.env.SORTSYS_UI_SCREENSHOTS) return;
      await page.mouse.move(5, 5);
      await page.getByRole("tooltip").waitFor({ state: "hidden" });
      const box = await dialog.locator(".gaeb-office-ribbon").boundingBox();
      await mkdir(process.env.SORTSYS_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(
          process.env.SORTSYS_UI_SCREENSHOTS,
          `${name}-${locale}-crop.png`,
        ),
        clip: {
          x: 0,
          y: 0,
          width: page.viewportSize().width,
          height: Math.ceil(box.y + box.height + 26),
        },
      });
    };
    const start = dialog.getByRole("button", {
      name: locale === "de" ? "Kalkulation beginnen" : "Start pricing",
      exact: true,
    });
    assert.match(await start.locator("span").innerText(), /\n/);
    assert.ok(
      (await start.boundingBox()).width < 110,
      "Two-part captions use compact two-line buttons",
    );
    await header("header-scope-desktop");
    await dialog
      .getByRole("button", {
        name: locale === "de" ? "Kalkulation beginnen" : "Start pricing",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("button", {
        name: locale === "de" ? "Einheitspreis" : "Unit price",
        exact: true,
      })
      .and(page.locator(":enabled"))
      .waitFor();
    assert.equal(
      await dialog
        .getByRole("button", {
          name: locale === "de" ? "Dokument wechseln" : "Switch document",
          exact: true,
        })
        .count(),
      0,
    );
    assert.equal(await dialog.getByRole("menuitemcheckbox").count(), 0);
    const scope = dialog.getByRole("button", {
      name:
        locale === "de" ? "Leistungsumfang bearbeiten" : "Edit scope of work",
      exact: true,
    });
    const submission = dialog.getByRole("button", {
      name: locale === "de" ? "Abgabe erfassen" : "Record submission",
      exact: true,
    });
    assert.match(await submission.locator("span").innerText(), /\n/);
    assert.ok((await submission.boundingBox()).width < 100);
    assert.equal(
      await dialog
        .getByRole("button", {
          name: locale === "de" ? "Kalkulation öffnen" : "Open pricing",
          exact: true,
        })
        .count(),
      0,
      "The current document is not offered as its own action",
    );
    await scope.click();
    await dialog
      .getByRole("button", {
        name: locale === "de" ? "Menge" : "Quantity",
        exact: true,
      })
      .and(page.locator(":enabled"))
      .waitFor();
    const calculation = dialog.getByRole("button", {
      name: locale === "de" ? "Kalkulation öffnen" : "Open pricing",
      exact: true,
    });
    await calculation.focus();
    await calculation.press("Enter");
    await dialog
      .getByRole("button", {
        name: locale === "de" ? "Einheitspreis" : "Unit price",
        exact: true,
      })
      .and(page.locator(":enabled"))
      .waitFor();
    await header("header-pricing-desktop");
    await checkPageLayout(`header-pricing-desktop-${locale}`);
    await page.setViewportSize({ width: 390, height: 900 });
    const view = dialog.getByRole("tab", {
      name: locale === "de" ? "Ansicht" : "View",
      exact: true,
    });
    const [viewBounds, tabsBounds] = await Promise.all([
      view.boundingBox(),
      dialog
        .getByRole("tablist", {
          name: locale === "de" ? "Menüband" : "Ribbon",
          exact: true,
        })
        .boundingBox(),
    ]);
    assert.ok(
      viewBounds.x + viewBounds.width <= tabsBounds.x + tabsBounds.width + 1,
      `All ribbon tabs fit without clipping at 390px: ${JSON.stringify({ viewBounds, tabsBounds })}`,
    );
    await header("header-pricing-mobile");
    await checkPageLayout(`header-pricing-mobile-${locale}`);
  });
}

test("fullscreen outline mixes groups with items and moves a deep position directly into its ancestor", async () => {
  const state = await createOfferInEditor("Mixed hierarchy");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const outline = dialog.getByRole("navigation", {
    name: "Document outline",
    exact: true,
  });
  for (const title of ["Group A", "Group B", "Group C"]) {
    await outline
      .getByRole("button", { name: "New section", exact: true })
      .click();
    const name = outline.getByRole("textbox", {
      name: "Section name",
      exact: true,
    });
    await name.fill(title);
    await name.press("Enter");
  }
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  await dialog.locator("textarea.gaeb-canvas-input").fill("Position A");
  const row = (label) =>
    outline
      .locator("[data-gaeb-entry]")
      .filter({ has: page.getByText(label, { exact: true }) });
  await row("Position A").dragTo(row("Group A"), {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 170, y: 18 },
  });
  await page.waitForFunction(() => {
    const rows = [
      ...document.querySelectorAll(".gaeb-outline [data-gaeb-entry]"),
    ];
    const position = rows
      .find((row) => row.textContent.includes("Position A"))
      ?.querySelector(".gaeb-tree-row");
    const group = rows
      .find((row) => row.textContent.includes("Group B"))
      ?.querySelector(".gaeb-tree-row");
    return (
      position &&
      group &&
      position.style.paddingInlineStart === group.style.paddingInlineStart
    );
  });
  assert.equal(
    await outline.getByText("Work items", { exact: true }).count(),
    0,
  );
  const itemBox = await row("Position A").boundingBox();
  await row("Group B").dragTo(row("Position A"), {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 140, y: itemBox.height - 2 },
  });
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  const labels = await outline.locator(".gaeb-tree-label").allTextContents();
  assert.deepEqual(labels, ["Group A", "Position A", "Group B", "Group C"]);
  assert.match(
    [...state.documents.values()].find((doc) => doc.purpose === "inquiry").xml,
    /Position A/,
  );
  await row("Group C").getByText("Group C", { exact: true }).click();
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  await dialog.locator("textarea.gaeb-canvas-input").fill("Nested position");
  await outline
    .getByRole("button", { name: "Entire document", exact: true })
    .click();
  await outline
    .getByRole("button", { name: "New section", exact: true })
    .click();
  const sectionName = outline.getByRole("textbox", {
    name: "Section name",
    exact: true,
  });
  await sectionName.fill("Group D");
  await sectionName.press("Enter");
  await row("Group D").dragTo(row("Nested position"), {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 140, y: 2 },
  });
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.deepEqual(
    await outline.locator(".gaeb-tree-label").allTextContents(),
    [
      "Group A",
      "Position A",
      "Group B",
      "Group C",
      "Group D",
      "Nested position",
    ],
  );
  await checkPageLayout("gaeb-mixed-hierarchy");
  await page.setViewportSize({ width: 390, height: 900 });
  await checkPageLayout("gaeb-mixed-hierarchy-mobile");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

test("offer hierarchy edits stay inside the fullscreen focus scope and flow into pricing", async () => {
  const state = await createOfferInEditor("Hierarchical offer");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const input = dialog.locator("textarea.gaeb-canvas-input");
  const outline = dialog.getByRole("navigation", {
    name: "Document outline",
    exact: true,
  });
  await outline
    .getByRole("button", { name: "New section", exact: true })
    .click();
  const draftName = outline.getByRole("textbox", {
    name: "Section name",
    exact: true,
  });
  await draftName.fill("Cancel this folder");
  await draftName.press("Escape");
  assert.equal(await dialog.isVisible(), true);
  assert.equal(
    await outline.getByText("Cancel this folder", { exact: true }).count(),
    0,
  );
  for (const label of ["Exterior", "Insulation"]) {
    const action = "New section";
    await outline.getByRole("button", { name: action, exact: true }).click();
    const form = outline.getByRole("form", {
      name: "Create section",
      exact: true,
    });
    await form.getByRole("textbox", { name: /^Section name/ }).fill(label);
    await form
      .getByRole("textbox", { name: "Section name", exact: true })
      .press("Enter");
    await form.waitFor({ state: "hidden" });
    assert.equal(
      await outline
        .locator('[aria-selected="true"]')
        .evaluate((node) => node === document.activeElement),
      true,
      "Creating a folder keeps keyboard focus in the outline",
    );
  }
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  await input.fill("Install the insulation panels");
  await input.press("Tab");
  await input.fill("4.000");
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await outline
    .getByText("Install the insulation panels", { exact: true })
    .waitFor();
  const scope = [...state.documents.values()].find(
    (doc) => doc.purpose === "inquiry",
  );
  assert.match(scope.xml, /<Qty>4.000<\/Qty>/);
  assert.equal((scope.xml.match(/<Type>BoQLevel<\/Type>/g) ?? []).length, 2);
  await dialog
    .getByRole("button", { name: "Start pricing", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Unit price", exact: true })
    .waitFor();
  const bid = [...state.documents.values()].find(
    (doc) => doc.purpose === "offer",
  );
  assert.ok(bid.xml.includes('RNoPart="1"'));
  assert.equal((bid.xml.match(/<Type>BoQLevel<\/Type>/g) ?? []).length, 2);
  assert.equal(await page.getByRole("dialog").count(), 1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
});

test("offer rows drag inside fullscreen, retain prices by ID and cancel keyboard drag without closing", async () => {
  const state = await createOfferInEditor("Reordered offer");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const input = dialog.locator("textarea.gaeb-canvas-input");
  const outline = dialog.getByRole("navigation", {
    name: "Document outline",
    exact: true,
  });
  const row = (label) =>
    outline
      .locator("[data-gaeb-entry]")
      .filter({ has: page.getByText(label, { exact: true }) });
  for (const label of ["Alpha", "Beta"]) {
    await dialog.getByRole("button", { name: "Add item", exact: true }).click();
    await input.fill(label);
    await input.press("Tab");
    await input.fill("2.000");
  }
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await dialog
    .getByRole("button", { name: "Start pricing", exact: true })
    .click();
  const prices = dialog.getByRole("button", {
    name: "Unit price",
    exact: true,
  });
  await prices.first().and(page.locator(":enabled")).waitFor();
  for (const [index, price] of ["11.000", "22.000"].entries()) {
    await prices.nth(index).focus();
    await input.fill(price);
  }
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  const bid = [...state.documents.values()].find(
    (doc) => doc.purpose === "offer",
  );
  const pricesById = async (xml) =>
    page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, "application/xml");
      return Object.fromEntries(
        [...doc.getElementsByTagNameNS("*", "Item")].map((item) => [
          item.getAttribute("ID"),
          item.getElementsByTagNameNS("*", "UP")[0]?.textContent,
        ]),
      );
    }, xml);
  const originalPrices = await pricesById(bid.xml);
  assert.deepEqual(Object.values(originalPrices), ["11.000", "22.000"]);
  await dialog
    .getByRole("button", { name: "Edit scope of work", exact: true })
    .click();
  await row("Beta")
    .getByRole("button", { name: /Move entry/ })
    .waitFor();
  await row("Beta").dragTo(row("Alpha"), {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 140, y: 2 },
  });
  await row("Beta").getByText("1", { exact: true }).waitFor();
  await row("Alpha").getByText("2", { exact: true }).waitFor();
  const handle = row("Beta").getByRole("button", { name: /Move entry/ });
  await handle.focus();
  await handle.press("Enter");
  await page.keyboard.press("Escape");
  assert.equal(
    await dialog.isVisible(),
    true,
    "Escape cancels the drag within the fullscreen dialog",
  );
  await row("Beta").getByText("1", { exact: true }).waitFor();
  await dialog
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  const scope = [...state.documents.values()].find(
    (doc) => doc.purpose === "inquiry",
  );
  assert.ok(scope.xml.indexOf("Beta") < scope.xml.indexOf("Alpha"));
  await dialog
    .getByRole("button", { name: "Update pricing", exact: true })
    .click();
  await prices.first().and(page.locator(":enabled")).waitFor();
  assert.deepEqual(
    await pricesById(state.documents.get(bid.id).xml),
    originalPrices,
  );
  assert.equal(
    await outline.getByRole("button", { name: /^Move (up|down)$/ }).count(),
    0,
  );
  await checkPageLayout("offer-dragged-outline");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

test("offer inquiry button rejects the wrong phase inside the dialog without replacing the scope", async () => {
  const state = await createOfferInEditor("Retained scope");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const before = [...state.documents.values()][0].xml;
  const chooser = page.waitForEvent("filechooser");
  await dialog
    .getByRole("button", { name: "Read work inquiry", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "Wrong.x84",
    mimeType: "application/xml",
    buffer: Buffer.from(
      contractorInquiry
        .replaceAll("DA83", "DA84")
        .replace("<DP>83</DP>", "<DP>84</DP>"),
    ),
  });
  await dialog
    .getByText(
      "This file does not have the document type needed for this step. Check its GAEB phase.",
      { exact: true },
    )
    .waitFor();
  assert.equal(state.documents.size, 1);
  assert.equal([...state.documents.values()][0].xml, before);
  assert.equal(
    await dialog
      .getByRole("button", { name: "Start pricing", exact: true })
      .isEnabled(),
    true,
  );
});

test("read-only offers open directly in fullscreen without mutation actions or an intermediate detail page", async () => {
  const state = seedContractorWorkflows(false);
  state.cases.set("offer-readonly", {
    case: {
      id: "offer-readonly",
      kind: "offer",
      title: "Read-only offer",
      reference: "ANG-READ",
      status: "draft",
      customerName: "Fixture Customer",
      customerId: "customer-fixture",
      projectId: "project-fixture",
      parentCaseId: null,
      netAmount: null,
      currency: "EUR",
      existingContract: false,
    },
    events: [],
  });
  state.documents.set("readonly-inquiry", {
    id: "readonly-inquiry",
    caseId: "offer-readonly",
    purpose: "inquiry",
    phase: "83",
    fileName: "Readonly.x83",
    xml: contractorInquiry,
    readOnly: true,
    version: 1n,
    sourceDocumentId: null,
    sourceVersion: null,
  });
  await openApplication("/offers", "en");
  await page.getByText("Read-only offer", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  await dialog.locator(".gaeb-editor").waitFor();
  assert.equal(await dialog.locator('[draggable="true"]').count(), 0);
  assert.equal(
    await dialog.getByRole("button", { name: /Move entry/ }).count(),
    0,
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Read work inquiry", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Start pricing", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("region", { name: "Workflow documents", exact: true })
      .count(),
    0,
  );
  await checkPageLayout("offer-readonly-direct-editor");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("heading", { name: "Offers", exact: true }).waitFor();
});

function seedOverlayOffers(count = 1, canManage = false) {
  const state = seedContractorWorkflows(canManage);
  for (let index = 0; index < count; index++) {
    const id = `overlay-${index}`;
    state.cases.set(id, {
      case: {
        id,
        kind: "offer",
        title: `Offer ${index}`,
        reference: `ANG-${index}`,
        status: "draft",
        customerId: "customer-fixture",
        customerName: "Fixture Customer",
        projectId: null,
        parentCaseId: null,
        netAmount: null,
        currency: "EUR",
        existingContract: false,
      },
      events: [],
    });
    state.documents.set(`scope-${index}`, {
      id: `scope-${index}`,
      caseId: id,
      purpose: "inquiry",
      phase: "83",
      fileName: `Offer-${index}.x83`,
      xml: contractorInquiry,
      readOnly: !canManage,
      version: 1n,
      sourceDocumentId: null,
      sourceVersion: null,
    });
  }
  api.respond("commercial.cases.list", (input) =>
    [...state.cases.values()]
      .map((detail) => detail.case)
      .filter(
        (row) =>
          (!input?.kind ||
            (input.kind === "sales"
              ? ["offer", "alternative"].includes(row.kind)
              : row.kind === input.kind)) &&
          (!input?.status || row.status === input.status) &&
          (!input?.search ||
            row.title.toLowerCase().includes(input.search.toLowerCase())),
      )
      .slice(
        Number(input?.offset ?? 0),
        Number(input?.offset ?? 0) + Number(input?.limit ?? 50),
      ),
  );
  return state;
}

test("offer overlay preserves the current route, filters, loaded pages, focus and scroll position", async () => {
  seedOverlayOffers(60);
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApplication("/offers", "en");
  const search = page.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("Offer");
  const searchNode = await search.elementHandle();
  await page.getByText("Offer 49", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  const last = page
    .getByRole("row")
    .filter({ has: page.getByText("Offer 59", { exact: true }) });
  await last.scrollIntoViewIfNeeded();
  await last.focus();
  const before = await page.evaluate(() => ({
    url: location.href,
    length: history.length,
    scroll: scrollY,
    title: document.title,
  }));
  await last.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  await dialog.locator(".gaeb-editor").waitFor();
  assert.equal(
    await page.locator("[data-fixture-path]").getAttribute("data-fixture-path"),
    "/offers",
  );
  assert.equal(await searchNode.evaluate((node) => node.isConnected), true);
  assert.equal(new URL(page.url()).pathname, "/gaeb/overlay-59");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('[aria-label="Offers list"][aria-busy="true"]').waitFor();
  await page.locator('[aria-label="Offers list"][aria-busy="false"]').waitFor();
  assert.equal(await search.inputValue(), "Offer");
  assert.equal(await searchNode.evaluate((node) => node.isConnected), true);
  assert.equal(await page.getByText("Offer 59", { exact: true }).count(), 1);
  const after = await page.evaluate(() => ({
    url: location.href,
    length: history.length,
    scroll: scrollY,
    title: document.title,
  }));
  assert.equal(after.url, before.url);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.title, before.title);
  assert.ok(
    Math.abs(after.scroll - before.scroll) <= 2,
    JSON.stringify({ before, after }),
  );
  assert.equal(
    await last.evaluate(
      (node) =>
        node === document.activeElement ||
        node.contains(document.activeElement),
    ),
    true,
  );
});

test("offer backdrop and focus scope remain mounted through delayed workflow and document loading", async () => {
  seedOverlayOffers(1);
  api.hold("commercial.cases.get");
  api.hold("commercial.documents.get");
  await openApplication("/offers", "en");
  await page.getByText("Offer 0", { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const initial = await dialog.elementHandle();
  const assertCenteredLoading = async (name) => {
    const loading = dialog.locator(".commercial-editor-loading");
    await loading.waitFor();
    const geometry = await loading.evaluate((node) => {
      const content = node.closest(".ss-modal-content").getBoundingClientRect();
      const spinner = node.querySelector(".ss-spinner").getBoundingClientRect();
      return {
        dx: Math.abs(
          (spinner.left + spinner.right - content.left - content.right) / 2,
        ),
        dy: Math.abs(
          (spinner.top + spinner.bottom - content.top - content.bottom) / 2,
        ),
      };
    });
    assert.ok(geometry.dx < 120 && geometry.dy < 50, JSON.stringify(geometry));
    await page.screenshot({
      path: join(process.env.SORTSYS_UI_SCREENSHOTS ?? "/tmp", `${name}.png`),
    });
  };
  await assertCenteredLoading("offer-loading-workflow");
  await initial.evaluate((node) => {
    window.__commercialDialogDetached = false;
    window.__commercialDialogObserver = new MutationObserver(() => {
      if (!node.isConnected) window.__commercialDialogDetached = true;
    });
    window.__commercialDialogObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
  api.release("commercial.cases.get");
  await page.getByRole("dialog", { name: "Offer", exact: true }).waitFor();
  assert.equal(await initial.evaluate((node) => node.isConnected), true);
  await assertCenteredLoading("offer-loading-document");
  api.release("commercial.documents.get");
  await dialog.locator(".gaeb-editor").waitFor();
  assert.equal(await dialog.count(), 1);
  assert.equal(
    await initial.evaluate(
      (node) => node === document.querySelector('[role="dialog"]'),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => window.__commercialDialogDetached),
    false,
  );
  assert.equal(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
    true,
  );
  await page.evaluate(() => window.__commercialDialogObserver.disconnect());
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
});

test("browser Back closes the offer overlay through autosave without navigating the background page", async () => {
  const state = seedOverlayOffers(1, true);
  await openApplication("/offers", "en");
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.set("back-test", "1");
    history.pushState(history.state, "", url);
  });
  const originalUrl = page.url();
  await page.getByText("Offer 0", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const quantity = dialog.getByRole("button", {
    name: "Quantity",
    exact: true,
  });
  await quantity.and(page.locator(":enabled")).waitFor();
  await quantity.focus();
  await dialog.locator("textarea.gaeb-canvas-input").fill("6.750");
  await dialog.locator('[data-save-state="saving"]').waitFor();
  await page.evaluate(() => history.back());
  await dialog.waitFor({ state: "hidden" });
  await page.waitForURL(originalUrl);
  assert.equal(
    await page.locator("[data-fixture-path]").getAttribute("data-fixture-path"),
    "/offers",
  );
  assert.match(state.documents.get("scope-0").xml, /<Qty>6.750<\/Qty>/);
});

for (const kind of ["offer", "measurement"])
  test(`${kind} uses the GAEB URL on refresh, direct links and browser Forward while preserving the background`, async () => {
    const state = seedOverlayOffers(1, true);
    if (kind === "measurement") {
      state.cases.get("overlay-0").case.kind = "measurement";
      Object.assign(state.documents.get("scope-0"), {
        purpose: "measurement",
        phase: "31",
        fileName: "Measured.x31",
        xml: await readFile(
          new URL(
            "../../../sortsys-gaeb/scripts/fixtures/native-seed/demo.x31",
            import.meta.url,
          ),
          "utf8",
        ),
      });
    }
    await openApplication("/gaeb/overlay-0", "en");
    const dialog = page.getByRole("dialog", {
      name: kind === "measurement" ? "Measured work" : "Offer",
      exact: true,
    });
    await dialog.locator(".gaeb-editor").waitFor();
    const link = page.url();
    assert.equal(new URL(link).pathname, "/gaeb/overlay-0");
    await page.reload();
    await dialog.locator(".gaeb-editor").waitFor();
    assert.equal(page.url(), link);
    assert.equal(await page.getByRole("dialog").count(), 1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForURL((url) => url.pathname === "/offers");
    await page.goForward();
    await dialog.locator(".gaeb-editor").waitFor();
    assert.equal(page.url(), link);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForURL((url) => url.pathname === "/offers");
    await page.goto(link);
    await dialog.locator(".gaeb-editor").waitFor();
    assert.equal(
      await page
        .locator("[data-fixture-path]")
        .getAttribute("data-fixture-path"),
      "/gaeb/overlay-0",
    );
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForURL((url) => url.pathname === "/offers");
  });

test("project attachment URLs preserve the browser and reopen through history, reload and legacy links", async () => {
  populateAttachments();
  await openApplication("/projects/project-fixture/files?keep=1", "en");
  const search = page.getByPlaceholder("Search attachments", { exact: true });
  await search.fill("Specification");
  const input = await search.elementHandle();
  const background = page.url();
  const trigger = page.getByRole("button", { name: /Specification.pdf/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "View PDF", exact: true });
  await dialog.waitFor();
  const link = page.url();
  assert.equal(
    new URL(link).pathname,
    "/projects/project-fixture/files/file-fixture",
  );
  assert.equal(new URL(link).searchParams.has("file"), false);
  assert.equal(await input.evaluate((node) => node.isConnected), true);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL(background);
  assert.equal(await search.inputValue(), "Specification");
  assert.equal(await input.evaluate((node) => node.isConnected), true);
  await trigger.click();
  await dialog.waitFor();
  await page.evaluate(() => history.back());
  await dialog.waitFor({ state: "hidden" });
  await page.waitForURL(background);
  await page.goForward();
  await page.waitForURL(link);
  await dialog.waitFor();
  assert.equal(page.url(), link);
  await page.reload();
  await dialog.waitFor();
  assert.equal(page.url(), link);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL(background);
  await page.goto(link);
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL(background);
  const trailing = new URL(link);
  trailing.pathname += "/";
  await page.goto(trailing.href);
  await dialog.waitFor();
  await page.waitForURL(link);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL(background);
  const legacy = new URL(link);
  legacy.pathname = "/projects/project-fixture/files";
  legacy.searchParams.set("file", "file-fixture");
  await page.goto(legacy.href);
  await dialog.waitFor();
  await page.waitForURL(link);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL(background);
  legacy.pathname += "/";
  await page.goto(legacy.href);
  await dialog.waitFor();
  await page.waitForURL(link);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL(background);
  const missing = new URL(link);
  missing.pathname = "/projects/project-fixture/files/missing-file";
  await page.goto(missing.href);
  const unavailable = page.getByRole("dialog", {
    name: "File preview",
    exact: true,
  });
  await unavailable
    .getByText("The file is unavailable or you do not have access to it.", {
      exact: true,
    })
    .waitFor();
  await unavailable.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL(background);
});

test("the project image gallery updates its file ID without adding history entries per photo", async () => {
  populateAttachments();
  const date = new Date("2026-10-27T08:00:00Z");
  const image =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  api.respond(
    "projects.files.list",
    ["photo-1", "photo-2"].map((id, index) => ({
      id,
      projectId: "project-fixture",
      folderId: null,
      fileName: `Photo ${index + 1}.png`,
      mimeType: "image/png",
      kind: "image",
      status: "uploaded",
      textExtractionStatus: "none",
      createdAt: date,
      modifiedAt: date,
      uploadedAt: date,
      downloadUrl: image,
    })),
  );
  await openApplication("/projects/project-fixture/files", "en");
  const background = page.url();
  const length = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Photo 1.png", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    new URL(page.url()).pathname,
    "/projects/project-fixture/files/photo-2",
  );
  assert.equal(
    await dialog.locator(".ss-modal-label").textContent(),
    "Photo 2.png",
  );
  assert.equal(await page.evaluate(() => history.length), length + 1);
  const link = page.url();
  await page.reload();
  await dialog.waitFor();
  assert.equal(
    await dialog.locator(".ss-modal-label").textContent(),
    "Photo 2.png",
  );
  assert.equal(page.url(), link);
  await page.evaluate(() => history.back());
  await dialog.waitFor({ state: "hidden" });
  await page.waitForURL(background);
});

test("shared tab bars match organization tabs and every organization tab uses the full available width", async () => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const appearance = () =>
    page.getByRole("tablist").evaluate((node) => {
      const selected = node.querySelector('[aria-selected="true"]');
      const indicator = selected.querySelector('[data-slot="tabs-indicator"]');
      const bar =
        node.closest('[data-slot="tabs-list-container"]') ??
        node.parentElement.parentElement;
      return {
        background: getComputedStyle(bar).backgroundColor,
        radius: getComputedStyle(bar).borderRadius,
        height: selected.getBoundingClientRect().height,
        selectedBackground: getComputedStyle(indicator).backgroundColor,
      };
    });
  await openApplication("/admin", "en");
  await page
    .getByRole("tab", { name: "Company details", selected: true })
    .waitFor();
  const expected = await appearance();
  for (const label of [
    "Company details",
    "Invoice numbers",
    "Logo",
    "Staff",
    "LLM usage",
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await page.getByRole("tab", { name: label, selected: true }).waitFor();
    const width = await page
      .locator(".ss-tabs")
      .evaluate((node) => node.parentElement.getBoundingClientRect().width);
    assert.ok(width >= 1550, `${label}: ${width}px`);
  }
  await openApplication("/settings", "en");
  await page.getByRole("tab").first().waitFor();
  assert.deepEqual(await appearance(), expected);
  const tabs = page.getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForURL((url) => url.pathname === "/settings/passkeys");
  await tabs.nth(1).and(page.locator('[aria-selected="true"]')).waitFor();
  await page.keyboard.press("End");
  await page.waitForURL((url) => url.pathname === "/settings/language");
  await tabs.nth(2).and(page.locator('[aria-selected="true"]')).waitFor();
  await checkPageLayout("shared-tabs-settings");
});

async function seedExtendedContract() {
  const state = seedContractorWorkflows();
  const now = new Date().toISOString();
  state.cases.set("extended-contract", {
    case: {
      id: "extended-contract",
      reference: "ANG-42",
      kind: "offer",
      status: "accepted",
      title: "Musterhaus",
      existingContract: false,
      projectId: "project-fixture",
      parentCaseId: null,
      customerId: "customer-fixture",
      customerName: "Fixture Customer",
      currency: "EUR",
      netAmount: "10000.00",
      scopeItemIds: [],
      createdAt: now,
      modifiedAt: now,
    },
    events: [],
  });
  const xml = await readFile(
    new URL(
      "../../../sortsys-gaeb/scripts/fixtures/native-seed/demo.x86",
      import.meta.url,
    ),
    "utf8",
  );
  state.documents.set("extended-order", {
    id: "extended-order",
    caseId: "extended-contract",
    purpose: "order",
    phase: "86",
    fileName: "Musterhaus.x86",
    xml,
    version: 1n,
    readOnly: true,
    sourceDocumentId: null,
    sourceVersion: null,
  });
  api.respond("commercial.invoices.context", {
    progressInvoices: [],
    hasInvoice: false,
    hasFinalInvoice: false,
    vatRate: null,
  });
  api.respond("customers.get", {
    id: "customer-fixture",
    name: "Fixture Customer",
    address: { streetAddress: "Musterweg 20", zip: "06108", city: "Halle" },
    phoneNumbers: [],
    emailAddresses: [],
  });
  return state;
}

test("project creates a native X89 invoice and keeps it inside its fullscreen editor", async () => {
  const state = await seedExtendedContract();
  await openApplication("/projects/project-fixture/contract", "en");
  await page
    .getByRole("button", { name: "Create document", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Invoice", exact: true }).click();
  const form = page.getByRole("dialog", {
    name: "Create invoice",
    exact: true,
  });
  await form
    .getByRole("textbox", { name: /^Your tax number \/ VAT ID/ })
    .fill("DEMO-123");
  await form.getByRole("button", { name: "Edit invoice", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Invoice", exact: true });
  await editor.waitFor();
  await editor.locator("canvas").first().waitFor();
  const invoice = [...state.documents.values()].find(
    (d) => d.purpose === "invoice",
  );
  assert.ok(invoice.xml.includes("DA89/3.3"));
  assert.ok(invoice.xml.includes("<TaxNo>DEMO-123</TaxNo>"));
  assert.ok(invoice.xml.includes("Fixture Company"));
  assert.ok(invoice.xml.includes("Musterweg 20"));
  assert.equal(
    state.cases.get(invoice.caseId).case.parentCaseId,
    "extended-contract",
  );
  await editor
    .getByRole("button", { name: "Issue invoice", exact: true })
    .waitFor();
});

for (const type of ["procurement", "calculation"]) {
  test(`project creates editable native ${type} from the accepted contract`, async () => {
    const state = await seedExtendedContract();
    await openApplication("/projects/project-fixture/contract", "en");
    await page
      .getByRole("button", { name: "Create document", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: type === "procurement" ? "Price inquiry" : "Cost calculation",
        exact: true,
      })
      .click();
    const form = page.getByRole("dialog", {
      name: type === "procurement" ? "Price inquiry" : "Cost calculation",
      exact: true,
    });
    await form
      .getByRole("textbox", { name: /^Title/ })
      .fill(type === "procurement" ? "Material order" : "Internal costing");
    await form
      .getByRole("button", {
        name:
          type === "procurement"
            ? "Create price inquiry"
            : "Create calculation",
        exact: true,
      })
      .click();
    const editor = page.getByRole("dialog", {
      name: type === "procurement" ? "Price inquiry" : "Cost calculation",
      exact: true,
    });
    await editor.waitFor();
    await editor.locator("canvas").first().waitFor();
    const doc = [...state.documents.values()].find(
      (d) =>
        d.purpose ===
        (type === "procurement" ? "price_inquiry" : "calculation"),
    );
    assert.ok(
      doc.xml.includes(type === "procurement" ? "DA93/3.3" : "DA52/3.3"),
    );
    assert.equal(
      state.cases.get(doc.caseId).case.parentCaseId,
      "extended-contract",
    );
    if (type === "procurement") assert.ok(!doc.xml.includes("<UP>"));
    else
      await editor
        .getByRole("button", { name: "Add cost component", exact: true })
        .waitFor();
  });
}

for (const locale of ["en", "de"]) {
  test(`added daily-report hours focus the new employee field in ${locale}`, async () => {
    await openApplication("/fixtures/forms", locale);
    await page
      .getByRole("button", { name: "Create daily report", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const add = dialog.getByRole("button", {
      name: locale === "de" ? "Arbeitszeit" : "Work hours",
      exact: true,
    });
    await add.click();
    const employee = dialog
      .getByRole("combobox", {
        name: locale === "de" ? /^Mitarbeiter/ : /^Employee/,
      })
      .last();
    await page.waitForFunction(
      (node) => node === document.activeElement,
      await employee.elementHandle(),
    );
    await employee.fill("Anna");
    const previousEmployee = await employee.elementHandle();
    await employee.press("Escape");
    await add.click();
    const next = dialog
      .getByRole("combobox", {
        name: locale === "de" ? /^Mitarbeiter/ : /^Employee/,
      })
      .last();
    await page.waitForFunction(
      (node) => node === document.activeElement,
      await next.elementHandle(),
    );
    assert.equal(await previousEmployee.evaluate((node) => node.value), "Anna");
  });
}

test("added delivery-note products and special items focus the new field without stealing it back", async () => {
  await openApplication("/fixtures/forms", "en");
  await page
    .getByRole("button", { name: "Create delivery note", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Entry", exact: true }).click();
  const product = dialog.getByRole("combobox", { name: /^Product/ }).last();
  await page.waitForFunction(
    (node) => node === document.activeElement,
    await product.elementHandle(),
  );
  await product.press("Escape");
  await dialog
    .getByRole("button", { name: "Special items", exact: true })
    .click();
  const name = dialog.getByRole("textbox", { name: /^Name/ }).last();
  await page.waitForFunction(
    (node) => node === document.activeElement,
    await name.elementHandle(),
  );
  await name.fill("Extra delivery");
  await name.press("Tab");
  const amount = dialog.getByRole("spinbutton", { name: /^Quantity/ }).last();
  await page.waitForFunction(
    (node) => node === document.activeElement,
    await amount.elementHandle(),
  );
  await amount.fill("2");
  assert.equal(
    await amount.evaluate((node) => node === document.activeElement),
    true,
  );
});

test("regie-report additions focus employees, products and special item names", async () => {
  await openApplication("/fixtures/forms", "en");
  await page
    .getByRole("button", { name: "Create regie report", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  for (const [button, role, label] of [
    ["Work hours", "combobox", /^Employee/],
    ["Entry", "combobox", /^Product/],
    ["Special items", "textbox", /^Name/],
  ]) {
    await dialog.getByRole("button", { name: button, exact: true }).click();
    const input = dialog.getByRole(role, { name: label }).last();
    await page.waitForFunction(
      (node) => node === document.activeElement,
      await input.elementHandle(),
    );
    await input.press("Escape");
  }
});

test("a newly added product unit focuses its name autocomplete", async () => {
  api.respond("products.units.list", ["kg", "m²", "Stk"]);
  await openApplication("/fixtures/forms", "en");
  await page
    .getByRole("button", { name: "Create product", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog
    .getByRole("button", { name: /^(Add unit|Weitere Einheit)$/, exact: true })
    .click();
  const unit = dialog.getByRole("combobox", { name: /^(Unit|Einheit)/ }).last();
  await page.waitForFunction(
    (node) => node === document.activeElement,
    await unit.elementHandle(),
  );
});

for (const theme of ["light", "dark"])
  for (const width of [390, 1440]) {
    test(`scan history has content-sized rows and readable notices at ${width}px in ${theme}`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      const states = [
        "failed",
        "completed",
        "completed",
        "queued",
        "ocr",
        "matching",
      ];
      api.respond(
        "deliveryNotes.scan.list",
        states.map((state, index) => ({
          id: `scan-${index}`,
          state,
          fileName:
            index === 0
              ? "Sonderpreisliste 24.09.2026 Fa. Musterunternehmen.xlsx"
              : `PXL_20260904_144550517_${index}.jpg`,
          fileNames: ["scan.jpg"],
          documentType:
            index === 1 ? "invoice" : index === 2 ? "priceList" : null,
          error: state === "failed" ? "The document could not be read." : null,
          createdAt: new Date("2026-11-06T18:00:00Z"),
          updatedAt: new Date("2026-11-06T18:00:00Z"),
        })),
      );
      await openApplication("/import", "en", theme);
      const rows = page.locator(".delivery-scan-history-row");
      await rows.nth(5).waitFor();
      const geometry = await rows.evaluateAll((nodes) =>
        nodes.map((node) => {
          const row = node.getBoundingClientRect();
          return {
            top: row.top,
            bottom: row.bottom,
            height: row.height,
            children: [
              ...node.querySelectorAll(
                ".delivery-scan-history-file > *, .delivery-scan-history-state",
              ),
            ].map((child) => {
              const r = child.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom };
            }),
          };
        }),
      );
      geometry.forEach((row, index) => {
        for (const child of row.children)
          assert.ok(
            child.top >= row.top && child.bottom <= row.bottom,
            JSON.stringify({ row, child }),
          );
        if (index)
          assert.ok(
            row.top >= geometry[index - 1].bottom,
            JSON.stringify(geometry),
          );
      });
      assert.ok(
        geometry[1].height > geometry[0].height,
        "Document type adds its own line of space",
      );
      await rows.first().focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("alert")
        .filter({ hasText: "The document could not be read." })
        .waitFor();
      await checkPageLayout(`scan-history-${theme}-${width}`);
    });
  }

for (const extension of ["d83", "p83"])
  test(`work inquiry button opens ${extension} and starts native pricing without an address form`, async () => {
    const state = await createOfferInEditor(`Legacy ${extension}`);
    const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
    const chooser = page.waitForEvent("filechooser");
    await dialog
      .getByRole("button", { name: "Read work inquiry", exact: true })
      .click();
    await (
      await chooser
    ).setFiles(
      new URL(
        `../../../sortsys-gaeb/scripts/fixtures/legacy/anfrage.${extension}`,
        import.meta.url,
      ).pathname,
    );
    await dialog.getByText("anfrage.x83", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "Start pricing", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Unit price", exact: true })
      .and(page.locator(":enabled"))
      .first()
      .waitFor();
    const inquiry = [...state.documents.values()].find(
      (doc) => doc.readOnly && doc.phase === "83",
    );
    const offer = [...state.documents.values()].find(
      (doc) => doc.purpose === "offer",
    );
    assert.ok(inquiry.xml.includes("Wände verputzen"));
    assert.ok(inquiry.xml.includes("<Qty>12.500</Qty>"));
    assert.ok(inquiry.xml.includes("sortsys:legacy-source:v1:"));
    assert.equal(offer.phase, "84");
    assert.equal(offer.sourceDocumentId, inquiry.id);
    assert.ok(offer.xml.includes("Fixture Company"));
    assert.equal(await page.getByRole("dialog").count(), 1);
  });
test("editing the document designation updates the workflow heading and overview after autosave", async () => {
  const state = await createOfferInEditor("Initial designation");
  const dialog = page.getByRole("dialog", { name: "Offer", exact: true });
  const field = dialog.locator('[data-gaeb-field="document:title"]');
  await field.and(page.locator(":enabled")).waitFor();
  await field.focus();
  const input = dialog.locator("textarea.gaeb-canvas-input");
  await input.fill("Sanierung Südflügel – Angebot");
  await input.press("Tab");
  await dialog.locator('.gaeb-editor[data-save-state="saved"]').waitFor();
  assert.equal(
    [...state.cases.values()][0].case.title,
    "Sanierung Südflügel – Angebot",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByText("Sanierung Südflügel – Angebot", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("Initial designation", { exact: true }).count(),
    0,
  );
});
