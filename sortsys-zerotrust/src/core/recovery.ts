import {
  readRecoveryCatalog,
  type RecoveryCatalogStorage,
} from "../recoveryCatalog";
import {
  authorityCertificate,
  authorityFrame,
  verifyAuthority,
} from "./certificates";
import type { AuthorityCertificate } from "./certificates";
import { boxFrame, openBox, sealBox, sealedBox } from "../boxes";
import type { SealedBox } from "../boxes";
import type { DomainCodec, DomainCreation, DomainDefinition } from "./domains";
import {
  base64,
  digest,
  frame,
  identifier,
  InvalidProtectedData,
  randomSecret,
  record,
  revision,
  signedPacketFrame,
  sized,
  unbase64,
} from "../encoding";
import {
  createIdentity,
  importSigningKey,
  publicIdentity,
  sign,
  verify,
} from "../identity";
import type { PrivateIdentity } from "../identity";
import { facetVocabulary } from "./vocabulary";
import { finishOpaqueRegistration, startOpaqueRegistration } from "../opaque";
import type {
  OpaqueRegistrationResult,
  OpaqueRegistrationStart,
} from "../opaque";
import {
  normalizeRecoveryPhrase,
  recoveryIdentity,
  recoveryTransitionFrame,
} from "../recovery";
import type { RecoveryTransition } from "../recovery";
import type { SetupCodec, TenantSetup } from "./setup";
import { accountVaultFrame, createAccountVault } from "../vault";
import type { AccountVault } from "../vault";
import { readSnapshotPages, validatePageToken } from "../snapshotPages";
import type { SnapshotPage, SnapshotPageRequest } from "../snapshotPages";
import {
  DEFAULT_RECOVERY_LIMITS,
  recoveryInventory,
  reserveRecoveryInventory,
  type RecoveryLimits,
} from "../recoveryInventory";

export type RecoverySource<
  F extends string = string,
  C extends DomainCreation<F> = never,
> = {
  challengeId: string;
  challenge: string;
  authority: AuthorityCertificate;
  catalog: SealedBox;
  catalogVersion: string;
  policyVersion: string;
  domains: { id: string; scope: string; facet: F; generation: string }[];
  domainProofs: DomainDefinition<F, C>[];
  keys: SealedBox[];
};
export type RecoverySourceHead = Omit<
  RecoverySource,
  "domains" | "domainProofs" | "keys"
> & { snapshot: string };
export type RecoveryPlan<
  F extends string = string,
  O extends string = never,
  C extends DomainCreation<F> = never,
> = {
  challengeId: string;
  sourceAuthority: AuthorityCertificate;
  transition: RecoveryTransition;
  nextSetup: TenantSetup<F, O>;
  username: string;
  accountVersion?: string;
  registrationRecord: string;
  vault: AccountVault;
  oldKeyEnvelopes: SealedBox[];
  domains: DomainDefinition<F, C>[];
  proof: string;
  nextProof: string;
};
type ArchivedKey = { domain: string; generation: string; key: string };

export type RecoveryAccount = { subject: string; username: string };
export type ExistingRecoveryAccount = RecoveryAccount & { version: string };
export type RecoveryOptions = {
  createAdministrator?: () => RecoveryAccount;
  inventoryLimits?: RecoveryLimits;
};

export function createRecoveryCodec<
  F extends string,
  O extends string = never,
  C extends DomainCreation<F> = never,
>(
  facets: readonly F[],
  domainCodec: DomainCodec<F, C>,
  setupCodec: SetupCodec<F, O>,
  options: RecoveryOptions = {},
) {
  const allowedFacets = facetVocabulary(facets);
  const createAdministrator =
    options.createAdministrator ?? defaultRecoveryAccount;
  const inventoryLimits = Object.freeze({
    ...(options.inventoryLimits ?? DEFAULT_RECOVERY_LIMITS),
  });
  recoveryInventory({ domains: 0, keyGenerations: 0 }, inventoryLimits);
  const { createDomain, domainFrame, domainBoxSigner, verifyDomain } =
    domainCodec;
  const { createTenantSetup, tenantSetupFrame } = setupCodec;
  function recoverySource(input: unknown): RecoverySource<F, C> {
    const source = record(input, [
      "challengeId",
      "challenge",
      "authority",
      "catalog",
      "catalogVersion",
      "policyVersion",
      "domains",
      "domainProofs",
      "keys",
    ]);
    identifier(source.challengeId);
    revision(source.catalogVersion);
    revision(source.policyVersion);
    if (typeof source.challenge !== "string") throw new InvalidProtectedData();
    sized(source.challenge, 32);
    const authority = authorityCertificate(source.authority);
    if (
      !Array.isArray(source.domains) ||
      source.domains.length > inventoryLimits.domains ||
      !Array.isArray(source.domainProofs) ||
      !Array.isArray(source.keys) ||
      source.keys.length > inventoryLimits.keyGenerations ||
      source.domainProofs.length > source.keys.length
    )
      throw new InvalidProtectedData();
    const domains = source.domains.map((input) => {
      const domain = record(input, ["id", "scope", "facet", "generation"]);
      identifier(domain.id);
      identifier(domain.scope);
      revision(domain.generation);
      if (!allowedFacets.has(domain.facet as string)) {
        throw new InvalidProtectedData();
      }
      return { ...domain } as RecoverySource<F, C>["domains"][number];
    });
    return {
      challengeId: source.challengeId as string,
      challenge: source.challenge,
      authority: { ...authority },
      catalog: sealedBox(source.catalog),
      catalogVersion: source.catalogVersion as string,
      policyVersion: source.policyVersion as string,
      domains,
      domainProofs: [...source.domainProofs] as DomainDefinition<F, C>[],
      keys: source.keys.map(sealedBox),
    };
  }

  function recoveryInspectFrame(
    tenant: string,
    generation: string,
    nonce: string,
  ): Uint8Array<ArrayBuffer> {
    identifier(tenant);
    revision(generation);
    sized(nonce, 32);
    return frame("sortsys/recovery-inspect/v1", [tenant, generation, nonce]);
  }

  function recoveryAccountFrame(
    tenant: string,
    generation: string,
    nonce: string,
  ): Uint8Array<ArrayBuffer> {
    identifier(tenant);
    revision(generation);
    sized(nonce, 32);
    return frame("sortsys/recovery-account/v1", [tenant, generation, nonce]);
  }

  function existingRecoveryAccount(input: unknown): ExistingRecoveryAccount {
    const value = record(input, ["subject", "username", "version"]);
    identifier(value.subject);
    identifier(value.username);
    sized(value.version as string, 32);
    return { ...value } as ExistingRecoveryAccount;
  }

  async function loadRecoverySource(input: {
    head: unknown;
    read: (
      request: SnapshotPageRequest,
      head: RecoverySourceHead,
    ) => Promise<SnapshotPage<unknown>>;
    signal?: AbortSignal;
  }): Promise<RecoverySource<F, C>> {
    const header = record(input.head, [
      "challengeId",
      "challenge",
      "authority",
      "catalog",
      "catalogVersion",
      "policyVersion",
      "snapshot",
    ]);
    validatePageToken(header.snapshot);
    const { snapshot, ...metadata } = header;
    const source = recoverySource({
      ...metadata,
      domains: [],
      domainProofs: [],
      keys: [],
    });
    const head: RecoverySourceHead = {
      challengeId: source.challengeId,
      challenge: source.challenge,
      authority: source.authority,
      catalog: source.catalog,
      catalogVersion: source.catalogVersion,
      policyVersion: source.policyVersion,
      snapshot,
    };
    const domains = new Map<string, RecoverySource<F, C>["domains"][number]>();
    const keys = new Set<string>();
    for await (const page of readSnapshotPages({
      read: (request) => input.read(request, head),
      maxItems: 64,
      snapshot,
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      for (const item of page) {
        const entry = record(item, ["kind", "value"]);
        if (entry.kind === "domain") {
          const [domain] = recoverySource({
            ...metadata,
            domains: [entry.value],
            domainProofs: [],
            keys: [],
          }).domains;
          if (!domain || domains.has(domain.id))
            throw new InvalidProtectedData();
          domains.set(domain.id, domain);
          source.domains.push(domain);
        } else if (entry.kind === "key") {
          const definition = entry.value as DomainDefinition<F, C>;
          if (!definition || typeof definition !== "object")
            throw new InvalidProtectedData();
          const box = sealedBox(definition.recoveryEnvelope);
          const id = `${box.object}\0${box.generation}`;
          if (keys.has(id)) throw new InvalidProtectedData();
          keys.add(id);
          source.keys.push(box);
          const published = domains.get(box.object);
          if (
            published?.generation === box.generation ||
            definition.creation ||
            definition.keyAuthority
          ) {
            source.domainProofs.push(definition);
          }
        } else {
          throw new InvalidProtectedData();
        }
      }
      // Source preparation and publication still validate a complete inventory.
      // Keep their admission bounds explicit instead of returning a prefix.
      if (
        source.domains.length > inventoryLimits.domains ||
        source.keys.length > inventoryLimits.keyGenerations
      ) {
        throw new InvalidProtectedData();
      }
    }
    return recoverySource(source);
  }

  function recoveryRegistrationFrame(
    tenant: string,
    challengeId: string,
    username: string,
    subject: string,
    registrationRequest: string,
    accountVersion?: string,
  ): Uint8Array<ArrayBuffer> {
    for (const value of [tenant, challengeId, username, subject])
      identifier(value);
    if (accountVersion !== undefined) sized(accountVersion, 32);
    return frame("sortsys/recovery-registration/v3", [
      tenant,
      challengeId,
      username,
      subject,
      registrationRequest,
      accountVersion ?? "",
    ]);
  }

  async function recoveryBundleHash(
    input: Pick<
      RecoveryPlan<F, O, C>,
      | "username"
      | "accountVersion"
      | "registrationRecord"
      | "nextSetup"
      | "vault"
      | "oldKeyEnvelopes"
      | "domains"
    >,
  ): Promise<string> {
    if (input.accountVersion !== undefined) sized(input.accountVersion, 32);
    const oldKeys = await Promise.all(
      input.oldKeyEnvelopes.map((box) =>
        digest(signedPacketFrame(boxFrame(box), box.signature)),
      ),
    );
    const domains = await Promise.all(
      input.domains.map(async (domain) =>
        digest(signedPacketFrame(await domainFrame(domain), domain.proof)),
      ),
    );
    return digest(
      frame("sortsys/recovery-bundle/v2", [
        input.username,
        input.accountVersion ?? "",
        await digest(unbase64(input.registrationRecord, 4096)),
        await digest(
          signedPacketFrame(
            await tenantSetupFrame(input.nextSetup),
            input.nextSetup.proof,
          ),
        ),
        await digest(accountVaultFrame(input.vault)),
        base64(frame("sortsys/archivekeys/v1", oldKeys)),
        base64(frame("sortsys/new-domains/v1", domains)),
      ]),
    );
  }

  // The callback receives an OPAQUE registration request and a public-key proof,
  // never a password, phrase, raw area key or decrypted catalog.
  async function prepareRecovery(input: {
    oldPhrase: string;
    newPhrase: string;
    password: string;
    source: RecoverySource<F, C>;
    administrator?: ExistingRecoveryAccount;
    catalogStorage?: RecoveryCatalogStorage;
    registrationCrypto?: {
      start: (password: string) => Promise<OpaqueRegistrationStart>;
      finish: (
        password: string,
        tenant: string,
        subject: string,
        state: OpaqueRegistrationStart,
        response: string,
      ) => Promise<OpaqueRegistrationResult>;
    };
    register: (input: {
      tenant: string;
      challengeId: string;
      username: string;
      subject: string;
      registrationRequest: string;
      accountVersion?: string;
      proof: string;
    }) => Promise<{ registrationResponse: string }>;
  }): Promise<{ plan: RecoveryPlan<F, O, C>; identity: PrivateIdentity }> {
    const source = recoverySource(input.source);
    const existing =
      input.administrator === undefined
        ? undefined
        : existingRecoveryAccount(input.administrator);
    if (input.password.length < 10 || input.password.length > 2000) {
      throw new InvalidProtectedData();
    }
    const tenant = source.authority.tenant;
    const generation = source.authority.generation;
    revision(generation);
    revision(source.policyVersion);
    const nextGeneration = (BigInt(generation) + 1n).toString();
    const nextPolicyVersion = (BigInt(source.policyVersion) + 1n).toString();
    revision(nextGeneration);
    revision(nextPolicyVersion);
    revision(source.catalogVersion);
    sized(source.challenge, 32);
    identifier(source.challengeId);
    const publishedDomains = new Map(
      source.domains.map((domain) => [domain.id, domain]),
    );
    if (
      source.domains.length > inventoryLimits.domains ||
      source.keys.length > inventoryLimits.keyGenerations ||
      publishedDomains.size !== source.domains.length
    )
      throw new InvalidProtectedData();
    if (
      normalizeRecoveryPhrase(input.oldPhrase) ===
      normalizeRecoveryPhrase(input.newPhrase)
    )
      throw new InvalidProtectedData();
    const oldRecovery = await recoveryIdentity(
      input.oldPhrase,
      tenant,
      generation,
    );
    const oldPublic = await publicIdentity(oldRecovery);
    const oldAuthority = await verifyAuthority(source.authority, {
      tenant,
      generation,
      recoverySigningKey: oldPublic.signingKey,
    });
    if (oldAuthority.recoveryEncryptionKey !== oldPublic.encryptionKey) {
      throw new InvalidProtectedData();
    }
    const oldAuthorityKey = await importSigningKey(
      oldAuthority.authoritySigningKey,
    );
    const authority = (version: string) => {
      if (version !== generation) throw new InvalidProtectedData();
      return oldAuthorityKey;
    };
    const recoveryBoxes = new Map(
      source.keys.map((box) => [`${box.object}\0${box.generation}`, box]),
    );
    const verifiedHeads = new Set<string>();
    const verifiedDefinitions = new Map<string, DomainDefinition<F, C>>();
    for (const definition of source.domainProofs) {
      if (!definition || typeof definition !== "object")
        throw new InvalidProtectedData();
      const published = publishedDomains.get(definition.id);
      revision(definition.generation);
      const id = `${definition.id}\0${definition.generation}`;
      if (
        !published ||
        BigInt(definition.generation) > BigInt(published.generation) ||
        verifiedDefinitions.has(id)
      ) {
        throw new InvalidProtectedData();
      }
      const verified = await verifyDomain(
        definition,
        { tenant, ...published, generation: definition.generation },
        authority,
      );
      const box = recoveryBoxes.get(id);
      if (
        !box ||
        box.signature !== verified.recoveryEnvelope.signature ||
        base64(boxFrame(box)) !== base64(boxFrame(verified.recoveryEnvelope))
      ) {
        throw new InvalidProtectedData();
      }
      verifiedDefinitions.set(id, verified);
      if (verified.generation === published.generation) {
        verifiedHeads.add(verified.id);
      }
    }
    if (verifiedHeads.size !== publishedDomains.size) {
      throw new InvalidProtectedData();
    }
    const archived = new Map<string, ArchivedKey>();
    const collect = (value: unknown) => {
      const key = record(value, ["domain", "generation", "key"]);
      identifier(key.domain);
      revision(key.generation);
      if (typeof key.key !== "string") throw new InvalidProtectedData();
      sized(key.key, 32);
      const current = { ...key } as ArchivedKey;
      // A staged key from an aborted publication has never encrypted an object.
      // Old catalogues can contain it; retain only published domain generations.
      const published = publishedDomains.get(current.domain);
      if (
        !published ||
        BigInt(current.generation) > BigInt(published.generation)
      )
        return;
      const id = `${current.domain}\0${current.generation}`;
      if (archived.has(id) && archived.get(id)!.key !== current.key) {
        throw new InvalidProtectedData();
      }
      archived.set(id, current);
      if (archived.size > inventoryLimits.keyGenerations)
        throw new InvalidProtectedData();
    };
    for await (const key of readRecoveryCatalog(source.catalog, {
      tenant,
      generation,
      encryptionKey: oldRecovery.encryptionKey.privateKey,
      signingKey: oldAuthorityKey,
      ...(input.catalogStorage ? { storage: input.catalogStorage } : {}),
    })) {
      collect(key);
    }
    for (const box of source.keys) {
      let signer = oldAuthorityKey;
      if (box.author !== `authority:${generation}`) {
        const definition = verifiedDefinitions.get(
          `${box.object}\0${box.generation}`,
        );
        if (
          !definition ||
          definition.recoveryEnvelope.signature !== box.signature ||
          definition.generation !== box.generation
        )
          throw new InvalidProtectedData();
        signer = await domainBoxSigner(definition, box, authority);
      }
      const raw = await openBox(
        box,
        {
          tenant,
          purpose: "area-key",
          object: box.object,
          generation: box.generation,
          recipient: `recovery:${generation}`,
          author: box.author,
        },
        oldRecovery.encryptionKey.privateKey,
        signer,
      );
      try {
        collect({
          domain: box.object,
          generation: box.generation,
          key: base64(raw),
        });
      } finally {
        raw.fill(0);
      }
    }
    for (const domain of source.domains) {
      identifier(domain.id);
      identifier(domain.scope);
      revision(domain.generation);
      if (!archived.has(`${domain.id}\0${domain.generation}`)) {
        throw new InvalidProtectedData();
      }
    }
    reserveRecoveryInventory(
      { domains: source.domains.length, keyGenerations: archived.size },
      { domains: 0, keyGenerations: source.domains.length },
      inventoryLimits,
    );
    const { subject, username } = existing ?? createAdministrator();
    identifier(subject);
    identifier(username);
    const identity = await createIdentity();
    const keys = [...archived.values()].sort((a, b) =>
      `${a.domain}\0${a.generation}` < `${b.domain}\0${b.generation}` ? -1 : 1,
    );
    const { setup: nextSetup, authorityKey } = await createTenantSetup(
      tenant,
      subject,
      identity,
      input.newPhrase,
      {
        generation: nextGeneration,
        ...(source.authority.context === undefined
          ? {}
          : { context: source.authority.context }),
        policyVersion: nextPolicyVersion,
        scopes: source.domains.map(({ scope, facet }) => ({ scope, facet })),
        keys,
        ...(input.catalogStorage
          ? { catalogStorage: input.catalogStorage }
          : {}),
      },
    );
    const passwordCrypto = input.registrationCrypto ?? {
      start: startOpaqueRegistration,
      finish: finishOpaqueRegistration,
    };
    const registration = await passwordCrypto.start(input.password);
    const { registrationResponse } = await input.register({
      tenant,
      challengeId: source.challengeId,
      username,
      subject,
      registrationRequest: registration.registrationRequest,
      ...(existing ? { accountVersion: existing.version } : {}),
      proof: await sign(
        oldRecovery.signingKey.privateKey,
        recoveryRegistrationFrame(
          tenant,
          source.challengeId,
          username,
          subject,
          registration.registrationRequest,
          existing?.version,
        ),
      ),
    });
    const result = await passwordCrypto.finish(
      input.password,
      tenant,
      subject,
      registration,
      registrationResponse,
    );
    const vault = await createAccountVault(
      result.exportKey,
      tenant,
      subject,
      identity,
      {
        recoveryGeneration: nextGeneration,
        recoverySigningKey: nextSetup.authority.recoverySigningKey,
      },
    );
    const publicKeys = await publicIdentity(identity);
    const currentDomains = new Set(source.domains.map((d) => d.id));
    const oldKeyEnvelopes: SealedBox[] = [];
    for (const key of keys.filter((key) => currentDomains.has(key.domain))) {
      const raw = sized(key.key, 32);
      try {
        oldKeyEnvelopes.push(
          await sealBox(
            {
              tenant,
              purpose: "area-key",
              object: key.domain,
              generation: key.generation,
              recipient: subject,
              author: `authority:${nextGeneration}`,
            },
            raw,
            identity.encryptionKey.publicKey,
            authorityKey.privateKey,
          ),
        );
      } finally {
        raw.fill(0);
      }
    }
    const domains: DomainDefinition<F, C>[] = [];
    for (const domain of source.domains) {
      const nextKeyGeneration = (BigInt(domain.generation) + 1n).toString();
      revision(nextKeyGeneration);
      domains.push(
        (
          await createDomain({
            tenant,
            id: domain.id,
            scope: domain.scope,
            facet: domain.facet,
            generation: nextKeyGeneration,
            policyVersion: nextPolicyVersion,
            authorityGeneration: nextGeneration,
            authorityKey: authorityKey.privateKey,
            recovery: {
              encryptionKey: nextSetup.authority.recoveryEncryptionKey,
              signingKey: nextSetup.authority.recoverySigningKey,
            },
            readers: [{ subject, identity: publicKeys }],
          })
        ).definition,
      );
    }
    const unsigned = {
      challengeId: source.challengeId,
      sourceAuthority: oldAuthority,
      nextSetup,
      username,
      ...(existing ? { accountVersion: existing.version } : {}),
      registrationRecord: result.registrationRecord,
      vault,
      oldKeyEnvelopes,
      domains,
    };
    const transition: RecoveryTransition = {
      tenant,
      generation,
      operation: `zt_${base64(randomSecret())}`,
      challenge: source.challenge,
      catalogVersion: source.catalogVersion,
      catalogHash: await digest(
        signedPacketFrame(
          boxFrame(nextSetup.catalog),
          nextSetup.catalog.signature,
        ),
      ),
      previousAuthorityCertificateHash: await digest(
        signedPacketFrame(authorityFrame(oldAuthority), oldAuthority.signature),
      ),
      nextRecoveryEncryptionKey: nextSetup.authority.recoveryEncryptionKey,
      nextRecoverySigningKey: nextSetup.authority.recoverySigningKey,
      nextAuthoritySigningKey: nextSetup.authority.authoritySigningKey,
      nextAdministrator: subject,
      nextAdministratorBundleHash: await recoveryBundleHash(unsigned),
    };
    const message = recoveryTransitionFrame(transition);
    const newRecovery = await recoveryIdentity(
      input.newPhrase,
      tenant,
      nextGeneration,
    );
    return {
      plan: {
        ...unsigned,
        transition,
        proof: await sign(oldRecovery.signingKey.privateKey, message),
        nextProof: await sign(newRecovery.signingKey.privateKey, message),
      },
      identity,
    };
  }

  async function verifyRecoveryTransition(
    plan: RecoveryPlan<F, O, C>,
  ): Promise<void> {
    const t = plan.transition;
    const old = plan.sourceAuthority;
    const next = plan.nextSetup.authority;
    if (
      (await recoveryBundleHash(plan)) !== t.nextAdministratorBundleHash ||
      old.tenant !== t.tenant ||
      old.generation !== t.generation ||
      next.tenant !== t.tenant ||
      BigInt(next.generation) !== BigInt(t.generation) + 1n ||
      next.recoveryEncryptionKey !== t.nextRecoveryEncryptionKey ||
      next.recoverySigningKey !== t.nextRecoverySigningKey ||
      next.authoritySigningKey !== t.nextAuthoritySigningKey ||
      next.context !== old.context ||
      next.recoverySigningKey === old.recoverySigningKey ||
      next.recoveryEncryptionKey === old.recoveryEncryptionKey ||
      plan.nextSetup.owner.user !== t.nextAdministrator ||
      (await digest(signedPacketFrame(authorityFrame(old), old.signature))) !==
        t.previousAuthorityCertificateHash ||
      (await digest(
        signedPacketFrame(
          boxFrame(plan.nextSetup.catalog),
          plan.nextSetup.catalog.signature,
        ),
      )) !== t.catalogHash
    )
      throw new InvalidProtectedData();
    await verifyAuthority(old, {
      tenant: t.tenant,
      generation: t.generation,
      recoverySigningKey: old.recoverySigningKey,
    });
    await verifyAuthority(next, {
      tenant: t.tenant,
      generation: next.generation,
      recoverySigningKey: t.nextRecoverySigningKey,
    });
    const message = recoveryTransitionFrame(t);
    await verify(
      await importSigningKey(plan.sourceAuthority.recoverySigningKey),
      plan.proof,
      message,
    );
    await verify(
      await importSigningKey(plan.transition.nextRecoverySigningKey),
      plan.nextProof,
      message,
    );
  }

  return Object.freeze({
    recoverySource,
    loadRecoverySource,
    recoveryInspectFrame,
    recoveryAccountFrame,
    existingRecoveryAccount,
    recoveryRegistrationFrame,
    recoveryBundleHash,
    prepareRecovery,
    verifyRecoveryTransition,
  });
}

function defaultRecoveryAccount(): RecoveryAccount {
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const userId = (
    new DataView(nonce.buffer).getBigUint64(0) & 0x7fffffffffffffffn
  ).toString(32);
  if (userId === "0") throw new InvalidProtectedData();
  return { subject: `user:${userId}`, username: `recovery-${userId}` };
}
