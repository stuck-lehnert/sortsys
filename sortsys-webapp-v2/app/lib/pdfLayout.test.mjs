import { describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typstString, wrapPdfDocument } from './pdfLayout.ts';
import { PDF_FONT_FAMILY, PDF_FONT_URLS } from './pdfFonts.ts';

mock.module('./client', () => ({ client: { query: async () => [null, null] } }));
const { buildPdfBatchDocument, buildPdfProductSection, renderStructuredPdf } = await import('./pdf.ts');
const { buildRegieReportPdfDocument } = await import('./regieReportPdf.ts');
const { buildTablePdfDocument } = await import('./pdfTableExport.ts');
const { buildWeeklyProjectCostsPdfDocument } = await import('./projectCostsPdf.ts');
const { pdfFixtures, weeklyProjectCostsFixture } = await import('../../scripts/pdf-fixtures.mjs');

const date = new Date('2026-10-03T12:00:00Z');
const letter = form => ({
  title: `Dokument ${form}`,
  reportLabel: 'Brief',
  exportedAt: date,
  layout: {
    kind: 'letter', form,
    sender: { name: 'Absender GmbH', lines: ['Musterstraße 1', '12345 Musterstadt'] },
    recipient: { name: 'Empfänger GmbH', lines: ['Einkauf', 'Zielstraße 2', '54321 Beispielstadt'] },
    annotations: ['Persönlich'],
    information: [{ label: 'Unser Zeichen', value: 'AB-123' }],
    footer: ['Bankverbindung: Beispielbank', 'Geschäftsführung: Erika Musterfrau'],
  },
  paragraphs: ['Sehr geehrte Damen und Herren,', 'hiermit erhalten Sie die gewünschten Unterlagen.'],
  sections: [],
});

describe('DIN document data', () => {
  test('fails clearly when a required font cannot be loaded', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 404 });
    try {
      await expect(renderStructuredPdf(letter('B'))).rejects.toThrow('Nimbus Sans L');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('encodes special characters and line breaks without executable markup', () => {
    const value = '" ] #panic("injected") \\ @test $ * _ =\nZweite Zeile';
    expect(JSON.parse(typstString(value))).toBe(value);
    const source = buildPdfBatchDocument({ documents: [{ ...letter('B'), title: value, paragraphs: [value] }] }, null);
    expect(source).toContain('#text("\\" ] #panic(\\"injected\\")');
  });

  test('rejects address and annotation lines exceeding the window zones', () => {
    const options = { index: 0, title: 'Test', date: '', dateLabel: 'Datum', pageLabel: 'Seite' };
    expect(() => wrapPdfDocument('', { ...options, layout: {
      kind: 'letter', recipient: { name: 'Name', lines: Array(6).fill('Zeile') },
    } })).toThrow('six address lines');
    expect(() => wrapPdfDocument('', { ...options, layout: {
      kind: 'letter', annotations: Array(5).fill('Vermerk'),
    } })).toThrow('four annotation lines');
  });
});

// The CLI check is optional on machines without Typst. It exercises generated
// documents and measures actual PDF text, rather than matching template strings.
const hasTypst = spawnSync('typst', ['--version']).status === 0;
const integrationTest = hasTypst ? test : test.skip;
const fontDirectory = fileURLToPath(new URL('../../public/fonts/nimbus-sans-l', import.meta.url));

test('compiles with the browser WASM compiler and the bundled Nimbus Sans L fonts', async () => {
  const { createTypstCompiler } = await import('@myriaddreamin/typst.ts/compiler');
  const { loadFonts } = await import('@myriaddreamin/typst.ts/options.init');
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => new Uint8Array(readFileSync(new URL('../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm', import.meta.url))),
    beforeBuild: [loadFonts(PDF_FONT_URLS.map(url => new Uint8Array(readFileSync(new URL(`../../public${url}`, import.meta.url)))), { assets: false })],
  });
  const document = letter('B');
  document.layout.recipient.name = 'W'.repeat(28);
  document.sections = [{ title: 'Positionen', columns: ['Bezeichnung', 'Menge'], rows: [['Leistung', '1,00']] }];
  document.cardSections = [{ title: 'Kontakt', cards: [{ title: 'Erika Musterfrau', badge: 'Bauleitung', items: [{ label: 'Telefon', value: '+49 123 456' }] }] }];
  const source = buildPdfBatchDocument({ documents: [document] }, null);
  expect(source).toContain(`font: "${PDF_FONT_FAMILY}"`);
  compiler.addSource('/main.typ', source);
  const result = await compiler.compile({ mainFilePath: '/main.typ', format: 1, diagnostics: 'full' });
  expect(result.diagnostics ?? []).toEqual([]);
  expect(new TextDecoder().decode(result.result?.slice(0, 5))).toBe('%PDF-');
});

test('flows weekly costs together with one title, continuous numbering and week context on continued tables', async () => {
  const { createTypstCompiler } = await import('@myriaddreamin/typst.ts/compiler');
  const { loadFonts } = await import('@myriaddreamin/typst.ts/options.init');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => new Uint8Array(readFileSync(new URL('../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm', import.meta.url))),
    beforeBuild: [loadFonts(PDF_FONT_URLS.map(url => new Uint8Array(readFileSync(new URL(`../../public${url}`, import.meta.url)))), { assets: false })],
  });
  const document = weeklyProjectCostsFixture({ buildWeeklyProjectCostsPdfDocument, buildPdfProductSection });
  const compact = { ...document, sections: [], groups: document.groups.map(group => ({ ...group, sections: group.sections.slice(0, 1) })) };
  for (const [name, documents] of [['weekly', [document]], ['compact-batch', [compact, compact]]]) {
    compiler.addSource(`/${name}.typ`, buildPdfBatchDocument({ documents }, null));
    const result = await compiler.compile({ mainFilePath: `/${name}.typ`, format: 1, diagnostics: 'full' });
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.result?.length).toBeGreaterThan(0);
    const task = getDocument({ data: result.result });
    try {
      const pdf = await task.promise;
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const { items } = await page.getTextContent();
        const text = items.filter(item => 'str' in item && item.str.trim());
        for (const item of text) {
          expect(item.transform[4] * 25.4 / 72).toBeGreaterThanOrEqual(24.9);
          expect((item.transform[4] + item.width) * 25.4 / 72).toBeLessThanOrEqual(190.2);
          const next = text.filter(other => other !== item && Math.abs(other.transform[5] - item.transform[5]) < 0.2
            && other.transform[4] > item.transform[4]).sort((a, b) => a.transform[4] - b.transform[4])[0];
          if (next) expect(item.transform[4] + item.width, `${item.str} / ${next.str}`).toBeLessThanOrEqual(next.transform[4] + 0.75);
        }
        pages.push(text);
      }
      const content = pages.map(items => items.map(item => item.str).join(' '));
      if (name === 'compact-batch') {
        // All three short weeks fit on one page, even when two reports are batched.
        expect(pdf.numPages).toBe(2);
        for (const page of content) {
          expect(page).toContain('Seite 1 / 1');
          for (const week of [39, 40, 41]) expect(page).toContain(`KW ${week} / 2026`);
        }
        continue;
      }
      expect(pdf.numPages).toBeGreaterThan(3);
      const allItems = pages.flat();
      expect(allItems.filter(item => item.str === document.title && item.height > 14)).toHaveLength(1);
      expect(allItems.filter(item => item.str === 'Musterbau GmbH')).toHaveLength(1);
      expect(allItems.filter(item => item.str.includes('Exportiert am'))).toHaveLength(1);
      expect(content.join('\n')).toContain('28.09.2026 bis 04.10.2026');
      for (const week of [39, 40, 41]) {
        expect(allItems.filter(item => item.str === `KW ${week} / 2026` && item.height > 12)).toHaveLength(1);
      }
      const workers = allItems.map(item => item.str).filter(value => /^Mitarbeiter \d+$/.test(value));
      expect(workers).toEqual(Array.from({ length: 100 }, (_, n) => `Mitarbeiter ${n + 1}`));
      for (const [index, page] of content.entries()) {
        expect(page).toContain(`Seite ${index + 1} / ${pdf.numPages}`);
        if (/Mitarbeiter \d+/.test(page)) {
          expect(page).toContain('KW 40 / 2026');
          expect(page).toContain('Arbeitszeit');
          for (const column of ['Tag', 'Stunden', 'Kosten']) expect(page).toContain(column);
          const continuedCaption = pages[index].find(item => item.str === 'KW 40 / 2026 · Arbeitszeit');
          if (continuedCaption) expect(continuedCaption.height).toBeLessThanOrEqual(10);
        }
        // A week heading stays on the same page as the first cost rows.
        if (pages[index].some(item => item.str === 'KW 41 / 2026' && item.height > 12)) {
          expect(page).toContain('1.100,00 €');
          expect(page).toContain('Einzelkosten');
        }
      }
      expect(content.at(-1)).toContain('M-103');
      expect(content.at(-1)).toContain('Montagematerial');
    } finally {
      await task.destroy();
    }
  }
});

test('keeps all document types and long position lists readable in the browser compiler', async () => {
  const { createTypstCompiler } = await import('@myriaddreamin/typst.ts/compiler');
  const { loadFonts } = await import('@myriaddreamin/typst.ts/options.init');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => new Uint8Array(readFileSync(new URL('../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm', import.meta.url))),
    beforeBuild: [loadFonts(PDF_FONT_URLS.map(url => new Uint8Array(readFileSync(new URL(`../../public${url}`, import.meta.url)))), { assets: false })],
  });
  for (const name of ['landscape', 'portrait']) {
    compiler.mapShadow(`/preview/${name}.svg`, new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${name === 'portrait' ? 100 : 400}" height="300"><rect width="100%" height="100%" fill="#ddd"/></svg>`));
  }
  const documents = pdfFixtures({ buildPdfProductSection, buildRegieReportPdfDocument, buildTablePdfDocument });
  documents.push(buildTablePdfDocument({
    title: 'Langer Datensatz',
    headers: ['Nummer', 'Bezeichnung', 'Status', 'Standort', 'Datum', 'Kontakt', 'Hinweis'],
    rows: [['W-999', 'Werkzeug', 'geprüft', 'Lager', '03.10.2026', 'Bauleitung',
      'Die ausführliche Dokumentation zur Prüfung bleibt auch bei einem Seitenwechsel vollständig erhalten. '.repeat(60) + 'Ende des langen Datensatzes.']],
  }));
  compiler.addSource('/main.typ', buildPdfBatchDocument({ documents }, null));
  const result = await compiler.compile({ mainFilePath: '/main.typ', format: 1, diagnostics: 'full' });
  expect(result.diagnostics ?? []).toEqual([]);
  expect(result.result?.length).toBeGreaterThan(0);
  const task = getDocument({ data: result.result });
  try {
    const pdf = await task.promise;
    const pages = [];
    const pageItems = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      const text = items.filter(item => 'str' in item && item.str.trim());
      // Actual text bounds, including long names, dates, captions and numeric columns.
      for (const item of text) {
        const x = item.transform[4] * 25.4 / 72;
        const right = (item.transform[4] + item.width) * 25.4 / 72;
        const y = (page.view[3] - item.transform[5]) * 25.4 / 72;
        expect(x).toBeGreaterThanOrEqual(24.9);
        expect(right).toBeLessThanOrEqual(190.2);
        expect(y).toBeGreaterThan(9);
        expect(y).toBeLessThan(286);
      }
      // Page bounds alone miss text overflowing into an adjacent table cell.
      for (const item of text) {
        const next = text.filter(other => other !== item
          && Math.abs(other.transform[5] - item.transform[5]) < 0.2
          && other.transform[4] > item.transform[4]).sort((a, b) => a.transform[4] - b.transform[4])[0];
        if (next) expect(item.transform[4] + item.width, `${item.str} / ${next.str}`).toBeLessThanOrEqual(next.transform[4] + 0.75);
      }
      pages.push(text.map(item => item.str).join(' '));
      pageItems.push(text);
    }
    const allText = pages.join('\n');
    for (const document of documents) expect(allText).toContain(document.title);
    const positions = [...allText.matchAll(/Position (\d+):/g)].map(match => Number(match[1]));
    expect(positions).toEqual(Array.from({ length: 90 }, (_, index) => index + 1));
    expect(allText).toContain('Gesamt');
    expect(allText).toContain('Basiseinheit');
    expect(allText).toContain('Letzte Inventur');
    expect(allText).toContain('Nordfassade');
    expect(allText).toContain('Ende des langen Datensatzes.');
    const regiePages = pages.filter(page => page.includes('Regiebericht #45'));
    expect(regiePages.join(' ')).toContain('Bauleiter');
    expect(regiePages.join(' ')).toContain('Bauherr');
    expect(regiePages.join(' ')).toContain('Datum und Unterschrift');
    expect(regiePages.join(' ')).toContain('M-104');
    expect(regiePages.join(' ')).toContain('Nr.');
    // Check the visible hierarchy in the compiled PDF, independent of source styles.
    const costItems = pageItems.find(items => items.some(item => item.str === 'Malerbetrieb Beispiel GmbH'));
    const sizeOf = value => Math.max(...costItems.filter(item => item.str.includes(value)).map(item => Math.hypot(item.transform[0], item.transform[1])));
    const titleSize = sizeOf('Projektkostenbericht');
    const sectionSize = sizeOf('Zusammenfassung');
    const labelSize = sizeOf('Gesamtkosten');
    const metricSize = sizeOf('751,27');
    const tableSize = sizeOf('Nico Beispiel');
    expect(titleSize).toBeGreaterThanOrEqual(sectionSize * 1.4);
    expect(sectionSize).toBeGreaterThanOrEqual(tableSize * 1.15);
    expect(metricSize).toBeGreaterThan(tableSize);
    expect(metricSize).toBeLessThanOrEqual(12.1);
    expect(labelSize).toBeLessThanOrEqual(metricSize);
    expect(allText).toContain('25,23 %');
    // Every export kind uses the same hierarchy, including letters, presence
    // matrices, project identities, wide/narrow lists and weekly cost reports.
    for (const document of documents) {
      const items = pageItems.find(items =>
        items.some(item => item.str === document.title && Math.hypot(item.transform[0], item.transform[1]) >= 14)
        && (document.showReportLabel === false || document.reportLabel === document.title || items.some(item => item.str === document.reportLabel)));
      expect(items).toBeDefined();
      const title = items.find(item => item.str === document.title);
      const titleSize = Math.hypot(title.transform[0], title.transform[1]);
      const sectionTitles = [...document.sections, ...(document.cardSections ?? []), ...(document.trailingSections ?? []), ...(document.imageSections ?? [])].map(section => section.title).filter(Boolean);
      const headings = items.filter(item => sectionTitles.includes(item.str));
      expect(headings.length).toBeGreaterThan(0);
      for (const heading of headings) expect(titleSize).toBeGreaterThan(Math.hypot(heading.transform[0], heading.transform[1]));
      for (const section of document.sections.filter(section => ['summary', 'metrics'].includes(section.presentation))) {
        for (const [label, value] of section.rows) {
          if (typeof value !== 'object' || value === null || (!value.bold && !value.emphasis)) continue;
          // Results stay on the same row as their labels, with a moderate
          // emphasis rather than a separate oversized dashboard tile.
          const caption = items.find(item => item.str === label);
          expect(caption, `${document.title}: ${label}`).toBeDefined();
          const values = items.filter(item => item.transform[4] > caption.transform[4]
            && Math.abs(item.transform[5] - caption.transform[5]) < 2);
          const text = values.map(item => item.str).join(' ').replace(/\s+/g, ' ');
          expect(text, `${document.title}: ${label}`).toContain(`${value.value}`.replace(/\s+/g, ' '));
          for (const item of values) {
            expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(10);
            expect(Math.hypot(item.transform[0], item.transform[1])).toBeLessThanOrEqual(12.1);
          }
        }
      }
    }
    // Contacts precede project notes and keep the same field/value columns.
    const contactPage = pages.find(page => page.includes('Projektdatenblatt') && !page.includes('umfangreiche Kontaktliste'));
    expect(contactPage.indexOf('Ansprechpartner')).toBeLessThan(contactPage.indexOf('Vermerke'));
    expect(contactPage).toContain('Mobil: +49 170 1234567');
    const contactItems = pageItems[pages.indexOf(contactPage)];
    const emailLabels = contactItems.filter(item => item.str === 'E-Mail');
    expect(emailLabels).toHaveLength(3);
    for (const label of emailLabels) {
      const value = contactItems.find(item => item.str.includes('@example.test') && Math.abs(item.transform[5] - label.transform[5]) < 1);
      expect(value).toBeDefined();
      expect(value.transform[4]).toBeGreaterThan(label.transform[4]);
    }
    const manyContactPages = pages.filter(page => page.includes('umfangreiche Kontaktliste'));
    expect(manyContactPages.length).toBeGreaterThan(1);
    const manyContacts = [...manyContactPages.join(' ').matchAll(/Kontakt (\d+):/g)].map(match => Number(match[1]));
    expect(manyContacts).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    const signaturePage = pages.find(page => page.includes('Position 90:'));
    expect(signaturePage).toContain('Datum und Unterschrift');
    expect(signaturePage).toContain('Auftraggeber');
    for (const page of pages.filter(page => /Position \d+:/.test(page))) {
      expect(page).toContain('Produkte');
      expect(page).toContain('Nr.');
      expect(page).toContain('Bezeichnung');
      expect(page).toContain('Basiseinheit');
    }
    // Number and description are separate cells on the same row, including
    // every position of a long report and the price-free regie report.
    for (const items of pageItems) {
      for (const number of items.filter(item => /^(M-\d+|2147483647)$/.test(item.str))) {
        const name = items.find(item => item.transform[4] > number.transform[4]
          && Math.abs(item.transform[5] - number.transform[5]) < 1
          && !/^\d/.test(item.str) && item.str !== '-');
        expect(name).toBeDefined();
        expect(name.transform[4] - number.transform[4]).toBeGreaterThan(40);
      }
    }
  } finally {
    await task.destroy();
  }
});

test('keeps logos within the company header and collapses unused space without a logo', async () => {
  const { createTypstCompiler } = await import('@myriaddreamin/typst.ts/compiler');
  const { loadFonts } = await import('@myriaddreamin/typst.ts/options.init');
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => new Uint8Array(readFileSync(new URL('../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm', import.meta.url))),
    beforeBuild: [loadFonts(PDF_FONT_URLS.map(url => new Uint8Array(readFileSync(new URL(`../../public${url}`, import.meta.url)))), { assets: false })],
  });
  const document = {
    title: 'Projektblatt', reportLabel: 'Projekt', exportedAt: date,
    layout: { sender: { name: 'Beispiel GmbH', lines: [] } }, sections: [],
  };
  let titleWithoutLogo;
  for (const file of [null, 'logo-black.png', 'icon-black.png']) {
    const path = file ? `/preview/${file}` : null;
    let aspect;
    if (file) {
      const bytes = readFileSync(new URL(`../../public/${file}`, import.meta.url));
      aspect = bytes.readUInt32BE(16) / bytes.readUInt32BE(20);
      compiler.mapShadow(path, new Uint8Array(bytes));
    }
    compiler.addSource('/logo.typ', buildPdfBatchDocument({ documents: [document] }, path));
    const result = await compiler.compile({ mainFilePath: '/logo.typ', format: 1, diagnostics: 'full' });
    expect(result.diagnostics ?? []).toEqual([]);
    const task = getDocument({ data: result.result });
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const { items } = await page.getTextContent();
      const title = items.find(item => item.str === document.title);
      const titleY = (page.view[3] - title.transform[5]) * 25.4 / 72;
      const sender = items.find(item => item.str === 'Beispiel GmbH');
      const senderY = (page.view[3] - sender.transform[5]) * 25.4 / 72;
      if (!file) {
        titleWithoutLogo = titleY;
        expect(titleY - senderY).toBeLessThan(12);
      } else {
        expect(titleY - titleWithoutLogo).toBeGreaterThan(3);
        expect(titleY - senderY).toBeLessThan(22);
      }
      const operators = await page.getOperatorList();
      const stack = [];
      let matrix = [1, 0, 0, 1, 0, 0];
      const images = [];
      for (const [index, op] of operators.fnArray.entries()) {
        if (op === OPS.save) stack.push([...matrix]);
        if (op === OPS.restore) matrix = stack.pop();
        if (op === OPS.transform) {
          const a = matrix, b = operators.argsArray[index];
          matrix = [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
        }
        if (op === OPS.paintImageXObject) {
          const points = [[0,0], [0,1], [1,0], [1,1]].map(([x,y]) => [matrix[0]*x+matrix[2]*y+matrix[4], matrix[1]*x+matrix[3]*y+matrix[5]]);
          const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
          images.push({ width: (Math.max(...xs)-Math.min(...xs))*25.4/72,
            height: (Math.max(...ys)-Math.min(...ys))*25.4/72,
            right: Math.max(...xs)*25.4/72, top: (page.view[3]-Math.max(...ys))*25.4/72 });
        }
      }
      expect(images).toHaveLength(file ? 1 : 0);
      if (file) {
        expect(images[0].width).toBeLessThanOrEqual(30.01);
        expect(images[0].height).toBeLessThanOrEqual(10.01);
        expect(images[0].width / images[0].height).toBeCloseTo(aspect, 2);
        expect(images[0].right).toBeCloseTo(190, 1);
        expect(images[0].top).toBeCloseTo(25, 1);
      }
    } finally {
      await task.destroy();
    }
  }
});

test('retains column labels and values when wide exports become labeled records', () => {
  const headers = Array.from({ length: 8 }, (_, index) => `Feld ${index}`);
  const row = headers.map((_, index) => `Wert ${index}`);
  const document = buildTablePdfDocument({ title: 'Export', headers, rows: [row] });
  const card = document.cardSections[0].cards[0];
  expect(card.title).toBe('Feld 0: Wert 0');
  expect(card.items).toEqual(headers.slice(1).map((label, index) => ({ label, value: row[index + 1] })));
  const empty = buildTablePdfDocument({ title: 'Leer', headers, rows: [] });
  expect(empty.sections.at(-1).rows).toEqual([]);
  expect(empty.sections[0].rows[0][1]).toBe(0);
});

describe('compiled PDF layout', () => {
  integrationTest('positions both forms, repeats headers and numbers each batch document separately', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const directory = mkdtempSync(join(tmpdir(), 'sortsys-din-test-'));
    let task;
    try {
      const report = {
        title: 'Projektbericht', reportLabel: 'Projekt', exportedAt: date,
        sections: [{ title: 'Produkte', columns: ['Bezeichnung', 'Menge'],
          rows: Array.from({ length: 140 }, (_, n) => [`Position ${n}`, `${n},00`]),
        }],
        signatures: [{ title: 'Bauleitung' }],
      };
      const source = buildPdfBatchDocument({ documents: [letter('A'), letter('B'), report] }, null);
      writeFileSync(join(directory, 'main.typ'), source);
      const compilation = spawnSync('typst', ['compile', '--font-path', fontDirectory, join(directory, 'main.typ'), join(directory, 'main.pdf')], { encoding: 'utf8' });
      expect(compilation.status).toBe(0);
      expect(compilation.stderr).toBe('');
      task = getDocument({ data: new Uint8Array(readFileSync(join(directory, 'main.pdf'))), useSystemFonts: true });
      const pdf = await task.promise;
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const { items } = await page.getTextContent();
        const height = page.view[3];
        pages.push(items.filter(item => 'str' in item).map(item => ({
          text: item.str, x: item.transform[4] * 25.4 / 72,
          y: (height - item.transform[5]) * 25.4 / 72,
        })));
      }
      expect(pages.length).toBeGreaterThan(4);
      const find = (page, text) => page.find(item => item.text === text);
      const addressA = find(pages[0], 'Empfänger GmbH');
      const addressB = find(pages[1], 'Empfänger GmbH');
      expect(addressA.x).toBeCloseTo(25, 1);
      expect(addressB.x).toBeCloseTo(25, 1);
      expect(addressB.y - addressA.y).toBeCloseTo(18, 1);
      expect(addressB.y).toBeGreaterThan(62.7);
      expect(addressB.y).toBeLessThan(67);
      expect(find(pages[1], 'Unser Zeichen').x).toBeCloseTo(125, 1);
      expect(find(pages[1], 'Dokument B').y).toBeGreaterThanOrEqual(98.46);
      expect(pages[0].map(item => item.text).join(' ')).toContain('Seite 1 / 1');
      expect(pages[1].map(item => item.text).join(' ')).toContain('Seite 1 / 1');
      const reportPages = pages.slice(2);
      for (let n = 0; n < reportPages.length; n++) {
        const content = reportPages[n].map(item => item.text).join(' ');
        expect(content).toContain(`Seite ${n + 1} / ${reportPages.length}`);
        expect(content).toContain('Projektbericht');
        if (content.includes('Position')) expect(content).toContain('Bezeichnung');
        expect(content).not.toContain('Empfänger GmbH');
      }
      expect(reportPages.at(-1).map(item => item.text).join(' ')).toContain('Bauleitung');
    } finally {
      await task?.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  integrationTest('rejects address text that cannot fit even at the minimum font size', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sortsys-din-overflow-'));
    try {
      const document = letter('B');
      document.layout.recipient.name = 'W'.repeat(300);
      writeFileSync(join(directory, 'main.typ'), buildPdfBatchDocument({ documents: [document] }, null));
      const compilation = spawnSync('typst', ['compile', '--font-path', fontDirectory, join(directory, 'main.typ'), join(directory, 'main.pdf')], { encoding: 'utf8' });
      expect(compilation.status).not.toBe(0);
      expect(compilation.stderr).toContain('address line is too long');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
