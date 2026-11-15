export type EffectiveEntry<T> = {
  group: string;
  instant: bigint;
  id: bigint;
  value: T;
};

function compareEntries<T>(
  left: EffectiveEntry<T>,
  right: EffectiveEntry<T>,
): number {
  if (left.instant !== right.instant) {
    return left.instant < right.instant ? -1 : 1;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }
  return 0;
}

/** Select the latest effective entry per group without rounding timestamps or
 * IDs. The optional fallback is the earliest later entry, never the latest. */
export function effectiveHistory<T>(
  entries: Iterable<EffectiveEntry<T>>,
  cutoff: bigint,
  futureFallback: "earliest" | "none" = "none",
): Map<string, T> {
  const active = new Map<string, EffectiveEntry<T>>();
  const future = new Map<string, EffectiveEntry<T>>();

  for (const entry of entries) {
    if (entry.instant <= cutoff) {
      const previous = active.get(entry.group);
      if (!previous || compareEntries(entry, previous) > 0) {
        active.set(entry.group, entry);
      }
    } else if (futureFallback === "earliest") {
      const previous = future.get(entry.group);
      if (!previous || compareEntries(entry, previous) < 0) {
        future.set(entry.group, entry);
      }
    }
  }

  const result = new Map<string, T>();
  for (const [group, entry] of active) {
    result.set(group, entry.value);
  }
  for (const [group, entry] of future) {
    if (!result.has(group)) {
      result.set(group, entry.value);
    }
  }
  return result;
}

/** Build once for reports that price many records at different instants.
 * Each lookup searches only the requested group's sorted history. */
export function indexEffectiveHistory<T>(entries: Iterable<EffectiveEntry<T>>) {
  const groups = new Map<string, EffectiveEntry<T>[]>();
  for (const entry of entries) {
    const group = groups.get(entry.group) ?? [];
    group.push(entry);
    groups.set(entry.group, group);
  }
  for (const group of groups.values()) {
    group.sort(compareEntries);
  }

  return (
    group: string,
    cutoff: bigint,
    futureFallback: "earliest" | "none" = "none",
  ): T | undefined => {
    const history = groups.get(group);
    if (!history?.length) {
      return undefined;
    }
    let lower = 0;
    let upper = history.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (history[middle]!.instant <= cutoff) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    if (lower > 0) {
      return history[lower - 1]!.value;
    }
    if (futureFallback === "earliest") {
      return history[0]!.value;
    }
    return undefined;
  };
}
