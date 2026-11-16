import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@sortsys/react-components";
import { useProtectedState } from "~/hooks/useProtectedState";
import { client } from "~/lib/client";
import { listenCryptoSession, unlockedAccount } from "~/lib/crypto/session";
import {
  changeCreationAccesses,
  memberCreationAccesses,
  type CreationAccesses,
} from "~/lib/crypto/permissions";
import { uiText } from "~/lib/i18n";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import type { ResourceAccessProps } from "./ResourceAccess";

const fields = [
  {
    namespace: "project",
    label: () => uiText("Neue Projekte anlegen", "Create new projects"),
  },
  {
    namespace: "commercial",
    label: () =>
      uiText(
        "Neue Angebote und Aufträge anlegen",
        "Create new offers and contracts",
      ),
  },
  {
    namespace: "tool-tracking",
    label: () =>
      uiText("Neue Werkzeugbuchungen anlegen", "Create new tool bookings"),
  },
] as const;

export function CreationAccess({
  user,
  disabled = false,
  onBusyChange,
}: ResourceAccessProps) {
  const [state, setState, context] = useProtectedState<{
    saved: CreationAccesses;
    draft: CreationAccesses;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context, controller.signal]);
    setState(null);
    if (operation.current || !unlockedAccount())
      return () => controller.abort();
    setError(false);
    void memberCreationAccesses(client, user, signal)
      .then((access) => {
        signal.throwIfAborted();
        setState({ saved: access, draft: { ...access } });
      })
      .catch(() => {
        if (!signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [user, context, version]);

  useEffect(() => {
    const account = unlockedAccount();
    function abort() {
      if (!operation.current) return;
      operation.current.abort();
      operation.current = null;
      setBusy(false);
      onBusyChange?.(false);
    }
    const stopSession = listenCryptoSession(() => {
      if (unlockedAccount() !== account) abort();
    });
    const stopAuth = client.listenAuthState(abort);
    return () => {
      stopSession();
      stopAuth();
      abort();
    };
  }, [user, onBusyChange]);

  const changed =
    state &&
    fields.some(
      ({ namespace }) => state.draft[namespace] !== state.saved[namespace],
    );
  async function save() {
    if (
      !state ||
      !changed ||
      busy ||
      disabled ||
      operation.current ||
      context.aborted
    )
      return;
    const changes: Partial<CreationAccesses> = {};
    for (const { namespace } of fields) {
      if (state.draft[namespace] !== state.saved[namespace])
        changes[namespace] = state.draft[namespace];
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(false);
    onBusyChange?.(true);
    try {
      await changeCreationAccesses(client, user, changes, controller.signal);
      controller.signal.throwIfAborted();
      setVersion((value) => value + 1);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }

  return (
    <section className="space-y-4 border-t border-border pt-5">
      <h3 className="text-lg font-semibold">
        {uiText("Anlageberechtigungen", "Creation permissions")}
      </h3>
      {error && (
        <MyCallout color="red">
          {uiText(
            "Die Anlageberechtigungen konnten nicht aktualisiert werden.",
            "Creation permissions could not be updated.",
          )}
        </MyCallout>
      )}
      <div className="flex flex-wrap items-center gap-4">
        {fields.map(({ namespace, label }) => (
          <Checkbox
            key={namespace}
            labelText={label()}
            checked={state?.draft[namespace] ?? false}
            disabled={busy || disabled || !state}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              if (operation.current || context.aborted) return;
              const checked = event.target.checked;
              setState(
                (current) =>
                  current && {
                    ...current,
                    draft: { ...current.draft, [namespace]: checked },
                  },
              );
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <MyButton
          kind="tertiary"
          loading={busy || (!state && !error)}
          disabled={!state || !changed || busy || disabled}
          onClick={() => void save()}
        >
          {uiText(
            "Anlageberechtigungen speichern",
            "Save creation permissions",
          )}
        </MyButton>
        {error && (
          <MyButton
            kind="tertiary"
            disabled={busy || disabled}
            onClick={() => setVersion((value) => value + 1)}
          >
            {uiText("Erneut laden", "Reload")}
          </MyButton>
        )}
      </div>
    </section>
  );
}
