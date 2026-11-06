import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable event identity lets memoized editor panels retain their render while
 * actions always read the most recently committed document and selection. */
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const current = useRef(callback);
  useLayoutEffect(() => {
    current.current = callback;
  });
  return useCallback((...args: Args) => current.current(...args), []);
}
