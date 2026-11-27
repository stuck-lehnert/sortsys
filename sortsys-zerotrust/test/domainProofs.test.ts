import { expect, test } from "bun:test";
import { boxFrame } from "../src/boxes";
import { digest, signedPacketFrame } from "../src/encoding";
import {
  certifyCreationCapability,
  certifyIdentity,
  createDelegatedDomain,
  createDomain,
  createIdentity,
  createOrigin,
  createTenantSetup,
  domainProof,
  publicIdentity,
  verifyDomainProof,
} from "../src/sortsys";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

async function fixture(delegated = false) {
  const owner = await createIdentity();
  const reader = await createIdentity();
  const { setup, authorityKey } = await createTenantSetup(
    "test",
    "user:1",
    owner,
    PHRASE,
  );
  const expected = {
    tenant: "test",
    id: "commercial:2:offer-prices",
    scope: "commercial:2",
    facet: "offer-prices" as const,
    generation: "1",
  };
  const readerCertificate = await certifyIdentity(
    {
      tenant: "test",
      user: "user:2",
      generation: "1",
      ...(await publicIdentity(reader)),
    },
    authorityKey.privateKey,
  );
  const recovery = {
    encryptionKey: setup.authority.recoveryEncryptionKey,
    signingKey: setup.authority.recoverySigningKey,
  };
  let definition;
  if (delegated) {
    const capability = await certifyCreationCapability(
      {
        tenant: "test",
        id: "capability",
        generation: "1",
        namespace: "commercial",
        creator: setup.owner,
        readers: [readerCertificate],
      },
      authorityKey.privateKey,
    );
    const origin = await createOrigin(
      {
        tenant: "test",
        id: expected.id,
        scope: expected.scope,
        facet: expected.facet,
        capability,
      },
      owner.signingKey.privateKey,
    );
    definition = (
      await createDelegatedDomain({
        origin,
        creatorKey: owner.signingKey.privateKey,
        policyVersion: "2",
        recovery,
      })
    ).definition;
  } else {
    definition = (
      await createDomain({
        ...expected,
        policyVersion: "2",
        authorityGeneration: "1",
        authorityKey: authorityKey.privateKey,
        recovery,
        readers: [
          { subject: "user:1", identity: setup.owner },
          { subject: "user:2", identity: readerCertificate },
        ],
      })
    ).definition;
  }
  const proof = await domainProof(definition);
  return {
    definition,
    proof,
    expected,
    authority: () => authorityKey.publicKey,
  };
}

test("a public domain proof authenticates the original definition without exposing user key packages", async () => {
  for (const delegated of [false, true]) {
    const current = await fixture(delegated);
    expect(
      await verifyDomainProof(
        current.proof,
        current.expected,
        current.authority,
      ),
    ).toEqual(current.proof);
    expect(Object.hasOwn(current.proof, "envelopes")).toBe(false);
    const hashes = await Promise.all(
      current.definition.envelopes.map((box) =>
        digest(signedPacketFrame(boxFrame(box), box.signature)),
      ),
    );
    expect(current.proof.envelopeHashes).toEqual(hashes);

    const encoded = JSON.stringify(current.proof);
    for (const envelope of current.definition.envelopes) {
      expect(encoded.includes(envelope.ciphertext)).toBe(false);
    }
  }
});

test("signed domain metadata and every packet hash remain bound to the original authority or creator", async () => {
  for (const delegated of [false, true]) {
    const current = await fixture(delegated);
    const changes = [
      { policyVersion: "3" },
      { envelopeHashes: [...current.proof.envelopeHashes].reverse() },
      { envelopeHashes: ["A".repeat(43)] },
      {
        recoveryEnvelope: {
          ...current.proof.recoveryEnvelope,
          recipient: "recovery:2",
        },
      },
      { envelopes: current.definition.envelopes },
      { unknown: null },
    ];
    for (const change of changes) {
      await expect(
        verifyDomainProof(
          { ...current.proof, ...change },
          current.expected,
          current.authority,
        ),
      ).rejects.toThrow();
    }
    if (delegated) {
      const { creation, ...stripped } = current.proof;
      await expect(
        verifyDomainProof(stripped, current.expected, current.authority),
      ).rejects.toThrow();
    }
    const other = await createIdentity();
    await expect(
      verifyDomainProof(
        current.proof,
        current.expected,
        () => other.signingKey.publicKey,
      ),
    ).rejects.toThrow();
  }
});
