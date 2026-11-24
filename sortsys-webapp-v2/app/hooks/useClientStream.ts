import { useEffect, useMemo, useState } from "react";
import type { Observable } from "rxjs";

export function useClientStream<T, ErrT>(
  createStream: () => Observable<[T, ErrT]>,
  deps: readonly unknown[] = [],
) {
  const request = useMemo(
    () => ({ createStream, pending: [null, null] as [T, ErrT] }),
    deps,
  );
  const [current, setCurrent] = useState<{
    request: typeof request;
    result: [T, ErrT];
  }>();

  useEffect(() => {
    setCurrent((previous) =>
      previous?.request === request ? previous : undefined,
    );

    const subscription = request.createStream().subscribe((result) => {
      setCurrent({ request, result });
    });

    return () => subscription.unsubscribe();
  }, [request]);

  // Effects run after the new render. Do not commit a previous selection's
  // data or error while waiting to subscribe to the new request.
  return current?.request === request ? current.result : request.pending;
}
