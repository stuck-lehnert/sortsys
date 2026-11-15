import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from "react";
import { protectedContent } from "~/lib/client";

/** React state belongs to the content-access lifetime that produced it. A
 * revoked context hides it synchronously and rejects late asynchronous setters. */
export function useProtectedState<T>(empty: T) {
  const context = useSyncExternalStore(
    protectedContent.listenContext,
    protectedContent.context,
    protectedContent.context,
  );
  const [stored, setStored] = useState(() => ({ context, value: empty }));
  useEffect(() => {
    const clear = () => setStored({ context, value: empty });
    setStored((previous) => {
      if (previous.context === context && !context.aborted) return previous;
      return { context, value: empty };
    });
    context.addEventListener("abort", clear, { once: true });
    if (context.aborted) clear();
    return () => context.removeEventListener("abort", clear);
  }, [context, empty]);
  const setValue = useCallback(
    (input: SetStateAction<T>) => {
      if (context.aborted || protectedContent.context() !== context) return;
      setStored((previous) => {
        if (context.aborted || protectedContent.context() !== context)
          return previous;
        let value = input as T;
        if (typeof input === "function") {
          const current = previous.context === context ? previous.value : empty;
          value = (input as (current: T) => T)(current);
        }
        return { context, value };
      });
    },
    [context, empty],
  );
  const value =
    stored.context === context && !context.aborted ? stored.value : empty;
  return [value, setValue, context] as const;
}
