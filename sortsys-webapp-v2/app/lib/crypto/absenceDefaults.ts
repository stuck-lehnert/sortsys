import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  InvalidProtectedData,
  policy,
  type Policy,
  type Rule,
} from "@sortsys/zerotrust/sortsys";
import { absenceCollection } from "../data/absenceData";
import { addressId } from "../data/addressBook";
import {
  commitProtectedWrites,
  ProtectedWriteConflict,
} from "../data/atomicWrites";
import type { DuckDriver } from "../data/database";
import { ORGANIZATION_COLLECTION } from "../data/organizationData";
import {
  personnelCollection,
  personnelDomain,
  personnelRequest,
} from "../data/personnelData";
import { provisionOwnedCollections } from "../data/prepareCollections";
import { publicId } from "../data/products";
import type { DataRequest, DataView } from "../data/runtime/runtime";
import { acquireDataRuntime } from "../data/runtime/session";
import {
  defaultSupervisor,
  supervisorSettingsRequest,
} from "../data/supervisorSettingsData";
import { administratorPolicyContext } from "./administration";
import { finishAccessChanges } from "./permissions";
import { preparePolicyPublication } from "./policy";

export type AbsencePerson = {
  id: string;
  contractType: "internal" | "external" | "subcontractor";
  supervisorUserId: string | null;
};

function firstSupervisor(
  person: AbsencePerson,
  fallback: string | null,
): string | null {
  if (person.supervisorUserId !== null) return person.supervisorUserId;
  if (person.contractType !== "internal" || person.id === fallback) return null;
  return fallback;
}

/** Defaults are signed grants, never authority inferred from an API role or
 * from a missing HR fragment. Explicit grants and vetoes keep their provenance. */
export function absenceDefaultRules(
  people: readonly AbsencePerson[],
  certified: ReadonlySet<string>,
  fallback: string | null = null,
): Rule[] {
  const users = new Map<string, AbsencePerson>();
  const rules = new Map<string, Rule>();
  for (const person of people) {
    addressId(person.id);
    if (person.supervisorUserId !== null) addressId(person.supervisorUserId);
    if (
      users.has(person.id) ||
      !["internal", "external", "subcontractor"].includes(person.contractType)
    ) {
      throw new InvalidProtectedData();
    }
    users.set(person.id, person);
  }
  if (fallback !== null && !users.has(fallback))
    throw new InvalidProtectedData();

  function add(
    user: string,
    area: { scope: string; facet: Rule["facet"] },
    actions: Rule["actions"],
  ) {
    if (!certified.has(user)) return;
    const key = `${user}\0${area.scope}\0${area.facet}`;
    const previous = rules.get(key);
    rules.set(key, {
      subject: `user:${user}`,
      scope: area.scope,
      facet: area.facet,
      effect: "allow",
      origin: "absence-default",
      actions: ACTIONS.filter(
        (action) =>
          actions.includes(action) || previous?.actions.includes(action),
      ),
    });
  }

  for (const person of people) {
    let supervisor = firstSupervisor(person, fallback);
    const automatic = person.contractType !== "internal" || supervisor === null;
    add(person.id, absenceCollection(person.id), ["read", "create", "delete"]);
    add(
      person.id,
      absenceCollection(person.id, true),
      automatic ? ["read", "approve"] : ["read"],
    );
    add(person.id, personnelCollection(person.id, "scope"), ["read"]);
    const seen = new Set([person.id]);
    while (supervisor !== null) {
      if (seen.has(supervisor) || seen.size > 120)
        throw new InvalidProtectedData();
      seen.add(supervisor);
      const ancestor = users.get(supervisor);
      if (!ancestor) throw new InvalidProtectedData();
      add(supervisor, absenceCollection(person.id), ["read"]);
      add(supervisor, absenceCollection(person.id, true), ["read", "approve"]);
      add(supervisor, personnelCollection(person.id, "scope"), ["read"]);
      // A configured fallback replaces a missing direct assignment; it does
      // not append itself to every explicit manager's ancestor chain.
      supervisor = ancestor.supervisorUserId;
    }
  }
  return [...rules]
    .sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    })
    .map(([, value]) => value);
}

export function withAbsenceDefaults(
  current: Policy,
  people: readonly AbsencePerson[],
  certified: ReadonlySet<string>,
  fallback: string | null = null,
): Policy {
  return policy({
    ...current,
    version: (BigInt(current.version) + 1n).toString(),
    rules: [
      ...current.rules.filter((rule) => rule.origin !== "absence-default"),
      ...absenceDefaultRules(people, certified, fallback),
    ],
  });
}

/** Personnel inventory and its policy must belong to one verified snapshot.
 * Provisioning a missing area changes that snapshot, so read it again before
 * deriving either supervision defaults or deletion prerequisites. */
async function absencePrerequisites(client: Client, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const context = await administratorPolicyContext(client, signal);
    const directory = context.domains;
    const ids = directory
      .map((area) => personnelDomain(area.id))
      .filter((part) => part?.facet === "master-data")
      .map((part) => part!.id);
    const known = new Set(directory.map((area) => area.id));
    const missing = ids
      .flatMap((id) => [absenceCollection(id), absenceCollection(id, true)])
      .filter((area) => !known.has(area.domain));
    if (!missing.length) return { context, ids, known };
    await provisionOwnedCollections(
      client,
      `user:${context.session.user.id}`,
      missing,
      signal,
    );
    context.live();
  }
  throw new ProtectedWriteConflict();
}

export async function absenceDefaultPlan(client: Client, signal: AbortSignal) {
  const { context, ids, known } = await absencePrerequisites(client, signal);
  const previous = {
    permissions: context.permissions,
    signature: context.policySignature,
  };
  const selected: DataRequest[] = ids.flatMap((id) => [
    personnelRequest(id, "master-data"),
    personnelRequest(id, "scope"),
  ]);
  // Initial account provisioning can precede organization-domain creation.
  // Once present, its setting is a mandatory guarded read, even when empty.
  const hasOrganization = known.has(ORGANIZATION_COLLECTION.domain);
  if (hasOrganization) selected.push(supervisorSettingsRequest);

  return {
    selected,
    policySignature: previous.signature,
    inventorySnapshot: context.inventorySnapshot,
    next(view: DataView) {
      context.live();
      const people: AbsencePerson[] = [];
      const certified = new Set<string>();
      for (const id of ids) {
        const names = view.documents(personnelRequest(id, "master-data"));
        const details = view.documents(personnelRequest(id, "scope"));
        if (!names.length && !details.length) continue;
        if (names.length !== 1 || details.length !== 1)
          throw new InvalidProtectedData();
        const values = view
          .row("users", { id: addressId(id) })
          .pick(["contract_type", "supervisor_user_id"]);
        people.push({
          id,
          contractType: values.contract_type as AbsencePerson["contractType"],
          supervisorUserId:
            values.supervisor_user_id === null
              ? null
              : publicId(values.supervisor_user_id),
        });
        try {
          context.history.identityCertificate(`user:${id}`);
          certified.add(id);
        } catch {
          // Pending invitations receive defaults after identity approval.
        }
      }
      const fallback = hasOrganization ? defaultSupervisor(view) : null;
      return withAbsenceDefaults(
        previous.permissions,
        people,
        certified,
        fallback,
      );
    },
    publication(next: Policy) {
      return preparePolicyPublication(
        client,
        { ...context, author: `user:${context.session.user.id}` },
        previous,
        next,
      );
    },
    changed(next: Policy) {
      return (
        JSON.stringify(next.rules) !==
        JSON.stringify(previous.permissions.rules)
      );
    },
  };
}

export async function synchronizeAbsenceDefaults(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<void> {
  const plan = await absenceDefaultPlan(client, signal);
  const lease = acquireDataRuntime(client, signal, driver);
  try {
    const prepared = await lease.runtime.prepare(plan.selected, (transaction) =>
      plan.next(transaction),
    );
    try {
      if (plan.changed(prepared.value)) {
        await commitProtectedWrites(
          client,
          prepared.groups,
          signal,
          prepared.guards,
          { policy: plan.publication(prepared.value) },
        );
      }
    } finally {
      prepared.close();
    }
  } finally {
    lease.close();
  }
  await finishAccessChanges(client, signal);
}
