import type { Client, MutateInput } from "@sortsys/v2-client";
import { InvalidProtectedData, record, sized } from "@sortsys/zerotrust";
import { unlockedAccount } from "../crypto/session";
import { addressId, partialAddressRecord } from "./addressBook";
import { commitProtectedWrites, ProtectedWriteConflict, type PreparedWrites } from "./atomicWrites";
import { createBusinessDatabase, type DuckDriver } from "./database";
import { deliveryChanges } from "./deliveryChanges";
import { deliveryCollection, deliveryPayload, deliveryPrices, DELIVERY_MUTATIONS, type DeliveryPayload, type DeliveryPrices } from "./deliveryNoteData";
import { allocateDeliveryNote, deliveryAllocation, deliveryRequestContext, deliveryRequestFingerprint } from "./deliveryRegistry";
import { newProductRowId, PRODUCT_COLLECTION, productPayload, publicId } from "./products";
import { projectCollection, projectPayload } from "./projectData";
import { projectFacetRows } from "./projection";
import { protectedCollections, required } from "./protectedObjects";
import { businessSchema } from "./schema";
import type { BusinessRow } from "./rowCodec";
type Receipt = {
  format: "sortsys-delivery-create-v1";
  author: string;
  requestId: string;
  requestHash: string;
  id: string;
  number: string;
};
function receipt(input: unknown): Receipt {
  const data = record(input, ["format", "author", "requestId", "requestHash", "id", "number"]);
  if (data.format !== "sortsys-delivery-create-v1" || typeof data.author !== "string" || !data.author.startsWith("user:") || typeof data.requestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(data.requestId)
    || typeof data.number !== "string" || !/^[1-9]\d{0,18}$/.test(data.number))
    throw new InvalidProtectedData();
  addressId(data.author.slice(5));
  addressId(data.id);
  sized(data.requestHash as string, 32);
  return data as Receipt;
}
const row = (table: string, values: Record<string, unknown>): BusinessRow => ({ format: "sortsys-row-v2", schema: businessSchema.fingerprint, table, values });
export async function writeDeliveryNote(client: Client, path: string, input: unknown, signal: AbortSignal, driver?: () => Promise<DuckDriver>) {
  if (!DELIVERY_MUTATIONS.has(path))
    throw new InvalidProtectedData();
  const account = unlockedAccount();
  if (!account)
    throw new InvalidProtectedData();
  const live = () => { signal.throwIfAborted(); if (account !== unlockedAccount())
    throw new InvalidProtectedData(); };
  const creating = path === "deliveryNotes.create", outer = partialAddressRecord(input, creating ? ["requestId", "projectId", "effectiveTimestamp", "comment", "records", "specialRecords"] : ["id", "data", "expectedRevision", "expectedPriceRevision"]);
  const { requestId: submitted, ...createInput } = outer;
  const changes = deliveryChanges(creating ? createInput : outer.data, creating), requestId = creating ? (submitted ?? crypto.randomUUID()) : null;
  if (creating && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)))
    throw new InvalidProtectedData();
  if (!creating)
    addressId(outer.id);
  for (const field of ["expectedRevision", "expectedPriceRevision"] as const)
    if (outer[field] !== undefined && (typeof outer[field] !== "string" || !/^(0|[1-9]\d{0,18})$/.test(outer[field] as string) || field === "expectedRevision" && outer[field] === "0"))
      throw new InvalidProtectedData();
  const located = creating ? null : deliveryAllocation(await required(client.query("zerotrust.deliveryNotes.locate", { id: outer.id as string }, { strategy: "network-only" })));
  live();
  const projectId = creating ? changes.projectId! : located!.projectId;
  // Moving encrypted contents between reader sets needs its own atomic
  // lifecycle operation. Never rewrite the private project field in place.
  if (!creating && changes.projectId !== undefined && changes.projectId !== projectId)
    throw new InvalidProtectedData();
  const context = await deliveryRequestContext(client, signal), open = await protectedCollections(client, signal);
  live();
  const area = deliveryCollection(projectId), quantities = open(area), stores = [quantities], groups: PreparedWrites[] = [], guards: PreparedWrites["head"][] = [];
  const author = context.subject, receiptArea = { ...area, prefix: `delivery-create:${projectId}:${author.slice(5)}:` }, receipts = creating ? open(receiptArea) : null;
  if (receipts)
    stores.push(receipts);
  const requestHash = creating ? await deliveryRequestFingerprint(account.exportKey, account.tenant, author, { requestId, ...changes }) : null;
  live();
  const receiptObject = receiptArea.prefix + requestId;
  async function confirmedReceipt(): Promise<{
    id: string;
  } | null> {
    if (!receipts)
      return null;
    const saved = (await receipts.read(receiptObject)).find(item => item.envelope.object === receiptObject);
    live();
    if (!saved)
      return null;
    const value = receipt(saved.value);
    if (saved.envelope.author !== author || value.author !== author || value.requestId !== requestId || value.requestHash !== requestHash)
      throw new InvalidProtectedData();
    const allocation = deliveryAllocation(await required(client.query("zerotrust.deliveryNotes.locate", { id: value.id }, { strategy: "network-only" })));
    live();
    if (allocation.projectId !== projectId || allocation.number !== value.number)
      throw new InvalidProtectedData();
    return { id: value.id };
  }
  try {
    if (creating) {
      const done = await confirmedReceipt();
      if (done)
        return done;
    }
    if (creating && !quantities.can("create"))
      throw new InvalidProtectedData();
    const allocation = creating ? await allocateDeliveryNote(client, projectId, requestId as string, signal) : located!;
    live();
    const id = allocation.id, object = area.prefix + id, current = (await quantities.read(object)).find(item => item.envelope.object === object);
    live();
    if (creating && current || !creating && !current)
      throw new InvalidProtectedData();
    if (outer.expectedRevision !== undefined && outer.expectedRevision !== current?.envelope.revision)
      throw new ProtectedWriteConflict();
    const previous = current ? deliveryPayload(current.value, object, projectId) : null;
    if (creating) {
      const projectArea = projectCollection(projectId), project = open(projectArea);
      stores.push(project);
      const found = (await project.read()).find(item => item.envelope.object === projectArea.prefix);
      live();
      if (!found || !projectPayload(found.value, found.envelope.object, projectId).project)
        throw new InvalidProtectedData();
      guards.push({ domain: projectArea.domain, sequence: project.snapshot() });
    }
    const oldRecords = new Map(previous?.records.map(r => [publicId(r.values.id), r])), oldSpecials = new Map(previous?.specialRecords.map(r => [publicId(r.values.id), r]));
    if (changes.records?.some(r => r.id && !oldRecords.has(r.id)) || changes.specialRecords?.some(r => r.id && !oldSpecials.has(r.id)))
      throw new InvalidProtectedData();
    let catalog: ReturnType<typeof open> | null = null, catalogHead: string | null = null;
    async function product(id: string) {
      catalog ??= open(PRODUCT_COLLECTION);
      if (!stores.includes(catalog))
        stores.push(catalog);
      const key = PRODUCT_COLLECTION.prefix + id, found = (await catalog.read(key)).find(item => item.envelope.object === key);
      live();
      if (!found)
        throw new InvalidProtectedData();
      const value = productPayload(found.value, key);
      if (catalogHead !== null && catalog.snapshot() !== catalogHead)
        throw new ProtectedWriteConflict();
      catalogHead = catalog.snapshot();
      return value.product.values;
    }
    const rawId = addressId(id), now = new Date().toISOString();
    const records: BusinessRow[] = changes.records === undefined ? previous!.records : [];
    for (const change of changes.records ?? []) {
      const old = change.id ? oldRecords.get(change.id) : undefined, same = old?.values.product_id === addressId(change.productId), unit = change.unit ?? (same ? old?.values.unit as string : null);
      let chosen = unit;
      if (!same || !chosen || chosen !== old?.values.unit) {
        const p = await product(change.productId);
        chosen ??= p.base_unit as string;
        const other = JSON.parse(p.other_units as string) as Record<string, number>;
        if (chosen !== p.base_unit && !Object.hasOwn(other, chosen))
          throw new InvalidProtectedData();
      }
      records.push(row("product_delivery_records", { id: old?.values.id ?? newProductRowId(), note_id: rawId, product_id: addressId(change.productId), quantity: change.quantity, unit: chosen,
        comment: change.comment === undefined ? old?.values.comment ?? null : change.comment }));
    }
    const specialRecords: BusinessRow[] = changes.specialRecords === undefined ? previous!.specialRecords : [];
    const priceChanges = new Map<string, number | null>();
    for (const change of changes.specialRecords ?? []) {
      const old = change.id ? oldSpecials.get(change.id) : undefined, specialId = old?.values.id as string | undefined ?? newProductRowId();
      specialRecords.push(row("product_delivery_special_records", { id: specialId, note_id: rawId, name: change.name, unit: change.unit, amount: change.amount, price_per_unit: null,
        comment: change.comment === undefined ? old?.values.comment ?? null : change.comment }));
      if (change.pricePerUnit !== undefined && (!creating || change.pricePerUnit !== null))
        priceChanges.set(publicId(specialId), change.pricePerUnit);
    }
    const value = deliveryPayload({ format: "sortsys-delivery-note-v1", note: row("product_delivery_notes", previous ? { ...previous.note.values,
        ...(changes.comment !== undefined ? { comment: changes.comment } : {}), ...(changes.effectiveTimestamp !== undefined ? { effective_timestamp: changes.effectiveTimestamp } : {}) }
        : { id: rawId, auto_id: allocation.number, project_id: addressId(projectId), created_by_user_id: addressId(author.slice(5)), comment: changes.comment ?? null, effective_timestamp: changes.effectiveTimestamp ?? now, created_at: now }), records, specialRecords } satisfies DeliveryPayload, object, projectId);
    const check = await createBusinessDatabase(await driver?.());
    try {
      const rows = [value.note, ...value.records, ...value.specialRecords];
      for (let offset = 0; offset < rows.length; offset += 10000)
        await projectFacetRows(check, rows.slice(offset, offset + 10000), new Set(["projects", "users", "products"]));
      live();
    }
    finally {
      await check.close();
    }
    const quantityChanged = creating || JSON.stringify(value) !== JSON.stringify(previous);
    if (quantityChanged && !creating && !quantities.can("update"))
      throw new InvalidProtectedData();
    const quantityPackets: MutateInput<"zerotrust.objects.save">[] = [];
    if (quantityChanged)
      quantityPackets.push(await quantities.packet(object, value, current?.envelope));
    if (creating)
      quantityPackets.push(await receipts!.packet(receiptObject, receipt({ format: "sortsys-delivery-create-v1", author, requestId, requestHash, id, number: allocation.number })));
    if (quantityPackets.length)
      groups.push({ packets: quantityPackets, head: { domain: area.domain, sequence: quantities.snapshot() }, close() { }, async verify() {
          const saved = await quantities.read(object);
          live();
          if (quantityChanged && saved.find(item => item.envelope.object === object)?.envelope.signature !== quantityPackets[0]!.envelope.signature)
            return false;
          return !creating || !!await confirmedReceipt();
        } });
    if (priceChanges.size) {
      const pricesArea = deliveryCollection(projectId, true), prices = open(pricesArea);
      stores.push(prices);
      const priceObject = pricesArea.prefix + id, old = (await prices.read(priceObject)).find(item => item.envelope.object === priceObject);
      live();
      if (outer.expectedPriceRevision !== undefined && outer.expectedPriceRevision !== (old?.envelope.revision ?? "0"))
        throw new ProtectedWriteConflict();
      const previousPrices = old ? deliveryPrices(old.value, priceObject, projectId) : { format: "sortsys-delivery-prices-v1" as const, projectId, noteId: id, prices: [] };
      const map = new Map(previousPrices.prices.map(r => [r.id, r.pricePerUnit]));
      for (const [key, price] of priceChanges)
        map.set(key, price);
      const next = deliveryPrices({ ...previousPrices, prices: [...map].map(([id, pricePerUnit]) => ({ id, pricePerUnit })) } satisfies DeliveryPrices, priceObject, projectId);
      if (JSON.stringify(next) !== JSON.stringify(previousPrices)) {
        const packet = await prices.packet(priceObject, next, old?.envelope);
        live();
        groups.push({ packets: [packet], head: { domain: pricesArea.domain, sequence: prices.snapshot() }, close() { }, async verify() { return (await prices.read(priceObject)).find(item => item.envelope.object === priceObject)?.envelope.signature === packet.envelope.signature; } });
      }
    }
    if (catalog && catalogHead !== null)
      guards.push({ domain: PRODUCT_COLLECTION.domain, sequence: catalogHead });
    if (!groups.length)
      return { success: true as const };
    if (!quantityPackets.length)
      guards.push({ domain: area.domain, sequence: quantities.snapshot() });
    try {
      await commitProtectedWrites(client, groups, signal, guards);
      live();
    }
    catch (error) {
      if (creating) {
        const done = await confirmedReceipt();
        if (done)
          return done;
      }
      throw error;
    }
    return creating ? { id } : { success: true as const };
  }
  finally {
    for (const store of stores)
      store.close();
  }
}
