// Run with Bun; uses the browser WASM compiler and local fonts without a server.
import { mock } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pdfFixtures, pdfFixtureNames, weeklyProjectCostsFixture } from './pdf-fixtures.mjs';

mock.module('../app/lib/client.ts', () => ({ client: { query: async () => [null, null] } }));
const { buildPdfBatchDocument, buildPdfProductSection } = await import('../app/lib/pdf.ts');
const { buildRegieReportPdfDocument } = await import('../app/lib/regieReportPdf.ts');
const { buildTablePdfDocument } = await import('../app/lib/pdfTableExport.ts');
const { buildWeeklyProjectCostsPdfDocument } = await import('../app/lib/projectCostsPdf.ts');
const { PDF_FONT_URLS } = await import('../app/lib/pdfFonts.ts');
const { createTypstCompiler } = await import('@myriaddreamin/typst.ts/compiler');
const { loadFonts } = await import('@myriaddreamin/typst.ts/options.init');
const outputDirectory = resolve(process.argv[2] ?? '/tmp/sortsys-pdf-preview');
mkdirSync(outputDirectory, { recursive: true });
const compiler = createTypstCompiler();
await compiler.init({
  getModule: () => new Uint8Array(readFileSync(new URL('../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm', import.meta.url))),
  beforeBuild: [loadFonts(PDF_FONT_URLS.map(url => new Uint8Array(readFileSync(new URL(`../public${url}`, import.meta.url)))), { assets: false })],
});
const svg = (width, height, label) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#eee"/><rect x="10" y="10" width="${width - 20}" height="${height - 20}" fill="none" stroke="#555"/><path d="M10 10 L${width - 10} ${height - 10} M${width - 10} 10 L10 ${height - 10}" stroke="#888"/><text x="20" y="40" font-size="16">${label}</text></svg>`);
compiler.mapShadow('/preview/landscape.svg', svg(480, 240, 'Querformat'));
compiler.mapShadow('/preview/portrait.svg', svg(240, 640, 'Hochformat'));
compiler.mapShadow('/preview/logo.svg', new Uint8Array(readFileSync(new URL('../assets/logo-black.svg', import.meta.url))));
const documents = pdfFixtures({ buildPdfProductSection, buildRegieReportPdfDocument, buildTablePdfDocument });
const source = buildPdfBatchDocument({ documents }, '/preview/logo.svg');
compiler.addSource('/main.typ', source);
const result = await compiler.compile({ mainFilePath: '/main.typ', format: 1, diagnostics: 'full' });
if (result.diagnostics?.length || !result.result?.length) throw new Error(JSON.stringify(result.diagnostics));
writeFileSync(resolve(outputDirectory, 'beispiele.typ'), source);
writeFileSync(resolve(outputDirectory, 'beispiele.pdf'), result.result);
if (documents.length !== pdfFixtureNames.length) throw new Error('Each preview document needs a file name.');
const manifest = [];
for (const [index, document] of documents.entries()) {
  const name = pdfFixtureNames[index];
  const content = buildPdfBatchDocument({ documents: [document] }, name === 'projektkosten' ? null : '/preview/logo.svg');
  const path = `/${name}.typ`;
  compiler.addSource(path, content);
  const preview = await compiler.compile({ mainFilePath: path, format: 1, diagnostics: 'full' });
  if (preview.diagnostics?.length || !preview.result?.length) throw new Error(JSON.stringify(preview.diagnostics));
  writeFileSync(resolve(outputDirectory, `${name}.typ`), content);
  writeFileSync(resolve(outputDirectory, `${name}.pdf`), preview.result);
  manifest.push({ title: document.title, file: `${name}.pdf` });
}
const weeklyDocument = weeklyProjectCostsFixture({ buildWeeklyProjectCostsPdfDocument, buildPdfProductSection });
const weeklySource = buildPdfBatchDocument({ documents: [weeklyDocument] }, '/preview/logo.svg');
compiler.addSource('/projektkosten-wochenweise.typ', weeklySource);
const weeklyPreview = await compiler.compile({ mainFilePath: '/projektkosten-wochenweise.typ', format: 1, diagnostics: 'full' });
if (weeklyPreview.diagnostics?.length || !weeklyPreview.result?.length) throw new Error(JSON.stringify(weeklyPreview.diagnostics));
writeFileSync(resolve(outputDirectory, 'projektkosten-wochenweise.typ'), weeklySource);
writeFileSync(resolve(outputDirectory, 'projektkosten-wochenweise.pdf'), weeklyPreview.result);
manifest.push({ title: weeklyDocument.title, file: 'projektkosten-wochenweise.pdf' });
writeFileSync(resolve(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(resolve(outputDirectory, 'beispiele.pdf'));
