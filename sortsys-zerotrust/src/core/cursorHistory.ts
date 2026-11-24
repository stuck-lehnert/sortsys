export type CursorHistoryState<T> = {
  items: T[];
  loading: boolean;
  complete: boolean;
  error: boolean;
};

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = keyOf(item);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

// Each first-page snapshot owns its paging state, including outstanding requests.
export function createCursorHistory<T extends { id: string }>(
  firstPage: readonly T[],
  pageSize: number,
  keyOf: (item: T) => string = (item) => item.id,
) {
  const listeners = new Set<() => void>();
  let cursor = firstPage.at(-1)?.id;
  let state: CursorHistoryState<T> = {
    items: uniqueBy(firstPage, keyOf),
    loading: false,
    complete: firstPage.length < pageSize,
    error: false,
  };

  function publish(next: CursorHistoryState<T>) {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot() {
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    async loadOlder(loadPage: (cursor: string) => Promise<readonly T[]>) {
      if (state.loading || state.complete || !cursor) {
        return;
      }

      const requestedCursor = cursor;

      publish({ ...state, loading: true, error: false });

      try {
        const page = await loadPage(requestedCursor);

        cursor = page.at(-1)?.id ?? requestedCursor;

        publish({
          items: uniqueBy([...state.items, ...page], keyOf),
          loading: false,
          complete: page.length < pageSize || cursor === requestedCursor,
          error: false,
        });
      } catch {
        publish({ ...state, loading: false, error: true });
      }
    },
  };
}
