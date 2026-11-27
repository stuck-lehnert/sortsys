import type { Client, MutateInput, QueryResult } from "@sortsys/v2-client";
import {
  frame,
  identifier,
  InvalidProtectedData,
  revision,
  sign,
  signPolicy,
  sized,
  verify,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "../data/addressBook";
import { administratorContext } from "./administration";
import { readVerifiedPolicy } from "./policy";
import { timestampFromMicros, timestampMicros } from "../data/timestamps";
import type { MemberPublication } from "../data/atomicWrites";
import { required } from "../protectedResult";

type Creation = MutateInput<"zerotrust.members.create">;
type MemberChange = NonNullable<
  MutateInput<"zerotrust.objects.batch">["member"]
>;
export type MemberAction = MemberChange["action"];
export type MemberStatus = {
  id: string;
  username: string;
  version: string;
  at: string;
  deactivatedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
};
export function decodeMemberStatus(
  input: QueryResult<"zerotrust.members.status">,
): MemberStatus {
  addressId(input.id);
  technicalUsername(input.username);
  sized(input.version, 32);
  return {
    id: input.id,
    username: input.username,
    version: input.version,
    at: timestampFromMicros(input.atMicros),
    deactivatedAt:
      input.deactivatedMicros === null
        ? null
        : timestampFromMicros(input.deactivatedMicros),
    archivedAt:
      input.archivedMicros === null
        ? null
        : timestampFromMicros(input.archivedMicros),
    deletedAt:
      input.deletedMicros === null
        ? null
        : timestampFromMicros(input.deletedMicros),
  };
}
export function memberChangeFrame(change: Omit<MemberChange, "proof">) {
  for (const value of [change.tenant, change.author, change.requestId])
    identifier(value);
  addressId(change.id);
  revision(change.generation);
  sized(change.expected, 32);
  sized(change.packetSignature, 64);
  timestampFromMicros(change.atMicros);
  if (
    ![
      "activate",
      "deactivate",
      "archive",
      "unarchive",
      "rename",
      "delete",
    ].includes(change.action)
  )
    throw new InvalidProtectedData();
  if (change.action === "rename") technicalUsername(change.username);
  else if (change.username !== undefined) throw new InvalidProtectedData();
  if (change.action === "delete") sized(change.inventorySnapshot ?? "", 32);
  else if (change.inventorySnapshot !== undefined)
    throw new InvalidProtectedData();
  return frame("sortsys/member-change/v3", [
    change.tenant,
    change.generation,
    change.author,
    change.id,
    change.action,
    change.username ?? "",
    change.inventorySnapshot ?? "",
    change.requestId,
    change.expected,
    change.atMicros,
    change.packetSignature,
    change.permissions?.signature ?? "",
  ]);
}
export function memberStateAfter(status: MemberStatus, action: MemberAction) {
  timestampMicros(status.at);
  if (status.deletedAt !== null) throw new InvalidProtectedData();
  for (const value of [status.deactivatedAt, status.archivedAt])
    if (value !== null) timestampMicros(value);
  switch (action) {
    case "delete":
      return {
        deactivated_at: status.deactivatedAt ?? status.at,
        archived_at: status.archivedAt ?? status.at,
      };
    case "rename":
      return {
        deactivated_at: status.deactivatedAt,
        archived_at: status.archivedAt,
      };
    case "activate":
      return { deactivated_at: null, archived_at: null };
    case "deactivate":
      return {
        deactivated_at:
          status.deactivatedAt !== null &&
          timestampMicros(status.deactivatedAt) <= timestampMicros(status.at)
            ? status.deactivatedAt
            : status.at,
        archived_at: status.archivedAt,
      };
    case "archive":
      if (
        status.deactivatedAt === null ||
        timestampMicros(status.deactivatedAt) > timestampMicros(status.at)
      )
        throw new InvalidProtectedData();
      return {
        deactivated_at: status.deactivatedAt,
        archived_at: status.archivedAt ?? status.at,
      };
    case "unarchive":
      return { deactivated_at: status.deactivatedAt, archived_at: null };
  }
}
export async function memberLifecycle(
  client: Client,
  id: string,
  action: MemberAction,
  signal: AbortSignal,
  username?: string,
) {
  addressId(id);
  if (action === "rename") technicalUsername(username);
  else if (username !== undefined) throw new InvalidProtectedData();
  const context = await administratorContext(client, signal);
  if (id === context.session.user.id && action !== "rename")
    throw new InvalidProtectedData();
  const [{ permissions, signature: policySignature }, wireStatus] =
    await Promise.all([
      readVerifiedPolicy(client, context),
      required(
        client.query(
          "zerotrust.members.status",
          { id },
          { strategy: "network-only" },
        ),
      ),
    ]);
  context.live();
  const status = decodeMemberStatus(wireStatus);
  if (status.id !== id) throw new InvalidProtectedData();
  sized(status.version, 32);
  const values = memberStateAfter(status, action),
    subject = `user:${id}`;
  const suspended = permissions.suspended?.includes(subject) === true;
  const same =
    values.deactivated_at === status.deactivatedAt &&
    values.archived_at === status.archivedAt &&
    (action !== "rename" || username === status.username);
  let unchanged = same;
  if (action === "delete") unchanged = false;
  else if (action === "deactivate") unchanged = same && suspended;
  else if (action === "activate") unchanged = same && !suspended;
  return {
    status,
    values,
    unchanged,
    policySignature,
    async publication(
      packet: MutateInput<"zerotrust.objects.save">,
      options: { inventorySnapshot?: string } = {},
    ): Promise<MemberPublication> {
      context.live();
      const inventorySnapshot = options.inventorySnapshot;
      if (action === "delete") sized(inventorySnapshot ?? "", 32);
      else if (inventorySnapshot !== undefined)
        throw new InvalidProtectedData();
      if (
        packet.domain !== `personnel:${id}:master-data` ||
        packet.envelope.object !== `personnel:${id}:master-data:record` ||
        packet.envelope.policyVersion !== permissions.version
      )
        throw new InvalidProtectedData();
      const blocked = (permissions.suspended ?? []).filter(
        (member) => member !== subject,
      );
      if (action === "deactivate" || action === "delete") {
        blocked.push(subject);
        blocked.sort();
      }
      const next =
        action === "activate" || action === "deactivate" || action === "delete"
          ? await signPolicy(
              {
                ...permissions,
                version: (BigInt(permissions.version) + 1n).toString(),
                suspended: blocked,
              },
              context.authority,
            )
          : undefined;
      const draft: Omit<MemberChange, "proof"> = {
        tenant: context.account.tenant,
        generation: context.history.current.generation,
        author: `user:${context.session.user.id}`,
        id,
        action,
        ...(action === "rename" ? { username } : {}),
        ...(action === "delete" ? { inventorySnapshot } : {}),
        requestId: crypto.randomUUID(),
        expected: status.version,
        atMicros: wireStatus.atMicros,
        packetSignature: packet.envelope.signature,
        ...(next ? { permissions: next } : {}),
      };
      const change: MemberChange = {
        ...draft,
        proof: await sign(context.authority, memberChangeFrame(draft)),
      };
      context.live();
      return {
        change,
        async verify() {
          context.live();
          const [saved, error] = await client.query(
            "zerotrust.members.changeReceipt",
            { requestId: change.requestId },
            { strategy: "network-only" },
          );
          context.live();
          if (error) throw error;
          if (
            !saved ||
            Object.keys(saved).length !== Object.keys(change).length ||
            Object.entries(change).some(([key, value]) =>
              key === "permissions"
                ? saved.permissions?.signature !== next?.signature
                : saved[key as keyof MemberChange] !== value,
            )
          )
            return false;
          if (saved.permissions)
            await verifyPolicy(saved.permissions, {
              tenant: context.account.tenant,
              authority: context.history.authority(draft.generation),
            });
          const { proof, ...unsigned } = saved;
          await verify(
            context.history.authority(draft.generation),
            proof,
            memberChangeFrame(unsigned),
          );
          context.live();
          if (next) {
            const current = await readVerifiedPolicy(client, context);
            if (
              BigInt(current.permissions.version) < BigInt(next.version) ||
              (current.permissions.suspended?.includes(subject) === true) !==
                (action === "deactivate" || action === "delete")
            )
              return false;
          }
          return true;
        },
      };
    },
  };
}
export function technicalUsername(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 63 ||
    !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(input)
  ) {
    throw new InvalidProtectedData();
  }
  return input;
}

export function memberCreationFrame(input: Omit<Creation, "proof">) {
  addressId(input.id);
  technicalUsername(input.username);
  const fields = [
    input.tenant,
    input.generation,
    input.author,
    input.id,
    input.username,
  ];
  if (input.source) {
    const source = input.source;
    identifier(source.context);
    if (
      !source.context.startsWith("backup:") ||
      !["de", "en"].includes(source.locale) ||
      (source.archivedMicros !== null && source.deactivatedMicros === null)
    )
      throw new InvalidProtectedData();
    for (const value of [
      source.createdMicros,
      source.modifiedMicros,
      source.deactivatedMicros,
      source.archivedMicros,
    ]) {
      if (value !== null) timestampFromMicros(value);
    }
    fields.push(
      source.context,
      source.locale,
      source.createdMicros,
      source.modifiedMicros,
      source.deactivatedMicros ?? "",
      source.archivedMicros ?? "",
    );
    return frame("sortsys/member-create-from-backup/v1", fields);
  }
  return frame("sortsys/member-create/v1", fields);
}

/** A reservation contains technical metadata only. Always verify its exact
 * signed readback, including after a positive or lost acknowledgement. */
export async function createMemberAccount(
  client: Client,
  id: string,
  username: string,
  signal: AbortSignal,
) {
  const context = await administratorContext(client, signal);
  const draft = {
    tenant: context.account.tenant,
    generation: context.history.current.generation,
    author: `user:${context.session.user.id}`,
    id,
    username,
  };
  const request: Creation = {
    ...draft,
    proof: await sign(context.authority, memberCreationFrame(draft)),
  };
  context.live();
  let failure: unknown;
  try {
    const [, error] = await client.mutate("zerotrust.members.create", request);
    failure = error;
  } catch (error) {
    failure = error;
  }
  context.live();
  try {
    const [saved, error] = await client.query(
      "zerotrust.members.creation",
      { id },
      { strategy: "network-only" },
    );
    context.live();
    if (error) throw error;
    const rawDate: unknown = saved?.createdAt,
      createdAt =
        rawDate instanceof Date
          ? rawDate
          : typeof rawDate === "string"
            ? new Date(rawDate)
            : null;
    if (
      !saved ||
      Object.keys(saved.creation).length !== Object.keys(request).length ||
      Object.entries(request).some(
        ([name, value]) => saved.creation[name as keyof Creation] !== value,
      ) ||
      !createdAt ||
      !Number.isFinite(createdAt.getTime())
    )
      throw new InvalidProtectedData();
    await verify(
      context.history.authority(draft.generation),
      saved.creation.proof,
      memberCreationFrame(saved.creation),
    );
    context.live();
    // Match the new technical account's schema default, not the administrator's language.
    return {
      id,
      username,
      createdAt,
      creator: context.session.user.id,
      locale: "de" as const,
    };
  } catch (error) {
    context.live();
    throw failure ?? error;
  }
}
