import type { Client } from "@sortsys/v2-client";
import { useEffect } from "react";
import { useProtectedState } from "~/hooks/useProtectedState";

export function usePersonnelNames(client: Client, ids: readonly string[]) {
  const key = JSON.stringify([...new Set(ids)].sort());
  const [result, setResult, context] = useProtectedState<{
    client: Client;
    key: string;
    names?: ReadonlyMap<string, string>;
  } | undefined>(undefined);

  useEffect(() => {
    setResult(undefined);
    if (key === "[]" || context.aborted) return;

    const controller = new AbortController();
    const signal = AbortSignal.any([context, controller.signal]);
    const userIds: string[] = JSON.parse(key);
    void import("~/lib/data/personnelNames")
      .then(({ loadPersonnelNames }) => loadPersonnelNames(client, userIds, signal))
      .then(
        (names) => {
          if (!signal.aborted) setResult({ client, key, names });
        },
        () => {
          // A failed or denied name lookup must not hide the readable records.
          if (!signal.aborted) setResult({ client, key });
        },
      );

    return () => controller.abort();
  }, [client, context, key, setResult]);

  const current = result?.client === client && result.key === key ? result : undefined;
  return {
    names: current?.names,
    pending: key !== "[]" && !context.aborted && !current,
    context,
  };
}
