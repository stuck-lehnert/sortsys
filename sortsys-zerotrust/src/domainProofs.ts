import { boxFrame, boxPacketFrame, sealedBox, type SealedBox } from "./boxes";
import {
  creationAuthor,
  verifyCreationOrigin,
  type CreationOrigin,
} from "./creation";
import { domainFrameFromHashes, type DomainDefinition } from "./domains";
import {
  digest,
  InvalidProtectedData,
  record,
  sized,
} from "./encoding";
import { importSigningKey, verify } from "./identity";
import type { Facet } from "./objects";
import {
  keyAuthority,
  verifyKeyAuthority,
  keyAuthorityAuthor,
  type KeyAuthority,
} from "./keyAuthorities";

export type DomainProof = {
  format: "sortsys-domain-proof-v1";
  tenant: string;
  id: string;
  scope: string;
  facet: Facet;
  generation: string;
  policyVersion: string;
  envelopeHashes: string[];
  recoveryEnvelope: SealedBox;
  proof: string;
  creation?: CreationOrigin;
  keyAuthority?: KeyAuthority;
};

/** Derive a public authorization proof; user key packages stay private. */
export async function domainProof(
  definition: DomainDefinition,
): Promise<DomainProof> {
  const { envelopes, ...publicFields } = definition;
  const envelopeHashes = await Promise.all(
    envelopes.map((box) => digest(boxPacketFrame(box))),
  );

  return {
    ...publicFields,
    format: "sortsys-domain-proof-v1",
    envelopeHashes,
  };
}

export async function verifyDomainProof(
  input: unknown,
  expected: {
    tenant: string;
    id: string;
    scope: string;
    facet: Facet;
    generation: string;
  },
  authority: (generation: string) => CryptoKey,
): Promise<DomainProof> {
  const hasCreation =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "creation");
  const hasKeyAuthority =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "keyAuthority");
  if (hasCreation && hasKeyAuthority) throw new InvalidProtectedData();
  const fields = [
    "format",
    "tenant",
    "id",
    "scope",
    "facet",
    "generation",
    "policyVersion",
    "envelopeHashes",
    "recoveryEnvelope",
    "proof",
  ];
  const value = record(input, [
    ...fields,
    ...(hasCreation ? ["creation"] : []),
    ...(hasKeyAuthority ? ["keyAuthority"] : []),
  ]);
  for (const name of [
    "tenant",
    "id",
    "scope",
    "facet",
    "generation",
  ] as const) {
    if (value[name] !== expected[name]) {
      throw new InvalidProtectedData();
    }
  }
  if (
    value.format !== "sortsys-domain-proof-v1" ||
    !Array.isArray(value.envelopeHashes) ||
    value.envelopeHashes.length > 10000 ||
    typeof value.policyVersion !== "string" ||
    typeof value.proof !== "string"
  ) {
    throw new InvalidProtectedData();
  }
  const envelopeHashes = value.envelopeHashes.map((hash) => {
    if (typeof hash !== "string") {
      throw new InvalidProtectedData();
    }
    sized(hash, 32);
    return hash;
  });
  const recoveryEnvelope = sealedBox(value.recoveryEnvelope);
  const creation = hasCreation
    ? await verifyCreationOrigin(value.creation, authority)
    : undefined;
  let management: KeyAuthority | undefined;
  if (hasKeyAuthority) {
    const certificate = keyAuthority(value.keyAuthority);
    management = await verifyKeyAuthority(
      certificate,
      {
        tenant: expected.tenant,
        generation: certificate.generation,
        scope: expected.scope,
        facet: expected.facet,
      },
      authority(certificate.generation),
    );
  }
  let rootGeneration =
    creation?.capability.generation ??
    recoveryEnvelope.author.match(/^authority:([1-9]\d*)$/)?.[1];
  if (management) rootGeneration = management.generation;
  if (!rootGeneration) {
    throw new InvalidProtectedData();
  }
  let signer = authority(rootGeneration);
  let expectedAuthor = `authority:${rootGeneration}`;
  if (creation) {
    signer = await importSigningKey(creation.capability.creator.signingKey);
    expectedAuthor = creationAuthor(creation);
  } else if (management) {
    signer = await importSigningKey(management.holder.signingKey);
    expectedAuthor = keyAuthorityAuthor(management);
  }
  if (
    recoveryEnvelope.tenant !== expected.tenant ||
    recoveryEnvelope.object !== expected.id ||
    recoveryEnvelope.generation !== expected.generation ||
    recoveryEnvelope.purpose !== "area-key" ||
    recoveryEnvelope.recipient !== `recovery:${rootGeneration}` ||
    recoveryEnvelope.author !== expectedAuthor
  ) {
    throw new InvalidProtectedData();
  }
  const proof: DomainProof = {
    ...expected,
    format: "sortsys-domain-proof-v1",
    policyVersion: value.policyVersion,
    envelopeHashes,
    recoveryEnvelope,
    proof: value.proof,
    ...(creation ? { creation } : {}),
    ...(management ? { keyAuthority: management } : {}),
  };
  const recoveryHash = await digest(boxPacketFrame(recoveryEnvelope));
  await verify(
    signer,
    proof.proof,
    await domainFrameFromHashes(proof, [...envelopeHashes, recoveryHash]),
  );
  await verify(signer, recoveryEnvelope.signature, boxFrame(recoveryEnvelope));
  return proof;
}
