import assert from "node:assert/strict";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { base64, bytes } from "@sortsys/zerotrust";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { readBusinessRows, publicId } from "../app/lib/data/products";
import { prepareProjectFiles } from "../app/lib/data/migrateProjectFiles";
import { chunkCollection, fileCollection, filePayload, fileObject, parsePrivateFileUrl, FILE_CHUNK_BYTES } from "../app/lib/data/projectFileData";
import { loadFileContent } from "../app/lib/data/fileContent";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { acceptVault, signIn, unlockedAccount } from "../app/lib/crypto/session";

export async function testProtectedProjectFiles(raw: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, password: string) {
  const signal = new AbortController().signal, legacy = await readBusinessRows(source, "project_files");
  const account = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "file-reference-peer");
  await signIn(peer, { tenant: account.tenant, username: account.username, password }); await acceptVault(account.exportKey, account.vault, false);
  await prepareProjectFiles(raw, source, subject, signal);
  await prepareProjectFiles(raw, source, subject, signal); // Exact confirmed files resume without fetching originals again.
  const sent: { path: string; input: unknown }[] = [];
  let loseBlock = false, loseManifest = false, lostBlock = false, lostManifest = false, falseManifest = false, raceReference = false;
  const other = createBusinessClient(peer, { productDriver: driver });
  const observed: Client = { ...raw, query: ((path, input, options) => { sent.push({ path, input }); return raw.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      if (path === "zerotrust.objects.batch" && falseManifest) {
        const batch = input as MutateInput<"zerotrust.objects.batch">;
        return [{ success: true, heads: [{ domain: batch.objects[0].domain, sequence: (BigInt(batch.heads![0].sequence) + 1n).toString() }] }, null];
      }
      const result = await raw.mutate(path, input, options);
      if (path === "zerotrust.fileChunks.put" && raceReference) {
        raceReference = false; await required(other.mutate("projects.update", { id: projectId, data: { title: "Projekt zwischen Dateiprüfung und Speicherung geändert" } }));
      }
      if (!result[1] && path === "zerotrust.fileChunks.put" && loseBlock) { loseBlock = false; lostBlock = true; return [null, new Error("Synthetic lost block acknowledgement")]; }
      if (!result[1] && path === "zerotrust.objects.batch" && loseManifest) { loseManifest = false; lostManifest = true; return [null, new Error("Synthetic lost manifest acknowledgement")]; }
      return result;
    }) as Client["mutate"] };
  let business = createBusinessClient(observed, { productDriver: driver });
  const file = legacy.find(row => row.values.status === "uploaded")!, projectId = publicId(file.values.project_id);
  try {
    const listed = await required(business.query("projects.files.list", { projectId }));
    assert.equal(listed.length, legacy.filter(row => row.values.project_id === file.values.project_id && row.values.status === "uploaded").length);
    for (const extension of [".pdf", ".dwg", ".msg", ".eml"]) {
      const selected = legacy.find(row => row.values.status === "uploaded" && (row.values.file_name as string).toLowerCase().endsWith(extension));
      assert.ok(selected, `Expected static ${extension} seed fixture`);
      const id = publicId(selected.values.id), project = publicId(selected.values.project_id);
      const direct = await required(raw.query("zerotrust.migration.file", { fileId: id, thumbnail: false }, { strategy: "network-only" }));
      const original = new Uint8Array(await (await fetch(direct.url)).arrayBuffer());
      assert.deepEqual(new Uint8Array(await (await business.files.blob(project, id)).arrayBuffer()), original, `Encrypted ${extension} bytes differ from the frozen original`);
    }
    const folders = await required(business.query("projects.files.folders.list", { projectId }));
    const folder = await required(business.mutate("projects.files.folders.create", { projectId, name: "Vertrauliche Werkplanung" }));
    const child = await required(business.mutate("projects.files.folders.create", { projectId, name: "Obergeschoss", parentFolderId: folder.id }));
    assert.ok((await business.mutate("projects.files.folders.move", { projectId, folderId: folder.id, parentFolderId: child.id }))[1], "Folder cycles must fail locally before publication");
    assert.ok((await business.mutate("projects.files.folders.delete", { projectId, folderId: folder.id }))[1]);
    const binary = new Uint8Array(FILE_CHUNK_BYTES * 3 + 17);
    for (let index = 0; index < binary.length; index++) binary[index] = (index * 31 + 7) % 251;
    binary.set(bytes("SENSITIVE-CALCULATION-97531.2468"), 100);
    const name = "Private Nachkalkulation.bin";
    loseBlock = true; loseManifest = true;
    const id = await business.files.upload({ projectId, folderId: child.id, name, mime: "application/octet-stream", blob: new Blob([binary]) });
    assert.equal(lostBlock, true); assert.equal(lostManifest, true);
    falseManifest = true;
    try { await assert.rejects(() => business.files.upload({ projectId, name: "False acknowledgement must not create a file.bin", mime: "application/octet-stream", blob: new Blob([binary]) })); }
    finally { falseManifest = false; }
    raceReference = true;
    await assert.rejects(() => business.files.upload({ projectId, name: "Reference race must roll back metadata.bin", mime: "application/octet-stream", blob: new Blob([binary]) }));
    assert.equal(raceReference, false);
    assert.equal((await required(business.query("projects.files.list", { projectId }))).some(file => /False acknowledgement|Reference race/.test(file.fileName)), false);
    assert.deepEqual(new Uint8Array(await (await business.files.blob(projectId, id)).arrayBuffer()), binary);
    const metadata = await protectedCollection(raw, fileCollection(projectId), signal);
    let manifest;
    try { const entry = (await metadata.read()).find(row => row.envelope.object === fileObject(projectId, id))!; manifest = filePayload(entry.value, entry.envelope.object, projectId).original!; }
    finally { metadata.close(); }
    assert.equal(manifest.parts.length, 4);
    const first = await required(raw.query("zerotrust.fileChunks.get", { domain: fileCollection(projectId).domain, id: manifest.parts[0].id }, { strategy: "network-only" }));
    await required(raw.mutate("zerotrust.fileChunks.put", { domain: fileCollection(projectId).domain, envelope: first })); // Idempotent exact retry.
    const blocks = await protectedCollection(raw, chunkCollection(projectId), signal);
    try {
      const changed = await blocks.packet(first.object, { format: "sortsys-file-block-v1", data: base64(new Uint8Array(FILE_CHUNK_BYTES)) }, undefined, true);
      assert.ok((await raw.mutate("zerotrust.fileChunks.put", { domain: fileCollection(projectId).domain, envelope: changed.envelope }))[1], "A valid writer cannot overwrite an immutable chunk");
    } finally { blocks.close(); }
    const substitute: Client = { ...raw, query: ((path, input, options) => {
      if (path === "zerotrust.fileChunks.get" && (input as { id: string }).id === manifest.parts[1].id) return Promise.resolve([first, null]);
      return raw.query(path, input, options);
    }) as Client["query"] };
    await assert.rejects(() => loadFileContent(substitute, projectId, id, manifest, "application/octet-stream", signal), "Reordered or substituted blocks must never produce a file");
    const results = await required(business.query("projects.files.list", { projectId })), added = results.find(file => file.id === id)!;
    assert.equal(added.fileName, name); assert.equal(parsePrivateFileUrl(added.downloadUrl!).fileId, id);
    assert.ok(results.every(file => !file.downloadUrl || file.downloadUrl.startsWith("sortsys-private:")));
    const rendition = parsePrivateFileUrl(added.downloadUrl!), beforeResource = sent.length;
    const lease = await business.files.url(projectId, id, rendition.revision);
    assert.deepEqual(new Uint8Array(await (await fetch(lease.url)).arrayBuffer()), binary);
    const resourceReads = sent.slice(beforeResource);
    assert.equal(resourceReads.some(request => request.path === "zerotrust.objects.list"), false, "A known rendition must not reload the metadata collection for every preview");
    assert.ok(resourceReads.some(request => request.path === "zerotrust.policy.get"), "Cached rendition metadata must still recheck current authorization");
    lease.dispose(); await assert.rejects(() => fetch(lease.url), "Closing a resource lease must revoke its local URL");
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(() => business.files.url(projectId, id, rendition.revision, false, cancelled.signal));
    const sessionLease = await business.files.url(projectId, id, rendition.revision);
    await required(business.mutate("projects.files.rename", { projectId, fileId: id, fileName: "Überarbeitete Nachkalkulation.bin" }));
    await required(business.mutate("projects.files.move", { projectId, fileIds: [id], folderId: folder.id }));
    const modified = await business.files.save(projectId, id, 1n, new Blob([bytes("New private content after saving")], { type: "application/octet-stream" }));
    assert.equal(modified.version, 2n);
    await assert.rejects(() => business.files.save(projectId, id, 1n, new Blob(["Stale content"])), "Stale editor saves cannot overwrite a newer file");
    assert.equal(await (await business.files.blob(projectId, id)).text(), "New private content after saving");
    await required(business.mutate("projects.files.folders.delete", { projectId, folderId: child.id }));
    assert.ok((await business.mutate("projects.files.folders.delete", { projectId, folderId: folder.id }))[1], "A folder containing a file cannot be deleted");
    assert.equal((await required(business.query("projects.files.folders.list", { projectId }))).length, folders.length + 1);
    const history = JSON.stringify(sent);
    for (const secret of [name, "Überarbeitete Nachkalkulation.bin", "Vertrauliche Werkplanung", "SENSITIVE-CALCULATION-97531.2468", "New private content after saving"]) assert.equal(history.includes(secret), false, `Plaintext escaped through an API request: ${secret}`);
    assert.equal(sent.some(request => request.path === "projects.files.createUpload" || request.path === "projects.files.completeUpload"), false);
    business.dispose(); await assert.rejects(() => fetch(sessionLease.url), "Resetting the business context must revoke outstanding local URLs");
    business = createBusinessClient(raw, { productDriver: driver });
    assert.equal(await (await business.files.blob(projectId, id)).text(), "New private content after saving");
    await required(business.mutate("projects.files.delete", { projectId, fileId: id }));
    await assert.rejects(() => business.files.blob(projectId, id));
    await required(business.mutate("projects.files.folders.delete", { projectId, folderId: folder.id }));
  } finally { business.dispose(); other.dispose(); }
  console.log("Encrypted project files verified: original PDF/DWG/MSG/EML bytes, resumable source conversion, immutable bounded blocks, manifest substitution denial, private metadata, folder cycles/references, existing CRUD, version conflicts and fresh-client reopening without plaintext uploads.");
}
