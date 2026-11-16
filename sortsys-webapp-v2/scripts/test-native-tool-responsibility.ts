import assert from "node:assert/strict";
import { RpcClientError, type Client } from "@sortsys/v2-client";
import {
  areaKey,
  base64,
  bytes,
  domainBoxSigner,
  encryptObject,
  decryptObject,
  encryptedObject,
  openBox,
  randomSecret,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { TOOL_MODEL, toolCollection } from "../app/lib/data/toolData";
import { toolResponsibilityPacket } from "../app/lib/data/toolResponsibility";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
import { signIn, unlockedAccount } from "../app/lib/crypto/session";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { DEVELOPMENT_PASSWORD } from "./development/seed";

export async function exerciseNativeToolResponsibility(
  owner: Client,
  member: Client,
  tenant = "development-seed",
) {
  const signal = new AbortController().signal;
  const operationId = publicId(newProductRowId());
  const marker = "Private automatic tool responsibility 672914";
  async function login(client: Client, username: string) {
    await signIn(client, { tenant, username, password: DEVELOPMENT_PASSWORD });
    return required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
  }
  const frank = await login(member, "frank.doe");
  const subject = `user:${frank.user.id}`;
  const [, alias] = await member.query(
    "zerotrust.identities.get",
    {
      subject: `user:0${frank.user.id}`,
    },
    { strategy: "network-only" },
  );
  assert.equal(alias?.code, "BAD_REQUEST");
  await login(owner, "john.doe");
  const business = createBusinessClient(owner, { productDriver: duckDriver });
  let toolId: string;
  let initialDefinition: Awaited<ReturnType<typeof getDefinition>>;
  let retainedKey: CryptoKey | undefined;
  async function getDefinition() {
    return required(
      owner.query(
        "zerotrust.domains.get",
        {
          domain: `tool-tracking:${operationId}:master-data`,
          generation: "1",
        },
        { strategy: "network-only" },
      ),
    );
  }
  try {
    const customId = await required(
      business.query("tools.suggestNextCustomId", undefined),
    );
    const created = await required(
      business.mutate("tools.create", {
        customId,
        brand: marker,
        category: "Montage",
        label: "Zuständigkeitstest",
        purchasePrice: 1397.5,
        usageCostPerDay: 37.25,
      }),
    );
    toolId = created.id;
    const booked = await required(
      business.mutate("tools.trackMany", {
        operationId,
        tools: [{ id: toolId, expectedTrackingId: null }],
        data: { responsibleUserId: frank.user.id, comment: marker },
      }),
    );
    assert.deepEqual(booked.trackings, [{ toolId, trackingId: operationId }]);
    initialDefinition = await getDefinition();
    const area = toolCollection("tool-tracking", operationId, "master-data");
    const collection = await protectedCollection(owner, area, signal);
    try {
      const [previous] = await collection.read();
      assert.ok(previous);
      const packet = await collection.packet(
        area.prefix,
        previous.value,
        previous.envelope,
      );
      assert.ok(packet.resourceAccess);
      const { resourceAccess, ...stripped } = packet;
      const heads = [
        { domain: area.domain, sequence: await collection.inspect() },
      ];
      const [, missing] = await owner.mutate("zerotrust.objects.batch", {
        objects: [stripped],
        heads,
      });
      assert.ok(missing instanceof RpcClientError);
      assert.equal(missing.code, "BAD_REQUEST");
      const [, tampered] = await owner.mutate("zerotrust.objects.batch", {
        objects: [
          { ...packet, resourceAccess: { ...resourceAccess, active: false } },
        ],
        heads,
      });
      assert.ok(tampered instanceof RpcClientError);
      assert.equal(tampered.code, "BAD_REQUEST");
      const [unchanged] = await collection.read();
      assert.equal(unchanged?.envelope.signature, previous.envelope.signature);
    } finally {
      collection.close();
    }
  } finally {
    business.dispose();
  }

  await login(member, "frank.doe");
  const restricted = createBusinessClient(member, {
    productDriver: duckDriver,
  });
  try {
    const bookings = await required(
      restricted.query("tools.trackings.list", {}),
    );
    const assigned = bookings.find((booking) => booking.id === operationId);
    assert.ok(
      assigned,
      "The responsible member receives their new booking without a manual grant",
    );
    assert.equal(assigned.comment, marker);
    assert.equal(assigned.responsibleUserId, frank.user.id);
    assert.equal(assigned.toolUsageCostPerDay, null);
    assert.equal(assigned.toolSummary?.brand, marker);
    assert.equal(assigned.toolSummary?.id, toolId!);
    assert.equal(Object.hasOwn(assigned.toolSummary!, "purchasePrice"), false);
    const [, costs] = await member.query(
      "zerotrust.keys.get",
      {
        domain: `tool-tracking:${operationId}:procurement`,
        generation: "1",
      },
      { strategy: "network-only" },
    );
    assert.equal(costs?.code, "FORBIDDEN");

    const access = await verifiedAccessContext(member, signal);
    const account = unlockedAccount();
    assert.ok(account);
    const area = toolCollection("tool-tracking", operationId, "master-data");
    const definition = await verifyDomain(
      await required(
        member.query(
          "zerotrust.domains.get",
          {
            domain: area.domain,
            generation: "1",
          },
          { strategy: "network-only" },
        ),
      ),
      {
        tenant,
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: "1",
      },
      access.history.authority,
    );
    const box = await required(
      member.query(
        "zerotrust.keys.get",
        { domain: area.domain, generation: "1" },
        { strategy: "network-only" },
      ),
    );
    const raw = await openBox(
      box,
      {
        tenant,
        purpose: "area-key",
        object: area.domain,
        generation: "1",
        recipient: subject,
        author: box.author,
      },
      account.identity.encryptionKey.privateKey,
      await domainBoxSigner(definition, box, access.history.authority),
    );
    try {
      retainedKey = await areaKey(raw);
      const collection = await protectedCollection(member, area, signal);
      try {
        const [previous] = await collection.read();
        assert.ok(previous);
        const envelope = await encryptObject(
          {
            tenant: previous.envelope.tenant,
            scope: previous.envelope.scope,
            facet: previous.envelope.facet,
            object: previous.envelope.object,
            generation: previous.envelope.generation,
            revision: (BigInt(previous.envelope.revision) + 1n).toString(),
            author: subject,
            policyVersion: access.rootPolicy.version,
          },
          bytes(JSON.stringify(previous.value)),
          retainedKey,
          account.identity.signingKey.privateKey,
        );
        const origin = access.origins.find(
          (origin) => origin.id === area.domain,
        );
        const resourceAccess = await toolResponsibilityPacket(
          origin,
          envelope,
          previous.value,
          access.history.identityCertificate(subject),
          account.identity.signingKey.privateKey,
        );
        const [, denied] = await member.mutate("zerotrust.objects.batch", {
          objects: [
            {
              domain: area.domain,
              messageId: `msg_${base64(randomSecret())}`,
              envelope,
              resourceAccess,
            },
          ],
          heads: [
            { domain: area.domain, sequence: await collection.inspect() },
          ],
        });
        assert.equal(
          denied instanceof RpcClientError ? denied.code : null,
          "FORBIDDEN",
          "Read keys and a valid state signature confer no write permission",
        );
      } finally {
        collection.close();
      }
    } finally {
      raw.fill(0);
    }
  } finally {
    restricted.dispose();
  }

  await login(owner, "john.doe");
  const management = createBusinessClient(owner, { productDriver: duckDriver });
  try {
    await required(management.mutate("tools.untrack", { id: toolId! }));
    const afterClose = await required(
      owner.query(
        "zerotrust.access.snapshot",
        {},
        { strategy: "network-only" },
      ),
    );
    const area = toolCollection("tool-tracking", operationId, "master-data");
    const following = await protectedCollection(owner, area, signal);
    try {
      const [previous] = await following.read();
      assert.ok(previous);
      const value = TOOL_MODEL.decode(
        structuredClone(previous.value),
        area.prefix,
        area,
      );
      value.rows[0]!.values.comment =
        "Private comment after responsibility ended";
      const packet = await following.packet(
        area.prefix,
        value,
        previous.envelope,
      );
      assert.equal(packet.envelope.generation, "2");
      await required(
        owner.mutate("zerotrust.objects.batch", {
          objects: [packet],
          heads: [{ domain: area.domain, sequence: await following.inspect() }],
        }),
      );
      assert.ok(retainedKey);
      const account = unlockedAccount();
      assert.ok(account);
      await assert.rejects(() =>
        decryptObject(
          packet.envelope,
          {
            tenant,
            scope: area.scope,
            facet: "master-data",
            object: area.prefix,
            revision: packet.envelope.revision,
            generation: packet.envelope.generation,
            policyVersion: packet.envelope.policyVersion,
            author: packet.envelope.author,
          },
          retainedKey!,
          account.identity.signingKey.publicKey,
        ),
      );
      const stable = await required(
        owner.query(
          "zerotrust.access.snapshot",
          { known: afterClose.snapshot },
          { strategy: "network-only" },
        ),
      );
      assert.equal(
        stable.unchanged,
        true,
        "A content edit with unchanged access does not invalidate the full permission inventory",
      );
      const reopened = structuredClone(value);
      reopened.rows[0]!.values.ended_at = null;
      const reopenPacket = await following.packet(
        area.prefix,
        reopened,
        encryptedObject(packet.envelope),
      );
      assert.equal(reopenPacket.resourceAccess?.active, true);
      const [, reopenError] = await owner.mutate("zerotrust.objects.batch", {
        objects: [reopenPacket],
        heads: [{ domain: area.domain, sequence: await following.inspect() }],
      });
      assert.ok(reopenError instanceof RpcClientError);
      assert.equal(
        reopenError?.code,
        "CONFLICT",
        "Even a newly signed administrator packet cannot reactivate a closed assignment",
      );
      const [unchanged] = await following.read();
      assert.equal(unchanged?.envelope.signature, packet.envelope.signature);
    } finally {
      following.close();
    }
    const closed = await required(
      owner.query(
        "zerotrust.creations.origin",
        {
          domain: `tool-tracking:${operationId}:master-data`,
        },
        { strategy: "network-only" },
      ),
    );
    assert.equal(closed?.access?.active, false);
    const [, replay] = await owner.mutate(
      "zerotrust.domains.put",
      initialDefinition!,
    );
    if (replay) {
      assert.ok(replay instanceof RpcClientError);
      assert.equal(replay.code, "CONFLICT");
    }
    const retained = await required(
      owner.query(
        "zerotrust.creations.origin",
        {
          domain: `tool-tracking:${operationId}:master-data`,
        },
        { strategy: "network-only" },
      ),
    );
    assert.equal(
      retained?.access?.signature,
      closed?.access?.signature,
      "Replaying a definition without the optional access field cannot reopen a closed assignment",
    );
  } finally {
    management.dispose();
  }

  await login(member, "frank.doe");
  const ended = createBusinessClient(member, { productDriver: duckDriver });
  try {
    const bookings = await required(ended.query("tools.trackings.list", {}));
    assert.equal(
      bookings.some((booking) => booking.id === operationId),
      false,
    );
    for (const facet of ["master-data", "scope", "procurement"] as const) {
      const [, denied] = await member.query(
        "zerotrust.keys.get",
        {
          domain: `tool-tracking:${operationId}:${facet}`,
          generation: "1",
        },
        { strategy: "network-only" },
      );
      assert.equal(denied?.code, "FORBIDDEN");
    }
  } finally {
    ended.dispose();
  }
  await login(owner, "john.doe");
  const offlinePersonnel = createBusinessClient(owner, {
    productDriver: duckDriver,
  });
  try {
    const staff = await required(
      offlinePersonnel.mutate("users.create", {
        username: `pending.tool.${operationId}`,
        firstName: "Unangemeldet",
        lastName: "Werkzeugzuständigkeit",
      }),
    );
    const [certificate, certificateError] = await owner.query(
      "zerotrust.identities.get",
      {
        subject: `user:${staff.id}`,
      },
      { strategy: "network-only" },
    );
    assert.equal(certificateError, null);
    assert.equal(certificate, null);
    const pendingId = publicId(newProductRowId());
    await required(
      offlinePersonnel.mutate("tools.trackMany", {
        operationId: pendingId,
        tools: [{ id: toolId!, expectedTrackingId: null }],
        data: { responsibleUserId: staff.id },
      }),
    );
    const bookings = await required(
      offlinePersonnel.query("tools.trackings.list", {}),
    );
    assert.equal(
      bookings.find((booking) => booking.id === pendingId)?.responsibleUserId,
      staff.id,
      "A staff member without a registered encryption identity can still receive a physical tool",
    );
    await required(offlinePersonnel.mutate("tools.untrack", { id: toolId! }));
  } finally {
    offlinePersonnel.dispose();
  }
  console.log(
    "Tool responsibility verified: automatic read grants, hidden costs, rejected reader writes, atomic state binding and revocation after return across API instances.",
  );
}
