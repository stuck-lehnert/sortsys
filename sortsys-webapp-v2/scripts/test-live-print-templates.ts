import assert from "node:assert/strict";
import type { Client, QueryResult } from "@sortsys/v2-client";
import { base64, bytes } from "@sortsys/zerotrust";
import type { BusinessDatabase } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { preparePrintTemplates } from "../app/lib/data/migratePrintTemplates";
import { PRINT_COLLECTION } from "../app/lib/data/organizationData";
import { PRINT_OBJECT, printTemplatePayload, readTemplateResource } from "../app/lib/data/printTemplateData";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";

export async function seedPrintTemplates(client: Client) {
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1") throw new Error("Disposable test stack only");
  const original = await required(client.query("settings.documentTemplate.get", undefined));
  await required(client.mutate("settings.documentTemplate.set", { source: "// Vertraulicher Musterkopf 48931\n#let briefkopf = [Bau und Handwerk]\n", expectedRevision: original.revision }));
  const originals = new Map<string, Uint8Array>();
  for (const [name, mimeType, file] of [
    ["Musterlogo-48931.png", "image/png", new URL("../public/icon-black-192x192.png", import.meta.url)],
    ["Musterbriefpapier-48931.pdf", "application/pdf", new URL("../../sortsys-api-v2/test-files/searchable-project-document.pdf", import.meta.url)],
  ] as const) {
    const content = new Uint8Array(await Bun.file(file!).arrayBuffer());
    const draft = await required(client.mutate("settings.documentTemplate.assets.createUpload", { name: name!, mimeType: mimeType!, sizeBytes: content.length }));
    const uploaded = await fetch(draft.uploadUrl, { method: draft.uploadMethod, headers: draft.uploadHeaders, body: new Blob([content], { type: mimeType }) });
    assert.equal(uploaded.ok, true); await required(client.mutate("settings.documentTemplate.assets.completeUpload", { id: draft.id }));
    originals.set(name!, content);
  }
  return { template: await required(client.query("settings.documentTemplate.get", undefined, { strategy: "network-only" })), originals };
}

export async function testProtectedPrintTemplates(client: Client, source: BusinessDatabase, subject: string,
  fixture: { template: QueryResult<"settings.documentTemplate.get">; originals: Map<string, Uint8Array> }) {
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1") throw new Error("Disposable test stack only");
  const signal = new AbortController().signal;
  await preparePrintTemplates(client, source, subject, signal); await preparePrintTemplates(client, source, subject, signal);
  const area = await protectedCollection(client, PRINT_COLLECTION, signal);
  let original: ReturnType<typeof printTemplatePayload>;
  try { const object = (await area.read())[0]!; original = printTemplatePayload(object.value, object.envelope.object); } finally { area.close(); }
  async function restore(payload = original) {
    const collection = await protectedCollection(client, PRINT_COLLECTION, signal);
    try {
      const previous = (await collection.read())[0]!, packet = await collection.packet(PRINT_OBJECT, payload, previous.envelope);
      await commitProtectedWrites(client, [{ packets: [packet], head: { domain: PRINT_COLLECTION.domain, sequence: collection.snapshot() },
        async verify() { return (await collection.read())[0]?.envelope.signature === packet.envelope.signature; }, close() { collection.close(); } }], signal);
    } finally { collection.close(); }
  }
  const sent: { path: string; input: unknown }[] = [];
  let discardChunks = false, discardMetadata = false;
  const observed: Client = { ...client, query: (async (path, input, options) => {
    sent.push({ path, input });
    if (path === "auth.sessionInfo") {
      const reply = await client.query("auth.sessionInfo", undefined, options);
      return reply[0] ? [{ ...reply[0], roles: [] }, reply[1]] : reply;
    }
    return client.query(path, input, options);
  }) as Client["query"],
    mutate: ((path, input, options) => { sent.push({ path, input });
      if (path === "zerotrust.fileChunks.put" && discardChunks || path === "zerotrust.objects.batch" && discardMetadata) return Promise.resolve([{ success: true }, null]);
      return client.mutate(path, input, options);
    }) as Client["mutate"] };
  const business = createBusinessClient(observed), peer = createBusinessClient(observed);
  try {
    const loaded = await required(business.query("settings.documentTemplate.get", undefined));
    assert.equal(loaded.source, fixture.template.source); assert.equal(loaded.revision, fixture.template.revision);
    const metadata = (value: typeof loaded) => value.assets.map(({ downloadUrl, ...asset }) => asset).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(metadata(loaded), metadata(fixture.template));
    for (const asset of loaded.assets) {
      const resource = readTemplateResource(asset.downloadUrl!); assert.equal(resource.version, "legacy");
      assert.deepEqual(new Uint8Array(await (await business.templates.blob(resource.id, resource.version)).arrayBuffer()), fixture.originals.get(asset.name));
    }
    const corrupt = structuredClone(original);
    corrupt.assets[0]!.content.parts[0]!.hash = base64(new Uint8Array(32));
    await restore(corrupt);
    const poisoned = readTemplateResource(loaded.assets[0]!.downloadUrl!);
    await assert.rejects(() => business.templates.blob(poisoned.id, poisoned.version), "A signed but substituted manifest cannot replace verified block bytes");
    await restore();
    const putCount = sent.filter(request => request.path === "zerotrust.fileChunks.put").length;
    await assert.rejects(() => business.templates.upload(new File(["<svg><image href='https://outside.example/private.png'/></svg>"], "Remote.svg", { type: "image/svg+xml" })));
    assert.equal(sent.filter(request => request.path === "zerotrust.fileChunks.put").length, putCount, "Network-bearing SVG must fail before staging any bytes");
    const padded = new Uint8Array(256 * 1024 * 3 + 17), png = fixture.originals.get("Musterlogo-48931.png")!;
    padded.set(png); padded.set(bytes("Vertrauliches Briefpapier 48931"), padded.length - 40);
    const selected = new File([padded], "Privates-Logo-48931.png", { type: "image/png" });
    discardChunks = true;
    await assert.rejects(() => business.templates.upload(selected), "An acknowledgement cannot publish missing blocks");
    discardChunks = false;
    const created = await business.templates.upload(selected);
    const after = await required(business.query("settings.documentTemplate.get", undefined)), asset = after.assets.find(asset => asset.id === created)!;
    const resource = readTemplateResource(asset.downloadUrl!);
    assert.deepEqual(new Uint8Array(await (await business.templates.blob(created, resource.version)).arrayBuffer()), padded);
    const chunk = (await protectedCollection(client, PRINT_COLLECTION, signal));
    try {
      const catalog = printTemplatePayload((await chunk.read())[0]!.value, PRINT_OBJECT), first = catalog.assets.find(asset => asset.id === created)!.content.parts[0]!;
      assert.ok((await client.query("zerotrust.fileChunks.get", { domain: "organization:billing", id: first.id }, { strategy: "network-only" }))[1]);
    } finally { chunk.close(); }
    const replacement = await business.templates.upload(selected);
    assert.notEqual(created, replacement);
    await assert.rejects(() => business.templates.blob(created, resource.version), "Replaced assets must not resolve through the current catalogue");
    const previous = await required(business.query("settings.documentTemplate.get", undefined));
    const code = "// Privater Typst-Code 48931\n#let footer = [Bau GmbH]\n";
    discardMetadata = true;
    assert.ok((await business.mutate("settings.documentTemplate.set", { source: code, expectedRevision: previous.revision }))[1]);
    discardMetadata = false;
    await business.invalidate("settings.documentTemplate.get");
    assert.equal((await required(business.query("settings.documentTemplate.get", undefined))).source, previous.source);
    const saved = await required(business.mutate("settings.documentTemplate.set", { source: code, expectedRevision: previous.revision }));
    assert.equal(saved.source, code);
    await required(business.mutate("settings.documentTemplate.set", { source: code, expectedRevision: previous.revision })); // Durable equal-content retry.
    assert.ok((await business.mutate("settings.documentTemplate.set", { source: code + "// stale", expectedRevision: previous.revision }))[1]);
    const outcomes = await Promise.all([
      business.mutate("settings.documentTemplate.set", { source: code + "// A", expectedRevision: saved.revision }),
      peer.mutate("settings.documentTemplate.set", { source: code + "// B", expectedRevision: saved.revision }),
    ]);
    assert.equal(outcomes.filter(result => result[1] === null).length, 1);
    await required(business.mutate("settings.documentTemplate.assets.delete", { id: replacement }));
    await business.invalidate("settings.documentTemplate.get");
    assert.equal((await required(business.query("settings.documentTemplate.get", undefined))).assets.some(asset => asset.id === replacement), false);
    const wire = JSON.stringify(sent);
    for (const secret of ["Musterlogo-48931.png", "Musterbriefpapier-48931.pdf", "Privates-Logo-48931.png", "Vertrauliches Briefpapier 48931", "Privater Typst-Code 48931"]) assert.equal(wire.includes(secret), false);
    assert.equal(sent.some(request => request.path.startsWith("settings.")), false, "Print data must never reach plaintext settings or presigned-upload procedures");
  } finally { discardMetadata = discardChunks = false; business.dispose(); peer.dispose(); await restore(); }
  console.log("Encrypted print templates verified: legacy source/PDF/image conversion, exact original bytes, private chunk bindings, signature/hash substitution denial, local SVG rejection, multi-block uploads, false ACKs, replacements, code revisions/concurrent edits and no plaintext uploads or settings calls.");
}
