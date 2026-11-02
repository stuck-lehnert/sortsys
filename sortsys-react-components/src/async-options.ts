import { useEffect, useState } from "react";

type MaybePromise<T> = T | Promise<T>;

type OptionsSource<T> = {
  query: string;
  enabled?: boolean;
  prepare?: () => MaybePromise<any>;
  load?: (input: { query: string; init: any }) => MaybePromise<T[]>;
};

export function useAsyncOptions<T>({
  query,
  enabled = true,
  prepare,
  load,
}: OptionsSource<T>) {
  const [preparation, setPreparation] = useState({
    ready: false,
    failed: false,
    data: undefined as any,
  });
  const [response, setResponse] = useState({
    query: "",
    items: [] as T[],
    loading: false,
    failed: false,
  });

  useEffect(() => {
    let active = true;
    setPreparation({ ready: false, failed: false, data: undefined });

    if (!enabled) {
      return;
    }

    Promise.resolve()
      .then(() => prepare?.())
      .then((data) => {
        if (active) {
          setPreparation({ ready: true, failed: false, data });
        }
      })
      .catch(() => {
        if (active) {
          setPreparation({ ready: true, failed: true, data: undefined });
        }
      });

    return () => {
      active = false;
    };
  }, [enabled, prepare]);

  useEffect(() => {
    let active = true;
    const pending = enabled && Boolean(query) && Boolean(load);
    setResponse({ query, items: [], loading: pending, failed: false });

    if (!pending || !preparation.ready) {
      return;
    }

    if (preparation.failed) {
      setResponse({ query, items: [], loading: false, failed: true });
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const items = await load!({ query, init: preparation.data });

        if (active) {
          setResponse({
            query,
            items: items ?? [],
            loading: false,
            failed: false,
          });
        }
      } catch {
        if (active) {
          setResponse({ query, items: [], loading: false, failed: true });
        }
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [enabled, query, preparation, load]);

  return {
    items: response.query === query ? response.items : [],
    initialization: preparation.data,
    loading:
      enabled &&
      Boolean(query) &&
      Boolean(load) &&
      (!preparation.ready || response.query !== query || response.loading),
    failed:
      enabled && Boolean(query) && (preparation.failed || response.failed),
  };
}
