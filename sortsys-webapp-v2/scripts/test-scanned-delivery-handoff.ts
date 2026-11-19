import assert from "node:assert/strict";
import {
  createClient,
  type Client,
  type MutateInput,
  type QueryInput,
  type QueryResult,
} from "@sortsys/v2-client";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { deliveryCollection } from "../app/lib/data/deliveryNoteData";
import {
  deliveryScanPrefill,
  scannedDeliveryRequestId,
} from "../app/lib/data/deliveryScanPrefill";
import { required } from "../app/lib/data/protectedObjects";
import { PRODUCT_COLLECTION } from "../app/lib/data/products";

export async function testScannedDeliveryHandoff(
  raw: Client,
  business: Client,
  driver: () => Promise<DuckDriver>,
  scan: QueryResult<"deliveryNotes.scan.list">[number],
  peer: { endpoint: string; token: string },
) {
  const { id: projectId } = await required(
    business.mutate("projects.create", {
      title: "Baustelle für einen eingelesenen Lieferschein",
    }),
  );
  const customId = await required(
    business.query("products.suggestNextCustomId", undefined),
  );
  const { id: secondProduct } = await required(
    business.mutate("products.create", {
      customId,
      name: "Zusätzlich gelieferte Plane",
      baseUnit: "Stk",
    }),
  );

  async function prepare(client: Client) {
    const result = await required(
      client.mutate("deliveryNotes.scan.complete", { scanId: scan.id }),
    );
    assert.ok(result.deliveryNote);
    const products = await required(client.query("products.list", {}));
    const prefill = deliveryScanPrefill(scan, result.deliveryNote, products);
    assert.equal(prefill.records.length, 1);
    const matched = prefill.records[0]!;
    const factor = matched.unit === matched.product.baseUnit
      ? 1
      : matched.product.otherUnits[matched.unit]!;
    const row = {
      productId: matched.product.id,
      quantity: matched.amount * factor,
      unit: matched.unit,
      comment: matched.comment,
    };
    const input = {
      projectId,
      effectiveTimestamp: prefill.deliveryDate,
      comment: prefill.comment,
      records: [row, { ...row }, { productId: secondProduct, quantity: 3, unit: "Stk" }],
      specialRecords: prefill.specialRecords,
    };
    return { ...input, requestId: await scannedDeliveryRequestId(scan.id, input) };
  }

  const batches: string[][] = [];
  let lostAcknowledgement = false;
  let changeBeforeCommit: (() => Promise<unknown>) | undefined;
  const area = deliveryCollection(projectId);
  const observed: Client = {
    ...raw,
    query: ((path, input, options) => {
      if (path === "zerotrust.objects.getMany") {
        const selection = input as QueryInput<"zerotrust.objects.getMany">;
        if (selection.domain === PRODUCT_COLLECTION.domain) batches.push(selection.ids);
      }
      return raw.query(path, input, options);
    }) as Client["query"],
    mutate: (async (path, input, options) => {
      const publication = path === "zerotrust.objects.batch" &&
        (input as MutateInput<"zerotrust.objects.batch">).heads?.some(
          ({ domain }) => domain === area.domain,
        );
      if (publication && changeBeforeCommit) {
        const change = changeBeforeCommit;
        changeBeforeCommit = undefined;
        await change();
      }
      const result = await raw.mutate(path, input, options);
      if (publication && !result[1] && !lostAcknowledgement) {
        lostAcknowledgement = true;
        return [null, new Error("Synthetic lost scanned-delivery acknowledgement")];
      }
      return result;
    }) as Client["mutate"],
  };
  const first = createBusinessClient(observed, { productDriver: driver });
  const secondTransport = createClient(peer.endpoint, "scanned-delivery-peer");
  secondTransport.setToken(peer.token);
  const second = createBusinessClient(secondTransport, { productDriver: driver });
  try {
    const firstInput = await prepare(first);
    batches.length = 0;
    const created = await required(first.mutate("deliveryNotes.create", firstInput));
    assert.equal(lostAcknowledgement, true);
    assert.equal(batches.length, 1);
    assert.deepEqual(new Set(batches[0]), new Set(
      firstInput.records.map(({ productId }) => PRODUCT_COLLECTION.prefix + productId),
    ));

    const reopened = await prepare(second);
    assert.deepEqual(reopened, firstInput);
    assert.deepEqual(
      await required(second.mutate("deliveryNotes.create", reopened)),
      created,
    );
    const { requestId: _previous, ...confirmedInput } = reopened;
    const nextInput = { ...confirmedInput, comment: "Weitere Lieferung erwartet" };
    changeBeforeCommit = () => required(second.mutate("products.update", {
      id: secondProduct,
      data: { description: "Katalog auf der anderen Instanz geändert" },
    }));
    const [raced, error] = await first.mutate("deliveryNotes.create", {
      ...nextInput,
      requestId: await scannedDeliveryRequestId(scan.id, nextInput),
    });
    assert.equal(changeBeforeCommit, undefined);
    assert.ok(error);
    assert.equal(raced, null);

    const notes = await required(second.query("deliveryNotes.list", { projectId }));
    assert.deepEqual(notes.map(({ id }) => id), [created.id]);
    const details = await required(second.query("deliveryNotes.get", { id: created.id }));
    assert.deepEqual(details.records.map(({ quantity }) => quantity), [5, 5, 3]);
    assert.equal(details.effectiveTimestamp.getTime(), firstInput.effectiveTimestamp?.getTime());
    assert.equal(details.comment, firstInput.comment);
  } finally {
    first.dispose();
    second.dispose();
    secondTransport.setToken(null);
  }
  console.log("Scanned delivery verified: batched catalogue validation, concurrent catalogue edit rejected, and a duplicate-free retry after a lost acknowledgement on the other API.");
}
