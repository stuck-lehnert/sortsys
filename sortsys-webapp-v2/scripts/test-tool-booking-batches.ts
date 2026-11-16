import assert from "node:assert/strict";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { publicId, newProductRowId } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { toolCollection } from "../app/lib/data/toolData";
import { toolUsageCollection } from "../app/lib/data/projectToolUsage";
import { trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import {
  readVerifiedPolicy,
  publishVerifiedPolicy,
} from "../app/lib/crypto/policy";

type RequestHook = (
  url: URL,
  next: () => Promise<Response>,
) => Promise<Response>;

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
  async function denySecond(denied: boolean) {
    const { permissions } = await readVerifiedPolicy(owner, context);
    const rules = permissions.rules.filter(
      (rule) =>
        !(
          rule.subject === subject &&
          rule.scope === deniedScope &&
          rule.facet === "master-data" &&
          rule.effect === "deny" &&
          rule.actions.length === 1 &&
          rule.actions[0] === "update"
        ),
    );
    if (denied)
      rules.push({
        subject,
        scope: deniedScope,
        facet: "master-data",
        actions: ["update"],
        effect: "deny",
      });
    await publishVerifiedPolicy(owner, context, {
      ...permissions,
      version: (BigInt(permissions.version) + 1n).toString(),
      rules,
    });
  }
  try {
    await denySecond(true);
    assert.ok((await owner.mutate("tools.trackMany", input))[1]);
    await assertOriginal();
    await denySecond(false);

    let pretend = true;
    install(async (url, next) => {
      if (pretend && url.pathname.endsWith("/zerotrust.objects.batch")) {
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

    let winner: string | null = null;
    let race = true;
    install(async (url, next) => {
      if (race && url.pathname.endsWith("/zerotrust.objects.batch")) {
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
    install(async (url, next) => {
      if (lost && url.pathname.endsWith("/zerotrust.objects.batch")) {
        lost = false;
        const response = await next();
        assert.equal(response.ok, true);
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
