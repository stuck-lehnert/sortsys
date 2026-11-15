import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { commonCostType, costNumber } from "./commonCostData";
import { indexEffectiveHistory } from "./effectiveHistory";
import { indexHistoricalPrices, wireHistoricalPrice } from "./historicalPrices";
import { wireFinancialEntry } from "./projectFinancialData";
import { publicId } from "./products";
import type { BusinessRow } from "./rowCodec";
import type { DailyCosts, DailyPayload } from "./dailyReportData";
import { wireDailyReport } from "./dailyReportData";
import type { DeliveryPayload, DeliveryPrices } from "./deliveryNoteData";
import { wireDelivery } from "./deliveryNoteData";
import {
  timestampFromMicros,
  timestampInstant,
  timestampMicros,
} from "./timestamps";

export type ProjectCosts = QueryResult<"projects.costs.get">;
export type CostPeriod = { from: bigint | null; to: bigint | null };
export type ProjectCostSources = {
  financial: readonly BusinessRow[];
  deliveries: readonly { value: DeliveryPayload; prices: DeliveryPrices }[];
  daily: readonly { value: DailyPayload; costs: DailyCosts }[];
  tools: readonly BusinessRow[];
  productPrices: readonly BusinessRow[];
  commonCosts: readonly BusinessRow[];
};
type ProductCost = ProjectCosts["products"][number];
type CostBucket = ProjectCosts["commonCosts"]["fgk"];

export function costPeriod(from: unknown, to: unknown): CostPeriod {
  const first = from == null ? null : timestampMicros(timestampInstant(from));
  const last = to == null ? null : timestampMicros(timestampInstant(to));
  if (first !== null && last !== null && first > last)
    throw new InvalidProtectedData();
  return { from: first, to: last };
}
function inPeriod(instant: bigint, period: CostPeriod): boolean {
  return (
    (period.from === null || instant >= period.from) &&
    (period.to === null || instant <= period.to)
  );
}
function compareIdDescending(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}
function compareRows(
  left: BusinessRow,
  right: BusinessRow,
  timestamp: string,
): number {
  const first = timestampMicros(left.values[timestamp] as string);
  const second = timestampMicros(right.values[timestamp] as string);
  if (first > second) return -1;
  if (first < second) return 1;
  return compareIdDescending(
    left.values.id as string,
    right.values.id as string,
  );
}
function emptyBucket(): CostBucket {
  return { baseCost: 0, overheadCost: 0, totalCost: 0 };
}
function optionalId(value: unknown): string | null {
  return value === null ? null : publicId(value);
}

/** A pure calculation over complete, authorized source sets. No missing
 * collection or missing cost fragment is treated as an empty data set. */
export function calculateProjectCosts(
  source: ProjectCostSources,
  period: CostPeriod = { from: null, to: null },
  now = new Date(),
): ProjectCosts {
  const nowMicros = timestampMicros(timestampInstant(now));
  const priceAt = indexHistoricalPrices(source.productPrices);
  const commonAt = indexEffectiveHistory(
    source.commonCosts.map((row) => ({
      group: commonCostType(row.values.type),
      instant: timestampMicros(row.values.effective_at as string),
      id: BigInt(row.values.id as string),
      value: row,
    })),
  );
  function overhead(
    type: "fgk" | "mgk" | "ngk",
    instant: bigint,
    base: number,
  ): number {
    const values = commonAt(type, instant)?.values;
    if (!values) return 0;
    return costNumber(
      base * costNumber(values.relative_factor) + costNumber(values.constant),
    );
  }

  const financial = source.financial
    .filter((row) =>
      inPeriod(timestampMicros(row.values.created_at as string), period),
    )
    .sort((left, right) => compareRows(left, right, "created_at"));
  const offers = financial
    .filter((row) => row.values.type === "offer")
    .map(wireFinancialEntry);
  const invoices = financial
    .filter((row) => row.values.type === "invoice")
    .map(wireFinancialEntry);
  const fgk = emptyBucket();
  const mgk = emptyBucket();
  const ngk = emptyBucket();
  const products = new Map<string, ProductCost>();
  const productOrder = new Map<
    ProductCost,
    { product: bigint; instant: bigint | null; price: bigint }
  >();
  const deliveryNotes: ProjectCosts["deliveryNotes"] = [];
  const specialRecords: ProjectCosts["specialRecords"] = [];
  const noteInstants = new Map<string, bigint>();
  const deliveries = source.deliveries
    .filter(({ value }) =>
      inPeriod(
        timestampMicros(value.note.values.effective_timestamp as string),
        period,
      ),
    )
    .sort((left, right) =>
      compareRows(left.value.note, right.value.note, "effective_timestamp"),
    );

  for (const entry of deliveries) {
    const effective = timestampMicros(
      entry.value.note.values.effective_timestamp as string,
    );
    const specialPrices = new Set(entry.prices.prices.map((price) => price.id));
    if (
      entry.value.specialRecords.some(
        (row) => !specialPrices.has(publicId(row.values.id)),
      )
    )
      throw new InvalidProtectedData();
    const note = wireDelivery(entry.value, entry.prices);
    noteInstants.set(note.id, effective);
    let totalCost = 0;
    for (const record of note.records) {
      const row = priceAt(record.productId, effective, "earliest");
      const priceRecord = row ? wireHistoricalPrice(row) : null;
      const amount = costNumber(record.quantity * (priceRecord?.price ?? 0));
      totalCost += amount;
      const key = `${record.productId}:${priceRecord?.id ?? "none"}`;
      let product = products.get(key);
      if (!product) {
        product = {
          productId: record.productId,
          quantity: 0,
          totalCost: 0,
          priceRecord,
        };
        products.set(key, product);
        productOrder.set(product, {
          product: BigInt(addressId(record.productId)),
          instant: row ? timestampMicros(row.values.timestamp as string) : null,
          price: row ? BigInt(row.values.id as string) : 0n,
        });
      }
      product.quantity += record.quantity;
      product.totalCost += amount;
    }
    for (const record of note.specialRecords) {
      const amount = costNumber(record.amount * (record.pricePerUnit ?? 0));
      totalCost += amount;
      specialRecords.push({
        ...record,
        noteId: note.id,
        noteAutoId: note.autoId,
        effectiveTimestamp: note.effectiveTimestamp,
        totalCost: amount,
      });
    }
    mgk.baseCost += totalCost;
    if (note.records.length + note.specialRecords.length > 0)
      mgk.overheadCost += overhead("mgk", effective, totalCost);
    deliveryNotes.push({
      noteId: note.id,
      autoId: note.autoId,
      effectiveTimestamp: note.effectiveTimestamp,
      totalCost,
    });
  }

  const firstDay =
    period.from === null ? null : timestampFromMicros(period.from).slice(0, 10);
  const lastDay =
    period.to === null ? null : timestampFromMicros(period.to).slice(0, 10);
  const work: { row: BusinessRow; wire: ProjectCosts["workHours"][number] }[] =
    [];
  const laborByDay = new Map<
    string,
    { fgk: number; ngk: number; internal: boolean; subcontractor: boolean }
  >();
  for (const entry of source.daily) {
    if (!entry.value.report) continue;
    const day = entry.value.report.values.day as string;
    if (
      (firstDay !== null && day < firstDay) ||
      (lastDay !== null && day > lastDay)
    )
      continue;
    const prices = new Set(entry.costs.costs.map((cost) => cost.id));
    if (entry.value.hours.some((row) => !prices.has(publicId(row.values.id))))
      throw new InvalidProtectedData();
    const report = wireDailyReport(entry.value, entry.costs);
    const aggregate = laborByDay.get(day) ?? {
      fgk: 0,
      ngk: 0,
      internal: false,
      subcontractor: false,
    };
    laborByDay.set(day, aggregate);
    for (const [index, hours] of report.workHours.entries()) {
      const totalCost = costNumber(hours.hours * (hours.costPerHour ?? 0));
      if (hours.contractType === "internal") {
        aggregate.fgk += totalCost;
        aggregate.internal = true;
        fgk.baseCost += totalCost;
      } else if (hours.contractType === "subcontractor") {
        aggregate.ngk += totalCost;
        aggregate.subcontractor = true;
        ngk.baseCost += totalCost;
      }
      work.push({
        row: entry.value.hours[index]!,
        wire: {
          id: hours.id,
          userId: hours.userId,
          day: report.day,
          hours: hours.hours,
          costPerHour: hours.costPerHour,
          contractType: hours.contractType,
          totalCost,
        },
      });
    }
  }
  for (const [day, amounts] of laborByDay) {
    const instant = timestampMicros(`${day}T00:00:00Z`);
    if (amounts.internal)
      fgk.overheadCost += overhead("fgk", instant, amounts.fgk);
    if (amounts.subcontractor)
      ngk.overheadCost += overhead("ngk", instant, amounts.ngk);
  }
  work.sort((left, right) =>
    compareIdDescending(
      left.row.values.id as string,
      right.row.values.id as string,
    ),
  );
  const workHours = work
    .filter((entry) => entry.wire.contractType !== "subcontractor")
    .map((entry) => entry.wire);
  const subcontractorWorkHours = work
    .filter((entry) => entry.wire.contractType === "subcontractor")
    .map((entry) => entry.wire);

  const trackings = source.tools
    .filter((row) => {
      const start = timestampMicros(row.values.started_at as string);
      const end =
        row.values.ended_at === null
          ? nowMicros
          : timestampMicros(row.values.ended_at as string);
      return (
        (period.from === null || end >= period.from) &&
        (period.to === null || start <= period.to)
      );
    })
    .sort((left, right) => compareRows(left, right, "started_at"));
  const toolTrackings = trackings.map(({ values }) => {
    const startedAt = new Date(values.started_at as string);
    const endedAt =
      values.ended_at === null ? null : new Date(values.ended_at as string);
    const days = Math.max(
      0,
      Math.floor((endedAt ?? now).getTime() / 86400000) -
        Math.floor(startedAt.getTime() / 86400000) +
        1,
    );
    const rate = values.tool_usage_cost_per_day as number | null;
    return {
      id: publicId(values.id),
      toolId: publicId(values.tool_id),
      responsibleUserId: optionalId(values.responsible_user_id),
      startedByUserId: optionalId(values.started_by_user_id),
      endedByUserId: optionalId(values.ended_by_user_id),
      toolUsageCostPerDay: rate,
      comment: values.comment as string | null,
      startedAt,
      endedAt,
      deadlineAt:
        values.deadline_at === null
          ? null
          : new Date(values.deadline_at as string),
      totalCost: costNumber(days * (rate ?? 0)),
    };
  });

  const productRows = [...products.values()].sort((left, right) => {
    const a = productOrder.get(left)!;
    const b = productOrder.get(right)!;
    if (a.product < b.product) return -1;
    if (a.product > b.product) return 1;
    if (a.instant === null && b.instant !== null) return 1;
    if (a.instant !== null && b.instant === null) return -1;
    if (a.instant !== b.instant) return a.instant! > b.instant! ? -1 : 1;
    return compareIdDescending(String(a.price), String(b.price));
  });
  specialRecords.sort((left, right) => {
    const a = noteInstants.get(left.noteId)!;
    const b = noteInstants.get(right.noteId)!;
    if (a > b) return -1;
    if (a < b) return 1;
    return compareIdDescending(addressId(left.id), addressId(right.id));
  });
  for (const product of productRows) {
    costNumber(product.quantity);
    costNumber(product.totalCost);
  }
  const sum = (rows: readonly { totalCost: number }[]) =>
    costNumber(rows.reduce((amount, row) => amount + row.totalCost, 0));
  for (const bucket of [fgk, mgk, ngk])
    bucket.totalCost = costNumber(bucket.baseCost + bucket.overheadCost);
  const overallOverhead = costNumber(
    fgk.overheadCost + mgk.overheadCost + ngk.overheadCost,
  );
  const totalCosts = {
    offers: costNumber(offers.reduce((amount, row) => amount + row.amount, 0)),
    invoices: costNumber(
      invoices.reduce((amount, row) => amount + row.amount, 0),
    ),
    deliveryNotes: sum(deliveryNotes),
    products: sum(productRows),
    specialRecords: sum(specialRecords),
    workHours: sum(workHours),
    subcontractorWorkHours: sum(subcontractorWorkHours),
    toolTrackings: sum(toolTrackings),
    overall: 0,
  };
  totalCosts.overall = costNumber(
    totalCosts.deliveryNotes +
      totalCosts.workHours +
      totalCosts.subcontractorWorkHours +
      totalCosts.toolTrackings +
      overallOverhead,
  );
  return {
    offers,
    invoices,
    deliveryNotes,
    products: productRows,
    specialRecords,
    workHours,
    subcontractorWorkHours,
    toolTrackings,
    commonCosts: { fgk, mgk, ngk, overallOverhead },
    totalCosts,
  };
}
