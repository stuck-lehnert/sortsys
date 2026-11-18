import assert from "node:assert/strict";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { encryptedObject } from "@sortsys/zerotrust/sortsys";
import { addressId } from "../app/lib/data/addressBook";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";
import {
  deliveryCollection,
  type DeliveryPayload,
  type DeliveryPrices,
} from "../app/lib/data/deliveryNoteData";
import { allocateDeliveryNote } from "../app/lib/data/deliveryRegistry";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { mapConcurrent } from "../app/lib/data/runtime/concurrentReads";

/** Keep the cost page physically populated with ciphertext whose signed
 * parents have been deleted. Remaining live costs must still be reachable. */
export async function exerciseNativeDeliveryPagination(
  owner: Client,
  peer: Client,
  projectId: string,
  template: DeliveryPayload,
  signal: AbortSignal,
) {
  const master = deliveryCollection(projectId);
  const prices = deliveryCollection(projectId, true);
  const notes = await protectedCollection(owner, master, signal);
  const costs = await protectedCollection(owner, prices, signal);
  try {
    await notes.read();
    await costs.read();
    const allocations = await mapConcurrent(
      Array.from({ length: 36 }, () => crypto.randomUUID()),
      4,
      (request) => allocateDeliveryNote(owner, projectId, request, signal),
    );
    const pairs = await mapConcurrent(allocations, 16, async (allocation) => {
      const payload = structuredClone(template);
      payload.note.values.id = addressId(allocation.id);
      payload.note.values.auto_id = allocation.number;
      payload.records = [];
      payload.specialRecords = [];
      const price: DeliveryPrices = {
        format: "sortsys-delivery-prices-v1",
        projectId,
        noteId: allocation.id,
        prices: [],
      };
      return {
        note: await notes.packet(master.prefix + allocation.id, payload),
        price: await costs.packet(prices.prefix + allocation.id, price),
      };
    });
    function group(
      collection: typeof notes,
      domain: string,
      packets: MutateInput<"zerotrust.objects.save">[],
    ) {
      return {
        packets,
        head: { domain, sequence: collection.snapshot()! },
        async verify() {
          const loaded = new Map(
            (await collection.read()).map((object) => [
              object.envelope.object,
              object.envelope.signature,
            ]),
          );
          return packets.every(
            (packet) =>
              loaded.get(packet.envelope.object) === packet.envelope.signature,
          );
        },
        close() {},
      };
    }
    await commitProtectedWrites(
      owner,
      [
        group(
          notes,
          master.domain,
          pairs.map((pair) => pair.note),
        ),
        group(
          costs,
          prices.domain,
          pairs.map((pair) => pair.price),
        ),
      ],
      signal,
    );
    // Use code-unit order, exactly as the store's object cursor does.
    const sorted = pairs.slice().sort((left, right) => {
      if (left.note.envelope.object < right.note.envelope.object) return -1;
      if (left.note.envelope.object > right.note.envelope.object) return 1;
      return 0;
    });
    const deleted = await mapConcurrent(sorted.slice(0, 32), 16, ({ note }) =>
      notes.tombstone(note.envelope.object, encryptedObject(note.envelope)),
    );
    await notes.write(deleted);
    const firstPage = await required(
      peer.query(
        "zerotrust.objects.list",
        {
          domain: prices.domain,
          prefix: prices.prefix,
          after: null,
          snapshot: null,
        },
        { strategy: "network-only" },
      ),
    );
    assert.deepEqual(firstPage.objects, []);
    assert.ok(
      firstPage.after,
      "an entirely hidden first page still has a continuation cursor",
    );
    const reader = await protectedCollection(peer, prices, signal);
    try {
      const remaining = await reader.read();
      assert.deepEqual(
        remaining.map((object) => object.envelope.object),
        sorted.slice(32).map((pair) => pair.price.envelope.object),
      );
      assert.equal(reader.snapshot(), firstPage.snapshot);
      for (const object of remaining) {
        const expected = pairs.find(
          (pair) => pair.price.envelope.object === object.envelope.object,
        )!;
        assert.equal(
          object.envelope.signature,
          expected.price.envelope.signature,
        );
      }
    } finally {
      reader.close();
    }
    console.log(
      "Native delivery deletion: 36 encrypted notes and prices, 32 signed deletions, an entirely hidden cost page and all four remaining authenticated prices verified across API processes",
    );
  } finally {
    notes.close();
    costs.close();
  }
}
