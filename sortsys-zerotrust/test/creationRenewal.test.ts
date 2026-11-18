import { expect, test } from "bun:test";
import {
  base64,
  createIdentity,
  createOrigin,
  creationRenewalFrame,
  sign,
  verify,
} from "../src/sortsys";
import { creationFixture } from "./support/creationFixture";

async function fixture() {
  const source = await creationFixture("tool-tracking");
  const scope = await createOrigin(
    { ...source.origin, facet: "scope", id: `${source.origin.scope}:scope` },
    source.creator.signingKey.privateKey,
  );
  return {
    ...source,
    renewal: {
      origins: [source.origin, scope],
      object: `${source.origin.scope}:master-data:record`,
      revision: "17",
      packetSignature: base64(new Uint8Array(64).fill(5)),
    },
  };
}

test("origin renewal requires a separate root signature bound to the exact source and both facets", async () => {
  const { renewal, authorityKey, creator } = await fixture();
  const frame = await creationRenewalFrame(renewal);
  const proof = await sign(authorityKey.privateKey, frame);
  await verify(authorityKey.publicKey, proof, frame);
  await expect(
    verify(creator.signingKey.publicKey, proof, frame),
  ).rejects.toThrow();
  for (const changed of [
    { ...renewal, revision: "18" },
    { ...renewal, packetSignature: base64(new Uint8Array(64).fill(6)) },
    {
      ...renewal,
      origins: [
        {
          ...renewal.origins[0]!,
          signature: base64(new Uint8Array(64).fill(7)),
        },
        renewal.origins[1]!,
      ],
    },
  ])
    await expect(
      verify(
        authorityKey.publicKey,
        proof,
        await creationRenewalFrame(changed),
      ),
    ).rejects.toThrow();
  const replacement = await createIdentity();
  await expect(
    verify(replacement.signingKey.publicKey, proof, frame),
  ).rejects.toThrow();
});

test("renewal rejects incomplete, reversed, cross-resource and conditional origins", async () => {
  const { renewal, origin } = await fixture();
  for (const changed of [
    { ...renewal, origins: [origin] },
    { ...renewal, origins: [...renewal.origins].reverse() },
    {
      ...renewal,
      origins: [origin, { ...renewal.origins[1]!, tenant: "other" }],
    },
    { ...renewal, object: `${origin.scope}:procurement:record` },
    {
      ...renewal,
      origins: [
        origin,
        { ...renewal.origins[1]!, assignee: origin.capability.creator },
      ],
    },
    { ...renewal, packetSignature: "invalid" },
  ])
    await expect(creationRenewalFrame(changed)).rejects.toThrow();
});
