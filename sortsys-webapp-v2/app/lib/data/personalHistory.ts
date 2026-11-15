import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { partialAddressRecord, addressId } from "./addressBook";
import type { DuckDriver } from "./database";
import {
  PERSONAL_HISTORY_MODEL,
  PERSONAL_HISTORY_QUERIES,
  PERSONAL_HISTORY_MUTATIONS,
  HISTORY_LIMITS,
  historyCollection,
  historyObject,
  historyTimestamp,
  recentHistory,
  visitInput,
  actionInput,
  dashboardPin,
  historyPath,
  type HistoryKind,
  type HistoryPayload,
  type PinsPayload,
} from "./personalHistoryData";
import { newProductRowId, publicId } from "./products";
import { required } from "./protectedObjects";
import { decodeBusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import { acquireDataRuntime } from "./runtime/session";

function pinInput(input: unknown, operation: string) {
  let fields: string[];
  switch (operation) {
    case "pin":
      fields = ["path", "title", "visitedAt"];
      break;
    case "unpin":
      fields = ["path"];
      break;
    case "move":
      fields = ["path", "target", "after", "offset"];
      break;
    default:
      fields = ["entries"];
  }
  return partialAddressRecord(input, fields);
}

export function createProtectedPersonalHistory(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  async function request() {
    const session = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    live();
    const subject = `user:${session.user.id}`;
    return {
      subject,
      model: PERSONAL_HISTORY_MODEL,
      area: historyCollection(subject),
    };
  }
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate();
    },
    async query(path: string, input: unknown) {
      live();
      if (!PERSONAL_HISTORY_QUERIES.has(path)) throw new InvalidProtectedData();
      const selected = await request();
      const kind: HistoryKind = path.includes(".visits.")
        ? "visits"
        : "actions";
      const pins = path.includes(".pins.");
      const data = partialAddressRecord(input ?? {}, pins ? [] : ["limit"]);
      const limit = data.limit ?? (kind === "visits" ? 20 : 100);
      if (typeof limit !== "number" || !Number.isSafeInteger(limit))
        throw new InvalidProtectedData();
      const result = await runtime.read([selected], (view) => {
        const object = view
          .documents(selected)
          .find(
            (doc) =>
              doc.id === historyObject(selected.subject, pins ? "pins" : kind),
          );
        if (pins)
          return (
            (object?.value as PinsPayload | undefined)?.entries.map((pin) => ({
              ...pin,
              visitedAt: new Date(pin.visitedAt),
            })) ?? []
          );
        const rows = (object?.value as HistoryPayload | undefined)?.rows ?? [];
        return rows
          .slice(0, Math.max(1, Math.min(limit, HISTORY_LIMITS[kind])))
          .map((row) => ({
            id: publicId(row.values.id),
            ...(kind === "visits"
              ? {
                  path: row.values.path as string,
                  title: row.values.title as string | null,
                  visitedAt: new Date(row.values.visited_at as string),
                }
              : {
                  actionId: row.values.action_id as string,
                  label: row.values.label as string,
                  href: row.values.href as string | null,
                  usedAt: new Date(row.values.used_at as string),
                }),
          }));
      });
      live();
      return result;
    },
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      live();
      cancellation?.throwIfAborted();
      if (!PERSONAL_HISTORY_MUTATIONS.has(path))
        throw new InvalidProtectedData();
      const selected = await request();
      const pins = path.includes(".pins.");
      const kind: HistoryKind = path.includes(".visits.")
        ? "visits"
        : "actions";
      const now = new Date().toISOString();
      const id = newProductRowId();
      let historyFields:
        | ReturnType<typeof visitInput>
        | ReturnType<typeof actionInput>
        | null = null;
      if (!pins) {
        historyFields =
          kind === "visits" ? visitInput(input) : actionInput(input);
      }
      const operation = pins ? path.split(".").at(-1)! : "append";
      const data = pins ? pinInput(input, operation) : {};
      const pin = operation === "pin" ? dashboardPin(data) : null;
      const sourcePath =
        operation === "move" || operation === "unpin"
          ? historyPath(data.path)!
          : null;
      if (
        operation === "import" &&
        (!Array.isArray(data.entries) || data.entries.length > 12)
      )
        throw new InvalidProtectedData();
      const imported =
        operation === "import"
          ? (data.entries as unknown[]).map(dashboardPin)
          : [];
      if (new Set(imported.map((pin) => pin.path)).size !== imported.length)
        throw new InvalidProtectedData();
      const target =
        operation === "move" && data.target !== undefined
          ? historyPath(data.target)!
          : null;
      if (operation === "move") {
        if (data.after !== undefined && typeof data.after !== "boolean") {
          throw new InvalidProtectedData();
        }
        const hasOffset = data.offset !== undefined;
        if (
          hasOffset &&
          (typeof data.offset !== "number" ||
            !Number.isSafeInteger(data.offset) ||
            Math.abs(data.offset) !== 1)
        ) {
          throw new InvalidProtectedData();
        }
        const hasTarget = target !== null;
        // A move needs either a target entry or an adjacent offset.
        if (hasTarget && hasOffset) throw new InvalidProtectedData();
        if (!hasTarget && !hasOffset) throw new InvalidProtectedData();
      }
      const object = historyObject(selected.subject, pins ? "pins" : kind);
      await runtime.transaction(
        [selected],
        (tx) => {
          cancellation?.throwIfAborted();
          const previous = tx
            .documents(selected)
            .find((doc) => doc.id === object);
          if (!pins) {
            const fields = historyFields!;
            const row = decodeBusinessRow({
              format: "sortsys-row-v2",
              schema: businessSchema.fingerprint,
              table:
                kind === "visits"
                  ? "user_visit_history"
                  : "user_action_history",
              values: {
                id,
                user_id: addressId(selected.subject.slice(5)),
                [historyTimestamp(kind)]: now,
                ...("path" in fields
                  ? { path: fields.path, title: fields.title }
                  : {
                      action_id: fields.actionId,
                      label: fields.label,
                      href: fields.href,
                    }),
              },
            });
            const rows = recentHistory(
              [
                ...((previous?.value as HistoryPayload | undefined)?.rows ??
                  []),
                row,
              ],
              kind,
            );
            if (previous)
              tx.edit(selected, object, (value) => {
                (value as HistoryPayload).rows = rows;
              });
            else
              tx.create(selected, object, {
                format: "sortsys-personal-history-v1",
                subject: selected.subject,
                kind,
                rows,
              });
            return;
          }
          const current = previous?.value as PinsPayload | undefined;
          let entries = [...(current?.entries ?? [])];
          if (pin)
            entries = [
              pin,
              ...entries.filter((value) => value.path !== pin.path),
            ].slice(0, 12);
          else if (operation === "unpin")
            entries = entries.filter((value) => value.path !== sourcePath);
          else if (operation === "import" && !current?.importedLocal)
            entries = [
              ...entries,
              ...imported.filter(
                (value) => !entries.some((entry) => entry.path === value.path),
              ),
            ].slice(0, 12);
          else if (operation === "move") {
            const sourceIndex = entries.findIndex(
              (value) => value.path === sourcePath,
            );
            const targetIndex =
              target === null
                ? sourceIndex + (data.offset as number)
                : entries.findIndex((value) => value.path === target);
            if (
              sourceIndex >= 0 &&
              targetIndex >= 0 &&
              targetIndex < entries.length &&
              sourceIndex !== targetIndex
            ) {
              const [moving] = entries.splice(sourceIndex, 1);
              let insertionIndex = targetIndex;
              if (target !== null) {
                insertionIndex = entries.findIndex(
                  (entry) => entry.path === target,
                );
                if (data.after) insertionIndex++;
              }
              entries.splice(insertionIndex, 0, moving!);
            }
          }
          const next: PinsPayload = {
            format: "sortsys-dashboard-pins-v1",
            subject: selected.subject,
            entries,
            importedLocal:
              current?.importedLocal === true || operation === "import",
          };
          if (previous) {
            if (JSON.stringify(current) !== JSON.stringify(next))
              tx.edit(selected, object, (value) => {
                Object.assign(value, next);
              });
          } else tx.create(selected, object, next);
        },
        { retries: 3 },
      );
      live();
      cancellation?.throwIfAborted();
      return { success: true as const };
    },
  };
}
