import {
  createRecoveryCatalog,
  type RecoveryCatalogStorage,
} from "../recoveryCatalog";
import {
  authorityFrame,
  certifyAuthority,
  certifyIdentity,
  identityCertificateFrame,
  identityCertificate,
  verifyAuthority,
} from "./certificates";
import type { AuthorityCertificate, IdentityCertificate } from "./certificates";
import type { PolicyCodec, SignedPolicy } from "./policy";
import { boxFrame, boxPacketFrame, sealBox, sealedBox } from "../boxes";
import type { SealedBox } from "../boxes";
import {
  digest,
  frame,
  InvalidProtectedData,
  record,
  signedPacketFrame,
  sized,
} from "../encoding";
import {
  importSigningKey,
  publicIdentity,
  sign,
  signingPair,
  verify,
} from "../identity";
import type { PrivateIdentity } from "../identity";
import { ACTIONS, type Action } from "./policy";
import { facetVocabulary } from "./vocabulary";
import { publicSigningKey, recoveryIdentity } from "../recovery";

export type TenantSetup<F extends string = string, O extends string = never> = {
  authority: AuthorityCertificate;
  owner: IdentityCertificate;
  authorityEnvelope: SealedBox;
  catalog: SealedBox;
  policy: SignedPolicy<F, O>;
  proof: string;
};

export type SetupOptions<F extends string> = {
  /** Owner permissions for application scopes without a data domain. */
  ownerGrants?: readonly { scope: string; facet: F; actions: readonly Action[] }[];
};

export function createSetupCodec<F extends string, O extends string = never>(
  facets: readonly F[],
  policies: PolicyCodec<F, O>,
  options: SetupOptions<F> = {},
) {
  const facetsSnapshot = Object.freeze([...facets]);
  facetVocabulary(facetsSnapshot);
  const { policyFrame, signPolicy, verifyPolicy } = policies;
  const ownerGrants = (options.ownerGrants ?? []).map((grant) => ({
    ...grant,
    actions: [...grant.actions],
  }));
  async function verifyTenantSetup(
    input: unknown,
    pinned: { tenant: string; generation: string; recoverySigningKey: string },
  ): Promise<TenantSetup<F, O>> {
    const obj = record(input, [
      "authority",
      "owner",
      "authorityEnvelope",
      "catalog",
      "policy",
      "proof",
    ]);
    const authority = await verifyAuthority(obj.authority, pinned);
    const key = await importSigningKey(authority.authoritySigningKey);
    const owner = identityCertificate(obj.owner);
    if (
      owner.tenant !== pinned.tenant ||
      owner.generation !== pinned.generation ||
      owner.previousSignature !== undefined
    )
      throw new InvalidProtectedData();
    await verify(key, owner.signature, identityCertificateFrame(owner));
    if (typeof obj.proof !== "string") throw new InvalidProtectedData();
    const checked = await verifyPolicy(obj.policy, {
      tenant: pinned.tenant,
      authority: key,
    });
    const policy: SignedPolicy<F, O> = {
      ...checked.permissions,
      signature: checked.signature,
      ...(checked.transaction ? { transaction: checked.transaction } : {}),
    };
    const authorityEnvelope = sealedBox(obj.authorityEnvelope);
    const catalog = sealedBox(obj.catalog);
    for (const [box, purpose, object, recipient] of [
      [
        authorityEnvelope,
        "authority-key",
        `authority:${pinned.generation}`,
        owner.user,
      ],
      [catalog, "recovery-catalog", "catalog", `recovery:${pinned.generation}`],
    ] as const) {
      if (
        box.tenant !== pinned.tenant ||
        box.generation !== pinned.generation ||
        box.purpose !== purpose ||
        box.object !== object ||
        box.recipient !== recipient ||
        box.author !== `authority:${pinned.generation}`
      )
        throw new InvalidProtectedData();
      await verify(key, box.signature, boxFrame(box));
    }
    sized(obj.proof, 64);
    const setup: TenantSetup<F, O> = {
      authority,
      owner: { ...owner },
      authorityEnvelope,
      catalog,
      policy,
      proof: obj.proof,
    };
    await verify(
      await importSigningKey(owner.signingKey),
      setup.proof,
      await tenantSetupFrame(setup),
    );
    return setup;
  }

  async function tenantSetupFrame(
    input: Omit<TenantSetup<F, O>, "proof">,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const {
      signature: policySignature,
      transaction,
      ...permissions
    } = input.policy;
    const hashes = await Promise.all([
      digest(
        signedPacketFrame(
          authorityFrame(input.authority),
          input.authority.signature,
        ),
      ),
      digest(
        signedPacketFrame(
          identityCertificateFrame(input.owner),
          input.owner.signature,
        ),
      ),
      digest(boxPacketFrame(input.authorityEnvelope)),
      digest(boxPacketFrame(input.catalog)),
      digest(
        signedPacketFrame(
          policyFrame(permissions, transaction),
          policySignature,
        ),
      ),
    ]);
    return frame("sortsys/tenant-setup/v1", [
      input.authority.tenant,
      input.owner.user,
      ...hashes,
    ]);
  }

  async function createTenantSetup(
    tenant: string,
    subject: string,
    identity: PrivateIdentity,
    recoveryPhrase: string,
    options: {
      generation?: string;
      context?: string;
      policyVersion?: string;
      scopes?: { scope: string; facet: F }[];
      keys?: { domain: string; generation: string; key: string }[];
      catalogStorage?: RecoveryCatalogStorage;
    } = {},
  ): Promise<{ setup: TenantSetup<F, O>; authorityKey: CryptoKeyPair }> {
    const generation = options.generation ?? "1";
    const policyVersion = options.policyVersion ?? "1";
    const recovery = await recoveryIdentity(recoveryPhrase, tenant, generation);
    const recoveryPublic = await publicIdentity(recovery);
    const authorityKey = await signingPair();
    const authority = await certifyAuthority(
      {
        tenant,
        generation,
        recoveryEncryptionKey: recoveryPublic.encryptionKey,
        recoverySigningKey: recoveryPublic.signingKey,
        authoritySigningKey: await publicSigningKey(authorityKey.publicKey),
        ...(options.context === undefined ? {} : { context: options.context }),
      },
      recovery.signingKey.privateKey,
    );
    const owner = await certifyIdentity(
      {
        tenant,
        generation,
        user: subject,
        ...(await publicIdentity(identity)),
      },
      authorityKey.privateKey,
    );
    const rawAuthority = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", authorityKey.privateKey),
    );
    let authorityEnvelope: SealedBox;
    try {
      authorityEnvelope = await sealBox(
        {
          tenant,
          purpose: "authority-key",
          object: `authority:${generation}`,
          generation,
          recipient: subject,
          author: `authority:${generation}`,
        },
        rawAuthority,
        identity.encryptionKey.publicKey,
        authorityKey.privateKey,
      );
    } finally {
      rawAuthority.fill(0);
    }
    const archivedKeys = [...(options.keys ?? [])].sort((left, right) => {
      const a = `${left.domain}\0${left.generation}`;
      const b = `${right.domain}\0${right.generation}`;
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    const catalog = await createRecoveryCatalog(archivedKeys, {
      tenant,
      generation,
      encryptionKey: recovery.encryptionKey.publicKey,
      signingKey: authorityKey.privateKey,
      ...(options.catalogStorage ? { storage: options.catalogStorage } : {}),
    });
    const grants = new Map<string, (typeof ownerGrants)[number]>();
    for (const grant of ownerGrants) {
      grants.set(`${grant.scope}\0${grant.facet}`, grant);
    }
    for (const scope of [
      ...facetsSnapshot.map((facet) => ({
        scope: `tenant:${tenant}`,
        facet,
      })),
      ...(options.scopes ?? []),
    ]) {
      grants.set(`${scope.scope}\0${scope.facet}`, {
        ...scope,
        actions: [...ACTIONS],
      });
    }
    const policy = await signPolicy(
      {
        tenant,
        version: policyVersion,
        rules: [...grants.values()].map(({ scope, facet, actions }) => ({
          subject,
          scope,
          facet,
          actions,
          effect: "allow",
        })),
      },
      authorityKey.privateKey,
    );
    const config = { authority, owner, authorityEnvelope, catalog, policy };
    const proof = await sign(
      identity.signingKey.privateKey,
      await tenantSetupFrame(config),
    );
    return { setup: { ...config, proof }, authorityKey };
  }

  return Object.freeze({
    verifyTenantSetup,
    tenantSetupFrame,
    createTenantSetup,
  });
}
export type SetupCodec<F extends string, O extends string = never> = ReturnType<
  typeof createSetupCodec<F, O>
>;
