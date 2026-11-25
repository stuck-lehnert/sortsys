import type { Client, MutateInput } from "@sortsys/v2-client";
import { arrayBatches, mapConcurrent } from "@sortsys/zerotrust";
import {
  InvalidProtectedData,
  type HistoryOrigin,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import {
  protectedCollection,
  protectedCollections,
  type Collection,
  type OpenedObject,
} from "./protectedObjects";
import { migrationOriginAttester } from "../crypto/migrationOrigin";
import { commitProtectedWrites, type PreparedWrites } from "./atomicWrites";

type SourceRow = { id: string; value: unknown };
type DecodeCopy = (input: unknown, object: string) => unknown;
type AttestCopy = Awaited<ReturnType<typeof migrationOriginAttester>>;

/** Open the migration authority only when there is a packet to sign. */
export function lazyCopyAttester(
  client: Client,
  signal: AbortSignal,
): AttestCopy {
  let opening: ReturnType<typeof migrationOriginAttester> | undefined;
  return async (packet, origin) => {
    const attest = await (opening ??= migrationOriginAttester(client, signal));
    return attest(packet, origin);
  };
}

type SingletonCopy = {
  area: Collection;
  row: SourceRow;
  validate: DecodeCopy;
  partial?: boolean;
  attest?: AttestCopy;
};

/** Copy independent one-row areas in access pages. Each changed area keeps
 * its own guarded head and is confirmed against the signed packet and source. */
export async function copyProtectedSingletons(
  client: Client,
  entries: readonly SingletonCopy[],
  signal: AbortSignal,
  open?: Awaited<ReturnType<typeof protectedCollections>>,
) {
  if (!entries.length) return;

  if (new Set(entries.map(({ area }) => area.domain)).size !== entries.length)
    throw new InvalidProtectedData();

  signal.throwIfAborted();
  const target = open ?? (await protectedCollections(client, signal));
  const defaultAttest = lazyCopyAttester(client, signal);

  for (const page of arrayBatches(entries, 16)) {
    signal.throwIfAborted();

    const requests = page.map(({ area, row, partial }) => ({
      area: partial ? { ...area, prefix: row.id } : area,
    }));
    await target.prefetch(requests);

    const opened: ReturnType<typeof target>[] = [];
    try {
      const prepared = await mapConcurrent(page, 4, async (entry, index) => {
        const { area, row, validate, partial = false, attest = defaultAttest } =
          entry;
        const request = requests[index]!;

        signal.throwIfAborted();
        const collection = target(area);
        opened.push(collection);

        const expected = expectedCopies([row], validate);
        const existing = await collection.read(request.area.prefix);
        signal.throwIfAborted();

        if (matchingCopies(existing, expected, validate, partial).has(row.id))
          return;

        const packet = await attest(await collection.packet(row.id, row.value));
        return { request, collection, packet, expected, validate, partial };
      });
      const pending = prepared.filter((copy) => copy !== undefined);
      if (!pending.length) continue;

      let confirming: Promise<void> | undefined;
      const groups: PreparedWrites[] = pending.map((copy) => ({
        packets: [copy.packet],
        head: {
          domain: copy.request.area.domain,
          sequence: copy.collection.snapshot(),
        },
        async verify() {
          confirming ??= target.prefetch(pending.map(({ request }) => request));
          await confirming;

          const saved = await copy.collection.read(copy.request.area.prefix);
          signal.throwIfAborted();

          const matched = matchingCopies(
            saved,
            copy.expected,
            copy.validate,
            copy.partial,
          );
          return matched.size === 1 && hasPackets(saved, [copy.packet]);
        },
        close() {}, // The page owns the collection until verification ends.
      }));

      await commitProtectedWrites(client, groups, signal);
    } finally {
      for (const collection of opened) collection.close();
    }
  }
}

function expectedCopies(rows: readonly SourceRow[], validate: DecodeCopy) {
  return new Map(
    rows.map(({ id, value }) => [id, JSON.stringify(validate(value, id))]),
  );
}

function matchingCopies(
  items: readonly OpenedObject[],
  expected: ReadonlyMap<string, string | undefined>,
  validate: DecodeCopy,
  partial: boolean,
): Set<string> {
  const matched = new Set<string>();
  for (const { envelope, value } of items) {
    const id = envelope.object;
    if (partial && !expected.has(id)) continue;
    if (
      !expected.has(id) ||
      matched.has(id) ||
      expected.get(id) !== JSON.stringify(validate(value, id))
    )
      throw new InvalidProtectedData();

    matched.add(id);
  }
  return matched;
}

function hasPackets(
  saved: readonly OpenedObject[],
  packets: PreparedWrites["packets"],
) {
  return packets.every(({ envelope }) =>
    saved.some(
      ({ envelope: actual }) =>
        actual.object === envelope.object &&
        actual.signature === envelope.signature,
    ),
  );
}

/** Resumable conversion from the verified source archive. Exact existing
 * objects are accepted; a changed source or destination is never overwritten. */
export async function copyProtectedCollection(
  client: Client,
  collection: Collection,
  rows: readonly SourceRow[],
  validate: DecodeCopy,
  signal: AbortSignal,
  partial = false,
  open?: (
    collection: Collection,
  ) => Awaited<ReturnType<typeof protectedCollection>>,
  history?: (value: unknown, id: string) => HistoryOrigin,
): Promise<void> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    if (signal.aborted || unlockedAccount() !== account)
      throw new InvalidProtectedData();
  };
  const target = open
    ? open(collection)
    : await protectedCollection(client, collection, signal);
  try {
    const expected = expectedCopies(rows, validate);
    const prefix =
      partial && rows.length === 1 ? rows[0]!.id : collection.prefix;
    const existing = await target.read(prefix);
    live();
    const done = matchingCopies(existing, expected, validate, partial);
    if (done.size === expected.size) return;

    let packets: MutateInput<"zerotrust.objects.save">[] = [],
      size = 0;
    let attest: AttestCopy | undefined;
    async function flush() {
      if (!packets.length) return;
      live();
      const pending = packets;
      await commitProtectedWrites(
        client,
        [
          {
            packets: pending,
            head: { domain: collection.domain, sequence: target.snapshot() },
            async verify() {
              const saved = await target.selected(
                pending.map((packet) => packet.envelope.object),
              );
              live();
              return saved.length === pending.length && hasPackets(saved, pending);
            },
            close() {}, // The complete copy owns this collection across its batches.
          },
        ],
        signal,
      );
      await target.inspect();
      live();
      packets = [];
      size = 0;
    }
    for (const row of rows) {
      live();
      if (done.has(row.id)) continue;
      attest ??= await migrationOriginAttester(client, signal);
      const packet = await attest(
        await target.packet(row.id, row.value),
        history?.(row.value, row.id),
      );
      if (
        packets.length >= 16 ||
        size + packet.envelope.ciphertext.length > 24 * 1024 * 1024
      )
        await flush();
      packets.push(packet);
      size += packet.envelope.ciphertext.length;
    }
    await flush();
    const verified = await target.read(prefix);
    live();
    if (
      matchingCopies(verified, expected, validate, partial).size !== expected.size
    )
      throw new InvalidProtectedData();
  } finally {
    target.close();
  }
}
