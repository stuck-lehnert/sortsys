import { useRefState } from "./useRefState";

export function useLoading(): [() => boolean, (action: () => Promise<void> | void) => Promise<void>] {
  const [loading, setLoading] = useRefState(false);

  return [loading, async (action) => {
    if (loading()) return;
    setLoading(true, !loading());

    try {
      await action();
    } finally {
      setLoading(false, loading());
    }
  }];
}