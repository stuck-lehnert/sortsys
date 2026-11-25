import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { DuckDriver } from "./database";
import {
  COMMON_COST_MUTATIONS,
  COMMON_COST_QUERIES,
  COMMON_COST_SAVE,
  commonCostInput,
  commonCostKey,
  commonCostObject,
  commonCostRequest,
  legacyCommonCostInput,
  wireCommonCosts,
  type CommonCostInput,
  type CommonCostPayload,
} from "./commonCostData";
import { addressId } from "./addressBook";
import { newProductRowId } from "./products";
import { required } from "./protectedObjects";
import { createBusinessRow, type BusinessRow } from "./rowCodec";
import { acquireDataRuntime } from "./runtime/session";
import { timestampMicros } from "./timestamps";

function mutationValues(
  path: string,
  input: unknown,
  now: string,
): CommonCostInput[] {
  if (path === "settings.costs.update") {
    return legacyCommonCostInput(input).map((value) => ({
      ...value,
      effectiveAt: now,
    }));
  }
  if (path === "settings.costs.set") return [commonCostInput(input)];
  if (
    path !== COMMON_COST_SAVE ||
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 3
  ) {
    throw new InvalidProtectedData();
  }
  const values = input.map(commonCostInput);
  const keys = values.map(
    (value) => `${value.type}:${timestampMicros(value.effectiveAt)}`,
  );
  if (new Set(keys).size !== values.length) throw new InvalidProtectedData();
  return values;
}

function matchingCost(
  row: BusinessRow,
  key: { type: string; effectiveAt: string },
): boolean {
  return (
    row.values.type === key.type &&
    timestampMicros(row.values.effective_at as string) ===
      timestampMicros(key.effectiveAt)
  );
}

export function createProtectedCommonCosts(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  const request = commonCostRequest;

  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate(new Set([request.area.domain]));
    },
    async query(path: string, input: unknown) {
      live();
      if (!COMMON_COST_QUERIES.has(path) || input != null)
        throw new InvalidProtectedData();
      const result = await runtime.read([request], (view) => {
        const rows = view
          .documents(request)
          .map((document) => document.value.row);
        return wireCommonCosts(rows);
      });
      live();
      return result;
    },
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      live();
      cancellation?.throwIfAborted();
      if (!COMMON_COST_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const deleting = path === "settings.costs.delete";
      const key = deleting ? commonCostKey(input) : null;
      const now = new Date().toISOString();
      const values = deleting ? [] : mutationValues(path, input, now);
      const newIds = values.map(() => newProductRowId());
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      const actor = addressId(session.user.id);

      await runtime.transaction(
        [request],
        (transaction) => {
          live();
          cancellation?.throwIfAborted();
          const documents = transaction.documents(request);
          if (key) {
            const previous = documents.find((document) =>
              matchingCost(document.value.row, key),
            );
            if (!previous) throw new InvalidProtectedData();
            transaction.delete(request, previous.id);
            return;
          }

          for (const [index, value] of values.entries()) {
            const previous = documents.find((document) =>
              matchingCost(document.value.row, value),
            );
            if (previous) {
              transaction.require(request, "update");
              transaction.edit(request, previous.id, (payload) => {
                Object.assign(payload.row.values, {
                  relative_factor: value.relativeFactor,
                  constant: value.constant,
                  created_by_user_id: actor,
                  modified_at: now,
                });
              });
            } else {
              transaction.require(request, "create");
              const id = newIds[index]!;
              const row = createBusinessRow("global_common_cost_entries", {
                id,
                type: value.type,
                effective_at: value.effectiveAt,
                relative_factor: value.relativeFactor,
                constant: value.constant,
                created_by_user_id: actor,
                created_at: now,
                modified_at: now,
              });
              const payload: CommonCostPayload = {
                format: "sortsys-common-costs-v1",
                row,
              };
              transaction.create(request, commonCostObject(id), payload);
            }
          }
        },
        { retries: 3 },
      );
      live();
      cancellation?.throwIfAborted();
      return { success: true as const };
    },
  };
}
