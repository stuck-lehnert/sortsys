import { mapConcurrent } from "@sortsys/zerotrust";
import {
  creationRules,
  InvalidProtectedData,
  verifyCreationOrigin,
  type CreationOrigin,
  type Policy,
} from "@sortsys/zerotrust/sortsys";

type CreationTrust = {
  authority: (generation: string) => CryptoKey;
  current: { generation: string };
};

/** Raw transport results never grant access until every relevant origin is
 * verified against the pinned generation, tenant and requested domain set.
 * Derived grants cannot override an explicit root denial. */
export async function verifyCreatedAccess(
  origins: readonly unknown[],
  permissions: Policy,
  history: CreationTrust,
  signal: AbortSignal,
  domains?: ReadonlySet<string>,
): Promise<{ permissions: Policy; origins: CreationOrigin[] }> {
  if (!Array.isArray(origins)) throw new InvalidProtectedData();
  signal.throwIfAborted();
  if (origins.length === 0) return { permissions, origins: [] };

  const checked = await mapConcurrent(origins, 8, (origin) => {
    signal.throwIfAborted();
    return verifyCreationOrigin(origin, history.authority);
  });
  const inherited = [];
  const seen = new Set<string>();
  for (const origin of checked) {
    signal.throwIfAborted();
    if (
      origin.tenant !== permissions.tenant ||
      origin.capability.generation !== history.current.generation ||
      seen.has(origin.id) ||
      (domains && !domains.has(origin.id))
    )
      throw new InvalidProtectedData();
    seen.add(origin.id);
    inherited.push(...creationRules(origin, permissions));
  }

  signal.throwIfAborted();
  return {
    permissions: { ...permissions, rules: [...permissions.rules, ...inherited] },
    origins: checked,
  };
}
