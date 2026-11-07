import { diffArrays, diffChars } from "diff";

type Edit = { start: number; end: number; value: string };
function edits(before: string, after: string, characters = false): Edit[] {
  const tokens = (value: string) =>
    value.match(
      /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^<>"']|"[^"]*"|'[^']*')+>|[^<]+/g,
    ) ?? [];
  const options = { timeout: 80, maxEditLength: 10000 };
  const changes = characters
    ? diffChars(before, after, options)
    : diffArrays(tokens(before), tokens(after), options);
  if (!changes) throw new Error("merge-conflict");
  const result: Edit[] = [];
  let position = 0,
    pending: Edit | undefined;
  for (const change of changes) {
    const value =
      typeof change.value === "string" ? change.value : change.value.join("");
    if (!change.added && !change.removed) {
      if (pending) result.push(pending);
      pending = undefined;
      position += value.length;
    } else {
      pending ??= { start: position, end: position, value: "" };
      if (change.removed) {
        position += value.length;
        pending.end = position;
      } else pending.value += value;
    }
  }
  if (pending) result.push(pending);
  return result;
}
function combine(
  base: string,
  local: string,
  remote: string,
  characters = false,
): string {
  if (local === remote || remote === base) return local;
  if (local === base) return remote;
  const own = edits(base, local, characters),
    others = edits(base, remote, characters);
  const combined = [...others];
  for (const edit of own) {
    const collisions = others.filter(
      (other) =>
        edit.start === other.start ||
        (edit.start < other.end && edit.end > other.start) ||
        (edit.start > other.start && edit.start < other.end) ||
        (other.start > edit.start && other.start < edit.end),
    );
    if (!collisions.length) {
      combined.push(edit);
      continue;
    }
    if (collisions.length !== 1) throw new Error("merge-conflict");
    const other = collisions[0]!;
    if (
      edit.start === other.start &&
      edit.end === other.end &&
      edit.value === other.value
    )
      continue;
    if (edit.start !== other.start || edit.end !== other.end)
      throw new Error("merge-conflict");
    if (characters && edit.start === edit.end) {
      other.value += edit.value;
      continue;
    }
    // Merge simultaneous typing inside a simple GAEB span. Prices, identifiers,
    // attributes and XML structures require an explicit conflict resolution.
    const original = base.slice(edit.start, edit.end);
    if (
      !characters &&
      /<(?:(?:[\w.-]+):)?span(?:\s[^>]*)?>$/.test(base.slice(0, edit.start)) &&
      /^<\/(?:(?:[\w.-]+):)?span>/.test(base.slice(edit.end)) &&
      !/[<&]/.test(original + edit.value + other.value)
    ) {
      other.value = combine(original, edit.value, other.value, true);
      continue;
    }
    throw new Error("merge-conflict");
  }
  let result = base;
  for (const edit of combined.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

/** Conservative three-way merge: never resolve an ambiguous business value by
 * silently overwriting another editor. The caller validates the resulting XML. */
export const mergeGaebXml = (base: string, local: string, remote: string) =>
  combine(base, local, remote);
