import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createFixtureServer } from "./browser-support.mjs";
import { readFile } from "node:fs/promises";

let browser, server, editor, attacker;
const requests = [];
test("the actual adoption form prepares native and legacy contracts entirely in the browser", async () => {
  const context = await browser.newContext(), page = await context.newPage(), external = [];
  await context.route("**/*", route => { if (new URL(route.request().url()).origin === server.origin) return route.continue(); external.push(route.request().url()); return route.abort("blockedbyclient"); });
  try {
    await page.goto(`${server.origin}/private-editors.html`); await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() => window.privateEditorFixture.contractAdoption());
    let count = 0;
    async function submit(name, bytes, normalized) {
      await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
      await page.getByText(normalized, { exact: true }).waitFor();
      await page.locator('button[type="submit"]').click(); count++;
      await page.waitForFunction(count => window.contractAdoptionFixture.snapshot().count === count, count);
      return page.evaluate(() => window.contractAdoptionFixture.snapshot().input);
    }
    for (const phase of ["84", "85", "86", "87"]) {
      const xml = await page.evaluate(phase => window.contractAdoptionFixture.xml(phase), phase);
      const input = await submit(`Original.x${phase}`, Buffer.from(xml), `Original.x${phase}`);
      assert.equal(input.sourcePhase, phase); assert.equal(input.sourceXml, xml); assert.equal(input.netAmount, "1776.00");
      assert.equal(input.offerXml === null, phase === "84");
      if (input.offerXml) assert.match(input.offerXml, /DA84/);
    }
    const original = await readFile(new URL("../../../sortsys-gaeb/scripts/fixtures/legacy/anfrage.d83", import.meta.url));
    const records = original.toString("latin1").trimEnd().split(/\r?\n/); records[0] = records[0].slice(0, 10) + "84" + records[0].slice(12);
    const price = Array(80).fill(" "); for (const [offset, text] of [[0, "23"], [2, "01010010A"], [12, "00000012340"], [24, "000000015425"]]) for (let i = 0; i < text.length; i++) price[offset + i] = text[i];
    records.splice(9, 0, price.join(""));
    const d84 = Buffer.from(records.map((row, i) => row.slice(0, 74).padEnd(74, " ") + String(i + 1).padStart(6, "0")).join("\r\n"), "latin1");
    const p83 = await readFile(new URL("../../../sortsys-gaeb/scripts/fixtures/legacy/anfrage.p83", import.meta.url), "utf8");
    const p84 = Buffer.from(p83.replace("[DP]83[end]", "[DP]84[end]").replace("[ME]m²[end]", "[ME]m²[end][EP]12,340[end][GB]154,25[end]"));
    for (const phase of ["84", "85", "86", "87"]) for (const kind of ["d", "p"]) {
      const source = kind === "d" ? Buffer.from(d84.toString("latin1").slice(0, 10) + phase + d84.toString("latin1").slice(12), "latin1")
        : Buffer.from(p84.toString().replace("[DP]84[end]", `[DP]${phase}[end]`));
      const input = await submit(`Altauftrag${kind}.${kind}${phase}`, source, `Altauftrag${kind}.x${phase}`);
      assert.equal(input.sourcePhase, phase); assert.equal(input.sourceFileName, `Altauftrag${kind}.x${phase}`); assert.equal(input.netAmount, "154.25");
      assert.equal(input.offerXml === null, phase === "84");
      if (phase === "84") { assert.ok(input.referenceXml); assert.match(input.referenceXml, /DA83/); }
      assert.ok(input.sourceXml.includes(source.toString("base64")));
    }
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});
test("the commercial ribbon downloads private native XML locally and blocks a late download after access reset", async () => {
  const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage(), urls = [], downloads = [];
  try {
    page.on("request", request => urls.push(request.url())); page.on("download", download => downloads.push(download));
    await page.goto(`${server.origin}/private-editors.html`); await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() => window.privateEditorFixture.commercialDownload());
    const button = page.getByRole("button", { name: "Herunterladen", exact: true }); await button.waitFor();
    const ready = page.waitForEvent("download"); await button.click(); const downloaded = await ready;
    assert.equal(downloaded.suggestedFilename(), "Vertrauliches Angebot.x84");
    const content = await readFile(await downloaded.path(), "utf8"), state = await page.evaluate(() => window.privateGaebDownload.snapshot());
    assert.equal(content, state.xml); assert.equal(state.reads, 1); assert.ok(state.paths.includes("commercial.documents.download"));
    assert.equal(urls.some(url => url.startsWith("sortsys-private-gaeb:")), false);
    await page.evaluate(() => window.privateGaebDownload.pause()); await button.click();
    await page.waitForFunction(() => window.privateGaebDownload.snapshot().reads === 2);
    await page.evaluate(() => window.privateGaebDownload.revoke()); await page.evaluate(() => window.privateGaebDownload.release());
    await page.waitForTimeout(200); assert.equal(downloads.length, 1);
  } finally { await context.close(); }
});
test("the actual GAEB dialog removes its old canvas when access is reset and cannot reopen denied content", async () => {
  const context = await browser.newContext(), page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`); await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(() => window.privateEditorFixture.gaeb());
    await page.locator("canvas").first().waitFor({ state: "visible" });
    await page.evaluate(() => window.revokePrivateGaeb());
    await page.waitForFunction(() => document.querySelectorAll("canvas").length === 0);
    await page.getByText("Die Datei konnte nicht geöffnet werden.", { exact: true }).waitFor();
    assert.equal(await page.locator("canvas").count(), 0);
  } finally { await context.close(); }
});
test("GAEB XML is separated and losslessly reconstructed by the actual browser WASM worker", async () => {
  const context = await browser.newContext(), page = await context.newPage(), urls = [];
  try {
    page.on("request", request => urls.push(request.url()));
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    const result = await page.evaluate(() => window.privateEditorFixture.gaebPartition());
    assert.equal(result.exact, true); assert.equal(result.complete, true);
    assert.deepEqual(result.validation, { valid: true, invalid: false });
    assert.equal(result.scope.includes("592.00"), false); assert.equal(result.scope.includes("9876.54"), false);
    assert.equal(result.partial.complete, false); assert.ok(result.partial.xml.includes("2.500"));
    assert.equal(result.partial.xml.includes("592.00"), false); assert.equal(result.partial.xml.includes("9876.54"), false);
    assert.equal(urls.some(url => !url.startsWith(server.origin) && !url.startsWith("blob:") && !url.startsWith("data:")), false);
  } finally { await context.close(); }
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
    res.setHeader("Content-Type", "text/html"); res.end(editorHtml);
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${http.address().port}`, close: () => new Promise(resolve => http.close(resolve)) };
}
before(async () => {
  server = await createFixtureServer(); editor = await serveEditor(); attacker = await serveEditor();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close(); await editor?.close(); await attacker?.close(); await server?.close();
});
async function open(canEdit = true, key) {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`${server.origin}/private-editors.html`);
  await page.waitForFunction(() => window.privateEditorFixture);
  await page.evaluate(({ origin, canEdit, key }) => window.privateEditorFixture.open(origin, canEdit, key), { origin: editor.origin, canEdit, key });
  const frame = await (await page.locator("#private-office").elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.boot);
  return { context, page, frame };
}

test("the private editor rejects other windows and commits capabilities before sharing the document", async () => {
  const { context, page, frame } = await open();
  try {
    for (const origin of [attacker.origin, editor.origin]) {
      await page.evaluate(origin => {
        const frame = document.createElement("iframe"); frame.src = `${origin}/rogue`; frame.id = "rogue";
        document.body.append(frame);
      }, origin);
      const rogue = await (await page.locator("#rogue").elementHandle()).contentFrame();
      await rogue.waitForFunction(() => window.boot); await rogue.evaluate(() => window.boot());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await frame.evaluate(() => window.state.sessionRequests), 0);
      await page.locator("#rogue").evaluate(node => node.remove());
    }
    await frame.evaluate(() => { window.boot(); window.boot(); });
    await page.waitForFunction(() => window.privateEditorFixture.state.published === 1);
    assert.equal(await frame.evaluate(() => window.state.start), null);
    await page.evaluate(() => window.privateEditorFixture.publish());
    await page.waitForFunction(() => window.privateEditorFixture.state.ready === 1);
    const start = await frame.evaluate(() => window.state.start);
    assert.equal(start.document, "private browser document");
    assert.equal(start.url, undefined); assert.equal(start.editorConfig.callbackUrl, undefined);
    assert.equal(start.readOnly, false); assert.equal(start.autosave, 10);
    assert.equal(start._config.sortsysPersistentRoom, true);
    await frame.evaluate(() => window.command("SAVE", new Blob(["changed private document"])));
    await page.waitForFunction(() => window.privateEditorFixture.state.saved.length === 1);
    assert.deepEqual(await page.evaluate(() => window.privateEditorFixture.state.saved), ["changed private document"]);
    assert.ok(requests.every(req => req.method === "GET" && !/capability|document|callback|ooapidl|oosave/.test(req.url)));
  } finally { await context.close(); }
});

test("a read-only CryptPad session cannot invoke saving or publish an editing capability", async () => {
  const { context, page, frame } = await open(false, "view-capability");
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(() => window.privateEditorFixture.state.ready === 1);
    assert.equal(await frame.evaluate(() => window.state.start.readOnly), true);
    assert.equal(await page.evaluate(() => window.privateEditorFixture.state.published), 0);
    await frame.evaluate(() => window.command("SAVE", new Blob(["unauthorized"])))
    await frame.waitForFunction(() => window.state.acks.some(ack => ack.args?.error === "SAVE_REJECTED"));
    assert.deepEqual(await page.evaluate(() => window.privateEditorFixture.state.saved), []);
    await page.evaluate(() => window.privateEditorFixture.close());
    assert.equal(await page.locator("#private-office").getAttribute("src"), "about:blank");
  } finally { await context.close(); }
});

test("a reader can open an unshared copy before an editor initializes the shared session", async () => {
  const { context, page, frame } = await open(false);
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(() => window.privateEditorFixture.state.ready === 1);
    assert.equal(await frame.evaluate(() => window.state.start.readOnly), true);
    assert.equal(await frame.evaluate(() => window.state.start.autosave), false);
    assert.equal(await frame.evaluate(() => window.state.start._config.sortsysPersistentRoom), false);
    assert.equal(await page.evaluate(() => window.privateEditorFixture.state.published), 0);
    await frame.evaluate(() => window.command("SAVE", new Blob(["unauthorized clone"])))
    await frame.waitForFunction(() => window.state.acks.some(ack => ack.args?.error === "SAVE_REJECTED"));
    assert.deepEqual(await page.evaluate(() => window.privateEditorFixture.state.saved), []);
  } finally { await context.close(); }
});

test("a requested browser export accepts only the expected frame and rejects overlapping or late replies", async () => {
  const { context, page, frame } = await open(false, "view-capability");
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(() => window.privateEditorFixture.state.ready === 1);
    await page.evaluate(() => {
      window.exportResult = null;
      window.privateEditorFixture.export("docx").then(blob => blob.text()).then(value => window.exportResult = value);
    });
    await frame.waitForFunction(() => window.state.exports.length === 1);
    assert.equal(await page.evaluate(() => window.privateEditorFixture.export("pdf").then(() => false, () => true)), true);
    await page.evaluate(() => window.postMessage({ msg: { q: "ON_DOWNLOADAS", data: new Blob(["wrong window"]) }, txid: "fake" }, location.origin));
    assert.equal(await page.evaluate(() => window.exportResult), null);
    await frame.evaluate(() => window.command("ON_DOWNLOADAS", new Blob(["local converted export"])));
    await page.waitForFunction(() => window.exportResult === "local converted export");
    await frame.evaluate(() => window.command("ON_DOWNLOADAS", new Blob(["late export"])));
    await frame.waitForFunction(() => window.state.acks.some(ack => ack.args?.error === "EXPORT_NOT_REQUESTED"));
    await page.evaluate(() => {
      window.exportResult = null;
      window.privateEditorFixture.export("pdf").then(() => window.exportResult = "unexpected", () => window.exportResult = "cancelled");
      window.privateEditorFixture.close();
    });
    await page.waitForFunction(() => window.exportResult === "cancelled");
    assert.deepEqual(await page.evaluate(() => window.privateEditorFixture.state.saved), []);
  } finally { await context.close(); }
});

test("the normal Excel export opens local bytes, downloads the browser conversion and removes the frame on account reset", async () => {
  const context = await browser.newContext(), page = await context.newPage();
  const uploads = [];
  page.on("request", request => { if (request.method() !== "GET") uploads.push(request.url()); });
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(origin => window.privateEditorFixture.exportExcel(origin), editor.origin);
    const locate = () => page.locator('iframe[title="Excel-Export"],iframe[title="Excel export"]');
    const frame = await (await locate().elementHandle()).contentFrame();
    await frame.waitForFunction(() => window.boot); await frame.evaluate(() => window.boot());
    await frame.waitForFunction(() => window.state.start !== null);
    assert.equal(await frame.evaluate(() => window.state.start.document), "private generated workbook");
    assert.equal(await frame.evaluate(() => window.state.start.application), "sheet");
    assert.equal(await frame.evaluate(() => window.state.start._config.sortsysPersistentRoom), false);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Herunterladen|Download/, exact: true }).click();
    await frame.waitForFunction(() => window.state.exports[0] === "xlsx");
    await frame.evaluate(() => window.command("ON_DOWNLOADAS", new Blob(["edited browser workbook"])));
    const file = await download, stream = await file.createReadStream();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.equal(file.suggestedFilename(), "Projekt.xlsx");
    assert.equal(Buffer.concat(chunks).toString(), "edited browser workbook");
    assert.deepEqual(await page.evaluate(() => window.exportQueries), ["zerotrust.editors.config"]);
    assert.deepEqual(uploads, []);
    await page.evaluate(() => window.resetExportContext());
    await locate().waitFor({ state: "detached" });
    assert.equal(frame.isDetached(), true);
  } finally { await context.close(); }
});

test("a failed conversion cannot supply a late result to a later export request", async () => {
  const { context, page, frame } = await open(false, "view-capability");
  try {
    await frame.evaluate(() => window.boot());
    await page.waitForFunction(() => window.privateEditorFixture.state.ready === 1);
    await page.evaluate(() => {
      window.exportResult = null;
      window.privateEditorFixture.export("docx").then(() => window.exportResult = "unexpected", () => window.exportResult = "failed");
    });
    await frame.waitForFunction(() => window.state.exports.length === 1);
    await frame.evaluate(() => window.command("DOCUMENT_ERROR", "X2T_ERROR"));
    await page.waitForFunction(() => window.exportResult === "failed");
    assert.equal(await page.evaluate(() => window.privateEditorFixture.export("pdf").then(() => false, () => true)), true);
    await frame.evaluate(() => window.command("ON_DOWNLOADAS", new Blob(["old conversion"])));
    await frame.waitForFunction(() => window.state.acks.some(ack => ack.args?.error === "EXPORT_NOT_REQUESTED"));
    assert.equal(await page.evaluate(() => window.exportResult), "failed");
    assert.equal(await page.evaluate(() => window.privateEditorFixture.state.errors), 1);
  } finally { await context.close(); }
});

test("the normal protected Office component removes the old iframe on a rights reset and opens only the new view capability", async () => {
  const context = await browser.newContext(), page = await context.newPage();
  try {
    await page.goto(`${server.origin}/private-editors.html`);
    await page.waitForFunction(() => window.privateEditorFixture);
    await page.evaluate(origin => window.privateEditorFixture.protected(origin), editor.origin);
    const locate = () => page.locator('iframe[title="Office-Dokument"],iframe[title="Office document"]');
    const first = await (await locate().elementHandle()).contentFrame();
    await first.waitForFunction(() => window.boot); await first.evaluate(() => window.boot());
    await first.waitForFunction(() => window.state.start?.readOnly === false);
    await locate().waitFor({ state: "visible" });
    await first.evaluate(() => window.command("SAVE", new Blob(["actual component save"])));
    await page.waitForFunction(() => window.privateEditorFixture.state.saved.length === 1);
    await page.evaluate(() => window.downgradePrivateOffice());
    await page.waitForFunction(() => window.privateEditorFixture.state.ready >= 2);
    await locate().waitFor({ state: "attached" });
    assert.equal(first.isDetached(), true);
    const second = await (await locate().elementHandle()).contentFrame();
    await second.waitForFunction(() => window.boot); await second.evaluate(() => window.boot());
    await second.waitForFunction(() => window.state.start?.readOnly === true);
    assert.equal(await second.evaluate(() => window.state.start.key), "view-capability");
    assert.equal(await page.evaluate(() => window.privateEditorFixture.state.published), 1);
    await second.evaluate(() => window.command("SAVE", new Blob(["denied after downgrade"])));
    await second.waitForFunction(() => window.state.acks.some(ack => ack.args?.error === "SAVE_REJECTED"));
    assert.deepEqual(await page.evaluate(() => window.privateEditorFixture.state.saved), ["actual component save"]);
  } finally { await context.close(); }
});
