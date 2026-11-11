import { InvalidProtectedData } from "@sortsys/zerotrust";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
export type DeliveryRecordChange = {
  id?: string;
  productId: string;
  quantity: number;
  unit: string | null;
  comment?: string | null;
};
export type DeliverySpecialChange = {
  id?: string;
  name: string;
  unit: string;
  amount: number;
  pricePerUnit?: number | null;
  comment?: string | null;
};
export type DeliveryChanges = {
  projectId?: string;
  effectiveTimestamp?: string | null;
  comment?: string | null;
  records?: DeliveryRecordChange[];
  specialRecords?: DeliverySpecialChange[];
};
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InvalidProtectedData();
  return value;
}
function lines(value: unknown): unknown[] {
  if (value == null)
    return [];
  if (!Array.isArray(value) || value.length > 10000)
    throw new InvalidProtectedData();
  return value;
}
export function deliveryChanges(input: unknown, creating: boolean): DeliveryChanges {
  const data = partialAddressRecord(input, ["projectId", "effectiveTimestamp", "comment", "records", "specialRecords"]), out: DeliveryChanges = {};
  if (creating || data.projectId !== undefined) {
    addressId(data.projectId);
    out.projectId = data.projectId as string;
  }
  if (creating || data.effectiveTimestamp !== undefined) {
    if (data.effectiveTimestamp == null) {
      if (!creating)
        throw new InvalidProtectedData();
      out.effectiveTimestamp = null;
    }
    else {
      if (!(data.effectiveTimestamp instanceof Date) || !Number.isFinite(data.effectiveTimestamp.getTime()))
        throw new InvalidProtectedData();
      out.effectiveTimestamp = data.effectiveTimestamp.toISOString();
    }
  }
  if (creating || data.comment !== undefined)
    out.comment = addressText(data.comment, false, 511);
  if (creating || data.records !== undefined) {
    const seen = new Set<string>();
    out.records = lines(data.records).map(input => {
      const row = partialAddressRecord(input, [...(!creating ? ["id"] : []), "productId", "quantity", "unit", "comment"]);
      addressId(row.productId);
      const id = row.id == null ? undefined : row.id as string;
      if (id !== undefined) {
        addressId(id);
        if (seen.has(id))
          throw new InvalidProtectedData();
        seen.add(id);
      }
      return { id, productId: row.productId as string, quantity: number(row.quantity), unit: addressText(row.unit, false, 32),
        ...(row.comment !== undefined ? { comment: addressText(row.comment, false, 255) } : {}) };
    });
  }
  if (creating || data.specialRecords !== undefined) {
    const seen = new Set<string>();
    out.specialRecords = lines(data.specialRecords).map(input => {
      const row = partialAddressRecord(input, [...(!creating ? ["id"] : []), "name", "unit", "amount", "pricePerUnit", "comment"]);
      const id = row.id == null ? undefined : row.id as string;
      if (id !== undefined) {
        addressId(id);
        if (seen.has(id))
          throw new InvalidProtectedData();
        seen.add(id);
      }
      return { id, name: addressText(row.name, true, 255)!, unit: addressText(row.unit, true, 32)!, amount: number(row.amount),
        ...(row.pricePerUnit !== undefined ? { pricePerUnit: row.pricePerUnit === null ? null : number(row.pricePerUnit) } : {}),
        ...(row.comment !== undefined ? { comment: addressText(row.comment, false, 255) } : {}) };
    });
  }
  if (creating && !out.records!.length && !out.specialRecords!.length || !creating && !Object.keys(out).length)
    throw new InvalidProtectedData();
  return out;
}
