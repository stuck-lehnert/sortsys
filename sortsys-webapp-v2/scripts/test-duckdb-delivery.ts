import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import {
  allocateDeliveryNote,
  initializeDeliveryRegistry,
  deliveryRequestContext,
} from "../app/lib/data/deliveryRegistry";
import { deliveryCollection } from "../app/lib/data/deliveryNoteData";
import { newProductRowId, publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { mapConcurrent } from "../app/lib/data/runtime/concurrentReads";
import type { DeliveryRequestHook } from "./test-native-delivery-deletion";

export async function exerciseDeliveryReferenceBatch(
  writer: Client,
  reader: Client,
) {
  const signal = new AbortController().signal;
  const project = await required(
    writer.mutate("projects.create", {
      title: "Sanierung Westfassade",
    }),
  );
  const otherProject = await required(
    writer.mutate("projects.create", {
      title: "Neue Werkstatt",
    }),
  );
  const requestIds = Array.from({ length: 8 }, () => crypto.randomUUID());
  const allocations = await mapConcurrent(requestIds, 4, (requestId) =>
    allocateDeliveryNote(writer, project.id, requestId, signal),
  );
  const expected = allocations
    .slice()
    .reverse()
    .map((allocation) => ({
      object: `delivery-note:${project.id}:${allocation.id}`,
      allocation,
    }));
  const references = (objects: string[]) =>
    reader.query(
      "zerotrust.deliveryNotes.references",
      { objects },
      {
        strategy: "network-only",
      },
    );
  assert.deepEqual(
    await required(references(expected.map(({ object }) => object))),
    expected,
  );
  const [wrongProject, wrongProjectError] = await references([
    expected[0]!.object,
    `delivery-note:${otherProject.id}:${allocations[1]!.id}`,
  ]);
  assert.equal(wrongProject, null);
  assert.equal(wrongProjectError?.code, "CONFLICT");
  const [missingAllocation, missingError] = await references([
    expected[0]!.object,
    `delivery-note:${project.id}:${publicId(newProductRowId())}`,
  ]);
  assert.equal(missingAllocation, null);
  assert.equal(missingError?.code, "NOT_FOUND");

  const created = await required(
    writer.mutate("deliveryNotes.create", {
      requestId: requestIds[0]!,
      projectId: project.id,
      effectiveTimestamp: new Date("2026-11-01T07:30:00Z"),
      specialRecords: [
        { name: "Transport", amount: 1, unit: "pauschal", pricePerUnit: 4.25 },
      ],
    }),
  );
  const notes = await required(
    writer.query("deliveryNotes.list", { projectId: project.id }),
  );
  assert.deepEqual(notes.map(({ id }) => id), [created.id]);
  assert.equal(notes[0]!.specialRecords[0]!.pricePerUnit, 4.25);
}

export async function exerciseNativeDelivery(
  owner: Client,
  peer: Client,
  setRequestHook: (hook: DeliveryRequestHook | null) => void,
): Promise<string[]> {
  const signal = new AbortController().signal;
  const title = "Interne Fenstersanierung mit vertraulichen Sonderkonditionen";
  const created = await required(owner.mutate("projects.create", { title }));
  const second = await required(
    peer.mutate("projects.create", {
      title: "Dachabdichtung am Verwaltungsgebäude",
    }),
  );
  const requests = Array.from({ length: 8 }, () => crypto.randomUUID());
  const allocations = await Promise.all(
    requests.map((request, index) =>
      allocateDeliveryNote(
        index % 2 === 0 ? owner : peer,
        created.id,
        request,
        signal,
      ),
    ),
  );
  assert.deepEqual(
    allocations
      .map((allocation) => Number(allocation.number))
      .sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(new Set(allocations.map((allocation) => allocation.id)).size, 8);
  const first = allocations[0]!;
  assert.deepEqual(
    await allocateDeliveryNote(peer, created.id, requests[0]!, signal),
    first,
  );
  await assert.rejects(() =>
    allocateDeliveryNote(peer, second.id, requests[0]!, signal),
  );
  await assert.rejects(() =>
    required(
      owner.query(
        "zerotrust.deliveryNotes.locate",
        { id: first.id },
        { strategy: "network-only" },
      ),
    ),
  );
  await initializeDeliveryRegistry(peer, signal);
  const ninth = await allocateDeliveryNote(
    owner,
    created.id,
    crypto.randomUUID(),
    signal,
  );
  assert.equal(
    ninth.number,
    "9",
    "repeated initialization never resets the counter",
  );

  const comment = "Vertrauliche Lieferabsprache für die nördliche Fassade";
  const input = {
    requestId: requests[0]!,
    projectId: created.id,
    comment,
    effectiveTimestamp: new Date("2026-11-01T07:30:00Z"),
    specialRecords: [
      {
        name: "Anschlussprofile Fensterlaibung",
        unit: "m",
        amount: 3.5,
        pricePerUnit: 12.75,
      },
    ],
  };
  const note = await required(owner.mutate("deliveryNotes.create", input));
  assert.equal(note.id, first.id);
  assert.deepEqual(
    await required(peer.mutate("deliveryNotes.create", input)),
    note,
  );
  const found = await required(
    peer.query(
      "deliveryNotes.get",
      { id: note.id },
      { strategy: "network-only" },
    ),
  );
  assert.equal(found.comment, comment);
  assert.equal(found.autoId, Number(first.number));
  assert.equal(found.specialRecords[0]?.pricePerUnit, 12.75);
  const located = await required(
    owner.query(
      "zerotrust.deliveryNotes.locate",
      { number: first.number },
      { strategy: "network-only" },
    ),
  );
  assert.equal(located.id, first.id);
  assert.equal(located.projectId, created.id);
  const references = await required(
    peer.query(
      "zerotrust.deliveryNotes.references",
      {
        objects: [`delivery-note:${created.id}:${note.id}`],
      },
      { strategy: "network-only" },
    ),
  );
  assert.deepEqual(
    references.map((reference) => reference.allocation),
    [first],
  );

  await required(
    peer.mutate("deliveryNotes.update", {
      id: note.id,
      data: { comment: "Ergänzte vertrauliche Lieferabsprache" },
      expectedRevision: found.revision,
    }),
  );
  const updated = await required(
    owner.query(
      "deliveryNotes.get",
      { autoId: Number(first.number) },
      { strategy: "network-only" },
    ),
  );
  assert.equal(updated.autoId, found.autoId);
  assert.equal(updated.comment, "Ergänzte vertrauliche Lieferabsprache");

  for (const [projectId, noteId] of [
    [second.id, note.id],
    [created.id, publicId(newProductRowId())],
  ]) {
    const area = await protectedCollection(
      peer,
      deliveryCollection(projectId!),
      signal,
    );
    try {
      await area.read();
      const forged = await area.packet(`delivery-note:${projectId}:${noteId}`, {
        format: "hostile-client-payload",
      });
      await assert.rejects(
        () => area.write([forged]),
        "a valid author cannot forge a missing or foreign-project allocation",
      );
    } finally {
      area.close();
    }
  }
  const context = await deliveryRequestContext(owner, signal);
  await assert.rejects(() =>
    required(
      peer.mutate("zerotrust.deliveryNotes.allocate", {
        projectId: created.id,
        requestId: crypto.randomUUID(),
        generation: context.generation,
        policyVersion: context.policyVersion,
        proof: base64(new Uint8Array(64)),
      }),
    ),
  );
  const tenth = await allocateDeliveryNote(
    peer,
    second.id,
    crypto.randomUUID(),
    signal,
  );
  assert.equal(tenth.number, "10", "rejected requests cannot consume a number");
  const { exerciseNativeDeliveryDeletion } =
    await import("./test-native-delivery-deletion");
  await exerciseNativeDeliveryDeletion(
    owner,
    peer,
    created.id,
    note.id,
    setRequestHook,
  );
  console.log(
    "Native delivery notes verified: real project/note creation, concurrent shared numbering, replay, cross-project rejection, private prices and stable updates.",
  );
  return [title, comment, "Ergänzte vertrauliche Lieferabsprache"];
}
