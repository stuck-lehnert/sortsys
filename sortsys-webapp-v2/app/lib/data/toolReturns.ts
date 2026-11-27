import type { Client } from "@sortsys/v2-client";
import { arrayBatches, mapConcurrent } from "@sortsys/zerotrust";
import {
  InvalidProtectedData,
  resourceCommandBinding,
  TOOL_RETURN_PURPOSE,
  verifyResourceCommand,
  type ResourceCommand,
} from "@sortsys/zerotrust/sortsys";
import { captureAccountScope, type UnlockedAccount } from "../crypto/session";
import { required } from "./protectedObjects";
import type { DataDocument } from "./runtime/model";
import type { RowProjection } from "./runtime/rows";
import { TOOL_MODEL, type ToolPart } from "./toolData";

export type ToolReturns = ReadonlyMap<string, ResourceCommand>;
const verifiedReturns = new WeakMap<UnlockedAccount, Map<string, ResourceCommand>>();

/** Only the already opened booking, pointer or project projection supplies a
 * verification key. Keep the lookup batched and validate every match locally. */
export async function loadToolReturns(
  client: Client,
  keys: Iterable<string | undefined>,
  signal: AbortSignal,
): Promise<ToolReturns> {
  const selected = [...new Set(keys)].filter(
    (key): key is string => key !== undefined,
  );
  if (selected.length === 0) return new Map();

  const { account, live } = captureAccountScope(signal);
  const cached = verifiedReturns.get(account) ?? new Map<string, ResourceCommand>();
  verifiedReturns.set(account, cached);
  const result = new Map<string, ResourceCommand>();
  const missing = selected.filter((key) => {
    const command = cached.get(key);
    if (!command) return true;
    result.set(key, command);
    return false;
  });
  const groups = [...arrayBatches(missing, 64)];

  await mapConcurrent(groups, 4, async (verificationKeys) => {
    live();
    const commands = await required(
      client.query("zerotrust.toolReturns.lookup", { verificationKeys }, {
        strategy: "network-only",
      }),
    );
    live();
    if (!Array.isArray(commands) || commands.length !== verificationKeys.length)
      throw new InvalidProtectedData();
    await mapConcurrent(verificationKeys, 16, async (key, index) => {
      const command = commands[index];
      if (command === null) return;
      if (!command || command.verificationKey !== key)
        throw new InvalidProtectedData();
      const verified = await verifyResourceCommand(command, {
        tenant: account.tenant,
        purpose: TOOL_RETURN_PURPOSE,
        binding: await resourceCommandBinding(key),
      });
      live();
      cached.set(key, verified);
      result.set(key, verified);
    });
  });
  live();
  return result;
}

function trackingPart(document: DataDocument<unknown>): ToolPart | undefined {
  if (document.model !== TOOL_MODEL || document.area.facet !== "master-data")
    return;
  const part = document.value as ToolPart;
  if (part.namespace === "tool-tracking" && !part.deleted) return part;
}

/** The local uniqueness constraint applies to effective checkouts. Derived
 * fields are read-only and never become part of a later ciphertext write. */
export async function loadToolReturnProjection(
  client: Client,
  documents: readonly DataDocument<unknown>[],
  signal: AbortSignal,
): Promise<RowProjection | undefined> {
  const keys: string[] = [];
  for (const document of documents) {
    const part = trackingPart(document);
    if (part?.returnKey && part.rows[0]?.values.ended_at === null)
      keys.push(part.returnKey.verificationKey);
  }
  const returned = await loadToolReturns(client, keys, signal);
  if (returned.size === 0) return;
  return (document, source) => {
    if (source.table !== "tool_trackings" || source.values.ended_at !== null)
      return source;
    const key = trackingPart(document)?.returnKey?.verificationKey;
    const startedAt = new Date(source.values.started_at as string);
    const endedAt = toolReturnDate(returned, key, startedAt);
    if (!endedAt) return source;
    const fields = { ...source.fields };
    delete fields.ended_at;
    return {
      ...source,
      fields,
      values: {
        ...source.values,
        ended_at: endedAt.toISOString(),
      },
    };
  };
}

export function toolReturnDate(
  returned: ToolReturns,
  key: string | undefined,
  startedAt: Date,
): Date | null {
  const command = key === undefined ? undefined : returned.get(key);
  if (command === undefined) return null;
  // The signed time comes from the member's browser. Clock skew cannot
  // turn a valid proof into a negative booking duration.
  return new Date(Math.max(Number(command.issuedAt), startedAt.getTime()));
}
