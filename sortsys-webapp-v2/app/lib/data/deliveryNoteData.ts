import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { addressId } from "./addressBook";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import type { Collection } from "./protectedObjects";
import { defineDataModel } from "./runtime/model";

export const DELIVERY_QUERIES = new Set(["deliveryNotes.list", "deliveryNotes.get", "deliveryNotes.costs.get"]);
export const DELIVERY_MUTATIONS = new Set(["deliveryNotes.create", "deliveryNotes.update"]);
export type DeliveryNote = QueryResult<"deliveryNotes.get">;
export type DeliveryPayload = { format: "sortsys-delivery-note-v1"; note: BusinessRow; records: BusinessRow[]; specialRecords: BusinessRow[] };
export type DeliveryPrices = { format: "sortsys-delivery-prices-v1"; projectId: string; noteId: string; prices: { id: string; pricePerUnit: number | null }[] };
export const DELIVERY_MODEL = defineDataModel({ name: "delivery-notes", decode(value: unknown, object: string, area: Collection) {
  return deliveryPayload(value, object, deliveryDomain(area.domain)!.projectId);
}, exclude: { product_delivery_special_records: ["price_per_unit"] }, externalReferences: ["projects", "users", "products"] });
export const DELIVERY_PRICE_MODEL = defineDataModel({ name: "delivery-prices", decode(value: unknown, object: string, area: Collection) {
  return deliveryPrices(value, object, deliveryDomain(area.domain)!.projectId);
}, sources: value => value.prices.map((price, index) => ({ table: "product_delivery_special_records", kind: "fragment" as const,
  values: { id: addressId(price.id), price_per_unit: price.pricePerUnit }, fields: { price_per_unit: { path: ["prices", index, "pricePerUnit"] } } })) });

export function deliveryCollection(projectId: string, prices = false): Collection {
  addressId(projectId);
  return { domain: `project:${projectId}:${prices ? "procurement" : "contract-quantities"}`, scope: `project:${projectId}`,
    facet: prices ? "procurement" : "contract-quantities", prefix: `${prices ? "delivery-price" : "delivery-note"}:${projectId}:` };
}
export function deliveryDomain(domain: string): { projectId: string; prices: boolean } | null {
  const match = /^project:([1-9a-v][0-9a-v]{0,12}):(contract-quantities|procurement)$/.exec(domain);
  if (!match) return null;
  addressId(match[1]); return { projectId: match[1]!, prices: match[2] === "procurement" };
}
function rows(input: unknown, table: string, noteId: unknown): BusinessRow[] {
  if (!Array.isArray(input) || input.length > 10000) throw new InvalidProtectedData();
  const seen = new Set<string>();
  return input.map(item => {
    const row = decodeBusinessRow(item), id = publicId(row.values.id); addressId(id);
    if (row.table !== table || row.values.note_id !== noteId || seen.has(id)) throw new InvalidProtectedData();
    seen.add(id);
    if (table === "product_delivery_records") addressId(publicId(row.values.product_id));
    else if (row.values.price_per_unit !== null) throw new InvalidProtectedData(); // Prices never enter the quantity key.
    return row;
  });
}
export function deliveryPayload(input: unknown, object: string, projectId: string): DeliveryPayload {
  const data = record(input, ["format", "note", "records", "specialRecords"]), note = decodeBusinessRow(data.note);
  const area = deliveryCollection(projectId), id = publicId(note.values.id); addressId(id);
  if (data.format !== "sortsys-delivery-note-v1" || note.table !== "product_delivery_notes" || object !== area.prefix + id
    || publicId(note.values.project_id) !== projectId || !/^[1-9]\d*$/.test(note.values.auto_id as string)) throw new InvalidProtectedData();
  if (note.values.created_by_user_id !== null) addressId(publicId(note.values.created_by_user_id));
  return { format: data.format, note, records: rows(data.records, "product_delivery_records", note.values.id),
    specialRecords: rows(data.specialRecords, "product_delivery_special_records", note.values.id) };
}
export function deliveryPrices(input: unknown, object: string, projectId: string): DeliveryPrices {
  const data = record(input, ["format", "projectId", "noteId", "prices"]), area = deliveryCollection(projectId, true);
  addressId(data.noteId);
  if (data.format !== "sortsys-delivery-prices-v1" || data.projectId !== projectId || object !== area.prefix + data.noteId
    || !Array.isArray(data.prices) || data.prices.length > 10000) throw new InvalidProtectedData();
  const seen = new Set<string>();
  const prices = data.prices.map(input => {
    const price = record(input, ["id", "pricePerUnit"]); addressId(price.id);
    if (seen.has(price.id as string) || price.pricePerUnit !== null && (typeof price.pricePerUnit !== "number" || !Number.isFinite(price.pricePerUnit))) throw new InvalidProtectedData();
    seen.add(price.id as string); return { id: price.id as string, pricePerUnit: price.pricePerUnit as number | null };
  });
  return { format: data.format, projectId, noteId: data.noteId as string, prices };
}
export function wireDelivery(payload: DeliveryPayload, prices?: DeliveryPrices): DeliveryNote {
  const p = payload.note.values, id = publicId(p.id), autoId = Number(p.auto_id);
  if (!Number.isSafeInteger(autoId) || prices && (prices.noteId !== id || prices.projectId !== publicId(p.project_id))) throw new InvalidProtectedData();
  const specialPrices = new Map(prices?.prices.map(row => [row.id, row.pricePerUnit]));
  return { id, autoId, projectId: publicId(p.project_id), comment: p.comment as string | null,
    createdByUserId: p.created_by_user_id === null ? null : publicId(p.created_by_user_id), createdAt: new Date(p.created_at as string), effectiveTimestamp: new Date(p.effective_timestamp as string),
    records: payload.records.map(({ values: r }) => ({ id: publicId(r.id), noteId: id, productId: publicId(r.product_id), quantity: r.quantity as number, unit: r.unit as string, comment: r.comment as string | null })),
    specialRecords: payload.specialRecords.map(({ values: r }) => ({ id: publicId(r.id), noteId: id, name: r.name as string, unit: r.unit as string,
      amount: r.amount as number, pricePerUnit: specialPrices.get(publicId(r.id)) ?? null, comment: r.comment as string | null })) };
}

/** Compare the stored timestamp before projecting it to JavaScript Date. Price
 * selection must retain PostgreSQL's microseconds, including offset timestamps. */
export function timestampMicros(value: string): bigint {
  const match = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new InvalidProtectedData();
  return BigInt(millis) * 1000n + BigInt(match?.[1]!.padEnd(6, "0").slice(3) || "0");
}
export function deliveryCosts(payload: DeliveryPayload, special: DeliveryPrices, prices: BusinessRow[]): QueryResult<"deliveryNotes.costs.get"> {
  const note = wireDelivery(payload, special), effective = timestampMicros(payload.note.values.effective_timestamp as string);
  const byProduct = new Map<string, BusinessRow[]>();
  for (const row of prices) {
    const price = decodeBusinessRow(row);
    if (price.table !== "product_price_records") throw new InvalidProtectedData();
    const id = publicId(price.values.product_id), list = byProduct.get(id) ?? []; list.push(price); byProduct.set(id, list);
  }
  const chosen = new Map<string, BusinessRow>();
  for (const [product, list] of byProduct) {
    list.sort((a, b) => {
      const at = timestampMicros(a.values.timestamp as string), bt = timestampMicros(b.values.timestamp as string);
      if (at !== bt) return at < bt ? -1 : 1;
      return BigInt(a.values.id as string) < BigInt(b.values.id as string) ? -1 : 1;
    });
    const old = list.filter(row => timestampMicros(row.values.timestamp as string) <= effective), selected = old.at(-1) ?? list[0];
    if (selected) chosen.set(product, selected);
  }
  let totalCost = 0;
  const records = note.records.map(line => {
    const p = chosen.get(line.productId)?.values;
    const priceRecord = p ? { id: publicId(p.id), productId: publicId(p.product_id), vendorId: p.vendor_id === null ? null : publicId(p.vendor_id),
      timestamp: new Date(p.timestamp as string), price: p.price as number, isRealPurchase: p.is_real_purchase as boolean, comment: p.comment as string | null } : null;
    totalCost += line.quantity * (priceRecord?.price ?? 0);
    return { recordId: line.id, productId: line.productId, quantity: line.quantity, priceRecord };
  });
  const specialRecords = note.specialRecords.map(line => {
    const cost = line.amount * (line.pricePerUnit ?? 0); totalCost += cost;
    return { recordId: line.id, name: line.name, unit: line.unit, amount: line.amount, pricePerUnit: line.pricePerUnit, comment: line.comment, totalCost: cost };
  });
  if (!Number.isFinite(totalCost) || specialRecords.some(row => !Number.isFinite(row.totalCost))) throw new InvalidProtectedData();
  return { noteId: note.id, totalCost, records, specialRecords };
}
