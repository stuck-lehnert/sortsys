import assert from "node:assert/strict";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";
import { openAuthority } from "../app/lib/crypto/setup";
import { trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import {
  preparePolicyPublication,
  readVerifiedPolicy,
  publishVerifiedPolicy,
} from "../app/lib/crypto/policy";
import { exerciseBatchedReads } from "./test-batched-reads";
import { ORGANIZATION_COLLECTION } from "../app/lib/data/organizationData";

export async function exerciseNativeStaging(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
  transmissions: readonly string[][],
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const subject = `user:${draft.userId}`;
  const area = {
    domain: "testing:staging:master-data",
    scope: "testing:staging",
    facet: "master-data" as const,
    prefix: "staged:",
  };
  await provisionOwnedCollections(owner, subject, [area], signal);
  const collection = await protectedCollection(owner, area, signal);
  try {
    assert.deepEqual(await collection.read(), []);
    const packets: MutateInput<"zerotrust.objects.save">[] = [];
    for (let index = 0; index < 320; index++) {
      packets.push(
        await collection.packet(`staged:${index}`, {
          title: `Geheime Kalkulationszeile ${index}`,
          amount: 592.375,
        }),
      );
    }
    const head = { domain: area.domain, sequence: collection.snapshot()! };
    const publishedSequence = (BigInt(head.sequence) + 1n).toString();
    let firstStage = true;
    let attemptedCommit = false;
    const rejected: Client = {
      ...owner,
      mutate: (async (path, input, options) => {
        if (path === "zerotrust.objects.commit") attemptedCommit = true;
        if (path === "zerotrust.objects.stage" && firstStage) {
          firstStage = false;
          const changed = structuredClone(
            input as MutateInput<"zerotrust.objects.stage">,
          );
          changed.objects[0]!.envelope.signature = base64(new Uint8Array(64));
          return owner.mutate("zerotrust.objects.stage", changed, options);
        }
        return owner.mutate(path, input, options);
      }) as Client["mutate"],
    };
    await assert.rejects(
      commitProtectedWrites(
        rejected,
        [{ head, packets, verify: async () => true, close() {} }],
        signal,
      ),
    );
    assert.equal(attemptedCommit, false);
    const unpublished = await required(
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
    assert.equal(unpublished.objects.length, 0);
    assert.equal(unpublished.snapshot, head.sequence);
    const parts: string[] = [];
    let commitInput: MutateInput<"zerotrust.objects.commit"> | null = null;
    let lost = false;
    const observed: Client = {
      ...owner,
      mutate: (async (path, input, options) => {
        if (path === "zerotrust.objects.commit") {
          commitInput = structuredClone(
            input as MutateInput<"zerotrust.objects.commit">,
          );
          const result = await peer.mutate(path, input, options);
          if (!result[1] && !lost) {
            lost = true;
            throw new TypeError(
              "Lost acknowledgement after the full prepared commit",
            );
          }
          return result;
        }
        const result = await owner.mutate(path, input, options);
        if (path === "zerotrust.objects.stage" && result[0]) {
          parts.push((result[0] as { id: string }).id);
          const unpublished = await required(
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
          assert.equal(unpublished.objects.length, 0);
          assert.equal(unpublished.snapshot, head.sequence);
        }
        return result;
      }) as Client["mutate"],
    };
    const verify = async () => {
      const reopened = await protectedCollection(peer, area, signal);
      try {
        const objects = new Map(
          (await reopened.read()).map((object) => [
            object.envelope.object,
            object,
          ]),
        );
        return packets.every(
          (packet) =>
            objects.get(packet.envelope.object)?.envelope.signature ===
            packet.envelope.signature,
        );
      } finally {
        reopened.close();
      }
    };
    const transmissionStart = transmissions.length;
    await commitProtectedWrites(
      observed,
      [{ head, packets, verify, close() {} }],
      signal,
    );
    const stageBatches = transmissions
      .slice(transmissionStart)
      .map((paths) =>
        paths.filter((path) => path === "zerotrust.objects.stage"),
      )
      .filter((paths) => paths.length > 0);
    assert.deepEqual(
      stageBatches.map((paths) => paths.length),
      [4, 1],
    );
    assert.equal(parts.length, 5);
    assert.equal(lost, true);
    assert.ok(commitInput);
    const repeated = await required(
      owner.mutate("zerotrust.objects.commit", commitInput),
    );
    assert.equal(repeated.heads[0]!.sequence, publishedSequence);
    assert.equal(await verify(), true);
    console.log(
      "Native staging: 320 encrypted records use two upload requests (4/1 parts); a forged signature prevents publication; invisible parts, cross-instance commit, lost reply and exact retry verified",
    );
    await exerciseBatchedReads(
      owner,
      peer,
      area,
      publishedSequence,
      signal,
      transmissions,
    );

    const fresh = await protectedCollection(owner, area, signal);
    try {
      await fresh.read();
      const pending = await fresh.packet("staged:must-remain-hidden", {
        private: "Unpublished after permission change",
      });
      const stage = await required(
        owner.mutate("zerotrust.objects.stage", { objects: [pending] }),
      );
      const account = unlockedAccount()!;
      const history = await trustedHistory(owner);
      const authority = await openAuthority(owner, draft.setup);
      const context = {
        account,
        history,
        authority,
        live: () => signal.throwIfAborted(),
      };
      const previous = await readVerifiedPolicy(owner, context);
      const denied = {
        ...previous.permissions,
        version: (BigInt(previous.permissions.version) + 1n).toString(),
        rules: [
          ...previous.permissions.rules,
          {
            subject,
            scope: area.scope,
            facet: area.facet,
            actions: ["create" as const, "update" as const],
            effect: "deny" as const,
          },
        ],
      };
      await publishVerifiedPolicy(owner, context, denied);
      assert.ok(
        (
          await peer.mutate("zerotrust.objects.commit", {
            parts: [stage.id],
            heads: [{ domain: area.domain, sequence: publishedSequence }],
          })
        )[1],
      );
      const hidden = await required(
        owner.query(
          "zerotrust.objects.list",
          {
            domain: area.domain,
            prefix: "staged:must-remain-hidden",
            after: null,
            snapshot: null,
          },
          { strategy: "network-only" },
        ),
      );
      assert.equal(hidden.objects.length, 0);
      await publishVerifiedPolicy(owner, context, {
        ...previous.permissions,
        version: (BigInt(denied.version) + 1n).toString(),
      });

      const current = await protectedCollection(owner, area, signal);
      try {
        await current.read();
        const policyPackets: MutateInput<"zerotrust.objects.save">[] = [];
        for (let index = 0; index < 70; index++)
          policyPackets.push(
            await current.packet(`staged:policy:${index}`, {
              private: `Grant-bound change ${index}`,
            }),
          );
        const baseline = await readVerifiedPolicy(owner, context);
        const replacement = {
          ...baseline.permissions,
          version: (BigInt(baseline.permissions.version) + 1n).toString(),
        };
        const publication = preparePolicyPublication(
          owner,
          { ...context, author: subject },
          baseline,
          replacement,
        );
        const check = async () => {
          const view = await protectedCollection(peer, area, signal);
          try {
            const entries = new Map(
              (await view.read()).map((entry) => [
                entry.envelope.object,
                entry.envelope.signature,
              ]),
            );
            return policyPackets.every(
              (packet) =>
                entries.get(packet.envelope.object) ===
                packet.envelope.signature,
            );
          } finally {
            view.close();
          }
        };
        let substitutionDenied = false;
        const policyClient: Client = {
          ...owner,
          mutate: (async (path, input, options) => {
            if (path === "zerotrust.objects.commit") {
              const original = input as MutateInput<"zerotrust.objects.commit">;
              assert.equal(
                original.policy?.transaction?.packetCommitment?.count,
                70,
              );
              const replacementPacket = await current.packet(
                "staged:policy:0",
                { private: "Different correctly signed ciphertext" },
              );
              const alternative = await required(
                owner.mutate("zerotrust.objects.stage", {
                  objects: [replacementPacket, ...policyPackets.slice(1, 64)],
                }),
              );
              assert.ok(
                (
                  await peer.mutate("zerotrust.objects.commit", {
                    ...original,
                    parts: [alternative.id, ...original.parts.slice(1)],
                  })
                )[1],
              );
              const unchanged = await required(
                peer.query(
                  "zerotrust.objects.list",
                  {
                    domain: area.domain,
                    prefix: "staged:policy:",
                    after: null,
                    snapshot: null,
                  },
                  { strategy: "network-only" },
                ),
              );
              assert.equal(unchanged.objects.length, 0);
              assert.equal(
                (await readVerifiedPolicy(peer, context)).permissions.version,
                baseline.permissions.version,
              );
              substitutionDenied = true;
              return peer.mutate(path, input, options);
            }
            return owner.mutate(path, input, options);
          }) as Client["mutate"],
        };
        await commitProtectedWrites(
          policyClient,
          [
            {
              packets: policyPackets,
              head: { domain: area.domain, sequence: current.snapshot()! },
              verify: check,
              close() {},
            },
          ],
          signal,
          [],
          { policy: publication },
        );
        assert.equal(
          (await readVerifiedPolicy(peer, context)).permissions.version,
          replacement.version,
        );
        assert.equal(await check(), true);
        assert.equal(substitutionDenied, true);
        const visible = await required(
          peer.query("zerotrust.objects.pages", {
            selections: [
              {
                domain: ORGANIZATION_COLLECTION.domain,
                prefix: ORGANIZATION_COLLECTION.prefix,
                after: null,
                snapshot: null,
              },
            ],
          }),
        );
        assert.equal(visible.length, 1);
        const latest = await readVerifiedPolicy(owner, context);
        await publishVerifiedPolicy(owner, context, {
          ...latest.permissions,
          version: (BigInt(latest.permissions.version) + 1n).toString(),
          rules: [
            ...latest.permissions.rules,
            {
              subject,
              scope: area.scope,
              facet: area.facet,
              actions: ["read"],
              effect: "deny",
            },
          ],
        });
        const [partial, deniedRead] = await peer.query(
          "zerotrust.objects.pages",
          {
            selections: [
              {
                domain: ORGANIZATION_COLLECTION.domain,
                prefix: ORGANIZATION_COLLECTION.prefix,
                after: null,
                snapshot: null,
              },
              {
                domain: area.domain,
                prefix: area.prefix,
                after: null,
                snapshot: null,
              },
            ],
          },
        );
        assert.equal(partial, null);
        assert.equal(deniedRead?.code, "FORBIDDEN");
      } finally {
        current.close();
      }
    } finally {
      fresh.close();
    }
    console.log(
      "Native staging: fresh authorization after preparation and atomic publication of a signed policy with a large batch verified",
    );
  } finally {
    collection.close();
    controller.abort();
  }
}
