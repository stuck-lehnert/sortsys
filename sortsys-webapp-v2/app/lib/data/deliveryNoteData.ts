import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { publicId, wirePrice } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import type { Collection } from "./protectedObjects";
import { defineDataModel } from "./runtime/model";
import type { HistoricalPriceLookup } from "./historicalPrices";
import { timestampMicros } from "./timestamps";
import {
  projectModuleArea,
  projectModuleDecoder,
  projectModuleDomain,
} from "./projectScope";
import { aggregateRows } from "./aggregateRows";
import { deliveryPlacement } from "./deliveryIdentity";

export const DELIVERY_QUERIES = new Set([
  "deliveryNotes.list",
  "deliveryNotes.get",
  "deliveryNotes.costs.get",
]);
export const DELIVERY_MUTATIONS = new Set([
  "deliveryNotes.create",
  "deliveryNotes.update",
  "deliveryNotes.delete",
]);
export type DeliveryNote = QueryResult<"deliveryNotes.get">;
export type DeliveryPayload = {
  format: "sortsys-delivery-note-v1";
  note: BusinessRow;
  records: BusinessRow[];
  specialRecords: BusinessRow[];
};
export type DeliveryPrices = {
  format: "sortsys-delivery-prices-v1";
  projectId: string;
  noteId: string;
  prices: { id: string; pricePerUnit: number | null }[];
};
export const DELIVERY_MODEL = defineDataModel<DeliveryPayload>({
  name: "delivery-notes",
  decode: projectModuleDecoder(deliveryCollection, deliveryPayload),
  exclude: { product_delivery_special_records: ["price_per_unit"] },
  externalReferences: ["projects", "users", "products"],
});
export const DELIVERY_PRICE_MODEL = defineDataModel<DeliveryPrices>({
  name: "delivery-prices",
  decode: projectModuleDecoder(
    (id) => deliveryCollection(id, true),
    deliveryPrices,
  ),
  sources: (value) =>
    value.prices.map((price, index) => ({
      table: "product_delivery_special_records",
      kind: "fragment" as const,
      values: { id: addressId(price.id), price_per_unit: price.pricePerUnit },
      fields: { price_per_unit: { path: ["prices", index, "pricePerUnit"] } },
    })),
});

export function deliveryCollection(
  projectId: string,
  prices = false,
): Collection {
  return {
    ...projectModuleArea(
      projectId,
      "delivery-notes",
      prices ? "procurement" : "master-data",
    ),
    prefix: `${prices ? "delivery-price" : "delivery-note"}:${projectId}:`,
  };
}
export function deliveryDomain(
  domain: string,
): { projectId: string; prices: boolean } | null {
  const part = projectModuleDomain(domain);
  return part?.module === "delivery-notes" &&
    ["master-data", "procurement"].includes(part.facet)
    ? { projectId: part.id, prices: part.facet === "procurement" }
    : null;
}
function rows(input: unknown, table: string, noteId: unknown): BusinessRow[] {
  return aggregateRows(input, table, "note_id", noteId).map((row) => {
    if (table === "product_delivery_records")
      addressId(publicId(row.values.product_id));
    else if (row.values.price_per_unit !== null)
      throw new InvalidProtectedData();
    return row;
  });
}
export function deliveryPayload(
  input: unknown,
  object: string,
  projectId: string,
): DeliveryPayload {
  const data = record(input, ["format", "note", "records", "specialRecords"]),
    note = decodeBusinessRow(data.note);
  const id = publicId(note.values.id);
  addressId(id);
  deliveryPlacement(object, { projectId, id });
  if (
    data.format !== "sortsys-delivery-note-v1" ||
    note.table !== "product_delivery_notes" ||
    publicId(note.values.project_id) !== projectId ||
    !/^[1-9]\d*$/.test(note.values.auto_id as string)
  )
    throw new InvalidProtectedData();
  if (note.values.created_by_user_id !== null)
    addressId(publicId(note.values.created_by_user_id));
  return {
    format: data.format,
    note,
    records: rows(data.records, "product_delivery_records", note.values.id),
    specialRecords: rows(
      data.specialRecords,
      "product_delivery_special_records",
      note.values.id,
    ),
  };
}
export function deliveryPrices(
  input: unknown,
  object: string,
  projectId: string,
): DeliveryPrices {
  const data = record(input, ["format", "projectId", "noteId", "prices"]);
  addressId(data.noteId);
  deliveryPlacement(object, { projectId, id: data.noteId as string }, true);
  if (
    data.format !== "sortsys-delivery-prices-v1" ||
    data.projectId !== projectId ||
    !Array.isArray(data.prices) ||
    data.prices.length > 10000
  )
    throw new InvalidProtectedData();
  const seen = new Set<string>();
  const prices = data.prices.map((input) => {
    const price = record(input, ["id", "pricePerUnit"]);
    addressId(price.id);
    if (
      seen.has(price.id as string) ||
      (price.pricePerUnit !== null &&
        (typeof price.pricePerUnit !== "number" ||
          !Number.isFinite(price.pricePerUnit)))
    )
      throw new InvalidProtectedData();
    seen.add(price.id as string);
    return {
      id: price.id as string,
      pricePerUnit: price.pricePerUnit as number | null,
    };
  });
  return {
    format: data.format,
    projectId,
    noteId: data.noteId as string,
    prices,
  };
}
export function wireDelivery(
  payload: DeliveryPayload,
  prices?: DeliveryPrices,
): DeliveryNote {
  const p = payload.note.values,
    id = publicId(p.id),
    autoId = Number(p.auto_id);
  if (
    !Number.isSafeInteger(autoId) ||
    (prices &&
      (prices.noteId !== id || prices.projectId !== publicId(p.project_id)))
  )
    throw new InvalidProtectedData();
  const specialPrices = new Map(
    prices?.prices.map((row) => [row.id, row.pricePerUnit]),
  );
  return {
    id,
    autoId,
    projectId: publicId(p.project_id),
    comment: p.comment as string | null,
    createdByUserId:
      p.created_by_user_id === null ? null : publicId(p.created_by_user_id),
    createdAt: new Date(p.created_at as string),
    effectiveTimestamp: new Date(p.effective_timestamp as string),
    records: payload.records.map(({ values: r }) => ({
      id: publicId(r.id),
      noteId: id,
      productId: publicId(r.product_id),
      quantity: r.quantity as number,
      unit: r.unit as string,
      comment: r.comment as string | null,
    })),
    specialRecords: payload.specialRecords.map(({ values: r }) => ({
      id: publicId(r.id),
      noteId: id,
      name: r.name as string,
      unit: r.unit as string,
      amount: r.amount as number,
      pricePerUnit: specialPrices.get(publicId(r.id)) ?? null,
      comment: r.comment as string | null,
    })),
  };
}

export function calculateDeliveryCosts(
  payload: DeliveryPayload,
  special: DeliveryPrices | undefined,
  priceAt?: HistoricalPriceLookup,
) {
  const note = wireDelivery(payload, special);
  const effective = timestampMicros(
    payload.note.values.effective_timestamp as string,
  );
  if (note.records.length && !priceAt) throw new InvalidProtectedData();

  let totalCost = 0;
  const records = note.records.map((line) => {
    const price = priceAt?.(line.productId, effective, "earliest");
    const priceRecord = price ? wirePrice(price) : null;
    const lineCost = line.quantity * (priceRecord?.price ?? 0);
    totalCost += lineCost;
    return {
      recordId: line.id,
      productId: line.productId,
      quantity: line.quantity,
      priceRecord,
      priceInstant: price
        ? timestampMicros(price.values.timestamp as string)
        : null,
      totalCost: lineCost,
    };
  });
  const specialRecords = note.specialRecords.map((line) => {
    const lineCost = line.amount * (line.pricePerUnit ?? 0);
    totalCost += lineCost;
    return {
      recordId: line.id,
      name: line.name,
      unit: line.unit,
      amount: line.amount,
      pricePerUnit: line.pricePerUnit,
      comment: line.comment,
      totalCost: lineCost,
    };
  });
  if (!Number.isFinite(totalCost)) throw new InvalidProtectedData();
  return {
    noteId: note.id,
    autoId: note.autoId,
    effectiveTimestamp: note.effectiveTimestamp,
    effective,
    totalCost,
    records,
    specialRecords,
  };
}

export function wireDeliveryCosts(
  costs: ReturnType<typeof calculateDeliveryCosts>,
): QueryResult<"deliveryNotes.costs.get"> {
  return {
    noteId: costs.noteId,
    totalCost: costs.totalCost,
    records: costs.records.map(
      ({ recordId, productId, quantity, priceRecord }) => ({
        recordId,
        productId,
        quantity,
        priceRecord,
      }),
    ),
    specialRecords: costs.specialRecords,
  };
}
