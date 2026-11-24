// Share ordinary data inputs, including bigint pagination values. Dates,
// custom objects, sparse arrays and accessors keep the direct path rather than
// risk matching an input with different validation semantics.
function shareable(input: unknown, seen = new Set<object>()): boolean {
  if (input === null) return true;
  if (
    typeof input === "string" ||
    typeof input === "boolean" ||
    typeof input === "bigint"
  )
    return true;
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

// Tag every container so a bigint cannot alias a string, number or a caller's
// object/array that happens to look like our bigint representation.
function keyValue(input: unknown): unknown {
  if (typeof input === "bigint") return ["bigint", input.toString()];
  if (Array.isArray(input)) return ["array", input.map(keyValue)];
  if (input !== null && typeof input === "object") {
    return [
      "object",
      Object.entries(input).map(([name, value]) => [name, keyValue(value)]),
    ];
  }
  return input;
}

/** Identical local reads may share unfinished work, never a completed result.
 * Invalidation detaches old reads without cancelling their original callers. */
export function pendingReads<T>(
  read: (path: string, input: unknown) => Promise<T>,
  copy: (value: T) => T,
) {
  const pending = new Map<string, { path: string; work: Promise<T> }>();
  return {
    clear(matches?: (path: string) => boolean) {
      if (!matches) {
        pending.clear();
        return;
      }
      for (const [key, entry] of pending) {
        if (matches(entry.path)) pending.delete(key);
      }
    },
    async get(path: string, input: unknown): Promise<T> {
      if (input !== undefined && !shareable(input)) {
        return copy(await read(path, input));
      }

      const key = JSON.stringify([path, input === undefined, keyValue(input)]);
      if (key.length > 65_536) return copy(await read(path, input));

      const existing = pending.get(key);
      if (existing) return copy(await existing.work);

      const work = read(path, structuredClone(input));
      if (pending.size >= 256) return copy(await work);

      const entry = work.finally(() => {
        if (pending.get(key)?.work === entry) pending.delete(key);
      });
      pending.set(key, { path, work: entry });

      return copy(await entry);
    },
  };
}
