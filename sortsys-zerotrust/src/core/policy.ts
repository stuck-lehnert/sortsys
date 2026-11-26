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
import { verifyPublicProof as verify } from "../publicProofs";
import {
  type PolicyTransaction,
  policyTransaction,
  policyTransactionFrame,
  preparePolicyTransaction,
} from "../policyTransactions";
import { facetVocabulary } from "./vocabulary";
import { identityCertificate, identityCertificateFrame } from "./certificates";
import {
  createAdministrativeProfileCodec,
  type PolicyAdministration,
} from "./administration";

export const ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "approve",
  "grant",
] as const;
export type Action = (typeof ACTIONS)[number];
export type Rule<F extends string = string, O extends string = never> = {
  subject: string;
  scope: string;
  facet: F;
  actions: Action[];
  effect: "allow" | "deny";
  origin?: O;
};

/** Reconcile one application's derived rules without reordering unrelated
 * grants or re-signing a policy merely because JSON field order changed. */
export function reconcilePolicyRules<
  F extends string,
  O extends string = never,
>(
  current: readonly Rule<F, O>[],
  desired: readonly Rule<F, O>[],
  managed: (rule: Rule<F, O>) => boolean,
): Rule<F, O>[] {
  const key = (rule: Rule<F, O>) =>
    JSON.stringify([
      rule.subject,
      rule.scope,
      rule.facet,
      rule.effect,
      rule.origin ?? null,
      ACTIONS.filter((action) => rule.actions.includes(action)),
    ]);
  const pending = new Map<string, Rule<F, O>>();
  for (const rule of desired) {
    const identity = key(rule);
    if (!managed(rule) || pending.has(identity))
      throw new InvalidProtectedData();
    pending.set(identity, rule);
  }
  const result: Rule<F, O>[] = [];
  for (const rule of current) {
    if (!managed(rule)) {
      result.push(rule);
      continue;
    }
    const identity = key(rule);
    if (pending.delete(identity)) result.push(rule);
  }
  result.push(...pending.values());
  return result.map((rule) => ({ ...rule, actions: [...rule.actions] }));
}

export type Policy<F extends string = string, O extends string = never> = {
  tenant: string;
  version: string;
  rules: Rule<F, O>[];
  suspended?: string[];
};
export type SignedPolicy<
  F extends string = string,
  O extends string = never,
> = Policy<F, O> & {
  signature: string;
  transaction?: PolicyTransaction;
  administration?: PolicyAdministration<F, O>;
};
export type VerifiedPolicy<F extends string, O extends string = never> = {
  permissions: Policy<F, O>;
  signature: string;
  transaction?: PolicyTransaction;
  administration?: PolicyAdministration<F, O>;
};
export type PolicyOptions<F extends string, O extends string> = {
  /** Reject application-specific rule origins unless explicitly understood. */
  validateRuleOrigin?: (rule: Rule<F, O>) => void;
  validateRules?: (rules: readonly Rule<F, O>[]) => void;
  validateSuspendedSubject?: (subject: string) => void;
};

const actionBits = new Map(
  ACTIONS.map((action, index) => [action, 1 << index]),
);
const areaKey = (scope: string, facet: string) => `${scope}\0${facet}`;

function sameOrder<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (const [index, value] of left.entries()) {
    if (value !== right[index]) return false;
  }
  return true;
}

export function createPolicyCodec<
  const F extends string,
  O extends string = never,
>(facets: readonly F[], options: PolicyOptions<F, O> = {}) {
  const allowedFacets = facetVocabulary(facets);
  const validateRuleOrigin = options.validateRuleOrigin;
  const validateSuspendedSubject = options.validateSuspendedSubject;

  function parseRule(input: unknown): Rule<F, O> {
    const hasOrigin =
      !!input && typeof input === "object" && Object.hasOwn(input, "origin");
    const value = record(input, [
      "subject",
      "scope",
      "facet",
      "actions",
      "effect",
      ...(hasOrigin ? ["origin"] : []),
    ]);
    identifier(value.subject);
    identifier(value.scope);
    if (
      !allowedFacets.has(value.facet as string) ||
      (value.effect !== "allow" && value.effect !== "deny") ||
      !Array.isArray(value.actions) ||
      !value.actions.length ||
      value.actions.length > ACTIONS.length ||
      value.actions.some((action) => !actionBits.has(action)) ||
      new Set(value.actions).size !== value.actions.length
    ) {
      throw new InvalidProtectedData();
    }
    const rule = { ...value, actions: [...value.actions] } as Rule<F, O>;
    if (hasOrigin) {
      identifier(value.origin);
      if (!validateRuleOrigin) throw new InvalidProtectedData();
      validateRuleOrigin(rule);
    }
    return rule;
  }

  function policy(input: unknown): Policy<F, O> {
    const hasSuspended =
      !!input && typeof input === "object" && Object.hasOwn(input, "suspended");
    const value = record(input, [
      "tenant",
      "version",
      "rules",
      ...(hasSuspended ? ["suspended"] : []),
    ]);
    identifier(value.tenant);
    revision(value.version);
    if (!Array.isArray(value.rules) || value.rules.length > 10_000) {
      throw new InvalidProtectedData();
    }
    const rules = value.rules.map(parseRule);
    options.validateRules?.(rules);
    if (!hasSuspended) {
      return { tenant: value.tenant, version: value.version, rules };
    }
    if (!Array.isArray(value.suspended) || value.suspended.length > 10_000) {
      throw new InvalidProtectedData();
    }
    const suspended = value.suspended.map((subject, index, subjects) => {
      identifier(subject);
      if (index > 0 && subjects[index - 1] >= subject) {
        throw new InvalidProtectedData();
      }
      validateSuspendedSubject?.(subject);
      return subject;
    });
    return { tenant: value.tenant, version: value.version, rules, suspended };
  }

  /** Deny rules win. Scope ancestry and group membership must already appear in
   * the signed policy; the codec never infers them from application records. */
  function compilePolicy(input: Policy<F, O>, subjects: readonly string[]) {
    const current = policy(input);
    const selected = new Set(subjects);
    const suspended =
      current.suspended?.some((subject) => selected.has(subject)) === true;
    const masks = new Map<
      string,
      { scope: string; facet: F; allow: number; deny: number }
    >();
    for (const rule of current.rules) {
      if (!selected.has(rule.subject)) continue;
      const key = areaKey(rule.scope, rule.facet);
      const entry = masks.get(key) ?? {
        scope: rule.scope,
        facet: rule.facet,
        allow: 0,
        deny: 0,
      };
      for (const action of rule.actions) {
        entry[rule.effect] |= actionBits.get(action)!;
      }
      masks.set(key, entry);
    }
    const areas = Object.freeze(
      [...masks.values()].map((entry) =>
        Object.freeze({
          scope: entry.scope,
          facet: entry.facet,
          actions: Object.freeze(
            ACTIONS.filter(
              (action) =>
                !suspended &&
                !!(entry.allow & ~entry.deny & actionBits.get(action)!),
            ),
          ),
        }),
      ),
    );
    return Object.freeze({
      tenant: current.tenant,
      version: current.version,
      areas,
      allows(scope: string, facet: F, action: Action): boolean {
        const bit = actionBits.get(action);
        if (
          suspended ||
          typeof scope !== "string" ||
          typeof facet !== "string" ||
          bit === undefined
        )
          return false;
        const entry = masks.get(areaKey(scope, facet));
        return entry !== undefined && !!(entry.allow & ~entry.deny & bit);
      },
    });
  }

  function allows(
    input: Policy<F, O>,
    request: {
      tenant: string;
      version: string;
      subjects: readonly string[];
      scope: string;
      facet: F;
      action: Action;
    },
  ): boolean {
    const access = compilePolicy(input, request.subjects);
    return (
      access.tenant === request.tenant &&
      access.version === request.version &&
      access.allows(request.scope, request.facet, request.action)
    );
  }

  function compileReadership(input: Policy<F, O>) {
    const current = policy(input);
    const suspended = new Set(current.suspended);
    const areas = new Map<
      string,
      { allowed: Set<string>; denied: Set<string> }
    >();
    for (const rule of current.rules) {
      if (!rule.actions.includes("read") || suspended.has(rule.subject)) {
        continue;
      }
      const key = areaKey(rule.scope, rule.facet);
      const area = areas.get(key) ?? { allowed: new Set(), denied: new Set() };
      if (rule.effect === "allow") area.allowed.add(rule.subject);
      else area.denied.add(rule.subject);
      areas.set(key, area);
    }
    return (scope: string, facet: F): readonly string[] => {
      const area = areas.get(areaKey(scope, facet));
      if (!area) return Object.freeze([]);
      return Object.freeze(
        [...area.allowed].filter((subject) => !area.denied.has(subject)).sort(),
      );
    };
  }

  function ruleFrame(rule: Rule<F, O>): string {
    const fields = [rule.subject, rule.scope, rule.facet, rule.effect];
    if (rule.origin !== undefined) fields.push(rule.origin);
    fields.push(...rule.actions);
    return base64(
      frame(
        rule.origin === undefined ? "sortsys/rule/v1" : "sortsys/rule/v2",
        fields,
      ),
    );
  }

  function policyFrame(
    input: Policy<F, O>,
    transaction?: PolicyTransaction,
    administration?: PolicyAdministration<F, O>,
  ): Uint8Array<ArrayBuffer> {
    return parsedPolicyFrame(policy(input), transaction, administration);
  }

  function parsedPolicyFrame(
    current: Policy<F, O>,
    transaction?: PolicyTransaction,
    administration?: PolicyAdministration<F, O>,
  ): Uint8Array<ArrayBuffer> {
    const rules = current.rules.map(ruleFrame);
    const fields = [current.tenant, current.version];
    if (current.suspended !== undefined) {
      fields.push(base64(frame("sortsys/suspended/v1", current.suspended)));
    } else if (transaction !== undefined) fields.push("");
    if (transaction !== undefined) {
      fields.push(base64(policyTransactionFrame(transaction)));
    }
    fields.push(...rules);
    let domain = "sortsys/policy/v1";
    if (transaction !== undefined) domain = "sortsys/policy/v3";
    else if (current.suspended !== undefined) domain = "sortsys/policy/v2";
    const primaryFrame = frame(domain, fields);
    if (administration === undefined) return primaryFrame;
    const fieldsOfDelegation = [
      base64(primaryFrame),
      administration.root.signature,
      base64(
        signedPacketFrame(
          identityCertificateFrame(administration.author),
          administration.author.signature,
        ),
      ),
      administration.previousSignature,
    ];
    let purpose = "sortsys/delegated-policy/v1";
    if (administration.continuation !== undefined) {
      sized(administration.continuation, 32);
      if (transaction !== undefined) throw new InvalidProtectedData();
      fieldsOfDelegation.push(administration.continuation);
      purpose = "sortsys/delegated-policy-continuation/v1";
    }
    fieldsOfDelegation.push(
      ...administration.profiles.map((profile) => profile.signature),
    );
    return frame(purpose, fieldsOfDelegation);
  }

  const administrativeProfiles = createAdministrativeProfileCodec<F, O>(
    facets,
    { policy, compilePolicy },
  );

  function parseSigned(
    input: unknown,
    allowAdministration = true,
  ): SignedPolicy<F, O> {
    const object = input && typeof input === "object" ? input : null;
    const hasSuspended = !!object && Object.hasOwn(object, "suspended");
    const hasTransaction = !!object && Object.hasOwn(object, "transaction");
    const hasAdministration =
      !!object && Object.hasOwn(object, "administration");
    if (hasAdministration && !allowAdministration)
      throw new InvalidProtectedData();
    const value = record(input, [
      "tenant",
      "version",
      "rules",
      "signature",
      ...(hasSuspended ? ["suspended"] : []),
      ...(hasTransaction ? ["transaction"] : []),
      ...(hasAdministration ? ["administration"] : []),
    ]);
    const {
      signature,
      transaction: transactionInput,
      administration: administrationInput,
      ...unsigned
    } = value;
    sized(signature as string, 64);
    const permissions = policy(unsigned);
    const transaction = hasTransaction
      ? policyTransaction(transactionInput)
      : undefined;
    let administration: PolicyAdministration<F, O> | undefined;
    if (hasAdministration) {
      const hasContinuation =
        administrationInput &&
        typeof administrationInput === "object" &&
        Object.hasOwn(administrationInput, "continuation");
      const source = record(administrationInput, [
        "root",
        "profiles",
        "author",
        "previousSignature",
        ...(hasContinuation ? ["continuation"] : []),
      ]);
      if (!Array.isArray(source.profiles) || source.profiles.length > 10000)
        throw new InvalidProtectedData();
      sized(source.previousSignature as string, 64);
      const root = parseSigned(source.root, false);
      const author = identityCertificate(source.author);
      const profiles = source.profiles.map(administrativeProfiles.parse);
      if (
        root.tenant !== permissions.tenant ||
        author.tenant !== permissions.tenant ||
        BigInt(root.version) >= BigInt(permissions.version)
      )
        throw new InvalidProtectedData();
      for (const profile of profiles) {
        if (
          profile.author.generation !== author.generation ||
          BigInt(profile.version) > BigInt(permissions.version)
        )
          throw new InvalidProtectedData();
      }
      const rules = administrativeProfiles.apply(
        unsignedPolicy(root),
        profiles,
        root.signature,
      );
      // These are validated rule fields in their signed order. Comparing
      // them does not require producing a second copy of either signed frame.
      if (
        rules.length !== permissions.rules.length ||
        rules.some((rule, index) => {
          const actual = permissions.rules[index];
          return (
            !actual ||
            rule.subject !== actual.subject ||
            rule.scope !== actual.scope ||
            rule.facet !== actual.facet ||
            rule.effect !== actual.effect ||
            rule.origin !== actual.origin ||
            !sameOrder(rule.actions, actual.actions)
          );
        }) ||
        (root.suspended === undefined || permissions.suspended === undefined
          ? root.suspended !== permissions.suspended
          : !sameOrder(root.suspended, permissions.suspended))
      )
        throw new InvalidProtectedData();
      administration = {
        root,
        profiles,
        author,
        previousSignature: source.previousSignature as string,
      };
      if (hasContinuation) {
        if (typeof source.continuation !== "string" || transaction)
          throw new InvalidProtectedData();
        sized(source.continuation, 32);
        administration.continuation = source.continuation;
      }
      if (
        transaction &&
        (transaction.author !== author.user ||
          transaction.previousSignature !== administration.previousSignature)
      )
        throw new InvalidProtectedData();
    }
    return {
      ...permissions,
      ...(transaction ? { transaction } : {}),
      ...(administration ? { administration } : {}),
      signature: signature as string,
    };
  }

  function unsignedPolicy(input: SignedPolicy<F, O>): Policy<F, O> {
    const {
      signature: _,
      transaction: __,
      administration: ___,
      ...permissions
    } = input;
    return permissions;
  }

  function canAdminister(input: Policy<F, O>, subject: string): boolean {
    const compiled = compilePolicy(input, [subject]);
    return input.rules.some((rule) =>
      compiled.allows(rule.scope, rule.facet, "grant"),
    );
  }

  async function signAdministrativePolicy(
    input: Omit<PolicyAdministration<F, O>, "continuation"> & {
      version: string;
      transaction?: PolicyTransaction;
    },
    key: CryptoKey,
  ): Promise<SignedPolicy<F, O>> {
    const root = parseSigned(input.root, false);
    const administration = {
      root,
      profiles: input.profiles.map(administrativeProfiles.parse),
      author: identityCertificate(input.author),
      previousSignature: input.previousSignature,
    };
    const permissions = policy({
      ...unsignedPolicy(root),
      version: input.version,
      rules: administrativeProfiles.apply(
        unsignedPolicy(root),
        administration.profiles,
        root.signature,
      ),
    });
    const transaction =
      input.transaction === undefined
        ? undefined
        : policyTransaction(input.transaction);
    const candidate = {
      ...permissions,
      administration,
      ...(transaction ? { transaction } : {}),
    };
    const signature = await sign(
      key,
      parsedPolicyFrame(permissions, transaction, administration),
    );
    return parseSigned({ ...candidate, signature });
  }

  function administrativeReplacement(
    previous: SignedPolicy<F, O>,
    next: SignedPolicy<F, O>,
    actor: import("./certificates").IdentityCertificate,
  ): boolean {
    const current = parseSigned(previous);
    const candidate = parseSigned(next);
    const administration = candidate.administration;
    if (
      !administration ||
      administration.continuation !== undefined ||
      BigInt(candidate.version) !== BigInt(current.version) + 1n ||
      administration.author.signature !== actor.signature ||
      administration.previousSignature !== current.signature
    )
      return false;
    const root = current.administration?.root ?? current;
    if (administration.root.signature !== root.signature) return false;
    return administrativeProfiles.replacement(
      current.administration?.profiles ?? [],
      administration.profiles,
      actor,
      candidate.version,
    );
  }

  async function signPolicy(
    input: Policy<F, O>,
    authority: CryptoKey,
  ): Promise<SignedPolicy<F, O>> {
    const permissions = policy(input);
    return {
      ...permissions,
      signature: await sign(authority, parsedPolicyFrame(permissions)),
    };
  }

  /** Advance the write version of an already verified policy. Delegated
   * profiles keep their original signatures and authority checkpoint. */
  async function signPolicyContinuation(
    previous: SignedPolicy<F, O>,
    binding: string,
    authority: CryptoKey,
  ): Promise<SignedPolicy<F, O>> {
    sized(binding, 32);
    const current = parseSigned(previous);
    const permissions = {
      ...unsignedPolicy(current),
      version: (BigInt(current.version) + 1n).toString(),
    };
    if (!current.administration) return signPolicy(permissions, authority);
    revision(permissions.version);
    const administration = {
      ...current.administration,
      previousSignature: current.signature,
      continuation: binding,
    };
    const signature = await sign(
      authority,
      parsedPolicyFrame(permissions, undefined, administration),
    );
    return parseSigned({ ...permissions, administration, signature });
  }

  async function signPolicyTransaction(
    input: Policy<F, O>,
    binding: PolicyTransaction,
    authority: CryptoKey,
  ): Promise<SignedPolicy<F, O>> {
    const permissions = policy(input);
    const transaction = preparePolicyTransaction(binding);
    return {
      ...permissions,
      transaction,
      signature: await sign(authority, parsedPolicyFrame(permissions, transaction)),
    };
  }

  async function verifyPolicy(
    input: unknown,
    expected: { tenant: string; authority: CryptoKey },
  ): Promise<VerifiedPolicy<F, O>> {
    return verifyParsedPolicy(parseSigned(input), expected);
  }

  async function verifyParsedPolicy(
    value: SignedPolicy<F, O>,
    expected: { tenant: string; authority: CryptoKey },
  ): Promise<VerifiedPolicy<F, O>> {
    const { signature, transaction, administration } = value;
    const permissions = unsignedPolicy(value);
    if (permissions.tenant !== expected.tenant)
      throw new InvalidProtectedData();
    let signer = expected.authority;
    if (administration) {
      const root = await verifyParsedPolicy(administration.root, expected);
      if (!canAdminister(root.permissions, administration.author.user))
        throw new InvalidProtectedData();
      await verify(
        expected.authority,
        administration.author.signature,
        identityCertificateFrame(administration.author),
      );
      for (
        let offset = 0;
        offset < administration.profiles.length;
        offset += 16
      ) {
        await Promise.all(
          administration.profiles.slice(offset, offset + 16).map((profile) =>
            administrativeProfiles.verify(profile, {
              root: root.permissions,
              signature: root.signature,
              authority: expected.authority,
              generation: administration.author.generation,
            }),
          ),
        );
      }
      if (administration.continuation === undefined) {
        signer = await importSigningKey(administration.author.signingKey);
      }
    }
    await verify(
      signer,
      signature,
      parsedPolicyFrame(permissions, transaction, administration),
    );
    return {
      permissions,
      signature,
      ...(transaction === undefined ? {} : { transaction }),
      ...(administration === undefined ? {} : { administration }),
    };
  }

  return Object.freeze({
    policy,
    compilePolicy,
    compileReadership,
    allows,
    policyFrame,
    signPolicy,
    signPolicyContinuation,
    signPolicyTransaction,
    verifyPolicy,
    administrativeProfiles,
    signAdministrativePolicy,
    parseSigned,
    canAdminister,
    administrativeReplacement,
  });
}

export type PolicyCodec<
  F extends string,
  O extends string = never,
> = ReturnType<typeof createPolicyCodec<F, O>>;
