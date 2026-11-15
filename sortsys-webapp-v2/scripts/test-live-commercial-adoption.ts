import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import type { GaebXmlProcessor } from "@sortsys/gaeb";
import { readGaebInput } from "../../sortsys-gaeb/src/core/legacy";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import type { DuckDriver } from "../app/lib/data/database";
import { openProjectCommercial } from "../app/lib/data/projectCommercial";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { decodeBusinessRow } from "../app/lib/data/rowCodec";
import { businessSchema } from "../app/lib/data/schema";
import { addressId } from "../app/lib/data/addressBook";
import { newProductRowId } from "../app/lib/data/products";
import { projectCollection, projectPayload } from "../app/lib/data/projectData";
import { gaebWorkflowXml as xml } from "./test-live-gaeb-workflows";

function legacyInput(kind: "d" | "p") {
  if (kind === "p") {
    const text = readFileSync(new URL("../../sortsys-gaeb/scripts/fixtures/legacy/anfrage.p83", import.meta.url), "utf8").replace("[DP]83[end]", "[DP]84[end]")
      .replace("[ME]m²[end]", "[ME]m²[end][EP]12,340[end][GB]154,25[end]");
    return new TextEncoder().encode(text);
  }
  const records = readFileSync(new URL("../../sortsys-gaeb/scripts/fixtures/legacy/anfrage.d83", import.meta.url)).toString("latin1").trimEnd().split(/\r?\n/);
  records[0] = records[0]!.slice(0, 10) + "84" + records[0]!.slice(12);
  const fields = Array(80).fill(" "); for (const [offset, text] of [[0, "23"], [2, "01010010A"], [12, "00000012340"], [24, "000000015425"]] as const) for (let i = 0; i < text.length; i++) fields[offset + i] = text[i];
  records.splice(9, 0, fields.join(""));
  return new Uint8Array(Buffer.from(records.map((row, i) => row.slice(0, 74).padEnd(74, " ") + String(i + 1).padStart(6, "0")).join("\r\n"), "latin1"));
}
export async function testContractAdoption(client: Client, driver: () => Promise<DuckDriver>, processor: GaebXmlProcessor, customerId: string, password: string) {
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "adoption-peer"), signal = new AbortController().signal;
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  let lose = false, race: (() => Promise<void>) | null = null; const requests: { path: string; input: unknown }[] = [];
  const observed: Client = { ...client, query: ((path, input, options) => { requests.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input });
      const publication = path === "zerotrust.objects.batch" && !!(input as MutateInput<"zerotrust.objects.batch">).documents?.length;
      if (publication && race) { const run = race; race = null; await run(); }
      const result = await client.mutate(path, input, options);
      if (publication && lose && !result[1]) { lose = false; return [null, new Error("Synthetic lost adoption acknowledgement")]; } return result;
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, { productDriver: driver, gaebProcessor: processor }), other = createBusinessClient(peer, { productDriver: driver, gaebProcessor: processor });
  const project = async (title: string) => {
    const created = await required(business.mutate("projects.create", { title, customerId, orderReceivedAt: new Date("2026-06-08T07:12:13.123Z") }));
    // Legacy PostgreSQL dates can carry microseconds beyond a JavaScript Date.
    // Install that exact row through the authenticated encrypted object path.
    const area = projectCollection(created.id), collection = await protectedCollection(observed, area, signal);
    try {
      const object = (await collection.read())[0]!, payload = projectPayload(object.value, object.envelope.object, created.id);
      const source = decodeBusinessRow({ ...payload.project!, values: { ...payload.project!.values, order_received_at: "2026-06-08T07:12:13.123456Z" } });
      await collection.write([await collection.packet(area.prefix, { ...payload, project: source }, object.envelope)]);
    } finally { collection.close(); }
    return created;
  };
  const adopt = (projectId: string, phase: "84" | "85" | "86" | "87") => ({ projectId, title: `Geschützter Bestandsauftrag ${phase}`, sourcePhase: phase, sourceFileName: `Altauftrag.x${phase}`,
    sourceXml: xml(phase), offerXml: phase === "84" ? null : xml("84"), referenceXml: null, netAmount: "1776.00" });
  let stage = "validation before provisioning";
  try {
    const first = await project("Übernahme aus X84"), input = adopt(first.id, "84"), count = (await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length;
    for (const patch of [{ sourcePhase: "83" }, { sourceXml: xml("87") }, { sourceXml: xml("84").replace("<GAEBInfo>", "<GAEBInfo><Unexpected/>") }, { sourceFileName: "../Altauftrag.x84" }]) assert.ok((await business.mutateDynamic("commercial.cases.adoptContract", { ...input, ...patch }))[1]);
    assert.equal((await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length, count);
    for (const phase of ["84", "85", "86", "87"] as const) {
      stage = `native ${phase} adoption`;
      const target = phase === "84" ? first : await project(`Übernahme aus X${phase}`);
      if (phase === "84") lose = true;
      const created = await required(business.mutate("commercial.cases.adoptContract", adopt(target.id, phase)));
      assert.equal(lose, false);
      const detail = await required(business.query("commercial.cases.get", { id: created.id }));
      assert.equal(detail.case.status, "accepted"); assert.equal(detail.case.kind, "offer"); assert.equal(detail.case.existingContract, true); assert.equal(detail.case.projectId, target.id);
      assert.equal(detail.case.customerId, customerId); assert.equal(detail.case.acceptedAt, "2026-06-08T07:12:13.123456Z");
      assert.equal(detail.documents.filter(document => document.phase === "86").length, phase === "86" ? 1 : 0, "Adoption must not invent an award");
      const source = detail.documents.find(document => document.phase === phase)!;
      const loaded = await required(business.query("commercial.documents.get", { caseId: created.id, id: source.id })); assert.equal(loaded.xml, xml(phase)); assert.equal(loaded.canEdit, false);
      for (const document of detail.documents) assert.equal(document.readOnly, true);
      if (phase !== "84") { const snapshot = detail.documents.find(document => document.phase === "84")!; assert.equal(snapshot.sourceDocumentId, source.id); assert.equal(snapshot.sourceVersion, 1n); }
      const register = await openProjectCommercial(observed, target.id, "offer-prices", signal);
      try { assert.equal(register.value.mainCaseId, created.id); assert.equal(register.value.offers.length, 1); assert.equal(register.value.offers[0]!.exactAmount, "1776.00"); } finally { register.close(); }
      const existing = (await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length;
      assert.ok((await business.mutate("commercial.cases.adoptContract", adopt(target.id, phase)))[1]);
      assert.equal((await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length, existing);
    }
    stage = "historic bookkeeping is retained";
    const recorded = await project("Historische Angebotssumme bleibt erhalten"), legacy = await openProjectCommercial(observed, recorded.id, "offer-prices", signal);
    try {
      const { commitProtectedWrites } = await import("../app/lib/data/atomicWrites");
      const actor = (await required(client.query("auth.sessionInfo", undefined))).user.id;
      const row = decodeBusinessRow({ format: "sortsys-row-v2", schema: businessSchema.fingerprint, table: "project_financial_entries", values: { id: newProductRowId(), project_id: addressId(recorded.id),
        type: "offer", amount: 5000, comment: "Bereits erfasst", created_by_user_id: addressId(actor), created_at: new Date().toISOString(), commercial_case_id: null } });
      await commitProtectedWrites(client, [await legacy.prepare({ ...legacy.value, offers: [{ row, exactAmount: "5000.00" }] })], signal);
    } finally { legacy.close(); }
    await required(business.mutate("commercial.cases.adoptContract", adopt(recorded.id, "86")));
    const kept = await openProjectCommercial(observed, recorded.id, "offer-prices", signal);
    try { assert.equal(kept.value.offers.length, 1); assert.equal(kept.value.offers[0]!.exactAmount, "5000.00"); } finally { kept.close(); }
    stage = "concurrent project completion rolls back all metadata and document heads";
    const stopped = await project("Übernahme bei Projektabschluss");
    race = async () => { await required(other.mutate("projects.finish", { id: stopped.id })); };
    assert.ok((await business.mutate("commercial.cases.adoptContract", adopt(stopped.id, "87")))[1]); assert.equal(race, null);
    await business.invalidate("commercial.cases.list"); assert.equal((await required(business.query("commercial.cases.list", { projectId: stopped.id }))).length, 0);
    const empty = await openProjectCommercial(observed, stopped.id, "offer-prices", signal);
    try { assert.equal(empty.value.mainCaseId, null); assert.equal(empty.value.offers.length, 0); } finally { empty.close(); }
    stage = "concurrent adoption on independent API replicas";
    const concurrent = await project("Parallele Bestandsübernahme"); let winner: string | null = null;
    race = async () => { winner = (await required(other.mutate("commercial.cases.adoptContract", adopt(concurrent.id, "85")))).id; };
    assert.ok((await business.mutate("commercial.cases.adoptContract", adopt(concurrent.id, "86")))[1]); assert.equal(race, null); assert.ok(winner);
    await business.invalidate("commercial.cases.list"); const cases = await required(business.query("commercial.cases.list", { projectId: concurrent.id }));
    assert.equal(cases.length, 1); assert.equal(cases[0]!.id, winner);
    for (const kind of ["d", "p"] as const) {
      stage = `client-decoded ${kind}84 contract adoption`;
      const bytes = legacyInput(kind), input = readGaebInput(bytes, `Original.${kind}84`), target = await project(`Älterer Auftrag ${kind.toUpperCase()}84`);
      const created = await required(business.mutate("commercial.cases.adoptContract", { projectId: target.id, title: `Originalauftrag ${kind}`, sourcePhase: "84", sourceFileName: input.fileName, sourceXml: input.xml,
        referenceXml: input.referenceXml!, offerXml: null, netAmount: "154.25" }));
      const detail = await required(business.query("commercial.cases.get", { id: created.id })), document = detail.documents.find(document => document.phase === "84")!;
      const content = await required(business.query("commercial.documents.get", { caseId: created.id, id: document.id }));
      assert.equal(content.xml, input.xml); assert.equal(content.referenceXml, input.referenceXml); assert.ok(content.xml.includes(Buffer.from(bytes).toString("base64")));
    }
    for (const secret of ["Geschützter Bestandsauftrag", "Altauftrag.x84", "Original.d84", "Original.p84", "<GAEB"]) assert.equal(JSON.stringify(requests).includes(secret), false, secret);
    console.log("Protected contract adoption verified: all four supplied phases, no invented award, original/read-only XML and exact timestamps, loss acknowledgement, existing bookkeeping, same-project concurrent adoption and completion fences, client-decoded D84/P84 with retained originals, and no plaintext API payloads.");
  } catch (cause) { throw new Error(`Protected contract adoption failed at ${stage}`, { cause }); }
  finally { business.dispose(); other.dispose(); }
}
