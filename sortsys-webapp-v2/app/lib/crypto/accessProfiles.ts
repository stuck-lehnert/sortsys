import {
  ACTIONS,
  compilePolicy,
  InvalidProtectedData,
  record,
  type Facet,
  type Policy,
  type Rule,
} from "@sortsys/zerotrust/sortsys";
import { PRICE_COLLECTION, PRODUCT_COLLECTION } from "../data/products";
import { CUSTOMER_COLLECTION, CONTACT_COLLECTION } from "../data/addressBook";
import { VENDOR_COLLECTION } from "../data/vendorData";

export const MASTER_DATA_AREAS = {
  catalogue: PRODUCT_COLLECTION,
  customers: CUSTOMER_COLLECTION,
  contacts: CONTACT_COLLECTION,
  vendors: VENDOR_COLLECTION,
  prices: PRICE_COLLECTION,
};
export const MASTER_DATA_FIELDS = [
  "catalogue",
  "customers",
  "contacts",
  "vendors",
  "prices",
] as const;
export type MasterDataField = (typeof MASTER_DATA_FIELDS)[number];
export type AccessLevel = "none" | "read" | "write";
export const DATA_ACTIONS = ["read", "create", "update", "delete"] as const;
export type DataAction = (typeof DATA_ACTIONS)[number];
type Action = Rule["actions"][number];
export type ManagedAction = Action;
export type AccessValue = AccessLevel | { readonly actions: readonly Action[] };
export type ActionPatch = Partial<Record<Action, boolean>>;
// A null decision lets the remaining policy rules apply to that action.
export type RuleDecisionPatch = Partial<Record<Action, boolean | null>>;
export const inheritDataActions: Readonly<RuleDecisionPatch> = Object.freeze(
  Object.fromEntries(DATA_ACTIONS.map((action) => [action, null])),
);
export type ManagedAccess = {
  [key in MasterDataField]: AccessValue;
} & { assistant: boolean };
const PRESETS = { none: [], read: ["read"], write: DATA_ACTIONS } as const;

export function accessValue(input: unknown): AccessValue {
  if (typeof input === "string") {
    if (Object.hasOwn(PRESETS, input)) return input as AccessLevel;
    throw new InvalidProtectedData();
  }
  const value = record(input, ["actions"]);
  if (
    !Array.isArray(value.actions) ||
    value.actions.length > ACTIONS.length ||
    value.actions.some((action) => !ACTIONS.includes(action)) ||
    new Set(value.actions).size !== value.actions.length
  )
    throw new InvalidProtectedData();
  const provided = value.actions;
  const actions = ACTIONS.filter((action) => provided.includes(action));
  for (const key of ["none", "read", "write"] as const)
    if (actions.join() === PRESETS[key].join()) return key;
  return { actions: Object.freeze(actions) };
}
export function accessActions(value: AccessValue): readonly Action[] {
  return typeof value === "string" ? PRESETS[value] : value.actions;
}
export function hasAccess(value: AccessValue, action: Action): boolean {
  return accessActions(value).includes(action);
}
export function sameAccess(first: AccessValue, second: AccessValue): boolean {
  return ACTIONS.every(
    (action) => hasAccess(first, action) === hasAccess(second, action),
  );
}
export function accessPreset(value: AccessValue): AccessLevel | "custom" {
  const checked = accessValue(value);
  return typeof checked === "string" ? checked : "custom";
}
function parseActionPatch<Decision>(
  input: unknown,
  isDecision: (value: unknown) => value is Decision,
): Partial<Record<Action, Decision>> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !(ACTIONS as readonly string[]).includes(key),
    )
  )
    throw new InvalidProtectedData();
  const value = record(input, Object.keys(input));
  if (!Object.values(value).every(isDecision))
    throw new InvalidProtectedData();
  return { ...value } as Partial<Record<Action, Decision>>;
}
export function actionPatch(input: unknown): ActionPatch {
  return parseActionPatch(input, (value) => typeof value === "boolean");
}
export function ruleDecisionPatch(input: unknown): RuleDecisionPatch {
  return parseActionPatch(
    input,
    (value) => value === null || typeof value === "boolean",
  );
}
export function profilePatch(value: AccessValue): ActionPatch {
  return Object.fromEntries(
    ACTIONS.map((action) => [action, hasAccess(value, action)]),
  );
}
export function withActions(
  value: AccessValue,
  patch: ActionPatch,
): AccessValue {
  const checked = actionPatch(patch);
  return accessValue({
    actions: ACTIONS.filter((action) =>
      Object.hasOwn(checked, action)
        ? checked[action]
        : hasAccess(value, action),
    ),
  });
}
export type AccessDraft = {
  original: AccessValue;
  value: AccessValue;
  patch: ActionPatch;
};
export function accessDraft(value: AccessValue): AccessDraft {
  const checked = accessValue(value);
  return { original: checked, value: checked, patch: {} };
}
export function editAccessDraft(
  draft: AccessDraft,
  value: AccessValue,
  actions: readonly ManagedAction[],
): AccessDraft {
  const patch = actionPatch(
    Object.fromEntries(
      actions.map((action) => [action, hasAccess(value, action)]),
    ),
  );
  return {
    ...draft,
    value: withActions(draft.value, patch),
    patch: { ...draft.patch, ...patch },
  };
}
export function accessChanged(draft: AccessDraft): boolean {
  return !sameAccess(draft.original, draft.value);
}
export function accessDrafts<K extends string>(
  keys: readonly K[],
  value: (key: K) => AccessValue,
): Record<K, AccessDraft> {
  return Object.fromEntries(
    keys.map((key) => [key, accessDraft(value(key))]),
  ) as Record<K, AccessDraft>;
}

/** Change explicit decisions for only the edited actions. Other rules and
 * extended actions retain their order and exact contents. Already applied
 * decisions are left untouched, so interrupted rotations can resume. */
export function patchAccessRules(
  rules: readonly Rule[],
  subject: string,
  changes: readonly {
    area: { scope: string; facet: Facet };
    patch: RuleDecisionPatch;
  }[],
): Rule[] {
  const remaining = rules.map((rule) => ({
    ...rule,
    actions: [...rule.actions],
  }));
  const additions: Rule[] = [];
  const seen = new Set<string>();
  for (const { area, patch: input } of changes) {
    const key = `${area.scope}\0${area.facet}`;
    if (seen.has(key)) throw new InvalidProtectedData();
    seen.add(key);
    const patch = ruleDecisionPatch(input);
    const allow: Action[] = [];
    const deny: Action[] = [];
    for (const action of ACTIONS) {
      if (!Object.hasOwn(patch, action)) continue;
      const matching = remaining.filter(
        (rule) =>
          !rule.origin &&
          rule.subject === subject &&
          rule.scope === area.scope &&
          rule.facet === area.facet &&
          rule.actions.includes(action),
      );
      let decision: boolean | null = null;
      if (matching.some((rule) => rule.effect === "deny")) {
        decision = false;
      } else if (matching.some((rule) => rule.effect === "allow")) {
        decision = true;
      }
      const next = patch[action];
      if (decision === next) continue;
      for (const rule of matching)
        rule.actions = rule.actions.filter((value) => value !== action);
      if (next === true) allow.push(action);
      else if (next === false) deny.push(action);
    }
    if (allow.length)
      additions.push({
        subject,
        scope: area.scope,
        facet: area.facet,
        actions: allow,
        effect: "allow",
      });
    if (deny.length)
      additions.push({
        subject,
        scope: area.scope,
        facet: area.facet,
        actions: deny,
        effect: "deny",
      });
  }
  return [...remaining.filter((rule) => rule.actions.length), ...additions];
}
/** Presentation of a verified policy; custom action sets remain untouched until
 * an area is explicitly edited. Use the same deny/suspension rules as writes. */
export function compileManagedAccess(permissions: Policy, subject: string) {
  const access = compilePolicy(permissions, [subject]);
  return (area: { scope: string; facet: Facet }): AccessValue =>
    accessValue({
      actions: ACTIONS.filter((action) =>
        access.allows(area.scope, area.facet, action),
      ),
    });
}
export function managedAccess(input: unknown): ManagedAccess {
  const data = record(input, [...MASTER_DATA_FIELDS, "assistant"]);
  if (typeof data.assistant !== "boolean") throw new InvalidProtectedData();
  return {
    ...(Object.fromEntries(
      MASTER_DATA_FIELDS.map((key) => [key, accessValue(data[key])]),
    ) as Omit<ManagedAccess, "assistant">),
    assistant: data.assistant,
  };
}
