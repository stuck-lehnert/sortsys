import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { createFixtureServer } from "./browser-support.mjs";

let browser, server;
before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch({
    executablePath: process.env.SORTSYS_E2E_CHROMIUM,
  });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(options = {}) {
  const context = await browser.newContext(options);
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${server.origin}/crypto.html`);
  await page.waitForFunction(() => window.cryptoFixture);
  return { context, page, external };
}

async function waitForClosedListboxes(page) {
  // Several portalled popups can coexist during their exit animation.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="listbox"]')].every(
      (node) => !node.checkVisibility(),
    ),
  );
}

async function revealField(page, field) {
  await field.and(page.locator(":enabled")).waitFor();
  await field.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  // React Aria closes non-modal lists on ancestor scroll. Deliver the scroll
  // before focusing a newly revealed input and opening its next list.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

test("backup history selection requires an explicit source organization and clears invalid or removed files", async () => {
  const { context, page, external } = await open();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.evaluate(() => window.cryptoFixture.showBackupSelection());
    const files = await page.evaluate(() =>
      window.cryptoFixture.backupSelectionFiles(),
    );
    const start = page.getByRole("button", { name: "Übernahme starten" });
    assert.equal(await start.isDisabled(), true);
    await page
      .getByLabel("Vorhandene Sicherung übernehmen (optional)", { exact: true })
      .setInputFiles({
        name: "tenant.sql",
        mimeType: "application/sql",
        buffer: Buffer.from(files.sql),
      });
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Übernahme starten",
        )?.disabled,
    );
    const historyFile = page.getByLabel(
      "Einleseverlauf aus Verwaltungsdatenbank (optional)",
      { exact: true },
    );
    await historyFile.setInputFiles({
      name: "administration.sql",
      mimeType: "application/sql",
      buffer: Buffer.from(files.history),
    });
    const organization = page.getByRole("combobox", {
      name: "Bisherige Organisation im Einleseverlauf",
    });
    await organization.waitFor();
    assert.equal(await organization.inputValue(), "");
    assert.equal(await start.isDisabled(), true);
    assert.equal(await organization.locator("option").count(), 3);
    await organization.selectOption("old-tenant");
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Ausgewählte Sicherung"]')
        ?.textContent.includes('"historyTenant":"old-tenant"'),
    );
    assert.equal(await start.isEnabled(), true);
    await page.screenshot({
      path: "/tmp/sortsys-backup-history-picker.png",
      fullPage: true,
    });
    await historyFile.setInputFiles({
      name: "wrong.sql",
      mimeType: "application/sql",
      buffer: Buffer.from(
        "COPY public.__tenants (name) FROM stdin;\nold-tenant\n\\.\n",
      ),
    });
    await page
      .getByText("Die Sicherung enthält keinen Einleseverlauf.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await start.isDisabled(), true);
    await page
      .getByRole("button", { name: "Einleseverlauf weglassen" })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Ausgewählte Sicherung"]')
        ?.textContent.includes('"historyTenant":null'),
    );
    assert.equal(await start.isEnabled(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("native document authors are checked before XML rendering or content-key access", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.documentAuthors(),
    );
    assert.deepEqual(result, {
      readerRejected: true,
      directLoadRejected: true,
      writerAccepted: true,
      renderCalls: 0,
      keyReads: 0,
    });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("partial native XML edits retain unread amounts in the real browser worker", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.partialDocumentWorker(),
    );
    assert.deepEqual(result, {
      complete: false,
      secretsAbsent: true,
      exactNative: true,
      foreignWritesRejected: true,
    });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("financial worker errors distinguish unavailable arithmetic from malformed totals without external requests", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.financialDocumentWorker(),
    );
    assert.deepEqual(result, {
      unsupported: null,
      missing: { phase: "86", netAmount: null },
      legacyAmount: "1851.17",
      malformedRejected: true,
    });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("printed totals preserve provisional and lump-sum rules without inventing missing values", async () => {
  const { context, page, external } = await open();
  try {
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.printedAmounts()),
      {
        ordinary: "30.00",
        provisional: "0.00",
        lumpSum: "10.00",
        lumpSumItem: "10.00",
        noQuantity: null,
        noPrice: null,
        provisionalNoPrice: null,
        sourceUnchanged: true,
      },
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("native metadata identities survive missing invoice fields and target the same XML element", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.metadataBindings(),
    );
    assert.deepEqual(result, {
      sourceHasDifferentOffsets: true,
      sameIdentity: true,
      nativeProjectionExact: true,
      scopeOwner: "scope",
      billingOwner: "billing",
      editorOwner: "scope",
      noPrivateFields: true,
      privateFieldRejectedBeforeRegistration: true,
    });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("encrypted live connections retain independent scope and invoice text through a late join", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.mixedFacetConnection(),
    );
    assert.deepEqual(result, {
      text: ["Hallo Baustelle", "Hallo Baustelle", "Hallo Baustelle"],
      invoice: ["2026-11-14", "2026-11-14", "2026-11-14"],
      nativeDate: "2026-11-14",
      rejected: [0, 0, 0],
    });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("a scope-only canvas edits descriptions without rendering hidden prices, quantities or totals", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPartialDocument());
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.gaebPartialFixture.ready());
    const layout = await page.evaluate(() =>
      window.gaebPartialFixture.layout(),
    );
    assert.ok(
      layout.fields.some(
        (field) => field.key.endsWith(":text:0") && field.editable,
      ),
    );
    assert.equal(
      layout.fields.some((field) => /:(?:UP|Qty)$/.test(field.key)),
      false,
    );
    assert.equal(layout.text.includes("592"), false);
    assert.equal(layout.text.includes("3,125"), false);
    assert.equal(layout.text.includes("1.851"), false);
    assert.equal(layout.text.includes("Summe netto"), false);
    assert.equal(
      await page
        .getByRole("button", { name: "Drucken", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page.locator(".gaeb-editor").getAttribute("data-schema-state"),
      "partial",
    );

    const description = page.locator('[data-gaeb-field$=":text:0"]').first();
    await description.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(
      await page.evaluate(() => window.gaebPartialFixture.description),
    );
    assert.equal(
      await page.evaluate(() => window.gaebPartialFixture.save()),
      true,
    );
    const result = await page.evaluate(() => ({
      calls: window.gaebPartialFixture.calls(),
      expected: window.gaebPartialFixture.expected(),
    }));
    assert.ok(result.calls.length > 0);
    assert.equal(result.calls.at(-1).native, result.expected);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("readable commercial amounts remain selectable but cannot be changed through their field callbacks", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showPartialDocument({ readAll: true }),
    );
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.gaebPartialFixture.ready());
    const layout = await page.evaluate(() =>
      window.gaebPartialFixture.layout(),
    );
    const price = layout.fields.find((field) => field.key.endsWith(":UP"));
    const quantity = layout.fields.find((field) => field.key.endsWith(":Qty"));
    assert.ok(price && quantity);
    assert.equal(price.editable, false);
    assert.equal(quantity.editable, false);
    assert.equal(price.value, "592.375");
    assert.equal(quantity.value, "3.125");
    assert.equal(
      await page.evaluate(() => window.gaebPartialFixture.deniedCommits()),
      0,
    );
    assert.ok(
      layout.fields.some(
        (field) => field.key.endsWith(":text:0") && field.editable,
      ),
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("removing field access clears the active native input and its clipboard source", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showPartialDocument({ readAll: true }),
    );
    const price = page.locator('[data-gaeb-field$=":UP"]');
    await price.waitFor({ state: "visible" });
    await price.scrollIntoViewIfNeeded();
    const bounds = await price.boundingBox();
    assert.ok(bounds);
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.waitForFunction(
      () => document.querySelector(".gaeb-canvas-input")?.value === "592.375",
    );
    await page.evaluate(() => window.gaebPartialFixture.restrict());
    await page.waitForFunction(
      () => !document.querySelector('[data-gaeb-field$=":UP"]'),
    );
    const result = await page.evaluate(() => {
      const input = document.querySelector(".gaeb-canvas-input");
      const clipboard = new DataTransfer();
      input.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
      return {
        value: input.value,
        copied: clipboard.getData("text/plain"),
        readOnly: input.readOnly,
      };
    });
    assert.deepEqual(result, { value: "", copied: "", readOnly: true });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("subcontract prices use procurement rights even when the native file has no kind marker", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showPartialDocument({
        readAll: true,
        kind: "subcontract",
        writable: ["scope", "procurement"],
      }),
    );
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.gaebPartialFixture.ready());
    const layout = await page.evaluate(() =>
      window.gaebPartialFixture.layout(),
    );
    const price = layout.fields.find((field) => field.key.endsWith(":UP"));
    const quantity = layout.fields.find((field) => field.key.endsWith(":Qty"));
    assert.ok(price && quantity);
    assert.equal(price.editable, true);
    assert.equal(quantity.editable, false);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("invoice settlement and number assignment use the real browser XML worker", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.invoiceWorker(),
    );
    assert.equal(result.schema.valid, true);
    assert.equal(result.onlyNumberChanged, true);
    assert.equal(result.details.netAmount, "0.00");
    assert.equal(result.details.dueDate, "2026-11-26");
    assert.equal(result.invalid, "invoice-total");
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("an explicit editor save confirms an unchanged native XML snapshot", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPublicationEditor());
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.gaebPublicationFixture.ready());
    assert.equal(
      await page.evaluate(() => window.gaebPublicationFixture.save()),
      true,
    );
    const calls = await page.evaluate(() =>
      window.gaebPublicationFixture.calls(),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, calls[0].base);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("a final native file cannot be overlaid by historical live text or later local edits", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.frozenPublication(),
    );
    assert.deepEqual(result, {
      hadOverlay: true,
      exactNative: true,
      canUndo: false,
      requests: 0,
    });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("a workflow confirmation waits for an in-flight save and confirms the latest live position afterwards", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPublicationEditor());
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.gaebPublicationFixture.ready());
    await page.evaluate(() => window.gaebPublicationFixture.pause());
    const firstSave = page.evaluate(() => window.gaebPublicationFixture.save());
    await page.waitForFunction(
      () => window.gaebPublicationFixture.calls().length === 1,
    );
    const confirmation = page.evaluate(() =>
      window.gaebPublicationFixture.save(),
    );
    await page.evaluate(() => window.gaebPublicationFixture.release());
    assert.deepEqual(await Promise.all([firstSave, confirmation]), [
      true,
      true,
    ]);
    assert.equal(
      (await page.evaluate(() => window.gaebPublicationFixture.calls())).length,
      2,
    );
  } finally {
    await context.close();
  }
});

test("encrypted GAEB initialization batches fields and survives a lost reply without duplicate candidates", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.gaebInitializationBatch(),
    );
    assert.equal(result.openingCandidates, 0);
    assert.equal(result.candidates, 49);
    assert.equal(result.uniqueKeys, 49);
    assert.ok(
      result.initialReads < 25,
      `Unexpected read amplification: ${result.initialReads}`,
    );
    assert.ok(result.maximum > 1 && result.maximum <= 4);
    assert.equal(result.active, 0);
    assert.equal(result.replyLost, true);
    assert.equal(result.text, "Gemeinsam bearbeitet");
    assert.equal(result.leaks, false);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("encrypted GAEB fields converge during concurrent typing, preserve a late join and show private selections", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() => window.cryptoFixture.gaebLive());
    assert.equal(result.openingCandidates, 0);
    assert.ok(
      result.initializerCandidates >= 1 && result.initializerCandidates <= 2,
    );
    assert.deepEqual(result.baseline, ["Hallo Welt", "Hallo Welt"]);
    assert.ok(result.merged.includes("schöne"));
    assert.ok(result.merged.includes("👋"));
    assert.ok(result.merged.endsWith("12345678901234567890"));
    assert.equal(result.merged.match(/Hallo/g)?.length, 1);
    assert.ok(
      result.typingWrites <= 3,
      "Rapid typing must form CRDT batches rather than one request per character",
    );
    assert.equal(result.late, result.merged);
    assert.ok(
      result.participants.some(
        (person) =>
          person.name === "Erste Bearbeiterin 726491" &&
          person.field === "item-a:text:0",
      ),
    );
    assert.deepEqual(result.leaks, []);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

const liveFaultCases = [
  [
    "staleBootstrapPolicy",
    "an obsolete in-flight live bootstrap policy never opens private text after revocation",
    (result) => {
      assert.ok(result.failure);
      assert.equal(result.text, null);
      assert.equal(result.rejected, 0);
    },
  ],
  [
    "revokedPresence",
    "late private presence cannot reappear after live rights are revoked",
    (result) => {
      assert.ok(result.failure);
      assert.deepEqual(result.people, []);
      assert.deepEqual(result.publishedNames, []);
    },
  ],
  [
    "replacedAccount",
    "an account switch cancels a delayed live read and all retries",
    (result) => {
      assert.ok(result.failure);
      assert.equal(result.text, null);
      assert.equal(result.reads, result.stoppedAt);
      assert.equal(result.rejected, 0);
    },
  ],
  [
    "unavailableHistoricalPolicy",
    "a failed historical live policy read retains the unprocessed initializer",
    (result) => {
      assert.equal(result.failure, "Protected message proof unavailable");
      assert.equal(result.before, null);
      assert.equal(result.text, "Hallo Welt");
      assert.equal(result.rejected, 0);
      assert.ok(result.proofReads >= 2);
    },
  ],
  [
    "lostUpdateReply",
    "lost encrypted update acknowledgements retry exact packets and never duplicate the text",
    (result) => {
      assert.ok(result.failure);
      assert.equal(result.lost, 3);
      assert.equal(result.text, "Hallo gespeicherte Welt");
      assert.equal(result.late, result.text);
      assert.equal(result.sameRetry, true);
      assert.equal(result.rejected, 0);
    },
  ],
  [
    "revokedDuringRead",
    "a live policy revocation prevents an in-flight page from publishing its private text",
    (result) => {
      assert.ok(result.failure);
      assert.equal(result.text, "Hallo Welt");
      assert.equal(result.rejected, 0);
      assert.equal(result.status, "offline");
    },
  ],
  [
    "recoverBootstrap",
    "failed encrypted live bootstrap retries and preserves offline input",
    (result) => {
      assert.equal(result.failure, "Temporary policy outage");
      assert.equal(result.text, "Hallo offline Welt");
      assert.equal(result.late, result.text);
      assert.equal(result.rejected, 0);
    },
  ],
  [
    "poisonedInitializer",
    "a signed invalid initializer cannot reserve a live field",
    (result) => {
      assert.equal(result.initial, "Hallo Welt");
      assert.ok(result.rejected > 0);
      assert.equal(result.covered, String(result.count));
      assert.equal(result.late, "Hallo Baustelle");
    },
  ],
  [
    "corruptPackets",
    "corrupt encrypted text and presence cannot block a later valid update",
    (result) => {
      assert.equal(result.text, "Hallo gültige Welt");
      assert.deepEqual(result.people, []);
      assert.ok(result.rejected > 0);
      assert.equal(result.covered, String(result.count));
      assert.equal(result.status, "online");
    },
  ],
  [
    "unavailableProof",
    "an unavailable live proof cannot discard valid text or advance the cursor",
    (result) => {
      assert.equal(result.failure, "Protected message proof unavailable");
      assert.equal(result.before, null);
      assert.equal(result.text, "Hallo geprüfte Welt");
      assert.equal(result.rejected, 0);
    },
  ],
  [
    "invalidPageBoundary",
    "invalid live page boundaries leave staged text unchanged until a valid retry",
    (result) => {
      assert.ok(result.failure);
      assert.equal(result.before, null);
      assert.equal(result.text, "Hallo geprüfte Welt");
      assert.equal(result.rejected, 0);
    },
  ],
  [
    "closedBootstrap",
    "closing a failed encrypted bootstrap cancels its retries",
    (result) => {
      assert.equal(result.failure, "Offline");
      assert.ok(result.stoppedAt > 0);
      assert.equal(result.reads, result.stoppedAt);
    },
  ],
];
for (const [scenario, name, check] of liveFaultCases) {
  test(name, async () => {
    const { context, page, external } = await open();
    try {
      const result = await page.evaluate(
        (value) => window.cryptoFixture.gaebLiveFault(value),
        scenario,
      );
      check(result);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("absence decisions expose an explicit approve checkbox and preserve unrelated grant rights", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showAbsenceActions());
    await page.getByText("Bestätigen", { exact: true }).click();
    const read = page.getByRole("checkbox", { name: "Lesen", exact: true });
    await read.focus();
    await read.press("Space");
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Bestätigen", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(await read.isChecked(), true);
    const value = JSON.parse(
      await page.getByRole("status", { name: "Einzelrechte" }).textContent(),
    );
    assert.deepEqual(value.actions.slice().sort(), [
      "approve",
      "grant",
      "read",
    ]);
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Bearbeiten", exact: true })
        .count(),
      0,
    );
  } finally {
    await context.close();
  }
});

test("absence forms retain their operation ID on retry and submit local calendar days across DST", async () => {
  const { context, page } = await open({ timezoneId: "Europe/Berlin" });
  try {
    await page.evaluate(() => window.cryptoFixture.showAbsences(true));
    await page
      .getByRole("button", { name: "Abwesenheit beantragen", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Von(?:\s*\*)?$/).fill("2026-03-29");
    await dialog.getByLabel(/^Bis(?:\s*\*)?$/).fill("2026-03-30");
    await dialog
      .getByRole("button", { name: "Beantragen", exact: true })
      .click();
    await dialog.getByText("Test: Antwort unterbrochen").waitFor();
    await dialog
      .getByRole("button", { name: "Beantragen", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const calls = await page.evaluate(() =>
      window.cryptoFixture.absenceState(),
    );
    assert.equal(calls.length, 2);
    assert.match(calls[0].input.operationId, /^[1-9a-v][0-9a-v]{0,12}$/);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].input.from, "2026-03-29");
    assert.equal(calls[0].input.to, "2026-03-30");
  } finally {
    await context.close();
  }
});

test("absence actions carry the displayed version and read-only grants cannot open a create form", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showAbsences(false, false));
    assert.equal(
      await page
        .getByRole("button", { name: "Abwesenheit beantragen", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Freigeben", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Freigeben", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const calls = await page.evaluate(() =>
      window.cryptoFixture.absenceState(),
    );
    assert.deepEqual(calls, [
      {
        path: "users.vacations.approve",
        input: { id: "3", expectedRevision: "source-signature.pending" },
      },
    ]);
  } finally {
    await context.close();
  }
});

test("the actual planning page removes remote deletions through its existing subscription without polling", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPlanning());
    await page.getByText("Gerüst prüfen", { exact: true }).waitFor();
    await page.evaluate(() => window.cryptoFixture.clearPlanning());
    await page
      .getByText("Gerüst prüfen", { exact: true })
      .waitFor({ state: "hidden" });
    await page.evaluate(() => window.cryptoFixture.restorePlanning());
    await page.getByText("Gerüst prüfen", { exact: true }).waitFor();
    await page.evaluate(() => window.cryptoFixture.failPlanning());
    await page
      .getByText("Gerüst prüfen", { exact: true })
      .waitFor({ state: "hidden" });
    const state = await page.evaluate(() =>
      window.cryptoFixture.planningState(),
    );
    assert.equal(state.streams - state.closed, 1);
    assert.equal(state.queries.includes("projects.deployments.list"), false);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("delete-only planning opens the current booking with its exact version and cannot save ordinary edits", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showPlanning(["read", "delete"]),
    );
    await page.getByText("Gerüst prüfen", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Einsatz löschen", exact: true })
      .waitFor();
    assert.equal(
      await dialog
        .getByRole("button", { name: "Speichern", exact: true })
        .isDisabled(),
      true,
    );
    await dialog.getByLabel(/^Von \(Datum\)/).press("Control+Enter");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.deepEqual(
      (await page.evaluate(() => window.cryptoFixture.planningState()))
        .mutations,
      [],
    );
    await dialog
      .getByRole("button", { name: "Einsatz löschen", exact: true })
      .click();
    const state = await page.evaluate(() =>
      window.cryptoFixture.planningState(),
    );
    assert.deepEqual(state.mutations, [
      {
        path: "projects.deployments.delete",
        input: { id: "3", expectedRevision: "schedule:2:deployment:3:3@7" },
      },
    ]);
  } finally {
    await context.close();
  }
});

test("site closures retain the selected calendar days across the Berlin daylight-saving boundary", async () => {
  const { context, page } = await open({ timezoneId: "Europe/Berlin" });
  try {
    await page.evaluate(() => window.cryptoFixture.showPlanning());
    await page
      .getByRole("button", { name: "Baustelle sperren", exact: true })
      .click();
    const dialog = page.getByRole("dialog"),
      project = dialog.getByRole("combobox", { name: /^Projekt/ });
    await project.fill("Fenster");
    await page
      .getByRole("option", { name: "Fenstersanierung", exact: true })
      .click();
    await dialog.getByLabel(/^Von(?:\s*\*)?$/).fill("2026-03-29");
    await dialog.getByLabel(/^Bis(?:\s*\*)?$/).fill("2026-03-30");
    await dialog.getByLabel(/^Grund/).fill("Gerüstabbau");
    await dialog.getByRole("button", { name: "Sperren", exact: true }).click();
    await page.waitForFunction(
      () => window.cryptoFixture.planningState().mutations.length === 1,
    );
    const { mutations } = await page.evaluate(() =>
      window.cryptoFixture.planningState(),
    );
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].path, "projects.unavailability.create");
    assert.equal(mutations[0].input.from, "2026-03-29");
    assert.equal(mutations[0].input.to, "2026-03-30");
    assert.match(mutations[0].input.operationId, /^[1-9a-v][0-9a-v]{0,12}$/);
  } finally {
    await context.close();
  }
});

for (const mode of ["material", "hours", "both", "hiddenrefs"])
  test(`regie forms preserve stable references and unedited permissions in ${mode} mode`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(
        (mode) => window.cryptoFixture.showRegieEdit(mode),
        mode,
      );
      await page
        .getByRole("button", { name: "Regiebericht bearbeiten", exact: true })
        .click();
      const summary = page.getByRole("textbox", {
        name: "Zusammenfassung",
        exact: true,
      });
      if (mode === "material")
        await page
          .getByText("Arbeitszeiten nicht freigegeben", { exact: true })
          .waitFor();
      if (mode === "hiddenrefs") {
        await page
          .getByText("Mitarbeiter: Nicht freigegeben", { exact: true })
          .waitFor();
        await page
          .getByText("Produkt: Nicht freigegeben", { exact: true })
          .waitFor();
      }
      if (mode !== "hours") {
        await page.locator('[name="specialRecord:5:amount"]').waitFor();
        await summary.fill("Zusätzliche Abdichtung");
      }
      if (mode !== "material") {
        const hours = page.locator('[name="workHour:8:hours"]');
        await hours.waitFor();
        await hours.fill("8.125");
      }
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await page.waitForFunction(
        () => window.cryptoFixture.regieEdits().length === 1,
      );
      const [{ input }] = await page.evaluate(() =>
        window.cryptoFixture.regieEdits(),
      );
      assert.equal(input.expectedRevision, "7");
      if (mode === "material") {
        assert.equal(Object.hasOwn(input.data, "workHours"), false);
        assert.equal(Object.hasOwn(input.data, "day"), false);
      } else {
        assert.equal(input.data.workHours[0].id, "8");
        assert.equal(input.data.workHours[0].userId, "7");
        assert.equal(input.data.workHours[0].hours, 8.125);
        assert.equal(input.expectedHoursRevision, "9");
      }
      if (mode === "hours") {
        assert.equal(Object.hasOwn(input.data, "products"), false);
        assert.equal(Object.hasOwn(input.data, "specialRecords"), false);
        assert.equal(Object.hasOwn(input.data, "summary"), false);
      } else {
        assert.equal(input.data.products[0].id, "4");
        assert.equal(input.data.products[0].comment, "Sonderfarbe");
        assert.equal(input.data.products[0].quantity, 2.375);
        assert.equal(input.data.specialRecords[0].id, "5");
        assert.equal(
          input.data.specialRecords[0].comment,
          "Getrennt entsorgen",
        );
      }
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });

test("the actual regie creation form retains its operation ID when retrying a failed save", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showRegieEdit("material", true),
    );
    await page
      .getByRole("button", { name: "Regiebericht bearbeiten", exact: true })
      .click();
    await page.getByRole("combobox", { name: /^Projekt/ }).fill("Fenster");
    await page
      .getByRole("option", { name: "Fenstersanierung", exact: true })
      .click();
    await waitForClosedListboxes(page);
    await page
      .getByRole("button", { name: "Sonderposten", exact: true })
      .click();
    await page.getByRole("textbox", { name: /^Bezeichnung/ }).fill("Transport");
    await page.getByRole("textbox", { name: /^Einheit/ }).fill("Stk");
    await page
      .locator('input[name^="specialRecord:"][name$=":amount"]')
      .fill("1.125");
    await page.getByRole("button", { name: "Erstellen", exact: true }).click();
    await page
      .getByText("Speicherantwort unterbrochen", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Erstellen", exact: true }).click();
    await page.waitForFunction(
      () => window.cryptoFixture.regieEdits().length === 2,
    );
    const [first, second] = await page.evaluate(() =>
      window.cryptoFixture.regieEdits(),
    );
    assert.match(first.input.operationId, /^[1-9a-v][0-9a-v]{0,12}$/);
    assert.equal(second.input.operationId, first.input.operationId);
    assert.equal(first.input.specialRecords[0].amount, 1.125);
    assert.equal(Object.hasOwn(first.input, "workHours"), false);
  } finally {
    await context.close();
  }
});

for (const costs of [false, true])
  test(`daily-report forms retain line IDs and versions with ${costs ? "editable" : "hidden"} internal costs`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(
        (costs) => window.cryptoFixture.showDailyReportEdit(costs),
        costs,
      );
      await page
        .getByRole("button", { name: "Tagesbericht bearbeiten", exact: true })
        .click();
      const summary = page.getByRole("textbox", {
        name: "Beschreibung der Arbeiten",
        exact: true,
      });
      await page.getByText("Maria", { exact: true }).waitFor();
      await summary.fill("Fensterlaibungen fertiggestellt");
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await page.waitForFunction(
        () => window.cryptoFixture.dailyReportEdits().length === 1,
      );
      const [{ path, input }] = await page.evaluate(() =>
        window.cryptoFixture.dailyReportEdits(),
      );
      assert.equal(path, "projects.dailyReports.update");
      assert.equal(input.expectedRevision, "7");
      assert.equal(input.data.summary, "Fensterlaibungen fertiggestellt");
      assert.equal(input.data.workHours[0].id, "4");
      assert.equal(input.data.workHours[0].hours, 7.375);
      assert.equal(
        Object.hasOwn(input.data.workHours[0], "costPerHour"),
        costs,
      );
      if (costs) {
        assert.equal(input.data.workHours[0].costPerHour, 73.87654321);
        assert.equal(input.expectedCostRevision, "8");
      }
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });

test("daily-report editing preserves a worker reference whose name is not shared", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showDailyReportEdit(false, false),
    );
    await page
      .getByRole("button", { name: "Tagesbericht bearbeiten", exact: true })
      .click();
    await page
      .getByText("Mitarbeiter: Nicht freigegeben", { exact: true })
      .waitFor();
    await page
      .getByRole("textbox", { name: "Beschreibung der Arbeiten", exact: true })
      .fill("Zusätzliche Abdichtung");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(
      () => window.cryptoFixture.dailyReportEdits().length === 1,
    );
    const [{ input }] = await page.evaluate(() =>
      window.cryptoFixture.dailyReportEdits(),
    );
    assert.equal(input.data.workHours[0].id, "4");
    assert.equal(input.data.workHours[0].userId, "6");
    assert.equal(Object.hasOwn(input.data.workHours[0], "costPerHour"), false);
  } finally {
    await context.close();
  }
});

test("active workspaces display encrypted profiles and update them without blocking normal work", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showPrivateSession(true, true),
    );
    await page
      .getByRole("button", { name: "Weiterarbeiten", exact: true })
      .waitFor();
    await page.waitForFunction(
      () => window.cryptoFixture.sessionReads().private.length === 2,
    );
    const initial = JSON.parse(
      await page.getByLabel("Sitzungsprofil").innerText(),
    );
    assert.equal(initial.user.firstName, "owner");
    assert.equal(initial.user.contractType, null);
    assert.equal(initial.companyName, null);
    await page.evaluate(() => window.cryptoFixture.sessionRelease());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('[aria-label="Sitzungsprofil"]').textContent,
        ).user.firstName === "Anna",
    );
    const loaded = JSON.parse(
      await page.getByLabel("Sitzungsprofil").innerText(),
    );
    assert.equal(loaded.companyName, "Privater Musterbetrieb");
    assert.equal(loaded.user.email, "anna@example.invalid");
    assert.equal(Object.hasOwn(loaded.user, "costPerHour"), false);
    await page.evaluate(() =>
      window.cryptoFixture.sessionRename("Anna überarbeitet"),
    );
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('[aria-label="Sitzungsprofil"]').textContent,
        ).user.firstName === "Anna überarbeitet",
    );
    const reads = await page.evaluate(() =>
      window.cryptoFixture.sessionReads(),
    );
    assert.equal(
      reads.technical.some(
        (path) => path === "users.get" || path === "settings.organization.get",
      ),
      false,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("session profile reads wait until signed tenant initialization is complete", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPrivateSession(false));
    await page
      .getByRole("heading", { name: "Organisation einrichten", exact: true })
      .waitFor();
    await page.waitForFunction(() =>
      window.cryptoFixture
        .sessionReads()
        .technical.includes("zerotrust.status"),
    );
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.sessionReads())).private
        .length,
      0,
    );
    await page.evaluate(() =>
      window.cryptoFixture.sessionCompleteInitialization(),
    );
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Sitzungsprofil"]')
        ?.textContent.includes('"firstName":"Anna"'),
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("revoked and failed private profile streams fall back to the technical account", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPrivateSession());
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Sitzungsprofil"]')
        ?.textContent.includes('"firstName":"Anna"'),
    );
    await page.evaluate(() => window.cryptoFixture.sessionFailProfiles());
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Sitzungsprofil"]')
        ?.textContent.includes('"firstName":"owner"'),
    );
    let value = JSON.parse(await page.getByLabel("Sitzungsprofil").innerText());
    assert.equal(value.user.email, null);
    assert.equal(value.user.contractType, null);
    assert.equal(value.companyName, null);
    await page.evaluate(() =>
      window.cryptoFixture.sessionRename("Restored private name"),
    );
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Sitzungsprofil"]')
        ?.textContent.includes("Restored private name"),
    );
    await page.evaluate(() => window.cryptoFixture.sessionRevokeProfiles());
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Sitzungsprofil"]')
        ?.textContent.includes('"firstName":"owner"'),
    );
    await page.evaluate(() =>
      window.cryptoFixture.sessionRename("Must remain invisible"),
    );
    value = JSON.parse(await page.getByLabel("Sitzungsprofil").innerText());
    assert.equal(value.user.firstName, "owner");
    assert.equal(value.companyName, null);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("late session profiles cannot cross a real account switch", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showPrivateSession(true, true),
    );
    await page.waitForFunction(
      () => window.cryptoFixture.sessionReads().private.length === 2,
    );
    await page.evaluate(() => window.cryptoFixture.sessionSwitchAccount());
    await page.waitForFunction(() =>
      window.cryptoFixture
        .sessionReads()
        .private.some((read) => read.input?.id === "2"),
    );
    await page.evaluate(() => window.cryptoFixture.sessionRelease());
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Sitzungsprofil"]')
        ?.textContent.includes('"firstName":"Beate"'),
    );
    const value = JSON.parse(
      await page.getByLabel("Sitzungsprofil").innerText(),
    );
    assert.equal(value.user.username, "second");
    assert.equal(value.companyName, null);
    assert.equal(await page.getByText("Anna", { exact: true }).count(), 0);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("the actual user creation form retains its operation ID after a failed submission", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPersonCreate());
    await page
      .getByRole("button", { name: "Person anlegen", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Benutzer erstellen" });
    await dialog.waitFor();
    await dialog.getByLabel(/^Anmeldename\b/).fill("anna.muster");
    await dialog.getByLabel(/^Vorname\b/).fill("Anna");
    await dialog
      .getByRole("button", { name: "Erstellen", exact: true })
      .click();
    await dialog
      .getByText("Anlageantwort unterbrochen", { exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "Erstellen", exact: true })
      .click();
    await page.waitForFunction(
      () => window.cryptoFixture.personCreations().length === 2,
    );
    const [first, second] = await page.evaluate(() =>
      window.cryptoFixture.personCreations(),
    );
    assert.match(first.operationId, /^[1-9a-v][0-9a-v]{0,12}$/);
    assert.equal(first.operationId, second.operationId);
    assert.equal(second.firstName, "Anna");
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

for (const scenario of [
  { mode: "delete", administrator: true, available: true },
  { mode: "delete-limited", administrator: true, available: false },
  { mode: "delete-without-cost-read", administrator: true, available: false },
  { mode: "delete", administrator: false, available: false },
  { mode: "delete-self", administrator: true, available: false },
]) {
  test(`the actual personnel detail ${scenario.available ? "offers" : "hides"} terminal deletion (${scenario.mode}, admin=${scenario.administrator})`, async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(
        ({ mode, administrator }) =>
          window.cryptoFixture.showPersonEdit(mode, administrator),
        scenario,
      );
      await page
        .getByRole("heading", { name: "Anna Muster", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Aktionen", exact: true }).click();
      const action = page.getByRole("menuitem", {
        name: "Löschen",
        exact: true,
      });
      if (!scenario.available) {
        assert.equal(await action.count(), 0);
        assert.deepEqual(
          await page.evaluate(() => window.cryptoFixture.personEdits()),
          [],
        );
        return;
      }
      await action.click();
      const dialog = page.getByRole("dialog", {
        name: "Benutzer löschen",
        exact: true,
      });
      await dialog.waitFor();
      const remove = dialog.getByRole("button", {
        name: "Löschen",
        exact: true,
      });
      if (await remove.isEnabled()) await remove.click();
      assert.deepEqual(
        await page.evaluate(() => window.cryptoFixture.personEdits()),
        [],
      );
      await dialog.getByRole("checkbox").focus();
      await dialog.getByRole("checkbox").press("Space");
      assert.equal(await dialog.getByRole("checkbox").isChecked(), true);
      await remove.click();
      await page.getByText("Benutzerübersicht", { exact: true }).waitFor();
      assert.deepEqual(
        await page.evaluate(() => window.cryptoFixture.personEdits()),
        [{ id: "4" }],
      );
    } finally {
      await context.close();
    }
  });
}

for (const mode of ["basic", "cost", "employment"])
  test(`the actual personnel form preserves independent ${mode} rights`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(
        (mode) => window.cryptoFixture.showPersonEdit(mode),
        mode,
      );
      await page
        .getByRole("button", { name: "Person bearbeiten", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Benutzer bearbeiten" });
      await dialog.waitFor();
      await page.waitForFunction(
        (input) => input?.value === "Anna",
        await dialog.getByLabel(/^Vorname\b/).elementHandle(),
      );
      assert.equal(
        await dialog.getByLabel(/^Anmeldename\b/).isDisabled(),
        mode === "cost",
      );
      const cost = dialog.getByLabel("Kosten pro Stunde (EUR)", {
          exact: true,
        }),
        leave = dialog.getByLabel("Urlaubstage pro Jahr", { exact: true });
      if (mode === "basic") {
        assert.equal(await cost.count(), 0);
        assert.equal(await leave.count(), 0);
      } else {
        assert.equal(await cost.isDisabled(), mode !== "cost");
        assert.equal(await leave.isDisabled(), mode !== "employment");
      }
      if (mode === "cost") {
        assert.equal(await dialog.getByLabel(/^Vorname\b/).isDisabled(), true);
        await cost.fill("81.375");
      } else await dialog.getByLabel(/^Vorname\b/).fill("Anna überarbeitet");
      if (mode === "basic")
        await dialog.getByLabel(/^Anmeldename\b/).fill("anna-updated");
      if (mode === "employment") await leave.fill("31");
      await dialog
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await page.waitForFunction(
        () => window.cryptoFixture.personEdits().length === 1,
      );
      const [saved] = await page.evaluate(() =>
        window.cryptoFixture.personEdits(),
      );
      assert.equal(saved.id, "4");
      if (mode === "basic") assert.equal(saved.data.username, "anna-updated");
      assert.equal(
        saved.data.firstName,
        mode === "cost" ? undefined : "Anna überarbeitet",
      );
      assert.equal(
        saved.data.costPerHour,
        mode === "cost" ? 81.375 : undefined,
      );
      assert.equal(
        saved.data.vacationDaysPerYear,
        mode === "employment" ? 31 : undefined,
      );
      assert.equal(
        Object.hasOwn(saved.data, "supervisorUserId"),
        mode === "employment",
      );
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });

test("a personnel editor can change contact details and leave allowance while supervision controls remain administrative", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showPersonEdit("employment", false),
    );
    await page
      .getByRole("button", { name: "Person bearbeiten", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Benutzer bearbeiten" });
    await page.waitForFunction(
      (input) => input?.value === "Anna",
      await dialog.getByLabel(/^Vorname\b/).elementHandle(),
    );
    assert.equal(await dialog.getByLabel(/^Anmeldename\b/).isDisabled(), true);
    assert.equal(
      await dialog
        .getByRole("combobox", { name: /^Vorgesetzter/ })
        .isDisabled(),
      true,
    );
    assert.equal(
      await dialog.getByRole("button", { name: /Vertrag/ }).isDisabled(),
      true,
    );
    await dialog.getByLabel(/^Telefon\b/).fill("012345");
    await dialog.getByLabel("Urlaubstage pro Jahr", { exact: true }).fill("32");
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await page.waitForFunction(
      () => window.cryptoFixture.personEdits().length === 1,
    );
    const [saved] = await page.evaluate(() =>
      window.cryptoFixture.personEdits(),
    );
    assert.equal(saved.data.phone, "012345");
    assert.equal(saved.data.vacationDaysPerYear, 32);
    assert.equal(Object.hasOwn(saved.data, "supervisorUserId"), false);
    assert.equal(Object.hasOwn(saved.data, "contractType"), false);
  } finally {
    await context.close();
  }
});

for (const access of ["none", "read", "write"])
  test(`the actual tool edit form respects ${access} cost rights without changing hidden prices`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(
        (access) => window.cryptoFixture.showToolEdit(access),
        access,
      );
      await page
        .getByRole("button", { name: "Werkzeug bearbeiten", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Werkzeug bearbeiten" });
      await dialog.waitFor();
      await page.waitForFunction(
        (input) => input?.value === "Profilfräse",
        await dialog.getByLabel("Modell", { exact: true }).elementHandle(),
      );
      const purchase = dialog.getByLabel("Kaufpreis (EUR)", { exact: true });
      if (access === "none") assert.equal(await purchase.count(), 0);
      else assert.equal(await purchase.isDisabled(), access === "read");
      await dialog
        .getByLabel("Modell", { exact: true })
        .fill("Profilfräse überarbeitet");
      await dialog
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await page.waitForFunction(
        () => window.cryptoFixture.toolEdits().length === 1,
      );
      const [mutation] = await page.evaluate(() =>
        window.cryptoFixture.toolEdits(),
      );
      assert.equal(mutation.id, "4");
      assert.equal(mutation.data.label, "Profilfräse überarbeitet");
      if (access === "write") {
        assert.equal(mutation.data.purchasePrice, 1537.87654321);
        assert.equal(mutation.data.usageCostPerDay, 17.375);
      } else {
        assert.equal(Object.hasOwn(mutation.data, "purchasePrice"), false);
        assert.equal(Object.hasOwn(mutation.data, "usageCostPerDay"), false);
      }
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });

test("the actual price import dialog retains its operation ID on retry and changes it for edited input", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPriceImport());
    await page.getByRole("button", { name: "Preisliste prüfen" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Preise aus Preisliste übernehmen",
    });
    await dialog.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".price-import-fields input")?.value ===
        "Baustoffhandel Browser",
    );
    // The exact supplier is selected after the query-aware provider resolves.
    await dialog
      .getByText("Händler aus der Trefferliste auswählen.")
      .waitFor({ state: "hidden" });
    await dialog
      .getByRole("button", { name: "Preise speichern", exact: true })
      .click();
    await dialog
      .getByText("Verbindung unterbrochen", { exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "Preise speichern", exact: true })
      .click();
    await page.waitForFunction(
      () => window.cryptoFixture.priceImportAttempts().length === 2,
    );
    let attempts = await page.evaluate(() =>
      window.cryptoFixture.priceImportAttempts(),
    );
    assert.ok(attempts[0].requestId);
    assert.equal(attempts[0].requestId, attempts[1].requestId);
    await dialog.getByLabel("Preisstand", { exact: true }).fill("2026-11-12");
    await dialog
      .getByRole("button", { name: "Preise speichern", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    attempts = await page.evaluate(() =>
      window.cryptoFixture.priceImportAttempts(),
    );
    assert.equal(attempts.length, 3);
    assert.notEqual(attempts[1].requestId, attempts[2].requestId);
    assert.notEqual(attempts[1].effectiveAt, attempts[2].effectiveAt);
  } finally {
    await context.close();
  }
});

test("actual session menus use signed grants even when legacy roles claim administrator access", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showMenuAccess());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            ?.textContent ?? "{}",
        ).supplierRead === true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Produkt bearbeiten", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Lieferant bearbeiten", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Preis bearbeiten", exact: true })
        .isDisabled(),
      true,
    );
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page
      .getByRole("button", { name: "Preis bearbeiten", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Preis bearbeiten",
        ).disabled,
    );
    const rights = JSON.parse(
      await page.locator('output[aria-label="Menüfreigaben"]').textContent(),
    );
    assert.equal(rights.admin, true);
    assert.equal(rights.createOffer, true);
    assert.equal(rights.createProject, false);
    assert.equal(rights.project4, true);
    assert.equal(rights.project5, false);
    assert.equal(rights.offers, true);
    assert.equal(rights.productRead, false);
    assert.ok(!rights.roles.includes("manage:products"));
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("assistant navigation follows signed permissions instead of raw LLM or administrator roles", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showMenuAccess());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            ?.textContent ?? "{}",
        ).supplierRead === true,
    );
    const read = async () =>
      JSON.parse(
        await page.locator('output[aria-label="Menüfreigaben"]').textContent(),
      );
    const initial = await read();
    assert.equal(initial.admin, true);
    assert.equal(initial.assistant, false);
    assert.equal(initial.assistantRole, false);
    assert.equal(initial.roles.includes(":llm"), false);
    await page.evaluate(() => window.cryptoFixture.menuChange("assistant"));
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            ?.textContent ?? "{}",
        ).assistant === true,
    );
    const enabled = await read();
    assert.equal(enabled.assistantRole, true);
    assert.equal(enabled.roles.includes(":llm"), true);
    assert.equal(enabled.productRead, false);
    assert.equal(enabled.priceEdit, false);
    await page.evaluate(() => window.cryptoFixture.menuChange("none"));
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            ?.textContent ?? "{}",
        ).assistant === false,
    );
    assert.equal((await read()).roles.includes(":llm"), false);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("document import is visible with signed assistant and catalogue read access without technical roles", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showMenuAccess({
        technicalRoles: [],
        showActions: true,
      }),
    );
    const waitForRights = async (assistant, productRead) => {
      await page.waitForFunction(
        ({ assistant, productRead }) => {
          const rights = JSON.parse(
            document.querySelector('output[aria-label="Menüfreigaben"]')
              ?.textContent ?? "{}",
          );
          return (
            rights.assistant === assistant && rights.productRead === productRead
          );
        },
        { assistant, productRead },
      );
    };
    const importButton = page.getByRole("button", {
      name: "Einlesen",
      exact: true,
    });
    await waitForRights(false, false);
    assert.equal(await importButton.count(), 0);
    await page.evaluate(() => window.cryptoFixture.menuChange("assistant"));
    await waitForRights(true, false);
    assert.equal(await importButton.count(), 0);
    await page.evaluate(() =>
      window.cryptoFixture.menuChange("assistant-catalogue"),
    );
    await importButton.waitFor();
    const rights = JSON.parse(
      await page.locator('output[aria-label="Menüfreigaben"]').textContent(),
    );
    assert.equal(rights.admin, false);
    assert.equal(rights.productRead, true);
    assert.equal(rights.productEdit, false);
    assert.equal(rights.priceEdit, false);
    assert.equal(rights.roles.includes("manage:deliveryNotes"), false);
    await importButton.click();
    await page.waitForFunction(
      () =>
        document.querySelector('output[aria-label="Aktuelle Seite"]')
          ?.textContent === "/import",
    );
    assert.equal(
      await page.locator('output[aria-label="Aktuelle Seite"]').textContent(),
      "/import",
    );
    await page.evaluate(() => window.cryptoFixture.menuChange("assistant"));
    await waitForRights(true, false);
    assert.equal(await importButton.count(), 0);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("revoked and replaced accounts cannot regain menu actions from a delayed policy response", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showMenuAccess());
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            ?.textContent ?? "{}",
        ).priceEdit === true,
    );
    await page.evaluate(() => window.cryptoFixture.menuCaptureAction());
    await page.evaluate(() => window.cryptoFixture.menuHold());
    assert.equal(
      await page.evaluate(() => window.cryptoFixture.oldMenuCanEdit()),
      false,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Preis bearbeiten", exact: true })
        .isDisabled(),
      true,
    );
    await page.evaluate(() => window.cryptoFixture.menuChange("none"));
    await page.evaluate(() => window.cryptoFixture.menuRelease());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            .textContent,
        ).priceEdit === false,
    );
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            .textContent,
        ).priceEdit === true,
    );
    await page.evaluate(() => window.cryptoFixture.menuCaptureAction());
    await page.evaluate(() => window.cryptoFixture.menuSwitchAccount());
    assert.equal(
      await page.evaluate(() => window.cryptoFixture.oldMenuCanEdit()),
      false,
    );
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            ?.textContent ?? "{}",
        ).id === "2",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Preis bearbeiten", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Angebot erstellen", exact: true })
        .isDisabled(),
      true,
    );
  } finally {
    await context.close();
  }
});

test("failed menu signature checks keep content actions disabled and the actual retry control recovers", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showMenuAccess());
    await page.evaluate(() => window.cryptoFixture.menuChange());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Menüfreigaben"]')
            ?.textContent ?? "{}",
        ).priceEdit === true,
    );
    await page.evaluate(() => window.cryptoFixture.menuTamper());
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Die Datenfreigaben konnten nicht geladen werden." });
    await alert.waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Preis bearbeiten", exact: true })
        .isDisabled(),
      true,
    );
    await page.evaluate(() => window.cryptoFixture.menuRepair());
    await alert
      .getByRole("button", { name: "Erneut versuchen", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Preis bearbeiten",
        ).disabled,
    );
    await alert.waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
});

test("the actual view-preference hook flushes pending settings on dialog close and restores them on reopen", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showViewPreferences());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Ansichtseinstellungen"]')
            .textContent,
        ).view?.outlineWidth === 320,
    );
    await page.evaluate(() => {
      window.cryptoFixture.editViewPreference(511);
      window.cryptoFixture.closeViewPreferences();
    });
    await page.waitForFunction(
      () => window.cryptoFixture.viewPreferenceState().calls.length === 1,
    );
    await page.evaluate(() => window.cryptoFixture.openViewPreferences());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Ansichtseinstellungen"]')
            .textContent,
        ).view?.outlineWidth === 511,
    );
  } finally {
    await context.close();
  }
});

test("queued view settings cannot be written under a newly opened account", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showViewPreferences());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Ansichtseinstellungen"]')
            .textContent,
        ).view?.outlineWidth === 320,
    );
    await page.evaluate(() => {
      window.cryptoFixture.pauseViewPreferences();
      window.cryptoFixture.editViewPreference(511);
      void window.cryptoFixture.flushViewPreference();
    });
    await page.waitForFunction(
      () => window.cryptoFixture.viewPreferenceState().calls.length === 1,
    );
    await page.evaluate(() => {
      window.cryptoFixture.editViewPreference(588);
      void window.cryptoFixture.flushViewPreference();
    });
    await page.evaluate(() =>
      window.cryptoFixture.switchViewPreferenceAccount(),
    );
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Ansichtseinstellungen"]')
            .textContent,
        ).view?.outlineWidth === 407,
    );
    await page.evaluate(() => window.cryptoFixture.releaseViewPreferences());
    await page.evaluate(() => window.cryptoFixture.flushViewPreference());
    const state = await page.evaluate(() =>
      window.cryptoFixture.viewPreferenceState(),
    );
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].scope, 0);
    assert.equal(state.stored[1][1].outlineWidth, 407);
  } finally {
    await context.close();
  }
});

test("failed automatic view saves remain pending and retry after the browser comes online", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showViewPreferences());
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Ansichtseinstellungen"]')
            .textContent,
        ).view?.outlineWidth === 320,
    );
    await page.evaluate(async () => {
      window.cryptoFixture.failViewPreferences();
      window.cryptoFixture.editViewPreference(522);
      await window.cryptoFixture.flushViewPreference();
    });
    await page
      .getByLabel("Ansichtseinstellungen")
      .filter({ hasText: /nicht gespeichert/ })
      .waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(
      () =>
        window.cryptoFixture.viewPreferenceState().stored[0][1].outlineWidth ===
        522,
    );
    await page.waitForFunction(
      () =>
        JSON.parse(
          document.querySelector('output[aria-label="Ansichtseinstellungen"]')
            .textContent,
        ).error === "",
    );
  } finally {
    await context.close();
  }
});

test("position descriptions are extracted in the actual local XML worker without external requests", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.positionTexts(
        '<g:GAEB xmlns:g="http://www.gaeb.de/GAEB_DA_XML/DA84/3.3"><g:Item><g:QU>m²</g:QU><g:UP>87531.2468</g:UP><g:Description><g:OutlTxt><g:p>Fensterlaibung</g:p></g:OutlTxt><g:DetailTxt><g:p>Fensterlaibung</g:p><g:p>Vorhandene Oberflächen schützen.</g:p><g:p>Mehrlagig verputzen.</g:p></g:DetailTxt></g:Description></g:Item></g:GAEB>',
      ),
    );
    assert.deepEqual(result, [
      {
        shortText: "Fensterlaibung",
        description: "Vorhandene Oberflächen schützen.\nMehrlagig verputzen.",
        unit: "m²",
      },
    ]);
    assert.equal(
      await page.evaluate(async () => {
        try {
          await window.cryptoFixture.positionTexts(
            '<!DOCTYPE GAEB [<!ENTITY remote SYSTEM "https://outside.example/private">]><GAEB>&remote;</GAEB>',
          );
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("position autocomplete accepts description matches and removes stale suggestions after a failed search", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPositionSearch());
    const input = page.getByRole("combobox", {
      name: "Bisherige Positionen durchsuchen",
    });
    await input.fill("Oberflächen");
    await page
      .getByRole("option")
      .filter({ hasText: "Fensterlaibung" })
      .waitFor();
    await input.fill("Fehler");
    await page.waitForFunction(
      () => window.cryptoFixture.lastPositionQuery === "Fehler",
    );
    await page
      .getByRole("option")
      .filter({ hasText: "Fensterlaibung" })
      .waitFor({ state: "hidden" });
    await input.fill("Oberflächen");
    await page
      .getByRole("option")
      .filter({ hasText: "Fensterlaibung" })
      .click();
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.selectedPosition))
        .description,
      "Oberflächen sorgfältig vorbereiten",
    );
  } finally {
    await context.close();
  }
});

test("a newer position query cancels the actual XML worker and returns only current suggestions", async () => {
  const { context, page, external } = await open();
  try {
    const result = await page.evaluate(() =>
      window.cryptoFixture.replacePositionQuery(),
    );
    assert.equal(result.old, "AbortError");
    assert.equal(result.latest.items[0].shortText, "Fensterlaibung");
    assert.equal(result.latest.indexing, false);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("trade position text survives scope-only browser rendering while quantities, prices and extensions remain hidden", async () => {
  const { context, page, external } = await open();
  try {
    for (const phase of ["93", "94", "96", "97"]) {
      const result = await page.evaluate(
        (phase) =>
          window.cryptoFixture.positionScopeTexts(
            `<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA${phase}/3.3"><GAEBInfo><Version>3.3</Version><VersDate>2021-05</VersDate></GAEBInfo><Order><DP>${phase}</DP><OrderItem ID="item"><Qty>312.50</Qty><QU>m²</QU><Description><DetailTxt><Text><p><span>Fassadenplatte</span></p><p><span>Witterungsbeständige Außenbekleidung.</span></p></Text></DetailTxt></Description><NetPrice>592.51</NetPrice><PriceBasis>777.77</PriceBasis><VendorPrice>GEHEIM-345</VendorPrice></OrderItem></Order></GAEB>`,
          ),
        phase,
      );
      assert.equal(result.complete, false);
      assert.deepEqual(result.positions, [
        {
          shortText: "Fassadenplatte",
          description: "Witterungsbeständige Außenbekleidung.",
          unit: "m²",
        },
      ]);
      for (const hidden of ["312.50", "592.51", "777.77", "GEHEIM-345"])
        assert.ok(!result.xml.includes(hidden));
    }
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("the organization form supplies the complete locally validated sender address", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showOrganization());
    await page.waitForFunction(
      () =>
        document.querySelector('input[name="companyName"]')?.value ===
        "Musterbetrieb Browser",
    );
    await page
      .getByRole("textbox", { name: /^Firmenname/ })
      .fill("Privater Musterbetrieb");
    await page
      .getByRole("textbox", { name: "Straße und Hausnummer", exact: true })
      .fill("Handwerkerstraße 23");
    await page
      .getByRole("textbox", { name: "Ort", exact: true })
      .fill("Bamberg");
    await page.getByRole("textbox", { name: "PLZ", exact: true }).fill("96047");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(
      () => window.cryptoFixture.organizationState().requests.length === 1,
    );
    const state = await page.evaluate(() =>
      window.cryptoFixture.organizationState(),
    );
    assert.deepEqual(state.profile, {
      companyName: "Privater Musterbetrieb",
      address: {
        streetAddress: "Handwerkerstraße 23",
        city: "Bamberg",
        zip: "96047",
        country: "DE",
      },
    });
    assert.ok(state.invalidations.includes("settings.organization.get"));
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("invoice numbering settings retain large decimal counters in the existing form", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showOrganization("numbering"),
    );
    const scheme = page.getByRole("button", { name: /Rechnungsnummer-Schema/ });
    await scheme.and(page.locator(":enabled")).waitFor();
    await scheme.click();
    await page
      .getByRole("option", {
        name: "Projektbasiert, lokal fortlaufend",
        exact: true,
      })
      .click();
    await page
      .getByRole("textbox", { name: /^Startnummer je Projekt/ })
      .fill("1234567890123456789");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.waitForFunction(
      () => window.cryptoFixture.organizationState().requests.length === 1,
    );
    const state = await page.evaluate(() =>
      window.cryptoFixture.organizationState(),
    );
    assert.deepEqual(state.numbering, {
      scheme: "projectLocal",
      startNumber: "1234567890123456789",
    });
    assert.ok(state.invalidations.includes("settings.invoiceNumbering.get"));
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

for (const kind of ["profile", "numbering"])
  test(`a stale ${kind} form keeps its input and requires a deliberate reload`, async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(
        (kind) => window.cryptoFixture.showOrganization(kind),
        kind,
      );
      const input = page.getByRole("textbox", {
        name: kind === "profile" ? /^Firmenname/ : /^Globale Startnummer/,
      });
      await input.and(page.locator(":enabled")).waitFor();
      await page.waitForFunction(
        (kind) =>
          document.querySelector(
            `input[name="${kind === "profile" ? "companyName" : "startNumber"}"]`,
          )?.value === (kind === "profile" ? "Musterbetrieb Browser" : "5368"),
        kind,
      );
      const typed =
        kind === "profile"
          ? "Eigene noch ungespeicherte Anschrift"
          : "1234567890123456789";
      await input.fill(typed);
      await page.evaluate(async (kind) => {
        window.cryptoFixture.changeOrganization(
          kind,
          kind === "profile"
            ? {
                companyName: "Anderer gespeicherter Stand",
                address: {
                  streetAddress: "Neuer Bauweg 8",
                  city: "Bamberg",
                  zip: "96047",
                  country: "DE",
                },
              }
            : { scheme: "sequential", startNumber: "987654321012345678" },
        );
        await window.cryptoFixture.readOrganization(kind);
      }, kind);
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await page
        .getByText(/Die Einstellungen wurden inzwischen geändert/)
        .waitFor();
      assert.equal(await input.inputValue(), typed);
      assert.equal(
        (await page.evaluate(() => window.cryptoFixture.organizationState()))
          .requests.length,
        0,
      );
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      assert.equal(
        (await page.evaluate(() => window.cryptoFixture.organizationState()))
          .requests.length,
        0,
      );
      await page
        .getByRole("button", { name: "Aktuellen Stand laden", exact: true })
        .click();
      await page.waitForFunction(
        (kind) =>
          document.querySelector(
            `input[name="${kind === "profile" ? "companyName" : "startNumber"}"]`,
          )?.value ===
          (kind === "profile"
            ? "Anderer gespeicherter Stand"
            : "987654321012345678"),
        kind,
      );
      await input.fill(typed);
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await page.waitForFunction(
        () => window.cryptoFixture.organizationState().requests.length === 1,
      );
      await input.fill(
        kind === "profile"
          ? "Zweite bestätigte Änderung"
          : "876543210123456789",
      );
      await page
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await page.waitForFunction(
        () => window.cryptoFixture.organizationState().requests.length === 2,
      );
    } finally {
      await context.close();
    }
  });

test("private print pixels and prepared buffers follow the current access context even for identical asset identifiers", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPrintTemplates("cache"));
    const first = await page.evaluate(() =>
      window.cryptoFixture.preparePrintAssets(),
    );
    assert.deepEqual(first.pixel, [255, 0, 0, 255]);
    await page.evaluate(() => window.cryptoFixture.preparePrintAssets());
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.printState())).calls
        .length,
      1,
    );
    await page.evaluate(() => window.cryptoFixture.switchPrintContext());
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.printState())).cleared,
      true,
    );
    const next = await page.evaluate(() =>
      window.cryptoFixture.preparePrintAssets(),
    );
    assert.deepEqual(next.pixel, [0, 0, 255, 255]);
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.printState())).calls
        .length,
      2,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("a late print asset cannot return pixels or enter the next access context's cache", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showPrintTemplates("cache"));
    await page.evaluate(() => {
      window.cryptoFixture.pausePrintAssets();
      window.cryptoFixture.beginLatePrintAssets();
    });
    await page.waitForFunction(
      () => window.cryptoFixture.printState().pending === 1,
    );
    await page.evaluate(async () => {
      await window.cryptoFixture.switchPrintContext();
      window.cryptoFixture.releasePrintAssets();
    });
    await page.waitForFunction(
      () => window.cryptoFixture.printState().late === "rejected",
    );
    assert.deepEqual(
      (await page.evaluate(() => window.cryptoFixture.preparePrintAssets()))
        .pixel,
      [0, 0, 255, 255],
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("SVG print pixels use a canonical static document and reject foreign embedded browsing contexts", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(async () => {
      await window.cryptoFixture.showPrintTemplates("cache");
      await window.cryptoFixture.setPrintSvg(false);
    });
    assert.deepEqual(
      (await page.evaluate(() => window.cryptoFixture.preparePrintAssets()))
        .pixel,
      [255, 0, 0, 255],
    );
    await page.evaluate(() => window.cryptoFixture.setPrintSvg(true));
    assert.equal(
      await page.evaluate(async () => {
        try {
          await window.cryptoFixture.preparePrintAssets();
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test(
  "a template draft survives an unrelated access refresh but is removed after read revocation and identity change",
  { timeout: 60000 },
  async () => {
    const { context, page } = await open();
    page.setDefaultTimeout(15000);
    try {
      await page.evaluate(() => window.cryptoFixture.showPrintTemplates());
      await page
        .getByRole("textbox", { name: "Typst-Vorlagencode", exact: true })
        .waitFor();
      await page.evaluate(async () => {
        const source = window.cryptoFixture.printState().template.source;
        await window.cryptoFixture.setTemplateSource(
          source + "\n// PRIVATE UNSAVED DRAFT 48931\n",
        );
      });
      await page.evaluate(() => window.cryptoFixture.switchPrintContext());
      await page.waitForFunction(async () =>
        (await window.cryptoFixture.printDrafts()).some((value) =>
          value.includes("PRIVATE UNSAVED DRAFT 48931"),
        ),
      );
      await page.evaluate(() => window.cryptoFixture.revokePrintRead());
      await page.getByText("Vorlage nicht geladen", { exact: true }).waitFor();
      await page.waitForFunction(
        async () => (await window.cryptoFixture.printDrafts()).length === 0,
      );
      await page.evaluate(() => window.cryptoFixture.switchPrintIdentity());
      await page.waitForFunction(async () =>
        (await window.cryptoFixture.printDrafts()).some((value) =>
          value.includes("OTHER TENANT"),
        ),
      );
      assert.equal(
        (await page.evaluate(() => window.cryptoFixture.printDrafts())).some(
          (value) => value.includes("PRIVATE UNSAVED DRAFT 48931"),
        ),
        false,
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "the actual Typst editor compiles private header/footer/table styles with images and PDF pages and clears compiler shadows",
  { timeout: 90000 },
  async () => {
    const { context, page, external } = await open();
    page.setDefaultTimeout(20000);
    try {
      await page.setViewportSize({ width: 1440, height: 1080 });
      await page.evaluate(() => window.cryptoFixture.showPrintTemplates());
      await page
        .getByRole("textbox", { name: "Typst-Vorlagencode", exact: true })
        .waitFor();
      await page
        .getByRole("region", { name: "PDF-Vorschau", exact: true })
        .locator("iframe")
        .waitFor();
      const before = await page.evaluate(() =>
        window.cryptoFixture.compilePrint(),
      );
      assert.match(before.text, /HEADER Musterbetrieb Browser/);
      assert.match(before.text, /FOOTER/);
      assert.ok(before.images >= 1);
      const pdf = await readFile(
        new URL(
          "../../../sortsys-api-v2/test-files/searchable-project-document.pdf",
          import.meta.url,
        ),
      );
      await page.locator('input[type="file"]').setInputFiles({
        name: "Bauplan.pdf",
        mimeType: "application/pdf",
        buffer: pdf,
      });
      await page.getByText("Bauplan.pdf", { exact: true }).waitFor();
      const source = (
        await page.evaluate(() => window.cryptoFixture.printState())
      ).template.source
        .replace("HEADER", "KOPF PRIVAT")
        .replace(
          "  body\n",
          '  body\n  attachment("Bauplan.pdf", width: 100%)\n',
        );
      await page.evaluate(
        (source) => window.cryptoFixture.setTemplateSource(source),
        source,
      );
      await page
        .getByRole("button", { name: "Vorlage speichern", exact: true })
        .and(page.locator(":enabled"))
        .waitFor();
      await page
        .getByRole("button", { name: "Vorlage speichern", exact: true })
        .click();
      await page.waitForFunction(() =>
        window.cryptoFixture
          .printState()
          .template.source.includes("KOPF PRIVAT"),
      );
      const after = await page.evaluate(() =>
        window.cryptoFixture.compilePrint(),
      );
      assert.match(after.text, /KOPF PRIVAT Musterbetrieb Browser/);
      assert.ok(after.images >= 2);
      assert.ok(after.pages >= 2);
      await page.evaluate(() =>
        window.cryptoFixture.setTemplateSource("#let broken = ("),
      );
      await page.getByText("Typst-Vorlage prüfen", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Vorlage speichern", exact: true })
          .isDisabled(),
        true,
      );
      assert.match(
        (await page.evaluate(() => window.cryptoFixture.printState())).template
          .source,
        /KOPF PRIVAT/,
      );
      const count = (
        await page.evaluate(() => window.cryptoFixture.printState())
      ).mutations.length;
      await page
        .getByRole("textbox", { name: "Typst-Vorlagencode", exact: true })
        .press("ControlOrMeta+s");
      await page
        .getByText("Aktion nicht abgeschlossen", { exact: true })
        .waitFor();
      assert.equal(
        (await page.evaluate(() => window.cryptoFixture.printState())).mutations
          .length,
        count,
        "Keyboard saving must also compile before publishing",
      );
      await page.locator('input[type="file"]').setInputFiles({
        name: "Remote.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg><image href="https://outside.example/logo.png"/></svg>',
        ),
      });
      await page
        .getByText(/Die Datei ist ungültig oder enthält externe Verweise/)
        .waitFor();
      assert.equal(
        (await page.evaluate(() => window.cryptoFixture.printState())).template
          .assets.length,
        2,
      );
      const shadows = await page.evaluate(() =>
        window.cryptoFixture.probePrintShadows(),
      );
      assert.equal(shadows.rejected, true, JSON.stringify(shadows));
      // A removed shadow has no filesystem capability. The WASM loader may
      // report either a missing file or a denied path outside its virtual root.
      assert.match(
        shadows.error,
        /failed to load file.*(?:access denied|file not found)/i,
      );
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  },
);

test("commercial lists extend one streamed window, accept query results and clear old account data", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showCommercialCases());
    const list = page.getByRole("region", { name: "Angebotsübersicht" });
    await list.getByText("Vertrauliches Angebot 1", { exact: true }).waitFor();
    await list.getByRole("button", { name: "Mehr anzeigen" }).click();
    await list.getByText("Vertrauliches Angebot 55", { exact: true }).waitFor();
    const expanded = await page.evaluate(() =>
      window.cryptoFixture.commercialState(),
    );
    assert.equal(expanded.streams, 1);
    assert.deepEqual(expanded.requests.slice(-2), [
      { search: null, offset: "0", limit: "50" },
      { search: null, offset: "0", limit: "100" },
    ]);

    await page.evaluate(() =>
      window.cryptoFixture.changeCommercialCase("Gemeinsam geändertes Angebot"),
    );
    await list
      .getByText("Gemeinsam geändertes Angebot", { exact: true })
      .waitFor();
    assert.equal(
      await list.getByText("Vertrauliches Angebot 55", { exact: true }).count(),
      1,
    );
    await list
      .getByLabel("Suchen", { exact: true })
      .fill("Beschreibungstreffer");
    await list
      .getByText("Gemeinsam geändertes Angebot", { exact: true })
      .waitFor();
    const state = await page.evaluate(() =>
      window.cryptoFixture.commercialState(),
    );
    assert.equal(state.streams, 1);
    assert.equal(state.requests.at(-1).search, "Beschreibungstreffer");
    await page.evaluate(() => window.cryptoFixture.resetCommercialCases());
    await list
      .getByText("Gemeinsam geändertes Angebot", { exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await list.getByText("Vertrauliches Angebot 55", { exact: true }).count(),
      0,
    );
    await list.getByText(/Noch keine Angebote/).waitFor();
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.commercialState()))
        .streams,
      1,
    );
  } finally {
    await context.close();
  }
});

test("an invitation opens the ordinary password form and removes its secret fragment in StrictMode", async () => {
  const { context, page, external } = await open();
  try {
    const link = await page.evaluate(() =>
      window.cryptoFixture.showInvitation(),
    );
    await page.getByRole("heading", { name: "Einladung annehmen" }).waitFor();
    await page.getByLabel(/^Passwort/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Anmelden", exact: true }).count(),
      1,
    );
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(
      (await page.locator("body").innerText()).includes(link.secret),
      false,
    );
    assert.equal(await page.locator('input[type="password"]').count(), 1);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("a new member sets an ordinary password after local invitation verification", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showInvitation(false, false),
    );
    await page.getByLabel(/^Passwort festlegen/).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Zugang einrichten", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page.locator('input[type="password"]').getAttribute("autocomplete"),
      "new-password",
    );
    assert.equal(new URL(page.url()).hash, "");
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});
test("an operator-substituted invitation authority cannot open a password form", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showInvitation(false, false, true),
    );
    await page
      .getByText("Die Einladung konnte nicht geprüft werden.", { exact: false })
      .waitFor();
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.equal(new URL(page.url()).hash, "");
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("a malformed invitation shows a fixed error without reflecting its fragment", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showInvitation(true));
    await page
      .getByText("Die Einladung ist unvollständig.", { exact: false })
      .waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(
      (await page.locator("body").innerText()).includes("invalid-fragment"),
      false,
    );
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("an accepted invitation opens the workspace action when approval arrives without a manual refresh", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showInvitation(false, true, false, true),
    );
    await page
      .getByRole("button", { name: "Freigabe prüfen", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Arbeitsbereich öffnen", exact: true }).count(),
      0,
    );
    await page.evaluate(() => window.cryptoFixture.completeInvitation());
    await page
      .getByRole("button", { name: "Arbeitsbereich öffnen", exact: true })
      .waitFor();
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("business roles can be selected for a new invitation and stay with the selected account", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    const people = page.getByRole("combobox", { name: "Benutzerkonto" });
    await people.fill("neues");
    await page.getByRole("option", { name: "neues.konto", exact: true }).click();
    await waitForClosedListboxes(page);
    const roles = page.getByRole("group", { name: "Fachrollen", exact: true });
    const purchasing = roles.getByRole("checkbox", { name: /^Einkauf/ });
    await purchasing.press("Space");
    assert.equal(await purchasing.isChecked(), true);
    assert.equal(
      await page.getByRole("button", { name: "Einladung erstellen", exact: true }).isEnabled(),
      true,
    );

    await people.fill("recovery");
    await page.getByRole("option", { name: "konto.nach.recovery", exact: true }).click();
    await waitForClosedListboxes(page);
    assert.equal(await purchasing.isChecked(), false);
  } finally {
    await context.close();
  }
});

test("project value and subcontract grants remain independent in the actual access form", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
    await page.getByRole("option", { name: "frank.doe", exact: true }).click();
    const project = page.getByRole("combobox", {
      name: "Projekt",
      exact: true,
    });
    await waitForClosedListboxes(page);
    await revealField(page, project);
    await project.fill("Fenster");
    await page
      .getByRole("option", { name: "Fenstersanierung", exact: true })
      .click();
    await waitForClosedListboxes(page);
    const values = page.getByRole("button", { name: /Auftragswerte/ }),
      awards = page.getByRole("button", { name: /Weitervergaben/ }),
      master = page.getByRole("button", { name: /Projektgrunddaten/ });
    assert.match(await values.innerText(), /Lesen/);
    assert.match(await awards.innerText(), /Individuell/);
    assert.match(await master.innerText(), /Lesen/);
    await values.click();
    await page
      .getByRole("option", { name: "Kein Zugriff", exact: true })
      .click();
    await waitForClosedListboxes(page);
    assert.match(await values.innerText(), /Kein Zugriff/);
    assert.match(await awards.innerText(), /Individuell/);
    assert.match(await master.innerText(), /Lesen/);
    await revealField(page, master);
    await master.click();
    await page
      .getByRole("option", { name: "Individuell", exact: true })
      .click();
    await waitForClosedListboxes(page);
    await page
      .getByRole("group", {
        name: "Einzelrechte für Projektgrunddaten",
        exact: true,
      })
      .waitFor();
    await revealField(page, project);
    await project.fill("Innenputz");
    await page.getByRole("option", { name: "Innenputz", exact: true }).click();
    await waitForClosedListboxes(page);
    assert.match(await values.innerText(), /Kein Zugriff/);
    assert.match(await awards.innerText(), /Kein Zugriff/);
    assert.match(await master.innerText(), /Kein Zugriff/);
    assert.equal(
      await page
        .getByRole("group", {
          name: "Einzelrechte für Projektgrunddaten",
          exact: true,
        })
        .count(),
      0,
    );
  } finally {
    await context.close();
  }
});

for (const discard of [false, true])
  test(`individual project delete rights preserve unedited actions${discard ? " after a false acknowledgement" : ""}`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(() => window.cryptoFixture.showUserAccess());
      await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
      await page
        .getByRole("option", { name: "frank.doe", exact: true })
        .click();
      const project = page.getByRole("combobox", {
        name: "Projekt",
        exact: true,
      });
      await waitForClosedListboxes(page);
      await revealField(page, project);
      await project.fill("Fenster");
      await page
        .getByRole("option", { name: "Fenstersanierung", exact: true })
        .click();
      await waitForClosedListboxes(page);
      await page.getByRole("button", { name: /Projektgrunddaten/ }).click();
      await page
        .getByRole("option", { name: "Individuell", exact: true })
        .click();
      await waitForClosedListboxes(page);
      const actions = page.getByRole("group", {
        name: "Einzelrechte für Projektgrunddaten",
        exact: true,
      });
      assert.equal(
        await actions
          .getByRole("checkbox", { name: "Lesen", exact: true })
          .isChecked(),
        true,
      );
      if (discard) {
        await actions
          .getByRole("checkbox", { name: "Löschen", exact: true })
          .focus();
        await page.keyboard.press("Space");
      } else await actions.getByText("Löschen", { exact: true }).click();
      assert.equal(
        await actions
          .getByRole("checkbox", { name: "Bearbeiten", exact: true })
          .isChecked(),
        false,
      );
      if (discard)
        await page.evaluate(() => window.cryptoFixture.failNextAccessSave());
      const save = page.getByRole("button", {
        name: "Projektzugriff speichern",
        exact: true,
      });
      await revealField(page, save);
      await save.click();
      if (discard) {
        await page
          .getByText(
            "Die Zugriffseinstellungen konnten nicht aktualisiert werden.",
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await actions
            .getByRole("checkbox", { name: "Löschen", exact: true })
            .isChecked(),
          true,
        );
        await save.click();
      }
      await waitForAccessSave(page, save);
      const { initial, saves } = await page.evaluate(() => ({
        initial: window.cryptoFixture.initialAccessRules(),
        saves: window.cryptoFixture.accessSaves(),
      }));
      assert.equal(saves.length, discard ? 2 : 1);
      assert.deepEqual(saves.at(-1).rules.slice(0, initial.length), initial);
      assert.deepEqual(saves.at(-1).rules.at(-1), {
        subject: "user:2",
        scope: "project:4",
        facet: "master-data",
        actions: ["delete"],
        effect: "allow",
      });
      assert.equal(
        await actions
          .getByRole("checkbox", { name: "Anlegen", exact: true })
          .isChecked(),
        false,
      );
      if (!discard)
        await page.screenshot({
          path: "/tmp/sortsys-individual-access.png",
          fullPage: true,
        });
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });

test("two project areas save as one policy while newer untouched actions remain granted", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
    await page.getByRole("option", { name: "frank.doe", exact: true }).click();
    const project = page.getByRole("combobox", {
      name: "Projekt",
      exact: true,
    });
    await waitForClosedListboxes(page);
    await revealField(page, project);
    await project.fill("Fenster");
    await page
      .getByRole("option", { name: "Fenstersanierung", exact: true })
      .click();
    await waitForClosedListboxes(page);
    await page.getByRole("button", { name: /Projektgrunddaten/ }).click();
    await page
      .getByRole("option", { name: "Individuell", exact: true })
      .click();
    await waitForClosedListboxes(page);
    const actions = page.getByRole("group", {
      name: "Einzelrechte für Projektgrunddaten",
      exact: true,
    });
    await actions.getByText("Löschen", { exact: true }).click();
    await page.getByRole("button", { name: /Projektdateien/ }).click();
    await page.getByRole("option", { name: "Lesen", exact: true }).click();
    await waitForClosedListboxes(page);
    await page.evaluate(() =>
      window.cryptoFixture.grantConcurrentProjectUpdate(),
    );
    const save = page.getByRole("button", {
      name: "Projektzugriff speichern",
      exact: true,
    });
    await revealField(page, save);
    await save.click();
    await waitForAccessSave(page, save);
    const saves = await page.evaluate(() => window.cryptoFixture.accessSaves());
    assert.equal(saves.length, 1);
    assert.equal(saves[0].version, "4");
    assert.equal(
      await actions
        .getByRole("checkbox", { name: "Bearbeiten", exact: true })
        .isChecked(),
      true,
    );
    assert.ok(
      saves[0].rules.some(
        (rule) =>
          rule.subject === "user:2" &&
          rule.scope === "project:4" &&
          rule.facet === "attachment" &&
          rule.effect === "allow" &&
          rule.actions.join() === "read",
      ),
    );
  } finally {
    await context.close();
  }
});

test("the master-data access form saves an exact read/delete profile without adding create or update", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
    await page.getByRole("option", { name: "frank.doe", exact: true }).click();
    await waitForClosedListboxes(page);
    await page.getByRole("button", { name: /Produktkatalog/ }).click();
    await page
      .getByRole("option", { name: "Individuell", exact: true })
      .click();
    await waitForClosedListboxes(page);
    const actions = page.getByRole("group", {
      name: "Einzelrechte für Produktkatalog",
      exact: true,
    });
    await actions.getByText("Löschen", { exact: true }).click();
    const save = page.getByRole("button", {
      name: "Berechtigungen speichern",
      exact: true,
    });
    await revealField(page, save);
    await save.click();
    await waitForAccessSave(page, save);
    const saves = await page.evaluate(() => window.cryptoFixture.accessSaves());
    assert.equal(saves.length, 1);
    assert.equal(
      await actions
        .getByRole("checkbox", { name: "Lesen", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(
      await actions
        .getByRole("checkbox", { name: "Bearbeiten", exact: true })
        .isChecked(),
      false,
    );
    assert.equal(
      await actions
        .getByRole("checkbox", { name: "Anlegen", exact: true })
        .isChecked(),
      false,
    );
    assert.ok(
      saves[0].rules.some(
        (rule) =>
          rule.subject === "user:2" &&
          rule.scope === "catalog:products" &&
          rule.facet === "master-data" &&
          rule.effect === "allow" &&
          rule.actions.join() === "delete",
      ),
    );
  } finally {
    await context.close();
  }
});

for (const discard of [false, true])
  test(`report modules are independently editable in the actual project access form${discard ? " after a false acknowledgement" : ""}`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(() => window.cryptoFixture.showUserAccess());
      await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
      await page
        .getByRole("option", { name: "frank.doe", exact: true })
        .click();
      const project = page.getByRole("combobox", {
        name: "Projekt",
        exact: true,
      });
      await waitForClosedListboxes(page);
      await revealField(page, project);
      await project.fill("Fenster");
      await page
        .getByRole("option", { name: "Fenstersanierung", exact: true })
        .click();
      await waitForClosedListboxes(page);
      const delivery = page.getByRole("button", { name: /Lieferscheine/ }),
        prices = page.getByRole("button", { name: /Lieferscheinpreise/ }),
        daily = page.getByRole("button", {
          name: /Bautagesberichte und Arbeitszeiten/,
        }),
        regie = page.getByRole("button", {
          name: /Regieberichte und Material/,
        }),
        hours = page.getByRole("button", {
          name: /Arbeitszeiten der Regieberichte/,
        });
      assert.match(await delivery.innerText(), /Individuell/);
      const deliveryActions = page.getByRole("group", {
        name: "Einzelrechte für Lieferscheine",
        exact: true,
      });
      assert.equal(
        await deliveryActions
          .getByRole("checkbox", { name: "Lesen", exact: true })
          .isChecked(),
        true,
      );
      assert.equal(
        await deliveryActions
          .getByRole("checkbox", { name: "Bearbeiten", exact: true })
          .isChecked(),
        true,
      );
      assert.match(await prices.innerText(), /Kein Zugriff/);
      assert.match(await daily.innerText(), /Lesen/);
      assert.match(await regie.innerText(), /Individuell/);
      assert.match(await hours.innerText(), /Lesen/);
      const save = page.getByRole("button", {
        name: "Projektzugriff speichern",
        exact: true,
      });
      assert.equal(await save.isDisabled(), true);
      await revealField(page, prices);
      await prices.click();
      await page.getByRole("option", { name: "Lesen", exact: true }).click();
      await waitForClosedListboxes(page);
      if (discard)
        await page.evaluate(() => window.cryptoFixture.failNextAccessSave());
      await revealField(page, save);
      await save.click();
      if (discard) {
        await page
          .getByText(
            "Die Zugriffseinstellungen konnten nicht aktualisiert werden.",
            { exact: true },
          )
          .waitFor();
        assert.equal(await save.isEnabled(), true);
        await save.click();
      }
      await waitForAccessSave(page, save);
      const { initial, saves } = await page.evaluate(() => ({
        initial: window.cryptoFixture.initialAccessRules(),
        saves: window.cryptoFixture.accessSaves(),
      }));
      const edited = (rule) =>
        rule.subject === "user:2" &&
        rule.scope === "project:4:delivery-notes" &&
        rule.facet === "procurement";
      assert.equal(saves.length, discard ? 2 : 1);
      assert.deepEqual(
        saves.at(-1).rules.filter((rule) => !edited(rule)),
        initial,
      );
      assert.ok(
        saves
          .at(-1)
          .rules.some(
            (rule) =>
              edited(rule) &&
              rule.effect === "allow" &&
              rule.actions.join() === "read",
          ),
      );
      assert.match(await regie.innerText(), /Individuell/);
      assert.match(await hours.innerText(), /Lesen/);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });

async function waitForAccessSave(page, button) {
  await page.waitForFunction(
    (element) => element.disabled && element.dataset.pending !== "true",
    await button.elementHandle(),
  );
}

for (const failure of ["certificate", "policy"]) {
  test(`creation access retains edited booking permissions after a false ${failure} acknowledgement`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(() => window.cryptoFixture.showUserAccess());
      await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
      await page
        .getByRole("option", { name: "frank.doe", exact: true })
        .click();
      await waitForClosedListboxes(page);
      const project = page.getByRole("checkbox", {
        name: "Neue Projekte anlegen",
        exact: true,
      });
      const booking = page.getByRole("checkbox", {
        name: "Neue Werkzeugbuchungen anlegen",
        exact: true,
      });
      await revealField(page, booking);
      await booking.focus();
      await booking.press("Space");
      assert.equal(await booking.isChecked(), true);
      const save = page.getByRole("button", {
        name: "Anlageberechtigungen speichern",
        exact: true,
      });
      if (failure === "certificate")
        await page.evaluate(() =>
          window.cryptoFixture.failNextCreationCertificate(),
        );
      else await page.evaluate(() => window.cryptoFixture.failNextAccessSave());
      await save.click();
      await page
        .getByText(
          "Die Anlageberechtigungen konnten nicht aktualisiert werden.",
          { exact: true },
        )
        .waitFor();
      assert.equal(await booking.isChecked(), true);
      assert.equal(await project.isChecked(), false);
      assert.equal(await save.isEnabled(), true);
      await save.click();
      await waitForAccessSave(page, save);
      await booking.and(page.locator(":enabled")).waitFor();
      assert.equal(await booking.isChecked(), true);
      const saves = await page.evaluate(() =>
        window.cryptoFixture.accessSaves(),
      );
      assert.equal(saves.length, failure === "certificate" ? 1 : 2);
      assert.ok(
        saves
          .at(-1)
          .rules.some(
            (rule) =>
              rule.subject === "user:2" &&
              rule.scope === "create:tool-tracking" &&
              rule.effect === "allow" &&
              rule.actions.join() === "create",
          ),
      );
      assert.equal(
        saves
          .at(-1)
          .rules.some(
            (rule) =>
              rule.subject === "user:2" && rule.scope === "create:project",
          ),
        false,
      );
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

for (const scenario of [
  {
    kind: "tool",
    picker: "Werkzeug",
    primary: "Werkzeugstammdaten",
    costs: "Anschaffung und Nutzungskosten",
    edited: "Werkzeuginventuren",
    facet: "measurement",
    scope: "tool:8",
    save: "Werkzeugzugriff speichern",
    error: "Die Werkzeugfreigaben konnten nicht aktualisiert werden.",
    discard: false,
  },
  {
    kind: "booking",
    picker: "Werkzeugbuchung",
    primary: "Buchungsdaten",
    costs: "Historische Nutzungskosten",
    edited: "Umbuchungsanfragen",
    facet: "scope",
    scope: "tool-tracking:a",
    save: "Buchungszugriff speichern",
    error: "Die Buchungsfreigaben konnten nicht aktualisiert werden.",
    discard: true,
  },
]) {
  test(`${scenario.kind} access saves one edited area and preserves custom master-data rights and denied costs`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(() => window.cryptoFixture.showUserAccess());
      await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
      await page
        .getByRole("option", { name: "frank.doe", exact: true })
        .click();
      await waitForClosedListboxes(page);
      const picker = page.getByRole("combobox", {
        name: scenario.picker,
        exact: true,
      });
      await revealField(page, picker);
      await picker.fill("Nordflügel");
      await page
        .getByRole("option", { name: /73 Muster Bohrhammer Nordflügel/ })
        .click();
      await waitForClosedListboxes(page);
      const primary = page.getByRole("button", {
        name: new RegExp(scenario.primary),
      });
      const costs = page.getByRole("button", {
        name: new RegExp(scenario.costs),
      });
      const edited = page.getByRole("button", {
        name: new RegExp(scenario.edited),
      });
      await primary.and(page.locator(":enabled")).waitFor();
      assert.match(await primary.innerText(), /Individuell/);
      assert.match(await costs.innerText(), /Kein Zugriff/);
      await edited.click();
      await page.getByRole("option", { name: "Lesen", exact: true }).click();
      await waitForClosedListboxes(page);
      const save = page.getByRole("button", {
        name: scenario.save,
        exact: true,
      });
      if (scenario.discard)
        await page.evaluate(() => window.cryptoFixture.failNextAccessSave());
      await save.click();
      if (scenario.discard) {
        await page.getByText(scenario.error, { exact: true }).waitFor();
        assert.match(await edited.innerText(), /Lesen/);
        assert.equal(await save.isEnabled(), true);
        await save.click();
      }
      await waitForAccessSave(page, save);
      const { initial, saves } = await page.evaluate(() => ({
        initial: window.cryptoFixture.initialAccessRules(),
        saves: window.cryptoFixture.accessSaves(),
      }));
      assert.equal(saves.length, scenario.discard ? 2 : 1);
      const changed = (rule) =>
        rule.subject === "user:2" &&
        rule.scope === scenario.scope &&
        rule.facet === scenario.facet;
      assert.deepEqual(
        saves.at(-1).rules.filter((rule) => !changed(rule)),
        initial,
      );
      assert.deepEqual(saves.at(-1).rules.filter(changed), [
        {
          subject: "user:2",
          scope: scenario.scope,
          facet: scenario.facet,
          actions: ["read"],
          effect: "allow",
        },
        {
          subject: "user:2",
          scope: scenario.scope,
          facet: scenario.facet,
          actions: ["create", "update", "delete", "approve", "grant"],
          effect: "deny",
        },
      ]);
      await revealField(page, picker);
      await picker.fill("Südflügel");
      await page
        .getByRole("option", { name: /74 Muster Rührwerk Südflügel/ })
        .click();
      await waitForClosedListboxes(page);
      await primary.and(page.locator(":enabled")).waitFor();
      for (const field of [primary, costs, edited])
        assert.match(await field.innerText(), /Kein Zugriff/);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

async function chooseAccessDocument(page, title) {
  const picker = page.getByRole("combobox", {
    name: "Angebot oder Dokument",
    exact: true,
  });
  await revealField(page, picker);
  await picker.fill(title);
  await page.getByRole("option", { name: new RegExp(title) }).click();
  await waitForClosedListboxes(page);
}

for (const scenario of [
  { suffix: "", discard: false, refresh: false },
  { suffix: " after a false acknowledgement", discard: true, refresh: false },
  { suffix: " during a live access refresh", discard: false, refresh: true },
]) {
  const { discard, refresh } = scenario;
  test(`document access saves only edited text actions and retains other grants${scenario.suffix}`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(() =>
        window.cryptoFixture.showUserAccess(false, true),
      );
      await chooseAccessDocument(page, "Vertrauliche Fassadenarbeiten");
      const text = page.getByRole("button", {
        name: /Leistungsbeschreibungen/,
      });
      await text.and(page.locator(":enabled")).waitFor();
      assert.match(await text.innerText(), /Individuell/);
      const prices = page.getByRole("button", { name: /Angebotspreise/ });
      assert.match(await prices.innerText(), /Kein Zugriff/);
      await text.click();
      await page
        .getByRole("option", { name: "Individuell", exact: true })
        .click();
      await waitForClosedListboxes(page);
      const actions = page.getByRole("group", {
        name: "Einzelrechte für Leistungsbeschreibungen",
        exact: true,
      });
      await actions.getByText("Löschen", { exact: true }).click();
      await page.evaluate(() =>
        window.cryptoFixture.grantConcurrentOfferPriceRead(),
      );
      const save = page.getByRole("button", {
        name: "Dokumentzugriff speichern",
        exact: true,
      });
      if (discard)
        await page.evaluate(() => window.cryptoFixture.failNextAccessSave());
      if (refresh) {
        await page.evaluate(() => {
          window.cryptoFixture.recordAccessReads();
          window.cryptoFixture.refreshContextAfterNextAccessSave();
        });
      }
      await save.click();
      if (discard) {
        await page
          .getByText(
            "Die Dokumentfreigaben konnten nicht aktualisiert werden.",
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await actions
            .getByRole("checkbox", { name: "Löschen", exact: true })
            .isChecked(),
          true,
        );
        assert.equal(await save.isEnabled(), true);
        await save.click();
      }
      await waitForAccessSave(page, save);
      await text.and(page.locator(":enabled")).waitFor();
      if (refresh) {
        const snapshots = await page.evaluate(() =>
          window.cryptoFixture.accessReads(),
        );
        const documentRightsReads = snapshots.filter(
          (domains) =>
            domains.length > 1 &&
            domains.every((domain) => domain.startsWith("commercial:6:")),
        );
        assert.equal(documentRightsReads.length, 1);
      }
      const { initial, saves } = await page.evaluate(() => ({
        initial: window.cryptoFixture.initialAccessRules(),
        saves: window.cryptoFixture.accessSaves(),
      }));
      assert.equal(saves.length, discard ? 2 : 1);
      const last = saves.at(-1).rules;
      const textRule = (rule) =>
        rule.subject === "user:2" &&
        rule.scope === "commercial:6" &&
        rule.facet === "scope";
      const priceRule = {
        subject: "user:2",
        scope: "commercial:6",
        facet: "offer-prices",
        actions: ["read"],
        effect: "allow",
      };
      assert.deepEqual(
        last.filter((rule) => !textRule(rule)),
        [...initial.filter((rule) => !textRule(rule)), priceRule],
      );
      assert.deepEqual(
        last
          .filter(textRule)
          .flatMap((rule) => rule.actions)
          .sort(),
        ["delete", "read", "update"],
      );
      assert.match(await prices.innerText(), /Lesen/);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("a refused save reloads document rights and reports the failure after the content context changes", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess(false, true));
    await chooseAccessDocument(page, "Vertrauliche Fassadenarbeiten");
    const text = page.getByRole("button", { name: /Leistungsbeschreibungen/ });
    await text.and(page.locator(":enabled")).waitFor();
    assert.match(await text.innerText(), /Individuell/);
    await text.click();
    await page.getByRole("option", { name: "Lesen", exact: true }).click();
    await waitForClosedListboxes(page);
    await page.evaluate(() => {
      window.cryptoFixture.failNextAccessSave();
      window.cryptoFixture.refreshContextAfterNextAccessSave();
    });
    const save = page.getByRole("button", {
      name: "Dokumentzugriff speichern",
      exact: true,
    });
    await save.click();
    const error = page.getByText(
      "Die Dokumentfreigaben konnten nicht aktualisiert werden.",
      { exact: true },
    );
    await error.waitFor();
    await text.and(page.locator(":enabled")).waitFor();
    assert.equal(await error.isVisible(), true);
    assert.match(await text.innerText(), /Individuell/);
    assert.equal(await save.isDisabled(), true);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("switching access documents discards a late policy result for the previous choice", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess(false, true));
    await page.evaluate(() => window.cryptoFixture.holdNextAccessRead());
    await chooseAccessDocument(page, "Vertrauliche Fassadenarbeiten");
    await page.waitForFunction(() => window.cryptoFixture.accessReadHeld());
    await chooseAccessDocument(page, "Eigenständige Dacharbeiten");
    const text = page.getByRole("button", { name: /Leistungsbeschreibungen/ });
    await text.and(page.locator(":enabled")).waitFor();
    assert.match(await text.innerText(), /Kein Zugriff/);
    await page.evaluate(() => window.cryptoFixture.releaseAccessRead());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.match(await text.innerText(), /Kein Zugriff/);
    assert.equal(
      await page
        .getByRole("button", { name: "Dokumentzugriff speichern", exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.accessSaves()),
      [],
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("locking the account removes document access labels and rejects late reads", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess(false, true));
    await page.evaluate(() => window.cryptoFixture.holdNextAccessRead());
    await chooseAccessDocument(page, "Vertrauliche Fassadenarbeiten");
    await page.waitForFunction(() => window.cryptoFixture.accessReadHeld());
    await page.evaluate(() => window.cryptoFixture.lockAccessSession());
    await page.evaluate(() => window.cryptoFixture.releaseAccessRead());
    await page.waitForFunction(
      () =>
        !document.body.textContent.includes("Vertrauliche Fassadenarbeiten"),
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "Angebot oder Dokument", exact: true })
        .inputValue(),
      "",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Dokumentzugriff speichern", exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.accessSaves()),
      [],
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

for (const discard of [false, true])
  test(`personnel access preserves custom name grants while saving hourly-rate rights${discard ? " after a false acknowledgement" : ""}`, async () => {
    const { context, page, external } = await open();
    try {
      await page.evaluate(() => window.cryptoFixture.showUserAccess());
      await page.getByRole("combobox", { name: "Benutzerkonto" }).fill("frank");
      await page
        .getByRole("option", { name: "frank.doe", exact: true })
        .click();
      const person = page.getByRole("combobox", {
        name: "Person",
        exact: true,
      });
      await waitForClosedListboxes(page);
      await revealField(page, person);
      await person.fill("Anna");
      await page
        .getByRole("option", {
          name: "Anna Mustermann (anna.muster)",
          exact: true,
        })
        .click();
      await waitForClosedListboxes(page);
      const names = page.getByRole("button", { name: /Name und Kontaktdaten/ }),
        employment = page.getByRole("button", { name: /Personalangaben/ }),
        costs = page.getByRole("button", { name: /Interner Stundensatz/ });
      await names.and(page.locator(":enabled")).waitFor();
      assert.match(await names.innerText(), /Individuell/);
      assert.match(await employment.innerText(), /Lesen und bearbeiten/);
      assert.match(await costs.innerText(), /Kein Zugriff/);
      const save = page.getByRole("button", {
        name: "Personalzugriff speichern",
        exact: true,
      });
      assert.equal(await save.isDisabled(), true);
      await costs.click();
      await page.getByRole("option", { name: "Lesen", exact: true }).click();
      await waitForClosedListboxes(page);
      if (discard)
        await page.evaluate(() => window.cryptoFixture.failNextAccessSave());
      await save.click();
      if (discard) {
        await page
          .getByText(
            "Die Personalfreigaben konnten nicht aktualisiert werden.",
            { exact: true },
          )
          .waitFor();
        assert.match(await costs.innerText(), /Lesen/);
        assert.equal(await save.isEnabled(), true);
        await save.click();
      }
      await page.waitForFunction(
        () => document.querySelectorAll('[role="alert"]').length === 0,
      );
      await waitForAccessSave(page, save);
      const { initial, saves } = await page.evaluate(() => ({
        initial: window.cryptoFixture.initialAccessRules(),
        saves: window.cryptoFixture.accessSaves(),
      }));
      assert.equal(saves.length, discard ? 2 : 1);
      const edited = (rule) =>
        rule.subject === "user:2" &&
        rule.scope === "personnel:4" &&
        rule.facet === "calculation";
      assert.deepEqual(
        saves.at(-1).rules.filter((rule) => !edited(rule)),
        initial,
      );
      assert.ok(
        saves
          .at(-1)
          .rules.some(
            (rule) =>
              edited(rule) &&
              rule.effect === "allow" &&
              rule.actions.length === 1 &&
              rule.actions[0] === "read",
          ),
      );
      await revealField(page, person);
      await person.fill("Max");
      await page
        .getByRole("option", { name: "Max Muster (max.muster)", exact: true })
        .click();
      await waitForClosedListboxes(page);
      await names.and(page.locator(":enabled")).waitFor();
      assert.match(await names.innerText(), /Kein Zugriff/);
      assert.match(await employment.innerText(), /Kein Zugriff/);
      assert.match(await costs.innerText(), /Kein Zugriff/);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });

test("an existing password without a current tenant certificate offers invitation controls", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    await page
      .getByRole("combobox", { name: "Benutzerkonto" })
      .fill("recovery");
    await page
      .getByRole("option", { name: "konto.nach.recovery", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Einladung erstellen", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Berechtigungen speichern", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: "Anlageberechtigungen speichern",
          exact: true,
        })
        .count(),
      0,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("the access form distinguishes editing a certified member from inviting a new account", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess());
    const account = page.getByRole("combobox", { name: "Benutzerkonto" });
    await account.fill("frank");
    await page.getByRole("option", { name: "frank.doe", exact: true }).click();
    await page
      .getByRole("button", { name: "Berechtigungen speichern", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "KI-Assistent und persönlicher Verlauf",
        })
        .isChecked(),
      true,
    );
    const prices = page.getByRole("button", { name: /Preisaufzeichnungen/ });
    const suppliers = page.getByRole("button", { name: /Lieferanten/ });
    assert.match(await prices.innerText(), /Kein Zugriff/);
    assert.match(await suppliers.innerText(), /Kein Zugriff/);
    await page.locator('[role="listbox"]').waitFor({ state: "hidden" });
    const customers = page.getByRole("button", { name: /Kunden/ });
    const contacts = page.getByRole("button", { name: /Ansprechpartner/ });
    assert.match(await customers.innerText(), /Kein Zugriff/);
    assert.match(await contacts.innerText(), /Kein Zugriff/);
    await prices.click();
    await page
      .getByRole("option", { name: "Lesen und bearbeiten", exact: true })
      .click();
    await waitForClosedListboxes(page);
    assert.match(await prices.innerText(), /Lesen und bearbeiten/);
    assert.match(await suppliers.innerText(), /Kein Zugriff/);
    await suppliers.click();
    await page.getByRole("option", { name: "Lesen", exact: true }).click();
    await waitForClosedListboxes(page);
    assert.match(await suppliers.innerText(), /Lesen/);
    assert.match(await prices.innerText(), /Lesen und bearbeiten/);
    await customers.click();
    await page.getByRole("option", { name: "Lesen", exact: true }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.match(await customers.innerText(), /Lesen/);
    assert.match(await contacts.innerText(), /Kein Zugriff/);
    const project = page.getByRole("combobox", {
      name: "Projekt",
      exact: true,
    });
    await revealField(page, project);
    await project.fill("Fenster");
    await page
      .getByRole("option", { name: "Fenstersanierung", exact: true })
      .click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    const projectLevel = page.getByRole("button", {
      name: /Projektgrunddaten/,
    });
    assert.match(await projectLevel.innerText(), /Lesen/);
    await revealField(page, project);
    await project.fill("Innenputz");
    await page.getByRole("option", { name: "Innenputz", exact: true }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.match(await projectLevel.innerText(), /Kein Zugriff/);
    const creation = page.getByRole("checkbox", {
      name: "Neue Projekte anlegen",
      exact: true,
    });
    const saveCreation = page.getByRole("button", {
      name: "Anlageberechtigungen speichern",
      exact: true,
    });
    assert.equal(await creation.isChecked(), false);
    assert.equal(await saveCreation.isDisabled(), true);
    await page.getByText("Neue Projekte anlegen", { exact: true }).click();
    assert.equal(await creation.isChecked(), true);
    assert.equal(await saveCreation.isEnabled(), true);
    await creation.focus();
    await page.keyboard.press("Space");
    assert.equal(await creation.isChecked(), false);
    assert.equal(await saveCreation.isDisabled(), true);
    const commercial = page.getByRole("checkbox", {
      name: "Neue Angebote und Aufträge anlegen",
      exact: true,
    });
    assert.equal(await commercial.isChecked(), false);
    await commercial.focus();
    await page.keyboard.press("Space");
    assert.equal(await commercial.isChecked(), true);
    assert.equal(
      await creation.isChecked(),
      false,
      "Offer creation must not toggle project creation",
    );
    assert.equal(await saveCreation.isEnabled(), true);
    await page.keyboard.press("Space");
    assert.equal(await commercial.isChecked(), false);
    assert.equal(await saveCreation.isDisabled(), true);
    await page.screenshot({
      path: "/tmp/sortsys-user-access.png",
      fullPage: true,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await revealField(page, account);
    await account.fill("neues");
    await page
      .getByRole("option", { name: "neues.konto", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Einladung erstellen", exact: true })
      .waitFor();
    assert.match(await customers.innerText(), /Kein zusätzlicher Zugriff/);
    assert.equal(
      await page
        .getByRole("heading", { name: "Projektzugriff", exact: true })
        .count(),
      0,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("encrypted device keys survive refresh, reject tampering and are erased on sign-out", async () => {
  const { context, page, external } = await open();
  try {
    const original = await page.evaluate(() => window.cryptoFixture.remember());
    assert.equal(original.stored, true);
    await page.reload();
    await page.waitForFunction(() => window.cryptoFixture);
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.restore())).signingKey,
      original.signingKey,
    );
    const record = await page.evaluate(() =>
      window.cryptoFixture.cachedRecord(),
    );
    assert.equal(record.nonExtractable, true);
    // The cached AES-256 account data key has a 16-byte authentication tag.
    assert.equal(record.ciphertextLength, 48);
    assert.deepEqual(record.storedFields, [
      "ciphertext",
      "id",
      "key",
      "nonce",
      "subject",
      "tenant",
      "vault",
    ]);
    await page.evaluate(() => window.cryptoFixture.cachedRecord(true));
    assert.equal(
      await page.evaluate(() => window.cryptoFixture.restore()),
      null,
    );
    assert.equal(
      await page.evaluate(() => window.cryptoFixture.protectedAccount()),
      true,
    );
    await page.evaluate(() => window.cryptoFixture.remember());
    await page.evaluate(() => window.cryptoFixture.forget());
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.cachedRecord())).count,
      0,
    );
    assert.equal(
      await page.evaluate(() => window.cryptoFixture.restore()),
      null,
    );
    assert.equal(
      await page.evaluate(() => window.cryptoFixture.protectedAccount()),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.storageFailure()),
      { protectedAccount: true, deletionReported: true },
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("the real DuckDB worker loads only local assets and returns exact amounts", async () => {
  const { context, page, external } = await open();
  try {
    assert.deepEqual(await page.evaluate(() => window.cryptoFixture.duck()), {
      id: "9223372036854775807",
      amount: "1234567890.45",
      enabled: true,
    });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("DuckDB worker parameters preserve Unicode, newlines and exact lists of identifiers", async () => {
  const { context, page, external } = await open();
  try {
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.duckLists()),
      {
        fields: ["Fensteröffnung", "line\nbreak", "literal\\n"],
        ids: ["9223372036854775807"],
        empty: [],
      },
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("catalogue rows cross the real worker boundary with UTC microseconds and exact IDs", async () => {
  const { context, page, external } = await open();
  try {
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.catalogueTime()),
      {
        id: "9223372036854775807",
        created: "2026-11-09T11:30:22.123456Z",
        modified: "2026-11-09T11:30:22.654321Z",
        description: "Äußere Fensterlaibung",
      },
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("recovery backup requires three correct words before continuing", async () => {
  const { context, page } = await open();
  try {
    await page
      .getByRole("button", { name: /Sicherung prüfen|Check backup/ })
      .click();
    const fields = page.getByRole("textbox");
    assert.equal(await fields.count(), 3);
    for (const field of await fields.all()) {
      const wordNumber = Number(
        await field.evaluate((el) => el.labels[0].textContent.match(/\d+/)[0]),
      );
      await field.fill(wordNumber === 24 ? "art" : "abandon");
    }
    await page.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await fields.first().fill("wrong-word");
    await page
      .getByRole("button", {
        name: /Mit gesicherter Phrase fortfahren|Continue with backed-up phrase/,
      })
      .click();
    await page
      .getByText(/Die Wörter stimmen nicht|The words do not match/)
      .waitFor();
    assert.equal(await page.getByLabel("Backup confirmed").count(), 0);
    const firstNumber = Number(
      await fields
        .first()
        .evaluate((el) => el.labels[0].textContent.match(/\d+/)[0]),
    );
    await fields.first().fill(firstNumber === 24 ? "art" : "abandon");
    await page
      .getByRole("button", {
        name: /Mit gesicherter Phrase fortfahren|Continue with backed-up phrase/,
      })
      .click();
    await page.getByLabel("Backup confirmed").waitFor();
  } finally {
    await context.close();
  }
});

test("recovery words remain contained on a phone and a desktop", async () => {
  const { context, page } = await open();
  try {
    for (const width of [320, 1365]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const words = page.getByRole("listitem");
      assert.equal(await words.count(), 24);
      assert.equal(
        await words.evaluateAll((nodes) =>
          nodes.every((node) => node.scrollWidth <= node.clientWidth),
        ),
        true,
      );
    }
  } finally {
    await context.close();
  }
});

test("import processing has no close control and ignores Escape and backdrop clicks", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const dialog = page.getByRole("dialog", {
      name: /Dokumente werden eingelesen|Reading documents/,
    });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("button").count(), 0);
    await dialog
      .getByText(/Neuladen oder Schließen|Reloading or closing/)
      .waitFor();
    await page.keyboard.press("Escape");
    await page.mouse.click(3, 3);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      true,
    );
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      false,
    );
  } finally {
    await context.close();
  }
});

test("internal navigation keeps chat work alive while leaving the document cancels it", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Chat starten" }).click();
    await page.getByRole("link", { name: "Andere Seite öffnen" }).click();
    await page.getByRole("heading", { name: "Andere Seite" }).waitFor();
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.llmState()),
      { pending: 1, aborted: false },
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      ),
    );
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.llmState()),
      { pending: 0, aborted: true },
    );
  } finally {
    await context.close();
  }
});

test("the import dialog and operation survive an internal route change", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const progress = page.getByRole("dialog", {
      name: /Dokumente werden eingelesen|Reading documents/,
    });
    await progress.waitFor();
    // The modal blocks pointer navigation; a router change can still arrive
    // through history or application code while the request is in progress.
    await page.locator('a[href="/other"]').evaluate((link) => link.click());
    await page
      .getByRole("heading", { name: "Andere Seite", includeHidden: true })
      .waitFor({ state: "attached" });
    assert.equal(await progress.isVisible(), true);
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.llmState()),
      { pending: 1, aborted: false },
    );
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await progress.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Andere Seite" }).waitFor();
  } finally {
    await context.close();
  }
});

test("cancelling an actual reload keeps the import and its progress dialog alive", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const progress = page.getByRole("dialog", {
      name: /Dokumente werden eingelesen|Reading documents/,
    });
    await progress.waitFor();
    const warning = page.waitForEvent("dialog");
    const reload = page.reload().catch(() => null);
    const dialog = await warning;
    assert.equal(dialog.type(), "beforeunload");
    await dialog.dismiss();
    await reload;
    assert.equal(await progress.isVisible(), true);
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.llmState()),
      { pending: 1, aborted: false },
    );
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await progress.waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
});

test("accepting an actual reload interrupts the import before the new document opens", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    await page
      .getByRole("dialog", {
        name: /Dokumente werden eingelesen|Reading documents/,
      })
      .waitFor();
    await page.evaluate(() =>
      window.addEventListener(
        "pagehide",
        () => {
          // Record only test lifecycle flags, never document contents or keys.
          sessionStorage.setItem(
            "llm-lifetime-check",
            JSON.stringify(window.cryptoFixture.llmState()),
          );
        },
        { once: true },
      ),
    );
    const warning = page.waitForEvent("dialog");
    const reload = page.reload();
    const dialog = await warning;
    assert.equal(dialog.type(), "beforeunload");
    await dialog.accept();
    await reload;
    await page.waitForFunction(() => window.cryptoFixture);
    assert.deepEqual(
      await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("llm-lifetime-check")),
      ),
      { pending: 0, aborted: true },
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
  } finally {
    await context.close();
  }
});

test("remounting the progress host keeps the import alive and a failed import releases the dialog", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showLLM());
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    const dialog = page.getByRole("dialog", {
      name: /Dokumente werden eingelesen|Reading documents/,
    });
    await dialog.waitFor();
    await page.evaluate(() => window.cryptoFixture.remountLLMHost());
    await dialog.waitFor();
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.llmState()),
      { pending: 1, aborted: false },
    );
    await page.evaluate(() => window.cryptoFixture.failLLM());
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      false,
    );
    await page.getByRole("button", { name: "Einlesen starten" }).click();
    await dialog.waitFor();
    await page.evaluate(() => window.cryptoFixture.finishLLM());
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
});

test("spreadsheet import runs in the real browser worker without external requests", async () => {
  const { context, page, external } = await open();
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Material").addRow(["Perlfix", 7.29, "Sack"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const result = await page.evaluate(
      (data) => window.cryptoFixture.spreadsheet(data),
      Array.from(buffer),
    );
    assert.equal(result.originals, 0);
    assert.deepEqual(result.names, ["preisliste.xlsx"]);
    assert.ok(result.text.includes("Perlfix | 7.29 | Sack"));
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("camera EXIF orientation is resolved before the model receives JPEG pixels", async () => {
  const { context, page, external } = await open();
  try {
    const jpeg = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 20;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 40, 20);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg"),
      );
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    // Synthetic APP1 Exif/TIFF entry: orientation=6 (90 degrees clockwise).
    const exif = [
      0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1,
      0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    const oriented = [...jpeg.slice(0, 2), ...exif, ...jpeg.slice(2)];
    const result = await page.evaluate(
      (data) => window.cryptoFixture.orientedPhoto(data),
      oriented,
    );
    assert.deepEqual(result, { width: 20, height: 40, mime: "image/jpeg" });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("private PDF preview resolves local bytes and releases its object URL when closed", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(
      new URL(
        "../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf",
        import.meta.url,
      ),
    );
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.evaluate(
      (data) => window.cryptoFixture.showPrivateFile(data),
      Array.from(bytes),
    );
    const frame = page.frameLocator(
      'iframe[title="PDF ansehen"],iframe[title="View PDF"]',
    );
    await frame.locator(".page").first().waitFor();
    assert.equal(await page.evaluate(() => window.privateFileStats.active), 1);
    assert.equal(
      requests.some(
        (url) =>
          url.includes("sortsys-private:") || url.includes("Vertraulich"),
      ),
      false,
    );
    await page.getByRole("button", { name: "Vorschau schließen" }).click();
    await page.waitForFunction(() => window.privateFileStats.active === 0);
    assert.equal(
      await page.evaluate(() => window.privateFileStats.disposed),
      1,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("new PDF text is extracted locally without OCR or document uploads", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(
      new URL(
        "../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf",
        import.meta.url,
      ),
    );
    const result = await page.evaluate(
      (data) => window.cryptoFixture.inspectFile(data),
      Array.from(bytes),
    );
    assert.ok(result.text.length > 20);
    assert.ok(result.pages > 0);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("document searches reuse one responsive worker after replacement and cancellation", async () => {
  const { context, page, external } = await open();
  try {
    const workers = [];
    page.on("worker", (worker) => workers.push(worker));
    const result = await page.evaluate(() =>
      window.cryptoFixture.documentSearchWorker(),
    );
    assert.equal(result.responsive, true);
    assert.equal(result.aborted, true);
    assert.equal(workers.length, 1);
    assert.equal(result.phraseMatches, 34);
    assert.equal(result.revisedMatches, 0);
    assert.deepEqual(result.afterAbort, ["1"]);
    assert.deepEqual(
      result.ids,
      Array.from({ length: 35 }, (_, index) => String(index)),
    );
    assert.match(result.excerpt.text, /Wände werden gestrichen/);
    const excerpt = page.getByTestId("document-excerpt");
    await excerpt.locator("mark").waitFor();
    assert.equal(await excerpt.locator("mark").textContent(), "Wände");
    assert.equal(await excerpt.locator("img").count(), 0);
    assert.match(await excerpt.textContent(), /<<Abschnitt>> <img src=x/);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("an actual locally extracted PDF is searchable in the document worker without uploads", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(
      new URL(
        "../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf",
        import.meta.url,
      ),
    );
    const { matches } = await page.evaluate(
      (file) => window.cryptoFixture.searchExtractedDocument(file),
      { data: Array.from(bytes), name: "Anlage.pdf", mime: "application/pdf", query: "Materialfreigabe" },
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, "Anlage.pdf");
    assert.ok(matches[0].excerpt.highlights.length > 0);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("uploaded EML and MSG text can be searched locally without network resources", async () => {
  const { context, page, external } = await open();
  try {
    for (const format of ["eml", "msg"]) {
      const bytes = await readFile(
        new URL(`../../../sortsys-api-v2/seed-assets/materialfreigabe.${format}`, import.meta.url),
      );
      const name = `Anlage.${format.toUpperCase()}`;
      const { matches, textMethod } = await page.evaluate(
        (file) => window.cryptoFixture.searchExtractedDocument(file),
        { data: Array.from(bytes), name, mime: "application/octet-stream", query: "Musterfläche" },
      );
      assert.equal(textMethod, `${format}-browser`);
      assert.deepEqual(matches.map(({ id }) => id), [name]);
      assert.match(matches[0].excerpt.text, /die Musterfläche ist freigegeben/);
      assert.ok(matches[0].excerpt.highlights.length > 0);
    }
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("an encrypted EML opens through the browser resource loader with its attachment intact", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(
      new URL(
        "../../../sortsys-api-v2/seed-assets/materialfreigabe.eml",
        import.meta.url,
      ),
    );
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.evaluate(
      (data) => window.cryptoFixture.showPrivateFile(data, "email"),
      Array.from(bytes),
    );
    await page
      .getByRole("heading", { name: "Materialfreigabe - Innenanstrich" })
      .waitFor();
    await page
      .frameLocator('iframe[title="Nachricht"],iframe[title="Message"]')
      .getByText(/die Musterfläche ist freigegeben/)
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", {
          name: /materialfreigabe.pdf.*herunterladen|Download materialfreigabe.pdf/,
        })
        .count(),
      1,
    );
    assert.equal(await page.evaluate(() => window.privateFileStats.reads), 1);
    assert.equal(
      requests.some(
        (url) =>
          url.includes("sortsys-private:") ||
          url.includes("materialfreigabe.eml"),
      ),
      false,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("private PDF pixels disappear on access reset and late leases cannot cross an account switch", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(
      new URL(
        "../../../sortsys-api-v2/seed-assets/materialfreigabe.pdf",
        import.meta.url,
      ),
    );
    await page.evaluate(
      (data) => window.cryptoFixture.showPrivateFile(data),
      Array.from(bytes),
    );
    const frame = () =>
      page.frameLocator('iframe[title="PDF ansehen"],iframe[title="View PDF"]');
    await frame().locator(".page").first().waitFor();
    await page.evaluate(async () => {
      window.cryptoFixture.pausePrivateFiles();
      await window.cryptoFixture.resetPrivateFiles();
    });
    await page.waitForFunction(
      () =>
        window.privateFileStats.pending === 1 &&
        window.privateFileStats.active === 0,
    );
    assert.equal(
      await page
        .locator('iframe[title="PDF ansehen"],iframe[title="View PDF"]')
        .isVisible(),
      false,
    );
    await page.evaluate(() => window.cryptoFixture.switchFileAccount());
    await page.waitForFunction(() => window.privateFileStats.pending === 2);
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    await frame().locator(".page").first().waitFor();
    await page.waitForFunction(
      () =>
        window.privateFileStats.active === 1 &&
        window.privateFileStats.disposed === 2,
    );
    await page.evaluate(async () => {
      window.cryptoFixture.pausePrivateFiles();
      await window.cryptoFixture.lockFileAccount();
    });
    await page.waitForFunction(() => window.privateFileStats.active === 0);
    assert.equal(
      await page
        .locator('iframe[title="PDF ansehen"],iframe[title="View PDF"]')
        .isVisible(),
      false,
    );
    await page.getByRole("button", { name: "Vorschau schließen" }).click();
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    await page.waitForFunction(() => window.privateFileStats.pending === 0);
    assert.equal(await page.evaluate(() => window.privateFileStats.active), 0);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("the project preview download button saves private bytes without navigating to the resource identifier", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = new TextEncoder().encode("Private file preview download");
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.evaluate(
      (data) => window.cryptoFixture.showPrivateFile(data, "download"),
      Array.from(bytes),
    );
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: /^(Herunterladen|Download)$/ })
      .click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), "Vertraulich.bin");
    assert.deepEqual(
      new Uint8Array(await readFile(await download.path())),
      bytes,
    );
    assert.equal(
      requests.some(
        (url) =>
          url.includes("sortsys-private:") || url.includes("Vertraulich.bin"),
      ),
      false,
    );
    assert.equal(await page.evaluate(() => window.privateFileStats.reads), 1);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("an email with identical document identifiers cannot retain the previous account's decoded body", async () => {
  const { context, page, external } = await open();
  try {
    const bytes = await readFile(
      new URL(
        "../../../sortsys-api-v2/seed-assets/materialfreigabe.eml",
        import.meta.url,
      ),
    );
    await page.evaluate(
      (data) => window.cryptoFixture.showPrivateFile(data, "email"),
      Array.from(bytes),
    );
    const oldMail = page.getByRole("heading", {
      name: "Materialfreigabe - Innenanstrich",
    });
    await oldMail.waitFor();
    await page.evaluate(async () => {
      window.cryptoFixture.pausePrivateFiles();
      await window.cryptoFixture.resetPrivateFiles();
    });
    await page.waitForFunction(() => window.privateFileStats.pending === 1);
    assert.equal(await oldMail.count(), 0);
    assert.equal(await page.locator(".attachment-email-body").count(), 0);
    await page.evaluate(async () => {
      window.cryptoFixture.replacePrivateFile(
        Array.from(
          new TextEncoder().encode(
            "From: other@example.test\r\nTo: owner@example.test\r\nSubject: Neuer Mandant\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nNeue vertrauliche Nachricht.",
          ),
        ),
      );
      await window.cryptoFixture.switchFileAccount();
    });
    await page.waitForFunction(() => window.privateFileStats.pending === 2);
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    await page.getByRole("heading", { name: "Neuer Mandant" }).waitFor();
    await page
      .frameLocator('iframe[title="Nachricht"],iframe[title="Message"]')
      .getByText("Neue vertrauliche Nachricht.")
      .waitFor();
    assert.equal(await oldMail.count(), 0);
    await page.evaluate(async () => {
      window.cryptoFixture.pausePrivateFiles();
      await window.cryptoFixture.lockFileAccount();
    });
    await page.waitForFunction(
      () => document.querySelector(".attachment-email-body") === null,
    );
    assert.equal(
      await page.getByRole("heading", { name: "Neuer Mandant" }).count(),
      0,
    );
    await page.getByRole("button", { name: "Vorschau schließen" }).click();
    await page.evaluate(() => window.cryptoFixture.releasePrivateFiles());
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("shared encrypted activity shows original actors and only authorized changed fields", async () => {
  for (const showPrices of [false, true]) {
    const { context, page, external } = await open();
    try {
      await page.evaluate(
        (options) => window.cryptoFixture.showSharedActivity(options),
        { showPrices },
      );
      await page
        .locator(".entity-activity-meta")
        .filter({ hasText: "Erika Altdaten" })
        .waitFor();
      const timeline = page.getByRole("list");
      assert.equal(await timeline.getByRole("listitem").count(), 1);
      const text = await timeline.textContent();
      assert.ok(text.includes("Vorname"));
      assert.equal(text.includes("Stundensatz"), showPrices);
      assert.ok(text.includes("01.02.2026"));
      const wire = await page.evaluate(() =>
        window.cryptoFixture.sharedActivityWire(),
      );
      assert.equal(wire.includes("Erika Altdaten"), false);
      assert.equal(wire.includes("personalization.activity.list"), false);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  }
});

test("timestamp evidence shows pending calendars truthfully and exports the exact signed packet with its OTS proof", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showTimestampEvidence());
    await page
      .getByRole("button", { name: "Zeitnachweis", exact: true })
      .click();
    await page
      .getByText("Beim Kalender eingereicht; Bitcoin-Bestätigung steht aus.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByText("Bitcoin-Zeitnachweis vom", { exact: false })
        .count(),
      0,
    );
    assert.equal(
      await page.getByText("Geheimer Grund", { exact: false }).count(),
      0,
    );
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Nachweise herunterladen", exact: true })
      .click();
    const download = await downloading;
    const { default: JSZip } = await import("jszip"),
      archive = await JSZip.loadAsync(await readFile(await download.path()));
    const packet = await archive
        .file("1/signed-packet.bin")
        .async("uint8array"),
      proof = await archive.file("1/signed-packet.bin.ots").async("uint8array");
    const { createHash } = await import("node:crypto");
    assert.deepEqual(
      Buffer.from(proof.subarray(33, 65)),
      createHash("sha256").update(packet).digest(),
    );
    assert.ok(archive.file("1/target.json"));
    assert.ok(archive.file("1/artifact.json"));
    assert.deepEqual(external, []);
    await page
      .getByRole("dialog", { name: "Zeitnachweis", exact: true })
      .getByRole("button", { name: "Schließen", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
});

test("timestamp evidence for another request cannot appear under the requested title or be downloaded", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showTimestampEvidence({ wrongTarget: true }),
    );
    await page
      .getByRole("button", { name: "Zeitnachweis", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Zeitnachweis",
      exact: true,
    });
    await dialog
      .getByText(
        "Der Nachweis konnte nicht geprüft werden. Der gespeicherte Dokumentstand bleibt unverändert.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await dialog
        .getByText(
          "Beim Kalender eingereicht; Bitcoin-Bestätigung steht aus.",
          { exact: true },
        )
        .count(),
      0,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Nachweise herunterladen", exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("dashboard pins migrate out of plaintext storage, keep keyboard order and survive a view remount through encrypted data", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showDashboardHistory());
    await page.getByRole("heading", { name: "Fixiert", exact: true }).waitFor();
    await page.getByRole("link", { name: /Vertrauliches Dach/ }).waitFor();
    const initial = await page.evaluate(() =>
      window.cryptoFixture.dashboardState(),
    );
    assert.equal(initial.legacy, null);
    assert.equal(initial.pins[0].title, "Vertrauliches Dach");
    assert.ok(!initial.wire.includes("Vertrauliches Dach"));
    assert.ok(!initial.wire.includes("Private Bauhalle"));
    await page
      .getByRole("button", { name: "Auf Dashboard fixieren", exact: true })
      .click();
    const card = page
      .locator(".dashboard-pinned-visits .dashboard-visit-row")
      .filter({ hasText: "Private Bauhalle" });
    await card.waitFor();
    await card.focus();
    await card.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".dashboard-pinned-visits .dashboard-visit-row a")
          ?.getAttribute("href") === "/projects/3",
    );
    await page.evaluate(() => window.cryptoFixture.remountDashboard());
    await page.getByRole("link", { name: /Vertrauliches Dach/ }).waitFor();
    assert.deepEqual(
      (
        await page.evaluate(() => window.cryptoFixture.dashboardState())
      ).pins.map((pin) => pin.path),
      ["/projects/3", "/projects/4"],
    );
    const first = page
        .locator(".dashboard-pinned-visits .dashboard-visit-row")
        .first(),
      last = page
        .locator(".dashboard-pinned-visits .dashboard-visit-row")
        .last(),
      box = await last.boundingBox();
    await first.dragTo(last, {
      targetPosition: { x: box.width - 2, y: box.height / 2 },
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".dashboard-pinned-visits .dashboard-visit-row a")
          ?.getAttribute("href") === "/projects/4",
    );
    assert.deepEqual(
      (
        await page.evaluate(() => window.cryptoFixture.dashboardState())
      ).pins.map((pin) => pin.path),
      ["/projects/4", "/projects/3"],
    );
    assert.equal(
      await page.evaluate(() =>
        Object.values(localStorage).some((value) =>
          value.includes("Vertrauliches Dach"),
        ),
      ),
      false,
    );
    await page.evaluate(() => window.cryptoFixture.lockDashboard());
    await page
      .getByRole("link", { name: /Vertrauliches Dach/ })
      .waitFor({ state: "hidden" });
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("dashboard pin save failure retains the original entry and reports the failure", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showDashboardHistory());
    await page.getByRole("link", { name: /Vertrauliches Dach/ }).waitFor();
    await page.evaluate(() => window.cryptoFixture.dashboardDiscard(true));
    await page
      .getByRole("button", { name: "Fixierung entfernen", exact: true })
      .click();
    await page
      .getByText(
        "Fixierte Einträge konnten nicht geladen oder gespeichert werden.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.getByRole("link", { name: /Vertrauliches Dach/ }).count(),
      1,
    );
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.dashboardState())).pins
        .length,
      1,
    );
  } finally {
    await context.close();
  }
});

for (const readOnly of [false, true]) {
  test(`common-cost form waits for actual rates and respects ${readOnly ? "read-only" : "write"} access`, async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(
        (readOnly) => window.cryptoFixture.showCommonCosts({ readOnly }),
        readOnly,
      );
      await page
        .getByRole("button", { name: "Gemeinkosten öffnen", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      const save = dialog.getByRole("button", {
        name: "Speichern",
        exact: true,
      });
      assert.equal(await save.isDisabled(), true);
      await page.waitForFunction(() => window.cryptoFixture.releaseCommonCosts);
      await page.evaluate(() => window.cryptoFixture.releaseCommonCosts());
      const factors = dialog.getByLabel(/^Relativer Faktor in %/);
      await factors.first().waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("input")].some(
          (input) => input.value === "10",
        ),
      );
      assert.equal(await factors.count(), 3);
      assert.equal(await factors.first().isDisabled(), readOnly);
      assert.equal(await save.isDisabled(), readOnly);
      if (readOnly) {
        assert.deepEqual(
          await page.evaluate(() => window.cryptoFixture.commonCostSaves()),
          [],
        );
      } else {
        await factors.first().fill("25.5");
        await save.click();
        await dialog.waitFor({ state: "hidden" });
        const saves = await page.evaluate(() =>
          window.cryptoFixture.commonCostSaves(),
        );
        assert.equal(saves.length, 1);
        assert.deepEqual(
          saves[0].map((value) => value.type),
          ["fgk", "mgk", "ngk"],
        );
        assert.equal(saves[0][0].relativeFactor, 0.255);
        assert.equal(saves[0][0].constant, 12.5);
        assert.match(saves[0][0].effectiveAt, /^\d{4}-\d{2}-\d{2}$/);
      }
    } finally {
      await context.close();
    }
  });
}

test("an unreadable common-cost history cannot be saved as empty defaults", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showCommonCosts({ fail: true }),
    );
    await page
      .getByRole("button", { name: "Gemeinkosten öffnen", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await page.waitForFunction(() => window.cryptoFixture.releaseCommonCosts);
    await page.evaluate(() => window.cryptoFixture.releaseCommonCosts());
    await dialog
      .getByText("Die Gemeinkosten konnten nicht geladen werden.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await dialog
        .getByRole("button", { name: "Speichern", exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.commonCostSaves()),
      [],
    );
  } finally {
    await context.close();
  }
});

test("project-cost overview displays missing rights without inventing zero amounts", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showCostOverview());
    const hidden = page.getByRole("row", {
      name: /Projekt ohne Kostenfreigabe/,
    });
    await hidden.waitFor();
    assert.equal(await hidden.getByText("–", { exact: true }).count(), 3);
    assert.equal(await hidden.getByText(/0,00\s*€/).count(), 0);
    await hidden
      .getByText("Für die Kostenauswertung fehlen Freigaben: Rechnungswerte.", {
        exact: true,
      })
      .waitFor();
    const available = page.getByRole("row", { name: /Verfügbares Projekt/ });
    await available.getByText(/327,13\s*€/).waitFor();
  } finally {
    await context.close();
  }
});

test("project-cost detail exposes denied access and provides an explicit retry", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showCostDetail());
    await page
      .getByText("Für die Kostenauswertung fehlen Freigaben: Werkzeugkosten.", {
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("button", { name: "Erneut versuchen", exact: true })
      .click();
    assert.deepEqual(
      await page.evaluate(() => window.cryptoFixture.costRetries()),
      ["projects.costs.get"],
    );
  } finally {
    await context.close();
  }
});

test("project-cost detail indicates a pending response instead of an empty view", async () => {
  const { context, page } = await open();
  try {
    await page.evaluate(() =>
      window.cryptoFixture.showCostDetail({ pending: true }),
    );
    await page
      .getByText("Projektkosten werden geladen …", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Erneut versuchen", exact: true })
        .count(),
      0,
    );
  } finally {
    await context.close();
  }
});

test("the user permission dialog edits cryptographic access for its selected member", async () => {
  const { context, page, external } = await open();
  try {
    await page.evaluate(() => window.cryptoFixture.showUserAccess(true));
    await page
      .getByRole("button", { name: "Zugriff bearbeiten", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("heading", { name: "Berechtigungen verwalten", exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "Berechtigungen speichern", exact: true })
      .waitFor();
    assert.equal(
      await dialog.getByRole("combobox", { name: "Benutzerkonto" }).count(),
      0,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Benutzer anlegen", exact: true })
        .count(),
      0,
    );
    await dialog.getByRole("button", { name: /Produktkatalog/ }).click();
    await page
      .getByRole("option", { name: "Lesen und bearbeiten", exact: true })
      .click();
    await waitForClosedListboxes(page);
    await dialog
      .getByRole("button", { name: "Berechtigungen speichern", exact: true })
      .click();
    await page
      .waitForFunction(() => window.cryptoFixture.accessSaves().length === 1)
      .catch(async (error) => {
        const state = await page.evaluate(() =>
          window.cryptoFixture.accessSaves(),
        );
        throw new Error(
          `${error.message}\nDialog: ${await dialog.innerText()}\nSaved policies: ${JSON.stringify(state)}`,
        );
      });
    const [saved] = await page.evaluate(() =>
      window.cryptoFixture.accessSaves(),
    );
    assert.ok(saved.signature);
    assert.ok(
      saved.rules.some(
        (rule) =>
          rule.subject === "user:2" &&
          rule.scope === "catalog:products" &&
          rule.effect === "allow" &&
          rule.actions.includes("update"),
      ),
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});
