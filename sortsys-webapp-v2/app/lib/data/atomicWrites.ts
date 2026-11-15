import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  type DocumentHead,
} from "@sortsys/zerotrust/sortsys";
import { uiText } from "../i18n";
import { announceDataChanges } from "./runtime/changes";
import type { LivePublication } from "./liveCheckpoints";

export type PreparedWrites = {
  packets: MutateInput<"zerotrust.objects.save">[];
  head: { domain: string; sequence: string };
  verify(): Promise<boolean>;
  close(): void;
  live?: LivePublication[];
};
export type DocumentPublication = {
  head: DocumentHead;
  verify(): Promise<boolean>;
  live?: LivePublication[];
};
export type MemberPublication = {
  change: NonNullable<MutateInput<"zerotrust.objects.batch">["member"]>;
  verify(): Promise<boolean>;
};
export type PolicyPublication = {
  bind(
    packets: MutateInput<"zerotrust.objects.save">[],
    heads: PreparedWrites["head"][],
  ): Promise<NonNullable<MutateInput<"zerotrust.objects.batch">["policy"]>>;
  verify(): Promise<boolean>;
};
export type PublicationOptions = {
  live?: LivePublication[];
  documents?: DocumentPublication[];
  member?: MemberPublication;
  policy?: PolicyPublication;
};
export class ProtectedWriteConflict extends Error {
  constructor() {
    super(
      uiText(
        "Die Daten wurden zwischenzeitlich geändert. Bitte erneut versuchen.",
        "The data changed in the meantime. Please try again.",
      ),
    );
    this.name = "ProtectedWriteConflict";
  }
}

/** Independently prepared changes may write disjoint objects in the same
 * domain. They can share one commit only when they read the same domain head.
 * Verification still checks every original group after publication. */
export function mergePreparedWrites(
  groups: readonly PreparedWrites[],
): PreparedWrites[] {
  const domains = new Map<string, PreparedWrites[]>();
  const objects = new Set<string>();
  for (const group of groups) {
    const previous = domains.get(group.head.domain) ?? [];
    if (previous.length && previous[0]!.head.sequence !== group.head.sequence) {
      throw new ProtectedWriteConflict();
    }
    for (const packet of group.packets) {
      if (
        packet.domain !== group.head.domain ||
        objects.has(packet.envelope.object)
      ) {
        throw new InvalidProtectedData();
      }
      objects.add(packet.envelope.object);
    }
    previous.push(group);
    domains.set(group.head.domain, previous);
  }
  return [...domains.values()].map((parts) => ({
    head: parts[0]!.head,
    packets: parts.flatMap((part) => part.packets),
    live: parts.flatMap((part) => part.live ?? []),
    async verify() {
      for (const part of parts) {
        if (!(await part.verify())) return false;
      }
      return true;
    },
    close() {
      for (const part of parts) part.close();
    },
  }));
}
export function isWriteConflict(error: unknown): boolean {
  return (
    error instanceof ProtectedWriteConflict ||
    (!!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "CONFLICT")
  );
}
/** The server checks only public proofs, permissions and technical heads. All
 * business validation has already happened in the browser. No partial receipt
 * or partial mutation can be committed by an independently running API peer. */
export async function commitProtectedWrites(
  client: Client,
  groups: PreparedWrites[],
  signal: AbortSignal,
  guards: PreparedWrites["head"][] = [],
  publications: PublicationOptions = {},
): Promise<void> {
  try {
    await publishProtectedWrites(client, groups, signal, guards, publications);
  } finally {
    announceDataChanges(
      client,
      publications.policy
        ? undefined
        : new Set(groups.map((group) => group.head.domain)),
      publications.policy ? { revalidate: true, control: true } : undefined,
    );
  }
}
async function publishProtectedWrites(
  client: Client,
  groups: PreparedWrites[],
  signal: AbortSignal,
  guards: PreparedWrites["head"][],
  publications: PublicationOptions,
): Promise<void> {
  signal.throwIfAborted();
  const documents = publications.documents ?? [];
  const member = publications.member;
  const policy = publications.policy;
  const packets = groups.flatMap((group) => group.packets);
  const live = [
    ...(publications.live ?? []),
    ...groups.flatMap((group) => group.live ?? []),
    ...documents.flatMap((document) => document.live ?? []),
  ];
  if (
    (!packets.length && !documents.length && !policy && !live.length) ||
    documents.length > 16 ||
    new Set(documents.map((p) => p.head.id)).size !== documents.length ||
    packets.length > (documents.length ? 64 : 40_001) ||
    groups.some(
      (group) =>
        !group.packets.length ||
        group.packets.some((p) => p.domain !== group.head.domain),
    ) ||
    new Set(groups.map((group) => group.head.domain)).size !== groups.length ||
    (member && (packets.length !== 1 || documents.length !== 0)) ||
    (policy && (member || documents.length > 0))
  )
    throw new InvalidProtectedData();
  // Independently prepared commands often read one another's write areas.
  // Coalesce equal snapshots while rejecting every conflicting prerequisite.
  const snapshots = new Map<string, string>();
  for (const head of [...groups.map((group) => group.head), ...guards]) {
    const previous = snapshots.get(head.domain);
    if (previous !== undefined && previous !== head.sequence)
      throw new ProtectedWriteConflict();
    snapshots.set(head.domain, head.sequence);
  }
  const heads = [...snapshots].map(([domain, sequence]) => ({
    domain,
    sequence,
  }));
  const permissions = policy ? await policy.bind(packets, heads) : undefined;
  signal.throwIfAborted();
  let error: Error | null = null;
  if (
    !documents.length &&
    (packets.length > 64 ||
      packets.reduce(
        (sum, packet) => sum + packet.envelope.ciphertext.length,
        0,
      ) >
        24 * 1024 * 1024)
  ) {
    const parts: string[] = [];
    let chunk: typeof packets = [];
    let size = 0;
    const upload = async () => {
      signal.throwIfAborted();
      const [part, failed] = await client.mutate(
        "zerotrust.objects.stage",
        { objects: chunk },
        { signal },
      );
      signal.throwIfAborted();
      if (failed) throw failed;
      if (!part || !/^[a-f0-9]{64}$/.test(part.id))
        throw new InvalidProtectedData();
      parts.push(part.id);
      chunk = [];
      size = 0;
    };
    for (const packet of packets) {
      if (
        chunk.length &&
        (chunk.length === 64 ||
          size + packet.envelope.ciphertext.length > 16 * 1024 * 1024)
      )
        await upload();
      chunk.push(packet);
      size += packet.envelope.ciphertext.length;
    }
    if (chunk.length) await upload();
    try {
      [, error] = await client.mutate(
        "zerotrust.objects.commit",
        {
          parts,
          heads,
          liveCheckpoints: live.map((value) => value.checkpoint),
          member: member?.change,
          policy: permissions,
        },
        { signal },
      );
    } catch (failure) {
      error = failure instanceof Error ? failure : new Error(String(failure));
    }
  } else {
    try {
      [, error] = await client.mutate(
        "zerotrust.objects.batch",
        {
          objects: packets,
          heads,
          documents: documents.map((p) => p.head),
          liveCheckpoints: live.map((value) => value.checkpoint),
          ...(member ? { member: member.change } : {}),
          ...(permissions ? { policy: permissions } : {}),
        },
        { signal },
      );
    } catch (failure) {
      error = failure instanceof Error ? failure : new Error(String(failure));
    }
  }
  signal.throwIfAborted();
  await client.invalidate("zerotrust.objects.list");
  for (const publication of [
    ...groups,
    ...documents,
    ...live,
    ...(member ? [member] : []),
    ...(policy ? [policy] : []),
  ]) {
    signal.throwIfAborted();
    let accepted: boolean;
    try {
      accepted = await publication.verify();
    } catch (verificationError) {
      throw error ?? verificationError;
    }
    if (!accepted) throw error ?? new ProtectedWriteConflict();
  }
  signal.throwIfAborted();
}
