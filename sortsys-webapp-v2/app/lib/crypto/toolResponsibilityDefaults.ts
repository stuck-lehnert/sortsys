import type { Client } from "@sortsys/v2-client";
import {
  activeBookingReadScope,
  InvalidProtectedData,
  policy,
  reconcilePolicyRules,
  type Policy,
  type Rule,
  type CreationOrigin,
} from "@sortsys/zerotrust/sortsys";
import { administratorPolicyContext } from "./administration";
import { preparePolicyPublication } from "./policy";
import { finishAccessChanges } from "./accessRotations";
import { commitProtectedWrites } from "../data/atomicWrites";
import type { DuckDriver } from "../data/database";
import { publicId } from "../data/products";
import { acquireDataRuntime } from "../data/runtime/session";
import { toolDomain, toolRequest } from "../data/toolData";

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

export async function synchronizeToolResponsibilityDefaults(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<void> {
  const context = await administratorPolicyContext(client, signal);
  const origins = new Map<string, CreationOrigin>();
  // The verified inventory owns both the actual domains and their current
  // creation proofs. No public identifier or server role supplies a data key.
  const { verifiedAccessContext } = await import("./accessContext");
  const access = await verifiedAccessContext(client, signal);
  context.live();
  for (const origin of access.origins) origins.set(origin.id, origin);
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
    const prepared = await lease.runtime.prepare(selected, (transaction) => {
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
        const active = row.ended_at === null && responsible !== null;
        bookings.push({ scope: request.area.scope, responsible, active });
        const origin = origins.get(request.area.domain)!;
        if (active && known && !origin.access) {
          // An unchanged payload gets a new signed revision that attests its
          // actual state. The policy publication guards this exact source.
          transaction.edit(request, document.id, () => {});
        }
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
