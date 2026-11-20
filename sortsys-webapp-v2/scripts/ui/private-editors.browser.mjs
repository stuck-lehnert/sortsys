import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createFixtureServer } from "./browser-support.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

let browser, server, editor, attacker;
const requests = [];

test("a quantity writer edits and prints the actual modal while its unit price remains locked", async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() =>
      window.privateEditorFixture.gaebFinancialPublication({
        quantityWriter: true,
      }),
    );
    await page.waitForFunction(() => window.gaebPublicationModal.ready());
    const quantity = page.locator('[data-gaeb-field$=":Qty"]').first();
    const price = page.locator('[data-gaeb-field$=":UP"]').first();
    assert.equal(await quantity.isDisabled(), false);
    assert.equal(await price.isDisabled(), true);
    await quantity.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("4,125");
    assert.equal(
      await page.evaluate(() => window.gaebPublicationModal.save()),
      true,
    );
    const saved = await page.evaluate(() =>
      window.gaebPublicationModal.calls().at(-1),
    );
    assert.ok(saved.xml.includes("<Qty>4.125</Qty>"));
    assert.ok(saved.xml.includes("<UP>592.375</UP>"));
    assert.ok(saved.xml.includes("<IT>2443.55</IT>"));
    assert.equal(saved.netAmount, "2443.55");
    assert.deepEqual(saved.livePositions, { "contract-quantities": "7" });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Drucken", exact: true }).click();
    const file = await download;
    const path = await file.path();
    assert.ok(path);
    const bytes = Array.from(await readFile(path));
    const printed = await page.evaluate(
      (data) => window.gaebPublicationModal.pdfText(data),
      bytes,
    );
    assert.match(printed.text, /2\.443,55/);
    assert.ok(!printed.text.includes("927461"));
  } finally {
    await context.close();
  }
});

test("an unfinished X84 can be calculated and saved one position at a time in the actual modal", async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() =>
      window.privateEditorFixture.gaebFinancialPublication({
        referenced: true,
        unfinished: true,
      }),
    );
    await page.waitForFunction(() => window.gaebPublicationModal.ready());
    const prices = page.locator('[data-gaeb-field$=":UP"]');
    await prices.first().waitFor({ state: "attached" });
    assert.equal(await prices.count(), 2);
    assert.equal(await prices.first().isDisabled(), false);
    assert.equal(await prices.nth(1).isDisabled(), false);
    assert.equal(await prices.first().textContent(), "");
    const print = page.getByRole("button", { name: "Drucken", exact: true });
    assert.equal(await print.isDisabled(), true);

    await prices.first().focus();
    await page.keyboard.insertText("600");
    assert.equal(
      await page.evaluate(() => window.gaebPublicationModal.save()),
      true,
    );
    const intermediate = await page.evaluate(() =>
      window.gaebPublicationModal.calls().at(-1),
    );
    assert.equal(intermediate.netAmount, null);
    assert.ok(intermediate.xml.includes("<UP>600.000</UP>"));
    assert.ok(!intermediate.xml.includes("<Qty>"));
    assert.equal(await print.isDisabled(), true);

    await prices.nth(1).focus();
    await page.keyboard.insertText("700");
    await page.waitForFunction(() =>
      window.gaebPublicationModal
        .calls()
        .some((call) => call.netAmount === "4062.50"),
    );
    const completed = await page.evaluate(() =>
      window.gaebPublicationModal.calls().at(-1),
    );
    assert.equal(completed.netAmount, "4062.50");
    assert.ok(completed.xml.includes("<UP>700.000</UP>"));
    assert.ok(!completed.xml.includes("Unbekannte Herstellerangabe 927461"));
    assert.equal(
      await page.evaluate(
        () => window.gaebPublicationModal.revisions().at(-1).netAmount,
      ),
      "4062.50",
    );
    assert.equal(await print.isDisabled(), false);
    const downloaded = page.waitForEvent("download");
    await print.click();
    const file = await downloaded;
    const path = await file.path();
    assert.ok(path);
    const printed = await page.evaluate(
      (bytes) => window.gaebPublicationModal.pdfText(bytes),
      Array.from(await readFile(path)),
    );
    assert.match(printed.text, /4\.062,50/);
    assert.ok(!printed.text.includes("927461"));
  } finally {
    await context.close();
  }
});

test("an unchanged RSA-signed X84 opens read-only and prints in the actual modal", async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() =>
      window.privateEditorFixture.gaebSignedPublication(),
    );
    await page.waitForFunction(() => window.gaebPublicationModal.ready());
    const print = page.getByRole("button", { name: "Drucken", exact: true });
    assert.equal(await print.isDisabled(), false);
    const downloaded = page.waitForEvent("download");
    await print.click();
    const file = await downloaded;
    const path = await file.path();
    assert.ok(path);
    const printed = await page.evaluate(
      (bytes) => window.gaebPublicationModal.pdfText(bytes),
      Array.from(await readFile(path)),
    );
    assert.ok(printed.text.includes("Fensterlaibungen verputzen"));
    assert.match(printed.text, /30,00/);
    assert.deepEqual(
      await page.evaluate(() => window.gaebPublicationModal.calls()),
      [],
    );
  } finally {
    await context.close();
  }
});

for (const referenced of [false, true]) {
  test(`the actual GAEB modal prices and prints ${referenced ? "separately shared X83" : "native"} quantities without opening opaque extensions`, async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/private-editors.html`);
      await page.waitForFunction(() => window.privateEditorFixture);
      await page.evaluate(
        (referenced) =>
          window.privateEditorFixture.gaebFinancialPublication({ referenced }),
        referenced,
      );
      await page.locator("canvas").first().waitFor({ state: "visible" });
      await page.waitForFunction(() => window.gaebPublicationModal.ready());
      const price = page.locator('[data-gaeb-field$=":UP"]').first();
      const quantity = page.locator('[data-gaeb-field$=":Qty"]').first();
      assert.equal(await price.isDisabled(), false);
      assert.equal(await quantity.isDisabled(), true);
      assert.equal(
        await page
          .getByRole("button", { name: "Drucken", exact: true })
          .isDisabled(),
        false,
      );
      await price.focus();
      await page.keyboard.press("Control+a");
      await page.keyboard.insertText("600");
      assert.equal(
        await page.evaluate(() => window.gaebPublicationModal.save()),
        true,
      );
      const calls = await page.evaluate(() =>
        window.gaebPublicationModal.calls(),
      );
      const saved = calls.at(-1);
      assert.ok(saved.xml.includes("600.000"));
      assert.ok(saved.xml.includes("1875.00"));
      if (referenced) {
        assert.ok(
          !saved.xml.includes("<Qty>"),
          "Borrowed quantities must not be copied into a read-only facet",
        );
      }
      assert.ok(!saved.xml.includes("Unbekannte Herstellerangabe 927461"));
      assert.equal(saved.netAmount, "1875.00");
      assert.deepEqual(saved.livePositions, { "offer-prices": "7" });
      assert.equal(
        await page.evaluate(
          () => window.gaebPublicationModal.revisions().at(-1).netAmount,
        ),
        "1875.00",
      );
      assert.equal(
        await page.locator(".gaeb-editor").getAttribute("data-schema-state"),
        "partial",
      );
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Drucken", exact: true }).click();
      const download = await downloading;
      const bytes = await readFile(await download.path());
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      const artifactDirectory = process.env.SORTSYS_PARTIAL_PRINT_PDF_DIR;
      const document = await page.evaluate(
        ({ bytes, render }) =>
          window.gaebPublicationModal.pdfText(bytes, render),
        { bytes: [...bytes], render: Boolean(artifactDirectory) },
      );
      assert.equal(document.pages, 1);
      assert.ok(
        document.text.includes("Fassadenbeschichtung im Innenhof 843167"),
      );
      assert.ok(document.text.includes("Schulsanierung Nordflügel"));
      assert.match(document.text, /1[.\s]?875,00/);
      assert.ok(!document.text.includes("Unbekannte Herstellerangabe"));
      if (artifactDirectory) {
        await mkdir(artifactDirectory, { recursive: true });
        const name = referenced ? "angebot-x84" : "auftrag-x86";
        await writeFile(join(artifactDirectory, `${name}.pdf`), bytes);
        await writeFile(
          join(artifactDirectory, `${name}.png`),
          Buffer.from(document.png, "base64"),
        );
      }
    } finally {
      await context.close();
    }
  });
}

for (const image of ["missing", "readable"]) {
  test(`the actual GAEB modal ${image === "missing" ? "blocks a print with an unread image" : "allows printing with an attachment grant"}`, async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/private-editors.html`);
      await page.waitForFunction(() => window.privateEditorFixture);
      await page.evaluate(
        (image) =>
          window.privateEditorFixture.gaebFinancialPublication({ image }),
        image,
      );
      await page.locator("canvas").first().waitFor({ state: "visible" });
      assert.equal(
        await page
          .getByRole("button", { name: "Drucken", exact: true })
          .isDisabled(),
        image === "missing",
      );
      if (image === "readable") {
        const downloading = page.waitForEvent("download");
        await page
          .getByRole("button", { name: "Drucken", exact: true })
          .click();
        const bytes = await readFile(await (await downloading).path());
        const artifactDirectory = process.env.SORTSYS_PARTIAL_PRINT_PDF_DIR;
        const printed = await page.evaluate(
          ({ bytes, render }) =>
            window.gaebPublicationModal.pdfText(bytes, render),
          { bytes: [...bytes], render: Boolean(artifactDirectory) },
        );
        assert.equal(printed.pages, 1);
        assert.equal(printed.images, 1);
        assert.ok(printed.text.includes("Schulsanierung Nordflügel"));
        if (artifactDirectory) {
          await writeFile(
            join(artifactDirectory, "native-image.png"),
            Buffer.from(printed.png, "base64"),
          );
        }
      }
    } finally {
      await context.close();
    }
  });
}
test("the actual GAEB modal edits a partial text view without sending invented amounts or enabling print", async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() =>
      window.privateEditorFixture.gaebPartialPublication(),
    );
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.gaebPublicationModal.ready());
    assert.equal(
      await page
        .getByRole("button", { name: "Drucken", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page.locator('[data-gaeb-field="document:title"]').isDisabled(),
      true,
    );
    assert.equal(
      await page
        .locator('[data-gaeb-field$=":UP"], [data-gaeb-field$=":Qty"]')
        .count(),
      0,
    );
    const field = page.locator('[data-gaeb-field$=":text:0"]').first();
    await field.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(
      "Positionstext im tatsächlichen Dialog überarbeitet",
    );
    assert.equal(
      await page.evaluate(() => window.gaebPublicationModal.save()),
      true,
    );
    const calls = await page.evaluate(() =>
      window.gaebPublicationModal.calls(),
    );
    assert.ok(calls.length > 0);
    const saved = calls.at(-1);
    assert.ok(
      saved.xml.includes("Positionstext im tatsächlichen Dialog überarbeitet"),
    );
    assert.ok(!saved.xml.includes("592.375"));
    assert.ok(!saved.xml.includes("3.125"));
    assert.equal(saved.netAmount, undefined);
    assert.deepEqual(saved.livePositions, { scope: "7" });
    assert.equal(
      await page.evaluate(
        () => window.gaebPublicationModal.revisions().at(-1).netAmount,
      ),
      null,
    );
    assert.equal(
      await page.locator(".gaeb-editor").getAttribute("data-schema-state"),
      "partial",
    );
    await page.evaluate(() => window.gaebPublicationModal.draft());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() => window.gaebPublicationModal.finalize());
    await page.getByText("Dokument abgeschlossen", { exact: true }).waitFor();
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Entwurf herunterladen", exact: true })
      .click();
    const download = await downloading;
    assert.ok(download.suggestedFilename().endsWith(".teilansicht.json"));
    const draft = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.equal(draft.format, "sortsys-gaeb-view-draft-v2");
    assert.equal(draft.document, "commercial:2:3");
    assert.ok(draft.base.includes("Positionstext im tatsächlichen Dialog überarbeitet"));
    assert.ok(draft.source.includes("Ungespeicherter Entwurf 821947"));
    assert.ok(!`${draft.base}${draft.source}`.includes("592.375"));
    await page.getByRole("tab", { name: "Einfügen", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Teilentwurf öffnen" }).count(), 0);

    await page.reload();
    await page.waitForFunction(() => window.privateEditorFixture);
    const newerText = "Leistungsbeschreibung aus der neuen Fassung";
    await page.evaluate(
      (description) => window.privateEditorFixture.gaebPartialPublication({ description }),
      newerText,
    );
    await page.waitForFunction(() => window.gaebPublicationModal.ready());
    await page.getByRole("tab", { name: "Einfügen", exact: true }).click();
    const input = page.getByLabel("GAEB-Teilentwurf", { exact: true });
    const dialog = page.getByRole("dialog", { name: "Teilentwurf zusammenführen" });
    async function selectDraft(value) {
      await input.setInputFiles({
        name: "Auftrag.x86.teilansicht.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(value)),
      });
    }
    await selectDraft({ ...draft, document: "commercial:2:4" });
    await page.getByText("Die Datei ist kein Teilentwurf für dieses Dokument.", { exact: true }).waitFor();
    assert.equal(await dialog.count(), 0);

    await selectDraft({
      ...draft,
      source: draft.source.replace("</Description>", "</Description><UP>999.000</UP>"),
    });
    await dialog.getByRole("button", { name: "Zusammenführen", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Dokumentrechten" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.gaebPublicationModal.calls()), []);
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();

    await selectDraft({
      ...draft,
      source: draft.source.replace(
        "Positionstext im tatsächlichen Dialog überarbeitet",
        "Vollständig anderer Positionstext im Entwurf",
      ),
    });
    await dialog.getByRole("button", { name: "Zusammenführen", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "überschneidet" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.gaebPublicationModal.calls()), []);
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();

    await selectDraft(draft);
    await dialog.getByRole("button", { name: "Zusammenführen", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.gaebPublicationModal.calls().length > 0);
    const restored = await page.evaluate(() => window.gaebPublicationModal.calls().at(-1).xml);
    assert.ok(restored.includes("Ungespeicherter Entwurf 821947"));
    assert.ok(restored.includes(newerText));
    assert.ok(!restored.includes("592.375"));
  } finally {
    await context.close();
  }
});
test("the actual GAEB modal confirms unchanged live state and retains a conflicting draft when finalized", async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() => window.privateEditorFixture.gaebPublication());
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.gaebPublicationModal.ready());
    assert.equal(
      await page.evaluate(() => window.gaebPublicationModal.save()),
      true,
    );
    const calls = await page.evaluate(() =>
      window.gaebPublicationModal.calls(),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].livePositions, { scope: "7" });
    await page.evaluate(() =>
      window.gaebPublicationModal.rejectSharedMessage(),
    );
    await page
      .getByText(
        "Eine nicht prüfbare gemeinsame Änderung wurde verworfen. Die übrigen Änderungen bleiben bearbeitbar.",
        { exact: true },
      )
      .waitFor();
    await page.evaluate(() => window.gaebPublicationModal.draft());
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() => window.gaebPublicationModal.finalize());
    await page.getByText("Dokument abgeschlossen", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.gaebPublicationModal.exactNative()),
      true,
    );
    const ready = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Entwurf herunterladen", exact: true })
      .click();
    const download = await ready;
    const draft = await readFile(await download.path(), "utf8");
    assert.ok(draft.includes("Ungespeicherter Entwurf 821947"));
    await page.evaluate(() => window.gaebPublicationModal.requestClose());
    await page.getByText("Lokalen Entwurf sichern", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Zurück zum Dokument", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => window.gaebPublicationModal.save()),
      true,
    );
    assert.equal(
      (await page.evaluate(() => window.gaebPublicationModal.calls())).length,
      1,
    );
  } finally {
    await context.close();
  }
});
test("the actual adoption form prepares native and legacy contracts entirely in the browser", async () => {
  const context = await browser.newContext(),
    page = await context.newPage(),
    external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin) {
      return route.continue();
    }
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() => window.privateEditorFixture.contractAdoption());
    let count = 0;
    async function submit(name, bytes, normalized) {
      await page.locator('input[type="file"]').first().setInputFiles({
        name,
        mimeType: "application/octet-stream",
        buffer: bytes,
      });
      await page.getByText(normalized, { exact: true }).waitFor();
      await page.locator('button[type="submit"]').click();
      count++;
      await page.waitForFunction(
        (count) => window.contractAdoptionFixture.snapshot().count === count,
        count,
      );
      return page.evaluate(
        () => window.contractAdoptionFixture.snapshot().input,
      );
    }
    for (const phase of ["84", "85", "86", "87"]) {
      const xml = await page.evaluate(
        (phase) => window.contractAdoptionFixture.xml(phase),
        phase,
      );
      const input = await submit(
        `Original.x${phase}`,
        Buffer.from(xml),
        `Original.x${phase}`,
      );
      assert.equal(input.sourcePhase, phase);
      assert.equal(input.sourceXml, xml);
      assert.equal(input.netAmount, "1776.00");
      assert.equal(input.offerXml === null, phase === "84");
      if (input.offerXml) assert.match(input.offerXml, /DA84/);
    }
    const original = await readFile(
      new URL(
        "../../../sortsys-gaeb/scripts/fixtures/legacy/anfrage.d83",
        import.meta.url,
      ),
    );
    const records = original.toString("latin1").trimEnd().split(/\r?\n/);
    records[0] = records[0].slice(0, 10) + "84" + records[0].slice(12);
    const price = Array(80).fill(" ");
    for (const [offset, text] of [
      [0, "23"],
      [2, "01010010A"],
      [12, "00000012340"],
      [24, "000000015425"],
    ]) {
      for (let i = 0; i < text.length; i++) price[offset + i] = text[i];
    }
    records.splice(9, 0, price.join(""));
    const d84 = Buffer.from(
      records
        .map(
          (row, i) =>
            row.slice(0, 74).padEnd(74, " ") + String(i + 1).padStart(6, "0"),
        )
        .join("\r\n"),
      "latin1",
    );
    const p83 = await readFile(
      new URL(
        "../../../sortsys-gaeb/scripts/fixtures/legacy/anfrage.p83",
        import.meta.url,
      ),
      "utf8",
    );
    const p84 = Buffer.from(
      p83
        .replace("[DP]83[end]", "[DP]84[end]")
        .replace("[ME]m²[end]", "[ME]m²[end][EP]12,340[end][GB]154,25[end]"),
    );
    for (const phase of ["84", "85", "86", "87"]) {
      for (const kind of ["d", "p"]) {
        const source =
          kind === "d"
            ? Buffer.from(
                d84.toString("latin1").slice(0, 10) +
                  phase +
                  d84.toString("latin1").slice(12),
                "latin1",
              )
            : Buffer.from(
                p84.toString().replace("[DP]84[end]", `[DP]${phase}[end]`),
              );
        const input = await submit(
          `Altauftrag${kind}.${kind}${phase}`,
          source,
          `Altauftrag${kind}.x${phase}`,
        );
        assert.equal(input.sourcePhase, phase);
        assert.equal(input.sourceFileName, `Altauftrag${kind}.x${phase}`);
        assert.equal(input.netAmount, "154.25");
        assert.equal(input.offerXml === null, phase === "84");
        if (phase === "84") {
          assert.ok(input.referenceXml);
          assert.match(input.referenceXml, /DA83/);
        }
        assert.ok(input.sourceXml.includes(source.toString("base64")));
      }
    }
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});
test("the commercial ribbon downloads private native XML locally and blocks a late download after access reset", async () => {
  const context = await browser.newContext({ acceptDownloads: true }),
    page = await context.newPage(),
    urls = [],
    downloads = [];
  try {
    page.on("request", (request) => urls.push(request.url()));
    page.on("download", (download) => downloads.push(download));
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() => window.privateEditorFixture.commercialDownload());
    const button = page.getByRole("button", {
      name: "Herunterladen",
      exact: true,
    });
    await button.waitFor();
    const caseReads = () =>
      page.evaluate(
        () =>
          window.privateGaebDownload
            .snapshot()
            .paths.filter((path) => path === "commercial.cases.get").length,
      );
    const initialReads = await caseReads();
    const ready = page.waitForEvent("download");
    await button.click();
    const downloaded = await ready;
    assert.equal(downloaded.suggestedFilename(), "Vertrauliches Angebot.x84");
    const content = await readFile(await downloaded.path(), "utf8"),
      state = await page.evaluate(() => window.privateGaebDownload.snapshot());
    assert.equal(content, state.xml);
    assert.equal(state.reads, 1);
    assert.equal(state.paths.includes("commercial.documents.download"), false);
    assert.equal(await caseReads(), initialReads);
    assert.equal(
      urls.some((url) => url.startsWith("sortsys-private-gaeb:")),
      false,
    );
    await page.evaluate(() => window.privateGaebDownload.pause());
    await button.click();
    await page.waitForFunction(
      () => window.privateGaebDownload.snapshot().reads === 2,
    );
    await page.evaluate(() => window.privateGaebDownload.revoke());
    await page.evaluate(() => window.privateGaebDownload.release());
    await page.waitForTimeout(200);
    assert.equal(downloads.length, 1);
  } finally {
    await context.close();
  }
});
test("the actual GAEB dialog removes its old canvas when access is reset and cannot reopen denied content", async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() => window.privateEditorFixture.gaeb());
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.evaluate(() => window.revokePrivateGaeb());
    await page.waitForFunction(
      () => document.querySelectorAll("canvas").length === 0,
    );
    await page
      .getByText("Die Datei konnte nicht geöffnet werden.", { exact: true })
      .waitFor();
    assert.equal(await page.locator("canvas").count(), 0);
  } finally {
    await context.close();
  }
});
test("GAEB XML is separated and losslessly reconstructed by the actual browser WASM worker", async () => {
  const context = await browser.newContext(),
    page = await context.newPage(),
    urls = [];
  try {
    page.on("request", (request) => urls.push(request.url()));
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    const result = await page.evaluate(() =>
      window.privateEditorFixture.gaebPartition(),
    );
    assert.equal(result.exact, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.validation, { valid: true, invalid: false });
    assert.equal(result.scope.includes("592.00"), false);
    assert.equal(result.scope.includes("9876.54"), false);
    assert.equal(result.partial.complete, false);
    assert.ok(result.partial.xml.includes("2.500"));
    assert.equal(result.partial.xml.includes("592.00"), false);
    assert.equal(result.partial.xml.includes("9876.54"), false);
    assert.equal(
      urls.some(
        (url) =>
          !url.startsWith(server.origin) &&
          !url.startsWith("blob:") &&
          !url.startsWith("data:"),
      ),
      false,
    );
  } finally {
    await context.close();
  }
});
// Implements the upstream integration protocol, with an explicit boot hook so
// unrelated windows can be tested before the legitimate editor announces itself.
const editorHtml = `<!doctype html><script>
window.state={sessionRequests:0,start:null,acks:[],exports:[]};
window.boot=()=>parent.postMessage({q:'INTEGRATION_READY'},'*');
window.command=(q,data)=>parent.postMessage({msg:{q,data},txid:crypto.randomUUID()},'*');
addEventListener('message',async event=>{
 const p=event.data;if(p.ack){state.acks.push(p);return;}
 if(p.msg?.q==='GET_SESSION'){
  state.sessionRequests++;
  parent.postMessage({ack:p.txid,args:{key:p.msg.data.key||'new-edit-capability',viewKey:'view-capability'}},event.origin);
 }
 if(p.msg?.q==='START'){
  state.start={...p.msg.data,document:await p.msg.data.document.text()};
  parent.postMessage({ack:p.txid,args:{}},event.origin);
  command('DOCUMENT_READY');
 }
 if(p.msg?.q==='DOWNLOAD_AS')state.exports.push(p.msg.data);
});</script>`;
async function serveEditor() {
  const http = createServer((req, res) => {
    requests.push({ url: req.url, method: req.method });
    res.setHeader("Content-Type", "text/html");
    res.end(editorHtml);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${http.address().port}`,
    close: () => new Promise((resolve) => http.close(resolve)),
  };
}
before(async () => {
  server = await createFixtureServer();
  editor = await serveEditor();
  attacker = await serveEditor();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await editor?.close();
  await attacker?.close();
  await server?.close();
});
async function open(canEdit = true, key, application = "doc") {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.origin}/private-editors.html`);
  await page.waitForFunction(() => window.privateEditorFixture);
  await page.evaluate(
    ({ origin, canEdit, key, application }) =>
      window.privateEditorFixture.open(origin, canEdit, key, application),
    { origin: editor.origin, canEdit, key, application },
  );
  const frame = await (
    await page.locator("#private-office").elementHandle()
  ).contentFrame();
  await frame.waitForFunction(() => window.boot);
  return { context, page, frame };
}

const protectedFrame = (page) =>
  page.getByTitle(/^(Dokumenteditor|Document editor)$/);

async function openProtectedFrame(page) {
  const target = protectedFrame(page);
  await target.waitFor({ state: "attached" });
  const frame = await (await target.elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.boot);
  await frame.evaluate(() => window.boot());
  await target.waitFor({ state: "visible" });
  return frame;
}

async function nextPaint(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

test("the private editor rejects other windows and commits capabilities before sharing the document", async () => {
  const { context, page, frame } = await open();
  try {
    for (const origin of [attacker.origin, editor.origin]) {
      await page.evaluate((origin) => {
        const frame = document.createElement("iframe");
        frame.src = `${origin}/rogue`;
        frame.id = "rogue";
        document.body.append(frame);
      }, origin);
      const rogue = await (
        await page.locator("#rogue").elementHandle()
      ).contentFrame();
      await rogue.waitForFunction(() => window.boot);
      await rogue.evaluate(() => window.boot());
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(await frame.evaluate(() => window.state.sessionRequests), 0);
      await page.locator("#rogue").evaluate((node) => node.remove());
    }
    await frame.evaluate(() => {
      window.boot();
      window.boot();
    });
    await page.waitForFunction(
      () => window.privateEditorFixture.state.published === 1,
    );
    assert.equal(await frame.evaluate(() => window.state.start), null);
    await page.evaluate(() => window.privateEditorFixture.publish());
    await page.waitForFunction(
      () => window.privateEditorFixture.state.ready === 1,
    );
    const start = await frame.evaluate(() => window.state.start);
    assert.equal(start.document, "private browser document");
    assert.equal(start.url, undefined);
    assert.equal(start.editorConfig.callbackUrl, undefined);
    assert.equal(start.readOnly, false);
    assert.equal(start.autosave, 10);
    assert.equal(start._config.sortsysPersistentRoom, true);
    await frame.evaluate(() =>
      window.command("SAVE", new Blob(["changed private document"])),
    );
    await page.waitForFunction(
      () => window.privateEditorFixture.state.saved.length === 1,
    );
    assert.deepEqual(
      await page.evaluate(() => window.privateEditorFixture.state.saved),
      ["changed private document"],
    );
    assert.ok(
      requests.every(
        (req) =>
          req.method === "GET" &&
          !/capability|document|callback|ooapidl|oosave/.test(req.url),
      ),
    );
  } finally {
    await context.close();
  }
});

test("an independent read-only Office preview follows the confirmed file version", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(
      (origin) =>
        window.privateEditorFixture.protected(origin, false, { readOnly: true }),
      editor.origin,
    );

    const original = await openProtectedFrame(page);
    assert.deepEqual(
      await original.evaluate(() => ({
        readOnly: window.state.start.readOnly,
        document: window.state.start.document,
      })),
      { readOnly: true, document: "private browser document" },
    );
    await page.evaluate(() =>
      window.replaceConfirmedPrivateOfficeFile("Confirmed replacement"),
    );
    await page.waitForFunction(
      () => window.privateOfficeLoads.length === 2,
      undefined,
      { timeout: 4000 },
    );
    assert.equal(original.isDetached(), true);
    const reader = await openProtectedFrame(page);
    assert.deepEqual(
      await reader.evaluate(() => ({
        readOnly: window.state.start.readOnly,
        document: window.state.start.document,
      })),
      { readOnly: true, document: "Confirmed replacement" },
    );
    assert.equal(
      await page.evaluate(() => window.privateEditorFixture.state.published),
      0,
    );
  } finally {
    await context.close();
  }
});

test("a read-only CryptPad session cannot invoke saving or publish an editing capability", async () => {
  const { context, page, frame } = await open(false, "view-capability");
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(
      () => window.privateEditorFixture.state.ready === 1,
    );
    assert.equal(await frame.evaluate(() => window.state.start.readOnly), true);
    assert.equal(
      await page.evaluate(() => window.privateEditorFixture.state.published),
      0,
    );
    await frame.evaluate(() =>
      window.command("SAVE", new Blob(["unauthorized"])),
    );
    await frame.waitForFunction(() =>
      window.state.acks.some((ack) => ack.args?.error === "SAVE_REJECTED"),
    );
    assert.deepEqual(
      await page.evaluate(() => window.privateEditorFixture.state.saved),
      [],
    );
    await page.evaluate(() => window.privateEditorFixture.close());
    assert.equal(
      await page.locator("#private-office").getAttribute("src"),
      "about:blank",
    );
  } finally {
    await context.close();
  }
});

test("a reader can open an unshared copy before an editor initializes the shared session", async () => {
  const { context, page, frame } = await open(false);
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(
      () => window.privateEditorFixture.state.ready === 1,
    );
    assert.equal(await frame.evaluate(() => window.state.start.readOnly), true);
    assert.equal(
      await frame.evaluate(() => window.state.start.autosave),
      false,
    );
    assert.equal(
      await frame.evaluate(
        () => window.state.start._config.sortsysPersistentRoom,
      ),
      false,
    );
    assert.equal(
      await page.evaluate(() => window.privateEditorFixture.state.published),
      0,
    );
    await frame.evaluate(() =>
      window.command("SAVE", new Blob(["unauthorized clone"])),
    );
    await frame.waitForFunction(() =>
      window.state.acks.some((ack) => ack.args?.error === "SAVE_REJECTED"),
    );
    assert.deepEqual(
      await page.evaluate(() => window.privateEditorFixture.state.saved),
      [],
    );
  } finally {
    await context.close();
  }
});

test("a read-only diagram room exports its native XML without publishing or saving a session", async () => {
  const { context, page, frame } = await open(
    false,
    "view-capability",
    "diagram",
  );
  const xml = '<mxfile><diagram id="floor-plan" name="Erdgeschoss"/></mxfile>';
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(
      () => window.privateEditorFixture.state.ready === 1,
    );
    const start = await frame.evaluate(() => window.state.start);
    assert.equal(start.application, "diagram");
    assert.equal(start.name, "Private.drawio");
    assert.equal(start.readOnly, true);
    await page.evaluate(() => {
      window.exportResult = null;
      window.privateEditorFixture
        .export("drawio")
        .then((blob) => blob.text())
        .then((value) => {
          window.exportResult = value;
        });
    });
    await frame.waitForFunction(() => window.state.exports[0] === "drawio");
    await frame.evaluate(
      (xml) =>
        window.command(
          "ON_DOWNLOADAS",
          new Blob([xml], { type: "application/x-drawio" }),
        ),
      xml,
    );
    await page.waitForFunction((xml) => window.exportResult === xml, xml);
    const state = await page.evaluate(() => window.privateEditorFixture.state);
    assert.equal(state.published, 0);
    assert.deepEqual(state.saved, []);
    assert.equal(state.errors, 0);
  } finally {
    await context.close();
  }
});

test("a requested browser export accepts only the expected frame and rejects overlapping or late replies", async () => {
  const { context, page, frame } = await open(false, "view-capability");
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(
      () => window.privateEditorFixture.state.ready === 1,
    );
    await page.evaluate(() => {
      window.exportResult = null;
      window.privateEditorFixture
        .export("docx")
        .then((blob) => blob.text())
        .then((value) => (window.exportResult = value));
    });
    await frame.waitForFunction(() => window.state.exports.length === 1);
    assert.equal(
      await page.evaluate(() =>
        window.privateEditorFixture.export("pdf").then(
          () => false,
          () => true,
        ),
      ),
      true,
    );
    await page.evaluate(() =>
      window.postMessage(
        {
          msg: { q: "ON_DOWNLOADAS", data: new Blob(["wrong window"]) },
          txid: "fake",
        },
        location.origin,
      ),
    );
    assert.equal(await page.evaluate(() => window.exportResult), null);
    await frame.evaluate(() =>
      window.command("ON_DOWNLOADAS", new Blob(["local converted export"])),
    );
    await page.waitForFunction(
      () => window.exportResult === "local converted export",
    );
    await frame.evaluate(() =>
      window.command("ON_DOWNLOADAS", new Blob(["late export"])),
    );
    await frame.waitForFunction(() =>
      window.state.acks.some(
        (ack) => ack.args?.error === "EXPORT_NOT_REQUESTED",
      ),
    );
    await page.evaluate(() => {
      window.exportResult = null;
      window.privateEditorFixture.export("pdf").then(
        () => (window.exportResult = "unexpected"),
        () => (window.exportResult = "cancelled"),
      );
      window.privateEditorFixture.close();
    });
    await page.waitForFunction(() => window.exportResult === "cancelled");
    assert.deepEqual(
      await page.evaluate(() => window.privateEditorFixture.state.saved),
      [],
    );
  } finally {
    await context.close();
  }
});

test("the normal Excel export opens local bytes, downloads the browser conversion and removes the frame on account reset", async () => {
  const context = await browser.newContext(),
    page = await context.newPage();
  const uploads = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") uploads.push(request.url());
  });
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(
      (origin) => window.privateEditorFixture.exportExcel(origin),
      editor.origin,
    );
    const locate = () =>
      page.locator('iframe[title="Excel-Export"],iframe[title="Excel export"]');
    const frame = await (await locate().elementHandle()).contentFrame();
    await frame.waitForFunction(() => window.boot);
    await frame.evaluate(() => window.boot());
    await frame.waitForFunction(() => window.state.start !== null);
    assert.equal(
      await frame.evaluate(() => window.state.start.document),
      "private generated workbook",
    );
    assert.equal(
      await frame.evaluate(() => window.state.start.application),
      "sheet",
    );
    assert.equal(
      await frame.evaluate(
        () => window.state.start._config.sortsysPersistentRoom,
      ),
      false,
    );
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: /Herunterladen|Download/, exact: true })
      .click();
    await frame.waitForFunction(() => window.state.exports[0] === "xlsx");
    await frame.evaluate(() =>
      window.command("ON_DOWNLOADAS", new Blob(["edited browser workbook"])),
    );
    const file = await download,
      stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(file.suggestedFilename(), "Projekt.xlsx");
    assert.equal(Buffer.concat(chunks).toString(), "edited browser workbook");
    assert.deepEqual(await page.evaluate(() => window.exportQueries), [
      "zerotrust.editors.config",
    ]);
    assert.deepEqual(uploads, []);
    await page.evaluate(() => window.resetExportContext());
    await locate().waitFor({ state: "detached" });
    assert.equal(frame.isDetached(), true);
  } finally {
    await context.close();
  }
});

test("a failed conversion cannot supply a late result to a later export request", async () => {
  const { context, page, frame } = await open(false, "view-capability");
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(
      () => window.privateEditorFixture.state.ready === 1,
    );
    await page.evaluate(() => {
      window.exportResult = null;
      window.privateEditorFixture.export("docx").then(
        () => (window.exportResult = "unexpected"),
        () => (window.exportResult = "failed"),
      );
    });
    await frame.waitForFunction(() => window.state.exports.length === 1);
    await frame.evaluate(() => window.command("DOCUMENT_ERROR", "X2T_ERROR"));
    await page.waitForFunction(() => window.exportResult === "failed");
    assert.equal(
      await page.evaluate(() =>
        window.privateEditorFixture.export("pdf").then(
          () => false,
          () => true,
        ),
      ),
      true,
    );
    await frame.evaluate(() =>
      window.command("ON_DOWNLOADAS", new Blob(["old conversion"])),
    );
    await frame.waitForFunction(() =>
      window.state.acks.some(
        (ack) => ack.args?.error === "EXPORT_NOT_REQUESTED",
      ),
    );
    assert.equal(await page.evaluate(() => window.exportResult), "failed");
    assert.equal(
      await page.evaluate(() => window.privateEditorFixture.state.errors),
      1,
    );
  } finally {
    await context.close();
  }
});

for (const fileName of ["Private.docx", "Plan.drawio"]) {
  test(`${fileName}: the protected component previews a fixed shared draft before its explicit transfer`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/private-editors.html`);
      await page.waitForFunction(() => window.privateEditorFixture);
      await page.evaluate(
        ({ origin, fileName }) =>
          window.privateEditorFixture.protected(origin, true, { fileName }),
        { origin: editor.origin, fileName },
      );
      const source = page.locator(
        'iframe[title="Bearbeitungsstand wird übernommen"],iframe[title="Recovering document draft"]',
      );
      await source.waitFor({ state: "attached" });
      const recovery = await (await source.elementHandle()).contentFrame();
      await recovery.waitForFunction(() => window.boot);
      await recovery.evaluate(() => window.boot());
      await recovery.waitForFunction(
        (format) => window.state.exports.includes(format),
        fileName.endsWith(".drawio") ? "drawio" : "docx",
      );
      assert.equal(
        await recovery.evaluate(() => window.state.start.readOnly),
        true,
      );
      assert.equal(
        await recovery.evaluate(() => window.state.start.key),
        "view-capability",
      );
      assert.equal(
        await page.evaluate(() => window.privateEditorFixture.state.published),
        0,
      );
      await recovery.evaluate(() =>
        window.command(
          "ON_DOWNLOADAS",
          new Blob(["shared draft before key replacement"]),
        ),
      );
      const target = page.locator(
        'iframe[title="Dokumenteditor"],iframe[title="Document editor"]',
      );
      await target.waitFor({ state: "attached" });
      const preview = await (await target.elementHandle()).contentFrame();
      await preview.waitForFunction(() => window.boot);
      await preview.evaluate(() => window.boot());
      await target.waitFor({ state: "visible" });
      assert.equal(
        await preview.evaluate(() => window.state.start.readOnly),
        true,
      );
      assert.equal(
        await preview.evaluate(() => window.state.start.key),
        "new-edit-capability",
      );
      assert.equal(
        await preview.evaluate(() => window.state.start.document),
        "shared draft before key replacement",
      );
      assert.equal(
        await page.evaluate(() => window.privateEditorFixture.state.published),
        0,
      );
      const reviewBanner = page.getByRole("region", {
        name: /Bearbeitungsstand prüfen|Review document draft/,
      });
      const bannerBounds = await reviewBanner.boundingBox();
      const previewBounds = await target.boundingBox();
      assert.ok(bannerBounds && previewBounds);
      assert.ok(
        previewBounds.y >= bannerBounds.y + bannerBounds.height - 1,
        "Review actions must not cover the document preview",
      );
      assert.ok(previewBounds.height > 200);
      await page.screenshot({
        path: "/tmp/sortsys-office-draft-review.png",
        fullPage: true,
      });
      await page
        .getByRole("button", {
          name: /Bearbeitungsstand übernehmen|Use editing draft/,
        })
        .click();
      await page.waitForFunction(
        () => window.privateEditorFixture.state.ready >= 2,
      );
      await target.waitFor({ state: "attached" });
      const replacement = await (await target.elementHandle()).contentFrame();
      await replacement.waitForFunction(() => window.boot);
      await replacement.evaluate(() => window.boot());
      await target.waitFor({ state: "visible" });
      assert.equal(recovery.isDetached(), true);
      assert.equal(preview.isDetached(), true);
      assert.equal(
        await replacement.evaluate(() => window.state.start.document),
        "shared draft before key replacement",
      );
      assert.equal(
        await replacement.evaluate(() => window.state.start.readOnly),
        false,
      );
      assert.deepEqual(
        await page.evaluate(() => window.privateEditorFixture.state.recovered),
        [
          {
            text: "shared draft before key replacement",
            epoch: "old-office-room",
            version: "1",
          },
        ],
      );
    } finally {
      await context.close();
    }
  });

  test(`${fileName}: an unavailable shared draft requires an explicit choice before using the confirmed file`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/private-editors.html`);
      await page.waitForFunction(() => window.privateEditorFixture);
      await page.evaluate(
        ({ origin, fileName }) =>
          window.privateEditorFixture.protected(origin, true, { fileName }),
        { origin: editor.origin, fileName },
      );
      const source = page.locator(
        'iframe[title="Bearbeitungsstand wird übernommen"],iframe[title="Recovering document draft"]',
      );
      await source.waitFor({ state: "attached" });
      const recovery = await (await source.elementHandle()).contentFrame();
      await recovery.waitForFunction(() => window.boot);
      await recovery.evaluate(() => window.boot());
      await recovery.waitForFunction(
        (format) => window.state.exports.includes(format),
        fileName.endsWith(".drawio") ? "drawio" : "docx",
      );
      await recovery.evaluate(() => window.command("DOCUMENT_ERROR", {}));
      const fallback = page.getByRole("button", {
        name: /Gespeicherten Dateistand öffnen|Open saved file/,
      });
      await fallback.waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(() => window.privateEditorFixture.state.published),
        0,
      );
      await fallback.click();
      const replacement = await openProtectedFrame(page);
      assert.equal(
        await replacement.evaluate(() => window.state.start.document),
        "private browser document",
      );
      assert.equal(
        await page.evaluate(
          () => window.privateEditorFixture.state.recovered[0].text,
        ),
        "private browser document",
      );
    } finally {
      await context.close();
    }
  });

  test(`${fileName}: the protected component removes the old iframe on a rights reset and opens only the new view capability`, async () => {
    const context = await browser.newContext(),
      page = await context.newPage();
    try {
      await page.goto(`${server.origin}/private-editors.html`);
      await page.waitForFunction(() => window.privateEditorFixture);
      await page.evaluate(
        ({ origin, fileName }) =>
          window.privateEditorFixture.protected(origin, false, { fileName }),
        { origin: editor.origin, fileName },
      );
      const first = await openProtectedFrame(page);
      assert.equal(await first.evaluate(() => window.state.start.readOnly), false);
      await first.evaluate(() => window.command("SAVE", new Blob(["Unbound file"])));
      await first.waitForFunction(() =>
        window.state.acks.some((ack) => ack.args?.error === "SAVE_REJECTED"),
      );
      await first.evaluate(() => window.command("SAVE_VERSION"));
      const prepared = await first.waitForFunction(() =>
        window.state.acks.find((ack) => ack.args?.version)?.args.version,
      );
      assert.equal(await prepared.jsonValue(), "1");
      await first.evaluate(() =>
        window.command("SAVE", {
          blob: new Blob(["actual component save"]),
          version: window.state.acks.find((ack) => ack.args?.version).args.version,
        }),
      );
      await page.waitForFunction(
        () => window.privateEditorFixture.state.saved.length === 1,
      );
      await page.evaluate(() => window.downgradePrivateOffice());
      await page.waitForFunction(
        () => window.privateEditorFixture.state.ready >= 2,
      );
      assert.equal(first.isDetached(), true);
      const second = await openProtectedFrame(page);
      assert.deepEqual(
        await second.evaluate(() => ({
          key: window.state.start.key,
          readOnly: window.state.start.readOnly,
        })),
        { key: "view-capability", readOnly: true },
      );
      assert.equal(
        await page.evaluate(() => window.privateEditorFixture.state.published),
        1,
      );
      await second.evaluate(() =>
        window.command("SAVE", new Blob(["denied after downgrade"])),
      );
      await second.waitForFunction(() =>
        window.state.acks.some((ack) => ack.args?.error === "SAVE_REJECTED"),
      );
      assert.deepEqual(
        await page.evaluate(() => window.privateEditorFixture.state.saved),
        ["actual component save"],
      );
    } finally {
      await context.close();
    }
  });

  for (const reset of ["revoke", "switch-back"]) {
    test(`${fileName}: a late first load cannot replace the ${reset} session`, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`${server.origin}/private-editors.html`);
        await page.waitForFunction(() => window.privateEditorFixture);
        await page.evaluate(
          ({ origin, fileName }) =>
            window.privateEditorFixture.protected(origin, false, {
              fileName,
              holdFirstLoad: true,
            }),
          { origin: editor.origin, fileName },
        );
        await page.waitForFunction(
          () => window.privateOfficeLoads.length === 1,
        );
        if (reset === "revoke") {
          await page.evaluate(() => window.denyPrivateOffice());
          await page
            .locator('.project-files-office-status[role="alert"]')
            .waitFor();
          await page.evaluate(() => window.releasePrivateOfficeLoad());
          await nextPaint(page);
          assert.equal(await protectedFrame(page).count(), 0);
          assert.equal(
            await page.evaluate(
              () => window.privateEditorFixture.state.published,
            ),
            0,
          );
        } else {
          await page.evaluate(() => window.switchPrivateOfficeFile("6"));
          const intermediate = await openProtectedFrame(page);
          assert.equal(
            await intermediate.evaluate(() => window.state.start.document),
            "Private document 6",
          );
          await page.evaluate(() => window.switchPrivateOfficeFile("5"));
          await page.waitForFunction(
            () => window.privateOfficeLoads.length === 3,
          );
          const current = await openProtectedFrame(page);
          await page.evaluate(() => window.releasePrivateOfficeLoad());
          await nextPaint(page);
          assert.equal(intermediate.isDetached(), true);
          assert.equal(current.isDetached(), false);
          assert.equal(await protectedFrame(page).count(), 1);
          assert.equal(
            await current.evaluate(() => window.state.start.document),
            "private browser document",
          );
          assert.equal(
            await current.evaluate(() => window.state.start.application),
            fileName.endsWith(".drawio") ? "diagram" : "doc",
          );
        }
        assert.deepEqual(
          await page.evaluate(() => window.privateEditorFixture.state.saved),
          [],
        );
      } finally {
        await context.close();
      }
    });
  }
}
