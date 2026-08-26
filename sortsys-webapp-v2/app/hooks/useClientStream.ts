import { useEffect, useState } from "react";
import type { Observable } from "rxjs";

export function useClientStream<T, ErrT>(createStream: () => Observable<[T, ErrT]>, deps: any[] = []) {
  const [current, setCurrent] = useState<[T, ErrT]>([null, null] as any);

  useEffect(() => {
    if (current) setCurrent([null, null] as any);

    const subscription = createStream().subscribe((event) => {
      setCurrent(event);
    });

    return () => subscription.unsubscribe();
  }, deps);

  return current;
}
