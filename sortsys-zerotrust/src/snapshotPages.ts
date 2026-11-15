import { bytes, InvalidProtectedData, record, utf8 } from "./encoding";

export function validatePageToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 2048) {
    throw new InvalidProtectedData();
  }
  const encoded = bytes(value);
  if (encoded.length > 2048 || utf8(encoded) !== value) throw new InvalidProtectedData();
}

export type SnapshotPage<T> = {
  snapshot: string;
  items: T[];
  after: string | null;
};
export type SnapshotPageRequest = {
  snapshot: string | null;
  after: string | null;
};

/** Read one stable inventory without prefetching or hiding snapshot changes.
 * Pagination does not authenticate its items; callers must still verify their
 * signatures, expected context and application schema before using contents. */
export async function* readSnapshotPages<T>(options: {
  read: (request: SnapshotPageRequest) => Promise<SnapshotPage<T>>;
  maxItems: number;
  snapshot?: string;
  signal?: AbortSignal;
}): AsyncGenerator<readonly T[]> {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1) {
    throw new InvalidProtectedData();
  }
  let snapshot = options.snapshot ?? null;
  if (snapshot !== null) validatePageToken(snapshot);
  let after: string | null = null;
  const cursors = new Set<string>();
  for (;;) {
    options.signal?.throwIfAborted();
    const input = await options.read({ snapshot, after });
    options.signal?.throwIfAborted();
    const page = record(input, ["snapshot", "items", "after"]);
    validatePageToken(page.snapshot);
    if (snapshot !== null && page.snapshot !== snapshot) {
      throw new InvalidProtectedData();
    }
    if (!Array.isArray(page.items) || page.items.length > options.maxItems) {
      throw new InvalidProtectedData();
    }
    if (page.after !== null) validatePageToken(page.after);
    if (typeof page.after === "string") {
      if (cursors.has(page.after)) throw new InvalidProtectedData();
      cursors.add(page.after);
    }
    snapshot = page.snapshot;
    after = page.after;
    // Own the array: an adapter cannot change its length between validation and
    // consumption. Content authentication remains the consuming codec's task.
    yield page.items.slice() as T[];
    if (after === null) return;
  }
}

export async function collectSnapshotPages<T>(
  options: Parameters<typeof readSnapshotPages<T>>[0],
): Promise<T[]> {
  const items: T[] = [];
  for await (const page of readSnapshotPages(options)) {
    for (const item of page) items.push(item);
  }
  return items;
}
