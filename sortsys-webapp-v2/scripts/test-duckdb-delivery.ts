import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import {
  activatePreparedContent,
  approvePreparedContent,
  inspectPreparedContent,
} from "../app/lib/backups/contentRestore";
import {
  allocateDeliveryNote,
  initializeDeliveryRegistry,
  deliveryRequestContext,
} from "../app/lib/data/deliveryRegistry";
import { deliveryCollection } from "../app/lib/data/deliveryNoteData";
import { deliveryObject } from "../app/lib/data/deliveryIdentity";
import { newProductRowId, publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { mapConcurrent } from "../app/lib/data/runtime/concurrentReads";
import type { DeliveryRequestHook } from "./test-native-delivery-deletion";

export async function exerciseDeliveryMove(
  owner: Client,
  peer: Client,
  from: string,
  to: string,
  setRequestHook: (hook: DeliveryRequestHook | null) => void,
  backup: { operator: Client; tenant: string },
) {
  const comment = "Korrigierte Baustellenzuordnung für Lieferung 58673";
  const item = { name: "Zwischentransport", unit: "Stk", amount: 2, pricePerUnit: 22.75 };
  const unpricedItem = { name: "Montagehilfe", unit: "Std", amount: 3 };
  const product = await required(owner.mutate("products.create", {
    customId: 58673,
    name: "Kantenschutz aus verzinktem Stahl",
    baseUnit: "Stk",
  }));
  const purchase = await required(owner.mutate("products.priceRecords.create", {
    productId: product.id,
    pricePerBaseUnit: 9.25,
    timestamp: new Date("2026-11-01T11:00:00Z"),
    isRealPurchase: true,
  }));
  const creation = {
    requestId: crypto.randomUUID(),
    projectId: from,
    effectiveTimestamp: new Date("2026-11-02T07:30:00Z"),
    records: [{ productId: product.id, quantity: 2 }],
    specialRecords: [item, { ...unpricedItem, pricePerUnit: null }],
  };
  const created = await required(owner.mutate("deliveryNotes.create", creation));
  const read = (client: Client) => required(client.query(
    "deliveryNotes.get", { id: created.id }, { strategy: "network-only" },
  ));
  const detailCosts = (client: Client) => required(client.query(
    "deliveryNotes.costs.get", { id: created.id }, { strategy: "network-only" },
  ));
  async function projectDeliveryCost(client: Client, projectId: string) {
    const costs = await required(client.query(
      "projects.costs.get", { projectId }, { strategy: "network-only" },
    ));
    return costs.deliveryNotes.find((entry) => entry.noteId === created.id)?.totalCost;
  }
  const source = await read(owner);
  const initialCosts = await detailCosts(owner);
  assert.equal(initialCosts.totalCost, 64);
  assert.equal(initialCosts.records[0]?.priceRecord?.id, purchase.id);
  assert.equal(initialCosts.specialRecords[1]?.pricePerUnit, null);
  assert.equal(initialCosts.specialRecords[1]?.totalCost, 0);
  assert.equal(await projectDeliveryCost(owner, from), initialCosts.totalCost);
  const sourceObject = deliveryObject({ id: created.id, projectId: from });
  const move = (client: Client, target: string, expected: Awaited<ReturnType<typeof read>>) =>
    client.mutate("deliveryNotes.update", {
      id: created.id,
      expectedRevision: expected.revision,
      expectedPriceRevision: expected.priceRevision,
      data: { projectId: target, comment },
    });

  let raced = false;
  setRequestHook(async (url, next) => {
    if (!url.pathname.endsWith("/zerotrust.deliveryNotes.move") || raced) return next();
    raced = true;
    await required(peer.mutate("deliveryNotes.update", {
      id: created.id,
      expectedRevision: source.revision,
      expectedPriceRevision: source.priceRevision,
      data: { specialRecords: [
        { ...item, id: source.specialRecords[0]!.id, pricePerUnit: 27.5 },
        { ...unpricedItem, id: source.specialRecords[1]!.id },
      ] },
    }));
    return next();
  });
  try {
    assert.ok((await move(owner, to, source))[1]);
    assert.equal(raced, true);
  } finally {
    setRequestHook(null);
  }
  await owner.invalidate("deliveryNotes.get");
  const current = await read(owner);
  assert.equal(current.projectId, from);
  assert.equal(current.specialRecords[0]?.pricePerUnit, 27.5);
  assert.deepEqual(await required(peer.query("deliveryNotes.list", { projectId: to })), []);

  let lost = false;
  setRequestHook(async (url, next) => {
    const response = await next();
    if (url.pathname.endsWith("/zerotrust.deliveryNotes.move") && response.ok) {
      lost = true;
      return new Response("Lost successful delivery transfer response", { status: 503 });
    }
    return response;
  });
  try {
    await required(move(owner, to, current));
    assert.equal(lost, true);
  } finally {
    setRequestHook(null);
  }
  await peer.invalidate("deliveryNotes.list");
  const destination = await read(peer);
  assert.equal(destination.projectId, to);
  assert.equal(destination.autoId, source.autoId);
  assert.equal(destination.comment, comment);
  assert.equal(destination.specialRecords[0]?.id, source.specialRecords[0]?.id);
  assert.equal(destination.specialRecords[0]?.pricePerUnit, 27.5);
  const movedCosts = await detailCosts(peer);
  assert.equal(movedCosts.totalCost, 73.5);
  assert.equal(await projectDeliveryCost(peer, to), movedCosts.totalCost);
  assert.equal(await projectDeliveryCost(owner, from), undefined);
  assert.equal((await required(owner.query("deliveryNotes.list", { projectId: from })))
    .some(({ id }) => id === created.id), false);
  assert.ok((await owner.query("zerotrust.objects.get", { id: sourceObject }))[1]);
  const lookup = await required(peer.query("zerotrust.deliveryNotes.locate", { number: String(source.autoId) }));
  assert.equal(lookup.projectId, to);
  assert.match(lookup.placement!, /^[a-f0-9]{32}$/);
  assert.deepEqual(await required(owner.mutate("deliveryNotes.create", creation)), created);
  const snapshot = await required(backup.operator.mutate("admin.storage.snapshots.create", {
    tenant: backup.tenant,
    operation: crypto.randomUUID(),
  }));

  await required(peer.mutate("products.priceRecords.update", {
    id: purchase.id,
    data: { pricePerBaseUnit: 10.5 },
  }));
  const updatedCosts = await detailCosts(peer);
  assert.equal(updatedCosts.totalCost, 76);
  assert.equal(await projectDeliveryCost(peer, to), updatedCosts.totalCost);

  await required(move(peer, from, destination));
  await owner.invalidate("deliveryNotes.list");
  const returned = await read(owner);
  assert.equal(returned.projectId, from);
  assert.equal(returned.autoId, source.autoId);
  assert.equal(returned.specialRecords[0]?.pricePerUnit, 27.5);
  assert.notEqual(returned.revision, source.revision);
  assert.ok((await move(owner, to, source))[1], "a form from the former placement stays stale");
  await required(owner.mutate("deliveryNotes.delete", { id: created.id, expectedRevision: returned.revision }));
  assert.ok((await peer.query("zerotrust.deliveryNotes.locate", { id: created.id }))[1]);
  console.log("Delivery move verified: shared number, concurrent price guard, lost reply, round trip and stale form denial.");

  const signal = new AbortController().signal;
  const prepared = await required(peer.mutate("zerotrust.content.prepare", {
    snapshotOperation: snapshot.id,
    operation: crypto.randomUUID(),
  }));
  const approval = await approvePreparedContent(peer, prepared, signal);
  const preview = await inspectPreparedContent(peer, approval, signal);
  assert.deepEqual(preview.restoredMaterial, {
    deliveryNotes: 1,
    regieReports: 0,
    missingProjects: 0,
    missingProducts: 0,
    uncheckedReferences: 0,
  });
  await activatePreparedContent(peer, { ...approval, review: preview.review }, signal);
  const restored = await read(peer);
  assert.equal(restored.projectId, destination.projectId);
  assert.equal(restored.autoId, destination.autoId);
  assert.equal(restored.revision, destination.revision);
  assert.deepEqual(restored.specialRecords, destination.specialRecords);
  assert.deepEqual(await detailCosts(peer), movedCosts);
  assert.equal(await projectDeliveryCost(peer, to), movedCosts.totalCost);
  assert.equal(await projectDeliveryCost(peer, from), undefined);
  console.log("Delivery restore verified: preview and activation use the saved placement, numbering and prices.");
  return comment;
}

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
    second.id,
  );
  console.log(
    "Native delivery notes verified: real project/note creation, concurrent shared numbering, replay, cross-project rejection, private prices and stable updates.",
  );
  return [title, comment, "Ergänzte vertrauliche Lieferabsprache"];
}
