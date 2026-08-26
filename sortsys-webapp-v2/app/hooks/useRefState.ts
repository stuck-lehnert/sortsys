import { useRef } from "react";
import { useForceUpdate } from "./useForceUpdate";

export function useRefState<T>(initialValue: T): [() => T, (value: T, rerender?: boolean) => void] {
  const ref = useRef(initialValue);
  const forceUpdate = useForceUpdate();

  return [
    () => ref.current,
    (value, rerender) => {
      ref.current = value;
      if (rerender) forceUpdate();
    },
  ];
}