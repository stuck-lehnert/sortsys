import { boxFrame, sealBox, sealedBox } from "../boxes";
import type { SealedBox } from "../boxes";
import {
  digest,
  frame,
  identifier,
  InvalidProtectedData,
  randomSecret,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "../encoding";
import { areaKey, hpke, sign, verify } from "../identity";
import type { PublicIdentity } from "../identity";

import { facetVocabulary } from "./vocabulary";

export type DomainCreation<F extends string = string> = {
  tenant: string;
  id: string;
  scope: string;
  facet: F;
  signature: string;
};

/** The application certifies delegated creation. The core binds its proof to
 * the exact domain and never interprets roles, namespaces or resource IDs. */
export type DomainCreationCodec<F extends string, C extends DomainCreation<F>> =
  {
    parse: (input: unknown) => C;
    verify: (
      input: unknown,
      authority: (generation: string) => CryptoKey,
    ) => Promise<C>;
    frame: (origin: C) => Promise<Uint8Array<ArrayBuffer>>;
    author: (origin: C) => string;
    authorityGeneration: (origin: C) => string;
    signer: (origin: C) => Promise<CryptoKey>;
    readers: (origin: C) => { subject: string; identity: PublicIdentity }[];
  };

export type DomainDefinition<
  F extends string = string,
  C extends DomainCreation<F> = never,
> = {
  tenant: string;
  id: string;
  scope: string;
  facet: F;
  generation: string;
  policyVersion: string;
  envelopes: SealedBox[];
  recoveryEnvelope: SealedBox;
  proof: string;
  creation?: C;
};

export function createDomainCodec<
  const F extends string,
  C extends DomainCreation<F> = never,
>(
  facets: readonly F[],
  creation?: DomainCreationCodec<F, C>,
) {
  const allowedFacets = facetVocabulary(facets);
  const configuredCreation = creation === undefined
    ? undefined
    : Object.freeze({ ...creation });
  function requiredCreation(): DomainCreationCodec<F, C> {
    if (!configuredCreation) throw new InvalidProtectedData();
    return configuredCreation;
  }
  /** A key package alone does not bind its domain to a scope or facet. Verify the
   * full signed definition before using the package to encrypt business values. */
  async function verifyDomain(
    input: unknown,
    expected: {
      tenant: string;
      id: string;
      scope: string;
      facet: F;
      generation: string;
    },
    authority: (generation: string) => CryptoKey,
  ): Promise<DomainDefinition<F, C>> {
    const keys = [
      "tenant",
      "id",
      "scope",
      "facet",
      "generation",
      "policyVersion",
      "envelopes",
      "recoveryEnvelope",
      "proof",
    ];
    const raw = record(
      input,
      input && typeof input === "object" && Object.hasOwn(input, "creation")
        ? [...keys, "creation"]
        : keys,
    );
    for (
      const key of ["tenant", "id", "scope", "facet", "generation"] as const
    ) {
      if (raw[key] !== expected[key]) {
        throw new InvalidProtectedData();
      }
    }
    if (!Array.isArray(raw.envelopes) || typeof raw.proof !== "string") {
      throw new InvalidProtectedData();
    }
    const recoveryEnvelope = sealedBox(raw.recoveryEnvelope);
    const origin = raw.creation === undefined
      ? undefined
      : await requiredCreation().verify(raw.creation, authority);
    if (
      origin &&
      (origin.tenant !== expected.tenant ||
        origin.id !== expected.id ||
        origin.scope !== expected.scope ||
        origin.facet !== expected.facet ||
        expected.generation !== "1")
    ) {
      throw new InvalidProtectedData();
    }
    let rootGeneration = recoveryEnvelope.author.match(/^authority:([1-9]\d*)$/)
      ?.[1];
    if (origin !== undefined) {
      rootGeneration = requiredCreation().authorityGeneration(origin);
    }
    if (!rootGeneration) {
      throw new InvalidProtectedData();
    }
    revision(rootGeneration);
    const definition: DomainDefinition<F, C> = {
      ...raw,
      envelopes: raw.envelopes.map(sealedBox),
      recoveryEnvelope,
      ...(origin ? { creation: origin } : {}),
    } as DomainDefinition<F, C>;
    const key = origin
      ? await requiredCreation().signer(origin)
      : authority(rootGeneration);
    const author = origin
      ? requiredCreation().author(origin)
      : `authority:${rootGeneration}`;
    await verify(key, definition.proof, await domainFrame(definition));
    for (const box of [...definition.envelopes, definition.recoveryEnvelope]) {
      if (
        box.tenant !== definition.tenant ||
        box.purpose !== "area-key" ||
        box.object !== definition.id ||
        box.generation !== definition.generation ||
        box.author !== author
      ) {
        throw new InvalidProtectedData();
      }
      await verify(key, box.signature, boxFrame(box));
    }
    if (recoveryEnvelope.recipient !== `recovery:${rootGeneration}`) {
      throw new InvalidProtectedData();
    }
    return definition;
  }

  async function domainFrame(
    input: Omit<DomainDefinition<F, C>, "proof">,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (
      !allowedFacets.has(input.facet) ||
      input.envelopes.length > 10000 ||
      new Set(input.envelopes.map((e) => e.recipient)).size !==
        input.envelopes.length
    ) {
      throw new InvalidProtectedData();
    }
    const hashes = await Promise.all(
      [...input.envelopes, input.recoveryEnvelope].map((box) =>
        digest(signedPacketFrame(boxFrame(box), box.signature))
      ),
    );
    return domainFrameFromHashes(input, hashes);
  }

  /** The public proof uses the same signed frame without exposing user key boxes. */
  async function domainFrameFromHashes(
    input: Pick<
      DomainDefinition<F, C>,
      | "tenant"
      | "id"
      | "scope"
      | "facet"
      | "generation"
      | "policyVersion"
      | "creation"
    >,
    packetHashes: readonly string[],
  ): Promise<Uint8Array<ArrayBuffer>> {
    for (const value of [input.tenant, input.id, input.scope]) {
      identifier(value);
    }
    revision(input.generation);
    revision(input.policyVersion);
    if (
      !allowedFacets.has(input.facet) ||
      packetHashes.length < 1 ||
      packetHashes.length > 10001
    ) {
      throw new InvalidProtectedData();
    }
    for (const hash of packetHashes) {
      sized(hash, 32);
    }
    const hashes = [...packetHashes];
    if (input.creation) {
      if (
        input.generation !== "1" ||
        input.creation.tenant !== input.tenant ||
        input.creation.id !== input.id ||
        input.creation.scope !== input.scope ||
        input.creation.facet !== input.facet
      ) {
        throw new InvalidProtectedData();
      }
      hashes.push(
        await digest(
          signedPacketFrame(
            await requiredCreation().frame(input.creation),
            input.creation.signature,
          ),
        ),
      );
    }
    return frame(
      input.creation ? "sortsys/domain-created/v1" : "sortsys/domain/v1",
      [
        input.tenant,
        input.id,
        input.scope,
        input.facet,
        input.generation,
        input.policyVersion,
        ...hashes,
      ],
    );
  }

  /** Historical grants can be signed by the tenant authority; an original
   * creator-signed box additionally needs the certified origin of this domain. */
  async function domainBoxSigner(
    definition: DomainDefinition<F, C>,
    input: unknown,
    authority: (generation: string) => CryptoKey,
  ): Promise<CryptoKey> {
    const box = sealedBox(input);
    const generation = box.author.match(/^authority:([1-9]\d*)$/)?.[1];
    if (generation) {
      return authority(generation);
    }
    if (
      definition.creation &&
      box.author === requiredCreation().author(definition.creation)
    ) {
      return requiredCreation().signer(definition.creation);
    }
    throw new InvalidProtectedData();
  }

  async function createDelegatedDomain(input: {
    origin: C;
    creatorKey: CryptoKey;
    policyVersion: string;
    recovery: PublicIdentity;
  }): Promise<{ definition: DomainDefinition<F, C>; key: CryptoKey }> {
    const origin = requiredCreation().parse(input.origin);
    const raw = randomSecret();
    try {
      const readers = new Map(
        requiredCreation().readers(origin).map(
          (reader) => [reader.subject, reader.identity],
        ),
      );
      const author = requiredCreation().author(origin);
      const envelopes = await Promise.all(
        [...readers]
          .sort(([a], [b]) => compareIdentifiers(a, b))
          .map(async ([subject, reader]) =>
            sealBox(
              {
                tenant: origin.tenant,
                purpose: "area-key",
                object: origin.id,
                generation: "1",
                recipient: subject,
                author,
              },
              raw,
              await hpke.kem.deserializePublicKey(
                sized(reader.encryptionKey, 32),
              ),
              input.creatorKey,
            )
          ),
      );
      const recoveryEnvelope = await sealBox(
        {
          tenant: origin.tenant,
          purpose: "area-key",
          object: origin.id,
          generation: "1",
          recipient: `recovery:${
            requiredCreation().authorityGeneration(origin)
          }`,
          author,
        },
        raw,
        await hpke.kem.deserializePublicKey(
          sized(input.recovery.encryptionKey, 32),
        ),
        input.creatorKey,
      );
      const unsigned = {
        tenant: origin.tenant,
        id: origin.id,
        scope: origin.scope,
        facet: origin.facet,
        generation: "1",
        policyVersion: input.policyVersion,
        envelopes,
        recoveryEnvelope,
        creation: origin,
      };
      return {
        definition: {
          ...unsigned,
          proof: await sign(input.creatorKey, await domainFrame(unsigned)),
        },
        key: await areaKey(raw),
      };
    } finally {
      raw.fill(0);
    }
  }

  async function createDomain(input: {
    tenant: string;
    id: string;
    scope: string;
    facet: F;
    generation: string;
    policyVersion: string;
    authorityGeneration: string;
    authorityKey: CryptoKey;
    recovery: PublicIdentity;
    readers: { subject: string; identity: PublicIdentity }[];
  }): Promise<{ definition: DomainDefinition<F, C>; key: CryptoKey }> {
    const raw = randomSecret();
    try {
      const readers = [...input.readers].sort((a, b) =>
        compareIdentifiers(a.subject, b.subject)
      );
      const envelopes = await Promise.all(
        readers.map(async (reader) =>
          sealBox(
            {
              tenant: input.tenant,
              purpose: "area-key",
              object: input.id,
              generation: input.generation,
              recipient: reader.subject,
              author: `authority:${input.authorityGeneration}`,
            },
            raw,
            await hpke.kem.deserializePublicKey(
              sized(reader.identity.encryptionKey, 32),
            ),
            input.authorityKey,
          )
        ),
      );
      const recoveryEnvelope = await sealBox(
        {
          tenant: input.tenant,
          purpose: "area-key",
          object: input.id,
          generation: input.generation,
          recipient: `recovery:${input.authorityGeneration}`,
          author: `authority:${input.authorityGeneration}`,
        },
        raw,
        await hpke.kem.deserializePublicKey(
          sized(input.recovery.encryptionKey, 32),
        ),
        input.authorityKey,
      );
      const unsigned = {
        tenant: input.tenant,
        id: input.id,
        scope: input.scope,
        facet: input.facet,
        generation: input.generation,
        policyVersion: input.policyVersion,
        envelopes,
        recoveryEnvelope,
      };
      return {
        definition: {
          ...unsigned,
          proof: await sign(input.authorityKey, await domainFrame(unsigned)),
        },
        key: await areaKey(raw),
      };
    } finally {
      raw.fill(0);
    }
  }

  return Object.freeze({
    verifyDomain,
    domainFrame,
    domainFrameFromHashes,
    domainBoxSigner,
    createDomain,
    createDelegatedDomain,
  });
}

export type DomainCodec<F extends string, C extends DomainCreation<F> = never> =
  ReturnType<typeof createDomainCodec<F, C>>;

function compareIdentifiers(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}
