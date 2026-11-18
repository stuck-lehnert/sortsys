import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { unlockedAccount } from "../app/lib/crypto/session";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import { PRODUCT_COLLECTION } from "../app/lib/data/products";
import { protectedCollection } from "../app/lib/data/protectedObjects";
import { mapConcurrent } from "../app/lib/data/runtime/concurrentReads";
import { row } from "../app/lib/data/testing/businessRow.mjs";

/** Publish real encrypted catalogue records through one replica and verify
 * every stock proof through the other, using the ordinary collection reader. */
export async function exerciseNativeStockBatching(
  owner: Client,
  peer: Client,
  transmissions: readonly string[][],
) {
  const account = unlockedAccount();
  assert.ok(account);
  const controller = new AbortController();
  const signal = controller.signal;
  await provisionOwnedCollections(
    owner,
    account.vault.subject,
    [PRODUCT_COLLECTION],
    signal,
  );
  const collection = await protectedCollection(
    owner,
    PRODUCT_COLLECTION,
    signal,
  );
  try {
    assert.deepEqual(await collection.read(), []);
    const packets = await mapConcurrent(
      Array.from({ length: 320 }, (_, index) => 9_000_000 + index),
      16,
      async (id) =>
        collection.packet(`product:${id.toString(32)}`, {
          format: "sortsys-product-v1",
          product: row("products", {
            id: String(id),
            name: `Geheimes Katalogprodukt ${id}`,
            description: `Verschlüsselte Beschreibung ${id}`,
          }),
          categories: [],
        }),
    );
    let verified = false;
    await commitProtectedWrites(
      owner,
      [
        {
          packets,
          head: {
            domain: PRODUCT_COLLECTION.domain,
            sequence: collection.snapshot()!,
          },
          close() {},
          async verify() {
            const reader = await protectedCollection(
              peer,
              PRODUCT_COLLECTION,
              signal,
            );
            try {
              const start = transmissions.length;
              const objects = await reader.read();
              assert.equal(objects.length, packets.length);
              const expected = new Map(
                packets.map((packet) => [packet.envelope.object, packet]),
              );
              for (const object of objects) {
                const packet = expected.get(object.envelope.object);
                assert.ok(packet);
                assert.equal(
                  object.envelope.signature,
                  packet.envelope.signature,
                );
                assert.equal(
                  object.stock?.references.signature,
                  packet.references?.signature,
                );
              }
              const stockBatches = transmissions
                .slice(start)
                .filter((paths) =>
                  paths.includes("zerotrust.stock.references"),
                );
              assert.deepEqual(stockBatches, [
                Array(4).fill("zerotrust.stock.references"),
                ["zerotrust.stock.references"],
              ]);
              verified = true;
              return true;
            } finally {
              reader.close();
            }
          },
        },
      ],
      signal,
    );
    assert.equal(verified, true);
    console.log(
      "Native stock batching: 320 encrypted products and individually verified stock proofs cross API replicas in two metadata HTTP requests",
    );
  } finally {
    collection.close();
    controller.abort();
  }
}
