import type { MutateResult, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { uiText } from "../i18n";
import { assistantId } from "./privateLlm";

export type ScanResult = MutateResult<"deliveryNotes.scan.complete">;
export type Product = QueryResult<"products.get">;
type Line = { sourceText: string; name: string; brand: string | null; description: string | null; quantity: number;
  unit: string; baseUnit: string | null; unitConversions: { unit: string; quantity: number; inUnit: string }[];
  productId: string | null; pricePerUnit: number | null; confidence: number; comment: string | null };
export type RawScan = { documentType: "deliveryNote" | "priceList" | "invoice"; supplier: string | null;
  documentNumber: string | null; documentDate: string | null; comment: string | null; lines: Line[] };

function text(value: unknown, maximum = 16384): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new InvalidProtectedData();
  return value.trim();
}
function optional(value: unknown, maximum?: number): string | null {
  return value == null ? null : text(value, maximum) || null;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidProtectedData();
  return value;
}
export function parseRawScan(content: string): RawScan {
  const input = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  const data = record(input, ["documentType", "supplier", "documentNumber", "documentDate", "comment", "lines"]);
  if (!["deliveryNote", "priceList", "invoice"].includes(String(data.documentType)) || !Array.isArray(data.lines) || !data.lines.length || data.lines.length > 10000) throw new InvalidProtectedData();
  return {
    documentType: data.documentType as RawScan["documentType"], supplier: optional(data.supplier), documentNumber: optional(data.documentNumber),
    documentDate: optional(data.documentDate, 64), comment: optional(data.comment),
    lines: data.lines.map(input => {
      const line = record(input, ["sourceText", "name", "brand", "description", "quantity", "unit", "baseUnit", "unitConversions", "productId", "pricePerUnit", "confidence", "comment"]);
      if (!Array.isArray(line.unitConversions) || line.unitConversions.length > 64) throw new InvalidProtectedData();
      const name = text(line.name), unit = text(line.unit, 32), quantity = number(line.quantity);
      if (!name || !unit || quantity <= 0) throw new InvalidProtectedData();
      const price = line.pricePerUnit == null ? null : number(line.pricePerUnit);
      return { sourceText: text(line.sourceText), name, brand: optional(line.brand), description: optional(line.description, 65536),
        quantity, unit, baseUnit: optional(line.baseUnit, 32), productId: line.productId == null ? null : assistantId(line.productId),
        pricePerUnit: price !== null && price >= 0 ? price : null, confidence: Math.max(0, Math.min(1, number(line.confidence))), comment: optional(line.comment),
        unitConversions: line.unitConversions.map(input => {
          const value = record(input, ["unit", "quantity", "inUnit"]);
          const unit = text(value.unit, 32), inUnit = text(value.inUnit, 32), quantity = number(value.quantity);
          if (!unit || !inUnit || quantity <= 0 || [unit, inUnit].some(s => ["__proto__", "constructor", "prototype"].includes(s))) throw new InvalidProtectedData();
          return { unit, quantity, inUnit };
        }),
      };
    }),
  };
}

function normalized(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
export function normalizedScanUnit(value: string): string {
  const unit = normalized(value);
  if (["pal", "palette", "paletten"].includes(unit)) return "palette";
  if (["stk", "stück", "stueck"].includes(unit)) return "stück";
  if (["saecke", "säcke", "sack"].includes(unit)) return "sack";
  return unit;
}
const packages = new Set(["sack", "palette", "packung", "karton", "gebinde", "eimer", "kanister", "beutel", "fass", "bigbag", "rolle"]);
function factor(product: Product, unit: string): { unit: string; factor: number } | null {
  if (normalizedScanUnit(product.baseUnit) === normalizedScanUnit(unit)) return { unit: product.baseUnit, factor: 1 };
  const found = Object.entries(product.otherUnits).find(([key]) => normalizedScanUnit(key) === normalizedScanUnit(unit));
  return found && Number.isFinite(found[1]) && found[1] > 0 ? { unit: found[0], factor: found[1] } : null;
}
export function proposedScanUnits(line: Line): { baseUnit: string; otherUnits: Record<string, number>; factor: number } | null {
  let baseUnit = line.baseUnit || line.unit;
  const seen = new Set<string>();
  while (packages.has(normalizedScanUnit(baseUnit))) {
    const key = normalizedScanUnit(baseUnit);
    if (seen.has(key)) return null;
    seen.add(key);
    const conversion = line.unitConversions.find(value => normalizedScanUnit(value.unit) === key);
    if (!conversion) break;
    baseUnit = conversion.inUnit;
  }
  if (new TextEncoder().encode(baseUnit).length > 8) return null;
  const names = new Set(line.unitConversions.map(value => normalizedScanUnit(value.unit)));
  if (names.size !== line.unitConversions.length) return null;
  const factors = new Map([[normalizedScanUnit(baseUnit), 1]]), otherUnits: Record<string, number> = Object.create(null);
  for (let pass = 0; pass < line.unitConversions.length; pass++) {
    let changed = false;
    for (const conversion of line.unitConversions) {
      const parent = factors.get(normalizedScanUnit(conversion.inUnit));
      if (parent === undefined) continue;
      const quantity = conversion.quantity * parent, key = normalizedScanUnit(conversion.unit), previous = factors.get(key);
      if (!Number.isFinite(quantity) || quantity <= 0 || previous !== undefined && Math.abs(previous - quantity) > 1e-9 * Math.max(previous, quantity)) return null;
      if (previous === undefined) { factors.set(key, quantity); changed = true; }
      otherUnits[conversion.unit] = quantity;
    }
    if (!changed) break;
  }
  const source = factors.get(normalizedScanUnit(line.unit));
  if (Object.keys(otherUnits).length !== line.unitConversions.length || source === undefined) return null;
  return { baseUnit, otherUnits, factor: source };
}
function discountedPrice(line: Line): number | null {
  if (line.pricePerUnit === null) return null;
  const columns = line.sourceText.split("|").map(s => s.trim()).reverse();
  const parse = (value: string) => { const source = value.replace(/%$/, "").replace(",", ".").trim(); return source ? Number(source) : NaN; };
  if (columns.length >= 5 && normalizedScanUnit(columns[2]) === normalizedScanUnit(line.unit)) {
    const discounted = parse(columns[0]), percentage = parse(columns[1]), original = parse(columns[3]);
    if (Number.isFinite(discounted) && discounted >= 0 && original > 0 && percentage > 0 && percentage < 100
      && Math.abs(discounted - original * (1 - percentage / 100)) <= .01
      && (Math.abs(line.pricePerUnit - original) <= .01 || Math.abs(line.pricePerUnit - discounted) <= .01)) return Math.round(discounted * 10000) / 10000;
  }
  return line.pricePerUnit;
}
function proposedName(line: Line, catalogue: Product[]): { name: string; brand: string | null } {
  const word = (text: string) => text.trim().replace(/^\d+\s+/, "").match(/[\p{L}\p{N}]+/u)?.[0] ?? "";
  const starts = (source: string, brand: string) => normalized(word(source)) === normalized(brand);
  const brand = line.brand || catalogue.find(p => p.brand && normalized(p.brand) === normalized(word(line.sourceText)))?.brand || null;
  if (!brand) return { name: line.name, brand: null };
  const peers = catalogue.filter(product => product.brand && normalized(product.brand) === normalized(brand));
  const spelling = peers[0]?.brand ?? brand;
  const prefixed = peers.filter(product => starts(product.name, spelling)).length;
  const prefersPrefix = peers.length === 0 || prefixed > peers.length - prefixed;
  return { name: prefersPrefix && starts(line.sourceText, spelling) && !starts(line.name, spelling) ? `${spelling} ${line.name}` : line.name, brand: spelling };
}

/** Complete local catalogue matching is intentional. No server search results
 * are re-filtered, and neither prices nor price-domain keys are requested. */
export function normalizeScanResult(raw: RawScan, catalogue: Product[]): ScanResult {
  const warnings: string[] = [];
  let date = raw.documentDate;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
    warnings.push(uiText("Das erkannte Datum konnte nicht übernommen werden.", "The recognized date could not be used.")); date = null;
  }
  const products = new Map(catalogue.map(product => [product.id, product]));
  const delivery: NonNullable<ScanResult["deliveryNote"]> = { supplier: raw.supplier, deliveryNumber: raw.documentNumber, deliveryDate: date, comment: raw.comment, records: [], specialRecords: [], warnings };
  const priceList: NonNullable<ScanResult["priceList"]> = { supplier: raw.supplier, documentNumber: raw.documentNumber, effectiveDate: date, rows: [], warnings };
  for (const line of raw.lines) {
    let product = line.productId ? products.get(line.productId) : undefined;
    if (!line.productId && raw.documentType !== "deliveryNote") {
      const source = normalized(line.sourceText);
      const candidates = catalogue.filter(product => normalized(product.name).length >= 6 && source.includes(normalized(product.name))
        && (!product.brand || source.includes(normalized(product.brand))) && factor(product, line.unit));
      if (candidates.length === 1) product = candidates[0];
    }
    const converted = product ? factor(product, line.unit) : null;
    if (raw.documentType === "deliveryNote") {
      if (product && converted) {
        const quantity = line.quantity * converted.factor;
        if (!Number.isFinite(quantity)) throw new InvalidProtectedData();
        delivery.records.push({ sourceText: line.sourceText, productId: product.id, customId: product.customId, productName: product.name,
          quantity, displayQuantity: line.quantity, unit: converted.unit, baseUnit: product.baseUnit, confidence: line.confidence, comment: line.comment });
      } else {
        if (line.productId) warnings.push(uiText("Eine vorgeschlagene Produktzuordnung konnte nicht übernommen werden; die Zeile bleibt als Sonderposten erhalten.", "A proposed product match could not be used; the line is retained as a special item."));
        delivery.specialRecords.push({ sourceText: line.sourceText, name: line.name, unit: line.unit, amount: line.quantity, pricePerUnit: line.pricePerUnit, confidence: line.confidence, comment: line.comment });
      }
    } else {
      const price = discountedPrice(line);
      if (price === null) { warnings.push(uiText("Eine Zeile ohne verwendbaren Nettopreis wurde übersprungen.", "A line without a usable net price was skipped.")); continue; }
      const units = product && converted ? { baseUnit: product.baseUnit, otherUnits: product.otherUnits, factor: converted.factor } : proposedScanUnits(line);
      if (!units && line.baseUnit && normalizedScanUnit(line.baseUnit) !== normalizedScanUnit(line.unit)) warnings.push(uiText("Eine Einheitenumrechnung konnte nicht geprüft werden; die Ausgangseinheit wurde beibehalten.", "A unit conversion could not be verified; the source unit was retained."));
      const name = proposedName(line, catalogue);
      const pricePerBaseUnit = price / (units?.factor ?? 1);
      if (!Number.isFinite(pricePerBaseUnit)) throw new InvalidProtectedData();
      priceList.rows.push({ sourceText: line.sourceText, productId: product && converted ? product.id : null,
        customId: product && converted ? product.customId : null, productName: product && converted ? product.name : name.name,
        brand: product && converted ? product.brand : name.brand, description: product && converted ? null : line.description,
        baseUnit: units?.baseUnit ?? line.unit, otherUnits: units?.otherUnits ?? {}, sourceUnit: converted?.unit ?? line.unit,
        pricePerBaseUnit, confidence: line.confidence, comment: line.comment });
    }
  }
  if (raw.documentType !== "deliveryNote" && !priceList.rows.length) throw new InvalidProtectedData();
  return { documentType: raw.documentType, deliveryNote: raw.documentType === "deliveryNote" ? delivery : null, priceList: raw.documentType === "deliveryNote" ? null : priceList };
}

/** Treat authenticated ciphertext from another client as untrusted business
 * data too. A valid signature never replaces the local document schema. */
export function validateScanResult(input: unknown): ScanResult {
  const value = record(input, ["documentType", "deliveryNote", "priceList"]);
  const strings = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.length > 10000) throw new InvalidProtectedData();
    return input.map(value => text(value));
  };
  const requiredText = (input: unknown, max?: number) => { const value = text(input, max); if (!value) throw new InvalidProtectedData(); return value; };
  const rows = (input: unknown): unknown[] => {
    if (!Array.isArray(input) || input.length > 10000) throw new InvalidProtectedData();
    return input;
  };
  const positive = (input: unknown) => { const value = number(input); if (value <= 0) throw new InvalidProtectedData(); return value; };
  const price = (input: unknown) => { const value = number(input); if (value < 0) throw new InvalidProtectedData(); return value; };
  const confidence = (input: unknown) => { const value = number(input); if (value < 0 || value > 1) throw new InvalidProtectedData(); return value; };
  const customId = (input: unknown) => { const value = price(input); if (!Number.isInteger(value) || value > 2147483647) throw new InvalidProtectedData(); return value; };
  const date = (input: unknown) => {
    const value = optional(input, 10);
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new InvalidProtectedData();
    return value;
  };
  if (value.documentType === "deliveryNote" && value.priceList === null) {
    const data = record(value.deliveryNote, ["supplier", "deliveryNumber", "deliveryDate", "comment", "records", "specialRecords", "warnings"]);
    const records = rows(data.records).map(input => {
      const row = record(input, ["sourceText", "productId", "customId", "productName", "quantity", "displayQuantity", "unit", "baseUnit", "confidence", "comment"]);
      return { sourceText: text(row.sourceText), productId: assistantId(row.productId), customId: customId(row.customId), productName: requiredText(row.productName),
        quantity: positive(row.quantity), displayQuantity: positive(row.displayQuantity), unit: requiredText(row.unit, 32), baseUnit: requiredText(row.baseUnit, 32), confidence: confidence(row.confidence), comment: optional(row.comment) };
    });
    const specialRecords = rows(data.specialRecords).map(input => {
      const row = record(input, ["sourceText", "name", "unit", "amount", "pricePerUnit", "confidence", "comment"]);
      return { sourceText: text(row.sourceText), name: requiredText(row.name), unit: requiredText(row.unit, 32), amount: positive(row.amount),
        pricePerUnit: row.pricePerUnit === null ? null : price(row.pricePerUnit), confidence: confidence(row.confidence), comment: optional(row.comment) };
    });
    if (!records.length && !specialRecords.length) throw new InvalidProtectedData();
    return { documentType: "deliveryNote", priceList: null, deliveryNote: { supplier: optional(data.supplier), deliveryNumber: optional(data.deliveryNumber),
      deliveryDate: date(data.deliveryDate), comment: optional(data.comment), records, specialRecords, warnings: strings(data.warnings) } };
  }
  if (["priceList", "invoice"].includes(String(value.documentType)) && value.deliveryNote === null) {
    const data = record(value.priceList, ["supplier", "documentNumber", "effectiveDate", "rows", "warnings"]);
    const lines = rows(data.rows).map(input => {
      const row = record(input, ["sourceText", "productId", "customId", "productName", "brand", "description", "otherUnits", "baseUnit", "sourceUnit", "pricePerBaseUnit", "confidence", "comment"]);
      if (!row.otherUnits || typeof row.otherUnits !== "object" || Array.isArray(row.otherUnits)) throw new InvalidProtectedData();
      const units = record(row.otherUnits, Object.keys(row.otherUnits));
      const otherUnits: Record<string, number> = Object.create(null);
      if (Object.keys(units).length > 64) throw new InvalidProtectedData();
      for (const [unit, quantity] of Object.entries(units)) {
        if (!text(unit, 32) || ["__proto__", "constructor", "prototype"].includes(unit)) throw new InvalidProtectedData();
        otherUnits[unit] = positive(quantity);
      }
      const productId = row.productId === null ? null : assistantId(row.productId);
      if (productId === null && row.customId !== null || productId !== null && row.customId === null) throw new InvalidProtectedData();
      return { sourceText: text(row.sourceText), productId, customId: productId === null ? null : customId(row.customId), productName: requiredText(row.productName),
        brand: optional(row.brand), description: optional(row.description, 65536), otherUnits, baseUnit: requiredText(row.baseUnit, 32), sourceUnit: requiredText(row.sourceUnit, 32),
        pricePerBaseUnit: price(row.pricePerBaseUnit), confidence: confidence(row.confidence), comment: optional(row.comment) };
    });
    if (!lines.length) throw new InvalidProtectedData();
    return { documentType: value.documentType as "priceList" | "invoice", deliveryNote: null, priceList: { supplier: optional(data.supplier),
      documentNumber: optional(data.documentNumber), effectiveDate: date(data.effectiveDate), rows: lines, warnings: strings(data.warnings) } };
  }
  throw new InvalidProtectedData();
}
