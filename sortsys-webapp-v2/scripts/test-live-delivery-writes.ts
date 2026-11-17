import assert from "node:assert/strict";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { record, policy, signPolicy, encryptedObject } from "@sortsys/zerotrust/sortsys";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import { finishAccessChanges } from "../app/lib/crypto/permissions";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { deliveryCollection } from "../app/lib/data/deliveryNoteData";
import type { DuckDriver } from "../app/lib/data/database";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
export async function testDeliveryWrites(client: Client, driver: () => Promise<DuckDriver>, password: string) {
  const account = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "delivery-write-peer");
  await signIn(peer, { tenant: account.tenant, username: account.username, password });
  await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
  const requests: {
    path: string;
    input: unknown;
  }[] = [];
  let lostAllocation = false, lostPublication = false, discardPublication = false;
  const allocations: unknown[] = [];
  let allocationCalls = 0;
  let barrier: {
    count: number;
    release: () => void;
    wait: Promise<void>;
  } | null = null;
  const observed: Client = { ...client,
    query: ((path, input, options) => { requests.push({ path, input }); assert.ok(!path.startsWith("deliveryNotes.") && !path.startsWith("products.") && !path.startsWith("projects.")); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input });
      assert.ok(!path.startsWith("deliveryNotes."));
      if (path === "zerotrust.objects.batch") {
        if (barrier) {
          if (++barrier.count === 2)
            barrier.release();
          await barrier.wait;
        }
        if (discardPublication) {
          discardPublication = false;
          return [{ success: true, heads: [] }, null];
        }
      }
      const transport = path === "zerotrust.deliveryNotes.allocate" && ++allocationCalls % 2 === 0 ? client : peer;
      const result = await transport.mutate(path, input as MutateInput<typeof path>, options);
      if (path === "zerotrust.deliveryNotes.allocate" && !result[1]) {
        allocations.push(result[0]);
        if (lostAllocation) {
          lostAllocation = false;
          return [null, new Error("Synthetic lost allocation reply")];
        }
      }
      if (path === "zerotrust.objects.batch" && lostPublication && !result[1]) {
        lostPublication = false;
        return [null, new Error("Synthetic lost delivery publication reply")];
      }
      return result;
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  const initial = await required(business.query("deliveryNotes.list", {}));
  assert.ok(initial.length);
  const projectId = initial[0]!.projectId, anotherProject = (await required(other.query("projects.list", {}))).find(project => project.id !== projectId)!;
  const product = (await required(other.query("products.list", {})))[0]!;
  const marker = "Vertrauliche Anlieferung mit Sonderpreis", price = 98765.4321;
  const input = (project = projectId) => ({ requestId: crypto.randomUUID(), projectId: project, comment: marker, effectiveTimestamp: new Date("2026-11-11T12:13:14.567Z"),
    records: [{ productId: product.id, quantity: 2.375, unit: product.baseUnit, comment: "Position bleibt erhalten" }],
    specialRecords: [{ name: "Anlieferung", unit: "pauschal", amount: 1.125, pricePerUnit: price, comment: "Sonderkommentar bleibt erhalten" }] });
  try {
    const pending = input();
    lostAllocation = true;
    assert.ok((await business.mutate("deliveryNotes.create", pending))[1]);
    const lost = allocations.at(-1)!;
    assert.equal((await required(business.query("deliveryNotes.list", {}))).length, initial.length);
    lostPublication = true;
    const made = await required(business.mutate("deliveryNotes.create", pending));
    assert.deepEqual(allocations.at(-1), lost);
    assert.equal(lostPublication, false);
    assert.deepEqual(await required(business.mutate("deliveryNotes.create", pending)), made);
    const reopened = createBusinessClient(observed, { productDriver: driver });
    try {
      assert.deepEqual(await required(reopened.mutate("deliveryNotes.create", pending)), made);
    }
    finally {
      reopened.dispose();
    }
    assert.ok((await business.mutate("deliveryNotes.create", { ...pending, comment: "Different input under the same operation ID" }))[1]);
    assert.ok((await business.mutate("deliveryNotes.create", { ...pending, projectId: anotherProject.id }))[1]);
    let note = await required(business.query("deliveryNotes.get", { id: made.id }));
    assert.ok(note.revision);
    assert.ok(note.priceRevision);
    assert.equal(note.records[0]!.quantity, 2.375);
    assert.equal(note.specialRecords[0]!.pricePerUnit, price);
    assert.equal(note.effectiveTimestamp.toISOString(), pending.effectiveTimestamp.toISOString());
    const next = { ...input(), comment: marker + " Zweite Lieferung" };
    discardPublication = true;
    assert.ok((await business.mutate("deliveryNotes.create", next))[1]);
    assert.equal((await required(business.query("deliveryNotes.list", {}))).length, initial.length + 1);
    const retried = await required(business.mutate("deliveryNotes.create", next));
    assert.notEqual(retried.id, made.id);
    const countBefore = (await required(business.query("deliveryNotes.list", {}))).length;
    const separate = [input(), input(anotherProject.id)], parallel = await Promise.all(separate.map(async (row) => {
      const store = createBusinessClient(observed, { productDriver: driver });
      try {
        return await required(store.mutate("deliveryNotes.create", row));
      }
      finally {
        store.dispose();
      }
    }));
    const independentlyRead = await Promise.all(parallel.map(value => required(other.query("deliveryNotes.get", { id: value!.id }))));
    assert.notEqual(independentlyRead[0]!.autoId, independentlyRead[1]!.autoId);
    assert.ok(independentlyRead.every(row => row.autoId > note.autoId));
    assert.equal((await required(business.query("deliveryNotes.list", {}))).length, countBefore + 2);
    const stale = note;
    await required(business.mutate("deliveryNotes.update", { id: made.id, expectedRevision: note.revision, data: { comment: "Überarbeiteter Lieferschein" } }));
    assert.ok((await business.mutate("deliveryNotes.update", { id: made.id, expectedRevision: stale.revision, data: { comment: "Stale form must not overwrite" } }))[1]);
    note = await required(business.query("deliveryNotes.get", { id: made.id }));
    assert.equal(note.comment, "Überarbeiteter Lieferschein");
    const change = { id: made.id, expectedRevision: note.revision, expectedPriceRevision: note.priceRevision, data: {
        records: note.records.map(row => ({ id: row.id, productId: row.productId, quantity: 3.625, unit: row.unit })),
        specialRecords: note.specialRecords.map(row => ({ id: row.id, name: row.name, unit: row.unit, amount: 2.25 }))
      } };
    await required(business.mutate("deliveryNotes.update", change));
    let updated = await required(business.query("deliveryNotes.get", { id: made.id }));
    assert.equal(updated.records[0]!.id, note.records[0]!.id);
    assert.equal(updated.records[0]!.comment, note.records[0]!.comment);
    assert.equal(updated.specialRecords[0]!.id, note.specialRecords[0]!.id);
    assert.equal(updated.specialRecords[0]!.comment, note.specialRecords[0]!.comment);
    assert.equal(updated.specialRecords[0]!.pricePerUnit, price);
    await required(business.mutate("deliveryNotes.update", { id: made.id, expectedRevision: updated.revision, expectedPriceRevision: updated.priceRevision, data: { specialRecords: updated.specialRecords.map(row => ({ id: row.id, name: row.name, unit: row.unit, amount: row.amount, pricePerUnit: 12345.6789 })) } }));
    const priced = await required(business.query("deliveryNotes.get", { id: made.id }));
    assert.equal(priced.revision, updated.revision);
    assert.equal(priced.specialRecords[0]!.pricePerUnit, 12345.6789);
    assert.ok((await business.mutate("deliveryNotes.update", { id: made.id, expectedRevision: updated.revision, expectedPriceRevision: updated.priceRevision, data: { specialRecords: priced.specialRecords.map(row => ({ id: row.id, name: row.name, unit: row.unit, amount: row.amount, pricePerUnit: 1 })) } }))[1]);
    const area = deliveryCollection(projectId), pricing = deliveryCollection(projectId, true);
    const status = await required(client.query("zerotrust.status", undefined)), authority = await openAuthority(client, status.profile), subject = `user:${(await required(client.query("auth.sessionInfo", undefined))).user.id}`;
    const signed = record(await required(client.query("zerotrust.policy.get", undefined)), ["tenant", "version", "rules", "signature"]), permissions = policy({ tenant: signed.tenant, version: signed.version, rules: signed.rules });
    await required(client.mutate("zerotrust.policy.replace", await signPolicy({ ...permissions, version: (BigInt(permissions.version) + 1n).toString(), rules: permissions.rules.filter(rule => rule.subject !== subject || rule.scope !== pricing.scope || rule.facet !== pricing.facet) }, authority)));
    try {
      const scoped = createBusinessClient(observed, { productDriver: driver }), start = requests.length;
      try {
        await required(scoped.mutate("deliveryNotes.update", { id: made.id, expectedRevision: priced.revision, data: { specialRecords: priced.specialRecords.map(row => ({ id: row.id, name: row.name, unit: row.unit, amount: 3.75 })) } }));
      }
      finally {
        scoped.dispose();
      }
      assert.equal(requests.slice(start).some(request => ["zerotrust.keys.get", "zerotrust.objects.list"].includes(request.path) && (request.input as {
        domain?: string;
      })?.domain === pricing.domain), false);
      const collection = await protectedCollection(client, area, new AbortController().signal);
      try {
        const original = (await collection.read(area.prefix + made.id)).find(row => row.envelope.object === area.prefix + made.id)!;
        const wrong = structuredClone(original.value) as {
          note: {
            values: {
              auto_id: string;
            };
          };
        };
        wrong.note.values.auto_id = "1";
        const packet = await collection.packet(original.envelope.object, wrong, original.envelope);
        await collection.write([packet]);
        const honest = createBusinessClient(observed, { productDriver: driver });
        try {
          assert.ok((await honest.query("deliveryNotes.get", { id: made.id }))[1], "A correctly signed fake note number must fail registry validation");
        }
        finally {
          honest.dispose();
        }
        await collection.write([await collection.packet(original.envelope.object, original.value, encryptedObject(packet.envelope))]);
      }
      finally {
        collection.close();
      }
    }
    finally {
      const latest = await required(client.query("zerotrust.policy.get", undefined));
      await required(client.mutate("zerotrust.policy.replace", await signPolicy({ ...permissions, version: (BigInt((latest as {
          version: string;
        }).version) + 1n).toString() }, authority)));
      await finishAccessChanges(client, new AbortController().signal);
    }
    const final = createBusinessClient(peer, { productDriver: driver });
    try {
      updated = await required(final.query("deliveryNotes.get", { id: made.id }));
      assert.equal(updated.specialRecords[0]!.amount, 3.75);
      assert.equal(updated.specialRecords[0]!.pricePerUnit, 12345.6789);
    }
    finally {
      final.dispose();
    }
    assert.ok((await business.mutate("deliveryNotes.update", { id: made.id, data: { projectId: anotherProject.id } }))[1]);
    let release = () => { };
    const wait = new Promise<void>(done => { release = done; });
    barrier = { count: 0, release, wait };
    await other.invalidate("deliveryNotes.get");
    const current = await required(other.query("deliveryNotes.get", { id: made.id }));
    const contenders = [createBusinessClient(observed, { productDriver: driver }), createBusinessClient(observed, { productDriver: driver })];
    try {
      const results = await Promise.all(contenders.map((store, index) => store.mutate("deliveryNotes.update", { id: made.id, expectedRevision: current.revision, data: { comment: `Concurrent delivery edit ${index}` } })));
      assert.equal(results.filter(([, error]) => !error).length, 1);
    }
    finally {
      barrier = null;
      for (const store of contenders)
        store.dispose();
    }
    for (const text of [marker, "98765.4321", "12345.6789", "Position bleibt erhalten"])
      assert.equal(JSON.stringify(requests).includes(text), false);
    console.log("Encrypted delivery writes verified: global cross-instance numbering, lost allocation/publication replies, stable create retry, discarded ACKs, concurrent projects, stable line IDs/comments, hidden-price preservation, price-only updates, stale-form rejection, registry tamper detection and concurrent CAS.");
  }
  finally {
    business.dispose();
    other.dispose();
    await peer.logout();
  }
}
