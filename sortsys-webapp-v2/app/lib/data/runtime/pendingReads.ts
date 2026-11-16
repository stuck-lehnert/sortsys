type ReadInput = { path: string; input: unknown };

// Share only ordinary JSON inputs. Dates, custom objects, sparse arrays and
// accessors keep the existing direct path rather than risk matching an input
// with different validation semantics.
function shareable(input: unknown, seen = new Set<object>()): boolean {
  if (input === null) return true;
  if (typeof input === "string" || typeof input === "boolean") return true;
  if (typeof input === "number")
    return Number.isFinite(input) && !Object.is(input, -0);
  if (typeof input !== "object" || seen.has(input)) return false;
  seen.add(input);
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype) return false;
    if (Object.keys(input).length !== input.length) return false;
    if (Object.getOwnPropertyNames(input).length !== input.length + 1)
      return false;
    for (let index = 0; index < input.length; index++) {
      const property = Object.getOwnPropertyDescriptor(input, index);
      if (
        !property ||
        !("value" in property) ||
        !shareable(property.value, seen)
      )
        return false;
    }
    return Object.getOwnPropertySymbols(input).length === 0;
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(input).length) return false;
  return Object.values(Object.getOwnPropertyDescriptors(input)).every(
    (property) =>
      property.enumerable &&
      "value" in property &&
      shareable(property.value, seen),
  );
}

/** Identical local reads may share unfinished work, never a completed result.
 * Invalidation detaches old reads without cancelling their original callers. */
export function pendingReads<T>(
  read: (path: string, input: unknown) => Promise<T>,
  copy: (value: T) => T,
) {
  const pending = new Map<string, Promise<T>>();
  return {
    clear() {
      pending.clear();
    },
    async get(path: string, input: unknown): Promise<T> {
      let key: string | undefined;
      let request: ReadInput = { path, input };
      if (input === undefined || shareable(input)) {
        const encoded = JSON.stringify([path, input === undefined, input]);
        if (encoded.length <= 65_536) {
          key = encoded;
          request = { path, input: structuredClone(input) };
        }
      }
      let work = key === undefined ? undefined : pending.get(key);
      if (!work) {
        work = read(request.path, request.input);
        if (key !== undefined && pending.size < 256) {
          const entryKey = key;
          const entry = work.finally(() => {
            if (pending.get(entryKey) === entry) pending.delete(entryKey);
          });
          pending.set(entryKey, entry);
          work = entry;
        }
      }
      return copy(await work);
    },
  };
}
