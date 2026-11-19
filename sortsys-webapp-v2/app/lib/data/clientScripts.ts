import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import {
  CLIENT_SCRIPT_COLLECTION,
  CLIENT_SCRIPT_MUTATIONS,
  clientScriptChanges,
  clientScriptObject,
  clientScriptRequest,
  wireClientScript,
} from "./clientScriptData";
import type { DuckDriver } from "./database";
import { createPrefixMatcher } from "../search/prefixQuery";
import { newProductRowId } from "./products";
import { required } from "./protectedObjects";
import { businessSchema } from "./schema";
import { acquireDataRuntime } from "./runtime/session";

function listOptions(input: unknown) {
  const data = partialAddressRecord(input ?? {}, [
    "search",
    "includeDisabled",
    "limit",
  ]);
  if (
    data.search != null &&
    (typeof data.search !== "string" ||
      new TextEncoder().encode(data.search).length > 200)
  ) {
    throw new InvalidProtectedData();
  }
  if (
    data.includeDisabled !== undefined &&
    typeof data.includeDisabled !== "boolean"
  )
    throw new InvalidProtectedData();
  if (
    data.limit !== undefined &&
    (typeof data.limit !== "number" ||
      !Number.isInteger(data.limit) ||
      data.limit < 1 ||
      data.limit > 200)
  ) {
    throw new InvalidProtectedData();
  }
  return {
    search: data.search as string | null | undefined,
    includeDisabled: data.includeDisabled !== false,
    limit: (data.limit as number | undefined) ?? 200,
  };
}

export function createProtectedClientScripts(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  const request = clientScriptRequest;
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate(new Set([CLIENT_SCRIPT_COLLECTION.domain]));
    },
    async query(path: string, input: unknown) {
      live();
      if (path === "clientScripts.get") {
        const data = record(input, ["id"]);
        const selected = {
          ...request,
          ids: [clientScriptObject(addressId(data.id))],
        };
        const result = await runtime.read([selected], (view) => {
          const document = view.documents(selected)[0];
          return document ? wireClientScript(document.value) : null;
        });
        live();
        return result;
      }
      if (path !== "clientScripts.list") throw new InvalidProtectedData();
      const options = listOptions(input);
      const matches = createPrefixMatcher(options.search);
      const result = await runtime.read([request], (view) =>
        view
          .documents(request)
          .map((document) => wireClientScript(document.value))
          .filter(
            (script) =>
              (options.includeDisabled || script.enabled) &&
              matches([script.name, script.description]),
          )
          .sort(
            (left, right) =>
              left.name.localeCompare(right.name) ||
              left.id.localeCompare(right.id),
          )
          .slice(0, options.limit)
          .map(({ code: _code, ...summary }) => summary),
      );
      live();
      return result;
    },
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      live();
      cancellation?.throwIfAborted();
      if (!CLIENT_SCRIPT_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path === "clientScripts.create";
      const deleting = path === "clientScripts.delete";
      let rawId: string;
      let changes: ReturnType<typeof clientScriptChanges> = {};
      if (creating) {
        changes = clientScriptChanges(input, true);
        rawId = newProductRowId();
      } else {
        const data = record(input, deleting ? ["id"] : ["id", "data"]);
        rawId = addressId(data.id);
        if (!deleting) changes = clientScriptChanges(data.data, false);
      }
      const object = clientScriptObject(rawId);
      const selected = creating ? request : { ...request, ids: [object] };
      if (deleting) {
        await runtime.remove(selected, object);
        live();
        return { success: true as const };
      }
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      cancellation?.throwIfAborted();
      const actor = addressId(session.user.id);
      const now = new Date().toISOString();
      const result = await runtime.transaction(
        [selected],
        (transaction) => {
          live();
          cancellation?.throwIfAborted();
          if (creating) {
            transaction.create(selected, object, {
              format: "sortsys-client-script-v1",
              row: {
                format: "sortsys-row-v2",
                schema: businessSchema.fingerprint,
                table: "client_scripts",
                values: {
                  id: rawId,
                  ...changes,
                  created_by_user_id: actor,
                  modified_by_user_id: actor,
                  created_at: now,
                  modified_at: now,
                },
              },
            });
          } else {
            const current = transaction.documents(selected)[0];
            if (!current) return null;
            transaction.patch(
              "client_scripts",
              { id: rawId },
              { ...changes, modified_by_user_id: actor, modified_at: now },
            );
          }
          return wireClientScript(
            transaction
              .documents(selected)
              .find((document) => document.id === object)!.value,
          );
        },
        { retries: 3 },
      );
      live();
      return result;
    },
  };
}
