import { InvalidProtectedData } from "./encoding";
import { absenceDomain } from "./absenceRecords";
import { type Facet, FACETS } from "./objects";
import { createPolicyCodec } from "./core/policy";
import type {
  AdministrativeProfile as CoreAdministrativeProfile,
  PolicyAdministration as CorePolicyAdministration,
} from "./core/administration";
import type {
  Policy as CorePolicy,
  Rule as CoreRule,
  SignedPolicy as CoreSignedPolicy,
} from "./core/policy";

export { type Action, ACTIONS } from "./core/policy";
export { administrativeProfileKey } from "./core/administration";
export type Rule = CoreRule<Facet, "absence-default">;
export type Policy = CorePolicy<Facet, "absence-default">;
export type SignedPolicy = CoreSignedPolicy<Facet, "absence-default">;
export type AdministrativeProfile = CoreAdministrativeProfile<Facet>;
export type PolicyAdministration = CorePolicyAdministration<
  Facet,
  "absence-default"
>;

function validateSuspendedSubject(subject: string): void {
  if (!/^user:[1-9a-v][0-9a-v]{0,12}$/.test(subject)) {
    throw new InvalidProtectedData();
  }
  let id = 0n;
  for (const digit of subject.slice(5)) {
    id = id * 32n + BigInt(parseInt(digit, 32));
  }
  if (id > 9223372036854775807n) throw new InvalidProtectedData();
}

function validateRuleOrigin(rule: Rule): void {
  if (
    rule.origin !== "absence-default" ||
    rule.effect !== "allow" ||
    !rule.subject.startsWith("user:")
  ) {
    throw new InvalidProtectedData();
  }
  if (!absenceDomain(`absence:${rule.subject.slice(5)}:master-data`)) {
    throw new InvalidProtectedData();
  }
  const personnel = /^personnel:([^:]+)$/.exec(rule.scope);
  const readsPersonnel =
    personnel &&
    rule.facet === "scope" &&
    rule.actions.every((action) => action === "read");
  if (readsPersonnel) {
    if (!absenceDomain(`absence:${personnel[1]}:master-data`)) {
      throw new InvalidProtectedData();
    }
    return;
  }
  if (!absenceDomain(`${rule.scope}:${rule.facet}`)) {
    throw new InvalidProtectedData();
  }
  let permittedActions: readonly string[] = ["read", "approve"];
  if (rule.facet === "master-data") {
    permittedActions = ["read", "create", "delete"];
  }
  if (rule.actions.some((action) => !permittedActions.includes(action))) {
    throw new InvalidProtectedData();
  }
}

export const sortsysPolicyCodec = createPolicyCodec<Facet, "absence-default">(
  FACETS,
  {
    validateRuleOrigin,
    validateSuspendedSubject,
  },
);

export const {
  policy,
  compilePolicy,
  compileReadership,
  allows,
  policyFrame,
  signPolicy,
  signPolicyTransaction,
  verifyPolicy,
  administrativeProfiles,
  signAdministrativePolicy,
  parseSigned,
  canAdminister,
  administrativeReplacement,
} = sortsysPolicyCodec;
