import type { Client } from "@sortsys/v2-client";
import {
  absenceRecord,
  objectWriteAction,
  compilePolicy,
  creationRules,
  InvalidProtectedData,
  objectFrame,
  revision,
  verifyDomain,
  verifyDomainProof,
  verifyPolicy,
  stockDeletionFrame,
  type StockDeletion,
  type Action,
  type DomainDefinition,
  type EncryptedObject,
  type Facet,
  type Policy,
} from "@sortsys/zerotrust/sortsys";
import type { trustedHistory } from "./session";
import { requiredMessageProof } from "./messageProofs";

type Context = {
  account: { tenant: string };
  history: Awaited<ReturnType<typeof trustedHistory>>;
  live(): void;
};
type CheckedPolicy = { generation: string; permissions: Policy };
export type AuthorRequirement = {
  facet: Facet;
  action: Action;
  keyGeneration?: string;
};
type ControlAuthor = {
  tenant: string;
  scope: string;
  generation: string;
  policyVersion: string;
  author: string;
  signature: string;
};
type BirthProof = Pick<
  DomainDefinition,
  "policyVersion" | "creation" | "keyAuthority"
>;
type WriterDefinition = BirthProof &
  Pick<DomainDefinition, "tenant" | "scope" | "facet" | "generation">;
const proofCaches = new WeakMap<
  Client,
  WeakMap<object, Map<string, BirthProof>>
>();
const MAX_BIRTH_PROOFS = 2048;

/** A certified reader is not necessarily a writer. Check each envelope against
 * its exact root-signed policy and certified creation origin before opening it.
 * Cache public proofs within the caller's account/snapshot lifetime only. */
export function createObjectAuthorVerifier(
  client: Client,
  context: Context,
  current?: Policy,
) {
  let accounts = proofCaches.get(client);
  if (!accounts) {
    accounts = new WeakMap();
    proofCaches.set(client, accounts);
  }
  let sharedProofs = accounts.get(context.account);
  if (!sharedProofs) {
    sharedProofs = new Map();
    accounts.set(context.account, sharedProofs);
  }
  const proofCache = sharedProofs;
  function proofKey(id: string, generation: string): string {
    return `${context.history.current.generation}/${context.history.current.authoritySigningKey}/${id}/${generation}`;
  }
  function rememberProof(
    id: string,
    generation: string,
    value: BirthProof,
  ): BirthProof {
    context.live();
    const key = proofKey(id, generation);
    const previous = proofCache.get(key);
    if (
      previous &&
      (previous.policyVersion !== value.policyVersion ||
        previous.creation?.signature !== value.creation?.signature ||
        previous.keyAuthority?.signature !== value.keyAuthority?.signature)
    )
      throw new InvalidProtectedData();
    const proof = structuredClone({
      policyVersion: value.policyVersion,
      ...(value.creation ? { creation: value.creation } : {}),
      ...(value.keyAuthority ? { keyAuthority: value.keyAuthority } : {}),
    });
    proofCache.delete(key);
    proofCache.set(key, proof);
    if (proofCache.size > MAX_BIRTH_PROOFS)
      proofCache.delete(proofCache.keys().next().value!);
    return proof;
  }
  async function definition(
    input: unknown,
    expected: Parameters<typeof verifyDomain>[1],
  ): Promise<DomainDefinition> {
    if (expected.tenant !== context.account.tenant)
      throw new InvalidProtectedData();
    const verified = await verifyDomain(
      input,
      expected,
      context.history.authority,
    );
    await verifyKeyManagement(verified, expected.scope, expected.facet);
    rememberProof(verified.id, verified.generation, verified);
    return verified;
  }
  const policies = new Map<string, Promise<CheckedPolicy>>();
  const origins = new Map<string, Promise<DomainDefinition>>();
  const accessViews = new Map<string, ReturnType<typeof compilePolicy>>();
  const publicDefinitions = new Map<string, Promise<BirthProof>>();

  function accessView(
    { generation, permissions }: CheckedPolicy,
    subject: string,
    origin?: DomainDefinition["creation"],
  ) {
    const id = `${generation}/${permissions.version}/${subject}/${origin?.id ?? ""}`;
    let access = accessViews.get(id);
    if (!access) {
      const input = origin
        ? {
            ...permissions,
            rules: [...permissions.rules, ...creationRules(origin)],
          }
        : permissions;
      access = compilePolicy(input, [subject]);
      accessViews.set(id, access);
    }
    return access;
  }

  async function verifyKeyManagement(
    proof: BirthProof,
    scope: string,
    facet: Facet,
  ): Promise<void> {
    const certificate = proof.keyAuthority;
    if (!certificate) return;
    const checked = await policy(proof.policyVersion);
    context.live();
    const access = accessView(checked, certificate.holder.user);
    if (
      checked.generation !== certificate.generation ||
      !access.allows(scope, facet, "grant") ||
      !access.allows(scope, facet, "read")
    ) {
      throw new InvalidProtectedData();
    }
  }
  if (current) {
    policies.set(
      current.version,
      Promise.resolve({
        generation: context.history.current.generation,
        permissions: current,
      }),
    );
  }
  async function policy(version: string): Promise<CheckedPolicy> {
    context.live();
    revision(version);
    let pending = policies.get(version);
    if (!pending) {
      pending = (async () => {
        const [value, error] = await client.query(
          "zerotrust.policy.getVersion",
          { version },
          { strategy: "network-only" },
        );
        context.live();
        if (error) {
          throw error;
        }
        if (
          !value ||
          Object.keys(value).sort().join(",") !== "generation,policy"
        ) {
          throw new InvalidProtectedData();
        }
        revision(value.generation);
        const checked = await verifyPolicy(value.policy, {
          tenant: context.account.tenant,
          authority: context.history.authority(value.generation),
        });
        context.live();
        if (checked.permissions.version !== version) {
          throw new InvalidProtectedData();
        }
        return {
          generation: value.generation,
          permissions: checked.permissions,
        };
      })();
      policies.set(version, pending);
    }
    try {
      const value = await pending;
      context.live();
      return value;
    } catch (error) {
      if (policies.get(version) === pending) {
        policies.delete(version);
      }
      throw error;
    }
  }
  async function initial(
    definition: DomainDefinition,
  ): Promise<DomainDefinition> {
    if (definition.generation === "1") {
      return definition;
    }
    let pending = origins.get(definition.id);
    if (!pending) {
      pending = (async () => {
        const [value, error] = await client.query(
          "zerotrust.domains.get",
          { domain: definition.id, generation: "1" },
          { strategy: "network-only" },
        );
        context.live();
        if (error) {
          throw error;
        }
        const checked = await verifyDomain(
          value,
          {
            tenant: context.account.tenant,
            id: definition.id,
            scope: definition.scope,
            facet: definition.facet,
            generation: "1",
          },
          context.history.authority,
        );
        await verifyKeyManagement(checked, definition.scope, definition.facet);
        context.live();
        rememberProof(checked.id, checked.generation, checked);
        return checked;
      })();
      origins.set(definition.id, pending);
    }
    try {
      const value = await pending;
      context.live();
      return value;
    } catch (error) {
      if (origins.get(definition.id) === pending) {
        origins.delete(definition.id);
      }
      throw error;
    }
  }
  async function signer(
    author: string,
    generation: string,
    signature: string,
    message: Uint8Array<ArrayBuffer>,
  ) {
    const value = await context.history.proofSigner(
      author,
      generation,
      signature,
      message,
    );
    context.live();
    return value;
  }
  function accessFor(
    author: string,
    version: string,
    checked: CheckedPolicy,
    first: Pick<DomainDefinition, "policyVersion" | "creation">,
  ) {
    if (BigInt(version) < BigInt(first.policyVersion)) {
      throw new InvalidProtectedData();
    }
    const origin =
      first.creation?.capability.generation === checked.generation
        ? first.creation
        : undefined;
    return accessView(checked, author, origin);
  }
  async function verifyPublicDefinition(
    value: unknown,
    scope: string,
    facet: Facet,
    generation: string,
  ) {
    const id = `${scope}:${facet}`;
    const proof = await verifyDomainProof(
      value,
      { tenant: context.account.tenant, id, scope, facet, generation },
      context.history.authority,
    );
    await verifyKeyManagement(proof, scope, facet);
    return rememberProof(id, generation, proof);
  }
  async function publicDefinition(
    scope: string,
    facet: Facet,
    generation: string,
  ): Promise<BirthProof> {
    const id = `${scope}:${facet}`;
    context.live();
    const shared = proofCache.get(proofKey(id, generation));
    if (shared) return shared;
    const cacheKey = `${id}/${generation}`;
    let pending = publicDefinitions.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const [value, error] = await client.query(
          "zerotrust.domains.proof",
          { domain: id, generation },
          { strategy: "network-only" },
        );
        context.live();
        if (error) {
          throw error;
        }
        return verifyPublicDefinition(value, scope, facet, generation);
      })();
      publicDefinitions.set(cacheKey, pending);
    }
    try {
      const proof = await pending;
      context.live();
      return proof;
    } catch (error) {
      if (publicDefinitions.get(cacheKey) === pending) {
        publicDefinitions.delete(cacheKey);
      }
      throw error;
    }
  }
  async function objectAuthorGeneration(
    envelope: EncryptedObject,
    definition: WriterDefinition,
    first: BirthProof,
    staged: boolean,
  ): Promise<string> {
    context.live();
    if (
      envelope.tenant !== context.account.tenant ||
      definition.tenant !== envelope.tenant ||
      definition.scope !== envelope.scope ||
      definition.facet !== envelope.facet ||
      definition.generation !== envelope.generation ||
      BigInt(envelope.policyVersion) < BigInt(definition.policyVersion)
    ) {
      throw new InvalidProtectedData();
    }
    const checked = await policy(envelope.policyVersion);
    const access = accessFor(
      envelope.author,
      envelope.policyVersion,
      checked,
      first,
    );
    const absence = absenceRecord(envelope);
    const action = objectWriteAction(envelope);
    if (!access.allows(envelope.scope, envelope.facet, "read")) {
      throw new InvalidProtectedData();
    }
    if (absence) {
      for (const facet of ["master-data", "personnel"] as const) {
        if (!access.allows(absence.scope, facet, "read")) {
          throw new InvalidProtectedData();
        }
      }
    }

    const canWrite = access.allows(envelope.scope, envelope.facet, action);
    const canStageFirstUpdate =
      staged &&
      !absence &&
      envelope.revision === "1" &&
      access.allows(envelope.scope, envelope.facet, "update");
    if (!canWrite && !canStageFirstUpdate) {
      throw new InvalidProtectedData();
    }

    context.live();
    return checked.generation;
  }
  async function authorizeObject(
    envelope: EncryptedObject,
    definition: WriterDefinition,
    first: BirthProof,
    staged: boolean,
  ): Promise<CryptoKey> {
    const generation = await objectAuthorGeneration(
      envelope,
      definition,
      first,
      staged,
    );

    return signer(
      envelope.author,
      generation,
      envelope.signature,
      objectFrame(envelope),
    );
  }
  const object = async (
    envelope: EncryptedObject,
    definition: DomainDefinition,
    staged = false,
  ): Promise<CryptoKey> =>
    authorizeObject(envelope, definition, await initial(definition), staged);
  return Object.assign(object, {
    definition,
    verifyPublicDefinition,
    /** The codec verifies the exact envelope before opening it. Keep the same
     * writer authorization without checking that signature a second time. */
    async signingKeysFor(
      envelope: EncryptedObject,
      definition: DomainDefinition,
      staged = false,
    ) {
      const generation = await objectAuthorGeneration(
        envelope,
        definition,
        await initial(definition),
        staged,
      );
      context.live();
      return context.history.signingKeys(envelope.author, generation);
    },
    /** A per-object reader receives signed public proofs, never the containing
     * area's key packages. Apply exactly the ordinary writer authorization. */
    async fromProofs(envelope: EncryptedObject, inputs: readonly unknown[]) {
      const generations = [...new Set(["1", envelope.generation])];
      if (!Array.isArray(inputs) || inputs.length !== generations.length)
        throw new InvalidProtectedData();
      const proofs = [];
      for (const [index, generation] of generations.entries()) {
        const proof = await verifyDomainProof(
          inputs[index],
          {
            tenant: context.account.tenant,
            id: `${envelope.scope}:${envelope.facet}`,
            scope: envelope.scope,
            facet: envelope.facet,
            generation,
          },
          context.history.authority,
        );
        await verifyKeyManagement(proof, proof.scope, proof.facet);
        context.live();
        rememberProof(proof.id, proof.generation, proof);
        proofs.push(proof);
      }
      return authorizeObject(envelope, proofs.at(-1)!, proofs[0]!, false);
    },
    /** Native heads and receipts have their own signed frames. Their authors
     * still need the historical root policy and each area's certified origin. */
    async control(
      value: ControlAuthor,
      signedFrame: Uint8Array<ArrayBuffer>,
      requirements: {
        all: readonly AuthorRequirement[];
        any?: readonly AuthorRequirement[];
      },
    ) {
      context.live();
      if (
        value.tenant !== context.account.tenant ||
        requirements.all.length === 0
      ) {
        throw new InvalidProtectedData();
      }
      const checked = await policy(value.policyVersion);
      if (checked.generation !== value.generation) {
        throw new InvalidProtectedData();
      }
      async function allows(requirement: AuthorRequirement): Promise<boolean> {
        const generation = requirement.keyGeneration ?? "1";
        const definition = await publicDefinition(
          value.scope,
          requirement.facet,
          generation,
        );
        if (BigInt(value.policyVersion) < BigInt(definition.policyVersion)) {
          throw new InvalidProtectedData();
        }
        const first =
          generation === "1"
            ? definition
            : await publicDefinition(value.scope, requirement.facet, "1");
        const access = accessFor(
          value.author,
          value.policyVersion,
          checked,
          first,
        );
        return (
          access.allows(value.scope, requirement.facet, "read") &&
          access.allows(value.scope, requirement.facet, requirement.action)
        );
      }
      const required = await Promise.all(requirements.all.map(allows));
      if (required.some((allowed) => !allowed)) {
        throw new InvalidProtectedData();
      }
      if (requirements.any) {
        let permitted = false;
        for (const alternative of requirements.any) {
          if (await allows(alternative)) {
            permitted = true;
            break;
          }
        }
        if (!permitted) {
          throw new InvalidProtectedData();
        }
      }
      const key = await signer(
        value.author,
        checked.generation,
        value.signature,
        signedFrame,
      );
      context.live();
      return key;
    },
    /** Live traffic has no ordinary object-create action. A reader may publish
     * presence, while text updates need update rights for every encrypted layer. */
    async message(
      envelope: EncryptedObject,
      definition: DomainDefinition,
      authorityGeneration: string,
      action: "read" | "update",
    ) {
      if (
        envelope.tenant !== context.account.tenant ||
        definition.tenant !== envelope.tenant ||
        definition.scope !== envelope.scope ||
        BigInt(envelope.policyVersion) < BigInt(definition.policyVersion)
      ) {
        throw new InvalidProtectedData();
      }
      const checked = await requiredMessageProof(() =>
        policy(envelope.policyVersion),
      );
      if (checked.generation !== authorityGeneration) {
        throw new InvalidProtectedData();
      }
      const origin = await requiredMessageProof(() => initial(definition));
      const access = accessFor(
        envelope.author,
        envelope.policyVersion,
        checked,
        origin,
      );
      if (
        !access.allows(envelope.scope, definition.facet, "read") ||
        !access.allows(envelope.scope, definition.facet, action)
      ) {
        throw new InvalidProtectedData();
      }
      await signer(
        envelope.author,
        checked.generation,
        envelope.signature,
        objectFrame(envelope),
      );
      context.live();
    },
    /** Catalogue deletions have an independently signed frame, not a new data
     * envelope. Catalogue rules are root-managed and have no creation grants. */
    async catalogueDeletion(value: StockDeletion) {
      const match =
        /^catalog:(products|vendors):(master-data|procurement)$/.exec(
          value.domain,
        );
      if (!match || value.tenant !== context.account.tenant) {
        throw new InvalidProtectedData();
      }
      const checked = await policy(value.policyVersion);
      if (checked.generation !== value.authorityGeneration) {
        throw new InvalidProtectedData();
      }
      const access = accessView(checked, value.author);
      const scope = `catalog:${match[1]}`;
      const facet = match[2] as "master-data" | "procurement";
      if (
        !access.allows(scope, facet, "read") ||
        !access.allows(scope, facet, "delete")
      ) {
        throw new InvalidProtectedData();
      }
      return signer(
        value.author,
        checked.generation,
        value.signature,
        stockDeletionFrame(value),
      );
    },
  });
}
