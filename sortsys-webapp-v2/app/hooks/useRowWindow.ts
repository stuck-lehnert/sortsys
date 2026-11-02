import { useMemo, useState } from "react";

type RowWindow = {
  scope: string;
  count: number;
};

function restoreCount(key: string | null, scope: string, fallback: number) {
  if (!key || typeof window !== "object") {
    return fallback;
  }

  try {
    const saved: RowWindow | null = JSON.parse(
      window.sessionStorage.getItem(key) ?? "null",
    );
    if (
      saved?.scope === scope &&
      Number.isSafeInteger(saved.count) &&
      saved.count > 0
    ) {
      return saved.count;
    }
  } catch {
    // Optional view state must not prevent access to the list.
  }

  return fallback;
}

export function useRowWindow(
  rowIds: string[],
  batchSize: number,
  sorting: string,
  persistentId?: string,
) {
  // A changed ordered result set starts at its first batch. Updated row values
  // with the same identities retain the user's already expanded view.
  const scope = JSON.stringify([batchSize, sorting, rowIds]);
  const key =
    persistentId && typeof window === "object"
      ? `sortsys.tableRows:${window.location.pathname}:${persistentId}`
      : null;
  const restoredCount = useMemo(
    () => restoreCount(key, scope, batchSize),
    [key, scope, batchSize],
  );
  const [current, setCurrent] = useState<RowWindow | null>(null);
  const requestedCount =
    current?.scope === scope ? current.count : restoredCount;
  const visibleCount = Math.min(
    rowIds.length,
    Math.max(batchSize, requestedCount),
  );

  const showMore = () => {
    const next = {
      scope,
      count: Math.min(rowIds.length, visibleCount + batchSize),
    };
    setCurrent(next);

    if (key) {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // The in-memory view still works when browser storage is unavailable.
      }
    }
  };

  return { visibleCount, showMore };
}
