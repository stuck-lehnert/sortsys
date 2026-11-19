import type { Client } from "@sortsys/v2-client";
import {
  activeBookingReadScope,
  InvalidProtectedData,
  policy,
  reconcilePolicyRules,
  type Policy,
  type Rule,
} from "@sortsys/zerotrust/sortsys";
import { administratorPolicyContext } from "./administration";
import { preparePolicyPublication } from "./policy";
import { finishAccessChanges } from "./accessRotations";
import { commitProtectedWrites } from "../data/atomicWrites";
import type { DuckDriver } from "../data/database";
import { publicId } from "../data/products";
import type { DataView } from "../data/runtime/runtime";
import { acquireDataRuntime } from "../data/runtime/session";
import { toolDomain, toolRequest, type ToolPart } from "../data/toolData";
import { prepareToolReturnKeys } from "../data/toolReturnKey";
import { renewToolResponsibilityOrigins } from "./renewToolResponsibilityOrigins";
import {
  replaceToolReturnKey,
  toolReturnKeyDependencies,
} from "./renewToolReturnKeys";

/** The intent targets no encryption domain. A separately verified, active
 * booking checkpoint activates read access; returning it ends that access. */
export function activeBookingIntents(
  permissions: Policy,
  bookings: readonly {
    scope: string;
    responsible: string | null;
    active: boolean;
  }[],
  certified: ReadonlySet<string>,
): Policy {
  const scopes = new Set(
    bookings.map((booking) => activeBookingReadScope(booking.scope)),
  );
  const added: Rule[] = [];
  for (const booking of bookings) {
    if (
      !booking.active ||
      booking.responsible === null ||
      !certified.has(booking.responsible)
    )
      continue;
    for (const facet of ["master-data", "scope"] as const) {
      added.push({
        subject: booking.responsible,
        scope: activeBookingReadScope(booking.scope),
        facet,
        effect: "allow",
        actions: ["read"],
      });
    }
  }
  return policy({
    ...permissions,
    version: (BigInt(permissions.version) + 1n).toString(),
    rules: reconcilePolicyRules(
      permissions.rules,
      added,
      (rule) => scopes.has(rule.scope) && rule.effect === "allow",
    ),
  });
}

function activeTracking(view: DataView, part: ToolPart): boolean {
  if (part.deleted) return false;
  const row = part.rows[0]!.values;
  if (row.responsible_user_id === null) return false;
  const tracking = view.row("tool_trackings", { id: row.id });
  return tracking.require("ended_at") === null;
}

function hasEarlierReturnKey(part: ToolPart, generation: string): boolean {
  if (!part.returnKey) return false;
  return part.returnKey.recipient.generation !== generation;
}

export async function synchronizeToolResponsibilityDefaults(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<void> {
  let context = await administratorPolicyContext(client, signal);
  let origins = new Map(context.origins.map((origin) => [origin.id, origin]));
  if (
    await renewToolResponsibilityOrigins(
      client,
      context,
      origins,
      signal,
      driver,
    )
  ) {
    context = await administratorPolicyContext(client, signal);
    origins = new Map(context.origins.map((origin) => [origin.id, origin]));
  }
  const selected = context.domains.flatMap((domain) => {
    const part = toolDomain(domain.id);
    const origin = origins.get(domain.id);
    if (
      !part ||
      part.namespace !== "tool-tracking" ||
      part.facet !== "master-data" ||
      !origin ||
      origin.assignee
    )
      return [];
    return [toolRequest("tool-tracking", part.id, "master-data")];
  });
  if (!selected.length) return;
  const previous = {
    permissions: context.permissions,
    signature: context.policySignature,
  };
  const lease = acquireDataRuntime(client, signal, driver);
  try {
    const generation = context.history.current.generation;
    const dependencies = await lease.runtime.read(selected, (view) =>
      selected.flatMap((request) => {
        if (origins.get(request.area.domain)?.access) return [];
        const booking = view.documents(request)[0]?.value;
        if (
          !booking ||
          !activeTracking(view, booking) ||
          !hasEarlierReturnKey(booking, generation)
        )
          return [];
        return toolReturnKeyDependencies(booking);
      }),
    );
    const prepared = await lease.runtime.prepare([...selected, ...dependencies], async (transaction) => {
      const bookings = [];
      const certified = new Set<string>();
      for (const request of selected) {
        const documents = transaction.documents(request);
        if (!documents.length) continue;
        if (documents.length !== 1) throw new InvalidProtectedData();
        const document = documents[0]!;
        if (document.value.deleted) continue;
        const row = document.value.rows[0]!.values;
        const responsible =
          row.responsible_user_id === null
            ? null
            : `user:${publicId(row.responsible_user_id)}`;
        let known = false;
        if (responsible !== null) {
          try {
            context.history.identityCertificate(responsible);
            certified.add(responsible);
            known = true;
          } catch (error) {
            if (!(error instanceof InvalidProtectedData)) throw error;
          }
        }
        const origin = origins.get(request.area.domain)!;
        const active = activeTracking(transaction, document.value) &&
          origin.returned === undefined;
        bookings.push({ scope: request.area.scope, responsible, active });
        if (!active || !known || origin.access) continue;
        if (!hasEarlierReturnKey(document.value, generation)) {
          // Attest the actual state with a fresh signed revision. The
          // policy publication guards the exact source of the grant.
          transaction.edit(request, document.id, () => {});
          continue;
        }
        const makeKey = await prepareToolReturnKeys(
          client,
          row.responsible_user_id as string,
          signal,
          context.history,
        );
        if (!makeKey) throw new InvalidProtectedData();
        const replacement = await makeKey(document.value.id);
        replaceToolReturnKey(transaction, request, document.value, replacement);
      }
      return activeBookingIntents(previous.permissions, bookings, certified);
    });
    try {
      const next = prepared.value;
      const changed =
        JSON.stringify(next.rules) !==
        JSON.stringify(previous.permissions.rules);
      if (
        changed ||
        prepared.groups.some((group) => group.packets.length > 0)
      ) {
        await commitProtectedWrites(
          client,
          prepared.groups,
          signal,
          prepared.guards,
          changed
            ? {
                policy: preparePolicyPublication(
                  client,
                  { ...context, author: context.account.vault.subject },
                  previous,
                  next,
                ),
              }
            : {},
        );
      }
    } finally {
      prepared.close();
    }
  } finally {
    lease.close();
  }
  context.live();
  await finishAccessChanges(
    client,
    signal,
    selected.flatMap((request) => [
      request.area.domain,
      `${request.area.scope}:scope`,
    ]),
  );
}
