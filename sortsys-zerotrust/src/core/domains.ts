import { boxFrame, boxPacketFrame, openBox, sealBox, sealedBox } from "../boxes";
import type { SealedBox } from "../boxes";
import {
  frame,
  identifier,
  InvalidProtectedData,
  randomSecret,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "../encoding";
import { areaKey, hpke, sign } from "../identity";
import {
  publicProofDigest as digest,
  verifyPublicProof as verify,
} from "../publicProofs";
import type { PublicIdentity } from "../identity";

import { facetVocabulary } from "./vocabulary";
import { createKeyAuthorityCodec, type KeyAuthority } from "./keyAuthorities";

export type DomainCreation<F extends string = string> = {
  tenant: string;
  id: string;
  scope: string;
  facet: F;
  signature: string;
};

/** The application certifies delegated creation. The core binds its proof to
 * the exact domain and never interprets roles, namespaces or resource IDs. */
export type DomainCreationCodec<
  F extends string,
  C extends DomainCreation<F>,
> = {
  parse: (input: unknown) => C;
  /** The frame is the exact unsigned message whose origin signature was verified. */
  verify: (
    input: unknown,
    authority: (generation: string) => CryptoKey,
  ) => Promise<{ origin: C; frame: Uint8Array<ArrayBuffer> }>;
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
  keyAuthority?: KeyAuthority<F>;
};

export function createDomainCodec<
  const F extends string,
  C extends DomainCreation<F> = never,
>(facets: readonly F[], creation?: DomainCreationCodec<F, C>) {
  const allowedFacets = facetVocabulary(facets);
  const keyAuthorities = createKeyAuthorityCodec(facets);
  const configuredCreation =
    creation === undefined ? undefined : Object.freeze({ ...creation });
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
    const optional = ["creation", "keyAuthority"].filter(
      (key) => input && typeof input === "object" && Object.hasOwn(input, key),
    );
    const raw = record(input, [...keys, ...optional]);
    if (raw.creation !== undefined && raw.keyAuthority !== undefined) {
      throw new InvalidProtectedData();
    }
    for (const key of [
      "tenant",
      "id",
      "scope",
      "facet",
      "generation",
    ] as const) {
      if (raw[key] !== expected[key]) {
        throw new InvalidProtectedData();
      }
    }
    if (!Array.isArray(raw.envelopes) || typeof raw.proof !== "string") {
      throw new InvalidProtectedData();
    }
    const recoveryEnvelope = sealedBox(raw.recoveryEnvelope);
    const creationProof =
      raw.creation === undefined
        ? undefined
        : await requiredCreation().verify(raw.creation, authority);
    const origin = creationProof?.origin;

    let keyAuthority: KeyAuthority<F> | undefined;
    if (raw.keyAuthority !== undefined) {
      const parsed = keyAuthorities.parse(raw.keyAuthority);
      keyAuthority = await keyAuthorities.verify(
        parsed,
        {
          tenant: expected.tenant,
          generation: parsed.generation,
          scope: expected.scope,
          facet: expected.facet,
        },
        authority(parsed.generation),
      );
    }
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
    let rootGeneration = recoveryEnvelope.author.match(
      /^authority:([1-9]\d*)$/,
    )?.[1];
    if (origin !== undefined) {
      rootGeneration = requiredCreation().authorityGeneration(origin);
    }
    if (keyAuthority) rootGeneration = keyAuthority.generation;
    if (!rootGeneration) {
      throw new InvalidProtectedData();
    }
    revision(rootGeneration);
    const definition: DomainDefinition<F, C> = {
      ...raw,
      envelopes: raw.envelopes.map(sealedBox),
      recoveryEnvelope,
      ...(origin ? { creation: origin } : {}),
      ...(keyAuthority ? { keyAuthority } : {}),
    } as DomainDefinition<F, C>;
    let key = authority(rootGeneration);
    let author = `authority:${rootGeneration}`;
    if (origin) {
      key = await requiredCreation().signer(origin);
      author = requiredCreation().author(origin);
    } else if (keyAuthority) {
      key = await keyAuthorities.signer(keyAuthority);
      author = keyAuthorities.author(keyAuthority);
    }
    const message = await buildDomainFrame(definition, creationProof?.frame);
    await verify(key, definition.proof, message);

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

  function domainFrame(
    input: Omit<DomainDefinition<F, C>, "proof">,
  ): Promise<Uint8Array<ArrayBuffer>> {
    return buildDomainFrame(input);
  }

  async function buildDomainFrame(
    input: Omit<DomainDefinition<F, C>, "proof">,
    verifiedOriginFrame?: Uint8Array<ArrayBuffer>,
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
        digest(boxPacketFrame(box)),
      ),
    );
    return buildDomainFrameFromHashes(input, hashes, verifiedOriginFrame);
  }

  type DomainHeader = Omit<
    DomainDefinition<F, C>,
    "envelopes" | "recoveryEnvelope" | "proof"
  >;

  /** The public proof uses the same signed frame without exposing user key boxes. */
  function domainFrameFromHashes(
    input: DomainHeader,
    packetHashes: readonly string[],
  ): Promise<Uint8Array<ArrayBuffer>> {
    return buildDomainFrameFromHashes(input, packetHashes);
  }

  async function buildDomainFrameFromHashes(
    input: DomainHeader,
    packetHashes: readonly string[],
    verifiedOriginFrame?: Uint8Array<ArrayBuffer>,
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
    if (input.creation && input.keyAuthority) throw new InvalidProtectedData();
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
      const originMessage =
        verifiedOriginFrame ?? (await requiredCreation().frame(input.creation));
      const packet = signedPacketFrame(originMessage, input.creation.signature);
      hashes.push(await digest(packet));
    }
    if (input.keyAuthority) {
      const { signature, ...certificate } = keyAuthorities.parse(
        input.keyAuthority,
      );
      if (
        certificate.tenant !== input.tenant ||
        certificate.scope !== input.scope ||
        certificate.facet !== input.facet
      ) {
        throw new InvalidProtectedData();
      }
      hashes.push(
        await digest(
          signedPacketFrame(keyAuthorities.frame(certificate), signature),
        ),
      );
    }
    let frameDomain = "sortsys/domain/v1";
    if (input.creation) frameDomain = "sortsys/domain-created/v1";
    if (input.keyAuthority) frameDomain = "sortsys/domain-managed/v1";
    return frame(frameDomain, [
      input.tenant,
      input.id,
      input.scope,
      input.facet,
      input.generation,
      input.policyVersion,
      ...hashes,
    ]);
  }

  /** Historical grants can be signed by the tenant authority; an original
   * creator-signed box additionally needs the certified origin of this domain. */
  async function domainBoxSigner(
    definition: DomainDefinition<F, C>,
    input: unknown,
    authority: (generation: string) => CryptoKey,
    sourceAuthority?: KeyAuthority<F>,
  ): Promise<CryptoKey> {
    const box = sealedBox(input);
    const generation = box.author.match(/^authority:([1-9]\d*)$/)?.[1];
    if (generation) {
      return authority(generation);
    }
    const certificate = sourceAuthority ?? definition.keyAuthority;
    if (certificate && box.author === keyAuthorities.author(certificate)) {
      const verified = await keyAuthorities.verify(
        certificate,
        {
          tenant: definition.tenant,
          generation: certificate.generation,
          scope: definition.scope,
          facet: definition.facet,
        },
        authority(certificate.generation),
      );
      return keyAuthorities.signer(verified);
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
        requiredCreation()
          .readers(origin)
          .map((reader) => [reader.subject, reader.identity]),
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
            ),
          ),
      );
      const recoveryEnvelope = await sealBox(
        {
          tenant: origin.tenant,
          purpose: "area-key",
          object: origin.id,
          generation: "1",
          recipient: `recovery:${requiredCreation().authorityGeneration(
            origin,
          )}`,
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
    keyAuthority?: KeyAuthority<F>;
  }): Promise<{ definition: DomainDefinition<F, C>; key: CryptoKey }> {
    const raw = randomSecret();
    try {
      let author = `authority:${input.authorityGeneration}`;
      if (input.keyAuthority) {
        const certificate = keyAuthorities.parse(input.keyAuthority);
        if (
          certificate.tenant !== input.tenant ||
          certificate.scope !== input.scope ||
          certificate.facet !== input.facet ||
          certificate.generation !== input.authorityGeneration
        ) {
          throw new InvalidProtectedData();
        }
        author = keyAuthorities.author(certificate);
      }
      const readers = [...input.readers].sort((a, b) =>
        compareIdentifiers(a.subject, b.subject),
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
              author,
            },
            raw,
            await hpke.kem.deserializePublicKey(
              sized(reader.identity.encryptionKey, 32),
            ),
            input.authorityKey,
          ),
        ),
      );
      const recoveryEnvelope = await sealBox(
        {
          tenant: input.tenant,
          purpose: "area-key",
          object: input.id,
          generation: input.generation,
          recipient: `recovery:${input.authorityGeneration}`,
          author,
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
        ...(input.keyAuthority ? { keyAuthority: input.keyAuthority } : {}),
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

  async function createManagedDomain(
    input: Omit<
      Parameters<typeof createDomain>[0],
      "authorityGeneration" | "authorityKey"
    > & {
      keyAuthority: KeyAuthority<F>;
      signingKey: CryptoKey;
    },
  ) {
    const { signingKey, ...options } = input;
    return createDomain({
      ...options,
      authorityGeneration: input.keyAuthority.generation,
      authorityKey: signingKey,
    });
  }

  /** Rewrap one authenticated area key for recipients selected by the caller's
   * verified policy. No raw key is returned; the owned temporary buffer is
   * cleared on success, failure and cancellation. No network dependency. */
  async function rewrapDomainKey(input: {
    definition: unknown;
    area: {
      tenant: string;
      id: string;
      scope: string;
      facet: F;
      generation: string;
    };
    envelope: unknown;
    owner: { subject: string; privateKey: CryptoKey };
    authority: {
      generation: string;
      privateKey: CryptoKey;
      keyAuthority?: KeyAuthority<F>;
    };
    sourceAuthority?: KeyAuthority<F>;
    history: (generation: string) => CryptoKey;
    readers: readonly { subject: string; identity: PublicIdentity }[];
    signal?: AbortSignal;
    live?: () => void;
  }): Promise<SealedBox[]> {
    const checkpoint = () => {
      input.signal?.throwIfAborted();
      input.live?.();
    };
    checkpoint();
    identifier(input.owner.subject);
    revision(input.authority.generation);
    if (input.readers.length > 10000) throw new InvalidProtectedData();
    const subjects = new Set<string>();
    const readers = input.readers.map((reader) => {
      identifier(reader.subject);
      if (subjects.has(reader.subject)) throw new InvalidProtectedData();
      subjects.add(reader.subject);
      sized(reader.identity.encryptionKey, 32);
      return {
        subject: reader.subject,
        encryptionKey: reader.identity.encryptionKey,
      };
    });
    const area = { ...input.area };
    let grantAuthor = `authority:${input.authority.generation}`;
    if (input.authority.keyAuthority) {
      const certificate = await keyAuthorities.verify(
        input.authority.keyAuthority,
        {
          tenant: area.tenant,
          generation: input.authority.generation,
          scope: area.scope,
          facet: area.facet,
          holder: input.owner.subject,
        },
        input.history(input.authority.generation),
      );
      checkpoint();
      grantAuthor = keyAuthorities.author(certificate);
    }
    const definition = await verifyDomain(
      input.definition,
      area,
      input.history,
    );
    checkpoint();
    const envelope = sealedBox(input.envelope);
    const raw = await openBox(
      envelope,
      {
        tenant: area.tenant,
        purpose: "area-key",
        object: area.id,
        generation: area.generation,
        recipient: input.owner.subject,
        author: envelope.author,
      },
      input.owner.privateKey,
      await domainBoxSigner(
        definition,
        envelope,
        input.history,
        input.sourceAuthority,
      ),
    );
    try {
      checkpoint();
      if (raw.length !== 32) throw new InvalidProtectedData();
      const grants: SealedBox[] = [];
      for (const reader of readers) {
        checkpoint();
        grants.push(
          await sealBox(
            {
              tenant: area.tenant,
              purpose: "area-key",
              object: area.id,
              generation: area.generation,
              recipient: reader.subject,
              author: grantAuthor,
            },
            raw,
            await hpke.kem.deserializePublicKey(
              sized(reader.encryptionKey, 32),
            ),
            input.authority.privateKey,
          ),
        );
        checkpoint();
      }
      return grants;
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
    createManagedDomain,
    createDelegatedDomain,
    rewrapDomainKey,
  });
}

export type DomainCodec<
  F extends string,
  C extends DomainCreation<F> = never,
> = ReturnType<typeof createDomainCodec<F, C>>;

function compareIdentifiers(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}
