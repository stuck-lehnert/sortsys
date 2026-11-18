import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createClient,
  RpcClientError,
  type Client,
  type MutateInput,
  type MutateResult,
} from "@sortsys/v2-client";
import {
  areaKey,
  bytes,
  decryptObject,
  domainBoxSigner,
  encryptObject,
  openBox,
  verifyDomain,
  type EncryptedObject,
  verify,
  objectFrame,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
import {
  createMemberInvitation,
  signInMemberInvitation,
  approveMemberInvitation,
} from "../app/lib/crypto/invitations";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { synchronizeToolResponsibilityDefaults } from "../app/lib/crypto/toolResponsibilityDefaults";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { newProductRowId, publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { toolCollection } from "../app/lib/data/toolData";
import { toolResponsibilityPacket } from "../app/lib/data/toolResponsibility";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

export async function exerciseLateToolResponsibility(
  owner: Client,
  peer: Client,
) {
  const signal = new AbortController().signal;
  const ownerAccount = unlockedAccount()!;
  const unlockOwner = () =>
    acceptVaultWithKey(
      ownerAccount.dataKey,
      ownerAccount.vault,
      ownerAccount.username,
      false,
    );
  let stripOneState = true;
  const observed: Client = {
    ...owner,
    mutate: (async (path, input, options) => {
      if (path === "zerotrust.objects.batch" && stripOneState) {
        const changed = structuredClone(
          input as MutateInput<"zerotrust.objects.batch">,
        );
        for (const packet of changed.objects) {
          if (packet.resourceAccess?.active) {
            // Represent a real earlier booking that predates live-state proofs.
            delete packet.resourceAccess;
            stripOneState = false;
            return owner.mutate("zerotrust.objects.batch", changed, options);
          }
        }
      }
      return owner.mutate(path, input, options);
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, {
    productDriver: duckDriver,
  });
  const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS!);
  const member = createClient(endpoints[1], "native-late-tool-member");
  let restricted: ReturnType<typeof createBusinessClient> | undefined;
  try {
    const person = await required(
      business.mutate("users.create", {
        username: "late.tool.member",
        firstName: "Später",
        lastName: "Werkzeugzugang",
        email: null,
        phone: null,
        costPerHour: 0,
        vacationDaysPerYear: 28,
        contractType: "internal",
        supervisorUserId: null,
      }),
    );
    const tools: MutateResult<"tools.create">[] = [];
    for (const label of ["Aktive Ausgabe", "Frühere Ausgabe"]) {
      const customId = await required(
        business.query("tools.suggestNextCustomId", undefined),
      );
      tools.push(
        await required(
          business.mutate("tools.create", {
            customId,
            brand: "Privater Werkzeugbestand 571943",
            category: "Montage",
            label,
            purchasePrice: 1479.25,
            usageCostPerDay: 23.875,
          }),
        ),
      );
    }
    const bookings = [];
    for (const tool of tools) {
      const operationId = publicId(newProductRowId());
      const result = await required(
        business.mutate("tools.trackMany", {
          operationId,
          tools: [{ id: tool.id, expectedTrackingId: null }],
          data: {
            responsibleUserId: person.id,
            comment: "Vertrauliche Ausgabe vor der Registrierung",
          },
        }),
      );
      bookings.push(result.trackings[0]!);
    }
    assert.equal(stripOneState, false);
    await required(business.mutate("tools.untrack", { id: tools[1]!.id }));
    const area = toolCollection(
      "tool-tracking",
      bookings[0]!.trackingId,
      "master-data",
    );
    const before = await required(
      peer.query(
        "zerotrust.creations.origin",
        { domain: area.domain },
        { strategy: "network-only" },
      ),
    );
    assert.ok(before);
    assert.equal(before.assignee, undefined);
    assert.equal(before.access, undefined);
    const original = await required(
      peer.query(
        "zerotrust.objects.get",
        { id: area.prefix },
        { strategy: "network-only" },
      ),
    );
    const invitation = await createMemberInvitation(
      observed,
      { id: person.id, username: "late.tool.member" },
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
      member,
      invitation.link,
      "Late-tool-member-password-2026!",
      signal,
    );
    const account = unlockedAccount()!;
    await unlockOwner();
    await approveMemberInvitation(
      observed,
      invitation.link.invitation.id,
      signal,
      duckDriver,
    );
    const checkpoint = await required(
      peer.query(
        "zerotrust.creations.origin",
        { domain: area.domain },
        { strategy: "network-only" },
      ),
    );
    assert.ok(checkpoint?.access?.active);
    assert.equal(checkpoint.assignee, undefined);
    assert.equal(
      BigInt(checkpoint.access.revision),
      BigInt(original.revision) + 1n,
    );
    const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
    assert.ok(root);
    await writeFile(
      join(root, "tool-authorization-witness.json"),
      JSON.stringify({
        tenant: checkpoint.tenant,
        domain: area.domain,
        origin: checkpoint,
      }),
      { mode: 0o600 },
    );
    const policy = await required(
      peer.query("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      }),
    );
    await synchronizeToolResponsibilityDefaults(observed, signal, duckDriver);
    assert.equal(
      (
        await required(
          peer.query("zerotrust.policy.get", undefined, {
            strategy: "network-only",
          }),
        )
      ).signature,
      policy.signature,
    );
    assert.equal(
      (
        await required(
          peer.query(
            "zerotrust.objects.get",
            { id: area.prefix },
            { strategy: "network-only" },
          ),
        )
      ).signature,
      checkpoint.access.packetSignature,
    );

    await acceptVaultWithKey(
      account.dataKey,
      account.vault,
      account.username,
      false,
    );
    restricted = createBusinessClient(member, { productDriver: duckDriver });
    const assigned = await required(
      restricted.query("tools.trackings.list", {}),
    );
    assert.deepEqual(
      assigned.map((booking) => booking.id),
      [bookings[0]!.trackingId],
    );
    assert.equal(assigned[0]!.toolUsageCostPerDay, null);
    assert.equal(
      assigned[0]!.toolSummary?.brand,
      "Privater Werkzeugbestand 571943",
    );
    for (const forbidden of [
      toolCollection("tool", tools[0]!.id, "master-data"),
      toolCollection("tool-tracking", bookings[0]!.trackingId, "procurement"),
      toolCollection("tool-tracking", bookings[1]!.trackingId, "master-data"),
    ]) {
      const [, error] = await member.query(
        "zerotrust.keys.get",
        { domain: forbidden.domain, generation: "1" },
        { strategy: "network-only" },
      );
      assert.equal(error?.code, "FORBIDDEN");
    }
    const access = await verifiedAccessContext(member, signal, {
      domain: area.domain,
    });
    const domain = access.domains.find((domain) => domain.id === area.domain)!;
    const definition = await verifyDomain(
      await required(
        member.query(
          "zerotrust.domains.get",
          {
            domain: area.domain,
            generation: domain.generation,
          },
          { strategy: "network-only" },
        ),
      ),
      {
        tenant: account.tenant,
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: domain.generation,
      },
      access.history.authority,
    );
    const box = await required(
      member.query(
        "zerotrust.keys.get",
        { domain: area.domain, generation: domain.generation },
        { strategy: "network-only" },
      ),
    );
    const raw = await openBox(
      box,
      {
        tenant: account.tenant,
        purpose: "area-key",
        object: area.domain,
        generation: domain.generation,
        recipient: account.vault.subject,
        author: box.author,
      },
      account.identity.encryptionKey.privateKey,
      await domainBoxSigner(definition, box, access.history.authority),
    );
    const retainedKey = await areaKey(raw);
    raw.fill(0);
    const collection = await protectedCollection(member, area, signal);
    try {
      const previous = await collection.get(area.prefix);
      const forged = await encryptObject(
        {
          tenant: account.tenant,
          scope: area.scope,
          facet: area.facet,
          object: area.prefix,
          generation: domain.generation,
          policyVersion: access.rootPolicy.version,
          revision: (BigInt(previous.envelope.revision) + 1n).toString(),
          author: account.vault.subject,
        },
        bytes(JSON.stringify(previous.value)),
        retainedKey,
        account.identity.signingKey.privateKey,
      );
      const resourceAccess = await toolResponsibilityPacket(
        access.origins.find((origin) => origin.id === area.domain),
        forged,
        previous.value,
        access.history.identityCertificate(account.vault.subject),
        account.identity.signingKey.privateKey,
      );
      const [, denied] = await member.mutate("zerotrust.objects.batch", {
        objects: [
          {
            domain: area.domain,
            messageId: `msg_${crypto.randomUUID()}`,
            envelope: forged,
            resourceAccess,
          },
        ],
        heads: [{ domain: area.domain, sequence: await collection.inspect() }],
      });
      assert.ok(denied instanceof RpcClientError);
      assert.equal(denied.code, "FORBIDDEN");
    } finally {
      collection.close();
    }
    async function returnTool(): Promise<EncryptedObject> {
      await unlockOwner();
      await required(business.mutate("tools.untrack", { id: tools[0]!.id }));
      const afterReturn = await protectedCollection(observed, area, signal);
      try {
        const [old] = await afterReturn.read();
        assert.ok(old);
        const value = structuredClone(old.value) as {
          rows: { values: Record<string, unknown> }[];
        };
        value.rows[0]!.values.comment =
          "Private Ergänzung nach der Rückgabe 681527";
        const packet = await afterReturn.packet(
          area.prefix,
          value,
          old.envelope,
        );
        await afterReturn.write([packet]);
        return (await afterReturn.get(area.prefix)).envelope;
      } finally {
        afterReturn.close();
      }
    }
    let after: EncryptedObject;
    if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
      const { exerciseToolResponsibilityBrowser } =
        await import("./test-tool-responsibility-browser");
      after = await exerciseToolResponsibilityBrowser(
        {
          tenant: account.tenant,
          member: {
            username: "late.tool.member",
            password: "Late-tool-member-password-2026!",
          },
          activeLabel: "Aktive Ausgabe",
          closedLabel: "Frühere Ausgabe",
          toolBrand: "Privater Werkzeugbestand 571943",
          toolId: tools[0]!.id,
          bookingDomain: area.domain,
        },
        returnTool,
      );
    } else {
      after = await returnTool();
    }
    await acceptVaultWithKey(
      account.dataKey,
      account.vault,
      account.username,
      false,
    );
    await restricted.invalidate("tools.trackings.list");
    assert.deepEqual(
      await required(restricted.query("tools.trackings.list", {})),
      [],
    );
    const [, revoked] = await member.query(
      "zerotrust.keys.get",
      { domain: area.domain, generation: domain.generation },
      { strategy: "network-only" },
    );
    assert.equal(revoked?.code, "FORBIDDEN");
    assert.equal(after!.author, ownerAccount.vault.subject);
    await verify(
      ownerAccount.identity.signingKey.publicKey,
      after!.signature,
      objectFrame(after!),
    );
    await assert.rejects(
      decryptObject(
        after!,
        {
          tenant: after!.tenant,
          scope: after!.scope,
          facet: after!.facet,
          object: after!.object,
          revision: after!.revision,
          generation: after!.generation,
          policyVersion: after!.policyVersion,
          author: after!.author,
        },
        retainedKey,
        ownerAccount.identity.signingKey.publicKey,
      ),
    );
    console.log(
      "Native late tool responsibility: earlier active booking checkpointed at invitation approval, closed booking and costs hidden, exact retry unchanged, authentic reader write denied, return revokes access and retained key cannot read later changes",
    );
  } finally {
    restricted?.dispose();
    business.dispose();
    await unlockOwner();
  }
}
