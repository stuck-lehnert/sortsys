import { useEffect, useState } from "react";

export function usePromise<T>(createPromise: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);

  useEffect(() => {
    if (data) setData(null);

    let cancelled = false;

    createPromise().then((res) => {
      if (cancelled) return;
      setData(res);
    });

    return () => { cancelled = true; };
  }, deps);

  return data;
}