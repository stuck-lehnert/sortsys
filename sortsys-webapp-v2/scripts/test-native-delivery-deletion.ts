import assert from "node:assert/strict";
import { createClient, RpcClientError, type Client } from "@sortsys/v2-client";
import {
  areaKey,
  domainBoxSigner,
  encryptTombstone,
  openBox,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
import {
  approveMemberInvitation,
  createMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import {
  deliveryCollection,
  deliveryPayload,
  type DeliveryPayload,
} from "../app/lib/data/deliveryNoteData";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

export type DeliveryRequestHook = (
  url: URL,
  next: (replacement?: URL) => Promise<Response>,
) => Promise<Response>;

async function assertServerRejectsReaderDeletion(
  client: Client,
  projectId: string,
  id: string,
  signal: AbortSignal,
) {
  const area = deliveryCollection(projectId);
  const collection = await protectedCollection(client, area, signal);
  try {
    const original = await collection.get(area.prefix + id);
    const context = await verifiedAccessContext(client, signal);
    const authorization = collection.authorization();
    const definition = await verifyDomain(
      await required(
        client.query(
          "zerotrust.domains.get",
          {
            domain: area.domain,
            generation: authorization.keyGeneration,
          },
          { strategy: "network-only" },
        ),
      ),
      {
        tenant: context.account.tenant,
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: authorization.keyGeneration,
      },
      context.history.authority,
    );
    const box = await required(
      client.query(
        "zerotrust.keys.get",
        {
          domain: area.domain,
          generation: authorization.keyGeneration,
        },
        { strategy: "network-only" },
      ),
    );
    const raw = await openBox(
      box,
      {
        tenant: context.account.tenant,
        purpose: "area-key",
        object: area.domain,
        generation: authorization.keyGeneration,
        recipient: context.subject,
        author: box.author,
      },
      context.account.identity.encryptionKey.privateKey,
      await domainBoxSigner(definition, box, context.history.authority),
    );
    try {
      // Bypass the browser's delete guard with a correctly encrypted tombstone
      // signed by the authenticated reader. Only the server's policy can deny it.
      const envelope = await encryptTombstone(
        {
          tenant: context.account.tenant,
          scope: area.scope,
          facet: area.facet,
          object: original.envelope.object,
          generation: authorization.keyGeneration,
          revision: (BigInt(original.envelope.revision) + 1n).toString(),
          policyVersion: authorization.policyVersion,
          author: context.subject,
        },
        await areaKey(raw),
        context.account.identity.signingKey.privateKey,
      );
      const [, error] = await client.mutate("zerotrust.objects.batch", {
        objects: [
          {
            domain: area.domain,
            messageId: `msg_${crypto.randomUUID()}`,
            envelope,
          },
        ],
        heads: [
          {
            domain: area.domain,
            sequence: await collection.inspect(
              undefined,
              original.envelope.object,
            ),
          },
        ],
      });
      assert.ok(error instanceof RpcClientError);
      assert.equal(error.code, "FORBIDDEN");
    } finally {
      raw.fill(0);
    }
  } finally {
    collection.close();
  }
}

/** Exercise the business facade, signed object publications and parent-driven
 * cost visibility against the ordinary disposable API replicas. */
export async function exerciseNativeDeliveryDeletion(
  owner: Client,
  peer: Client,
  projectId: string,
  id: string,
  setRequestHook: (hook: DeliveryRequestHook | null) => void,
) {
  const signal = new AbortController().signal;
  const master = deliveryCollection(projectId);
  const prices = deliveryCollection(projectId, true);
  const note = await required(
    owner.query("deliveryNotes.get", { id }, { strategy: "network-only" }),
  );
  assert.ok(note.revision);
  const source = await protectedCollection(owner, master, signal);
  const costs = await protectedCollection(owner, prices, signal);
  let replayNote;
  let replayPrice;
  let oldPriceHead;
  let template: DeliveryPayload;
  try {
    const original = (await source.read()).find(
      (object) => object.envelope.object === master.prefix + id,
    );
    const originalPrice = (await costs.read()).find(
      (object) => object.envelope.object === prices.prefix + id,
    );
    assert.ok(original);
    assert.ok(originalPrice);
    template = deliveryPayload(
      original.value,
      original.envelope.object,
      projectId,
    );
    oldPriceHead = costs.snapshot()!;
    replayPrice = await costs.packet(
      originalPrice.envelope.object,
      originalPrice.value,
      originalPrice.envelope,
    );
    // Prepare the next live revision after a potential tombstone. A rejection
    // must enforce deletion rather than merely catch an outdated revision.
    replayNote = await source.packet(original.envelope.object, original.value, {
      ...original.envelope,
      revision: (BigInt(original.envelope.revision) + 1n).toString(),
    });
  } finally {
    source.close();
    costs.close();
  }
  assert.ok(
    (
      await peer.mutate("deliveryNotes.delete", {
        id,
        expectedRevision: (BigInt(note.revision) + 1n).toString(),
      })
    )[1],
    "a stale confirmation cannot delete a newer or older revision",
  );

  let fakeAcknowledgement = false;
  setRequestHook(async (url, next) => {
    if (!url.pathname.slice(1).split(",").includes("zerotrust.objects.batch"))
      return next();
    assert.equal(url.pathname, "/zerotrust.objects.batch");
    fakeAcknowledgement = true;
    return Response.json([
      { result: { data: { json: { success: true, heads: [] } } } },
    ]);
  });
  try {
    assert.ok(
      (
        await owner.mutate("deliveryNotes.delete", {
          id,
          expectedRevision: note.revision,
        })
      )[1],
    );
    assert.equal(fakeAcknowledgement, true);
  } finally {
    setRequestHook(null);
  }
  assert.equal(
    (
      await required(
        peer.query("deliveryNotes.get", { id }, { strategy: "network-only" }),
      )
    ).revision,
    note.revision,
  );

  let lostAcknowledgement = false;
  setRequestHook(async (url, next) => {
    const response = await next();
    if (
      lostAcknowledgement ||
      !url.pathname.slice(1).split(",").includes("zerotrust.objects.batch")
    )
      return response;
    const reply = await response.json();
    assert.ok(reply[0]?.result?.data?.json?.success);
    lostAcknowledgement = true;
    throw new TypeError("Lost delivery deletion acknowledgement after commit");
  });
  try {
    await required(
      owner.mutate("deliveryNotes.delete", {
        id,
        expectedRevision: note.revision,
      }),
    );
    assert.equal(lostAcknowledgement, true);
  } finally {
    setRequestHook(null);
  }
  await required(
    peer.mutate("deliveryNotes.delete", {
      id,
      expectedRevision: note.revision,
    }),
  );
  assert.ok(
    (
      await peer.mutate("deliveryNotes.delete", {
        id,
        expectedRevision: (BigInt(note.revision) + 1n).toString(),
      })
    )[1],
    "an existing tombstone cannot acknowledge a different confirmed revision",
  );
  for (const input of [{ id }, { autoId: note.autoId }]) {
    assert.ok(
      (
        await peer.query("deliveryNotes.get", input, {
          strategy: "network-only",
        })
      )[1],
    );
  }
  assert.equal(
    (
      await peer.query(
        "zerotrust.deliveryNotes.locate",
        { id },
        { strategy: "network-only" },
      )
    )[1]?.code,
    "NOT_FOUND",
  );
  assert.equal(
    (
      await peer.query(
        "zerotrust.objects.get",
        { id: prices.prefix + id },
        { strategy: "network-only" },
      )
    )[1]?.code,
    "NOT_FOUND",
  );
  const [, staleSnapshot] = await peer.query(
    "zerotrust.objects.list",
    {
      domain: prices.domain,
      prefix: prices.prefix,
      snapshot: oldPriceHead!,
      after: null,
    },
    { strategy: "network-only" },
  );
  assert.equal(
    staleSnapshot?.code,
    "CONFLICT",
    "deleting a note invalidates the cost snapshot in the same transaction",
  );
  for (const [area, packet] of [
    [master, replayNote!],
    [prices, replayPrice!],
  ] as const) {
    const head = await required(
      peer.query(
        "zerotrust.objects.list",
        {
          domain: area.domain,
          prefix: area.prefix,
          after: null,
          snapshot: null,
        },
        { strategy: "network-only" },
      ),
    );
    assert.deepEqual(
      head.objects.filter((object) => object.object === prices.prefix + id),
      [],
    );
    const [, resurrection] = await owner.mutate("zerotrust.objects.batch", {
      objects: [packet],
      heads: [{ domain: area.domain, sequence: head.snapshot }],
    });
    assert.ok(
      resurrection,
      "a deleted note and its private prices cannot be revived even under the current domain head",
    );
  }
  console.log(
    "Native delivery deletion: stale confirmation, false and lost acknowledgements, authenticated retry, dependent cost snapshot and signed resurrection rejection verified",
  );

  const second = await required(
    owner.mutate("deliveryNotes.create", {
      requestId: crypto.randomUUID(),
      projectId,
      specialRecords: [
        {
          name: "Fensteranschlussprofil",
          amount: 2.5,
          unit: "m",
          pricePerUnit: 19.75,
        },
      ],
    }),
  );
  // These imperative native-test facades have no live subscription. Refresh
  // the peer's retained empty collection before reading the newly created note.
  await peer.invalidate("deliveryNotes.get");
  const secondNote = await required(
    peer.query(
      "deliveryNotes.get",
      { id: second.id },
      { strategy: "network-only" },
    ),
  );
  assert.ok(
    secondNote.autoId > note.autoId,
    "deleting a delivery note never releases its assigned number",
  );
  console.log(
    "Native delivery deletion: replacement note remains readable and numbering increases",
  );
  const member = await required(
    owner.mutate("users.create", {
      username: "delivery.deleter",
      firstName: "Lieferschein",
      lastName: "Bearbeitung",
      email: null,
      phone: null,
      costPerHour: 0,
      vacationDaysPerYear: 28,
      contractType: "internal",
      supervisorUserId: null,
    }),
  );
  const account = unlockedAccount()!;
  const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS!);
  const rawMember = createClient(endpoints[0], "native-delivery-deleter");
  let colleague: ReturnType<typeof createBusinessClient> | undefined;
  const unlockOwner = () =>
    acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
  try {
    const invitation = await createMemberInvitation(
      owner,
      { id: member.id, username: "delivery.deleter" },
      {
        catalogue: "none",
        customers: "none",
        contacts: "none",
        vendors: "none",
        prices: "none",
        assistant: false,
      },
      signal,
    );
    await signInMemberInvitation(
      rawMember,
      invitation.link,
      "Private-delivery-deleter-2026!",
      signal,
    );
    const memberAccount = unlockedAccount()!;
    await unlockOwner();
    const lease = acquireDataRuntime(owner, signal, duckDriver);
    try {
      await approveMemberInvitation(
        owner,
        invitation.link.invitation.id,
        signal,
      );
    } finally {
      lease.close();
    }
    await changeAreaActionAccesses(
      owner,
      `user:${member.id}`,
      [{ area: master, patch: { read: true, delete: false } }],
      signal,
    );
    console.log(
      "Native delivery deletion: ordinary member enrolled with quantity-only read access",
    );
    await acceptVaultWithKey(
      memberAccount.dataKey,
      memberAccount.vault,
      memberAccount.username,
      false,
    );
    colleague = createBusinessClient(rawMember, { productDriver: duckDriver });
    assert.deepEqual(
      (await required(rawMember.query("auth.sessionInfo", undefined))).roles,
      [],
    );
    const visible = await required(
      colleague.query(
        "deliveryNotes.get",
        { id: second.id },
        { strategy: "network-only" },
      ),
    );
    assert.equal(visible.specialRecords[0]!.pricePerUnit, null);
    await assertServerRejectsReaderDeletion(
      rawMember,
      projectId,
      second.id,
      signal,
    );
    assert.ok(
      (
        await colleague.mutate("deliveryNotes.delete", {
          id: second.id,
          expectedRevision: visible.revision,
        })
      )[1],
    );
    await unlockOwner();
    assert.equal(
      (
        await required(
          peer.query(
            "deliveryNotes.get",
            { id: second.id },
            { strategy: "network-only" },
          ),
        )
      ).specialRecords[0]!.pricePerUnit,
      19.75,
    );
    await changeAreaActionAccesses(
      owner,
      `user:${member.id}`,
      [{ area: master, patch: { delete: true, create: false, update: false } }],
      signal,
    );
    await acceptVaultWithKey(
      memberAccount.dataKey,
      memberAccount.vault,
      memberAccount.username,
      false,
    );
    assert.ok(
      (
        await rawMember.query(
          "zerotrust.keys.get",
          {
            domain: prices.domain,
            generation: replayPrice!.envelope.generation,
          },
          { strategy: "network-only" },
        )
      )[1],
    );
    await required(
      colleague.mutate("deliveryNotes.delete", {
        id: second.id,
        expectedRevision: visible.revision,
      }),
    );
    await unlockOwner();
    assert.ok(
      (
        await peer.query(
          "deliveryNotes.get",
          { id: second.id },
          { strategy: "network-only" },
        )
      )[1],
    );
    assert.equal(
      (
        await peer.query(
          "zerotrust.objects.get",
          { id: prices.prefix + second.id },
          { strategy: "network-only" },
        )
      )[1]?.code,
      "NOT_FOUND",
    );
    console.log(
      "Native delivery deletion: ordinary read-only member is denied, explicit delete works without create/update rights or a cost key, and private prices disappear across replicas",
    );
  } finally {
    colleague?.dispose();
    await unlockOwner();
  }
  const { exerciseNativeDeliveryPagination } =
    await import("./test-native-delivery-pagination");
  await exerciseNativeDeliveryPagination(
    owner,
    peer,
    projectId,
    template!,
    signal,
  );
}
