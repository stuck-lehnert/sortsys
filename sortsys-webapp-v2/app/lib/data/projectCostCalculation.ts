import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { commonCostType, costNumber } from "./commonCostData";
import { indexEffectiveHistory } from "./effectiveHistory";
import type { HistoricalPriceLookup } from "./historicalPrices";
import { wireFinancialEntry } from "./projectFinancialData";
import { publicId } from "./products";
import type { BusinessFields, BusinessRow } from "./rowCodec";
import type { DailyCosts, DailyPayload } from "./dailyReportData";
import { wireDailyReport } from "./dailyReportData";
import type { DeliveryPayload, DeliveryPrices } from "./deliveryNoteData";
import { calculateDeliveryCosts } from "./deliveryNoteData";
import {
  timestampFromMicros,
  timestampInstant,
  timestampMicros,
} from "./timestamps";

export type ProjectCosts = QueryResult<"projects.costs.get">;
export type CostPeriod = { from: bigint | null; to: bigint | null };
export type ProjectCostSources = {
  financial: readonly BusinessRow[];
  deliveries: readonly { value: DeliveryPayload; prices?: DeliveryPrices }[];
  daily: readonly { value: DailyPayload; costs: DailyCosts }[];
  tools: readonly BusinessRow[];
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
export function toolUsageInPeriod(
  values: BusinessFields["values"],
  period: CostPeriod,
  now: bigint,
): boolean {
  const start = timestampMicros(values.started_at as string);
  return toolUsageOverlaps(values, start, period, now);
}

function toolUsageOverlaps(
  values: BusinessFields["values"],
  start: bigint,
  period: CostPeriod,
  now: bigint,
) {
  const end =
    values.ended_at === null ? now : timestampMicros(values.ended_at as string);
  return (
    (period.from === null || end >= period.from) &&
    (period.to === null || start <= period.to)
  );
}
function compareIdDescending(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}
function orderedCostRows<T>(
  source: readonly T[],
  row: (value: T) => BusinessRow,
  field: string,
  include: (instant: bigint, values: BusinessRow["values"]) => boolean,
): T[] {
  const selected: { value: T; instant: bigint; id: bigint }[] = [];
  for (const value of source) {
    const { values } = row(value);
    const instant = timestampMicros(values[field] as string);
    if (include(instant, values)) {
      selected.push({ value, instant, id: BigInt(values.id as string) });
    }
  }

  selected.sort((a, b) => {
    if (a.instant !== b.instant) return a.instant > b.instant ? -1 : 1;
    if (a.id !== b.id) return a.id > b.id ? -1 : 1;
    return 0;
  });
  return selected.map(({ value }) => value);
}
function emptyBucket(): CostBucket {
  return { baseCost: 0, overheadCost: 0, totalCost: 0 };
}
function optionalId(value: unknown): string | null {
  return value === null ? null : publicId(value);
}

export function projectCostRates(
  productAt: HistoricalPriceLookup,
  commonCosts: readonly BusinessRow[],
) {
  const commonAt = indexEffectiveHistory(
    commonCosts.map((row) => ({
      group: commonCostType(row.values.type),
      instant: timestampMicros(row.values.effective_at as string),
      id: BigInt(row.values.id as string),
      value: row,
    })),
  );
  return {
    productAt,
    overhead(type: "fgk" | "mgk" | "ngk", instant: bigint, base: number) {
      const values = commonAt(type, instant)?.values;
      if (!values) return 0;
      return costNumber(
        base * costNumber(values.relative_factor) + costNumber(values.constant),
      );
    },
  };
}

/** Calculate from source collections the caller has verified and authorized. */
export function calculateProjectCosts(
  source: ProjectCostSources,
  rates: ReturnType<typeof projectCostRates>,
  period: CostPeriod = { from: null, to: null },
  now = new Date(),
): ProjectCosts {
  const nowMicros = timestampMicros(timestampInstant(now));
  const insidePeriod = (instant: bigint) => inPeriod(instant, period);

  const financial = orderedCostRows(
    source.financial,
    (row) => row,
    "created_at",
    insidePeriod,
  );
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
  const deliveries = orderedCostRows(
    source.deliveries,
    ({ value }) => value.note,
    "effective_timestamp",
    insidePeriod,
  );

  for (const { value, prices } of deliveries) {
    const costs = calculateDeliveryCosts(value, prices, rates.productAt);
    const { noteId, autoId, effective, effectiveTimestamp, totalCost } = costs;
    noteInstants.set(noteId, effective);
    for (const record of costs.records) {
      const { productId, priceRecord, priceInstant } = record;
      const key = `${productId}:${priceRecord?.id ?? "none"}`;
      let product = products.get(key);
      if (!product) {
        product = {
          productId,
          quantity: 0,
          totalCost: 0,
          priceRecord,
        };
        products.set(key, product);
        productOrder.set(product, {
          product: BigInt(addressId(productId)),
          instant: priceInstant,
          price: priceRecord ? BigInt(addressId(priceRecord.id)) : 0n,
        });
      }
      product.quantity += record.quantity;
      product.totalCost += record.totalCost;
    }
    for (const { recordId, ...record } of costs.specialRecords) {
      specialRecords.push({
        ...record,
        id: recordId,
        noteId,
        noteAutoId: autoId,
        effectiveTimestamp,
      });
    }
    mgk.baseCost += totalCost;
    if (costs.records.length + costs.specialRecords.length > 0)
      mgk.overheadCost += rates.overhead("mgk", effective, totalCost);
    deliveryNotes.push({
      noteId,
      autoId,
      effectiveTimestamp,
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
      fgk.overheadCost += rates.overhead("fgk", instant, amounts.fgk);
    if (amounts.subcontractor)
      ngk.overheadCost += rates.overhead("ngk", instant, amounts.ngk);
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

  const trackings = orderedCostRows(
    source.tools,
    (row) => row,
    "started_at",
    (instant, values) => toolUsageOverlaps(values, instant, period, nowMicros),
  );
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
