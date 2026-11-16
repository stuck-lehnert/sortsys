import { useEffect, useRef, useState } from "react";
import { Loading } from "@sortsys/react-components";
import { client } from "~/lib/client";
import {
  accessChanged,
  accessDraft,
  editAccessDraft,
} from "~/lib/crypto/accessProfiles";
import {
  changeAreaActionAccesses,
  memberAreaAccesses,
} from "~/lib/crypto/permissions";
import { COMMON_COST_COLLECTION } from "~/lib/data/commonCostData";
import { invoiceNumberAccessChanges } from "~/lib/crypto/invoiceAccess";
import {
  CLIENT_SCRIPT_COLLECTION,
  INVOICE_LEDGER_COLLECTION,
} from "~/lib/data/organizationData";
import { uiText } from "~/lib/i18n";
import { AccessLevelSelect } from "./AccessLevelSelect";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

type OrganizationAccessProps = {
  user: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

export function OrganizationAccess(props: OrganizationAccessProps) {
  return (
    <>
      <OrganizationAreaAccess {...props} kind="overhead" />
      <OrganizationAreaAccess {...props} kind="numbering" />
      <OrganizationAreaAccess {...props} kind="scripts" />
    </>
  );
}

function OrganizationAreaAccess({
  user,
  disabled = false,
  onBusyChange,
  kind,
}: OrganizationAccessProps & { kind: "overhead" | "numbering" | "scripts" }) {
  const settings = {
    overhead: {
      area: COMMON_COST_COLLECTION,
      title: uiText("Gemeinkostenfreigabe", "Overhead access"),
      label: uiText(
        "Gemeinkostensätze und Historie",
        "Overhead rates and history",
      ),
      error: uiText(
        "Die Gemeinkostenfreigabe konnte nicht aktualisiert werden.",
        "Overhead access could not be updated.",
      ),
      save: uiText("Gemeinkostenfreigabe speichern", "Save overhead access"),
    },
    numbering: {
      area: INVOICE_LEDGER_COLLECTION,
      title: uiText("Rechnungsnummernfreigabe", "Invoice numbering access"),
      label: uiText(
        "Mandantenweite Rechnungsnummern",
        "Organization-wide invoice numbering",
      ),
      error: uiText(
        "Die Rechnungsnummernfreigabe konnte nicht aktualisiert werden.",
        "Invoice numbering access could not be updated.",
      ),
      save: uiText(
        "Rechnungsnummernfreigabe speichern",
        "Save invoice numbering access",
      ),
    },
    scripts: {
      area: CLIENT_SCRIPT_COLLECTION,
      title: uiText("Skriptfreigabe", "Script access"),
      label: uiText("Client-Skripte", "Client scripts"),
      error: uiText(
        "Die Skriptfreigabe konnte nicht aktualisiert werden.",
        "Script access could not be updated.",
      ),
      save: uiText("Skriptfreigabe speichern", "Save script access"),
    },
  }[kind];
  const { area } = settings;
  const [draft, setDraft] = useState(() => accessDraft("none"));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const operation = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      operation.current?.abort();
      if (operation.current) onBusyChange?.(false);
      operation.current = null;
    },
    [user, onBusyChange],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError(false);
    void memberAreaAccesses(client, user, [area], controller.signal)
      .then(([value]) => {
        if (controller.signal.aborted) return;
        setDraft(accessDraft(value!));
        setLoaded(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [user, version, area]);

  async function save() {
    if (!loaded || busy || disabled || !accessChanged(draft)) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(false);
    onBusyChange?.(true);
    try {
      const changes =
        kind === "numbering"
          ? invoiceNumberAccessChanges(draft)
          : [{ area, patch: draft.patch }];
      await changeAreaActionAccesses(client, user, changes, controller.signal);
      controller.signal.throwIfAborted();
      setVersion((previous) => previous + 1);
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
      <h3 className="text-lg font-semibold">{settings.title}</h3>
      {error && (
        <MyCallout color="red">
          {settings.error}
          <MyButton
            kind="tertiary"
            disabled={busy || disabled}
            onClick={() => setVersion((previous) => previous + 1)}
          >
            {uiText("Erneut versuchen", "Try again")}
          </MyButton>
        </MyCallout>
      )}
      {!loaded && !error && (
        <Loading
          active
          description={uiText("Freigabe wird geladen …", "Loading access…")}
        />
      )}
      {loaded && (
        <AccessLevelSelect
          label={settings.label}
          allowManagement
          value={draft.value}
          disabled={busy || disabled}
          onChange={(value, actions) =>
            setDraft((previous) => editAccessDraft(previous, value, actions))
          }
        />
      )}
      <MyButton
        disabled={!loaded || busy || disabled || !accessChanged(draft)}
        loading={busy}
        onClick={() => void save()}
      >
        {settings.save}
      </MyButton>
    </section>
  );
}
