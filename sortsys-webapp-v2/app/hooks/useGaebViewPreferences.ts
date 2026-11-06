import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_GAEB_VIEW, type GaebViewPreferences } from "@sortsys/gaeb";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";

/** Settings are user-scoped on the server; no tenant/user data leaks through a global browser key. */
export function useGaebViewPreferences(retry: number) {
  const [preferences, setPreferences] = useState<GaebViewPreferences | null>(
    null,
  );
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const latest = useRef<GaebViewPreferences | undefined>(undefined);
  const pending = useRef<GaebViewPreferences | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve());
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const value = pending.current;
    if (!value) return queue.current;
    pending.current = undefined;
    queue.current = queue.current
      .then(async () => {
        const [, failure] = await client.mutate(
          "personalization.gaebView.set",
          value,
        );
        if (failure) {
          if (latest.current !== value) return;
          pending.current ??= value;
          setError(
            uiText(
              "Die Ansichtseinstellungen konnten nicht gespeichert werden.",
              "View preferences could not be saved.",
            ),
          );
        } else setError("");
      })
      .catch(() => {
        if (latest.current === value) pending.current ??= value;
      });
    return queue.current;
  }, []);
  useEffect(() => {
    let active = true;
    void client
      .query("personalization.gaebView.get", undefined, {
        strategy: "network-first",
      })
      .then(([value, failure]) => {
        if (!active) return;
        setPreferences(value ?? DEFAULT_GAEB_VIEW);
        setError(
          failure
            ? uiText(
                "Die Ansichtseinstellungen konnten nicht geladen werden.",
                "View preferences could not be loaded.",
              )
            : "",
        );
      });
    return () => {
      active = false;
      void flush();
    };
  }, [retry, reloadTick, flush]);
  useEffect(() => {
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [flush]);
  const change = useCallback(
    (next: GaebViewPreferences) => {
      latest.current = next;
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 300);
    },
    [flush],
  );
  return {
    preferences,
    error,
    change,
    flush,
    reload: () => setReloadTick((value) => value + 1),
  };
}
