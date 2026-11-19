import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "../encoding";
import { importSigningKey, sign } from "../identity";
import { verifyPublicProof } from "../publicProofs";
import {
  identityCertificate,
  identityCertificateFrame,
  type IdentityCertificate,
} from "./certificates";
import {
  ACTIONS,
  type Action,
  type Policy,
  type Rule,
  type SignedPolicy,
} from "./policy";
import { facetVocabulary } from "./vocabulary";

/** A certified manager changes one recipient's ordinary actions in one area.
 * The root checkpoint remains immutable; managers never acquire its private key. */
export type AdministrativeProfile<F extends string = string> = {
  tenant: string;
  rootSignature: string;
  version: string;
  subject: string;
  scope: string;
  facet: F;
  actions: Action[];
  author: IdentityCertificate;
  signature: string;
};

export type PolicyAdministration<
  F extends string = string,
  O extends string = never,
> = {
  root: SignedPolicy<F, O>;
  profiles: AdministrativeProfile<F>[];
  author: IdentityCertificate;
  previousSignature: string;
  continuation?: string;
};

export function administrativeProfileKey(
  profile: Pick<AdministrativeProfile, "subject" | "scope" | "facet">,
): string {
  return `${profile.subject}\0${profile.scope}\0${profile.facet}`;
}

/** Callers verify the root checkpoint with the policy codec and use the same
 * checkpoint when assembling or admitting a replacement. All storage reads and
 * compare-and-swap checks still belong to one application transaction. */
export function createAdministrativeProfileCodec<
  const F extends string,
  O extends string = never,
>(
  facets: readonly F[],
  policies: {
    policy(input: unknown): Policy<F, O>;
    compilePolicy(
      input: Policy<F, O>,
      subjects: readonly string[],
    ): { allows(scope: string, facet: F, action: Action): boolean };
  },
) {
  const allowedFacets = facetVocabulary(facets);

  function parse(input: unknown): AdministrativeProfile<F> {
    const value = record(input, [
      "tenant",
      "rootSignature",
      "version",
      "subject",
      "scope",
      "facet",
      "actions",
      "author",
      "signature",
    ]);
    for (const field of [value.tenant, value.subject, value.scope])
      identifier(field);
    revision(value.version);
    sized(value.rootSignature as string, 64);
    if (
      !allowedFacets.has(value.facet as string) ||
      !Array.isArray(value.actions) ||
      value.actions.length > ACTIONS.length - 1 ||
      typeof value.signature !== "string"
    )
      throw new InvalidProtectedData();
    let previous = -1;
    const actions = value.actions.map((action) => {
      const index = ACTIONS.indexOf(action);
      if (index <= previous || action === "grant")
        throw new InvalidProtectedData();
      previous = index;
      return action;
    });
    const author = identityCertificate(value.author);
    if (author.tenant !== value.tenant) throw new InvalidProtectedData();
    return { ...value, actions, author } as AdministrativeProfile<F>;
  }

  function profileFrame(
    input: Omit<AdministrativeProfile<F>, "signature">,
  ): Uint8Array<ArrayBuffer> {
    const value = parse({ ...input, signature: "" });
    return frame("sortsys/administrative-profile/v1", [
      value.tenant,
      value.rootSignature,
      value.version,
      value.subject,
      value.scope,
      value.facet,
      base64(frame("sortsys/profile-actions/v1", value.actions)),
      base64(
        signedPacketFrame(
          identityCertificateFrame(value.author),
          value.author.signature,
        ),
      ),
    ]);
  }

  function admits(
    input: AdministrativeProfile<F>,
    root: Policy<F, O>,
    signature: string,
  ): boolean {
    const value = parse(input);
    const checkpoint = policies.policy(root);
    if (
      value.tenant !== checkpoint.tenant ||
      value.rootSignature !== signature ||
      BigInt(value.version) <= BigInt(checkpoint.version)
    )
      return false;
    if (checkpoint.suspended?.includes(value.subject)) return false;
    // Only the root authority can change a manager's rights in this area.
    // Owning personal preferences does not protect unrelated business rights.
    if (
      checkpoint.rules.some(
        (rule) =>
          rule.subject === value.subject &&
          rule.scope === value.scope &&
          rule.facet === value.facet &&
          rule.effect === "allow" &&
          rule.actions.includes("grant"),
      )
    )
      return false;
    const actor = policies.compilePolicy(checkpoint, [value.author.user]);
    if (!actor.allows(value.scope, value.facet, "grant")) return false;
    for (const action of value.actions) {
      if (!actor.allows(value.scope, value.facet, action)) return false;
    }
    return true;
  }

  async function signProfile(
    input: Omit<AdministrativeProfile<F>, "signature">,
    key: CryptoKey,
  ): Promise<AdministrativeProfile<F>> {
    const value = parse({ ...input, signature: "" });
    return { ...value, signature: await sign(key, profileFrame(value)) };
  }

  async function verify(
    input: unknown,
    expected: {
      root: Policy<F, O>;
      signature: string;
      authority: CryptoKey;
      generation: string;
    },
  ): Promise<AdministrativeProfile<F>> {
    const value = parse(input);
    if (
      value.author.generation !== expected.generation ||
      !admits(value, expected.root, expected.signature)
    )
      throw new InvalidProtectedData();
    await verifyPublicProof(
      expected.authority,
      value.author.signature,
      identityCertificateFrame(value.author),
    );
    await verifyPublicProof(
      await importSigningKey(value.author.signingKey),
      value.signature,
      profileFrame(value),
    );
    return value;
  }

  function apply(
    root: Policy<F, O>,
    profiles: readonly AdministrativeProfile<F>[],
    signature: string,
  ): Rule<F, O>[] {
    const checkpoint = policies.policy(root);
    if (profiles.length > 10000) throw new InvalidProtectedData();
    const changed = new Set<string>();
    let previous: string | undefined;
    for (const profile of profiles) {
      if (!admits(profile, checkpoint, signature))
        throw new InvalidProtectedData();
      const key = administrativeProfileKey(profile);
      if (previous !== undefined && key <= previous)
        throw new InvalidProtectedData();
      changed.add(key);
      previous = key;
    }
    // Explicit profile decisions override derived permissions without
    // discarding their provenance or independently granted assignments.
    const result = checkpoint.rules.filter(
      (rule) =>
        (rule.origin &&
          rule.effect === "allow" &&
          !rule.actions.includes("grant")) ||
        !changed.has(administrativeProfileKey(rule)),
    );
    for (const profile of profiles) {
      if (profile.actions.length)
        result.push({
          subject: profile.subject,
          scope: profile.scope,
          facet: profile.facet,
          actions: [...profile.actions],
          effect: "allow",
        });
      const denied = ACTIONS.filter(
        (action) => action !== "grant" && !profile.actions.includes(action),
      );
      if (denied.length)
        result.push({
          subject: profile.subject,
          scope: profile.scope,
          facet: profile.facet,
          actions: denied,
          effect: "deny",
        });
    }
    return result;
  }

  /** Prevent replay or deletion of somebody else's profile at a new head. */
  function replacement(
    previous: readonly AdministrativeProfile<F>[],
    next: readonly AdministrativeProfile<F>[],
    actor: IdentityCertificate,
    version: string,
  ): boolean {
    const before = new Map(
      previous.map((profile) => [administrativeProfileKey(profile), profile]),
    );
    let changed = false;
    for (const profile of next) {
      const key = administrativeProfileKey(profile);
      const known = before.get(key);
      if (known?.signature !== profile.signature) {
        if (
          profile.author.signature !== actor.signature ||
          profile.version !== version
        )
          return false;
        changed = true;
      }
      before.delete(key);
    }
    return changed && before.size === 0;
  }

  return Object.freeze({
    parse,
    frame: profileFrame,
    admits,
    sign: signProfile,
    verify,
    apply,
    replacement,
  });
}
