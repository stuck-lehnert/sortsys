import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  type HistoryOrigin,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { protectedCollection, type Collection } from "./protectedObjects";
import { migrationOriginAttester } from "../crypto/migrationOrigin";
import { commitProtectedWrites } from "./atomicWrites";

/** Resumable conversion from the verified source archive. Exact existing
 * objects are accepted; a changed source or destination is never overwritten. */
export async function copyProtectedCollection(
  client: Client,
  collection: Collection,
  rows: { id: string; value: unknown }[],
  validate: (input: unknown, object: string) => unknown,
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
    const expected = new Map(
      rows.map((row) => [row.id, JSON.stringify(validate(row.value, row.id))]),
    );
    const prefix =
      partial && rows.length === 1 ? rows[0]!.id : collection.prefix;
    const existing = await target.read(prefix);
    live();
    const done = new Set<string>();
    for (const item of existing) {
      if (partial && !expected.has(item.envelope.object)) continue;
      if (
        expected.get(item.envelope.object) !==
        JSON.stringify(validate(item.value, item.envelope.object))
      )
        throw new InvalidProtectedData();
      done.add(item.envelope.object);
    }
    let packets: MutateInput<"zerotrust.objects.save">[] = [],
      size = 0;
    let attest: Awaited<ReturnType<typeof migrationOriginAttester>> | undefined;
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
              return (
                saved.length === pending.length &&
                pending.every((packet) =>
                  saved.some(
                    (item) =>
                      item.envelope.object === packet.envelope.object &&
                      item.envelope.signature === packet.envelope.signature,
                  ),
                )
              );
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
    const selected = partial
      ? verified.filter((item) => expected.has(item.envelope.object))
      : verified;
    if (
      selected.length !== expected.size ||
      selected.some(
        (item) =>
          expected.get(item.envelope.object) !==
          JSON.stringify(validate(item.value, item.envelope.object)),
      )
    )
      throw new InvalidProtectedData();
  } finally {
    target.close();
  }
}
