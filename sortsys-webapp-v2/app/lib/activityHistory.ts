type ActivityResource = {
  id: string;
  resourceType: string;
  resourceId: string;
};

type ActivityHistoryState<T> = {
  items: T[];
  loading: boolean;
  complete: boolean;
  error: boolean;
};

function uniqueResources<T extends ActivityResource>(items: readonly T[]): T[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = `${item.resourceType}:${item.resourceId}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

// Each first-page snapshot owns its paging state, including outstanding requests.
export function createActivityHistory<T extends ActivityResource>(
  firstPage: readonly T[],
  pageSize: number,
) {
  const listeners = new Set<() => void>();
  let cursor = firstPage.at(-1)?.id;
  let state: ActivityHistoryState<T> = {
    items: uniqueResources(firstPage),
    loading: false,
    complete: firstPage.length < pageSize,
    error: false,
  };

  function publish(next: ActivityHistoryState<T>) {
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
          items: uniqueResources([...state.items, ...page]),
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
