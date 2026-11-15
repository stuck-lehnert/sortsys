import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
} from "../encoding";
import { sign, verify } from "../identity";
import {
  type PolicyTransaction,
  policyTransaction,
  policyTransactionFrame,
  preparePolicyTransaction,
} from "../policyTransactions";
import { facetVocabulary } from "./vocabulary";

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
};
export type PolicyOptions<F extends string, O extends string> = {
  /** Reject application-specific rule origins unless explicitly understood. */
  validateRuleOrigin?: (rule: Rule<F, O>) => void;
  validateSuspendedSubject?: (subject: string) => void;
};

const actionBits = new Map(
  ACTIONS.map((action, index) => [action, 1 << index]),
);
const areaKey = (scope: string, facet: string) => `${scope}\0${facet}`;

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

  function policyFrame(
    input: Policy<F, O>,
    transaction?: PolicyTransaction,
  ): Uint8Array<ArrayBuffer> {
    const current = policy(input);
    const rules = current.rules.map((rule) => {
      const fields = [rule.subject, rule.scope, rule.facet, rule.effect];
      if (rule.origin !== undefined) fields.push(rule.origin);
      fields.push(...rule.actions);
      return base64(
        frame(
          rule.origin === undefined ? "sortsys/rule/v1" : "sortsys/rule/v2",
          fields,
        ),
      );
    });
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
    return frame(domain, fields);
  }

  async function signPolicy(
    input: Policy<F, O>,
    authority: CryptoKey,
  ): Promise<SignedPolicy<F, O>> {
    const permissions = policy(input);
    return {
      ...permissions,
      signature: await sign(authority, policyFrame(permissions)),
    };
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
      signature: await sign(authority, policyFrame(permissions, transaction)),
    };
  }

  async function verifyPolicy(
    input: unknown,
    expected: { tenant: string; authority: CryptoKey },
  ) {
    const hasSuspended =
      !!input && typeof input === "object" && Object.hasOwn(input, "suspended");
    const hasTransaction =
      !!input &&
      typeof input === "object" &&
      Object.hasOwn(input, "transaction");
    const value = record(input, [
      "tenant",
      "version",
      "rules",
      "signature",
      ...(hasSuspended ? ["suspended"] : []),
      ...(hasTransaction ? ["transaction"] : []),
    ]);
    const { signature, transaction: source, ...unsigned } = value;
    const permissions = policy(unsigned);
    const transaction = hasTransaction ? policyTransaction(source) : undefined;
    if (permissions.tenant !== expected.tenant || typeof signature !== "string")
      throw new InvalidProtectedData();
    await verify(
      expected.authority,
      signature,
      policyFrame(permissions, transaction),
    );
    return {
      permissions,
      signature,
      ...(transaction === undefined ? {} : { transaction }),
    };
  }

  return Object.freeze({
    policy,
    compilePolicy,
    compileReadership,
    allows,
    policyFrame,
    signPolicy,
    signPolicyTransaction,
    verifyPolicy,
  });
}

export type PolicyCodec<
  F extends string,
  O extends string = never,
> = ReturnType<typeof createPolicyCodec<F, O>>;
