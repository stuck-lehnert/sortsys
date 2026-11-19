import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;
before(async () => {
  server = await createFixtureServer();
  try {
    browser = await chromium.launch();
  } catch (error) {
    await server.close();
    throw error;
  }
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
});

async function open(options) {
  const context = await browser.newContext();
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await page.goto(`${server.origin}/crypto.html`);
    await page.waitForFunction(() => window.cryptoFixture);
    await page.evaluate(
      (options) =>
        options?.importPage
          ? window.cryptoFixture.showImportHistory(options)
          : window.cryptoFixture.showChatHistory(options),
      options,
    );
    return { context, page, external };
  } catch (error) {
    await context.close();
    throw error;
  }
}

test("accepted address proposals link to the remaining customer and identify deleted contacts", async () => {
  const { context, page, external } = await open({ addressReview: true });
  try {
    const card = page.getByRole("article").filter({
      hasText: "Adressänderungen bestätigt",
    });
    await card.getByText("Kontakt löschen", { exact: true }).waitFor();
    await card.getByText("Ansprechpartner zuordnen", { exact: true }).waitFor();
    const results = card.locator(".assistant-proposal-complete").getByRole("link");
    assert.deepEqual(
      await results.evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
      ["/customers/7"],
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

for (const [locale, theme] of [
  ["de", "light"],
  ["en", "dark"],
]) {
  test(`old chat decisions remain visible and do not claim missing execution evidence in ${locale} ${theme}`, async () => {
    const { context, page, external } = await open({ locale, theme });
    try {
      const missingEvidence =
        locale === "de"
          ? "Im bisherigen Verlauf wurde dieser Vorschlag angenommen. Ein Ausführungsnachweis ist nicht gespeichert."
          : "This proposal was accepted in the previous history. No execution record was saved.";
      await page.getByText(missingEvidence, { exact: true }).waitFor();
      assert.equal(await page.locator(".assistant-proposal").count(), 5);
      const historical = page
        .locator(".assistant-proposal.is-accepted")
        .filter({ hasText: missingEvidence });
      assert.equal(await historical.getByRole("link").count(), 0);
      await historical
        .getByText(locale === "de" ? "Vorgeschlagene Daten" : "Proposed data", {
          exact: true,
        })
        .waitFor();
      await page
        .getByText(
          locale === "de" ? "Überarbeitung angefordert" : "Revision requested",
          { exact: true },
        )
        .waitFor();
      await page
        .getByText("Andere Einheit verwenden", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByText("Nur im zweiten Konto 729361", { exact: true })
          .count(),
        0,
      );
      const state = await page.evaluate(() =>
        window.cryptoFixture.chatHistoryState(),
      );
      assert.equal(
        state.calls.some(
          (call) =>
            call.path.startsWith("llm.chats.") ||
            call.path.startsWith("llm.proposals."),
        ),
        false,
      );
      assert.equal(JSON.stringify(state.calls).includes("472915"), false);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      assert.deepEqual(
        accessibility.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
        [],
      );
      await page.evaluate(() => window.cryptoFixture.lockChatHistory());
      await page.waitForFunction(
        () =>
          !document.body.textContent.includes("472915") &&
          !document.body.textContent.includes("613947"),
      );
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("import history and selected originals disappear after signed permission revocation", async () => {
  const { context, page, external } = await open({ importPage: true });
  try {
    await page
      .getByText("Vertraulicher Lieferschein 782169.pdf", { exact: true })
      .waitFor();
    const fileInput = page.locator('input[type="file"][multiple]');
    await fileInput.setInputFiles({
      name: "Ausgewähltes Original 927845.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\nSelected private file"),
    });
    await page
      .getByRole("button", {
        name: "Ausgewähltes Original 927845.pdf entfernen",
        exact: true,
      })
      .waitFor();
    assert.equal(await fileInput.evaluate((input) => input.files.length), 1);
    await page.evaluate(() => window.cryptoFixture.revokeChatHistory());
    await page.waitForFunction(
      () =>
        !document.body.textContent.includes("782169") &&
        !document.body.textContent.includes("927845"),
    );
    assert.equal(await fileInput.evaluate((input) => input.files.length), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Dateien auswählen", exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

for (const reviewDelivery of ["module", "project"]) {
  test(`a scanned delivery keeps missing products and shows prices only for its signed ${reviewDelivery} scope`, async () => {
    const { context, page, external } = await open({ importPage: true, reviewDelivery });
    try {
      await page.getByRole("button").filter({ hasText: "Vertraulicher Lieferschein 782169.pdf" }).click();
      const dialog = page.getByRole("dialog", { name: "Lieferschein schreiben" });
      await dialog.getByText(/fehlenden oder geänderten Produktzuordnungen/).waitFor();
      assert.deepEqual(
        await dialog.getByRole("textbox", { name: /^Bezeichnung/ }).evaluateAll((fields) => fields.map(({ value }) => value)),
        ["Abdeckfolie", "Farbe"],
      );
      await dialog.getByRole("combobox", { name: /^Projekt/ }).fill("Baustelle");
      const project = page.getByRole("option", { name: "Eigene Baustelle" });
      await project.waitFor();
      assert.equal(await page.getByRole("option", { name: "Fremde Baustelle" }).count(), 0);
      await project.click();
      const prices = dialog.getByRole("spinbutton", { name: "Preis pro Einheit" });
      if (reviewDelivery === "module") {
        await prices.first().waitFor();
        assert.equal(await prices.first().isEnabled(), true);
      } else {
        assert.equal(await prices.count(), 0);
      }
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("a scanned invoice flags the changed package and recalculates when the current product is selected", async () => {
  const { context, page, external } = await open({ importPage: true, reviewPrice: true });
  try {
    await page.getByRole("button").filter({ hasText: "Rechnung Farbe.pdf" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "Preise aus Rechnung übernehmen" }).waitFor();
    await dialog.getByRole("button", { name: "Details für Farbe öffnen" }).click();
    const warning = dialog.getByText(/^Gebindeumrechnung prüfen/);
    await warning.waitFor();

    const price = dialog.getByRole("spinbutton", { name: "Nettopreis je kg" });
    assert.equal(await price.inputValue(), "1");
    await dialog.getByRole("combobox", { name: "Produktzuordnung" }).fill("Farbe");
    await page.getByRole("option", { name: /9 · Farbe/ }).click();
    assert.equal(await price.inputValue(), "1.2");
    assert.equal(await warning.count(), 0);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("a delayed import result cannot open a document dialog after permission revocation", async () => {
  const { context, page, external } = await open({
    importPage: true,
    hold: true,
  });
  try {
    await page
      .getByRole("button")
      .filter({ hasText: "Vertraulicher Lieferschein 782169.pdf" })
      .click();
    await page.waitForFunction(
      () => window.cryptoFixture.chatHistoryState().captured,
    );
    await page.evaluate(() => window.cryptoFixture.revokeChatHistory());
    await page.waitForFunction(
      () => !document.body.textContent.includes("782169"),
    );
    await page.evaluate(() => window.cryptoFixture.releaseChatHistory());
    await page.waitForFunction(
      () => window.cryptoFixture.chatHistoryState().delivered,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(
      await page.getByText("Zwei Eimer Farbe", { exact: true }).count(),
      0,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("read-only import history disables file selection while preserving previous results", async () => {
  const { context, page, external } = await open({
    importPage: true,
    readonly: true,
  });
  try {
    await page
      .getByText("Vertraulicher Lieferschein 782169.pdf", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Dateien auswählen", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page.locator('input[type="file"][multiple]').isDisabled(),
      true,
    );
    await page.evaluate(() => window.cryptoFixture.lockChatHistory());
    await page.waitForFunction(
      () => !document.body.textContent.includes("782169"),
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("history remains readable without a model provider while new live messages stay disabled", async () => {
  const { context, page } = await open({ provider: false });
  try {
    await page
      .getByText("Ein Ausführungsnachweis ist nicht gespeichert.", {
        exact: false,
      })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Nachricht", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await page.locator(".assistant-proposal").count(), 5);
  } finally {
    await context.close();
  }
});

test("the actual chat overview preserves its history without a model provider", async () => {
  const { context, page } = await open({ historyOnly: true, provider: false });
  try {
    await page.getByRole("link", { name: /Fenstersanierung 613947/ }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Neuer Chat", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByText("Der Global Admin hat noch keinen Provider eingerichtet.", {
        exact: true,
      })
      .waitFor();
  } finally {
    await context.close();
  }
});

test("read-only chat grants disable new messages and decisions", async () => {
  const { context, page } = await open({ readonly: true });
  try {
    await page.locator(".assistant-proposal-actions").waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Nachricht", exact: true })
        .isDisabled(),
      true,
    );
    const buttons = page.locator(".assistant-proposal-actions button");
    assert.equal(await buttons.count(), 3);
    for (const button of await buttons.all())
      assert.equal(await button.isDisabled(), true);
  } finally {
    await context.close();
  }
});

test("a delayed detail callback cannot restore private text after the account is locked", async () => {
  const { context, page } = await open({ hold: true });
  try {
    await page.waitForFunction(
      () => window.cryptoFixture.chatHistoryState().captured,
    );
    await page.evaluate(() => window.cryptoFixture.lockChatHistory());
    await page.evaluate(() => window.cryptoFixture.releaseChatHistory());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      (await page.locator("body").textContent()).includes("472915"),
      false,
    );
    assert.equal(await page.locator(".assistant-proposal").count(), 0);
  } finally {
    await context.close();
  }
});

test("a signed permission revocation hides loaded chat text and disables its actions", async () => {
  const { context, page } = await open();
  try {
    await page
      .getByText("Ein Ausführungsnachweis ist nicht gespeichert.", {
        exact: false,
      })
      .waitFor();
    await page.evaluate(() => window.cryptoFixture.revokeChatHistory());
    await page.waitForFunction(
      () =>
        !document.body.textContent.includes("472915") &&
        !document.body.textContent.includes("613947"),
    );
    assert.equal(
      await page
        .getByRole("textbox", { name: "Nachricht", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await page.locator(".assistant-proposal").count(), 0);
  } finally {
    await context.close();
  }
});

test("a delayed callback cannot restore chat contents after signed revocation", async () => {
  const { context, page } = await open({ hold: true });
  try {
    await page.waitForFunction(
      () => window.cryptoFixture.chatHistoryState().captured,
    );
    await page.evaluate(() => window.cryptoFixture.revokeChatHistory());
    await page.evaluate(() => window.cryptoFixture.releaseChatHistory());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      (await page.locator("body").textContent()).includes("472915"),
      false,
    );
    assert.equal(await page.locator(".assistant-proposal").count(), 0);
  } finally {
    await context.close();
  }
});

test("the history list is private and drops its loaded titles on permission revocation", async () => {
  const { context, page } = await open({ historyOnly: true });
  try {
    await page.getByRole("link", { name: /Fenstersanierung 613947/ }).waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: /Privater Verlauf eines anderen Kontos/ })
        .count(),
      0,
    );
    await page.evaluate(() => window.cryptoFixture.revokeChatHistory());
    await page.waitForFunction(
      () => !document.body.textContent.includes("613947"),
    );
    assert.equal(
      await page.getByRole("link", { name: /Fenstersanierung/ }).count(),
      0,
    );
  } finally {
    await context.close();
  }
});
