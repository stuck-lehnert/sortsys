import { useEffect, useId, useRef, useState } from "react";
import { useNotifications } from "@sortsys/react-components";
import { client } from "~/lib/client";
import {
  completeSigningRenewal,
  createSigningRequest,
  reviewSigningRequest,
} from "~/lib/crypto/signingRenewal";
import { uiText } from "~/lib/i18n";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { MyForm } from "./MyForm";

function TransferCode({ label, value }: { label: string; value: string }) {
  const id = useId();
  const notifications = useNotifications();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        className="block w-full resize-y border border-border bg-surface p-2 font-mono text-sm"
        id={id}
        value={value}
        readOnly
        rows={3}
      />
      <MyButton
        type="button"
        kind="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            notifications.success({
              title: uiText("Code kopiert", "Code copied"),
            });
          } catch {
            notifications.danger({
              title: uiText(
                "Bitte den Code im Textfeld markieren und kopieren.",
                "Select the code in the text field and copy it.",
              ),
            });
          }
        }}
      >
        {uiText("Kopieren", "Copy")}
      </MyButton>
    </div>
  );
}

function usePanelSignal() {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    return () => {
      active.abort();
      controller.current = null;
    };
  }, []);
  return controller;
}

export function PersonalSigningRenewal() {
  const controller = usePanelSignal();
  const [request, setRequest] = useState("");
  const [creating, setCreating] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const notifications = useNotifications();

  async function requestRenewal() {
    const signal = controller.current?.signal;
    if (!signal || creating) return;
    setCreating(true);
    setRequestFailed(false);
    try {
      const code = await createSigningRequest(client, signal);
      if (!signal.aborted) setRequest(code);
    } catch {
      if (!signal.aborted) setRequestFailed(true);
    } finally {
      if (!signal.aborted) setCreating(false);
    }
  }

  return (
    <details className="space-y-4 rounded-md border border-border p-4">
      <summary className="cursor-pointer font-semibold">
        {uiText("Signaturschlüssel erneuern", "Renew signing key")}
      </summary>
      <p className="text-sm">
        {uiText(
          "Geben Sie den Anfragecode an die Organisationsverwaltung weiter. Lösen Sie anschließend die Bestätigung mit einem neuen Passwort ein.",
          "Give the request code to your organization administrator. Then apply their approval with a new password.",
        )}
      </p>
      <MyButton
        type="button"
        kind="secondary"
        loading={creating}
        onClick={requestRenewal}
      >
        {uiText("Anfrage erstellen", "Create request")}
      </MyButton>
      {requestFailed && (
        <MyCallout color="red">
          {uiText(
            "Die Anfrage konnte nicht erstellt werden.",
            "The request could not be created.",
          )}
        </MyCallout>
      )}
      {request && (
        <TransferCode
          label={uiText("Anfragecode", "Request code")}
          value={request}
        />
      )}
      <MyForm
        className="max-w-2xl space-y-4"
        onSubmit={async (context) => {
          const signal = controller.current?.signal;
          if (!signal) return;
          const values = context.getValues();
          const password = String(values.renewalPassword ?? "");
          if (password !== String(values.renewalConfirmation ?? ""))
            throw new Error(uiText("Passwörter stimmen nicht überein."));
          try {
            await completeSigningRenewal(
              client,
              String(values.approvalCode ?? ""),
              password,
              signal,
            );
          } catch {
            throw new Error(
              uiText(
                "Der Schlüssel konnte nicht erneuert werden. Prüfen Sie die Bestätigung und das Passwort.",
                "The key could not be renewed. Check the approval and your password.",
              ),
            );
          }
          context.setValues({
            approvalCode: "",
            renewalPassword: "",
            renewalConfirmation: "",
          });
          setRequest("");
          notifications.success({
            title: uiText("Signaturschlüssel erneuert", "Signing key renewed"),
          });
        }}
      >
        <MyForm.Input
          required
          textArea
          name="approvalCode"
          labelText={uiText("Bestätigungscode", "Approval code")}
          rows={3}
          maxLength={4096}
        />
        <MyForm.Input
          required
          name="renewalPassword"
          labelText={uiText("Neues Passwort")}
          type="password"
          autoComplete="new-password"
          rules={[MyForm.Input.rules.min(10)]}
        />
        <MyForm.Input
          required
          name="renewalConfirmation"
          labelText={uiText(
            "Neues Passwort bestätigen",
            "Confirm new password",
          )}
          type="password"
          autoComplete="new-password"
          rules={[MyForm.Input.rules.min(10)]}
        />
        <p className="text-sm">
          {uiText(
            "Dabei werden andere Sitzungen und bisherige Passkeys gesperrt. Frühere Unterschriften bleiben prüfbar. Für delegierte Verwaltungsrechte können neue Nachweise nötig sein.",
            "This revokes other sessions and existing passkeys. Earlier signatures remain verifiable. Delegated administration rights may need new proofs.",
          )}
        </p>
        <MyForm.SubmitButton>
          {uiText("Schlüssel erneuern", "Renew key")}
        </MyForm.SubmitButton>
      </MyForm>
    </details>
  );
}

export function SigningRequestApproval() {
  const controller = usePanelSignal();
  type Review = Awaited<ReturnType<typeof reviewSigningRequest>>;
  const [review, setReview] = useState<Review | null>(null);
  const [approval, setApproval] = useState("");
  const [approving, setApproving] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <details className="space-y-4 rounded-md border border-border p-4">
      <summary className="cursor-pointer font-semibold">
        {uiText("Signaturwechsel bestätigen", "Approve signing key change")}
      </summary>
      <MyForm
        className="max-w-2xl space-y-4"
        onSubmit={async (context) => {
          const signal = controller.current?.signal;
          if (!signal || approving) return;
          setReview(null);
          setApproval("");
          setFailed(false);
          try {
            const code = String(context.getValues().requestCode ?? "");
            const checked = await reviewSigningRequest(client, code, signal);
            if (
              !signal.aborted &&
              String(context.getValues().requestCode ?? "") === code
            )
              setReview(checked);
          } catch {
            if (!signal.aborted) setFailed(true);
          }
        }}
      >
        <MyForm.Input
          required
          textArea
          name="requestCode"
          labelText={uiText("Anfragecode", "Request code")}
          rows={3}
          maxLength={4096}
          disabled={approving}
          onValueChange={() => {
            setReview(null);
            setApproval("");
            setFailed(false);
          }}
        />
        <MyForm.SubmitButton>
          {uiText("Anfrage prüfen", "Review request")}
        </MyForm.SubmitButton>
      </MyForm>
      {failed && (
        <MyCallout color="red">
          {uiText(
            "Die Anfrage ist ungültig oder nicht mehr aktuell.",
            "The request is invalid or out of date.",
          )}
        </MyCallout>
      )}
      {review && !approval && (
        <div className="space-y-2">
          <p>
            {uiText(
              "Bitte mit der betreffenden Person abgleichen, bevor Sie den Wechsel für dieses Konto bestätigen.",
              "Check with the person before approving the change for this account.",
            )}{" "}
            <strong>{review.username}</strong>
          </p>
          <MyButton
            type="button"
            loading={approving}
            onClick={async () => {
              const signal = controller.current?.signal;
              if (!signal || approving) return;
              setApproving(true);
              setFailed(false);
              try {
                const code = await review.approve();
                if (!signal.aborted) setApproval(code);
              } catch {
                if (!signal.aborted) {
                  setFailed(true);
                  setReview(null);
                }
              } finally {
                if (!signal.aborted) setApproving(false);
              }
            }}
          >
            {uiText("Wechsel bestätigen", "Approve change")}
          </MyButton>
        </div>
      )}
      {approval && (
        <TransferCode
          label={uiText("Bestätigungscode", "Approval code")}
          value={approval}
        />
      )}
    </details>
  );
}
