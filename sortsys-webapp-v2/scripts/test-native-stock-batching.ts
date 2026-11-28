import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { unlockedAccount } from "../app/lib/crypto/session";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import {
  openProtectedProducts,
  PRODUCT_COLLECTION,
} from "../app/lib/data/products";
import { protectedCollection } from "../app/lib/data/protectedObjects";
import { mapConcurrent } from "../app/lib/data/runtime/concurrentReads";
import { row } from "../app/lib/data/testing/businessRow.mjs";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

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
            custom_id: String(id),
            name: `Geheimes Katalogprodukt ${id}`,
            description: `Verschlüsselte Beschreibung ${id}`,
          }),
          categories: [],
        }),
    );

    console.log(`Native stock batching: stage and publish ${packets.length} signed packets`);
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
            console.log("Native stock batching: read published packets on the peer");
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
              const selectedIds = packets
                .map((packet) => packet.envelope.object)
                .reverse();
              const selectedStart = transmissions.length;
              const selected = await reader.selected(selectedIds);
              assert.deepEqual(
                selected.map((object) => object.envelope.object),
                selectedIds,
              );
              for (const object of selected) {
                const packet = expected.get(object.envelope.object)!;
                assert.equal(
                  object.envelope.signature,
                  packet.envelope.signature,
                );
                assert.equal(
                  object.stock?.references.signature,
                  packet.references?.signature,
                );
              }
              const objectBatches = transmissions
                .slice(selectedStart)
                .map((paths) =>
                  paths.filter((path) => path === "zerotrust.objects.getMany"),
                )
                .filter((paths) => paths.length > 0);
              assert.deepEqual(
                objectBatches,
                Array.from({ length: 10 }, () => ["zerotrust.objects.getMany"]),
                "Each group of up to 32 ciphertexts uses one authorized store operation",
              );
              assert.equal(
                transmissions
                  .slice(selectedStart)
                  .flat()
                  .includes("zerotrust.objects.get"),
                false,
              );
              const withMissing = await reader.selected([
                "product:missing",
                selectedIds[0]!,
              ]);
              assert.deepEqual(
                withMissing.map(({ envelope }) => envelope.object),
                [selectedIds[0]],
              );
              assert.deepEqual(await reader.selected(["product:missing"]), []);
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
      "Native stock batching: 320 encrypted products cross API replicas in ten getMany calls, with individually verified stock proofs",
    );

    const catalogue = openProtectedProducts(peer, signal, duckDriver);
    try {
      const ids = [9_000_000, 9_000_319];
      const start = transmissions.length;
      const products = await Promise.all(
        ids.map((id) => catalogue.get(id.toString(32))),
      );

      assert.deepEqual(
        products.map(({ name }) => name),
        ids.map((id) => `Geheimes Katalogprodukt ${id}`),
      );
      const reads = transmissions.slice(start).flat();
      assert.equal(
        reads.filter((path) => path === "zerotrust.objects.getMany").length,
        1,
      );
      assert.equal(reads.includes("zerotrust.objects.get"), false);

      const warmStart = transmissions.length;
      assert.deepEqual(await catalogue.get(products[0]!.id), products[0]);
      assert.equal(transmissions.length, warmStart);

      console.log(
        "Native stock batching: two product references share one selected read; warm lookup sends no RPC",
      );
    } finally {
      await catalogue.close();
    }
  } finally {
    collection.close();
    controller.abort();
  }
}
