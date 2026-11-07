import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
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

test("assisted X31 measures round trip, remain schema valid and preserve opaque XML", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      newMeasurement,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let doc = new GaebDocument(createGaebXml("31", "Aufmaß"), "test.x31");
    doc = new GaebDocument(doc.addItem(), doc.fileName);
    doc = new GaebDocument(
      doc.source
        .replace(
          "<Item ID=",
          '<Item xmlns:v="urn:vendor" v:keep="unbekannt" ID=',
        )
        .replace("</Item>", "<!-- fremder Kommentar --></Item>"),
      doc.fileName,
    );
    for (const row of [
      {
        ...newMeasurement("area", "wall"),
        label: "Wand & Leibung -- Süd",
        location: "EG · Raum 01",
        a: "4",
        b: "3",
      },
      {
        ...newMeasurement("area", "small"),
        label: "Fenster",
        mode: "opening",
        a: "1.2",
        b: "1.5",
        count: "10",
        threshold: "2.5",
      },
      {
        ...newMeasurement("factor", "arch"),
        label: "Bogen",
        a: ".3",
        b: "1.83",
        count: "4",
        factor: ".67",
      },
    ])
      doc = new GaebDocument(
        doc.addMeasurement(doc.items[0], row),
        doc.fileName,
      );
    const first = doc.quantity(doc.items[0]);
    const roundtrip = new GaebDocument(doc.source, doc.fileName);
    const labels = roundtrip
      .takeoff(roundtrip.items[0])
      .rows.map((row) => row.value.label);
    doc = new GaebDocument(
      doc.setMeasurementField(doc.items[0], "small", "a", "2"),
      doc.fileName,
    );
    const deducted = doc.quantity(doc.items[0]);
    doc = new GaebDocument(
      doc.removeMeasurement(doc.items[0], "arch"),
      doc.fileName,
    );
    const check = await validateGaebInBrowser(doc.source, doc.identity);
    let corrupt = new GaebDocument(
      doc.source.replace("<Qty>", "<Qty>9"),
      doc.fileName,
    );
    let protectedMismatch = false;
    try {
      corrupt.setMeasurementField(corrupt.items[0], "wall", "a", "5");
    } catch (e) {
      protectedMismatch = e.message === "takeoff-external-change";
    }
    return {
      first,
      deducted,
      final: doc.quantity(doc.items[0]),
      labels,
      valid: check.valid,
      issues: check.issues,
      keep:
        doc.source.includes('v:keep="unbekannt"') &&
        doc.source.includes("<!-- fremder Kommentar -->"),
      rows: doc
        .takeoffRows(doc.items[0])
        .map((row) => row.getAttribute("Row").length),
      protectedMismatch,
    };
  });
  assert.equal(result.first, "13.471");
  assert.equal(result.deducted, "-16.529");
  assert.equal(result.final, "-18.000");
  assert.deepEqual(result.labels, [
    "Wand & Leibung -- Süd",
    "Fenster",
    "Bogen",
  ]);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.keep, true);
  assert.deepEqual(result.rows, [80, 80]);
  assert.equal(result.protectedMismatch, true);
  await page.close();
});

test("quantity-only and unknown legacy takeoffs retain existing quantities; native FN91 stays editable", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      newMeasurement,
      rebMeasureRow,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let doc = new GaebDocument(createGaebXml("31", "Bestand"), "legacy.x31");
    doc = new GaebDocument(doc.addItem(), doc.fileName);
    doc = new GaebDocument(
      doc.setValue(doc.items[0], "Qty", "12.345"),
      doc.fileName,
    );
    const quantityOnly = new GaebDocument(
      doc.addMeasurement(doc.items[0], {
        ...newMeasurement("length", "next"),
        a: "2",
      }),
      doc.fileName,
    );
    const raw =
      " ".repeat(11) +
      "* Legacy REB with vendor formula / retained".padEnd(69, " ");
    doc = new GaebDocument(doc.addTakeoffRow(doc.items[0], raw), doc.fileName);
    doc = new GaebDocument(
      doc.addMeasurement(doc.items[0], {
        ...newMeasurement("length", "new"),
        a: "2",
      }),
      doc.fileName,
    );
    const afterAdd = doc.quantity(doc.items[0]);
    doc = new GaebDocument(
      doc.setMeasurementField(doc.items[0], "new", "a", "3"),
      doc.fileName,
    );
    const afterEdit = doc.quantity(doc.items[0]);
    doc = new GaebDocument(
      doc.removeMeasurement(doc.items[0], "new"),
      doc.fileName,
    );
    let native = new GaebDocument(createGaebXml("31", "FN91"), "native.x31");
    native = new GaebDocument(native.addItem(), native.fileName);
    native = new GaebDocument(
      native.addTakeoffRow(
        native.items[0],
        rebMeasureRow(
          {
            ...newMeasurement("formula", "unused"),
            expression: "2*3",
            label: "Room 01",
          },
          "0004A0",
        ),
      ),
      native.fileName,
    );
    native = new GaebDocument(
      native.setValue(native.items[0], "Qty", "6.000"),
      native.fileName,
    );
    const parsed = native.takeoff(native.items[0]).rows[0].value;
    native = new GaebDocument(
      native.setMeasurementField(
        native.items[0],
        parsed.id,
        "expression",
        "2*4",
      ),
      native.fileName,
    );
    const checked = await validateGaebInBrowser(native.source, native.identity);
    return {
      quantityOnly: quantityOnly.quantity(quantityOnly.items[0]),
      carried: quantityOnly.takeoff(quantityOnly.items[0]).rows[0].value.label,
      afterAdd,
      afterEdit,
      final: doc.quantity(doc.items[0]),
      raw: doc.takeoffRows(doc.items[0])[0].getAttribute("Row") === raw,
      native: native.quantity(native.items[0]),
      valid: checked.valid,
      issues: checked.issues,
    };
  });
  assert.equal(result.quantityOnly, "14.345");
  assert.equal(result.carried, "Übernommene Menge");
  assert.equal(result.afterAdd, "14.345");
  assert.equal(result.afterEdit, "15.345");
  assert.equal(result.final, "12.345");
  assert.equal(result.raw, true);
  assert.equal(result.native, "8.000");
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  await page.close();
});

test("only the recipient address is displayed; pricing files use their request's addressee", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { GaebDocument, createGaebXml } = await import("/editor.js");
    const source = (phase) =>
      createGaebXml(phase, "Address")
        .replace("<Award>", "<Award>")
        .replace(
          /<Name1>…<\/Name1>/g,
          (_, offset, xml) =>
            `<Name1>${xml.slice(0, offset).lastIndexOf("<OWN>") > xml.slice(0, offset).lastIndexOf("<CTR>") ? "Customer" : "Contractor"}</Name1>`,
        );
    const order = new GaebDocument(source("86"), "order.x86");
    const offer = new GaebDocument(source("84"), "offer.x84");
    return {
      order: order
        .recipientAddress()
        ?.document.value(order.recipientAddress()?.address, "Name1"),
      offer: offer
        .recipientAddress(order)
        ?.document.value(offer.recipientAddress(order)?.address, "Name1"),
      original: order.source === source("86"),
    };
  });
  assert.equal(result.order, "Contractor");
  assert.equal(result.offer, "Customer");
  assert.equal(result.original, true);
  await page.close();
});

async function saved(page) {
  await page.locator('.gaeb-editor[data-save-state="saved"]').waitFor();
}
async function field(page, suffix) {
  const target = page.locator(`[data-gaeb-field$="${suffix}"]`).first();
  await target.waitFor();
  await target.focus();
  return page.locator("textarea.gaeb-canvas-input");
}

test("measurement UI matches document typography, exposes only its recipient and supports keyboard entry with automatic totals", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.__draws = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      x,
      y,
      ...rest
    ) {
      window.__draws.push({ text, x, y, color: this.fillStyle });
      return original.call(this, text, x, y, ...rest);
    };
  });
  await page.goto(base + "/scripts/takeoff.fixture.html");
  const input = await field(page, ":measure:wall:location");
  await input.press("Tab");
  assert.match(await input.getAttribute("aria-label"), /Bezeichnung/);
  await input.press("Tab");
  assert.match(await input.getAttribute("aria-label"), /Anzahl/);
  await input.fill("5");
  await input.press("Tab");
  assert.match(await input.getAttribute("aria-label"), /Länge/);
  await input.fill("2");
  await input.press("Tab");
  await input.fill("3");
  await input.press("Tab");
  await saved(page);
  const model = await page.evaluate(async () => {
    const { GaebDocument } = await import("/editor.js");
    const doc = new GaebDocument(window.__takeoffXml, "measurement.x31");
    return {
      qty: doc.quantity(doc.items[0]),
      rows: doc.takeoff(doc.items[0]).rows.length,
    };
  });
  assert.equal(model.qty, "31.471");
  assert.equal(model.rows, 3);
  const texts = await page.evaluate(() =>
    window.__draws.map((draw) => draw.text).join(" "),
  );
  assert.match(texts, /Stadtbauamt/);
  assert.doesNotMatch(
    texts,
    /Musterbau|Auftragnehmer|Auftraggeber|Ausführungsort|Vertragsmenge|Maßansatz hinzufügen:|Tab zum|Zugang ·|Dreieck ·/,
  );
  const rowDraws = await page.evaluate(() =>
    window.__draws.filter((draw) =>
      /Fensterleibung|Fensteröffnung|Westflügel|Anzahl|Länge|Höhe/.test(
        draw.text,
      ),
    ),
  );
  assert.ok(rowDraws.length > 0);
  assert.ok(
    rowDraws.every(
      (draw) => !["#64748b", "#596273", "#9ca3af"].includes(draw.color),
    ),
    JSON.stringify(rowDraws),
  );
  await page
    .locator(".gaeb-document-paper")
    .click({ position: { x: 30, y: 30 } });
  await mkdir(process.env.SORTSYS_UI_SCREENSHOTS || "/tmp/sortsys-takeoff-ui", {
    recursive: true,
  });
  await page.screenshot({
    path: join(
      process.env.SORTSYS_UI_SCREENSHOTS || "/tmp/sortsys-takeoff-ui",
      "takeoff-desktop.png",
    ),
  });
  await page.close();
});

test("add, duplicate, delete and reload retain all dimensions; keyboard commands stay inside the editor", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(base + "/scripts/takeoff.fixture.html");
  await field(page, ":measure:arch:a");
  await page.keyboard.press("Control+Shift+Enter");
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.waitFor();
  assert.match(await input.getAttribute("aria-label"), /Bezeichnung/);
  await input.fill("Bogen Kopie");
  await input.press("Tab");
  await saved(page);
  let info = await page.evaluate(async () => {
    const { GaebDocument } = await import("/editor.js");
    const d = new GaebDocument(window.__takeoffXml, "m.x31");
    return {
      qty: d.quantity(d.items[0]),
      rows: d.takeoff(d.items[0]).rows.map((r) => r.value),
    };
  });
  assert.equal(info.rows.length, 4);
  assert.equal(info.rows[3].factor, "0.67");
  assert.equal(info.rows[3].count, "4");
  assert.equal(info.qty, "11.876");
  await page.reload();
  await field(page, `:measure:${info.rows[3].id}:a`);
  await page.keyboard.press("Control+Alt+Backspace");
  await saved(page);
  info = await page.evaluate(async () => {
    const { GaebDocument } = await import("/editor.js");
    const d = new GaebDocument(window.__takeoffXml, "m.x31");
    return {
      qty: d.quantity(d.items[0]),
      rows: d.takeoff(d.items[0]).rows.map((r) => r.value),
    };
  });
  assert.equal(info.rows.length, 3);
  assert.equal(info.qty, "10.405");
  await page
    .getByRole("button", { name: "Maßansatz hinzufügen", exact: true })
    .click();
  assert.match(await input.getAttribute("aria-label"), /Bezeichnung/);
  await page
    .getByRole("combobox", { name: "Berechnungsart", exact: true })
    .selectOption("volume");
  await page
    .getByRole("combobox", { name: "Zugang oder Abzug", exact: true })
    .selectOption("deduct");
  await saved(page);
  const currentId = await page
    .getByRole("combobox", { name: "Maßansatz auswählen", exact: true })
    .inputValue();
  const last = await page.evaluate(async (id) => {
    const { GaebDocument } = await import("/editor.js");
    const d = new GaebDocument(window.__takeoffXml, "m.x31");
    return d.takeoff(d.items[0]).rows.find((row) => row.value.id === id).value;
  }, currentId);
  assert.equal(last.shape, "volume");
  assert.equal(last.mode, "deduct");
  await page.close();
});

test(
  "Typst prints readable measurements and the recipient without role labels or sender address in the document body",
  { timeout: 60000 },
  async () => {
    const page = await browser.newPage();
    await page.goto(base + "/scripts/takeoff.fixture.html");
    const result = await page.evaluate(async () => {
      const { buildGaebTypst, compileTypst } = await import("/editor.js");
      const source = buildGaebTypst(
        window.__takeoffXml,
        "m.x31",
        "de",
        window.__takeoffReference,
      );
      const pdf = await compileTypst(source);
      return {
        body: source.slice(source.indexOf("#document-style(data)[")),
        magic: String.fromCharCode(...pdf.slice(0, 5)),
        bytes: pdf.length,
      };
    });
    assert.match(result.body, /Stadtbauamt Musterstadt/);
    assert.match(result.body, /Fensterleibung Raum 01/);
    assert.match(result.body, /übermessen/);
    assert.doesNotMatch(
      result.body,
      /Musterbau|Auftragnehmer|Auftraggeber|Rechnungssteller/,
    );
    assert.equal(result.magic, "%PDF-");
    assert.ok(result.bytes > 1000);
    await page.close();
  },
);

test("decimal entry accepts comma and point, formats on leaving and preserves additional precision", async () => {
  const page = await browser.newPage();
  await page.goto(base + "/scripts/takeoff.fixture.html");
  let input = await field(page, ":measure:wall:a");
  assert.equal(await input.inputValue(), "1,455");
  await input.fill("2,75");
  await input.press("Tab");
  await saved(page);
  input = await field(page, ":measure:wall:a");
  assert.equal(await input.inputValue(), "2,750");
  await input.fill("0.00123");
  await input.press("Tab");
  await saved(page);
  input = await field(page, ":measure:wall:a");
  assert.equal(await input.inputValue(), "0,00123");
  await input.fill("1.25");
  await input.press("Tab");
  await saved(page);
  input = await field(page, ":measure:wall:a");
  assert.equal(await input.inputValue(), "1,250");
  const result = await page.evaluate(async () => {
    const { GaebDocument } = await import("/editor.js");
    const doc = new GaebDocument(window.__takeoffXml, "m.x31");
    return {
      quantity: doc.quantity(doc.items[0]),
      dimension: doc.takeoff(doc.items[0]).rows[0].value.a,
    };
  });
  assert.equal(result.dimension, "1.250");
  assert.equal(result.quantity, "9.146");
  await page.close();
});

test("measurement title and construction project remain separate through editing, autosave, native X31 and printing", async () => {
  const page = await browser.newPage();
  await page.goto(base + "/scripts/takeoff.fixture.html");
  const input = await field(page, "takeoff:title");
  assert.equal(await input.inputValue(), "Aufmaß Westflügel · November");
  await input.fill("Aufmaß Test -- November");
  await input.press("Tab");
  await saved(page);
  const result = await page.evaluate(async () => {
    const { GaebDocument, buildGaebTypst, validateGaebInBrowser } =
      await import("/editor.js");
    const doc = new GaebDocument(window.__takeoffXml, "m.x31");
    const checked = await validateGaebInBrowser(doc.source, doc.identity);
    const source = buildGaebTypst(
      doc.source,
      doc.fileName,
      "de",
      window.__takeoffReference,
    );
    return {
      project: doc.projectName(),
      title: doc.takeoffTitle,
      ref: doc.xml.getElementsByTagNameNS(doc.namespace, "RefBoQName")[0]
        .textContent,
      print: source,
      valid: checked.valid,
      issues: checked.issues,
    };
  });
  assert.equal(result.title, "Aufmaß Test -- November");
  assert.equal(result.project, "Fenstersanierung Westflügel");
  assert.notEqual(result.ref, result.title);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.doesNotMatch(result.print, /Aufmaß Test -- November/);
  assert.match(result.print, /Bauvorhaben: Fenstersanierung Westflügel/);
  await page.reload();
  assert.equal(
    await (await field(page, "takeoff:title")).inputValue(),
    "Aufmaß Test -- November",
  );
  await page.close();
});

test("concurrent edits to different measurement rows merge their inputs and recalculate the shared total", async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      createGaebXml,
      newMeasurement,
      mergeGaebDocuments,
      validateGaebInBrowser,
    } = await import("/editor.js");
    let base = new GaebDocument(createGaebXml("31", "Together"), "live.x31");
    base = new GaebDocument(base.addItem(), base.fileName);
    for (const id of ["one", "two"])
      base = new GaebDocument(
        base.addMeasurement(base.items[0], {
          ...newMeasurement("length", id),
          a: "1",
        }),
        base.fileName,
      );
    const local = base.setMeasurementField(base.items[0], "one", "a", "2.5");
    const remote = base.setMeasurementField(base.items[0], "two", "a", "3.5");
    const merged = new GaebDocument(
      mergeGaebDocuments(base.source, local, remote, base.fileName),
      base.fileName,
    );
    const reversed = mergeGaebDocuments(
      base.source,
      remote,
      local,
      base.fileName,
    );
    const checked = await validateGaebInBrowser(merged.source, merged.identity);
    let conflict = false;
    try {
      mergeGaebDocuments(
        base.source,
        local,
        base.setMeasurementField(base.items[0], "one", "a", "9"),
        base.fileName,
      );
    } catch (e) {
      conflict = e.message === "merge-conflict";
    }
    return {
      qty: merged.quantity(merged.items[0]),
      dimensions: merged
        .takeoff(merged.items[0])
        .rows.map((row) => row.value.a),
      converges: merged.source === reversed,
      valid: checked.valid,
      issues: checked.issues,
      conflict,
    };
  });
  assert.equal(result.qty, "6.000");
  assert.deepEqual(result.dimensions, ["2.500", "3.500"]);
  assert.equal(result.converges, true);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.conflict, true);
  await page.close();
});

test("real seed X31 has editable approaches whose FN91 records, exact totals and contract positions agree", async () => {
  const [xml, order] = await Promise.all([
    readFile(
      new URL("./fixtures/native-seed/demo.x31", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("./fixtures/native-seed/demo.x86", import.meta.url),
      "utf8",
    ),
  ]);
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(
    async ({ xml, order }) => {
      const {
        GaebDocument,
        calculateMeasurement,
        measureDecimal,
        validateGaebInBrowser,
      } = await import("/editor.js");
      let doc = new GaebDocument(xml, "Seed.x31");
      const contract = new GaebDocument(order, "Contract.x86");
      const rows = [];
      let correct = true;
      const units = new Set();
      for (const item of doc.items) {
        const state = doc.takeoff(item);
        correct &&=
          state.rows.length > 0 &&
          !state.unmanaged.length &&
          !state.mismatch &&
          measureDecimal(state.total) === doc.quantity(item);
        const original = contract.items.find(
          (candidate) =>
            candidate.element.getAttribute("ID") ===
            item.element.getAttribute("ID"),
        );
        correct &&=
          !!original &&
          Number(doc.quantity(item)) <= Number(contract.quantity(original));
        units.add(contract.value(original.element, "QU"));
        rows.push(
          ...state.rows.map((row) => ({
            ...row.value,
            result: measureDecimal(calculateMeasurement(row.value).result),
            overmeasured: calculateMeasurement(row.value).overmeasured,
          })),
        );
      }
      const legacy = new GaebDocument(
        xml.replace(/<!--sortsys:measure:v1:[\s\S]*?-->/g, ""),
        doc.fileName,
      );
      const interoperable = legacy.items.every(
        (item) =>
          !legacy.takeoff(item).mismatch &&
          !legacy.takeoff(item).unmanaged.length &&
          legacy.quantity(item) ===
            doc.quantity(doc.items.find((other) => other.key === item.key)),
      );
      const first = doc.takeoff(doc.items[0]).rows[0].value;
      doc = new GaebDocument(
        doc.setMeasurementField(doc.items[0], first.id, "a", "5.25"),
        doc.fileName,
      );
      const checked = await validateGaebInBrowser(doc.source, doc.identity);
      return {
        items: doc.items.length,
        rows: rows.length,
        shapes: [...new Set(rows.map((row) => row.shape))].sort(),
        units: [...units].sort(),
        correct,
        interoperable,
        edited: !doc.takeoff(doc.items[0]).mismatch,
        valid: checked.valid,
        issues: checked.issues,
        small: rows
          .filter((row) => row.mode === "opening" && row.overmeasured)
          .map((row) => row.result),
        large: rows
          .filter((row) => row.mode === "opening" && !row.overmeasured)
          .map((row) => row.result),
        title: doc.takeoffTitle,
        project: doc.projectName(),
      };
    },
    { xml, order },
  );
  assert.equal(result.items, 6);
  assert.ok(result.rows >= 24);
  assert.equal(result.correct, true);
  assert.equal(result.interoperable, true);
  assert.equal(result.edited, true);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual(result.shapes, [
    "area",
    "count",
    "factor",
    "formula",
    "length",
    "trapezoid",
    "triangle",
    "volume",
  ]);
  assert.deepEqual(result.units, ["Stk", "m", "m²", "m³", "psch"]);
  assert.ok(
    result.small.length >= 4 &&
      result.small.every((value) => value === "0.000"),
  );
  assert.ok(
    result.large.length >= 2 &&
      result.large.every((value) => Number(value) < 0),
  );
  assert.notEqual(result.title, result.project);
  await page.close();
});

test("actual seeded measurement opens with multiple visible approaches and autosaves a dimension change", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  await page.goto(base + "/scripts/takeoff.fixture.html?seed=1");
  const input = await field(page, ":measure:measure_position_1_0_0:a");
  assert.match(await input.inputValue(), /^\d+,\d{3}$/);
  await input.fill("5,25");
  await input.press("Tab");
  await saved(page);
  const result = await page.evaluate(async () => {
    const { GaebDocument } = await import("/editor.js");
    const d = new GaebDocument(window.__takeoffXml, "Seed.x31");
    return {
      value: d.takeoff(d.items[0]).rows[0].value.a,
      mismatch: d.takeoff(d.items[0]).mismatch,
      rows: d.takeoff(d.items[0]).rows.length,
    };
  });
  assert.equal(result.value, "5.250");
  assert.equal(result.mismatch, false);
  assert.equal(result.rows, 8);
  await page
    .locator(".gaeb-document-paper")
    .click({ position: { x: 30, y: 30 } });
  await mkdir("/tmp/sortsys-takeoff-seed-ui", { recursive: true });
  await page.screenshot({
    path: "/tmp/sortsys-takeoff-seed-ui/seeded-takeoff.png",
  });
  await page.close();
});

test("numeric drafts remain unformatted during a pause and autosave, then format on Tab", async () => {
  const page = await browser.newPage();
  await page.goto(base + "/scripts/takeoff.fixture.html");
  const input = await field(page, ":measure:wall:a");
  await input.fill("2");
  await saved(page);
  await page.waitForTimeout(850);
  assert.equal(await input.inputValue(), "2");
  await input.press("End");
  await input.pressSequentially(",5");
  await saved(page);
  await page.waitForTimeout(850);
  assert.equal(await input.inputValue(), "2,5");
  await input.press("Tab");
  assert.equal(
    await (await field(page, ":measure:wall:a")).inputValue(),
    "2,500",
  );
  await page.close();
});
test("Ctrl Q and W cycle relevant calculation types in both directions without changing another measurement", async () => {
  const page = await browser.newPage();
  await page.goto(base + "/scripts/takeoff.fixture.html");
  let input = await field(page, ":measure:joints:a");
  await input.press("Control+w");
  await saved(page);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Berechnungsart", exact: true })
      .inputValue(),
    "formula",
  );
  await input.press("Control+q");
  await saved(page);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Berechnungsart", exact: true })
      .inputValue(),
    "length",
  );
  const labels = await page
    .getByRole("combobox", { name: "Berechnungsart", exact: true })
    .locator("option")
    .allTextContents();
  assert.ok(
    !labels.some((label) => /Trapez|Dreieck/.test(label)),
    JSON.stringify(labels),
  );
  input = await field(page, ":measure:wall:a");
  await input.press("Control+w");
  await saved(page);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Berechnungsart", exact: true })
      .inputValue(),
    "triangle",
  );
  const result = await page.evaluate(async () => {
    const { GaebDocument } = await import("/editor.js");
    const doc = new GaebDocument(window.__takeoffXml, "m.x31");
    return doc.items.flatMap((item) =>
      doc.takeoff(item).rows.map((row) => [row.value.id, row.value.shape]),
    );
  });
  assert.equal(new Map(result).get("joints"), "length");
  assert.equal(new Map(result).get("window"), "area");
  await page.close();
});
test("measurement headings insert between approaches, remain tabbable, print without quantity and preserve totals through rename and reload", async () => {
  const page = await browser.newPage();
  await page.goto(base + "/scripts/takeoff.fixture.html");
  await field(page, ":measure:wall:label");
  await page
    .getByRole("button", {
      name: "Zwischenüberschrift hinzufügen",
      exact: true,
    })
    .click();
  const input = page.locator("textarea.gaeb-canvas-input");
  await input.fill("Südflügel – Erdgeschoss");
  await input.press("Tab");
  await saved(page);
  const result = await page.evaluate(async () => {
    const {
      GaebDocument,
      validateGaebInBrowser,
      buildGaebTypst,
      compileTypst,
    } = await import("/editor.js");
    const doc = new GaebDocument(window.__takeoffXml, "m.x31"),
      state = doc.takeoff(doc.items[0]);
    const typst = buildGaebTypst(
      doc.source,
      doc.fileName,
      "de",
      window.__takeoffReference,
    );
    const pdf = await compileTypst(typst);
    return {
      contents: state.content.map((row) => row.kind),
      headings: state.headings.map((row) => row.value.title),
      qty: doc.quantity(doc.items[0]),
      valid: await validateGaebInBrowser(doc.source, doc.identity),
      typst,
      pdf: pdf.length,
    };
  });
  assert.deepEqual(result.contents, [
    "measure",
    "heading",
    "measure",
    "measure",
  ]);
  assert.deepEqual(result.headings, ["Südflügel – Erdgeschoss"]);
  assert.equal(result.qty, "10.405");
  assert.equal(result.valid.valid, true, JSON.stringify(result.valid));
  assert.match(result.typst, /Südflügel – Erdgeschoss/);
  assert.ok(result.pdf > 1000);
  await page.reload();
  const heading = page.locator('[data-gaeb-field*="heading:"]');
  await heading.focus();
  assert.equal(await input.inputValue(), "Südflügel – Erdgeschoss");
  await page
    .getByRole("button", { name: "Zwischenüberschrift löschen", exact: true })
    .click();
  await saved(page);
  assert.equal(await heading.count(), 0);
  await page.close();
});

test("printed seed measurements show compact opening markers and a single readable rule per table", async () => {
  const [xml, reference] = await Promise.all(
    ["31", "86"].map((phase) =>
      readFile(
        new URL(`./fixtures/native-seed/demo.x${phase}`, import.meta.url),
        "utf8",
      ),
    ),
  );
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(
    async ({ xml, reference }) => {
      const { GaebDocument, buildGaebTypst, compileTypst } =
        await import("/editor.js");
      const doc = new GaebDocument(xml, "Aufmaß.x31");
      const source = buildGaebTypst(xml, doc.fileName, "de", reference);
      const english = buildGaebTypst(xml, doc.fileName, "en", reference);
      return {
        source,
        english,
        locations: doc.items.flatMap((item) =>
          doc.takeoff(item).rows.map((row) => row.value.location),
        ),
        pdf: Array.from(await compileTypst(source)),
      };
    },
    { xml, reference },
  );
  assert.ok(result.locations.length >= 24);
  assert.ok(result.locations.every((location) => !location.includes("·")));
  assert.match(
    result.source,
    /Öffnungen bis 2,50 m² je Öffnung werden übermessen/,
  );
  assert.match(result.english, /Openings up to 2.50 m² each are not deducted/);
  assert.match(result.source, /#super\[1\]/);
  assert.doesNotMatch(result.source, /0 × \(|übermessen \(≤|2\.5 m²|1\.800 m²/);
  assert.ok(result.pdf.length > 1000);
  if (process.env.SORTSYS_TAKEOFF_PRINT_QA) {
    await mkdir(process.env.SORTSYS_TAKEOFF_PRINT_QA, { recursive: true });
    await writeFile(
      join(process.env.SORTSYS_TAKEOFF_PRINT_QA, "measurement.pdf"),
      new Uint8Array(result.pdf),
    );
    await writeFile(
      join(process.env.SORTSYS_TAKEOFF_PRINT_QA, "measurement.typ"),
      result.source,
    );
  }
  await page.close();
});
