import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, resolve, sep, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
let server, browser, base;
async function focusEditableField(field) {
  await field.and(field.page().locator(":enabled")).waitFor();
  await field.focus();
}
async function createSection(page, name, nested = false) {
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  if (!nested)
    await outline
      .getByRole("button", { name: "Gesamtes Dokument", exact: true })
      .click();
  await outline
    .getByRole("button", { name: "Neuer Titel", exact: true })
    .click();
  const input = outline.getByRole("textbox", {
    name: "Titelbezeichnung",
    exact: true,
  });
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "hidden" });
}
async function entryAction(page, label, action) {
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  await outline.getByText(label, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
before(async () => {
  server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      if (!file.startsWith(root.endsWith(sep) ? root : root + sep))
        throw new Error("outside-root");
      response.setHeader(
        "Content-Type",
        types[extname(file)] ?? "application/octet-stream",
      );
      response.end(await readFile(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SORTSYS_BROWSER_EXECUTABLE || undefined,
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test(
  "Typst exports real paginated PDF with editable organization header, footer and table style",
  { timeout: 60000 },
  async () => {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (message) => logs.push(message.text()));
    await page.goto(base);
    const result = await page
      .evaluate(async () => {
        const {
          GaebDocument,
          createGaebXml,
          DEFAULT_GAEB_TEMPLATE,
          buildGaebTypst,
          compileTypst,
        } = await import("/editor.js");
        let doc = new GaebDocument(
          createGaebXml("86", "PDF print"),
          "print.x86",
        );
        doc = new GaebDocument(doc.addItem(), doc.fileName);
        doc = new GaebDocument(
          doc.setRichText(
            doc.items[0],
            0,
            "Leistung mit Umlauten: Dämmung & Montage",
          ),
          doc.fileName,
        );
        doc = new GaebDocument(
          doc.setValue(doc.items[0], "Qty", "3.000"),
          doc.fileName,
        );
        doc = new GaebDocument(
          doc.setValue(doc.items[0], "UP", "592.000"),
          doc.fileName,
        );
        const template = DEFAULT_GAEB_TEMPLATE.replace(
          "#text(size: 9pt)[#data.sender.name]",
          "#text(size: 9pt)[KOPFZEILE #data.sender.name]",
        )
          .replace("[Seite ]", "[FUSSZEILE ]")
          .replace("#d5d7db", "#336699");
        const source = buildGaebTypst(
          doc.source,
          doc.fileName,
          "de",
          undefined,
          { template, sender: { name: "Testbau GmbH" } },
        );
        const pdf = await compileTypst(source);
        let binary = "";
        for (let offset = 0; offset < pdf.length; offset += 8192)
          binary += String.fromCharCode(...pdf.subarray(offset, offset + 8192));
        return { pdf: btoa(binary), source };
      })
      .catch((error) => {
        throw new Error(`${error.message}\n${logs.join("\n")}`);
      });
    const bytes = Buffer.from(result.pdf, "base64");
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert.ok(bytes.length > 1000);
    const output =
      process.env.SORTSYS_UI_SCREENSHOTS ?? "/tmp/sortsys-typst-native";
    await mkdir(output, { recursive: true });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(output, "print.pdf"), bytes),
    );
    await page.close();
  },
);

test("Tab and Shift+Tab select individual paragraphs and typing replaces only that paragraph", async () => {
  const page = await browser.newPage();
  const input = await keyboardDocument(page);
  await input.fill("Kurztext\nErster Absatz\nZweiter Absatz");
  await input.press("Control+s");
  await page.locator('[data-save-state="saved"]').waitFor();
  const title = page.getByRole("button", {
    name: "Bezeichnung",
    exact: true,
  });
  await focusEditableField(title);
  await page.keyboard.press("Tab");
  assert.equal(await input.getAttribute("aria-label"), "Bauvorhaben");
  await page.keyboard.press("Tab");
  const selected = () =>
    input.evaluate((node) =>
      node.value.slice(node.selectionStart, node.selectionEnd),
    );
  assert.equal(await selected(), "Kurztext");
  await input.press("Tab");
  assert.equal(await selected(), "Erster Absatz");
  await input.press("Tab");
  assert.equal(await selected(), "Zweiter Absatz");
  await input.press("Tab");
  assert.equal(await input.getAttribute("aria-label"), "Menge");
  await input.press("Shift+Tab");
  assert.equal(await selected(), "Zweiter Absatz");
  await page.keyboard.type("Neuer Schluss");
  assert.equal(
    await input.inputValue(),
    "Kurztext\nErster Absatz\nNeuer Schluss",
  );
  await input.press("Shift+Tab");
  assert.equal(await selected(), "Erster Absatz");
  await input.press("Shift+Tab");
  assert.equal(await selected(), "Kurztext");
  await input.fill("\nErster\n\nLetzter");
  await input.press("Control+Home");
  await input.press("Tab");
  assert.equal(await selected(), "Erster");
  await input.press("Shift+Tab");
  assert.deepEqual(
    await input.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [0, 0],
  );
  await input.press("Tab");
  await input.press("Tab");
  assert.deepEqual(
    await input.evaluate((node) => [node.selectionStart, node.selectionEnd]),
    [8, 8],
  );
  await input.press("Tab");
  assert.equal(await selected(), "Letzter");
  await page.close();
});

test(
  "editor shortcuts add items and groups, delete with undo/redo and override Ctrl+P with real Typst PDF",
  { timeout: 60000 },
  async () => {
    const page = await browser.newPage();
    await page.goto(base);
    await page
      .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
      .click();
    const editor = page.locator(".gaeb-editor");
    await editor.focus();
    await page.keyboard.press("Control+Enter");
    const input = page.locator("textarea.gaeb-canvas-input");
    await input.fill("Shortcut-Position");
    await input.press("Control+Shift+Enter");
    const name = page.getByRole("textbox", {
      name: "Titelbezeichnung",
      exact: true,
    });
    await name.fill("Shortcut-Gruppe");
    await name.press("Enter");
    const outline = page.getByRole("navigation", {
      name: "Dokumentgliederung",
      exact: true,
    });
    await outline.getByText("Shortcut-Position", { exact: true }).click();
    await page.keyboard.press("Control+Alt+Backspace");
    const removal = outline.getByRole("form", {
      name: "Eintrag löschen",
      exact: true,
    });
    await removal.getByRole("button", { name: "Löschen", exact: true }).click();
    assert.equal(
      await outline.getByText("Shortcut-Position", { exact: true }).count(),
      0,
    );
    await page.locator('[data-save-state="saved"]').waitFor();
    await page.keyboard.press("Control+z");
    await outline.getByText("Shortcut-Position", { exact: true }).waitFor();
    await page.locator('[data-save-state="saved"]').waitFor();
    await page.keyboard.press("Control+y");
    assert.equal(
      await outline.getByText("Shortcut-Position", { exact: true }).count(),
      0,
    );
    await page.locator('[data-save-state="saved"]').waitFor();
    await page.keyboard.press("Control+z");
    await outline.getByText("Shortcut-Position", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.__nativePrints = 0;
      window.print = () => window.__nativePrints++;
    });
    const download = page.waitForEvent("download");
    await editor.focus();
    await page.keyboard.press("Control+p");
    const file = await download;
    assert.match(file.suggestedFilename(), /\.pdf$/i);
    assert.equal(
      (await readFile(await file.path())).subarray(0, 5).toString(),
      "%PDF-",
    );
    assert.equal(await page.evaluate(() => window.__nativePrints), 0);
    assert.equal(await page.locator(".gaeb-ribbon-group-label").count(), 0);
    assert.equal(await page.locator(".gaeb-status").count(), 0);
    const button = page.getByRole("button", {
      name: "Position hinzufügen",
      exact: true,
    });
    await button.hover();
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole("tooltip").count(), 0);
    const gap = await button
      .locator("span")
      .evaluate(
        (node) =>
          node.closest(".gaeb-ribbon-panel").getBoundingClientRect().bottom -
          node.getBoundingClientRect().bottom,
      );
    assert.ok(gap >= 8, `Caption has ${gap}px of bottom space`);
    await page.close();
  },
);

test("outline width resizes by pointer and keyboard, survives reopening and stays full-width on mobile", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  const create = () =>
    page
      .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
      .click();
  await create();
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const separator = page.getByRole("separator", {
    name: "Breite der Gliederung",
    exact: true,
  });
  await separator.waitFor();
  const initial = await outline.boundingBox(),
    handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 130, handle.y + 100, {
    steps: 12,
  });
  await page.mouse.up();
  await page.waitForFunction(
    (width) =>
      Math.round(
        document.querySelector(".gaeb-outline").getBoundingClientRect().width,
      ) === width,
    Math.round(initial.width + 130),
  );
  await separator.focus();
  await separator.press("ArrowLeft");
  assert.equal(
    Number(await separator.getAttribute("aria-valuenow")),
    Math.round(initial.width + 120),
  );
  await separator.press("Home");
  assert.equal(Math.round((await outline.boundingBox()).width), 200);
  await separator.press("End");
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("sortsys-gaeb:view") ?? "{}")
        .outlineWidth === 600,
  );
  await page.getByRole("button", { name: "Schließen", exact: true }).click();
  await create();
  assert.equal(Math.round((await outline.boundingBox()).width), 600);
  assert.equal(await page.locator(".gaeb-file-details").count(), 0);
  assert.equal(
    await page.getByText("Dateidetails", { exact: true }).count(),
    0,
  );
  await separator.dblclick();
  assert.equal(Math.round((await outline.boundingBox()).width), 320);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForFunction(
    () =>
      document.querySelector(".gaeb-outline").getBoundingClientRect().width >
      380,
  );
  assert.equal(await separator.isVisible(), false);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.close();
});

test("embedded attachment downloads stay available under Insert without a file-details footer", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    return new GaebDocument(
      createGaebXml("31", "Aufmaß"),
      "Aufmaß.x31",
    ).addAttachment("plan.pdf", "pdf", btoa("%PDF-1.7\nexample"));
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "Aufmaß.x31",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await page.getByRole("tab", { name: "Einfügen", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "plan.pdf", exact: true }).click();
  assert.equal(
    await readFile(await (await downloaded).path(), "utf8"),
    "%PDF-1.7\nexample",
  );
  assert.equal(
    await page.getByText("Dateidetails", { exact: true }).count(),
    0,
  );
  await page.close();
});

test("ribbon tabs group real commands, retain text selection and support keyboard navigation and collapsing", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("Text zum Formatieren");
  await input.press("Control+a");
  await page.getByRole("tab", { name: "Ansicht", exact: true }).click();
  const fields = page.getByRole("button", {
    name: "Eingabefelder anzeigen",
    exact: true,
  });
  await fields.click();
  assert.equal(await fields.getAttribute("aria-pressed"), "false");
  await page.getByRole("tab", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Fett", exact: true }).click();
  assert.equal(await input.inputValue(), "Text zum Formatieren");
  assert.equal(
    await page
      .getByRole("button", { name: "Fett", exact: true })
      .getAttribute("aria-pressed"),
    "false",
    "The selected default-bold text can still be formatted after switching tabs",
  );
  await page.getByRole("tab", { name: "Einfügen", exact: true }).click();
  await page
    .getByRole("button", { name: "Titel hinzufügen", exact: true })
    .click();
  const name = page.getByRole("textbox", {
    name: "Titelbezeichnung",
    exact: true,
  });
  await name.fill("Neuer Titel");
  await name.press("Enter");
  await page
    .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
    .waitFor();
  await page
    .getByRole("button", { name: "Menüband einklappen", exact: true })
    .click();
  assert.equal(await page.getByRole("tabpanel").count(), 0);
  assert.equal(
    await page.getByRole("tab", { name: "Prüfen", exact: true }).count(),
    0,
  );
  await page.getByRole("tab", { name: "Ansicht", exact: true }).click();
  await page.getByRole("tabpanel", { name: "Ansicht", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Ansicht", exact: true }).press("Home");
  await page.getByRole("tabpanel", { name: "Start", exact: true }).waitFor();
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(
        process.env.SORTSYS_UI_SCREENSHOTS,
        "office-ribbon-desktop.png",
      ),
    });
  await page.close();
});

for (const scenario of [
  { phase: "83", density: 1, zoom: 100 },
  { phase: "86", density: 2, zoom: 175 },
])
  test(`rapid typing reuses static rows and retains every character: X${scenario.phase}, DPR ${scenario.density}, ${scenario.zoom}%`, async (t) => {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
      deviceScaleFactor: scenario.density,
    });
    await page.goto(base);
    const xml = await page.evaluate(async ({ phase }) => {
      const { GaebDocument, createGaebXml } = await import("/editor.js");
      let source = createGaebXml(phase, "Typing performance");
      for (let index = 0; index < 70; index++) {
        let model = new GaebDocument(source, `Performance.x${phase}`);
        model = new GaebDocument(model.addItem(), model.fileName);
        source = model.setRichGroupText(
          model.items.at(-1),
          0,
          `${index === 69 ? "InvisibleSentinel" : `Position ${index}`}\n${"Unveränderte Leistungsbeschreibung mit mehreren Wörtern. ".repeat(24)}`,
        );
      }
      return source;
    }, scenario);
    await page.locator('input[type="file"]').setInputFiles({
      name: `Performance.x${scenario.phase}`,
      mimeType: "application/xml",
      buffer: Buffer.from(xml),
    });
    const zoom = page.getByRole("textbox", {
      name: "Zoom in Prozent",
      exact: true,
    });
    await zoom.fill(String(scenario.zoom));
    await zoom.press("Enter");
    await page.waitForFunction(
      (scale) =>
        document.querySelector(".gaeb-canvas-tile canvas")?.width ===
        Math.ceil(794 * scale * window.devicePixelRatio),
      scenario.zoom / 100,
    );
    await focusEditableField(
      page.locator('[data-gaeb-field$=":text:0"]').first(),
    );
    await page
      .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
      .waitFor();
    const input = page.locator("textarea.gaeb-canvas-input");
    await input.press("End");
    const before = await input.inputValue();
    const offset = await input.evaluate((node) => node.selectionStart);
    const typed = "abcdefghijklmnop".repeat(5);
    const profiler = process.env.SORTSYS_TYPING_PROFILE
      ? await page.context().newCDPSession(page)
      : null;
    if (profiler) {
      await profiler.send("Profiler.enable");
      await profiler.send("Profiler.setSamplingInterval", { interval: 500 });
      await profiler.send("Profiler.start");
    }
    await page.evaluate(() => {
      window.__typing = {
        measures: 0,
        distantDraws: 0,
        frames: [],
        latencies: [],
        pendingInput: null,
        inputEvents: 0,
        started: performance.now(),
        running: true,
        previous: performance.now(),
      };
      document.querySelector("textarea.gaeb-canvas-input").addEventListener(
        "input",
        () => {
          window.__typing.pendingInput ??= performance.now();
          window.__typing.inputEvents++;
        },
        true,
      );
      const fill = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function (...args) {
        const result = fill.apply(this, args);
        const state = window.__typing;
        if (
          state.running &&
          state.pendingInput !== null &&
          this.fillStyle === "#005fcc"
        ) {
          state.latencies.push(performance.now() - state.pendingInput);
          state.pendingInput = null;
        }
        return result;
      };
      const measure = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function (...args) {
        window.__typing.measures++;
        return measure.apply(this, args);
      };
      const draw = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (value, ...args) {
        if (value === "InvisibleSentinel") window.__typing.distantDraws++;
        return draw.call(this, value, ...args);
      };
      const frame = (now) => {
        const state = window.__typing;
        if (!state.running) return;
        state.frames.push(now - state.previous);
        state.previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await input.pressSequentially(typed, { delay: 4 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const work = await page.evaluate(() => {
      window.__typing.running = false;
      return {
        ...window.__typing,
        elapsed: performance.now() - window.__typing.started,
      };
    });
    if (profiler) {
      const { profile } = await profiler.send("Profiler.stop");
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(
          `${process.env.SORTSYS_TYPING_PROFILE}.${scenario.phase}`,
          JSON.stringify(profile),
        ),
      );
    }
    const expected = before.slice(0, offset) + typed + before.slice(offset);
    assert.equal(
      await input.inputValue(),
      expected,
      "Rapid input retains every character",
    );
    assert.equal(work.inputEvents, typed.length);
    assert.ok(
      work.latencies.length > 0,
      "Input reaches the visible canvas during typing",
    );
    assert.equal(
      work.distantDraws,
      0,
      "Typing never paints text far outside a tile",
    );
    assert.ok(
      work.measures < 600,
      `Unchanged positions are not reshaped per key (${work.measures} native measurements)`,
    );
    t.diagnostic(
      JSON.stringify({
        nativeMeasurements: work.measures,
        elapsedMs: Math.round(work.elapsed),
        p95InputToCanvasMs: Math.round(
          [...work.latencies].sort((a, b) => a - b)[
            Math.floor(work.latencies.length * 0.95)
          ],
        ),
        frames: work.frames.length,
        medianFrameMs: Math.round(
          [...work.frames].sort((a, b) => a - b)[
            Math.floor(work.frames.length / 2)
          ],
        ),
        p95FrameMs: Math.round(
          [...work.frames].sort((a, b) => a - b)[
            Math.floor(work.frames.length * 0.95)
          ],
        ),
        maxFrameMs: Math.round(Math.max(...work.frames)),
      }),
    );
    await input.press("Control+s");
    await page.locator('[data-save-state="saved"]').waitFor();
    await page.reload();
    await focusEditableField(
      page.locator('[data-gaeb-field$=":text:0"]').first(),
    );
    assert.equal(
      await input.inputValue(),
      expected,
      "The complete rapid input survives autosave and reopening",
    );
    await page.close();
  });

test("cached rows match a fresh layout after wrapping text and widening price columns", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.addInitScript(() => {
    window.__rowDraws = new WeakMap();
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      window.__rowDraws.set(this.canvas, []);
      return clear.apply(this, args);
    };
    const draw = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      x,
      y,
      ...args
    ) {
      window.__rowDraws.get(this.canvas)?.push({ text, x, y, font: this.font });
      return draw.call(this, text, x, y, ...args);
    };
  });
  await page.goto(base);
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    let model = new GaebDocument(
      createGaebXml("86", "Layout cache"),
      "cache.x86",
    );
    for (const title of [
      "Erste Leistung",
      "Zweite Leistung",
      "Dritte Leistung",
    ]) {
      model = new GaebDocument(model.addItem(), model.fileName);
      model = new GaebDocument(
        model.setRichGroupText(
          model.items.at(-1),
          0,
          title + "\nBeschreibung der Leistung",
        ),
        model.fileName,
      );
    }
    return model.source;
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "cache.x86",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  const texts = page.locator('[data-gaeb-field$=":text:0"]');
  await texts.first().waitFor();
  const secondBefore = await texts.nth(1).boundingBox();
  await focusEditableField(texts.first());
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill(
    "Erste Leistung\n" +
      "Zusätzliche Beschreibung mit mehreren Zeilen. ".repeat(10),
  );
  assert.ok(
    (await texts.nth(1).boundingBox()).y > secondBefore.y + 30,
    "Following cached rows move with the growing description",
  );
  const snapshot = () =>
    page.evaluate(() => {
      window.dispatchEvent(new Event("beforeprint"));
      const draws = [
        ...document.querySelectorAll(".gaeb-canvas-tile canvas"),
      ].map((canvas) => window.__rowDraws.get(canvas));
      window.dispatchEvent(new Event("afterprint"));
      return draws;
    });
  const textDraft = await snapshot();
  await input.press("Control+s");
  await page.locator('[data-save-state="saved"]').waitFor();
  assert.deepEqual(
    await snapshot(),
    textDraft,
    "Cached row placement equals the fresh committed XML layout",
  );
  const prices = page.locator('[data-gaeb-field$=":UP"]');
  const quantity = page.locator('[data-gaeb-field$=":Qty"]').nth(1);
  const quantityBefore = await quantity.boundingBox();
  await focusEditableField(prices.first());
  await input.fill("1234567.000");
  assert.ok(
    (await quantity.boundingBox()).x < quantityBefore.x,
    "Growing a price repositions the other cached rows' columns before committing",
  );
  const priceDraft = await snapshot();
  await input.press("Control+s");
  await page.locator('[data-save-state="saved"]').waitFor();
  assert.deepEqual(
    await snapshot(),
    priceDraft,
    "Column changes invalidate every affected row",
  );
  await focusEditableField(texts.nth(1));
  assert.equal(
    await input.inputValue(),
    "Zweite Leistung\nBeschreibung der Leistung",
    "Reused semantic fields retain the correct row content",
  );
  await page.close();
});

test("zoom gestures reuse their bitmap and rerasterize sharply after settling, with six-pixel paragraph spacing", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.addInitScript(() => {
    window.__paragraphY = {};
    const draw = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      value,
      x,
      y,
      ...rest
    ) {
      if (["AbsatzEins", "AbsatzZwei"].includes(value))
        window.__paragraphY[value] = y;
      return draw.call(this, value, x, y, ...rest);
    };
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  for (let index = 0; index < 6; index++) {
    await page
      .getByRole("button", { name: "Position hinzufügen", exact: true })
      .click();
    await page
      .locator("textarea.gaeb-canvas-input")
      .fill(
        index
          ? `Position ${index}\n${"Längerer Positionstext mit mehreren Worten. ".repeat(30)}`
          : "Kurztext\nAbsatzEins\nAbsatzZwei",
      );
  }
  await page.getByRole("button", { name: "Menge", exact: true }).last().focus();
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page
    .locator(".gaeb-document-scroll")
    .evaluate((node) => (node.scrollTop = 0));
  await page.waitForFunction(
    () =>
      window.__paragraphY.AbsatzZwei - window.__paragraphY.AbsatzEins === 24,
  );
  const zoomInput = page.getByRole("textbox", { name: /Zoom/ });
  await zoomInput.fill("100");
  await zoomInput.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector(".gaeb-canvas-tile canvas").width ===
      Math.ceil(794 * window.devicePixelRatio),
  );
  const before = await page.evaluate(() => {
    const target = document.querySelector(".gaeb-canvas-tile canvas");
    window.__zoomPaints = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas === target) window.__zoomPaints++;
      return clear.apply(this, args);
    };
    return target.width;
  });
  await page.evaluate(async () => {
    const scroll = document.querySelector(".gaeb-document-scroll"),
      box = scroll.getBoundingClientRect();
    for (let step = 0; step < 12; step++) {
      scroll.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -8,
          clientX: box.left + 250,
          clientY: box.top + 150,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  assert.equal(
    await page.evaluate(() => window.__zoomPaints),
    0,
    "Wheel frames do not redraw the document bitmap",
  );
  assert.equal(
    await page
      .locator(".gaeb-canvas-tile canvas")
      .first()
      .evaluate((node) => node.width),
    before,
  );
  await page.waitForFunction(() => window.__zoomPaints > 0);
  assert.ok(
    (await page
      .locator(".gaeb-canvas-tile canvas")
      .first()
      .evaluate((node) => node.width)) > before,
    "The final bitmap uses the actual zoom resolution",
  );
  await page.close();
});

test("double click selects a word and triple click selects the complete paragraph", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  const first = "Alpha beta gamma";
  const second = "A wrapped paragraph with several words. ".repeat(12).trim();
  const xml = await page.evaluate(
    async ({ first, second }) => {
      const { GaebDocument, createGaebXml } = await import("/editor.js");
      return new GaebDocument(
        createGaebXml("83", "Click selection"),
        "Click.x83",
      )
        .addItem()
        .replace(
          /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
          `<p><span>${first}</span></p><p><span>${second}</span></p>`,
        );
    },
    { first, second },
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "Click.x83",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  const field = page.locator('[data-gaeb-field$=":text:0"]').first();
  await field.waitFor();
  const box = await field.boundingBox();
  const input = page.locator("textarea.gaeb-canvas-input");
  const selected = () =>
    input.evaluate((node) =>
      node.value.slice(node.selectionStart, node.selectionEnd),
    );
  await page.mouse.click(box.x + 12, box.y + 5, { clickCount: 2 });
  assert.equal(await selected(), "Alpha");
  await page.evaluate(() => {
    window.__gaebSelectionFrames = { running: true, collapsed: 0, frames: 0 };
    const sample = () => {
      const watch = window.__gaebSelectionFrames;
      if (!watch.running) return;
      const node = document.querySelector("textarea.gaeb-canvas-input");
      watch.frames++;
      if (node.selectionStart === node.selectionEnd) watch.collapsed++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.down({ clickCount: 3 });
  assert.equal(
    await selected(),
    first + "\n",
    "The paragraph is selected before mouse-up",
  );
  await page.waitForFunction(() => window.__gaebSelectionFrames.frames >= 3);
  await page.mouse.move(box.x + 13, box.y + 5);
  assert.equal(
    await selected(),
    first + "\n",
    "Pointer jitter preserves paragraph selection",
  );
  await page.mouse.move(box.x + 100, box.y + 55);
  assert.equal(
    await selected(),
    first + "\n" + second,
    "Dragging extends by whole paragraphs",
  );
  await page.mouse.move(box.x + 12, box.y + 5);
  await page.mouse.up({ clickCount: 3 });
  assert.equal(await selected(), first + "\n");
  const collapsedFrames = await page.evaluate(() => {
    window.__gaebSelectionFrames.running = false;
    return window.__gaebSelectionFrames.collapsed;
  });
  assert.equal(
    collapsedFrames,
    0,
    "Multi-click selection never flashes a collapsed caret between frames",
  );
  // Clicking the middle of a wrapped paragraph selects all its visual lines,
  // without also selecting the preceding paragraph in the same input buffer.
  await page.mouse.click(box.x + 100, box.y + 55, { clickCount: 3 });
  assert.equal(await selected(), second);
  await input.press("Control+c");
  await input.press("ArrowLeft");
  assert.equal(
    await input.evaluate((node) => node.selectionStart),
    first.length + 1,
  );
  await input.press("Control+Home");
  await input.press("Enter");
  await page.mouse.click(box.x + 12, box.y + 5, { clickCount: 3 });
  assert.equal(
    await selected(),
    "\n",
    "An empty first paragraph selects its newline",
  );
  await page.close();
});

test("touch taps activate document fields and blank space releases them without losing input", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    hasTouch: true,
  });
  page.setDefaultTimeout(6000);
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("Touch-Eingabe");
  const canvas = await page.locator("canvas").first().boundingBox();
  await page.touchscreen.tap(canvas.x + 10, canvas.y + 10);
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  const field = page.getByRole("button", { name: "Text 1 – 1", exact: true });
  const box = await field.boundingBox();
  await page.touchscreen.tap(box.x + 8, box.y + 8);
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-canvas-input"),
  );
  assert.equal(await input.inputValue(), "Touch-Eingabe");
  await input.fill("Touch bleibt erhalten");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page.reload();
  await page
    .getByRole("navigation", { name: "Dokumentgliederung", exact: true })
    .getByText("Touch bleibt erhalten", { exact: true })
    .waitFor();
  await page.close();
});

test("unit drafts use GAEB abbreviations and recover invalid input without claiming a valid schema", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const field = page.getByRole("button", { name: "Einheit", exact: true });
  await focusEditableField(field);
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("Stck.");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.equal(await input.inputValue(), "Stk");
  await input.fill("unbekannte Einheit");
  await page
    .getByText("Speichern wartet auf Korrektur", { exact: true })
    .waitFor();
  await page.locator('[data-schema-state="pending"]').waitFor();
  await page
    .getByText(/Die Einheit darf höchstens vier Zeichen enthalten/)
    .waitFor();
  assert.equal(
    await page
      .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
      .count(),
    0,
  );
  assert.equal(await input.inputValue(), "unbekannte Einheit");
  await page.reload();
  await focusEditableField(field);
  assert.equal(await input.inputValue(), "unbekannte Einheit");
  await input.fill("pauschal");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.equal(await input.inputValue(), "psch");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Datei herunterladen", exact: true })
    .click();
  const xml = await readFile(await (await downloaded).path(), "utf8");
  assert.match(xml, /<QU>psch<\/QU>/);
  assert.doesNotMatch(xml, /unbekannte Einheit|pauschal/);
  await page.getByRole("tab", { name: "Start", exact: true }).click();
  await page
    .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
    .waitFor();
  await page.close();
});

test("position numbers and quantity columns share the description baseline at different font sizes", async () => {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.closest(".gaeb-canvas-tile"))
        this.canvas.__textCalls = [];
      return clear.apply(this, args);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      value,
      x,
      y,
      ...rest
    ) {
      if (this.canvas.closest(".gaeb-canvas-tile")) {
        this.save();
        this.textBaseline = "alphabetic";
        const alphabetic = this.measureText("Hg").actualBoundingBoxAscent;
        this.textBaseline = "top";
        const top = this.measureText("Hg").actualBoundingBoxAscent;
        this.restore();
        (this.canvas.__textCalls ??= []).push({
          value,
          x,
          y,
          baseline: y + alphabetic - top,
          font: this.font,
        });
      }
      return fill.call(this, value, x, y, ...rest);
    };
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 1600 });
  await page.goto(base);
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    let model = new GaebDocument(
      createGaebXml("86", "Baselines"),
      "Baselines.x86",
    );
    for (const size of [12, 14, 24]) {
      let source = model.addItem();
      source = source.replace(
        /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
        `<p><span style="font-size: ${size}px">Description${size}</span></p>`,
      );
      model = new GaebDocument(source, model.fileName);
    }
    return model.source;
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "Baselines.x86",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await page.locator('[data-gaeb-field$=":text:0"]').first().waitFor();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const calls = await page
    .locator(".gaeb-canvas-tile canvas")
    .evaluateAll((nodes) => nodes.flatMap((node) => node.__textCalls ?? []));
  for (const [index, size] of [12, 14, 24].entries()) {
    const description = calls.find(
      (call) => call.value === `Description${size}`,
    );
    const number = calls.find((call) => call.value === String(index + 1));
    assert.ok(description && number, JSON.stringify(calls));
    assert.ok(
      Math.abs(description.baseline - number.baseline) < 0.01,
      JSON.stringify({ description, number }),
    );
    const quantity = calls.find(
      (call) =>
        call.value === "0,000" &&
        Math.abs(call.baseline - description.baseline) < 0.01,
    );
    assert.ok(quantity, `Quantity shares the ${size}px text baseline`);
    assert.ok(number.x < description.x && description.x < quantity.x);
  }
  await context.close();
});

test("fractional zoom paints identical pixels across different canvas boundaries, including hover and selection", async () => {
  const stitched = [];
  for (const [deviceScaleFactor, percent] of [
    [1, "187.5"],
    [1.5, "125"],
  ]) {
    // Keep Chromium's font hinting constant, while changing the editor's
    // reported display density and therefore its memory-bounded tile height.
    const context = await browser.newContext({
      viewport: { width: 1900, height: 1400 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript((ratio) => {
      Object.defineProperty(window, "devicePixelRatio", { get: () => ratio });
      const NativeObserver = window.IntersectionObserver;
      window.IntersectionObserver = class extends NativeObserver {
        constructor(callback, options) {
          super(callback, options);
          this.callback = callback;
        }
        observe(target) {
          if (target.matches(".gaeb-canvas-tile"))
            this.callback([{ target, isIntersecting: true }], this);
          else super.observe(target);
        }
      };
    }, deviceScaleFactor);
    const page = await context.newPage();
    await page.goto(base);
    const xml = await page.evaluate(async () => {
      const { GaebDocument, createGaebXml } = await import("/editor.js");
      const paragraphs = Array.from(
        { length: 40 },
        (_, i) =>
          `<p><span${i % 3 === 0 ? ' style="text-decoration: underline"' : ""}>Paragraph ${i + 1}: Äußere Wärmedämmung, Fassadenfront und Anschlussprofile – Montage und Oberflächenbehandlung.</span></p>`,
      ).join("");
      return new GaebDocument(
        createGaebXml("86", "Tile boundaries"),
        "Tiles.x86",
      )
        .addItem()
        .replace(
          /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
          paragraphs,
        );
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "Tiles.x86",
      mimeType: "application/xml",
      buffer: Buffer.from(xml),
    });
    const zoom = page.getByRole("textbox", {
      name: "Zoom in Prozent",
      exact: true,
    });
    await zoom.fill(percent);
    await zoom.press("Enter");
    await page.waitForFunction(
      (scale) =>
        document.querySelector(".gaeb-canvas-tile canvas")?.width ===
        Math.ceil(794 * scale * window.devicePixelRatio),
      Number(percent) / 100,
    );
    // Rasterization is deliberately deferred during a zoom gesture. Bitmap
    // dimensions can already match when the deferred paint is still pending.
    await page.waitForTimeout(180);
    const field = page.locator('[data-gaeb-field$=":text:0"]').first();
    await field.scrollIntoViewIfNeeded();
    const bounds = await field.boundingBox();
    const viewport = await page.locator(".gaeb-document-scroll").boundingBox();
    assert.ok(
      bounds.y + 5 >= viewport.y &&
        bounds.y + 5 <= viewport.y + viewport.height,
    );
    await page.mouse.move(bounds.x + 15, bounds.y + 5);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const capture = () =>
      page.locator(".gaeb-canvas-tile canvas").evaluateAll((nodes) => {
        const canvas = document.createElement("canvas");
        canvas.width = nodes[0].width;
        canvas.height = nodes.reduce((sum, node) => sum + node.height, 0);
        const ctx = canvas.getContext("2d");
        let y = 0;
        for (const node of nodes) {
          ctx.drawImage(node, 0, y);
          y += node.height;
        }
        return {
          count: nodes.length,
          width: canvas.width,
          height: canvas.height,
          scale: nodes[0].getContext("2d").getTransform().a,
          data: canvas.toDataURL(),
        };
      });
    const image = await capture();
    await focusEditableField(field);
    await page.locator("textarea.gaeb-canvas-input").press("Control+a");
    image.selected = (await capture()).data;
    stitched.push(image);
    await context.close();
  }
  assert.notEqual(
    stitched[0].count,
    stitched[1].count,
    "Different display densities must place the tile boundaries on different text lines",
  );
  assert.equal(stitched[0].width, stitched[1].width);
  assert.equal(stitched[0].height, stitched[1].height);
  const page = await browser.newPage();
  for (const mode of ["data", "selected"]) {
    const differences = await page.evaluate(
      async ({ images, mode }) => {
        const pixels = [];
        for (const source of images) {
          const image = new Image();
          image.src = source[mode];
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          pixels.push(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        }
        let changed = 0,
          max = 0;
        const rows = new Set();
        const samples = [];
        for (let i = 0; i < pixels[0].length; i++) {
          const delta = Math.abs(pixels[0][i] - pixels[1][i]);
          if (delta) {
            changed++;
            if (samples.length < 8)
              samples.push({
                x: Math.floor(i / 4) % images[0].width,
                channel: i % 4,
                first: pixels[0][i],
                second: pixels[1][i],
              });
            rows.add(Math.floor(i / 4 / images[0].width));
          }
          max = Math.max(max, delta);
        }
        return {
          mode,
          samples,
          heights: images.map((image) => image.height),
          changed,
          max,
          rows: [...rows].slice(0, 30),
          rowCount: rows.size,
          scales: images.map((source) => source.scale),
        };
      },
      { images: stitched, mode },
    );
    assert.equal(differences.changed, 0, JSON.stringify(differences));
  }
  await page.close();
});

test("production core retains original XML, namespaces, rich text and vendor extensions", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml, validateGaebInBrowser } =
      await import("/editor.js");
    let source = createGaebXml("83", "Müller & Söhne");
    source = new GaebDocument(source, "LV.x83").addItem();
    const unknown =
      '<v:Extra xmlns:v="urn:vendor" v:flag="ä"><![CDATA[a < b && Grüße]]></v:Extra>';
    source = source
      .replace(
        "<Qty>",
        "<!-- Keep exact whitespace and this comment -->" + unknown + "<Qty>",
      )
      .replace(
        "<Item ID=",
        '<Item xmlns:v="urn:vendor" v:custom="unchanged" ID=',
      );
    const original = new GaebDocument(source, "renamed.x84");
    const changed = original.setValue(original.items[0], "Qty", "2,125");
    const expected = source.replace("<Qty>0.000</Qty>", "<Qty>2.125</Qty>");
    const check = await validateGaebInBrowser(changed, original.identity);
    const signed = new GaebDocument(
      source.replace(
        "</GAEB>",
        '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></GAEB>',
      ),
      "signed.x83",
    );
    let blocked = false;
    try {
      signed.setValue(signed.items[0], "Qty", "3");
    } catch {
      blocked = true;
    }
    const text = original.textSegments(original.items[0])[0];
    const editedText = original.setText(text, "Dämmung < 10 mm & Öl");
    return {
      untouched: original.source === source,
      exact: changed === expected,
      unknown: changed.includes(unknown),
      valid: check.valid,
      issues: check.issues,
      mismatch: original.extensionMismatch,
      phase: original.phase,
      signed: signed.signed && blocked,
      rich:
        editedText.includes("Dämmung &lt; 10 mm &amp; Öl") &&
        editedText.includes("<CompleteText><DetailTxt><Text><p>"),
    };
  });
  assert.equal(result.untouched, true);
  assert.equal(result.exact, true);
  assert.equal(result.unknown, true);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.mismatch, true);
  assert.equal(result.phase, "83");
  assert.equal(result.signed, true);
  assert.equal(result.rich, true);
  await page.close();
});

test("all editable phases support native new items and produce schema-valid files", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const results = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      validateGaebInBrowser,
      GAEB_PHASES,
      phaseCanEdit,
      phaseHasPrices,
    } = await import("/editor.js");
    const results = [];
    for (const phase of GAEB_PHASES.filter(phaseCanEdit)) {
      const doc = new GaebDocument(createGaebXml(phase, "LV"), `LV.x${phase}`);
      const added = new GaebDocument(doc.addItem(), doc.fileName);
      let source = added.setValue(
        added.items[0],
        "Qty",
        ["93", "96"].includes(phase) ? "2.50" : "2.500",
      );
      if (phaseHasPrices(phase)) {
        const priced = new GaebDocument(source, doc.fileName);
        source = priced.setValue(
          priced.items[0],
          "UP",
          ["93", "96"].includes(phase) ? "12.34" : "12.345",
        );
      }
      const result = await validateGaebInBrowser(source, added.identity);
      results.push({ phase, ...result });
    }
    return results;
  });
  for (const result of results)
    assert.equal(
      result.valid,
      true,
      `X${result.phase}: ${JSON.stringify(result.issues)}`,
    );
  await page.close();
});

test("X31 editing retains REB rows, stores attachments and checks the 2023 schema", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml, validateGaebInBrowser } =
      await import("/editor.js");
    let doc = new GaebDocument(createGaebXml("31", "Aufmaß"), "test.x31");
    doc = new GaebDocument(doc.addItem(), doc.fileName);
    const row = " ".repeat(11) + "REB Bestand #Bild plan.pdf".padEnd(69, " ");
    doc = new GaebDocument(doc.addTakeoffRow(doc.items[0], row), doc.fileName);
    doc = new GaebDocument(
      doc.addAttachment("plan.pdf", "pdf", btoa("%PDF-1.7\nexample")),
      doc.fileName,
    );
    const before = doc.source;
    const changed = new GaebDocument(
      doc.setValue(doc.items[0], "Qty", "123.456"),
      doc.fileName,
    );
    const checked = await validateGaebInBrowser(
      changed.source,
      changed.identity,
    );
    return {
      valid: checked.valid,
      issues: checked.issues,
      row: changed.takeoffRows(changed.items[0])[0].getAttribute("Row") === row,
      attachment:
        changed.value(changed.attachmentElements()[0], "Data") ===
        btoa("%PDF-1.7\nexample"),
      exact:
        changed.source ===
        before.replace("<Qty>0.000</Qty>", "<Qty>123.456</Qty>"),
    };
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.row, true);
  assert.equal(result.attachment, true);
  assert.equal(result.exact, true);
  await page.close();
});

test("canvas WYSIWYG edits text in place, formats a selection and creates a real paragraph", async () => {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const input = page.getByRole("textbox", { name: /^Text / });
  await input.fill("Dämmung liefern und montieren");
  await input.press("Home");
  for (let i = 0; i < 7; i++) await input.press("Shift+ArrowRight");
  await input.press("Control+b");
  await input.press("ArrowRight");
  await input.press("End");
  await input.press("Enter");
  await page.keyboard.type("Weitere Hinweise");
  const saved = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Datei herunterladen", exact: true })
    .click();
  const xml = await readFile(await (await saved).path(), "utf8");
  assert.match(xml, /style="font-weight: normal">Dämmung<\/span>/);
  assert.match(
    xml,
    /<p[^>]*><span[^>]*font-weight:normal[^>]*>Weitere Hinweise<\/span><\/p>/,
  );
  assert.ok((await page.locator(".gaeb-canvas-tile canvas").count()) >= 1);
  assert.equal(await page.locator("[contenteditable]").count(), 0);
  assert.equal(await page.getByRole("grid").count(), 0);
  assert.equal(await page.locator("textarea.gaeb-canvas-input").count(), 1);
  if (process.env.SORTSYS_UI_SCREENSHOTS) {
    await mkdir(process.env.SORTSYS_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({
      path: `${process.env.SORTSYS_UI_SCREENSHOTS}/gaeb-canvas-wysiwyg.png`,
    });
  }
  await context.close();
});

test("multiline paste saves real paragraphs and retains the editing position", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("Erste Zeile\nZweite Zeile");
  let saved = page.waitForEvent("download");
  await input.press("Control+s");
  await page
    .getByRole("button", { name: "Datei herunterladen", exact: true })
    .click();
  let xml = await readFile(await (await saved).path(), "utf8");
  assert.match(
    xml,
    /<p[^>]*><span[^>]*>Erste Zeile<\/span><\/p><p[^>]*><span[^>]*>Zweite Zeile<\/span><\/p>/,
  );
  await focusEditableField(
    page.getByRole("button", { name: /Text .*– 1/ }).first(),
  );
  await input.press("Control+End");
  assert.equal(await input.inputValue(), "Erste Zeile\nZweite Zeile");
  await input.press("Home");
  assert.equal(await input.evaluate((node) => node.selectionStart), 12);
  await input.press("ArrowUp");
  assert.equal(await input.evaluate((node) => node.selectionStart), 0);
  await input.press("ArrowDown");
  assert.equal(await input.evaluate((node) => node.selectionStart), 12);
  await input.press("End");
  await page.keyboard.type(" ergänzt");
  saved = page.waitForEvent("download");
  await input.press("Control+s");
  await page
    .getByRole("button", { name: "Datei herunterladen", exact: true })
    .click();
  xml = await readFile(await (await saved).path(), "utf8");
  assert.match(xml, /<p[^>]*><span[^>]*>Zweite Zeile ergänzt<\/span><\/p>/);
  await page.close();
});

test("long documents use a seamless continuous canvas with virtualized rendering", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    const initial = new GaebDocument(
      createGaebXml("83", "Mehrseitiges LV"),
      "LV.x83",
    );
    const doc = new GaebDocument(initial.addItem(), initial.fileName);
    return doc.setRichText(
      doc.items[0],
      0,
      Array.from(
        { length: 180 },
        (_, i) =>
          `Absatz ${i + 1}: Dämmung liefern, fachgerecht montieren und alle Anschlussarbeiten vollständig ausführen. Die Ausführung erfolgt nach den Planunterlagen.`,
      ).join("\n"),
    );
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "LV.x83",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  const pages = page.locator(".gaeb-canvas-tile");
  await pages.first().waitFor();
  const count = await pages.count();
  assert.ok(count >= 8);
  assert.equal(await page.locator(".gaeb-document-paper").count(), 1);
  assert.equal(
    await pages.evaluateAll((nodes) =>
      nodes.every(
        (node, i) =>
          i === 0 ||
          Math.abs(
            node.getBoundingClientRect().top -
              nodes[i - 1].getBoundingClientRect().bottom,
          ) < 1,
      ),
    ),
    true,
  );
  assert.ok((await page.locator(".gaeb-canvas-tile canvas").count()) < count);
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  assert.equal(await page.locator(".gaeb-canvas-tile canvas").count(), count);
  assert.equal(
    await page.locator(".gaeb-canvas-tile canvas").evaluateAll((canvases) =>
      canvases.every((canvas) => {
        const context = canvas.getContext("2d");
        const ratio = canvas.width / 794;
        const pixels = context.getImageData(
          64 * ratio,
          88 * ratio,
          666 * ratio,
          950 * ratio,
        ).data;
        return pixels.some((value, index) => index % 4 === 0 && value < 150);
      }),
    ),
    true,
  );
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".gaeb-toolbar").isVisible(), false);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.close();
});

test("prices update stored totals with decimal rounding and retain special pricing unchanged", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml, validateGaebInBrowser } =
      await import("/editor.js");
    let doc = new GaebDocument(createGaebXml("86", "LV"), "LV.x86");
    doc = new GaebDocument(doc.addItem(), doc.fileName);
    doc = new GaebDocument(
      doc.source.replace(
        "</BoQInfo>",
        "<Totals><Total>0.00</Total><DiscountPcnt>10.000000</DiscountPcnt><TotAfterDisc>0.00</TotAfterDisc></Totals></BoQInfo>",
      ),
      doc.fileName,
    );
    doc = new GaebDocument(
      doc.setValue(doc.items[0], "Qty", "2.500"),
      doc.fileName,
    );
    doc = new GaebDocument(
      doc.setValue(doc.items[0], "UP", "12.345"),
      doc.fileName,
    );
    const total = doc.xml.getElementsByTagNameNS(doc.namespace, "Totals")[0];
    const check = await validateGaebInBrowser(doc.source, doc.identity);
    const special = new GaebDocument(
      doc.source.replace(
        "<Qty>",
        "<ALNGroupNo>1</ALNGroupNo><ALNSerNo>1</ALNSerNo><Qty>",
      ),
      doc.fileName,
    );
    let blocked = false;
    try {
      special.setValue(special.items[0], "UP", "99");
    } catch {
      blocked = true;
    }
    return {
      valid: check.valid,
      issues: check.issues,
      amount: doc.value(doc.items[0].element, "IT"),
      total: doc.value(total, "Total"),
      discount: doc.value(total, "DiscountAmt"),
      net: doc.value(total, "TotAfterDisc"),
      blocked,
      unchanged: special.source.includes("<UP>12.345</UP>"),
    };
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.amount, "30.86");
  assert.equal(result.total, "30.86");
  assert.equal(result.discount, "");
  assert.equal(result.net, "27.77");
  assert.equal(result.blocked, true);
  assert.equal(result.unchanged, true);
  await page.close();
});

test("older namespaces and prefixed XML remain editable without conversion", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml, validateGaebInBrowser } =
      await import("/editor.js");
    let source = createGaebXml("83", "LV");
    source = new GaebDocument(source, "LV.x83").addItem();
    const old = source
      .replace(/\/3\.3/g, "/3.2")
      .replace("<Version>3.3</Version>", "<Version>3.2</Version>")
      .replace("<VersDate>2021-05</VersDate>", "<VersDate>2013-10</VersDate>");
    const doc32 = new GaebDocument(old, "LV.xml");
    const changed = doc32.setValue(doc32.items[0], "Qty", "42.125");
    const checked = await validateGaebInBrowser(changed, doc32.identity);
    const old31 = source
      .replace(
        "http://www.gaeb.de/GAEB_DA_XML/DA83/3.3",
        "http://www.gaeb.de/GAEB_DA_XML/200407",
      )
      .replace("<Version>3.3</Version>", "<Version>3.1</Version>")
      .replace("<VersDate>2021-05</VersDate>", "<VersDate>2009-12</VersDate>");
    const doc31 = new GaebDocument(old31, "LV.x83");
    const prefixed = source
      .replace(/<(\/?)([A-Za-z]\w*)(?=[\s/>])/g, "<$1g:$2")
      .replace("xmlns=", "xmlns:g=");
    const prefixDoc = new GaebDocument(prefixed, "LV.x83");
    return {
      valid: checked.valid,
      issues: checked.issues,
      version32: new GaebDocument(changed, "LV.xml").version,
      phase31: doc31.phase,
      version31: doc31.version,
      exact:
        prefixDoc.setValue(prefixDoc.items[0], "Qty", "7") ===
        prefixed.replace("<g:Qty>0.000</g:Qty>", "<g:Qty>7.000</g:Qty>"),
    };
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.version32, "3.2");
  assert.equal(result.version31, "3.1");
  assert.equal(result.phase31, "83");
  assert.equal(result.exact, true);
  await page.close();
});

for (const variant of [
  { width: 1400, height: 900, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
]) {
  test(`real editor opens, edits, validates and saves directly at ${variant.width}px/${variant.theme}`, async () => {
    const context = await browser.newContext({
      viewport: variant,
      colorScheme: variant.theme,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, variant.theme);
    await page
      .getByRole("button", { name: "Neues Angebot", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Position hinzufügen", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Menge", exact: true })
      .fill("2,500");
    await page
      .getByRole("textbox", { name: "Menge", exact: true })
      .press("Tab");
    await page
      .getByRole("textbox", { name: "Einheitspreis", exact: true })
      .fill("12,345");
    await page
      .getByRole("textbox", { name: "Einheitspreis", exact: true })
      .press("Tab");

    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Datei herunterladen", exact: true })
      .click();
    const download = await downloadPromise;
    const xml = await readFile(await download.path(), "utf8");
    assert.match(xml, /<Qty>2\.500<\/Qty>/);
    assert.match(xml, /<UP>12\.345<\/UP>/);
    assert.equal(
      await page
        .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
        .count(),
      1,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    if (process.env.SORTSYS_UI_SCREENSHOTS) {
      await mkdir(process.env.SORTSYS_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: `${process.env.SORTSYS_UI_SCREENSHOTS}/gaeb-${variant.width}-${variant.theme}.png`,
      });
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test("trackpad, Ctrl-wheel and explicit zoom preserve the document anchor", async () => {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  await page
    .locator("textarea.gaeb-canvas-input")
    .fill(
      Array.from(
        { length: 50 },
        () => "Fortlaufender Text mit Dämmung und Montage.",
      ).join("\n"),
    );
  const viewport = page.getByRole("region", { name: "Dokument", exact: true });
  const zoom = page.getByRole("textbox", {
    name: "Zoom in Prozent",
    exact: true,
  });
  const bounds = await viewport.boundingBox();
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + 240 };
  const anchor = () =>
    page.locator(".gaeb-document-paper").evaluate(
      (node, point) => ({
        x:
          (point.x - node.getBoundingClientRect().left) /
          (Number(document.querySelector(".gaeb-zoom-value input").value) /
            100),
        y:
          (point.y - node.getBoundingClientRect().top) /
          (Number(document.querySelector(".gaeb-zoom-value input").value) /
            100),
      }),
      point,
    );
  const before = await anchor();
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.waitForFunction(
    () => Number(document.querySelector(".gaeb-zoom-value input").value) > 100,
  );
  const after = await anchor();
  assert.ok(Math.abs(after.y - before.y) < 3);
  assert.ok(Math.abs(after.x - before.x) < 3);
  const wheelZoom = await zoom.inputValue();
  await page.mouse.wheel(0, 200);
  assert.equal(await zoom.inputValue(), wheelZoom);
  await viewport.evaluate((node, point) => {
    const start = new Event("gesturestart", {
      bubbles: true,
      cancelable: true,
    });
    node.dispatchEvent(start);
    const change = new Event("gesturechange", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(change, { scale: 1.15, clientX: point.x, clientY: point.y });
    node.dispatchEvent(change);
  }, point);
  await page.waitForFunction(
    (previous) =>
      Number(document.querySelector(".gaeb-zoom-value input").value) > previous,
    Number(wheelZoom),
  );
  await zoom.fill("250");
  await zoom.press("Enter");
  assert.equal(await zoom.inputValue(), "250");
  await page
    .getByRole("button", { name: "An Breite anpassen", exact: true })
    .click();
  assert.ok(Number(await zoom.inputValue()) <= 100);
  await page.close();
});

test("autosave persists focused input across reload and retains invalid drafts", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neues Angebot", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("2.500");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.equal(downloads.length, 0);
  await page.reload();
  const quantity = page.getByRole("button", { name: "Menge", exact: true });
  await quantity.waitFor();
  assert.equal(await quantity.getAttribute("aria-description"), "2.500");
  await focusEditableField(quantity);
  await input.fill("unfertige Eingabe");
  await page.getByRole("alert").waitFor();
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-gaeb-field$=":Qty"]')
        ?.getAttribute("aria-description") === "unfertige Eingabe",
  );
  await focusEditableField(quantity);
  assert.equal(await input.inputValue(), "unfertige Eingabe");
  await input.fill("3.500");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page.reload();
  await quantity.waitFor();
  assert.equal(await quantity.getAttribute("aria-description"), "3.500");
  await focusEditableField(quantity);
  await input.fill("4.500");
  await page.getByRole("button", { name: "Schließen", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Zuletzt bearbeitetes Dokument öffnen",
      exact: true,
    })
    .click();
  await quantity.waitFor();
  assert.equal(await quantity.getAttribute("aria-description"), "4.500");
  assert.equal(
    await page.getByRole("button", { name: "Speichern", exact: true }).count(),
    0,
  );
  await context.close();
});

test("contractor document chains retain scope, validate each phase and exclude selling prices from procurement", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      deriveGaebDocument,
      gaebNetAmount,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let source = new GaebDocument(
      createGaebXml("83", "Trockenbau"),
      "Anfrage.x83",
    );
    source = new GaebDocument(source.addItem(), source.fileName);
    source = new GaebDocument(
      source.setRichText(source.items[0], 0, "Dämmung liefern und montieren"),
      source.fileName,
    );
    source = new GaebDocument(
      source.setValue(source.items[0], "Qty", "2.500"),
      source.fileName,
    );
    source = new GaebDocument(source.addItem(), source.fileName);
    const itemId = source.items[0].element.getAttribute("ID");
    const untouched = source.source;
    let offer = new GaebDocument(
      deriveGaebDocument(source.source, "84", {
        ownCompany: "Eigener Betrieb",
      }),
      "Angebot.x84",
    );
    offer = new GaebDocument(
      offer.setValue(offer.items[0], "UP", "123.456"),
      offer.fileName,
    );
    const inquiry = deriveGaebDocument(offer.source, "83", {
      referenceXml: source.source,
      selectedItemIds: [itemId],
      ownCompany: "Eigener Betrieb",
    });
    let supplier = new GaebDocument(
      deriveGaebDocument(inquiry, "84", { ownCompany: "Nachunternehmer" }),
      "NU.x84",
    );
    supplier = new GaebDocument(
      supplier.setValue(supplier.items[0], "UP", "75.000"),
      supplier.fileName,
    );
    const order = deriveGaebDocument(supplier.source, "86", {
      referenceXml: inquiry,
      ownCompany: "Eigener Betrieb",
      partnerName: "Nachunternehmer",
    });
    const confirmation = deriveGaebDocument(order, "87", {
      ownCompany: "Nachunternehmer",
      partnerName: "Eigener Betrieb",
    });
    const measurement = deriveGaebDocument(offer.source, "31", {
      referenceXml: source.source,
    });
    const results = [];
    for (const xml of [
      offer.source,
      inquiry,
      supplier.source,
      order,
      confirmation,
      measurement,
    ]) {
      const doc = new GaebDocument(xml, "file.xml");
      results.push({
        phase: doc.phase,
        ...(await validateGaebInBrowser(xml, doc.identity)),
      });
    }
    const packageDoc = new GaebDocument(inquiry, "package.x83");
    const takeoff = new GaebDocument(measurement, "measurement.x31");
    return {
      results,
      originalRetained: source.source === untouched,
      offerNet: gaebNetAmount(offer.source),
      orderNet: gaebNetAmount(order),
      privatePrices:
        inquiry.includes("123.456") ||
        packageDoc.xml.getElementsByTagNameNS(packageDoc.namespace, "UP")
          .length > 0 ||
        packageDoc.xml.getElementsByTagNameNS(packageDoc.namespace, "IT")
          .length > 0,
      packageItems: packageDoc.items.map((item) =>
        item.element.getAttribute("ID"),
      ),
      takeoffQty: takeoff.quantity(takeoff.items[0]),
      takeoffItems: takeoff.items.length,
      sourceItems: source.items.length,
    };
  });
  for (const checked of result.results)
    assert.equal(
      checked.valid,
      true,
      `X${checked.phase}: ${JSON.stringify(checked.issues)}`,
    );
  assert.equal(result.originalRetained, true);
  assert.equal(result.offerNet, "308.64");
  assert.equal(result.orderNet, "187.50");
  assert.equal(result.privatePrices, false);
  assert.equal(result.packageItems.length, 1);
  assert.equal(result.takeoffQty, "0.000");
  assert.equal(result.takeoffItems, result.sourceItems);
  await page.close();
});

test("organization addresses populate native bids, remain editable and survive recalculation", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      deriveGaebDocument,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let source = new GaebDocument(
      createGaebXml("83", "Baumaßnahme"),
      "request.x83",
    );
    source = new GaebDocument(source.addItem(), source.fileName);
    const options = {
      ownCompany: "Lange Unternehmensbezeichnung für Bau und Handwerk GmbH",
      ownAddress: {
        streetAddress: "Bauweg 12",
        zip: "06108",
        city: "Halle",
        country: "Deutschland",
      },
    };
    const offer = new GaebDocument(
      deriveGaebDocument(source.source, "84", options),
      "offer.x84",
    );
    const ctr = offer.child(offer.child(offer.root, "Award"), "CTR");
    const address = offer.child(ctr, "Address");
    const before = Object.fromEntries(
      [...address.children].map((el) => [el.localName, el.textContent]),
    );
    const street = offer.child(address, "Street");
    const streetIndex = offer.metadataElements().indexOf(street);
    const changed = offer.setMetadata(streetIndex, "Andere Straße 5");
    const updated = new GaebDocument(
      deriveGaebDocument(source.source, "84", {
        ...options,
        pricesXml: changed,
        ownAddress: {
          ...options.ownAddress,
          streetAddress: "Neue Firmenadresse 8",
        },
      }),
      "updated.x84",
    );
    const updatedAddress = updated.child(
      updated.child(updated.child(updated.root, "Award"), "CTR"),
      "Address",
    );
    let tooLong = false;
    try {
      deriveGaebDocument(source.source, "84", {
        ...options,
        ownAddress: { ...options.ownAddress, city: "X".repeat(41) },
      });
    } catch (error) {
      tooLong = error.message === "workflow-address-length";
    }
    return {
      before,
      updatedStreet: updated.value(updatedAddress, "Street"),
      tooLong,
      valid: await validateGaebInBrowser(updated.source, updated.identity),
    };
  });
  assert.equal(
    result.before.Name1 + result.before.Name2,
    "Lange Unternehmensbezeichnung für Bau und Handwerk GmbH",
  );
  assert.equal(result.before.Street, "Bauweg 12");
  assert.equal(result.before.City, "Halle");
  assert.equal(result.before.Country, "Deutschland");
  assert.equal(result.updatedStreet, "Andere Straße 5");
  assert.equal(result.tooLong, true);
  assert.equal(result.valid.valid, true, JSON.stringify(result.valid.issues));
  await page.close();
});

test("price and amount columns start compact and expand with large amounts", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    let doc = new GaebDocument(
      createGaebXml("86", "Compact prices"),
      "order.x86",
    );
    doc = new GaebDocument(doc.addItem(), doc.fileName);
    doc = new GaebDocument(
      doc.setValue(doc.items[0], "Qty", "3.000"),
      doc.fileName,
    );
    return doc.setValue(doc.items[0], "UP", "592.000");
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "order.x86",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  const price = page.locator('[data-gaeb-field$=":UP"]').first();
  const quantity = page.locator('[data-gaeb-field$=":Qty"]').first();
  await price.waitFor();
  const initial = await price.boundingBox(),
    quantityBefore = await quantity.boundingBox();
  assert.ok(initial.width < 84, `Initial price width ${initial.width}`);
  await focusEditableField(price);
  const input = page.getByRole("textbox", {
    name: "Einheitspreis",
    exact: true,
  });
  await input.fill("1234567.000");
  await input.press("Tab");
  await page.waitForFunction(
    (width) =>
      Number.parseFloat(
        document.querySelector('[data-gaeb-field$=":UP"]').style.width,
      ) >
      width + 10,
    initial.width,
  );
  assert.ok(
    (await quantity.boundingBox()).x < quantityBefore.x,
    "Amount columns grow leftwards and leave the right edge stable",
  );
  assert.ok((await price.boundingBox()).width <= 128);
  await page.close();
});

for (const [locale, currency, symbol, amount] of [
  ["de", "EUR", "€", "1.776,00\u00a0€"],
  ["en", "USD", "US$", "US$1,776.00"],
]) {
  test(`price and amount show ${currency} in ${locale} while price editing retains numeric XML`, async () => {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    });
    await page.goto(base);
    if (locale === "en")
      await page.getByRole("button", { name: "English", exact: true }).click();
    const xml = await page.evaluate(async (currency) => {
      const { GaebDocument, createGaebXml } = await import("/editor.js");
      let doc = new GaebDocument(
        createGaebXml("86", "Währung").replace(
          "<Cur>EUR</Cur>",
          `<Cur>${currency}</Cur>`,
        ),
        "order.x86",
      );
      doc = new GaebDocument(doc.addItem(), doc.fileName);
      doc = new GaebDocument(
        doc.setValue(doc.items[0], "Qty", "3.000"),
        doc.fileName,
      );
      window.__currencyDraws = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (
        text,
        x,
        y,
        ...rest
      ) {
        window.__currencyDraws.push({ text, x, y });
        return original.call(this, text, x, y, ...rest);
      };
      return doc.setValue(doc.items[0], "UP", "592.000");
    }, currency);
    await page.locator('input[type="file"]').setInputFiles({
      name: "order.x86",
      mimeType: "application/xml",
      buffer: Buffer.from(xml),
    });
    const price = page.locator('[data-gaeb-field$=":UP"]').first();
    await price.waitFor();
    const y = await price.evaluate((el) => Number.parseFloat(el.style.top));
    await page.waitForFunction(
      ({ symbol, amount, y }) =>
        window.__currencyDraws.some(
          (draw) => draw.text.trim() === symbol && Math.abs(draw.y - y) < 1,
        ) &&
        window.__currencyDraws.some(
          (draw) => draw.text === amount && Math.abs(draw.y - y) < 1,
        ),
      { symbol, amount, y },
    );
    await focusEditableField(price);
    const input = page.getByRole("textbox", {
      name: locale === "de" ? "Einheitspreis" : "Unit price",
      exact: true,
    });
    assert.equal(await input.inputValue(), "592.000");
    await input.fill("125.250");
    await input.press("Tab");
    await page
      .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
      .waitFor();
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: locale === "de" ? "Datei herunterladen" : "Download file",
        exact: true,
      })
      .click();
    const saved = await readFile(await (await download).path(), "utf8");
    assert.match(saved, /<UP>125.250<\/UP>/);
    assert.match(saved, /<IT>375.75<\/IT>/);
    if (process.env.SORTSYS_UI_SCREENSHOTS) {
      await mkdir(process.env.SORTSYS_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(
          process.env.SORTSYS_UI_SCREENSHOTS,
          `currency-${locale}-${currency}.png`,
        ),
      });
    }
    await page.close();
  });
}

test("offer canvas uses business columns, visible editable fields and stable multiline selection", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const textField = page.locator('[data-gaeb-field$=":text:0"]');
  await focusEditableField(textField);
  const paragraph =
    "Vorhandene oberflächenfertige Bauteile mit Klebeband und Folie abkleben. Entfernen alter Tapeten an Leibungsflächen. Herstellen einer vertikalen Deckenschürze. ".repeat(
      4,
    );
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill(paragraph);
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page.getByRole("tab", { name: "Start", exact: true }).click();
  await page
    .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
    .waitFor();
  const canvas = page.locator(".gaeb-canvas-tile canvas").first();
  const origin = await canvas.boundingBox();
  const target = await textField.boundingBox();
  const quantity = await page
    .locator('[data-gaeb-field$=":Qty"]')
    .boundingBox();
  const unit = await page.locator('[data-gaeb-field$=":QU"]').boundingBox();
  assert.ok(
    target.x < quantity.x && quantity.x < unit.x,
    "The description precedes quantities and units",
  );
  const shaded = await canvas.evaluate((node) => {
    const region = document.querySelector('[data-gaeb-field$=":Qty"]');
    const x = parseFloat(region.style.left) + 2,
      y = parseFloat(region.style.top) + 2;
    return [...node.getContext("2d").getImageData(x, y, 1, 1).data];
  });
  assert.notDeepEqual(
    shaded.slice(0, 3),
    [255, 255, 255],
    "Editable quantities have a visible field background",
  );
  // Drag below the last line and outside the text column, keeping the same field.
  await page.mouse.move(target.x + 1, target.y + 4);
  await page.mouse.down();
  await page.mouse.move(origin.x + 750, target.y + 270, { steps: 20 });
  await page.mouse.up();
  const selection = await input.evaluate((node) => ({
    start: node.selectionStart,
    end: node.selectionEnd,
  }));
  assert.equal(selection.start, 0);
  assert.equal(selection.end, paragraph.length);
  const zoom = page.getByRole("textbox", {
    name: "Zoom in Prozent",
    exact: true,
  });
  await zoom.fill("60");
  await zoom.press("Enter");
  await focusEditableField(textField);
  assert.equal(
    await zoom.inputValue(),
    "60",
    "Focusing a field must preserve the user's zoom",
  );
  await page.getByRole("tab", { name: "Ansicht", exact: true }).click();
  await page
    .getByRole("button", { name: "Eingabefelder anzeigen", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Eingabefelder anzeigen", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  if (process.env.SORTSYS_UI_SCREENSHOTS) {
    await page.screenshot({
      path: join(
        process.env.SORTSYS_UI_SCREENSHOTS,
        "offer-columns-selection.png",
      ),
      fullPage: true,
    });
  }
  await page.close();
});

test("native derivations preserve confirmation rules, resolve omitted bid quantities and protect private payloads", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      deriveGaebDocument,
      gaebNetAmount,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let scope = new GaebDocument(
      createGaebXml("83", "Büro 3 OG 01, Zusatzarbeiten am Fensterelement"),
      "Scope.x83",
    );
    scope = new GaebDocument(scope.addItem(), scope.fileName);
    scope = new GaebDocument(
      scope.setValue(scope.items[0], "Qty", "3.000"),
      scope.fileName,
    );
    const source = scope.source.replace(
      "</DetailTxt>",
      '<private:Margin xmlns:private="urn:private">INTERNAL-MARGIN-77</private:Margin><!-- INTERNAL-COMMENT-88 --></DetailTxt>',
    );
    let offered = new GaebDocument(deriveGaebDocument(source, "84"), "Bid.x84");
    offered = new GaebDocument(
      offered.setValue(offered.items[0], "UP", "592.000"),
      offered.fileName,
    );
    const withoutQuantity = offered.source.replace(/<Qty>[^<]*<\/Qty>/, "");
    const purchase = deriveGaebDocument(offered.source, "83", {
      referenceXml: source,
    });
    const conditional = source.replace(
      "<Qty>",
      "<Provis>WithoutTotal</Provis><Qty>",
    );
    let rejected = false;
    try {
      deriveGaebDocument(conditional, "84");
    } catch (error) {
      rejected = error.message === "workflow-pricing-rules";
    }
    const order = deriveGaebDocument(offered.source, "86", {
      referenceXml: source,
    });
    const withRule = new GaebDocument(
      order.replace("<Qty>", "<Provis>WithoutTotal</Provis><Qty>"),
      "Order.x86",
    ).recalculate();
    const confirmed = deriveGaebDocument(withRule, "87");
    const model = new GaebDocument(confirmed, "Confirmation.x87");
    return {
      net: gaebNetAmount(withoutQuantity, source),
      privateHidden:
        !purchase.includes("INTERNAL-MARGIN-77") &&
        !purchase.includes("INTERNAL-COMMENT-88"),
      sourceRetained: source.includes("INTERNAL-MARGIN-77"),
      conditionalRejected: rejected,
      confirmationRule: confirmed.includes("<Provis>WithoutTotal</Provis>"),
      confirmationSchema: await validateGaebInBrowser(
        confirmed,
        model.identity,
      ),
      fullLabel: scope.title,
    };
  });
  assert.equal(result.net, "1776.00");
  assert.equal(result.privateHidden, true);
  assert.equal(result.sourceRetained, true);
  assert.equal(result.conditionalRejected, true);
  assert.equal(result.confirmationRule, true);
  assert.equal(
    result.confirmationSchema.valid,
    true,
    JSON.stringify(result.confirmationSchema.issues),
  );
  assert.match(result.fullLabel, /Fensterelement/);
  await page.close();
});

for (const pixelRatio of [1, 2]) {
  test(`document columns and field baselines stay compact with sharp zoom at DPR ${pixelRatio}`, async () => {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1000 },
      deviceScaleFactor: pixelRatio,
    });
    const page = await context.newPage();
    await page.goto(base);
    const xml = await page.evaluate(async () => {
      const { GaebDocument, createGaebXml } = await import("/editor.js");
      let doc = new GaebDocument(
        createGaebXml("86", "Spalten und Zoom"),
        "Auftrag.x86",
      );
      doc = new GaebDocument(doc.addItem(), doc.fileName);
      doc = new GaebDocument(
        doc.setRichText(
          doc.items[0],
          0,
          "Leistung beschreiben und ausführen. ".repeat(12),
        ),
        doc.fileName,
      );
      return doc.setValue(doc.items[0], "UP", "592.000");
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "Auftrag.x86",
      mimeType: "application/xml",
      buffer: Buffer.from(xml),
    });
    const quantity = page.locator('[data-gaeb-field$=":Qty"]').first();
    const unit = page.locator('[data-gaeb-field$=":QU"]').first();
    const description = page.locator('[data-gaeb-field$=":text:0"]').first();
    const price = page.locator('[data-gaeb-field$=":UP"]').first();
    await focusEditableField(unit);
    const unitInput = page.getByRole("textbox", {
      name: "Einheit",
      exact: true,
    });
    await unitInput.waitFor();
    // Measure the ordinary glyph line rather than its white selected text.
    await unitInput.press("ArrowRight");
    const [descriptionBox, quantityBox, unitBox, priceBox] = await Promise.all([
      description.boundingBox(),
      quantity.boundingBox(),
      unit.boundingBox(),
      price.boundingBox(),
    ]);
    assert.ok(
      descriptionBox.x < quantityBox.x &&
        quantityBox.x < unitBox.x &&
        unitBox.x < priceBox.x,
    );
    assert.ok(
      Math.abs(descriptionBox.y - quantityBox.y) < 1 &&
        Math.abs(quantityBox.y - priceBox.y) < 1,
      "Description, quantity and price share the first text baseline even for a long description",
    );
    const field = await unit.evaluate((node) => {
      const canvas = node.closest(".gaeb-canvas-tile").querySelector("canvas"),
        ctx = canvas.getContext("2d");
      const ratio = canvas.width / 794,
        x = parseFloat(node.style.left),
        y = parseFloat(node.style.top),
        width = parseFloat(node.style.width);
      const frameRows = [],
        glyphRows = [];
      for (
        let py = Math.max(0, Math.floor((y - 8) * ratio));
        py < Math.min(canvas.height, Math.ceil((y + 35) * ratio));
        py++
      ) {
        const data = ctx.getImageData(
          Math.floor(x * ratio),
          py,
          Math.ceil(width * ratio),
          1,
        ).data;
        if (
          data.some(
            (value, index) =>
              index % 4 === 0 &&
              value === 231 &&
              data[index + 1] === 240 &&
              data[index + 2] === 253,
          )
        )
          frameRows.push(py / ratio);
        if (
          data.some(
            (value, index) =>
              index % 4 === 0 &&
              value < 80 &&
              data[index + 1] < 80 &&
              data[index + 2] < 80 &&
              data[index + 3] === 255,
          )
        )
          glyphRows.push(py / ratio);
      }
      return {
        frameTop: Math.min(...frameRows),
        frameBottom: Math.max(...frameRows),
        glyphTop: Math.min(...glyphRows),
        glyphBottom: Math.max(...glyphRows),
      };
    });
    assert.ok(
      Number.isFinite(field.frameTop) && Number.isFinite(field.glyphTop),
      JSON.stringify(field),
    );
    assert.ok(
      field.frameBottom - field.frameTop <= 21,
      `A field must fit the text line: ${JSON.stringify(field)}`,
    );
    assert.ok(
      Math.abs(
        (field.frameTop +
          field.frameBottom -
          field.glyphTop -
          field.glyphBottom) /
          2,
      ) <= 2.5,
      `Text must be vertically centered: ${JSON.stringify(field)}`,
    );
    if (process.env.SORTSYS_UI_SCREENSHOTS)
      await page.screenshot({
        path: join(
          process.env.SORTSYS_UI_SCREENSHOTS,
          `columns-compact-dpr-${pixelRatio}.png`,
        ),
        fullPage: true,
      });
    const zoom = page.getByRole("textbox", {
      name: "Zoom in Prozent",
      exact: true,
    });
    for (const percent of [150, 300]) {
      await zoom.fill(String(percent));
      await zoom.press("Enter");
      await page.waitForFunction(
        ({ pixelRatio, percent }) => {
          const canvases = [
            ...document.querySelectorAll(".gaeb-canvas-tile canvas"),
          ];
          return (
            canvases.length > 0 &&
            canvases.every(
              (canvas) =>
                canvas.width >= Math.ceil((794 * pixelRatio * percent) / 100),
            )
          );
        },
        { pixelRatio, percent },
      );
      const bitmaps = await page
        .locator(".gaeb-canvas-tile canvas")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            width: node.width,
            height: node.height,
            cssWidth: node.getBoundingClientRect().width,
            cssHeight: node.getBoundingClientRect().height,
          })),
        );
      assert.ok(
        bitmaps.every(
          (node) =>
            node.width / node.cssWidth >= pixelRatio - 0.01 &&
            node.height / node.cssHeight >= pixelRatio - 0.01,
        ),
        JSON.stringify(bitmaps),
      );
      assert.ok(
        bitmaps.every((node) => node.width * node.height <= 8 * 1024 * 1024),
        "Zoomed canvas tiles stay within the bitmap memory budget",
      );
    }
    if (pixelRatio === 2) {
      // Simulate moving the browser between displays while the editor stays open.
      await page.evaluate(() => {
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          value: 3,
        });
        window.dispatchEvent(new Event("resize"));
      });
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".gaeb-canvas-tile canvas")].some(
          (canvas) => canvas.width >= 794 * 9,
        ),
      );
      assert.ok(
        await page
          .locator(".gaeb-canvas-tile canvas")
          .evaluateAll((nodes) =>
            nodes.every((node) => node.width * node.height <= 8 * 1024 * 1024),
          ),
      );
    }
    await context.close();
  });
}

async function keyboardDocument(page) {
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  return page.locator("textarea.gaeb-canvas-input");
}

test("caret stays visible while arrow navigation is held and resumes blinking after release", async () => {
  const page = await browser.newPage(),
    input = await keyboardDocument(page);
  await input.fill("Cursor navigation stays steady");
  await input.press("Control+Home");
  await page.evaluate(() => {
    window.__caretPixels = () => {
      const field = document.querySelector('[data-gaeb-field$=":text:0"]');
      const canvas = field.closest(".gaeb-canvas-tile").querySelector("canvas"),
        ratio = canvas.width / 794;
      const pixels = canvas
        .getContext("2d")
        .getImageData(
          Math.floor((parseFloat(field.style.left) - 4) * ratio),
          Math.floor((parseFloat(field.style.top) - 8) * ratio),
          Math.ceil((parseFloat(field.style.width) + 8) * ratio),
          Math.ceil(40 * ratio),
        ).data;
      let hash = 2166136261;
      for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
      return hash >>> 0;
    };
  });
  await page.keyboard.down("ArrowRight");
  const samples = await page.evaluate(async () => {
    const values = [];
    await new Promise(requestAnimationFrame);
    for (let sample = 0; sample < 14; sample++) {
      values.push(window.__caretPixels());
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return values;
  });
  assert.equal(
    new Set(samples).size,
    1,
    "The rendered caret must not blink while an arrow key is held",
  );
  await page.keyboard.up("ArrowRight");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  assert.equal(await page.evaluate(() => window.__caretPixels()), samples[0]);
  await page.waitForFunction(
    (steady) => window.__caretPixels() !== steady,
    samples[0],
  );
  await input.press("ArrowRight");
  const restarted = await page.evaluate(() => window.__caretPixels());
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  assert.equal(await page.evaluate(() => window.__caretPixels()), restarted);
  await page.close();
});

test("canvas selection paints blue background and white glyphs while retaining unselected text", async () => {
  const page = await browser.newPage(),
    input = await keyboardDocument(page);
  await input.fill("MMMMMMMMMMMMMMMM");
  await input.press("Control+Home");
  for (let index = 0; index < 8; index++) await input.press("Shift+ArrowRight");
  await input.press("Control+b");
  const colors = await page
    .locator('[data-gaeb-field$=":text:0"]')
    .first()
    .evaluate((node) => {
      const canvas = node.closest(".gaeb-canvas-tile").querySelector("canvas"),
        ratio = canvas.width / 794;
      const width = Math.ceil(240 * ratio),
        height = Math.ceil(40 * ratio);
      const data = canvas
        .getContext("2d")
        .getImageData(
          Math.floor((parseFloat(node.style.left) - 4) * ratio),
          Math.floor((parseFloat(node.style.top) - 8) * ratio),
          width,
          height,
        ).data;
      const blue = [],
        white = [],
        dark = [];
      for (let pixel = 0; pixel < width * height; pixel++) {
        const offset = pixel * 4,
          x = pixel % width,
          y = Math.floor(pixel / width);
        if (
          data[offset] === 0 &&
          data[offset + 1] === 0 &&
          data[offset + 2] === 255
        )
          blue.push({ x, y });
        if (
          data[offset] === 255 &&
          data[offset + 1] === 255 &&
          data[offset + 2] === 255
        )
          white.push({ x, y });
        if (data[offset] < 70 && data[offset + 1] < 70 && data[offset + 2] < 70)
          dark.push({ x, y });
      }
      const minX = Math.min(...blue.map((p) => p.x)),
        maxX = Math.max(...blue.map((p) => p.x));
      const minY = Math.min(...blue.map((p) => p.y)),
        maxY = Math.max(...blue.map((p) => p.y));
      const inside = (p) =>
        p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
      return {
        blue: blue.length,
        white: white.filter(inside).length,
        darkInside: dark.filter(inside).length,
        darkOutside: dark.filter((p) => !inside(p)).length,
      };
    });
  assert.ok(colors.blue > 100, JSON.stringify(colors));
  assert.ok(colors.white > 20, JSON.stringify(colors));
  assert.equal(colors.darkInside, 0, JSON.stringify(colors));
  assert.ok(colors.darkOutside > 20, JSON.stringify(colors));
  await page.close();
});

test("Tab and Shift+Tab follow document fields once and can leave and re-enter the canvas", async () => {
  const page = await browser.newPage();
  const input = await keyboardDocument(page);
  await page
    .getByRole("separator", { name: "Breite der Gliederung", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  assert.equal(await input.getAttribute("aria-label"), "Bezeichnung");
  await page.keyboard.press("Tab");
  assert.equal(await input.getAttribute("aria-label"), "Bauvorhaben");
  await page.keyboard.press("Tab");
  assert.match(await input.getAttribute("aria-label"), /^Text /);
  await page.keyboard.press("Tab");
  assert.equal(await input.getAttribute("aria-label"), "Menge");
  await input.fill("3.500");
  await page.keyboard.press("Tab");
  assert.equal(await input.getAttribute("aria-label"), "Einheit");
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Verkleinern", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(await input.getAttribute("aria-label"), "Einheit");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await input.getAttribute("aria-label"), "Menge");
  assert.equal(await input.inputValue(), "3.500");
  await page.keyboard.press("Shift+Tab");
  assert.match(await input.getAttribute("aria-label"), /^Text /);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await input.getAttribute("aria-label"), "Bauvorhaben");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await input.getAttribute("aria-label"), "Bezeichnung");
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .getByRole("separator", { name: "Breite der Gliederung", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.close();
});

for (const platform of ["Win32", "MacIntel"])
  test(`text navigation and anchored selection use platform modifiers on ${platform}`, async () => {
    const context = await browser.newContext();
    await context.addInitScript(
      (platform) =>
        Object.defineProperty(navigator, "platform", { get: () => platform }),
      platform,
    );
    const page = await context.newPage(),
      input = await keyboardDocument(page);
    const value = "Dämmung liefern und montieren\nWeitere Arbeiten erledigen";
    await input.fill(value);
    const range = () =>
      input.evaluate((node) => ({
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      }));
    if (platform === "Win32") {
      await input.press("Control+Home");
      await input.press("Control+ArrowRight");
      assert.equal((await range()).start, 8);
      await input.press("Control+Shift+ArrowRight");
      assert.deepEqual(await range(), {
        start: 8,
        end: 16,
        direction: "forward",
      });
      await input.press("Control+Shift+ArrowLeft");
      assert.equal((await range()).start, (await range()).end);
      await input.press("Control+End");
      await input.press("Home");
      assert.equal((await range()).start, value.indexOf("\n") + 1);
      await input.press("Control+Shift+ArrowUp");
      assert.deepEqual(await range(), {
        start: 0,
        end: value.indexOf("\n") + 1,
        direction: "backward",
      });
    } else {
      await input.press("Meta+ArrowUp");
      await input.press("Alt+ArrowRight");
      assert.equal((await range()).start, 7);
      await input.press("Alt+ArrowRight");
      await input.press("Alt+ArrowLeft");
      assert.equal((await range()).start, 8);
      await input.press("Alt+Shift+ArrowRight");
      assert.deepEqual(await range(), {
        start: 8,
        end: 15,
        direction: "forward",
      });
      await input.press("Meta+ArrowLeft");
      assert.equal((await range()).start, 0);
      await input.press("Meta+Shift+ArrowRight");
      assert.deepEqual(await range(), {
        start: 0,
        end: value.indexOf("\n"),
        direction: "forward",
      });
      await input.press("Meta+ArrowDown");
      await input.press("Meta+Shift+ArrowUp");
      assert.deepEqual(await range(), {
        start: 0,
        end: value.length,
        direction: "backward",
      });
    }
    await input.press("Control+a");
    assert.deepEqual(
      { start: (await range()).start, end: (await range()).end },
      { start: 0, end: value.length },
    );
    await input.fill("A👩‍👩‍👧‍👦B");
    await input.press("Control+End");
    await input.press("ArrowLeft");
    await input.press("ArrowLeft");
    assert.equal((await range()).start, 1);
    await input.press("Shift+ArrowRight");
    assert.equal((await range()).end, "A👩‍👩‍👧‍👦".length);
    await input.press("Backspace");
    assert.equal(await input.inputValue(), "AB");
    await input.fill("Alpha Beta Gamma");
    await input.press(platform === "Win32" ? "Control+End" : "Meta+ArrowDown");
    await input.press(
      platform === "Win32" ? "Control+Backspace" : "Alt+Backspace",
    );
    assert.equal(await input.inputValue(), "Alpha Beta ");
    await input.press(platform === "Win32" ? "Control+Home" : "Meta+ArrowUp");
    await input.press(platform === "Win32" ? "Control+Delete" : "Alt+Delete");
    assert.equal(
      await input.inputValue(),
      platform === "Win32" ? "Beta " : " Beta ",
    );
    await context.close();
  });

test("clipboard shortcuts cross formatting and paragraphs and keep native XML data outside the selection", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: base,
  });
  const original = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    const doc = new GaebDocument(
      new GaebDocument(
        createGaebXml("83", "Clipboard"),
        "Clipboard.x83",
      ).addItem(),
      "Clipboard.x83",
    );
    return doc.source
      .replace(
        /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
        '<p><span style="font-weight: bold">Erster</span><span> Absatz</span></p><!-- preserved comment --><p><span style="font-style: italic">Zweiter Absatz</span></p>',
      )
      .replace(
        "<Qty>",
        '<v:Keep xmlns:v="urn:keep">ä &amp; untouched</v:Keep><Qty>',
      );
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "Clipboard.x83",
    mimeType: "application/xml",
    buffer: Buffer.from(original),
  });
  await focusEditableField(
    page.locator('[data-gaeb-field$=":text:0"]').first(),
  );
  const input = page.locator("textarea.gaeb-canvas-input");
  const value = "Erster Absatz\nZweiter Absatz";
  assert.equal(await input.inputValue(), value);
  await input.press("Control+a");
  await input.press("Control+c");
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    value,
  );
  await input.press("Control+End");
  await input.press("Control+Shift+Home");
  await input.press("Control+b");
  await page.waitForFunction(
    () =>
      document
        .querySelector('button[aria-label="Fett"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  assert.equal(
    await input.evaluate((node) => node.selectionDirection),
    "backward",
  );
  await input.press("Shift+ArrowRight");
  assert.deepEqual(
    await input.evaluate((node) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
    })),
    { start: 1, end: value.length },
  );
  await input.press("Control+a");
  await input.press("Control+x");
  assert.equal(await input.inputValue(), "");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await input.press("Control+v");
  assert.equal(await input.inputValue(), value);
  await input.press("Control+Home");
  await input.press("Control+Shift+End");
  await input.press("Control+i");
  await input.press("Control+s");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Datei herunterladen", exact: true })
    .click();
  const xml = await readFile(await (await download).path(), "utf8");
  assert.match(xml, /<v:Keep xmlns:v="urn:keep">ä &amp; untouched<\/v:Keep>/);
  assert.match(xml, /<!-- preserved comment -->/);
  assert.match(xml, /<p>/);
  const parsed = await page.evaluate(async (xml) => {
    const { GaebDocument, validateGaebInBrowser } = await import("/editor.js");
    const doc = new GaebDocument(xml, "Clipboard.x83");
    return {
      text: doc.richGroups(doc.items[0])[0].text,
      valid: (await validateGaebInBrowser(xml, doc.identity)).valid,
      styles: doc
        .richLeaves(doc.items[0])
        .filter((element) => element.textContent)
        .map((element) => element.getAttribute("style")),
    };
  }, xml);
  assert.equal(parsed.text, value);
  assert.equal(parsed.valid, true);
  assert.ok(
    parsed.styles.every((style) => style.includes("font-style: italic")),
  );
  await context.close();
});

test("paragraph boundary edits retain surrounding XML and reject deletion of protected span attributes", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml, validateGaebInBrowser } =
      await import("/editor.js");
    const base = new GaebDocument(
      createGaebXml("83", "Boundaries"),
      "Boundaries.x83",
    ).addItem();
    let doc = new GaebDocument(
      base.replace(
        /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
        '<p><span style="font-weight: bold">Alpha</span><span> Beta</span></p><!-- keep --><p><span style="font-style: italic">Gamma</span></p><p><span>Delta</span></p>',
      ),
      "Boundaries.x83",
    );
    doc = new GaebDocument(
      doc.setRichGroupText(doc.items[0], 0, "Alpha BeGamma\nDelta"),
      "Boundaries.x83",
    );
    doc = new GaebDocument(
      doc.setRichGroupText(doc.items[0], 0, "Al\npha BeGamma\nDelta"),
      "Boundaries.x83",
    );
    const protectedDoc = new GaebDocument(
      base.replace(
        /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
        '<p><span>A</span><span xmlns:v="urn:keep" v:token="keep">B</span><span>C</span></p>',
      ),
      "Boundaries.x83",
    );
    let error;
    try {
      protectedDoc.setRichGroupText(protectedDoc.items[0], 0, "");
    } catch (failure) {
      error = failure.message;
    }
    const editedProtected = protectedDoc.setRichGroupText(
      protectedDoc.items[0],
      0,
      "AXC",
    );
    return {
      text: doc.richGroups(doc.items[0])[0].text,
      comment: doc.source.includes("<!-- keep -->"),
      italic: doc.source.includes('style="font-style: italic">Gamma'),
      valid: (await validateGaebInBrowser(doc.source, doc.identity)).valid,
      protectedError: error,
      retained: editedProtected.includes(
        'xmlns:v="urn:keep" v:token="keep">X</span>',
      ),
    };
  });
  assert.deepEqual(result, {
    text: "Al\npha BeGamma\nDelta",
    comment: true,
    italic: true,
    valid: true,
    protectedError: "rich-structure",
    retained: true,
  });
  await page.close();
});

test("Home/End and reversed Shift selections follow visual wrapped lines", async () => {
  const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    }),
    input = await keyboardDocument(page);
  const value =
    "Lange Leistungsbeschreibung für die Ausführung sämtlicher Arbeiten einschließlich aller erforderlichen Nebenleistungen. ".repeat(
      5,
    );
  await input.fill(value);
  await input.press("Control+Home");
  await input.press("End");
  const end = await input.evaluate((node) => node.selectionEnd);
  assert.ok(end > 0 && end < value.length);
  await input.press("Shift+Home");
  assert.deepEqual(
    await input.evaluate((node) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
      direction: node.selectionDirection,
    })),
    { start: 0, end, direction: "backward" },
  );
  await input.press("ArrowLeft");
  await input.press("ArrowDown");
  const lower = await input.evaluate((node) => node.selectionEnd);
  assert.ok(lower > 0);
  await input.press("Shift+ArrowUp");
  assert.equal(
    await input.evaluate((node) => node.selectionDirection),
    "backward",
  );
  await page.close();
});

test("span drafts from an earlier editor version recover without overwriting other paragraphs", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    return new GaebDocument(createGaebXml("83", "Recovery"), "Recovery.x83")
      .addItem()
      .replace(
        /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
        '<p><span style="font-weight: bold">Erster</span><span> Absatz</span></p><p><span>Zweiter Absatz</span></p>',
      );
  });
  await page.evaluate(async (xml) => {
    const { GaebDocument } = await import("/editor.js");
    const doc = new GaebDocument(xml, "Recovery.x83");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("sortsys-gaeb-recovery", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("documents");
      request.onerror = reject;
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("documents", "readwrite");
        tx.objectStore("documents").put(
          {
            base: xml,
            source: xml,
            updatedAt: Date.now(),
            drafts: [[`${doc.items[0].key}:rich:1`, " Entwurf"]],
          },
          "standalone-recovery:Recovery.x83",
        );
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = reject;
      };
    });
  }, xml);
  await page.locator('input[type="file"]').setInputFiles({
    name: "Recovery.x83",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await focusEditableField(
    page.getByRole("button", { name: /Text .*– 1/ }).first(),
  );
  const input = page.locator("textarea.gaeb-canvas-input");
  await page.waitForFunction(
    () =>
      document.querySelector("textarea.gaeb-canvas-input").value ===
      "Erster Entwurf\nZweiter Absatz",
  );
  assert.equal(await input.inputValue(), "Erster Entwurf\nZweiter Absatz");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page.reload();
  await focusEditableField(
    page.getByRole("button", { name: /Text .*– 1/ }).first(),
  );
  assert.equal(await input.inputValue(), "Erster Entwurf\nZweiter Absatz");
  await page.close();
});

test("read-only canvas text supports selecting and copying without changing signed XML", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: base,
  });
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    const doc = new GaebDocument(
      new GaebDocument(
        createGaebXml("83", "Read only"),
        "Signed.x83",
      ).addItem(),
      "Signed.x83",
    );
    return doc
      .setRichText(doc.items[0], 0, "Nur lesen und kopieren")
      .replace(
        "</GAEB>",
        '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></GAEB>',
      );
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "Signed.x83",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  const field = page.locator('[data-gaeb-field$=":text:0"]').first();
  await field.waitFor();
  await page
    .getByRole("separator", { name: "Breite der Gliederung", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const input = page.locator("textarea.gaeb-canvas-input");
  assert.equal(await input.getAttribute("readonly"), "");
  await input.press("Control+a");
  await input.press("Control+c");
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "Nur lesen und kopieren",
  );
  await input.press("Backspace");
  await input.press("Control+v");
  assert.equal(await input.inputValue(), "Nur lesen und kopieren");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Datei herunterladen", exact: true })
    .click();
  assert.equal(await readFile(await (await download).path(), "utf8"), xml);
  await context.close();
});

test("Enter preserves preceding canvas lines and never paints placeholders inside nonempty paragraphs", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.closest(".gaeb-canvas-tile"))
        this.canvas.__textCalls = [];
      return clear.apply(this, args);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      value,
      x,
      y,
      ...rest
    ) {
      if (this.canvas.closest(".gaeb-canvas-tile"))
        (this.canvas.__textCalls ??= []).push({
          value,
          x,
          y,
          font: this.font,
          color: this.fillStyle,
        });
      return fill.call(this, value, x, y, ...rest);
    };
  });
  const page = await context.newPage();
  await page.goto(base);
  const xml = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    return new GaebDocument(
      createGaebXml("83", "Stable paragraphs"),
      "Paragraphs.x83",
    )
      .addItem()
      .replace(
        /(?<=<DetailTxt><Text>)<p><span(?: style="font-weight:bold")?>…<\/span><\/p>/,
        '<p><span style="font-size: 12px">Alpha</span></p><p><span style="font-size: 36px">Beta</span></p>',
      );
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "Paragraphs.x83",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await focusEditableField(
    page.locator('[data-gaeb-field$=":text:0"]').first(),
  );
  const input = page.locator("textarea.gaeb-canvas-input");
  const drawing = () =>
    page
      .locator(".gaeb-canvas-tile canvas")
      .evaluateAll((nodes) => nodes.flatMap((node) => node.__textCalls ?? []));
  const paragraphText = (calls) =>
    calls.filter((call) => ["Alpha", "Beta", "Gamma"].includes(call.value));
  let before = paragraphText(await drawing());
  assert.equal(
    before.find((call) => call.value === "Beta").y -
      before.find((call) => call.value === "Alpha").y,
    24,
  );
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
  );
  await input.press("Control+End");
  await input.press("Enter");
  assert.deepEqual(paragraphText(await drawing()), before);
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
    "Empty paragraphs remain blank without helper text",
  );
  await input.pressSequentially("Gamma");
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
  );
  const preview = paragraphText(await drawing());
  assert.deepEqual(
    preview.filter((call) => call.value !== "Gamma"),
    before,
  );
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.deepEqual(
    paragraphText(await drawing()),
    preview,
    "Autosave must not reflow earlier paragraphs",
  );
  await input.press("Control+Home");
  await input.press("ArrowDown");
  await input.press("ArrowRight");
  await input.press("ArrowRight");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "Alpha\nBe\nta\nGamma");
  assert.deepEqual(
    (await drawing()).find((call) => call.value === "Alpha"),
    before.find((call) => call.value === "Alpha"),
  );
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
  );
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await input.press("Backspace");
  assert.equal(await input.inputValue(), "Alpha\nBeta\nGamma");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
  );
  await input.press("Control+Home");
  await input.press("Enter");
  await input.press("Enter");
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
  );
  await input.press("ArrowUp");
  assert.equal(await input.evaluate((node) => node.selectionStart), 1);
  await input.press("ArrowUp");
  assert.equal(await input.evaluate((node) => node.selectionStart), 0);
  await input.press("ArrowDown");
  assert.equal(await input.evaluate((node) => node.selectionStart), 1);
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
  );
  await page.reload();
  await focusEditableField(
    page.locator('[data-gaeb-field$=":text:0"]').first(),
  );
  assert.equal(await input.inputValue(), "\n\nAlpha\nBeta\nGamma");
  assert.equal(
    (await drawing()).filter((call) => call.value === "…").length,
    0,
  );
  await context.close();
});

test("native hierarchical sections retain item XML and numbering through pricing, orders and measurements", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      deriveGaebDocument,
      validateGaebInBrowser,
    } = await import("/editor.js");
    const checks = [];
    for (const phase of ["83", "84", "86", "87", "31"]) {
      let doc = new GaebDocument(
        createGaebXml(phase, "Hierarchy"),
        `Hierarchy.x${phase}`,
      );
      doc = new GaebDocument(doc.addItem(), doc.fileName);
      const originalId = doc.items[0].element.getAttribute("ID");
      doc = new GaebDocument(
        doc.source.replace(
          "<Item ID=",
          '<Item xmlns:v="urn:keep" v:keep="untouched" ID=',
        ),
        doc.fileName,
      );
      const before = doc.source.match(/<Item[\s\S]*?<\/Item>/)[0];
      doc = new GaebDocument(
        doc.addCategory(undefined, "Fassade"),
        doc.fileName,
      );
      const first = doc.entries.find((entry) => entry.kind === "category");
      doc = new GaebDocument(doc.addItem(first), doc.fileName);
      doc = new GaebDocument(doc.addCategory(undefined, "Dach"), doc.fileName);
      const second = doc.entries.filter(
        (entry) => entry.kind === "category" && entry.depth === 0,
      )[1];
      doc = new GaebDocument(doc.addItem(second), doc.fileName);
      doc = new GaebDocument(
        doc.addCategory(
          doc.entries.find((entry) => entry.key === first.key),
          "Dämmung",
        ),
        doc.fileName,
      );
      const subgroup = doc.entries.find(
        (entry) =>
          entry.kind === "category" &&
          doc.parentCategory(entry)?.key === first.key,
      );
      doc = new GaebDocument(doc.addItem(subgroup), doc.fileName);
      const valid = await validateGaebInBrowser(doc.source, doc.identity);
      checks.push({
        phase,
        valid: valid.valid,
        issues: valid.issues,
        originalId: doc.items[0].element.getAttribute("ID") === originalId,
        raw:
          phase === "83" || phase === "31"
            ? doc.source.includes(before)
            : doc.source.includes('v:keep="untouched"'),
        itemNumbers: doc.items.map((entry) => entry.oz),
        levels: [
          ...doc.xml.getElementsByTagNameNS(doc.namespace, "BoQBkdn"),
        ].filter((part) => doc.value(part, "Type") === "BoQLevel").length,
      });
      if (phase === "83") {
        const bid = deriveGaebDocument(doc.source, "84", { ownCompany: "AN" });
        const bidDoc = new GaebDocument(bid, "Bid.x84");
        checks.push({
          phase: "derived84",
          valid: (await validateGaebInBrowser(bid, bidDoc.identity)).valid,
          itemNumbers: bidDoc.items.map((entry) => entry.oz),
        });
        const measured = deriveGaebDocument(bid, "31", {
          referenceXml: doc.source,
        });
        const measuredDoc = new GaebDocument(measured, "Measured.x31");
        checks.push({
          phase: "derived31",
          valid: (await validateGaebInBrowser(measured, measuredDoc.identity))
            .valid,
          itemNumbers: measuredDoc.items.map((entry) => entry.oz),
        });
      }
    }
    return checks;
  });
  for (const entry of result) {
    assert.equal(entry.valid, true, JSON.stringify(entry));
    assert.deepEqual(entry.itemNumbers, ["1.1.1", "1.1.2", "1.1.3", "2._.1"]);
    if (entry.originalId !== undefined) {
      assert.equal(entry.originalId, true);
      assert.equal(entry.raw, true);
      assert.equal(entry.levels, 2);
    }
  }
  await page.close();
});

test("hierarchy moves, reorders and deletes preserve native content and valid global numbering in all phases", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml, validateGaebInBrowser } =
      await import("/editor.js");
    const checks = [];
    for (const phase of ["83", "84", "86", "87", "31"]) {
      let doc = new GaebDocument(
        createGaebXml(phase, "Moves"),
        `Moves.x${phase}`,
      );
      const step = async (xml, label) => {
        doc = new GaebDocument(xml, doc.fileName);
        const validation = await validateGaebInBrowser(
          doc.source,
          doc.identity,
        );
        checks.push({
          phase,
          label,
          valid: validation.valid,
          issues: validation.issues,
          numbers: doc.items.map((item) => item.oz),
        });
      };
      await step(doc.addCategory(undefined, "A"), "A");
      const aKey = doc.entries[0].key;
      await step(doc.addItem(doc.entries[0]), "A item");
      const aItem = doc.items[0].key;
      doc = new GaebDocument(
        doc.setValue(doc.items[0], "Qty", "2.000"),
        doc.fileName,
      );
      const raw = doc.source.match(/<Item[\s\S]*?<\/Item>/)[0];
      await step(doc.addCategory(undefined, "B"), "B");
      const bKey = doc.entries.find(
        (item) => item.kind === "category" && item.key !== aKey,
      ).key;
      await step(
        doc.addItem(doc.entries.find((item) => item.key === bKey)),
        "B item",
      );
      const bItem = doc.items.find((item) => item.key !== aItem).key;
      await step(
        doc.moveEntry(
          doc.entries.find((item) => item.key === bKey),
          doc.entries.find((item) => item.key === aKey),
        ),
        "indent",
      );
      if (!doc.source.includes(raw))
        throw new Error("Moving a title altered its untouched item XML");
      await step(
        doc.moveEntry(doc.entries.find((item) => item.key === bKey)),
        "outdent",
      );
      const leafB = doc
        .children(doc.entries.find((item) => item.key === bKey))
        .find((item) => item.kind === "category");
      await step(
        doc.moveEntry(
          doc.entries.find((item) => item.key === aItem),
          leafB,
        ),
        "move item",
      );
      if (
        doc.quantity(doc.entries.find((item) => item.key === aItem)) !== "2.000"
      )
        throw new Error("Quantity lost");
      await step(
        doc.reorderEntry(
          doc.entries.find((item) => item.key === aItem),
          -1,
        ),
        "reorder items",
      );
      if (doc.items[0].key !== aItem) throw new Error("Incorrect item order");
      await step(
        doc.reorderEntry(
          doc.entries.find((item) => item.key === bKey),
          -1,
        ),
        "reorder sections",
      );
      await step(
        doc.removeEntry(doc.entries.find((item) => item.key === aKey)),
        "remove empty section",
      );
      if (
        !doc.items.some((item) => item.key === aItem) ||
        !doc.items.some((item) => item.key === bItem)
      )
        throw new Error("Moved items were deleted with their old parent");
      const cycle = doc.entries.find((item) => item.key === bKey);
      let blocked = false;
      try {
        doc.moveEntry(cycle, doc.parentCategory(doc.items[0]));
      } catch (error) {
        blocked = error.message === "hierarchy-cycle";
      }
      if (!blocked) throw new Error("Cycle was not blocked");
    }
    return checks;
  });
  for (const check of result)
    assert.equal(check.valid, true, JSON.stringify(check));
  await page.close();
});

test("moving entries retains inherited namespaces and protects referenced or indexed numbering", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    let doc = new GaebDocument(createGaebXml("83", "Namespaces"), "Ns.x83");
    doc = new GaebDocument(doc.addCategory(undefined, "A"), doc.fileName);
    const a = doc.entries[0].key;
    doc = new GaebDocument(doc.addItem(doc.entries[0]), doc.fileName);
    const item = doc.items[0].key;
    doc = new GaebDocument(doc.addCategory(undefined, "B"), doc.fileName);
    const b = doc.entries.find(
      (entry) => entry.kind === "category" && entry.key !== a,
    ).key;
    const owner = doc.entries.find((entry) => entry.key === a).element;
    const raw = doc.source.replace(
      `<BoQCtgy ID="${owner.getAttribute("ID")}"`,
      `<BoQCtgy xmlns:v="urn:original" xml:lang="de" ID="${owner.getAttribute("ID")}"`,
    );
    doc = new GaebDocument(
      raw.replace(
        "<Item ID=",
        '<Item v:RNoPart="vendor-value" v:flag="keep" ID=',
      ),
      doc.fileName,
    );
    const before = doc.source;
    doc = new GaebDocument(
      doc.moveEntry(
        doc.entries.find((entry) => entry.key === item),
        doc.entries.find((entry) => entry.key === b),
      ),
      doc.fileName,
    );
    const moved = doc.items.find((entry) => entry.key === item).element;
    let referenced = false,
      indexed = false;
    const ref = new GaebDocument(
      before.replace("</Item>", "<RefRNo>1.1</RefRNo></Item>"),
      doc.fileName,
    );
    try {
      ref.reorderEntry(
        ref.entries.find((entry) => entry.key === b),
        -1,
      );
    } catch (error) {
      referenced = error.message === "hierarchy-reference";
    }
    const index = new GaebDocument(
      before.replace('v:flag="keep"', 'v:flag="keep" RNoIndex="A"'),
      doc.fileName,
    );
    try {
      index.reorderEntry(
        index.entries.find((entry) => entry.key === b),
        -1,
      );
    } catch (error) {
      indexed = error.message === "hierarchy-numbering";
    }
    return {
      namespace: moved.getAttributeNS("urn:original", "flag"),
      vendorNumber: moved.getAttributeNS("urn:original", "RNoPart"),
      language: moved.getAttribute("xml:lang"),
      referenced,
      indexed,
    };
  });
  assert.deepEqual(result, {
    namespace: "keep",
    vendorNumber: "vendor-value",
    language: "de",
    referenced: true,
    indexed: true,
  });
  await page.close();
});

test("pricing updates follow item identities after hierarchy changes and never copy a reused number's price", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      deriveGaebDocument,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let scope = new GaebDocument(createGaebXml("83", "Prices"), "Scope.x83");
    scope = new GaebDocument(scope.addItem(), scope.fileName);
    scope = new GaebDocument(scope.addItem(), scope.fileName);
    const [one, two] = scope.items.map((item) => item.key);
    let bid = new GaebDocument(
      deriveGaebDocument(scope.source, "84"),
      "Bid.x84",
    );
    bid = new GaebDocument(
      bid.setValue(bid.items[0], "UP", "11.000"),
      bid.fileName,
    );
    bid = new GaebDocument(
      bid.setValue(bid.items[1], "UP", "22.000"),
      bid.fileName,
    );
    scope = new GaebDocument(
      scope.reorderEntry(scope.items[1], -1),
      scope.fileName,
    );
    scope = new GaebDocument(scope.addItem(), scope.fileName);
    const added = scope.items.find(
      (item) => ![one, two].includes(item.key),
    ).key;
    scope = new GaebDocument(
      scope.moveEntry(
        scope.items.find((item) => item.key === added),
        undefined,
        scope.items.find((item) => item.key === one),
      ),
      scope.fileName,
    );
    scope = new GaebDocument(
      scope.addCategory(undefined, "Work"),
      scope.fileName,
    );
    const updated = new GaebDocument(
      deriveGaebDocument(scope.source, "84", { pricesXml: bid.source }),
      bid.fileName,
    );
    return {
      prices: updated.items.map((item) => [
        item.key,
        updated.value(item.element, "UP"),
      ]),
      one,
      two,
      added,
      valid: (await validateGaebInBrowser(updated.source, updated.identity))
        .valid,
    };
  });
  assert.equal(result.valid, true);
  assert.deepEqual(Object.fromEntries(result.prices), {
    [result.one]: "11.000",
    [result.two]: "22.000",
    [result.added]: "0.000",
  });
  await page.close();
});

test("previous positions autocomplete searches descriptions and inserts short text, description and unit", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  page.setDefaultTimeout(8000);
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("Revisionsklappe\nBrandschutzplatte montieren");
  await page.getByRole("button", { name: "Einheit", exact: true }).focus();
  await input.fill("m²");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page.getByRole("button", { name: "Schließen", exact: true }).click();
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  const search = page.getByRole("combobox", {
    name: "Bisherige Positionen durchsuchen",
    exact: true,
  });
  await search.fill("montieren Revisionsklappe");
  await page
    .getByRole("option", { name: /Revisionsklappe.*Brandschutzplatte/ })
    .click();
  await page.getByRole("button", { name: "Text 1 – 1", exact: true }).focus();
  assert.equal(
    await input.inputValue(),
    "Revisionsklappe\nBrandschutzplatte montieren",
  );
  await page.getByRole("button", { name: "Einheit", exact: true }).focus();
  assert.equal(await input.inputValue(), "m²");
  await page.getByRole("button", { name: "Menge", exact: true }).focus();
  assert.equal(
    await input.inputValue(),
    "0.000",
    "Past quantities are not copied into the new offer",
  );
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  await input.fill("Nachfolgende Position");
  const existing = await page
    .locator(".gaeb-outline [data-gaeb-entry]")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-gaeb-entry")),
    );
  await page
    .getByRole("button", { name: "Menge", exact: true })
    .first()
    .focus();
  await input.fill("2.000");
  await page
    .locator(".gaeb-document-scroll")
    .click({ position: { x: 4, y: 4 } });
  await search.fill("Brandschutz");
  await page
    .getByRole("option", { name: /Revisionsklappe.*Brandschutzplatte/ })
    .click();
  const inserted = await page
    .locator(".gaeb-outline [data-gaeb-entry]")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-gaeb-entry")),
    );
  assert.equal(inserted.length, 3);
  assert.equal(inserted[0], existing[0]);
  assert.equal(
    inserted[2],
    existing[1],
    "The reused position follows the last edited item, including after clearing focus",
  );
  await page.close();
});

test("heading levels align with items, descriptions stay normal and F2 preserves descriptions", async () => {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1400 },
  });
  await context.addInitScript(() => {
    const paint = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      value,
      x,
      y,
      ...rest
    ) {
      if (this.canvas.closest(".gaeb-canvas-tile"))
        (this.canvas.__calls ??= []).push({ value, x, y, font: this.font });
      return paint.call(this, value, x, y, ...rest);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await createSection(page, "Hauptgruppe");
  await createSection(page, "Untergruppe", true);
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const input = page.locator("textarea.gaeb-canvas-input");
  await page.getByRole("button", { name: "Text 1.1 – 1", exact: true }).focus();
  await input.press("End");
  await input.press("Enter");
  await input.type("Gruppenbeschreibung");
  await entryAction(page, "Untergruppe", "Umbenennen");
  const groupName = outline.getByRole("textbox", {
    name: "Titelbezeichnung",
    exact: true,
  });
  assert.equal(await groupName.inputValue(), "Untergruppe");
  await groupName.fill("Untertitel");
  await groupName.press("Enter");
  await page.getByRole("button", { name: "Text 1.1 – 1", exact: true }).focus();
  assert.equal(await input.inputValue(), "Untertitel\nGruppenbeschreibung");
  for (const title of ["Ebene3", "Ebene4", "Ebene5"])
    await createSection(page, title, true);
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  await input.fill("Kurztext");
  await input.press("End");
  await input.press("Enter");
  await input.type("Leistungsbeschreibung");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await outline.getByText("Kurztext", { exact: true }).click();
  await outline.locator('[aria-selected="true"]').press("F2");
  const rename = outline.getByRole("textbox", {
    name: "Titelbezeichnung",
    exact: true,
  });
  assert.equal(await rename.inputValue(), "Kurztext");
  await rename.fill("Neuer Kurztext");
  await rename.press("Enter");
  await page
    .getByRole("button", { name: "Text 1.1.1.1.1.1 – 1", exact: true })
    .focus();
  assert.equal(
    await input.inputValue(),
    "Neuer Kurztext\nLeistungsbeschreibung",
  );
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const calls = await page
    .locator("canvas")
    .first()
    .evaluate((node) => node.__calls ?? []);
  const latest = (value) => calls.filter((call) => call.value === value).at(-1);
  const main = latest("Hauptgruppe"),
    sub = latest("Untertitel"),
    title = latest("Neuer"),
    description = latest("Leistungsbeschreibung"),
    groupDescription = latest("Gruppenbeschreibung");
  assert.equal(main.x, sub.x);
  assert.equal(main.x, title.x);
  assert.equal(main.x, description.x);
  assert.equal(main.x, groupDescription.x);
  assert.match(main.font, /(?:600|700|bold) 20px/);
  assert.match(sub.font, /(?:600|700|bold) 18px/);
  assert.match(latest("Ebene3").font, /(?:600|700|bold) 17px/);
  assert.match(latest("Ebene4").font, /(?:600|700|bold) 16px/);
  assert.match(latest("Ebene5").font, /(?:600|700|bold) 15px/);
  assert.match(title.font, /(?:600|700|bold) 14px/);
  assert.doesNotMatch(description.font, /(?:600|700|bold) /);
  assert.doesNotMatch(groupDescription.font, /(?:600|700|bold) /);
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(
        process.env.SORTSYS_UI_SCREENSHOTS,
        "compact-hierarchy-typography.png",
      ),
    });
  await context.close();
});

test("mixed folders move a deep item directly into its ancestor and interleave groups and items without visible helper groups", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      validateGaebInBrowser,
      deriveGaebDocument,
    } = await import("/editor.js");
    const checks = [];
    for (const phase of ["83", "84", "86", "87", "31"]) {
      let doc = new GaebDocument(
        createGaebXml(phase, "Mixed"),
        `Mixed.x${phase}`,
      );
      const step = async (source, label) => {
        doc = new GaebDocument(source, doc.fileName);
        const valid = await validateGaebInBrowser(doc.source, doc.identity);
        if (!valid.valid) throw new Error(label + JSON.stringify(valid.issues));
      };
      await step(doc.addCategory(undefined, "A"), "A");
      const a = doc.outlineEntries[0].key;
      await step(
        doc.addCategory(
          doc.entries.find((e) => e.key === a),
          "B",
        ),
        "B",
      );
      const b = doc.outlineEntries.at(-1).key;
      await step(
        doc.addCategory(
          doc.entries.find((e) => e.key === b),
          "C",
        ),
        "C",
      );
      const c = doc.outlineEntries.at(-1).key;
      await step(
        doc.addItemInCategory(doc.entries.find((e) => e.key === c)),
        "Deep item",
      );
      const item = doc.items[0].key;
      await step(doc.addCategory(undefined, "Sibling"), "Sibling group");
      const sibling = doc.outlineEntries.at(-1).key;
      await step(
        doc.moveEntry(
          doc.entries.find((e) => e.key === sibling),
          doc.entries.find((e) => e.key === c),
          doc.entries.find((e) => e.key === item),
        ),
        "Group before an item in a previously items-only folder",
      );
      if (
        JSON.stringify(
          doc
            .outlineChildren(doc.entries.find((e) => e.key === c))
            .map((e) => e.key),
        ) !== JSON.stringify([sibling, item])
      )
        throw new Error("Group did not precede the existing item");
      await step(
        doc.moveEntry(doc.entries.find((e) => e.key === sibling)),
        "Group back to root",
      );
      await step(
        doc.removeEntry(doc.entries.find((e) => e.key === sibling)),
        "Remove temporary group",
      );
      await step(
        doc.moveEntry(
          doc.entries.find((e) => e.key === item),
          doc.entries.find((e) => e.key === a),
        ),
        "Move directly to A",
      );
      if (doc.outlineParent(doc.entries.find((e) => e.key === item))?.key !== a)
        throw new Error("Item is not directly in A");
      if (doc.outlineEntries.length !== 4)
        throw new Error("Extra visible groups");
      await step(
        doc.addItemInCategory(doc.entries.find((e) => e.key === a)),
        "Second direct item",
      );
      const item2 = doc.items.find((e) => e.key !== item).key;
      if (phase === "83") {
        const secondId = doc.entries
          .find((entry) => entry.key === item2)
          .element.getAttribute("ID");
        let vendor = new GaebDocument(
          doc.source
            .replace(
              /(<BoQCtgy ID="sortsys_direct_[\s\S]*?<BoQBody><Itemlist)/,
              '$1 xmlns:v="urn:keep-list" v:metadata="retain"',
            )
            .replace(`ID="${secondId}"`, `ID="${secondId}" v:keep="retained"`),
          doc.fileName,
        );
        vendor = new GaebDocument(
          vendor.moveEntry(
            vendor.entries.find((entry) => entry.key === b),
            vendor.entries.find((entry) => entry.key === a),
            vendor.entries.find((entry) => entry.key === item2),
          ),
          doc.fileName,
        );
        if (
          vendor.entries
            .find((entry) => entry.key === item2)
            .element.getAttributeNS("urn:keep-list", "keep") !== "retained"
        )
          throw new Error("Split lost inherited namespace");
        vendor = new GaebDocument(
          vendor.moveEntry(
            vendor.entries.find((entry) => entry.key === item),
            vendor.entries.find((entry) => entry.key === a),
          ),
          doc.fileName,
        );
        if (!vendor.source.includes('v:metadata="retain"'))
          throw new Error("Empty storage cleanup removed vendor metadata");
      }
      await step(
        doc.moveEntry(
          doc.entries.find((e) => e.key === b),
          doc.entries.find((e) => e.key === a),
          doc.entries.find((e) => e.key === item2),
        ),
        "Group between items",
      );
      const middle = doc
        .outlineChildren(doc.entries.find((e) => e.key === a))
        .map((e) => e.key);
      if (JSON.stringify(middle) !== JSON.stringify([item, b, item2]))
        throw new Error("Wrong mixed order: " + JSON.stringify(middle));
      await step(
        doc.moveEntry(
          doc.entries.find((e) => e.key === item2),
          doc.entries.find((e) => e.key === a),
          doc.entries.find((e) => e.key === b),
        ),
        "Item before group",
      );
      if (
        JSON.stringify(
          doc
            .outlineChildren(doc.entries.find((e) => e.key === a))
            .map((e) => e.key),
        ) !== JSON.stringify([item, item2, b])
      )
        throw new Error("Wrong reordered items");
      const loaded = new GaebDocument(doc.source, doc.fileName);
      checks.push({
        phase,
        visible: loaded.outlineEntries.length,
        items: loaded.items.length,
        parent:
          loaded.outlineParent(loaded.entries.find((e) => e.key === item))
            .key === a,
      });
      if (phase === "83") {
        const offer = new GaebDocument(
          deriveGaebDocument(doc.source, "84", { ownCompany: "AN" }),
          "Bid.x84",
        );
        if (offer.outlineEntries.some((e) => offer.isInternalCategory(e)))
          throw new Error("Native bucket exposed after pricing");
      }
    }
    return checks;
  });
  for (const check of result) {
    assert.equal(check.visible, 5);
    assert.equal(check.items, 2);
    assert.equal(check.parent, true);
  }
  await page.close();
});

test("folder creation stays empty and adding items to parents preserves IDs in every native phase", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const checks = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml, validateGaebInBrowser } =
      await import("/editor.js");
    const result = [];
    for (const phase of ["83", "84", "86", "87", "31"]) {
      let doc = new GaebDocument(
        createGaebXml(phase, "Folders"),
        `Folders.x${phase}`,
      );
      doc = new GaebDocument(doc.addItem(), doc.fileName);
      const original = doc.items[0].key;
      doc = new GaebDocument(
        doc.addEmptyCategory(undefined, "New folder", "Work items"),
        doc.fileName,
      );
      const folder = doc.children().at(-1);
      const empty = !doc.items.some((item) =>
        folder.element.contains(item.element),
      );
      const originalParent = doc.parentCategory(
        doc.items.find((item) => item.key === original),
      ).key;
      const folderKey = folder.key;
      doc = new GaebDocument(
        doc.addItemInCategory(undefined, "Work items"),
        doc.fileName,
      );
      const sameOriginalParent =
        doc.parentCategory(doc.items.find((item) => item.key === original))
          .key === originalParent;
      const ownBranch = doc.items.every(
        (item) =>
          !doc.entries
            .find((entry) => entry.key === folderKey)
            .element.contains(item.element),
      );
      doc = new GaebDocument(
        doc.addItemInCategory(
          doc.entries.find((entry) => entry.key === folderKey),
          "Work items",
        ),
        doc.fileName,
      );
      const inFolder = doc.items.filter((item) =>
        doc.entries
          .find((entry) => entry.key === folderKey)
          .element.contains(item.element),
      );
      doc = new GaebDocument(
        doc.addEmptyCategory(
          doc.entries.find((entry) => entry.key === folderKey),
          "Nested",
          "Work items",
        ),
        doc.fileName,
      );
      const nested = doc
        .children(doc.entries.find((entry) => entry.key === folderKey))
        .at(-1);
      const validation = await validateGaebInBrowser(doc.source, doc.identity);
      result.push({
        phase,
        empty,
        sameOriginalParent,
        ownBranch,
        inFolder: inFolder.length,
        nestedEmpty: !doc.items.some((item) =>
          nested.element.contains(item.element),
        ),
        ids: doc.items.map((item) => item.key),
        original,
        valid: validation.valid,
        issues: validation.issues,
      });
    }
    return result;
  });
  for (const check of checks) {
    assert.equal(check.valid, true, JSON.stringify(check));
    assert.equal(check.empty, true, JSON.stringify(check));
    assert.equal(check.sameOriginalParent, true);
    assert.equal(check.ownBranch, true);
    assert.equal(check.inFolder, 1);
    assert.equal(check.nestedEmpty, true);
    assert.equal(check.ids.length, 3);
    assert.ok(check.ids.includes(check.original));
  }
  await page.close();
});

test("blank paper, workspace and outline clear focus and selection without losing drafts", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  const editor = page.getByRole("region", { name: "GAEB-Editor", exact: true });
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("Freie Fläche");
  const field = page.getByRole("button", { name: "Text 1 – 1", exact: true });
  await editor
    .locator("canvas")
    .first()
    .click({ position: { x: 10, y: 10 } });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  assert.equal(await outline.locator('[aria-selected="true"]').count(), 0);
  assert.equal(
    await editor
      .getByText("Blaue Bereiche sind bearbeitbar", { exact: true })
      .count(),
    0,
  );
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await field.focus();
  assert.equal(await input.inputValue(), "Freie Fläche");
  await input.press("Control+a");
  await editor
    .locator(".gaeb-document-scroll")
    .click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  assert.equal(await outline.locator('[aria-selected="true"]').count(), 0);
  await outline.getByText("Freie Fläche", { exact: true }).click();
  await outline.locator('[aria-selected="true"]').waitFor();
  const tree = outline.getByRole("treegrid");
  const box = await tree.boundingBox();
  await tree.click({ position: { x: 140, y: box.height - 10 } });
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("gaeb-editor"),
  );
  assert.equal(await outline.locator('[aria-selected="true"]').count(), 0);
  await field.focus();
  assert.equal(await input.inputValue(), "Freie Fläche");
  await input.press("Control+a");
  await page.getByRole("button", { name: "Fett", exact: true }).click();
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  assert.equal(
    await outline.locator('[aria-selected="true"]').count(),
    1,
    "Formatting controls retain the active document selection",
  );
  await page.reload();
  await outline.getByText("Freie Fläche", { exact: true }).waitFor();
  await page.close();
});

test("folder explorer names inline, cancels drafts, renames with F2 and reopens collapsed ancestors", async () => {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const name = outline.getByRole("textbox", {
    name: "Titelbezeichnung",
    exact: true,
  });
  await outline
    .getByRole("button", { name: "Neuer Titel", exact: true })
    .click();
  await name.fill("Nicht anlegen");
  await name.press("Escape");
  assert.equal(
    await outline.getByText("Nicht anlegen", { exact: true }).count(),
    0,
  );
  await createSection(page, "Fassade");
  await createSection(page, "Fenster", true);
  await createSection(page, "Beschläge", true);
  await outline.locator('[aria-selected="true"]').press("F2");
  assert.equal(await name.inputValue(), "Beschläge");
  await name.fill("Griffe");
  await name.press("Escape");
  await outline.getByText("Beschläge", { exact: true }).waitFor();
  await outline.locator('[aria-selected="true"]').press("F2");
  await name.fill("Griffe");
  await name.press("Enter");
  await outline.getByText("Griffe", { exact: true }).waitFor();
  await outline
    .getByRole("button", { name: "Alle Titel einklappen", exact: true })
    .click();
  assert.equal(
    await outline.getByText("Griffe", { exact: true }).isVisible(),
    false,
  );
  await outline
    .getByRole("button", { name: "Neuer Titel", exact: true })
    .click();
  await name.waitFor({ state: "visible" });
  await name.fill("Rosetten");
  await name.press("Enter");
  await outline.getByText("Rosetten", { exact: true }).waitFor();
  await entryAction(page, "Fenster", "Umbenennen");
  await name.fill("Fenster und Türen");
  await name.press("Tab");
  await outline.getByText("Fenster und Türen", { exact: true }).waitFor();
  await outline.getByText("Fenster und Türen", { exact: true }).click();
  assert.equal(
    await outline.getByText("Rosetten", { exact: true }).isVisible(),
    false,
  );
  await outline.getByText("Fenster und Türen", { exact: true }).click();
  await outline.getByText("Rosetten", { exact: true }).waitFor();
  assert.equal(
    await outline.locator('[data-slot="select-trigger"]').count(),
    0,
  );
  assert.equal(
    await outline.getByText("Einfügen in", { exact: true }).count(),
    0,
  );
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.SORTSYS_UI_SCREENSHOTS, "folder-explorer.png"),
    });
  await page.reload();
  await outline.getByText("Fenster und Türen", { exact: true }).waitFor();
  await outline.getByText("Rosetten", { exact: true }).waitFor();
  await page.close();
});

test("visible hierarchy actions move items between sections, reorder with the keyboard, rename and undo deletion", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const input = page.locator("textarea.gaeb-canvas-input");
  await createSection(page, "Fassade");
  await outline
    .getByRole("button", { name: "Neue Position", exact: true })
    .click();
  await input.fill("Alpha");
  await outline
    .getByRole("button", { name: "Neue Position", exact: true })
    .click();
  await input.fill("Beta");
  await outline
    .getByRole("button", { name: "Gesamtes Dokument", exact: true })
    .click();
  await outline
    .getByRole("button", { name: "Neuer Titel", exact: true })
    .click();
  const sectionForm = outline.getByRole("form", {
    name: "Titel anlegen",
    exact: true,
  });
  const sectionName = sectionForm.getByRole("textbox", {
    name: /^Titelbezeichnung/,
  });
  await sectionName.fill("Entwurf");
  await sectionName.press("Control+z");
  await outline.getByText("Beta", { exact: true }).waitFor();
  await sectionName.fill("Innen");
  await sectionName.press("Enter");
  await outline
    .getByRole("button", { name: "Neue Position", exact: true })
    .click();
  await input.fill("Gamma");
  await outline.getByText("Alpha", { exact: true }).click();
  await outline.getByText("Alpha", { exact: true }).click({ button: "right" });
  assert.equal(
    await page
      .getByRole("menuitem", { name: "Verschieben …", exact: true })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  const alphaRow = outline
    .locator("[data-gaeb-entry]")
    .filter({ has: page.getByText("Alpha", { exact: true }) });
  const gammaRow = outline
    .locator("[data-gaeb-entry]")
    .filter({ has: page.getByText("Gamma", { exact: true }) });
  const gammaBox = await gammaRow.boundingBox();
  await alphaRow.dragTo(gammaRow, {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 140, y: gammaBox.height - 2 },
  });
  await outline.getByText("Alpha", { exact: true }).click();
  const alpha = outline
    .locator(".gaeb-tree-row")
    .filter({ has: page.getByText("Alpha", { exact: true }) });
  assert.match(await alpha.innerText(), /2\.2/);
  await page.keyboard.press("Alt+ArrowUp");
  assert.match(await alpha.innerText(), /2\.1/);
  await page.keyboard.press("F2");
  const rename = outline.getByRole("textbox", {
    name: "Titelbezeichnung",
    exact: true,
  });
  assert.equal(await rename.inputValue(), "Alpha");
  await page.waitForFunction(
    (node) => node.selectionEnd - node.selectionStart === 5,
    await rename.elementHandle(),
  );
  assert.equal(
    await rename.evaluate((node) => node.selectionEnd - node.selectionStart),
    5,
  );
  await rename.fill("Alpha neu");
  await rename.press("Enter");
  await outline.getByText("Beta", { exact: true }).click();
  await entryAction(page, "Beta", "Löschen");
  const removal = outline.getByRole("form", {
    name: "Eintrag löschen",
    exact: true,
  });
  await removal.getByRole("button", { name: "Löschen", exact: true }).click();
  assert.equal(await outline.getByText("Beta", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await outline.getByText("Beta", { exact: true }).waitFor();
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.SORTSYS_UI_SCREENSHOTS, "hierarchy-moved.png"),
    });
  await page.reload();
  await outline.getByText("Alpha neu", { exact: true }).waitFor();
  await outline.getByText("Beta", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("folder keyboard moves apply directly and Escape cancels subtree deletion", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const input = page.locator("textarea.gaeb-canvas-input");
  await createSection(page, "Aussen");
  await outline
    .getByRole("button", { name: "Neue Position", exact: true })
    .click();
  await input.fill("Dämmplatten");
  await createSection(page, "Innen");
  await outline
    .getByRole("button", { name: "Neue Position", exact: true })
    .click();
  await input.fill("Trockenbau");
  await outline.getByText("Innen", { exact: true }).click();
  await outline.locator('[aria-selected="true"]').focus();
  await page.keyboard.press("Control+Alt+ArrowRight");
  const row = outline
    .locator(".gaeb-tree-row")
    .filter({ has: page.getByText("Innen", { exact: true }) });
  await row.getByText("1.2", { exact: true }).waitFor();
  assert.equal(await outline.getByRole("form").count(), 0);
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await row.getByText("2", { exact: true }).waitFor();
  await entryAction(page, "Innen", "Löschen");
  const removal = outline.getByRole("form", {
    name: "Eintrag löschen",
    exact: true,
  });
  await removal.getByText(/enthaltene Position/).waitFor();
  await page.keyboard.press("Escape");
  await removal.waitFor({ state: "hidden" });
  await row.locator("button.gaeb-tree-chevron").click();
  await outline.getByText("Trockenbau", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Start", exact: true }).click();
  await page
    .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
    .waitFor();
  await page.close();
});

test("dragging rows reorders items without arrow buttons and supports keyboard drag cancellation", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const input = page.locator("textarea.gaeb-canvas-input");
  for (const label of ["Alpha", "Beta", "Gamma"]) {
    await page
      .getByRole("button", { name: "Position hinzufügen", exact: true })
      .click();
    await input.fill(label);
  }
  const row = (label) =>
    outline
      .locator("[data-gaeb-entry]")
      .filter({ has: page.getByText(label, { exact: true }) });
  assert.equal(
    await outline.getByRole("button", { name: /^Nach (oben|unten)$/ }).count(),
    0,
  );
  await row("Gamma").dragTo(row("Alpha"), {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 140, y: 2 },
  });
  await row("Gamma").getByText("1", { exact: true }).waitFor();
  await row("Alpha").getByText("2", { exact: true }).waitFor();
  const handle = row("Gamma").getByRole("button", {
    name: /Eintrag verschieben/,
  });
  await handle.focus();
  await handle.press("Enter");
  await page.keyboard.press("Escape");
  await row("Gamma").getByText("1", { exact: true }).waitFor();
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  await page.reload();
  await row("Gamma").getByText("1", { exact: true }).waitFor();
  await row("Beta").getByText("3", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("dragging into sections reparents entire subtrees, rejects cycles and supports the document root", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  const input = page.locator("textarea.gaeb-canvas-input");
  const row = (label) =>
    outline
      .locator("[data-gaeb-entry]")
      .filter({ has: page.getByText(label, { exact: true }) });
  await createSection(page, "Fassade");
  await outline
    .getByRole("button", { name: "Neue Position", exact: true })
    .click();
  await input.fill("Alpha");
  await createSection(page, "Innen");
  await outline
    .getByRole("button", { name: "Neue Position", exact: true })
    .click();
  await input.fill("Beta");
  await row("Beta").dragTo(row("Fassade"), {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 170, y: 20 },
  });
  await row("Beta").getByText("1.2", { exact: true }).waitFor();
  await row("Fassade").locator("button.gaeb-tree-chevron").click();
  assert.equal(await row("Alpha").isVisible(), false);
  const draggingBox = await row("Innen").boundingBox();
  const destinationBox = await row("Fassade").boundingBox();
  await page.mouse.move(draggingBox.x + 140, draggingBox.y + 18);
  await page.mouse.down();
  await page.mouse.move(draggingBox.x + 150, draggingBox.y + 18);
  await page.mouse.move(destinationBox.x + 170, destinationBox.y + 20, {
    steps: 10,
  });
  await row("Alpha").waitFor({ state: "visible" });
  await row("Fassade").and(page.locator("[data-drop-target]")).waitFor();
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(
        process.env.SORTSYS_UI_SCREENSHOTS,
        "hierarchy-drop-target.png",
      ),
    });
  await page.mouse.up();
  await row("Innen").getByText("1.2", { exact: true }).waitFor();
  await row("Beta").getByText("1.1.2", { exact: true }).waitFor();
  await row("Fassade").dragTo(row("Innen"), {
    sourcePosition: { x: 140, y: 18 },
    targetPosition: { x: 170, y: 20 },
  });
  await row("Fassade").getByText("1", { exact: true }).waitFor();
  await row("Innen").getByText("1.2", { exact: true }).waitFor();
  await row("Innen").dragTo(
    outline.getByRole("button", { name: "Gesamtes Dokument", exact: true }),
  );
  await row("Innen").getByText("2", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Start", exact: true }).click();
  await page
    .locator('xpath=descendant-or-self::*[@data-schema-state="valid"]')
    .waitFor();
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.SORTSYS_UI_SCREENSHOTS, "hierarchy-dragged.png"),
    });
  assert.deepEqual(errors, []);
  await page.close();
});

test("editor creates named sections with explicit parents and keeps the hierarchy visible", async (t) => {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (error) => t.diagnostic(error.stack));
  await page.goto(base);
  await page
    .getByRole("button", { name: "Neue Angebotsaufforderung", exact: true })
    .click();
  await createSection(page, "Fassade");
  await createSection(page, "Wärmedämmung", true);
  const input = page.locator("textarea.gaeb-canvas-input");
  await page
    .getByRole("button", { name: "Position hinzufügen", exact: true })
    .click();
  await input.fill("WDVS Fassadenfront 2x2m");
  await input.press("Tab");
  await input.fill("4.000");
  await page
    .locator('xpath=descendant-or-self::*[@data-save-state="saved"]')
    .waitFor();
  const outline = page.getByRole("navigation", {
    name: "Dokumentgliederung",
    exact: true,
  });
  await outline.getByText("Fassade", { exact: true }).waitFor();
  await outline.getByText("Wärmedämmung", { exact: true }).waitFor();
  await outline.getByText("WDVS Fassadenfront 2x2m", { exact: true }).waitFor();
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.SORTSYS_UI_SCREENSHOTS, "hierarchy-desktop.png"),
    });
  await page.reload();
  await outline.getByText("WDVS Fassadenfront 2x2m", { exact: true }).waitFor();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("[data-exiting]"));
  await page.setViewportSize({ width: 390, height: 900 });
  await page
    .getByRole("navigation", { name: "Document outline", exact: true })
    .waitFor();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  if (process.env.SORTSYS_UI_SCREENSHOTS)
    await page.screenshot({
      path: join(process.env.SORTSYS_UI_SCREENSHOTS, "hierarchy-mobile.png"),
    });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter(
            (node) =>
              node.getBoundingClientRect().right > innerWidth + 1 &&
              getComputedStyle(node).position !== "absolute",
          )
          .map((node) => ({
            class: node.className,
            width: node.getBoundingClientRect().width,
            right: node.getBoundingClientRect().right,
          }))
          .slice(0, 15),
      ),
    ),
  );
  await page.close();
});

test("seed native documents validate, round-trip and support their editable phases", async () => {
  // These fixtures use the exact same constructor as development seeding.
  const fixtures = await Promise.all(
    [
      "31",
      "52",
      "80",
      "81",
      "82",
      "83",
      "84",
      "85",
      "86",
      "87",
      "89",
      "93",
      "94",
      "96",
      "97",
    ].map(async (phase) => ({
      phase,
      xml: await readFile(
        new URL(`./fixtures/native-seed/demo.x${phase}`, import.meta.url),
        "utf8",
      ),
    })),
  );
  const page = await browser.newPage();
  await page.goto(base);
  const results = await page.evaluate(async (fixtures) => {
    const {
      GaebDocument,
      validateGaebInBrowser,
      phaseCanEdit,
      phaseHasPrices,
    } = await import("/editor.js");
    const output = [];
    for (const { phase, xml } of fixtures) {
      let doc = new GaebDocument(xml, `Seed.x${phase}`);
      const before = await validateGaebInBrowser(xml, doc.identity);
      if (!before.valid) {
        output.push({ phase, ...before });
        continue;
      }
      if (phase === "31") {
        const first = doc.takeoff(doc.items[0]).rows[0];
        doc = new GaebDocument(
          doc.setMeasurementField(doc.items[0], first.value.id, "count", "2"),
          doc.fileName,
        );
        if (doc.takeoff(doc.items[0]).mismatch)
          throw new Error("Seed X31 calculation mismatch");
      } else if (phaseCanEdit(phase)) {
        doc = new GaebDocument(
          doc.setValue(
            doc.items[0],
            "Qty",
            phase === "93" || phase === "96" ? "8.00" : "8.000",
          ),
          doc.fileName,
        );
        if (phaseHasPrices(phase))
          doc = new GaebDocument(
            doc.setValue(
              doc.items[0],
              "UP",
              ["93", "96"].includes(phase) ? "12.00" : "12.000",
            ),
            doc.fileName,
          );
      }
      output.push({
        phase,
        ...(await validateGaebInBrowser(doc.source, doc.identity)),
        items: doc.items.length,
      });
    }
    return output;
  }, fixtures);
  for (const r of results)
    assert.equal(r.valid, true, `X${r.phase}: ${JSON.stringify(r.issues)}`);
  await page.close();
});

test("alternative, cost, trade and billing chains produce native schema-valid documents", async () => {
  const fixture = await readFile(
    new URL("./fixtures/native-seed/demo.x86", import.meta.url),
    "utf8",
  );
  const quote = await readFile(
    new URL("./fixtures/native-seed/demo.x94", import.meta.url),
    "utf8",
  );
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(
    async ({ fixture, quote }) => {
      const {
        GaebDocument,
        deriveGaebDocument,
        createInvoiceXml,
        gaebNetAmount,
        validateGaebInBrowser,
      } = await import("/editor.js");
      const checks = [];
      const check = async (xml, phase) => {
        const error = new DOMParser()
          .parseFromString(xml, "application/xml")
          .querySelector("parsererror");
        if (error)
          throw new Error(
            `X${phase}: ${error.textContent} ${xml.slice(0, 500)}`,
          );
        const d = new GaebDocument(xml, `chain.x${phase}`);
        checks.push({
          phase,
          ...(await validateGaebInBrowser(xml, d.identity)),
        });
        return d;
      };
      await check(deriveGaebDocument(fixture, "85"), "85");
      let cost = await check(deriveGaebDocument(fixture, "52"), "52");
      cost = new GaebDocument(
        cost.addCostApproach(cost.items[0]),
        cost.fileName,
      );
      cost = new GaebDocument(
        cost.setCostApproach(cost.items[0], 0, "Value", "34.500"),
        cost.fileName,
      );
      await check(cost.source, "52");
      await check(deriveGaebDocument(fixture, "93"), "93");
      await check(deriveGaebDocument(quote, "96"), "96");
      const opts = {
        kind: "progress_invoice",
        title: "Abschlag",
        vatRate: "19.00",
        invoiceDate: "2026-11-06",
        serviceStart: "2026-11-01",
        serviceEnd: "2026-11-06",
        ownCompany: "Muster GmbH",
        ownAddress: {
          streetAddress: "Beispielweg 12",
          zip: "06108",
          city: "Halle",
        },
        customerName: "Bauherr GmbH",
        customerAddress: {
          streetAddress: "Musterstraße 20",
          zip: "06108",
          city: "Halle",
        },
        taxNumber: "DEMO-123",
        lumpSum: "200.00",
      };
      const progress = await check(createInvoiceXml(fixture, opts), "89");
      const final = await check(
        createInvoiceXml(fixture, {
          ...opts,
          kind: "final_invoice",
          lumpSum: undefined,
          previousInvoices: [
            {
              invoiceNumber: "123",
              invoiceDate: "2026-11-06",
              netAmount: "200.00",
              grossAmount: "238.00",
              paidAmount: "100.00",
            },
          ],
        }),
        "89",
      );
      const full = await check(
        createInvoiceXml(fixture, {
          ...opts,
          kind: "invoice",
          lumpSum: undefined,
        }),
        "89",
      );
      const small = await check(
        createInvoiceXml(fixture, { ...opts, lumpSum: "0.03" }),
        "89",
      );
      await check(
        createInvoiceXml(fixture, {
          ...opts,
          ownAddress: undefined,
          customerAddress: undefined,
        }),
        "89",
      );
      const source = new GaebDocument(fixture, "source.x86");
      let measurement = new GaebDocument(
        deriveGaebDocument(fixture, "31", {
          selectedItemIds: [source.items[0].element.getAttribute("ID")],
        }),
        "measurement.x31",
      );
      measurement = new GaebDocument(
        measurement.setValue(measurement.items[0], "Qty", "3.000"),
        measurement.fileName,
      );
      const measuredInvoice = await check(
        createInvoiceXml(fixture, {
          ...opts,
          kind: "invoice",
          lumpSum: undefined,
          measurementXml: measurement.source,
        }),
        "89",
      );
      return {
        measuredItems: measuredInvoice.items.length,
        checks,
        progress: gaebNetAmount(progress.source),
        final: gaebNetAmount(final.source),
        full: gaebNetAmount(full.source),
        small: small.value(small.child(small.root, "Invoice"), "TotalGross"),
      };
    },
    { fixture, quote },
  );
  for (const r of result.checks)
    assert.equal(r.valid, true, `X${r.phase}: ${JSON.stringify(r.issues)}`);
  assert.equal(result.measuredItems, 1);
  assert.equal(result.progress, "200.00");
  assert.equal(Number(result.full) - Number(result.final), 200);
  assert.equal(result.small, "0.04");
  await page.close();
});

test("document designation stays out of printed documents while the actual project survives work, measurement, billing and trade derivation", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      deriveGaebDocument,
      createInvoiceXml,
      validateGaebInBrowser,
      buildGaebTypst,
    } = await import("/editor.js");
    let doc = new GaebDocument(
      createGaebXml("86", "Intern nur November"),
      "order.x86",
    );
    doc = new GaebDocument(
      doc.setProjectName("Sanierung Musterhalle"),
      doc.fileName,
    );
    doc = new GaebDocument(doc.addItem(), doc.fileName);
    doc = new GaebDocument(
      doc.setValue(doc.items[0], "Qty", "10.000"),
      doc.fileName,
    );
    doc = new GaebDocument(
      doc.setValue(doc.items[0], "UP", "20.000"),
      doc.fileName,
    );
    const measured = deriveGaebDocument(doc.source, "31", {
      title: "Intern nur Aufmaß",
    });
    const trade = deriveGaebDocument(doc.source, "93", {
      title: "Intern nur Material",
    });
    const invoice = createInvoiceXml(doc.source, {
      title: "Intern nur Rechnung",
      kind: "invoice",
      vatRate: "19.00",
      invoiceDate: "2026-11-06",
      serviceStart: "2026-11-01",
      serviceEnd: "2026-11-06",
      ownCompany: "Muster GmbH",
      customerName: "Bauherr",
      taxNumber: "DEMO-123",
    });
    const sources = [doc.source, measured, trade, invoice];
    const values = [];
    for (const xml of sources) {
      const model = new GaebDocument(xml, "document.xml");
      values.push({
        project: model.projectName(),
        valid: await validateGaebInBrowser(xml, model.identity),
        print: buildGaebTypst(xml, "Intern nur Dateiname.xml", "de"),
      });
    }
    let variation = new GaebDocument(
      createGaebXml("83", "Intern nur Nachtrag"),
      "variation.x83",
    );
    variation = new GaebDocument(
      variation.setDocumentKind("variation"),
      variation.fileName,
    );
    variation = new GaebDocument(variation.addItem(), variation.fileName);
    const offer = new GaebDocument(
      deriveGaebDocument(variation.source, "84"),
      "offer.x84",
    );
    return {
      values,
      variation: buildGaebTypst(
        offer.source,
        offer.fileName,
        "de",
        variation.source,
      ),
    };
  });
  for (const row of result.values) {
    assert.equal(row.project, "Sanierung Musterhalle");
    assert.equal(row.valid.valid, true, JSON.stringify(row.valid));
    assert.match(row.print, /Sanierung Musterhalle/);
    assert.doesNotMatch(row.print, /Intern nur/);
  }
  assert.match(result.variation, /Nachtragsangebot/);
  await page.close();
});
test(
  "embedded raster images render in Canvas and Typst without treating their base64 bytes as editable text",
  { timeout: 30000 },
  async () => {
    const page = await browser.newPage();
    await page.goto(base);
    await page.evaluate(() => {
      window.__nativeImageDraws = 0;
      window.__longText = false;
      const draw = CanvasRenderingContext2D.prototype.drawImage,
        fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
        if (image instanceof HTMLImageElement) window.__nativeImageDraws++;
        return draw.call(this, image, ...args);
      };
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        if (text.length > 300) window.__longText = true;
        return fill.call(this, text, ...args);
      };
    });
    const source = await page.evaluate(async () => {
      const { GaebDocument, createGaebXml } = await import("/editor.js");
      let doc = new GaebDocument(
        createGaebXml("83", "Bildbeschreibung"),
        "image.x83",
      );
      doc = new GaebDocument(doc.addItem(), doc.fileName);
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      const pixels = ctx.createImageData(256, 256);
      for (let i = 0; i < pixels.data.length; i++)
        pixels.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;
      ctx.putImageData(pixels, 0, 0);
      const encoded = canvas.toDataURL("image/png").split(",")[1];
      return doc.source.replace(
        "</Text>",
        `<p><image Type="image/png" Encoding="base64" width="150">${encoded}</image></p></Text>`,
      );
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "image.x83",
      mimeType: "application/xml",
      buffer: Buffer.from(source),
    });
    await page.waitForFunction(() => window.__nativeImageDraws > 0);
    assert.equal(await page.evaluate(() => window.__longText), false);
    const result = await page.evaluate(async (xml) => {
      const { gaebEmbeddedImageFiles, buildGaebTypst, compileTypst } =
        await import("/editor.js");
      const files = gaebEmbeddedImageFiles(xml),
        code = buildGaebTypst(xml, "image.x83", "de");
      const pdf = await compileTypst(code, files);
      return { files: Object.keys(files), size: pdf.length, code };
    }, source);
    assert.equal(result.files.length, 1);
    assert.match(result.code, /image\("\/gaeb-native\//);
    assert.ok(result.size > 1000);
    await page.close();
  },
);

test("GAEB 3.1 project currencies remain in the source while native X84 contains only schema-allowed project identifiers", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      deriveGaebDocument,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let original = new GaebDocument(
      createGaebXml("83", "Ausschreibung"),
      "request.x83",
    );
    original = new GaebDocument(
      original.setProjectName("Musterhalle"),
      original.fileName,
    );
    original = new GaebDocument(original.addItem(), original.fileName);
    const source = original.source
      .replaceAll(original.namespace, "http://www.gaeb.de/GAEB_DA_XML/200407")
      .replace("<Version>3.3</Version>", "<Version>3.1</Version>")
      .replace("<VersDate>2021-05</VersDate>", "<VersDate>2009-12</VersDate>")
      .replace("</PrjInfo>", "<Cur>EUR</Cur><CurLbl>Euro</CurLbl></PrjInfo>");
    const request = new GaebDocument(source, "request.x83");
    const output = deriveGaebDocument(source, "84", {
      ownCompany: "Muster GmbH",
      ownAddress: {
        streetAddress: "Musterweg 1",
        zip: "12345",
        city: "Musterstadt",
      },
    });
    const offer = new GaebDocument(output, "offer.x84");
    return {
      sourceValid: await validateGaebInBrowser(source, request.identity),
      targetValid: await validateGaebInBrowser(output, offer.identity),
      sourceUnchanged: request.source === source,
      project: offer.projectName(),
      projectTags: [...offer.child(offer.root, "PrjInfo").children].map(
        (node) => node.localName,
      ),
      currency: offer.currency,
      items: offer.items.length,
    };
  });
  assert.equal(
    result.sourceValid.valid,
    true,
    JSON.stringify(result.sourceValid),
  );
  assert.equal(
    result.targetValid.valid,
    true,
    JSON.stringify(result.targetValid),
  );
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.project, "Musterhalle");
  assert.deepEqual(result.projectTags, ["NamePrj", "LblPrj"]);
  assert.equal(result.currency, "EUR");
  assert.equal(result.items, 1);
  await page.close();
});
