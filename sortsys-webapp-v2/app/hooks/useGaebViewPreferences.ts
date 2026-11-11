import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_GAEB_VIEW, type GaebViewPreferences } from "@sortsys/gaeb";
import { client, projectFiles } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { useProtectedDataContext } from "./useProtectedDataContext";

type PendingView = { context: AbortSignal; value: GaebViewPreferences };
/** Preferences outlive the dialog in encrypted storage. Pending saves stay
 * bound to the account that edited them, including during dialog cleanup. */
export function useGaebViewPreferences(retry: number) {
  const context = useProtectedDataContext();
  const loadedContext = useRef<AbortSignal | null>(null);
  const [preferences, setPreferences] = useState<GaebViewPreferences | null>(
    null,
  );
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const latest = useRef<PendingView | undefined>(undefined);
  const pending = useRef<PendingView | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve());
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const entry = pending.current;
    if (!entry || entry.context !== context) return queue.current;
    pending.current = undefined;
    const active = () => !context.aborted && projectFiles.context() === context;
    if (!active()) return queue.current;
    queue.current = queue.current
      .then(async () => {
        if (!active()) return;
        const [, failure] = await client.mutate(
          "personalization.gaebView.set",
          entry.value,
        );
        if (!active()) return;
        if (failure) {
          if (latest.current !== entry) return;
          pending.current ??= entry;
          setError(
            uiText(
              "Die Ansichtseinstellungen konnten nicht gespeichert werden.",
              "View preferences could not be saved.",
            ),
          );
        } else setError("");
      })
      .catch(() => {
        if (active() && latest.current === entry) {
          pending.current ??= entry;
          setError(uiText("Die Ansichtseinstellungen konnten nicht gespeichert werden.", "View preferences could not be saved."));
        }
      });
    return queue.current;
  }, [context]);
  useEffect(() => {
    let active = true;
    setPreferences(null); setError(""); latest.current = undefined; pending.current = undefined;
    void client
      .query("personalization.gaebView.get", undefined, {
        strategy: "network-first",
      })
      .then(([value, failure]) => {
        if (!active || context.aborted || projectFiles.context() !== context) return;
        loadedContext.current = context;
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
  }, [retry, reloadTick, flush, context]);
  useEffect(() => {
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [flush]);
  const change = useCallback(
    (next: GaebViewPreferences) => {
      if (context.aborted || projectFiles.context() !== context) return;
      latest.current = { context, value: next };
      pending.current = latest.current;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 300);
    },
    [flush, context],
  );
  return {
    preferences: loadedContext.current === context && !context.aborted ? preferences : null,
    error: loadedContext.current === context && !context.aborted ? error : "",
    change,
    flush,
    reload: () => setReloadTick((value) => value + 1),
  };
}
