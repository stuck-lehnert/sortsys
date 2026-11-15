import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { existingAggregateRows } from "./aggregateRows";
import { commitProtectedWrites, ProtectedWriteConflict } from "./atomicWrites";
import { calendarDay } from "./calendarDays";
import type { DuckDriver } from "./database";
import { personnelRequest } from "./personnelData";
import {
  newProductRowId,
  PRICE_COLLECTION,
  PRICE_MODEL,
  PRODUCT_COLLECTION,
  PRODUCT_MODEL,
  publicId,
} from "./products";
import { PROJECT_MODEL, projectCollection } from "./projectData";
import { readableAreas } from "./readableAreas";
import { required } from "./protectedObjects";
import {
  regieChanges,
  regieCollection,
  regieDomain,
  regieHourRequest,
  regieMaterialCosts,
  regieRequest,
  REGIE_MUTATIONS,
  REGIE_QUERIES,
  wireRegie,
  type RegieHours,
  type RegiePayload,
} from "./regieReportData";
import { decodeBusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import { acquireDataRuntime } from "./runtime/session";
import type { DataRequest, DataView } from "./runtime/runtime";

const priceRequest = { model: PRICE_MODEL, area: PRICE_COLLECTION },
  productRequest = { model: PRODUCT_MODEL, area: PRODUCT_COLLECTION };
const row = (table: string, values: Record<string, unknown>) =>
  decodeBusinessRow({
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table,
    values,
  });
function expected(input: unknown, revision: string | undefined): void {
  if (input === undefined) return;
  if (typeof input !== "string" || !/^(0|[1-9]\d{0,18})$/.test(input))
    throw new InvalidProtectedData();
  if (input !== (revision ?? "0")) throw new ProtectedWriteConflict();
}
function sameCreation(
  value: RegiePayload,
  hours: RegieHours | undefined,
  changes: ReturnType<typeof regieChanges>,
  actor: string,
): boolean {
  if (
    !value.report ||
    value.report.values.created_by_user_id !== addressId(actor) ||
    value.report.values.day !== changes.day ||
    value.report.values.summary !== changes.summary
  )
    return false;
  const products = value.products.map(({ values: row }) => ({
    productId: publicId(row.product_id),
    quantity: row.quantity,
    comment: row.comment,
  }));
  const specials = value.specials.map(({ values: row }) => ({
    name: row.name,
    unit: row.unit,
    amount: row.amount,
    comment: row.comment,
  }));
  const expectedProducts = (changes.products ?? []).map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
    comment: line.comment ?? null,
  }));
  const expectedSpecials = (changes.specials ?? []).map((line) => ({
    name: line.name,
    unit: line.unit,
    amount: line.amount,
    comment: line.comment ?? null,
  }));
  if (
    JSON.stringify(products) !== JSON.stringify(expectedProducts) ||
    JSON.stringify(specials) !== JSON.stringify(expectedSpecials)
  )
    return false;
  if (hours || changes.hours?.length) {
    const observed = (hours?.hours ?? []).map(({ values: row }) => ({
      userId: row.user_id === null ? null : publicId(row.user_id),
      day: row.day,
      hours: row.hours,
    }));
    if (JSON.stringify(observed) !== JSON.stringify(changes.hours ?? []))
      return false;
  }
  return true;
}
type Selection = {
  reports: DataRequest<RegiePayload>[];
  hours: DataRequest<RegieHours>[];
  all: DataRequest[];
};
function reports(view: DataView, selection: Selection) {
  const values = [];
  for (const selected of selection.reports) {
    const projectId = regieDomain(selected.area.domain)!.projectId,
      hourRequest = selection.hours.find(
        (item) => item.area.scope === selected.area.scope,
      );
    const times = new Map(
      hourRequest
        ? view
            .documents(hourRequest)
            .map((document) => [document.value.reportId, document])
        : [],
    );
    const rows = view
      .documents(selected)
      .filter((document) => document.value.report);
    rows.sort(
      (a, b) =>
        (a.value.report!.values.day as string).localeCompare(
          b.value.report!.values.day as string,
        ) ||
        (BigInt(a.value.report!.values.id as string) <
        BigInt(b.value.report!.values.id as string)
          ? -1
          : 1),
    );
    for (const [index, document] of rows.entries()) {
      const id = publicId(document.value.report!.values.id),
        hour = times.get(id);
      values.push({
        selected,
        document,
        hourRequest,
        hour,
        projectId,
        wire: {
          ...wireRegie(document.value, hour?.value, index + 1),
          revision: document.revision,
          workHoursAvailable: !!hourRequest,
          ...(hourRequest ? { hoursRevision: hour?.revision ?? "0" } : {}),
        },
      });
    }
  }
  return values;
}
export function createProtectedRegieReports(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    { runtime, live } = lease;
  async function selection(projectId?: string): Promise<Selection> {
    if (projectId) addressId(projectId);
    const areas = await readableAreas(client, signal, (domain) => {
      const part = regieDomain(domain);
      return part && (!projectId || part.projectId === projectId)
        ? regieCollection(part.projectId, part.hours)
        : null;
    });
    live();
    const main = areas
      .filter((area) => area.facet === "master-data")
      .map((area) => regieRequest(regieDomain(area.domain)!.projectId));
    if (projectId && !main.length) throw new InvalidProtectedData();
    const scopes = new Set(main.map((item) => item.area.scope));
    const hours = areas
      .filter((area) => area.facet === "personnel" && scopes.has(area.scope))
      .map((area) => regieHourRequest(regieDomain(area.domain)!.projectId));
    return { reports: main, hours, all: [...main, ...hours] };
  }
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.invalidate();
    },
    async query(path: string, input: unknown) {
      live();
      if (!REGIE_QUERIES.has(path)) throw new InvalidProtectedData();
      const listing = path === "regieReports.list",
        data = partialAddressRecord(
          input ?? {},
          listing
            ? ["projectId", "dayFrom", "dayTo", "limit", "offset"]
            : ["id"],
        );
      if (!listing) addressId(data.id);
      if (data.projectId != null) addressId(data.projectId);
      const from = data.dayFrom == null ? null : calendarDay(data.dayFrom),
        to = data.dayTo == null ? null : calendarDay(data.dayTo),
        limit = data.limit ?? 1000,
        offset = data.offset ?? 0;
      if (
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new InvalidProtectedData();
      const selected = await selection(
        data.projectId == null ? undefined : (data.projectId as string),
      );
      const all = await runtime.read(selected.all, (view) =>
        reports(view, selected),
      );
      live();
      if (listing)
        return all
          .map((item) => item.wire)
          .filter(
            (item) =>
              (from === null || calendarDay(item.day) >= from) &&
              (to === null || calendarDay(item.day) <= to),
          )
          .sort(
            (a, b) =>
              b.day.getTime() - a.day.getTime() ||
              (addressId(a.id) > addressId(b.id) ? -1 : 1),
          )
          .slice(offset, offset + limit);
      const current = all.find((item) => item.wire.id === data.id);
      if (!current) throw new InvalidProtectedData();
      if (path === "regieReports.get") return current.wire;
      if (!current.wire.products.length)
        return regieMaterialCosts(current.wire, []);
      const result = await runtime.read(
        [...selected.all, priceRequest],
        (view) => {
          const report = reports(view, selected).find(
            (item) => item.wire.id === data.id,
          );
          if (!report) throw new InvalidProtectedData();
          return regieMaterialCosts(
            report.wire,
            view
              .documents(priceRequest)
              .map((document) => document.value.price),
          );
        },
      );
      live();
      return result;
    },
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      const operation = cancellation
        ? AbortSignal.any([signal, cancellation])
        : signal;
      operation.throwIfAborted();
      live();
      if (!REGIE_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path === "regieReports.create",
        deleting = path === "regieReports.delete";
      const outer = partialAddressRecord(
        input,
        creating
          ? [
              "operationId",
              "projectId",
              "day",
              "summary",
              "products",
              "specialRecords",
              "workHours",
            ]
          : deleting
            ? ["id", "expectedRevision"]
            : ["id", "data", "expectedRevision", "expectedHoursRevision"],
      );
      if (creating) {
        addressId(outer.projectId);
        if (outer.operationId !== undefined) addressId(outer.operationId);
      } else addressId(outer.id);
      const changes = deleting
        ? {}
        : regieChanges(
            creating
              ? Object.fromEntries(
                  Object.entries(outer).filter(
                    ([key]) => key !== "projectId" && key !== "operationId",
                  ),
                )
              : outer.data,
            creating,
          );
      const available = await selection(
        creating ? (outer.projectId as string) : undefined,
      );
      const baseline = creating
        ? null
        : await runtime.read(available.all, (view) =>
            reports(view, available).find((item) => item.wire.id === outer.id),
          );
      live();
      if (!creating && !baseline) throw new InvalidProtectedData();
      const projectId = creating
          ? (outer.projectId as string)
          : baseline!.projectId,
        selected = regieRequest(projectId);
      const timeRequest = available.hours.find(
        (item) => item.area.scope === selected.area.scope,
      );
      if (
        changes.hours !== undefined &&
        (changes.hours.length || !creating) &&
        !timeRequest
      )
        throw new InvalidProtectedData();
      const movingWeek =
        !creating &&
        changes.day !== undefined &&
        changes.day !== baseline!.document.value.report!.values.day;
      if (movingWeek && (changes.hours === undefined || !timeRequest))
        throw new InvalidProtectedData();
      const hoursSelected =
        timeRequest &&
        ((changes.hours !== undefined &&
          (!creating || changes.hours.length > 0)) ||
          movingWeek)
          ? timeRequest
          : null;
      const old = baseline?.document.value,
        oldProducts = existingAggregateRows(
          old?.products ?? [],
          changes.products ?? [],
        ),
        oldSpecials = existingAggregateRows(
          old?.specials ?? [],
          changes.specials ?? [],
        ),
        oldHours = existingAggregateRows(
          baseline?.hour?.value.hours ?? [],
          changes.hours ?? [],
        );
      const newProducts = (changes.products ?? []).filter(
        (change) =>
          !change.id ||
          oldProducts.get(change.id)?.values.product_id !==
            addressId(change.productId),
      );
      const newUsers = [
        ...new Set(
          (changes.hours ?? [])
            .filter(
              (change) =>
                change.userId &&
                (!change.id ||
                  oldHours.get(change.id)?.values.user_id !==
                    addressId(change.userId)),
            )
            .map((change) => change.userId!),
        ),
      ].map((id) => personnelRequest(id, "master-data"));
      const project = creating
        ? { model: PROJECT_MODEL, area: projectCollection(projectId) }
        : null;
      const session = creating
        ? await required(
            client.query("auth.sessionInfo", undefined, {
              strategy: "network-only",
            }),
          )
        : null;
      live();
      const prepared = await runtime.prepare(
        [
          selected,
          ...(hoursSelected ? [hoursSelected] : []),
          ...(project ? [project] : []),
          ...(newProducts.length ? [productRequest] : []),
          ...newUsers,
        ],
        (tx) => {
          if (creating && outer.operationId !== undefined) {
            const existing = tx
              .documents(selected)
              .find(
                (document) =>
                  document.id === selected.area.prefix + outer.operationId,
              );
            if (existing) {
              const hours = hoursSelected
                ? tx
                    .documents(hoursSelected)
                    .find(
                      (document) =>
                        document.value.reportId === outer.operationId,
                    )?.value
                : undefined;
              if (
                !sameCreation(existing.value, hours, changes, session!.user.id)
              )
                throw new ProtectedWriteConflict();
              return { id: outer.operationId as string };
            }
          }
          const current = baseline
            ? tx
                .documents(selected)
                .find((document) => document.id === baseline.document.id)
            : undefined;
          if (baseline) {
            if (!current?.value.report) throw new InvalidProtectedData();
            tx.expect(selected, baseline.document.id, {
              signature: baseline.document.signature,
            });
          }
          expected(outer.expectedRevision, current?.revision);
          if (
            project &&
            !tx.documents(project).some((document) => document.value.project)
          )
            throw new InvalidProtectedData();
          if (
            newProducts.some(
              (change) =>
                !tx
                  .documents(productRequest)
                  .some(
                    (document) =>
                      document.value.product.values.id ===
                      addressId(change.productId),
                  ),
            )
          )
            throw new InvalidProtectedData();
          for (const user of newUsers)
            tx.row("users", { id: addressId(user.area.scope.split(":")[1]) });
          const id = creating
              ? ((outer.operationId as string | undefined) ??
                publicId(newProductRowId()))
              : (outer.id as string),
            rawId = addressId(id),
            object = selected.area.prefix + id,
            now = new Date().toISOString();
          if (deleting) {
            tx.delete(selected, object);
            return { success: true as const };
          }
          const currentValue = current?.value;
          const day =
            changes.day ?? (currentValue!.report!.values.day as string);
          const products =
            changes.products === undefined
              ? currentValue!.products
              : changes.products.map((change) => {
                  const previous = change.id
                    ? oldProducts.get(change.id)
                    : undefined;
                  return row("regie_report_products", {
                    id: previous?.values.id ?? newProductRowId(),
                    report_id: rawId,
                    product_id: addressId(change.productId),
                    quantity: change.quantity,
                    comment:
                      change.comment === undefined
                        ? (previous?.values.comment ?? null)
                        : change.comment,
                  });
                });
          const specials =
            changes.specials === undefined
              ? currentValue!.specials
              : changes.specials.map((change) => {
                  const previous = change.id
                    ? oldSpecials.get(change.id)
                    : undefined;
                  return row("regie_report_special_records", {
                    id: previous?.values.id ?? newProductRowId(),
                    report_id: rawId,
                    name: change.name,
                    unit: change.unit,
                    amount: change.amount,
                    comment:
                      change.comment === undefined
                        ? (previous?.values.comment ?? null)
                        : change.comment,
                  });
                });
          const value: RegiePayload = {
            format: "sortsys-regie-report-v1",
            report: row(
              "regie_reports",
              currentValue
                ? {
                    ...currentValue.report!.values,
                    day,
                    ...(changes.summary === undefined
                      ? {}
                      : { summary: changes.summary }),
                  }
                : {
                    id: rawId,
                    project_id: addressId(projectId),
                    day,
                    summary: changes.summary ?? null,
                    created_by_user_id: addressId(session!.user.id),
                    created_at: now,
                  },
            ),
            products,
            specials,
          };
          if (creating) tx.create(selected, object, value);
          else if (JSON.stringify(value) !== JSON.stringify(currentValue))
            tx.edit(selected, object, (target) => Object.assign(target, value));
          if (hoursSelected) {
            const hourObject = hoursSelected.area.prefix + id,
              currentHours = tx
                .documents(hoursSelected)
                .find((document) => document.id === hourObject);
            expected(outer.expectedHoursRevision, currentHours?.revision);
            if (baseline?.hour)
              tx.expect(hoursSelected, baseline.hour.id, {
                signature: baseline.hour.signature,
              });
            if (movingWeek)
              tx.require(hoursSelected, currentHours ? "update" : "create");
            const value: RegieHours = {
              format: "sortsys-regie-hours-v1",
              projectId,
              reportId: id,
              week: day,
              hours: (changes.hours ?? []).map((change) => {
                const previous = change.id
                  ? oldHours.get(change.id)
                  : undefined;
                return row("regie_report_work_hours", {
                  id: previous?.values.id ?? newProductRowId(),
                  report_id: rawId,
                  user_id:
                    change.userId === null ? null : addressId(change.userId),
                  day: change.day,
                  hours: change.hours,
                });
              }),
            };
            if (!currentHours) tx.create(hoursSelected, hourObject, value);
            else if (
              JSON.stringify(value) !== JSON.stringify(currentHours.value)
            )
              tx.edit(hoursSelected, hourObject, (target) =>
                Object.assign(target, value),
              );
          }
          return creating ? { id } : { success: true as const };
        },
      );
      try {
        live();
        operation.throwIfAborted();
        if (prepared.groups.length)
          await commitProtectedWrites(
            client,
            prepared.groups,
            operation,
            prepared.guards,
          );
        live();
        return prepared.value;
      } finally {
        prepared.close();
      }
    },
  };
}
