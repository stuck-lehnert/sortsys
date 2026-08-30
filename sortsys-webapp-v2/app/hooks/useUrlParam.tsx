import { useCallback, useEffect, useRef, useState } from "react";

type UrlWriteMode = "replace" | "push";

function readSearchParam(name: string): string | null {
  if (typeof window === "undefined") return null;

  const sp = new URLSearchParams(window.location.search);
  return sp.get(name);
}

function writeSearchParam(
  name: string,
  value: string | null | undefined,
  mode: UrlWriteMode = "replace"
) {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);

  if (value == null || value === "") url.searchParams.delete(name);
  else url.searchParams.set(name, value);

  const method = mode === "push" ? "pushState" : "replaceState";
  window.history[method](window.history.state, "", url.toString());
}

function useLazyUrlParam<T>(
  name: string,
  decode: (raw: string | null) => T,
  encode: (value: T) => string | null | undefined,
  options?: {
    syncOnPopState?: boolean;
    writeMode?: UrlWriteMode;
    flushStrategy?: "raf" | number;
  }
): [T, (next: T) => void] {
  const {
    syncOnPopState = false,
    writeMode = "replace",
    flushStrategy = "raf",
  } = options ?? {};

  const [state, setState] = useState<T>(() => decode(null));
  const decodeRef = useRef(decode);

  // Use `undefined` as "nothing pending" so `null` can be a real value.
  const pendingRef = useRef<T | undefined>(undefined);

  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  decodeRef.current = decode;


  const flush = useCallback(() => {
    if (pendingRef.current === undefined) return;
    const v = pendingRef.current;
    pendingRef.current = undefined;
    writeSearchParam(name, encode(v), writeMode);
  }, [name, encode, writeMode]);

  const scheduleFlush = useCallback(() => {
    if (typeof window === "undefined") return;

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (flushStrategy === "raf") {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        flush();
      });
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flush();
    }, flushStrategy);
  }, [flush, flushStrategy]);

  const set = useCallback(
    (next: T) => {
      setState(next);
      pendingRef.current = next; // can now safely be null
      scheduleFlush();
    },
    [scheduleFlush]
  );

  useEffect(() => {
    // Reading after hydration keeps the server and browser's first render identical.
    setState(decodeRef.current(readSearchParam(name)));
  }, [name]);

  useEffect(() => {
    if (!syncOnPopState) return;
    if (typeof window === "undefined") return;

    const onPopState = () => {
      const next = decode(readSearchParam(name));
      setState(next);
      pendingRef.current = undefined; // navigation wins
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [name, decode, syncOnPopState]);

  useEffect(() => {
    return () => {
      if (typeof window === "undefined") return;

      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return [state, set];
}


/** Same export name/signature as before */
export function useStringUrlParam(name: string) {
  return useLazyUrlParam<string | null>(
    name,
    (raw) => raw ?? null,
    (value) => (value == null ? null : value)
  );
}

/** Same export name/signature as before */
export function useBoolUrlParam(name: string) {
  return useLazyUrlParam<boolean>(
    name,
    (raw) => raw === "yes",
    (value) => (value ? "yes" : null)
  );
}

/** Same export name/signature as before */
export function useIntUrlParam(name: string) {
  return useLazyUrlParam<number | null>(
    name,
    (raw) => {
      const n = parseInt(raw ?? "", 10);
      return Number.isNaN(n) ? null : n;
    },
    (value) => {
      if (typeof value !== "number" || Number.isNaN(value)) return null;
      return Math.trunc(value).toString();
    }
  ) as [number | null, (value: number | null | undefined) => void];
}

/** Same export name/signature as before */
export function useFloatUrlParam(name: string) {
  return useLazyUrlParam<number | null>(
    name,
    (raw) => {
      const n = parseFloat(raw ?? "");
      return Number.isNaN(n) ? null : n;
    },
    (value) => {
      if (typeof value !== "number" || Number.isNaN(value)) return null;
      return value.toString();
    }
  ) as [number | null, (value: number | null | undefined) => void];
}

/** Same export name/signature as before */
export function useJsonUrlParam(name: string) {
  return useLazyUrlParam<any>(
    name,
    (raw) => {
      if (!raw) return null;
      try {
        return JSON.parse(atob(raw)) ?? null;
      } catch {
        return null;
      }
    },
    (value) => {
      if (value === null || value === undefined) return null;
      try {
        return btoa(JSON.stringify(value));
      } catch {
        return null;
      }
    }
  ) as [any, (value: any) => void];
}