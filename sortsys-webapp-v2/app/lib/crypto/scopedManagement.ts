import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  ACTIONS,
  compilePolicy,
  verifyPolicy,
  InvalidProtectedData,
  type Policy,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "./accessContext";
import { readVerifiedPolicy } from "./policy";
import { ProtectedWriteConflict } from "../data/atomicWrites";
import { required } from "../protectedResult";
import {
  accessValue,
  compileManagedAccess,
  type AccessValue,
  type ManagedAction,
} from "./accessProfiles";
import { managedArea, type ManagedArea } from "./managedAreas";

export type ManagedPermission = ManagedArea & {
  value: AccessValue;
  actions: readonly ManagedAction[];
  editable: boolean;
};

/** A UI projection, never a new grant. A delegated profile cannot preserve
 * rights beyond the manager's own checkpoint, so such targets remain locked. */
export function projectManagedPermissions(
  current: Policy,
  checkpoint: Policy,
  actor: string,
  subject: string,
  areas: readonly ManagedArea[],
): ManagedPermission[] {
  const manager = compilePolicy(checkpoint, [actor]);
  const liveManager = compilePolicy(current, [actor]);
  const recipient = compilePolicy(current, [subject]);
  const values = compileManagedAccess(current, subject);
  return areas.flatMap((descriptor) => {
    const { area } = descriptor;
    if (
      !manager.allows(area.scope, area.facet, "grant") ||
      !manager.allows(area.scope, area.facet, "read") ||
      !liveManager.allows(area.scope, area.facet, "grant") ||
      !liveManager.allows(area.scope, area.facet, "read")
    )
      return [];
    const actions = ACTIONS.filter(
      (action) =>
        action !== "grant" &&
        manager.allows(area.scope, area.facet, action) &&
        liveManager.allows(area.scope, area.facet, action),
    );
    const protectedRecipient = checkpoint.rules.some(
      (rule) =>
        rule.subject === subject &&
        rule.scope === area.scope &&
        rule.facet === area.facet &&
        rule.effect === "allow" &&
        rule.actions.includes("grant"),
    );
    const ownsStrongerRights = ACTIONS.some(
      (action) =>
        recipient.allows(area.scope, area.facet, action) &&
        !actions.includes(action),
    );
    return [
      {
        ...descriptor,
        value: accessValue(values(area)),
        actions,
        editable:
          subject !== actor && !protectedRecipient && !ownsStrongerRights,
      },
    ];
  });
}

async function managementContext(client: Client, signal: AbortSignal) {
  const context = await verifiedAccessContext(client, signal);
  const signed = await readVerifiedPolicy(client, context);
  context.live();
  if (signed.permissions.version !== context.rootPolicy.version)
    throw new ProtectedWriteConflict();
  let checkpoint = signed.permissions;
  if (signed.administration) {
    const primary = await verifyPolicy(signed.administration.root, {
      tenant: context.account.tenant,
      authority: context.history.authority(context.history.current.generation),
    });
    context.live();
    checkpoint = primary.permissions;
  }
  const areas = context.domains.flatMap((domain) => {
    const descriptor = managedArea(domain.id);
    if (!descriptor) return [];
    if (
      descriptor.area.scope !== domain.scope ||
      descriptor.area.facet !== domain.facet
    )
      throw new InvalidProtectedData();
    return [descriptor];
  });
  return { ...context, checkpoint, areas };
}

export async function readScopedManagement(
  client: Client,
  signal: AbortSignal,
) {
  const context = await managementContext(client, signal);
  // Discover areas before choosing a recipient. The self-projection is locked;
  // actual recipient protection is applied again after selection.
  const areas = projectManagedPermissions(
    context.permissions,
    context.checkpoint,
    context.subject,
    context.subject,
    context.areas,
  );
  if (!areas.length)
    return { subject: context.subject, areas: [], members: [] };
  const recipientIds = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  const first = areas[0]!.area;
  for (;;) {
    const page: QueryResult<"zerotrust.identities.recipients"> = await required(
      client.query(
        "zerotrust.identities.recipients",
        { scope: first.scope, facet: first.facet, after },
        { strategy: "network-only" },
      ),
    );
    context.live();
    if (!Array.isArray(page.rows) || page.rows.length > 64)
      throw new InvalidProtectedData();
    for (const id of page.rows) {
      if (recipientIds.has(id) || recipientIds.size >= 10000)
        throw new InvalidProtectedData();
      context.history.identityCertificate(`user:${id}`);
      recipientIds.add(id);
    }
    if (page.after === null) break;
    if (cursors.has(page.after)) throw new InvalidProtectedData();
    cursors.add(page.after);
    after = page.after;
  }
  // Names are optional encrypted business data. Server-supplied account labels
  // never identify recipients; without a readable profile the certified ID does.
  const [rows] = await client.query("users.list", {});
  context.live();
  const profiles = new Map((rows ?? []).map((person) => [person.id, person]));
  const members = [...recipientIds]
    .filter((id) => `user:${id}` !== context.subject)
    .map((id) => {
      const profile = profiles.get(id);
      return {
        id,
        username: profile?.username ?? null,
        firstName: profile?.firstName ?? null,
        lastName: profile?.lastName ?? null,
      };
    });
  return { subject: context.subject, areas, members };
}

export async function readScopedMemberPermissions(
  client: Client,
  subject: string,
  signal: AbortSignal,
) {
  const context = await managementContext(client, signal);
  const certificate = await required(
    client.query(
      "zerotrust.identities.get",
      { subject },
      { strategy: "network-only" },
    ),
  );
  context.live();
  if (
    !certificate ||
    certificate.signature !==
      context.history.identityCertificate(subject).signature
  )
    throw new InvalidProtectedData();
  return projectManagedPermissions(
    context.permissions,
    context.checkpoint,
    context.subject,
    subject,
    context.areas,
  );
}
