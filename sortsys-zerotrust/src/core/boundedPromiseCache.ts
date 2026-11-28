/** Share successful work and in-flight requests by exact key. The oldest
 * insertion is evicted first. Rejections never replace a newer entry.
 * Callers still own scope, freshness and authorization checks. */
export function readCachedPromise<Key, Value>(
  entries: Map<Key, Promise<Value>>,
  key: Key,
  capacity: number,
  load: () => Promise<Value>,
): Promise<Value> {
  const previous = entries.get(key);
  if (previous) return previous;

  const pending = load();
  entries.set(key, pending);
  if (entries.size > capacity) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }

  void pending.catch(() => {
    if (entries.get(key) === pending) entries.delete(key);
  });
  return pending;
}
