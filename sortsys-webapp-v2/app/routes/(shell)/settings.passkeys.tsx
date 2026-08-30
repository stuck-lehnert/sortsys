import { uiText } from "~/lib/i18n";
import { Tile } from "@sortsys/react-components";
import { useState } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { createPasskeyCredential, isPasskeySupported } from "~/lib/passkeys";
import type { Route } from "./+types/settings.passkeys";

type Passkey = {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export function meta({}: Route.MetaArgs) {
  return [{ title: uiText("Passkeys | Einstellungen") }];
}

export default function PasskeySettingsPage() {
  const modals = useMyModals();
  const [reloadCounter, setReloadCounter] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [passkeys, passkeysErr] = useClientStream<Passkey[] | null, any>(() => {
    return client.streamQuery("auth.passkeys.list", undefined, {
      strategy: "network-first",
    });
  }, [reloadCounter]);

  const passkeySupported = isPasskeySupported();

  function showAddPasskeyModal() {
    setError(null);
    setMessage(null);

    modals.showForm({
      content: ({ context }) => (
        <>
          <MyForm.Input
            required
            autoFocus
            name="label"
            labelText={uiText("Name")}
          />
          <NotifyLoaded onLoad={() => context.setValues({ label: uiText("Passkey") })} />
        </>
      ),
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Passkey hinzufügen"),
        primaryButtonText: uiText("Hinzufügen"),
      }),
      onSubmit: async ({ context, hide }) => {
        const label = `${context.getValues().label ?? ""}`.trim();

        try {
          const [begin, beginErr] = await client.mutate(
            "auth.passkeys.registerOptions",
            undefined,
          );
          if (beginErr) throw beginErr;
          if (!begin) {
            throw new Error(uiText("Passkey-Registrierung konnte nicht gestartet werden."));
          }

          const credential = await createPasskeyCredential(begin.options);
          const [, finishErr] = await client.mutate("auth.passkeys.register", {
            challengeToken: begin.challengeToken,
            label,
            credential,
          });
          if (finishErr) throw finishErr;
        } catch (err) {
          setError((err as Error)?.message || uiText("Passkey konnte nicht gespeichert werden."));
          hide();
          return;
        }

        setReloadCounter(value => value + 1);
        setMessage(uiText("Passkey gespeichert."));
        hide();
      },
    });
  }

  function showDeletePasskeyModal(passkey: Passkey) {
    setError(null);
    setMessage(null);

    modals.showDefault({
      content: () => (
        <p>{uiText(`Passkey „${passkey.label}“ wirklich entfernen?`, `Remove passkey “${passkey.label}”?`)}</p>
      ),
      modalProps: () => ({
        danger: true,
        noFullscreen: true,
        modalHeading: uiText("Passkey entfernen"),
        primaryButtonText: uiText("Entfernen"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const [, err] = await client.mutate("auth.passkeys.delete", {
          id: passkey.id,
        });
        if (err) {
          setError(err.message || uiText("Passkey konnte nicht entfernt werden."));
          hide();
          return;
        }

        setReloadCounter(value => value + 1);
        setMessage("Passkey entfernt.");
        hide();
      },
    });
  }

  return (
    <Tile className="settings-section">
      <div className="settings-section-actions">
        <MyButton
          renderIcon={Icons.Plus}
          disabled={!passkeySupported}
          onClick={showAddPasskeyModal}
        >{uiText("Hinzufügen")}</MyButton>
      </div>

      {!passkeySupported && (
        <MyCallout icon={Icons.Deny} color="red">{uiText("Passkeys werden von diesem Browser nicht unterstützt.")}</MyCallout>
      )}
      {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}
      {!!passkeysErr && (
        <MyCallout icon={Icons.Deny} color="red">{uiText("Passkeys konnten nicht geladen werden.")}</MyCallout>
      )}
      {!!message && (
        <AutoHideSuccessCallout resetKey={message} onHidden={() => setMessage(null)}>
          {message}
        </AutoHideSuccessCallout>
      )}

      <div className="settings-passkey-list">
        {(passkeys ?? []).map(passkey => (
          <div key={passkey.id} className="settings-passkey-row">
            <div className="settings-passkey-details">
              <strong>{passkey.label}</strong>
              <span className="light text-sm">{uiText(`Erstellt am ${formatDate(passkey.createdAt, "long")}`, `Created on ${formatDate(passkey.createdAt, "long")}`)}
                {passkey.lastUsedAt ? uiText(
                  ` · Zuletzt genutzt ${formatDate(passkey.lastUsedAt, "long")}`,
                  ` · Last used ${formatDate(passkey.lastUsedAt, "long")}`,
                ) : ""}
              </span>
            </div>

            <MyButton
              kind="danger--tertiary"
              size="sm"
              renderIcon={Icons.Delete}
              onClick={() => showDeletePasskeyModal(passkey)}
            >{uiText("Entfernen")}</MyButton>
          </div>
        ))}

        {passkeys && passkeys.length === 0 && (
          <p className="settings-empty">{uiText("Keine Passkeys vorhanden.")}</p>
        )}
      </div>
    </Tile>
  );
}
