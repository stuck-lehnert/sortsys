/** Store entries by two object identities without keeping either key alive.
 * Callers still own freshness and authorization checks. */
export function createWeakPairCache<
  Outer extends object,
  Inner extends object,
  Entry extends object,
>(initialize: () => Entry) {
  const groups = new WeakMap<Outer, WeakMap<Inner, Entry>>();

  function getOrCreate(outer: Outer, inner: Inner): Entry {
    let group = groups.get(outer);
    if (!group) {
      group = new WeakMap();
      groups.set(outer, group);
    }

    const existing = group.get(inner);
    if (existing) return existing;

    const entry = initialize();
    group.set(inner, entry);
    return entry;
  }

  function deleteIfCurrent(outer: Outer, inner: Inner, entry: Entry): void {
    const group = groups.get(outer);
    if (group?.get(inner) === entry) group.delete(inner);
  }

  return { getOrCreate, deleteIfCurrent };
}
