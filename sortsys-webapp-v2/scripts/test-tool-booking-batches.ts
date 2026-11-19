import assert from "node:assert/strict";
import { RpcClientError, type Client, type MutateInput } from "@sortsys/v2-client";
import {
  base64,
  digest,
  immutableObject,
  openBox,
  openResourceCommandSigner,
  signResourceCommand,
  sized,
  TOOL_RETURN_PURPOSE,
  type Action,
} from "@sortsys/zerotrust/sortsys";
import { publicId, newProductRowId } from "../app/lib/data/products";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { TOOL_BOOKING_MODEL, TOOL_MODEL, toolBookingArea, toolCollection } from "../app/lib/data/toolData";
import { TOOL_USAGE_MODEL, toolUsageCollection } from "../app/lib/data/projectToolUsage";
import { prepareToolReturnKeys } from "../app/lib/data/toolReturnKey";
import { trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import {
  readVerifiedPolicy,
  publishVerifiedPolicy,
} from "../app/lib/crypto/policy";

type RequestHook = (
  url: URL,
  next: () => Promise<Response>,
  options?: RequestInit,
) => Promise<Response>;

function isBookingPublication(
  url: URL,
  options: RequestInit | undefined,
  operationId: string,
) {
  if (
    !url.pathname.endsWith("/zerotrust.objects.batch") ||
    typeof options?.body !== "string"
  ) {
    return false;
  }
  const receipt = immutableObject(
    `tool-tracking:${operationId}`,
    "master-data",
    "tool-booking",
    operationId,
  );
  const calls = Object.values(JSON.parse(options.body)) as {
    json: MutateInput<"zerotrust.objects.batch">;
  }[];
  return calls.some(({ json }) =>
    json.objects?.some(({ envelope }) => envelope.object === receipt),
  );
}

async function checkReturnBinding(
  owner: Client,
  peer: Client,
  toolId: string,
  trackingId: string,
  projectId: string,
) {
  const signal = new AbortController().signal;
  const source = toolCollection("tool-tracking", trackingId, "master-data");
  const pointer = toolBookingArea(toolId);
  const projection = toolUsageCollection(projectId, "master-data");
  const tracking = await protectedCollection(owner, source, signal);
  const tool = await protectedCollection(peer, pointer, signal);
  const usage = await protectedCollection(peer, projection, signal);
  try {
    const opened = await tracking.get(source.prefix);
    const stored = TOOL_MODEL.decode(opened.value, source.prefix, source);
    assert.ok(stored.returnKey);
    const publicKey = stored.returnKey.verificationKey;
    const pointerObject = await tool.get(pointer.prefix);
    const checkedPointer = TOOL_BOOKING_MODEL.decode(pointerObject.value, pointer.prefix, pointer);
    const usageId = projection.prefix + trackingId;
    const usageObject = await usage.get(usageId);
    const checkedUsage = TOOL_USAGE_MODEL.decode(usageObject.value, usageId, projection);
    assert.equal(checkedPointer.returnKey, publicKey);
    assert.equal(checkedUsage.returnKey, publicKey);
    const origin = await required(peer.query("zerotrust.creations.origin", {
      domain: source.domain,
    }, { strategy: "network-only" }));
    assert.ok(origin?.access);
    const commitment = await digest(sized(publicKey, 32));
    assert.equal(origin.access.commandBinding, commitment);
    assert.equal(origin.access.active, true);
    const member = unlockedAccount()!;
    const box = stored.returnKey.recipient;
    const copy = await openBox(
      box,
      {
        tenant: member.tenant,
        purpose: "resource-command-key",
        object: `${source.scope}:return:${publicKey}`,
        generation: box.generation,
        recipient: member.vault.subject,
        author: member.vault.subject,
      },
      member.identity.encryptionKey.privateKey,
      member.identity.signingKey.publicKey,
    );
    try {
      const signingSeed = base64(copy);
      const signer = await openResourceCommandSigner({
        verificationKey: publicKey,
        signingSeed,
      });
      for (const value of [opened.value, pointerObject.value, usageObject.value]) {
        assert.ok(!JSON.stringify(value).includes(signingSeed));
      }
      const returned = await signResourceCommand({
        tenant: member.tenant,
        purpose: TOOL_RETURN_PURPOSE,
        revision: opened.envelope.revision,
        issuedAt: Date.now().toString(),
        verificationKey: publicKey,
      }, signer);
      const definition = await required(owner.query("zerotrust.domains.get", {
        domain: source.domain,
        generation: opened.envelope.generation,
      }, { strategy: "network-only" }));
      assert.ok(definition.creation);
      const [updated, error] = await peer.mutate("zerotrust.domains.put", {
        ...definition,
        creation: { ...origin, returned },
      });
      assert.equal(updated, null);
      assert.ok(error instanceof RpcClientError);
      assert.equal(error.code, "BAD_REQUEST");
      const current = await required(owner.query("zerotrust.creations.origin", {
        domain: source.domain,
      }, { strategy: "network-only" }));
      assert.deepEqual(current, origin);
    } finally {
      copy.fill(0);
    }

    // A valid author and signature cannot replace or remove a committed key.
    const prepare = await prepareToolReturnKeys(
      owner, stored.rows[0]!.values.responsible_user_id as string, signal,
    );
    assert.ok(prepare);
    const alternate = await prepare(trackingId);
    const replacement = { ...stored, returnKey: alternate };
    const sequence = await tracking.inspect();
    for (const value of [replacement, { ...stored, returnKey: undefined }]) {
      const input = structuredClone(value);
      if (!input.returnKey) delete input.returnKey;
      const packet = await tracking.packet(source.prefix, input, opened.envelope);
      const [result, error] = await owner.mutate("zerotrust.objects.batch", {
        objects: [packet], heads: [{ domain: source.domain, sequence }],
      });
      assert.equal(result, null);
      assert.ok(error instanceof RpcClientError);
      assert.equal(error.code, "CONFLICT");
    }
    assert.equal((await tracking.get(source.prefix)).envelope.signature, opened.envelope.signature);
    console.log("Tool return key: two projections hold only the matched verification key; API rejects any change to the signed commitment");
  } finally {
    usage.close();
    tool.close();
    tracking.close();
  }
}

export async function exerciseToolBookingBatches(
  owner: Client,
  peer: Client,
  install: (hook: RequestHook | null) => void,
) {
  const session = await required(owner.query("auth.sessionInfo", undefined));
  const subject = `user:${session.user.id}`;
  const source = await required(
    owner.mutate("projects.create", { title: "Werkzeugausgabe Rohbau" }),
  );
  const target = await required(
    peer.mutate("projects.create", { title: "Werkzeugausgabe Ausbau" }),
  );
  const number = await required(
    owner.query("tools.suggestNextCustomId", undefined),
  );
  const first = await required(
    owner.mutate("tools.create", {
      customId: number,
      brand: "Musterwerkzeug",
      category: "Bohrhammer",
      label: "Sammelausgabe Nordflügel",
      purchasePrice: 1127.25,
      usageCostPerDay: 11.375,
    }),
  );
  const second = await required(
    peer.mutate("tools.create", {
      customId: number + 1,
      brand: "Musterwerkzeug",
      category: "Rührwerk",
      label: "Sammelausgabe Südflügel",
      purchasePrice: 917.25,
      usageCostPerDay: 7.625,
    }),
  );
  const old = await required(
    owner.mutate("tools.track", {
      id: first.id,
      data: { projectId: source.id, responsibleUserId: session.user.id },
    }),
  );
  await checkReturnBinding(owner, peer, first.id, old.trackingId, source.id);
  const transfer = await required(
    owner.mutate("tools.trackings.transfers.request", {
      toolTrackingId: old.trackingId,
      transferToUserId: session.user.id,
    }),
  );
  await required(
    owner.mutate("tools.update", {
      id: first.id,
      data: { usageCostPerDay: 19.125 },
    }),
  );
  const sourcePrice = toolUsageCollection(source.id, "procurement");
  const oldPrice = await required(
    owner.query(
      "zerotrust.objects.get",
      { id: sourcePrice.prefix + old.trackingId },
      { strategy: "network-only" },
    ),
  );
  let input: MutateInput<"tools.trackMany"> = {
    operationId: publicId(newProductRowId()),
    tools: [
      { id: first.id, expectedTrackingId: old.trackingId },
      { id: second.id, expectedTrackingId: null },
    ],
    data: {
      projectId: target.id,
      responsibleUserId: session.user.id,
      comment: "Geschützte Sammelausgabe 751392",
    },
  };
  async function bookings(client: Client, id: string) {
    return required(
      client.query(
        "tools.trackings.list",
        { toolId: id, limit: 1000 },
        { strategy: "network-only" },
      ),
    );
  }
  async function assertOriginal() {
    const firstBookings = await bookings(peer, first.id);
    assert.equal(firstBookings.length, 1);
    assert.equal(firstBookings[0]!.id, old.trackingId);
    assert.equal(firstBookings[0]!.endedAt, null);
    assert.equal((await bookings(peer, second.id)).length, 0);
  }
  const account = unlockedAccount()!;
  const history = await trustedHistory(owner);
  const status = await required(owner.query("zerotrust.status", undefined));
  assert.ok(status.profile);
  const authority = await openAuthority(owner, status.profile);
  const context = {
    account,
    history,
    authority,
    live: () => assert.equal(unlockedAccount(), account),
  };
  const deniedScope = toolCollection("tool", second.id, "master-data").scope;
  async function denyAction(scope: string, action: Action, denied: boolean) {
    const { permissions } = await readVerifiedPolicy(owner, context);
    const rules = permissions.rules.filter(
      (rule) =>
        !(
          rule.subject === subject &&
          rule.scope === scope &&
          rule.facet === "master-data" &&
          rule.effect === "deny" &&
          rule.actions.length === 1 &&
          rule.actions[0] === action
        ),
    );
    if (denied)
      rules.push({
        subject,
        scope,
        facet: "master-data",
        actions: [action],
        effect: "deny",
      });
    await publishVerifiedPolicy(owner, context, {
      ...permissions,
      version: (BigInt(permissions.version) + 1n).toString(),
      rules,
    });
  }
  try {
    await denyAction(deniedScope, "update", true);
    assert.ok((await owner.mutate("tools.trackMany", input))[1]);
    await assertOriginal();
    await denyAction(deniedScope, "update", false);

    let pretend = true;
    install(async (url, next, options) => {
      if (pretend && isBookingPublication(url, options, input.operationId)) {
        pretend = false;
        return Response.json([
          { result: { data: { json: { success: true } } } },
        ]);
      }
      return next();
    });
    const [, rejectedReply] = await owner.mutate("tools.trackMany", input);
    assert.ok(rejectedReply);
    if (pretend)
      throw new Error(
        "The false acknowledgement must reach the real booking publication",
        { cause: rejectedReply },
      );
    install(null);
    await assertOriginal();

    // Preparation has created empty key areas. Revocation must still prevent
    // their first business publication, even when a retry reuses those areas.
    await denyAction("create:tool-tracking", "create", true);
    assert.ok(
      (await owner.mutate("tools.trackMany", input))[1],
      "Prepared empty areas must not bypass revoked creation permission",
    );
    await assertOriginal();
    await required(
      owner.mutate("tools.update", {
        id: first.id,
        data: { label: "Vorhandenes Werkzeug bleibt bearbeitbar" },
      }),
    );
    await denyAction("create:tool-tracking", "create", false);

    let winner: string | null = null;
    let race = true;
    install(async (url, next, options) => {
      if (race && isBookingPublication(url, options, input.operationId)) {
        race = false;
        winner = (
          await required(
            peer.mutate("tools.track", {
              id: second.id,
              data: { responsibleUserId: session.user.id },
            }),
          )
        ).trackingId;
      }
      return next();
    });
    assert.ok((await owner.mutate("tools.trackMany", input))[1]);
    assert.equal(race, false);
    assert.ok(winner);
    install(null);
    assert.equal((await bookings(peer, first.id))[0]!.endedAt, null);
    assert.equal((await bookings(peer, second.id))[0]!.id, winner);
    assert.ok(
      (await owner.mutate("tools.trackMany", input))[1],
      "An outdated selection must not silently rebook the competing winner",
    );

    input = {
      ...input,
      tools: [
        { id: first.id, expectedTrackingId: old.trackingId },
        { id: second.id, expectedTrackingId: winner },
      ],
    };
    let lost = true;
    install(async (url, next, options) => {
      if (lost && isBookingPublication(url, options, input.operationId)) {
        lost = false;
        const response = await next();
        assert.equal(response.ok, true);
        const [result] = await response.clone().json();
        if (result.error) return response;
        throw new TypeError("Lost successful bulk booking acknowledgement");
      }
      return next();
    });
    const result = await required(owner.mutate("tools.trackMany", input));
    assert.equal(lost, false);
    install(null);
    assert.equal(result.trackings.length, 2);
    for (const [id, expectedRate] of [
      [first.id, 19.125],
      [second.id, 7.625],
    ] as const) {
      const all = await bookings(peer, id);
      assert.equal(all.length, 2);
      const active = all.filter((booking) => booking.endedAt === null);
      assert.equal(active.length, 1);
      assert.equal(
        active[0]!.id,
        result.trackings.find((booking) => booking.toolId === id)!.trackingId,
      );
      assert.equal(active[0]!.projectId, target.id);
      assert.equal(active[0]!.toolUsageCostPerDay, expectedRate);
    }
    assert.equal(
      (await bookings(peer, first.id)).find(
        (booking) => booking.id === old.trackingId,
      )!.toolUsageCostPerDay,
      11.375,
    );
    assert.equal(
      (
        await required(
          peer.query("tools.trackings.transfers.list", { toolId: first.id }),
        )
      ).find((request) => request.id === transfer.id)!.status,
      "denied",
    );
    const preservedPrice = await required(
      peer.query(
        "zerotrust.objects.get",
        { id: sourcePrice.prefix + old.trackingId },
        { strategy: "network-only" },
      ),
    );
    assert.equal(preservedPrice.signature, oldPrice.signature);

    await required(peer.mutate("tools.untrack", { id: first.id }));
    assert.deepEqual(
      await required(owner.mutate("tools.trackMany", input)),
      result,
    );
    assert.equal((await bookings(peer, first.id)).length, 2);
    assert.equal(
      (await required(peer.query("tools.get", { id: first.id }))).available,
      true,
    );
    assert.ok(
      (
        await owner.mutate("tools.trackMany", {
          ...input,
          data: { ...input.data, comment: "Changed intent" },
        })
      )[1],
    );
    console.log(
      "Native tool batches: denied selection, false/lost acknowledgements, cross-instance competing booking, atomic rebooking of all tools, preserved historical prices, transfer denial and receipt replay after return verified",
    );
  } finally {
    install(null);
  }
}
