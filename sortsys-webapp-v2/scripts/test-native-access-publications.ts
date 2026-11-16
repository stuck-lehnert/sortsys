import assert from "node:assert/strict";
import {
  RpcClientError,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import {
  base64,
  createDomain,
  publicIdentity,
  rewrapDomainKey,
} from "@sortsys/zerotrust/sortsys";
import { administratorPolicyContext } from "../app/lib/crypto/administration";
import {
  publishVerifiedPolicy,
  readVerifiedPolicy,
} from "../app/lib/crypto/policy";
import { createResourceAreas } from "../app/lib/data/createProjectArea";
import { newProductRowId, publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import {
  publishAccessRotations,
  type AccessRotation,
} from "../app/lib/data/accessPublication";

type RequestHook = (
  url: URL,
  next: (replacement?: URL) => Promise<Response>,
  options?: RequestInit,
) => Promise<Response>;

export async function exerciseNativeAccessPublications(
  owner: Client,
  peer: Client,
  setRequestHook: (hook: RequestHook | null) => void,
) {
  const signal = new AbortController().signal;
  const areas = Array.from({ length: 2 }, () => {
    const scope = `tool:${publicId(newProductRowId())}`;
    return {
      domain: `${scope}:master-data`,
      scope,
      facet: "master-data" as const,
      prefix: `${scope}:master-data:record`,
    };
  });
  await createResourceAreas(owner, areas, "tool", signal);
  const context = await administratorPolicyContext(owner, signal);
  const subject = `user:${context.session.user.id}`;
  const originals = await Promise.all(
    areas.map((area) =>
      required(
        peer.query(
          "zerotrust.domains.get",
          {
            domain: area.domain,
            generation: "1",
          },
          { strategy: "network-only" },
        ),
      ),
    ),
  );
  const initial = await protectedCollection(owner, areas[0]!, signal);
  try {
    await initial.read();
    await initial.write([
      await initial.packet(areas[0]!.prefix, {
        private: "Private batched permission record 591274",
        version: 1,
      }),
    ]);
  } finally {
    initial.close();
  }

  async function prepare(policyVersion: string): Promise<AccessRotation[]> {
    return Promise.all(
      areas.map(async (area, index) => {
        const original = originals[index]!;
        const box = await required(
          owner.query(
            "zerotrust.keys.get",
            { domain: area.domain, generation: "1" },
            { strategy: "network-only" },
          ),
        );
        const envelopes = await rewrapDomainKey({
          definition: original,
          area: {
            tenant: context.account.tenant,
            id: area.domain,
            scope: area.scope,
            facet: area.facet,
            generation: "1",
          },
          envelope: box,
          owner: {
            subject,
            privateKey: context.account.identity.encryptionKey.privateKey,
          },
          authority: {
            generation: context.history.current.generation,
            privateKey: context.authority,
          },
          history: context.history.authority,
          readers: [
            {
              subject,
              identity: await publicIdentity(context.account.identity),
            },
          ],
          signal,
        });
        const { definition } = await createDomain({
          tenant: context.account.tenant,
          id: area.domain,
          scope: area.scope,
          facet: area.facet,
          generation: "2",
          policyVersion,
          authorityGeneration: context.history.current.generation,
          authorityKey: context.authority,
          recovery: {
            encryptionKey: context.history.current.recoveryEncryptionKey,
            signingKey: context.history.current.recoverySigningKey,
          },
          readers: [
            {
              subject,
              identity: await publicIdentity(context.account.identity),
            },
          ],
        });
        return {
          definition,
          grants: envelopes.map((envelope) => ({
            domain: area.domain,
            generation: "1",
            envelope,
          })),
        };
      }),
    );
  }
  function publication(
    rotations: AccessRotation[],
    policyVersion: string,
  ): MutateInput<"zerotrust.access.publish"> {
    return {
      policyVersion,
      grants: rotations.flatMap((rotation) => rotation.grants),
      domains: rotations.map((rotation) => rotation.definition),
    };
  }
  const prepared = await prepare(context.permissions.version);
  const input = publication(prepared, context.permissions.version);
  const inspect = () =>
    required(
      peer.query(
        "zerotrust.keys.inspect",
        {
          keys: areas.map((area) => ({
            domain: area.domain,
            generation: "1",
            recipient: subject,
          })),
        },
        { strategy: "network-only" },
      ),
    );
  async function assertUnpublished() {
    const keys = await inspect();
    assert.deepEqual(
      keys.map((key) => key.signature),
      originals.map((definition) => definition.envelopes[0]!.signature),
    );
    await assertNoNewGenerations();
  }
  async function assertNoNewGenerations() {
    for (const area of areas) {
      const [missing, error] = await peer.query(
        "zerotrust.domains.get",
        { domain: area.domain, generation: "2" },
        { strategy: "network-only" },
      );
      assert.equal(missing, null);
      assert.equal(error?.code, "NOT_FOUND");
    }
  }
  for (const changed of [
    {
      ...input,
      domains: [
        input.domains[0]!,
        { ...input.domains[1]!, proof: base64(new Uint8Array(64)) },
      ],
    },
    { ...input, grants: [input.grants[0]!, input.grants[0]!] },
    { ...input, domains: [input.domains[0]!, input.domains[0]!] },
    { ...input, policyVersion: (BigInt(input.policyVersion) + 1n).toString() },
    { ...input, domains: [], grants: [] },
    {
      ...input,
      domains: [],
      grants: Array.from({ length: 33 }, () => input.grants[0]!),
    },
  ]) {
    const [result, error] = await owner.mutate(
      "zerotrust.access.publish",
      changed,
    );
    assert.equal(result, null);
    assert.ok(error);
    await assertUnpublished();
  }

  // A stale policy and a currently denied recipient each reject the whole set,
  // including the first area's otherwise valid historical key replacement.
  const [, oversizedPacket] = await owner.mutate("zerotrust.access.publish", {
    policyVersion: input.policyVersion,
    domains: [],
    grants: [
      {
        ...input.grants[0]!,
        envelope: {
          ...input.grants[0]!.envelope,
          ciphertext: base64(new Uint8Array(2 * 1024 * 1024)),
        },
      },
    ],
  });
  assert.ok(oversizedPacket instanceof RpcClientError);
  assert.equal(
    oversizedPacket.code,
    "BAD_REQUEST",
    "Large encrypted publications reach signature validation and cannot bypass it",
  );
  await assertUnpublished();
  const deny = {
    subject,
    scope: areas[1]!.scope,
    facet: "master-data" as const,
    actions: ["read" as const],
    effect: "deny" as const,
  };
  const revoked = await publishVerifiedPolicy(owner, context, {
    ...context.permissions,
    version: (BigInt(context.permissions.version) + 1n).toString(),
    rules: [...context.permissions.rules, deny],
  });
  assert.ok((await peer.mutate("zerotrust.access.publish", input))[1]);
  const [, denied] = await peer.mutate("zerotrust.access.publish", {
    ...input,
    policyVersion: revoked.permissions.version,
  });
  assert.ok(denied instanceof RpcClientError);
  assert.equal(denied.code, "FORBIDDEN");
  await assertNoNewGenerations();
  const [, inspectionDenied] = await peer.query(
    "zerotrust.keys.inspect",
    {
      keys: [{ domain: areas[1]!.domain, generation: "1", recipient: subject }],
    },
    { strategy: "network-only" },
  );
  assert.equal(
    inspectionDenied?.code,
    "FORBIDDEN",
    "Inspection cannot bypass a recipient's current read denial",
  );
  const { permissions } = await readVerifiedPolicy(owner, context);
  const restored = await publishVerifiedPolicy(owner, context, {
    ...permissions,
    version: (BigInt(permissions.version) + 1n).toString(),
    rules: permissions.rules.filter(
      (rule) =>
        !(
          rule.subject === deny.subject &&
          rule.scope === deny.scope &&
          rule.facet === deny.facet &&
          rule.effect === "deny"
        ),
    ),
  });
  const final = await prepare(restored.permissions.version);
  await assertUnpublished();
  let requests = 0;
  let loseReply = true;
  setRequestHook(async (url, next) => {
    if (url.pathname !== "/zerotrust.access.publish") return next();
    requests++;
    const response = await next();
    if (loseReply && response.ok) {
      loseReply = false;
      throw new TypeError("Lost successful access publication response");
    }
    return response;
  });
  try {
    await publishAccessRotations(
      owner,
      restored.permissions.version,
      final,
      signal,
    );
    assert.equal(
      requests,
      1,
      "Readback resolves a lost response without repeating the mutation",
    );
  } finally {
    setRequestHook(null);
  }
  assert.deepEqual(
    (await inspect()).map((key) => key.signature),
    final.map((rotation) => rotation.grants[0]!.envelope.signature),
  );
  const after = await required(
    owner.query("zerotrust.access.snapshot", {}, { strategy: "network-only" }),
  );
  console.log(
    "Atomic publication, revocation and lost-response checks passed; checking encrypted business readback",
  );
  // Business contents still pass only through the browser's encrypted store.
  const collection = await protectedCollection(peer, areas[0]!, signal);
  try {
    const previous = await collection.read();
    assert.deepEqual(
      previous.map((record) => record.value),
      [{ private: "Private batched permission record 591274", version: 1 }],
    );
    await collection.write([
      await collection.packet(
        areas[0]!.prefix,
        {
          private: "Private batched permission record 591274",
          version: 2,
        },
        previous[0]!.envelope,
      ),
    ]);
  } finally {
    collection.close();
  }
  await required(
    peer.mutate(
      "zerotrust.access.publish",
      publication(final, restored.permissions.version),
    ),
  );
  const repeated = await required(
    owner.query(
      "zerotrust.access.snapshot",
      { known: after.snapshot },
      { strategy: "network-only" },
    ),
  );
  assert.equal(
    repeated.unchanged,
    true,
    "An exact replay cannot rotate the same areas again or rewind a newer business revision",
  );
  const readback = await protectedCollection(owner, areas[0]!, signal);
  try {
    assert.deepEqual(
      (await readback.read()).map((record) => record.value),
      [{ private: "Private batched permission record 591274", version: 2 }],
    );
  } finally {
    readback.close();
  }
  console.log(
    "Native access publications: forged second definition, duplicate/oversized groups and concurrent revocation publish nothing; one atomic commit covers historical grants and both replacement generations; lost response and exact retry preserve the verified state across two API instances",
  );
}
