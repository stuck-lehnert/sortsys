import type { Client, MutateInput } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import {
  protectedCollection,
  protectedCollections,
  type Collection,
  type OpenedObject,
} from "./protectedObjects";
import { migrationOriginAttester } from "../crypto/migrationOrigin";
import { commitProtectedWrites, type PreparedWrites } from "./atomicWrites";
import { prepareOwnerCollections } from "./prepareCollections";
import { mapConcurrent } from "./runtime/concurrentReads";

type SourceRow = { id: string; value: unknown };
type DecodeCopy = (input: unknown, object: string) => unknown;
type AttestCopy = Awaited<ReturnType<typeof migrationOriginAttester>>;

/** Open the verified source only if a copy adds a packet. The CAS still
 * checks the pending setup and current authority for each publication. */
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

// access.snapshot accepts up to sixteen selected domains in one request.
const SMALL_COLLECTION_PAGE_SIZE = 16;
const SMALL_COLLECTION_MAX_ROWS = 2;

type SmallCollectionCopy = {
  area: Collection;
  rows: readonly SourceRow[];
  validate: DecodeCopy;
  attest?: AttestCopy;
  partial?: boolean;
};

function copyDomains(entries: readonly SmallCollectionCopy[]): string[] {
  const domains = entries.map(({ area }) => area.domain);
  if (new Set(domains).size !== domains.length) throw new InvalidProtectedData();

  return domains;
}

export type SingletonCopy = Omit<SmallCollectionCopy, "rows"> & {
  row: SourceRow;
};

function copyPage({ area, rows, partial }: SmallCollectionCopy) {
  return {
    area: partial && rows.length === 1 ? { ...area, prefix: rows[0]!.id } : area,
  };
}

export async function copyOwnedAreas(
  client: Client,
  subject: string,
  entries: readonly Omit<SmallCollectionCopy, "partial">[],
  signal: AbortSignal,
) {
  await prepareOwnerCollections(
    client,
    subject,
    entries.map(({ area }) => area),
    signal,
  );
  await copyProtectedAreas(client, entries, signal);
}

export function copyProtectedSingletons(
  client: Client,
  entries: readonly SingletonCopy[],
  signal: AbortSignal,
  open?: Awaited<ReturnType<typeof protectedCollections>>,
) {
  return copySmallProtectedCollections(
    client,
    entries.map(({ row, ...entry }) => ({ ...entry, rows: [row] })),
    signal,
    open,
  );
}

/** Reuse the verified access context for a group of complete migrations.
 * Small areas share pages; larger areas keep their normal bounded copier. */
export async function copyProtectedAreas(
  client: Client,
  entries: readonly Omit<SmallCollectionCopy, "partial">[],
  signal: AbortSignal,
  open?: Awaited<ReturnType<typeof protectedCollections>>,
) {
  if (!entries.length) return;

  const domains = copyDomains(entries);
  const selection =
    domains.length <= SMALL_COLLECTION_PAGE_SIZE ? domains : undefined;
  open ??= await protectedCollections(client, signal, selection);

  const defaultAttest = lazyCopyAttester(client, signal);
  const copies = entries.map((entry) =>
    entry.attest ? entry : { ...entry, attest: defaultAttest },
  );
  await copySmallProtectedCollections(
    client,
    copies.filter(({ rows }) => rows.length <= SMALL_COLLECTION_MAX_ROWS),
    signal,
    open,
  );

  for (const { area, rows, validate, attest } of copies) {
    if (rows.length <= SMALL_COLLECTION_MAX_ROWS) continue;

    await copyProtectedCollection(
      client,
      area,
      rows,
      validate,
      signal,
      false,
      open,
      attest,
    );
  }
}

/** Verify or publish up to sixteen areas of at most two objects per page.
 * An empty source area must still have an empty target. Each written area
 * keeps its own guarded head, verification and immutable migration origin.
 * At most four areas are prepared or verified concurrently. */
export async function copySmallProtectedCollections(
  client: Client,
  entries: readonly SmallCollectionCopy[],
  signal: AbortSignal,
  open?: Awaited<ReturnType<typeof protectedCollections>>,
) {
  if (!entries.length) return;

  copyDomains(entries);
  if (
    entries.some(
      ({ rows, partial }) =>
        (partial && rows.length === 0) ||
        rows.length > SMALL_COLLECTION_MAX_ROWS ||
        new Set(rows.map(({ id }) => id)).size !== rows.length,
    )
  )
    throw new InvalidProtectedData();

  signal.throwIfAborted();
  open ??= await protectedCollections(client, signal);
  const defaultAttest = lazyCopyAttester(client, signal);

  for (
    let offset = 0;
    offset < entries.length;
    offset += SMALL_COLLECTION_PAGE_SIZE
  ) {
    signal.throwIfAborted();
    const page = entries.slice(offset, offset + SMALL_COLLECTION_PAGE_SIZE);

    await open.prefetch(page.map(copyPage));
    await copySmallBatch(client, page, signal, open, defaultAttest);
  }
}

async function copySmallBatch(
  client: Client,
  entries: readonly SmallCollectionCopy[],
  signal: AbortSignal,
  open: Awaited<ReturnType<typeof protectedCollections>>,
  defaultAttest: AttestCopy,
) {
  const targets: ReturnType<typeof open>[] = [];

  try {
    const copies = await mapConcurrent(
      entries,
      4,
      async (entry) => {
        const { area, rows, validate, attest = defaultAttest, partial = false } =
          entry;
        const page = copyPage(entry);
        signal.throwIfAborted();
        const target = open(area);
        targets.push(target);

        const expected = new Map(
          rows.map(({ id, value }) => [id, JSON.stringify(validate(value, id))]),
        );
        const existing = await target.read(page.area.prefix);
        signal.throwIfAborted();

        const done = matchingCopies(existing, expected, validate, partial);
        if (done.size === expected.size) return;

        const packets: PreparedWrites["packets"] = [];
        for (const row of rows) {
          if (done.has(row.id)) continue;
          signal.throwIfAborted();
          packets.push(await attest(await target.packet(row.id, row.value)));
        }

        return {
          page,
          target,
          packets,
          expected,
          validate,
          partial,
          sequence: target.snapshot(),
        };
      },
    );
    const pending = copies.filter((copy) => copy !== undefined);
    if (!pending.length) return;

    let confirmation: Promise<void> | undefined;
    const groups: PreparedWrites[] = pending.map((copy) => {
      const { page, target, packets, expected, validate, partial, sequence } =
        copy;

      return {
        packets,
        head: { domain: page.area.domain, sequence },
        async verify() {
          confirmation ??= open.prefetch(pending.map(({ page }) => page));
          await confirmation;

          const saved = await target.read(page.area.prefix);
          signal.throwIfAborted();

          const matched = matchingCopies(saved, expected, validate, partial);
          return matched.size === expected.size && hasPackets(saved, packets);
        },
        close() {}, // The batch owns every opened target until confirmation ends.
      };
    });

    await commitProtectedWrites(client, groups, signal);
  } finally {
    for (const target of targets) target.close();
  }
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
    if (!expected.has(id)) {
      if (partial) continue;
      throw new InvalidProtectedData();
    }

    if (
      matched.has(id) ||
      expected.get(id) !== JSON.stringify(validate(value, id))
    ) {
      throw new InvalidProtectedData();
    }
    matched.add(id);
  }

  return matched;
}

function hasPackets(
  saved: readonly OpenedObject[],
  packets: PreparedWrites["packets"],
): boolean {
  return packets.every((packet) =>
    saved.some(
      (item) =>
        item.envelope.object === packet.envelope.object &&
        item.envelope.signature === packet.envelope.signature,
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
  attest = lazyCopyAttester(client, signal),
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
    const expected = new Map(
      rows.map((row) => [row.id, JSON.stringify(validate(row.value, row.id))]),
    );
    const prefix =
      partial && rows.length === 1 ? rows[0]!.id : collection.prefix;
    const existing = await target.read(prefix);
    live();
    const done = matchingCopies(existing, expected, validate, partial);

    // This read already verified the exact copy. Read again only after writes.
    if (done.size === expected.size) return;

    let packets: MutateInput<"zerotrust.objects.save">[] = [],
      size = 0;

    async function flush(final: boolean) {
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
              // The last confirmation checks both the exact packets and the
              // complete target in the same verified snapshot.
              const saved = final
                ? await target.read(prefix)
                : await target.selected(
                    pending.map((packet) => packet.envelope.object),
                  );
              live();
              if (final) {
                const complete = matchingCopies(
                  saved,
                  expected,
                  validate,
                  partial,
                );
                if (complete.size !== expected.size) return false;
              } else if (saved.length !== pending.length) {
                return false;
              }

              return hasPackets(saved, pending);
            },
            close() {}, // The complete copy owns this collection across its batches.
          },
        ],
        signal,
      );
      live();
      packets = [];
      size = 0;
    }
    for (const row of rows) {
      live();
      if (done.has(row.id)) continue;
      const packet = await attest(await target.packet(row.id, row.value));
      if (
        packets.length > 0 &&
        (packets.length >= 16 ||
          size + packet.envelope.ciphertext.length > 24 * 1024 * 1024)
      ) {
        await flush(false);
        // Only another write batch needs a fresh head. The final full read
        // already revalidates the resulting collection after the last batch.
        await target.inspect();
        live();
      }

      packets.push(packet);
      size += packet.envelope.ciphertext.length;
    }

    await flush(true);
  } finally {
    target.close();
  }
}
