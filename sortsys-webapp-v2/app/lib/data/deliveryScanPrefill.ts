import type { QueryResult } from "@sortsys/v2-client";
import {
  accountRequestFingerprint,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { uiText } from "../i18n";
import { deliveryChanges } from "./deliveryChanges";
import { assistantId } from "./privateLlm";
import {
  normalizedScanUnit,
  scanProductUnit,
  type Product,
  type ScanResult,
} from "./scanResult";

export type DeliveryNotePrefill = {
  scanId?: string;
  project?: QueryResult<"projects.get"> | null;
  deliveryDate?: Date | null;
  comment?: string | null;
  records: {
    product: Product;
    amount: number;
    unit: string;
    comment?: string | null;
  }[];
  specialRecords: {
    name: string;
    unit: string;
    amount: number;
    pricePerUnit: number | null;
    comment?: string | null;
  }[];
  warnings?: string[];
};

/** Match the archived quantities against one current catalogue. A missing
 * product or changed conversion keeps the original amount and unit editable. */
export function deliveryScanPrefill(
  scan: { id: string; createdAt: Date },
  result: NonNullable<ScanResult["deliveryNote"]>,
  catalogue: readonly Product[],
): DeliveryNotePrefill {
  const products = new Map(catalogue.map((product) => [product.id, product]));
  const records: DeliveryNotePrefill["records"] = [];
  const specialRecords = result.specialRecords.map(
    ({ name, unit, amount, pricePerUnit, comment }) => ({
      name, unit, amount, pricePerUnit, comment,
    }),
  );
  const warnings = [...result.warnings];
  for (const line of result.records) {
    const product = products.get(line.productId);
    const unit = product && scanProductUnit(product, line.unit);
    if (
      product && unit &&
      normalizedScanUnit(product.baseUnit) === normalizedScanUnit(line.baseUnit)
    ) {
      const converted = line.displayQuantity * unit.factor;
      if (Math.abs(converted - line.quantity) <= 1e-9 * line.quantity) {
        records.push({
          product,
          amount: line.displayQuantity,
          unit: unit.unit,
          comment: line.comment,
        });
        continue;
      }
    }
    specialRecords.push({
      name: line.productName,
      unit: line.unit,
      amount: line.displayQuantity,
      pricePerUnit: null,
      comment: line.comment,
    });
  }
  if (records.length !== result.records.length) {
    warnings.push(
      uiText(
        "Positionen mit fehlenden oder geänderten Produktzuordnungen stehen unter Sonderposten. Bitte Menge und Einheit prüfen.",
        "Lines with missing or changed product matches appear as special items. Check their quantities and units.",
      ),
    );
  }

  const comment = [
    result.supplier &&
      uiText(`Lieferant: ${result.supplier}`, `Supplier: ${result.supplier}`),
    result.deliveryNumber && uiText(
      `Lieferscheinnummer: ${result.deliveryNumber}`,
      `Delivery note number: ${result.deliveryNumber}`,
    ),
    result.comment,
  ].filter(Boolean).join(" · ");
  const deliveryDate = result.deliveryDate
    ? new Date(`${result.deliveryDate}T12:00:00`)
    : new Date(scan.createdAt);
  deliveryDate.setHours(12, 0, 0, 0);
  return { scanId: scan.id, deliveryDate, comment, records, specialRecords, warnings };
}

/** A reopened form can reproduce the same encrypted write receipt without
 * sending its personal scan identifier or a public hash of business data. */
export async function scannedDeliveryRequestId(
  scanId: string,
  input: unknown,
): Promise<string> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const requestId = await accountRequestFingerprint(
    account.dataKey,
    "sortsys/delivery-scan-request/v1",
    account.tenant,
    account.vault.subject,
    [assistantId(scanId), deliveryChanges(input, true)],
  );
  if (account !== unlockedAccount()) throw new InvalidProtectedData();
  return requestId;
}
