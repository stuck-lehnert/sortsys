import { unlockedAccount } from "./session";

type Selection = { member: string | null; area: string | null };
const selections = new WeakMap<object, Selection>();

/** Only public IDs survive view replacement. Names and decoded records remain
 * in protected React state and are fetched again under the current rights. */
export function permissionSelection(): Selection {
  const account = unlockedAccount();
  const selected = account ? selections.get(account) : undefined;
  return { member: selected?.member ?? null, area: selected?.area ?? null };
}

export function rememberPermissionSelection(patch: Partial<Selection>): void {
  const account = unlockedAccount();
  if (!account) return;
  selections.set(account, { ...permissionSelection(), ...patch });
}
