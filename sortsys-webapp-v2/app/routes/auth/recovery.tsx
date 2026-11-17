import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { RecoveryPlan } from "@sortsys/zerotrust/sortsys";
import { AuthLayout } from "~/components/AuthLayout";
import { MyForm } from "~/components/MyForm";
import { MyButton } from "~/components/MyButton";
import { RecoveryPhraseBackup } from "~/components/RecoveryPhraseBackup";
import { client } from "~/lib/client";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
  RecoveryNotStarted,
  RecoveryAccountUnavailable,
  RecoveryMemberUnavailable,
} from "~/lib/crypto/recovery";
import type { RecoveryDraft } from "~/lib/crypto/recovery";
import { lockCryptoSession } from "~/lib/crypto/session";
import { uiText } from "~/lib/i18n";

export function meta() {
  return [{ title: uiText("Mandant wiederherstellen", "Recover tenant") }];
}

export default function RecoveryPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<RecoveryDraft | null>(null);
  const [prepared, setPrepared] = useState<RecoveryPlan | null>(null);
  const [restoreMember, setRestoreMember] = useState(false);
  const [completed, setCompleted] = useState<{
    tenant: string;
    username: string;
    restored: boolean;
    member?: string;
  } | null>(null);
  if (completed)
    return (
      <AuthLayout
        title={uiText("Mandant wiederhergestellt", "Tenant recovered")}
      >
        <p>
          {uiText(
            "Die bisherige Phrase und alle bisherigen Sitzungen sind jetzt ungültig. Für die nächste Wiederherstellung gilt ausschließlich die neu gesicherte Phrase.",
            "The previous phrase and all previous sessions are now invalid. Only the newly backed-up phrase can authorize the next recovery.",
          )}
        </p>
        <p>
          {completed.restored
            ? uiText(
                "Wiederhergestelltes Administratorkonto",
                "Restored administrator account",
              )
            : uiText("Neues Administratorkonto", "New administrator account")}
          :{" "}
          <strong className="select-all">
            {completed.username}@{completed.tenant}
          </strong>
        </p>
        {completed.member && (
          <p>
            {uiText(
              `Das Konto „${completed.member}“ hat ein neues Passwort erhalten. Seine fachlichen Freigaben müssen durch die Administration erneut bestätigt werden.`,
              `Account “${completed.member}” has received a new password. Its business access must be approved again by the administrator.`,
            )}
          </p>
        )}
        <MyButton onClick={() => navigate("/auth/login")}>
          {uiText("Anmelden", "Sign in")}
        </MyButton>
      </AuthLayout>
    );
  if (draft)
    return (
      <AuthLayout
        wide
        title={uiText(
          "Neue Wiederherstellungsphrase sichern",
          "Back up new recovery phrase",
        )}
      >
        <RecoveryPhraseBackup
          phrase={draft.newPhrase}
          onCancel={() => {
            setDraft(null);
            setPrepared(null);
          }}
          onConfirmed={async () => {
            try {
              const plan = prepared ?? (await recoveryPlan(client, draft));
              setPrepared(plan);
              await commitRecovery(client, plan);
              await lockCryptoSession(true);
              client.setToken(null);
              setCompleted({
                tenant: draft.tenant,
                username: plan.username,
                restored: plan.accountVersion !== undefined,
                ...(draft.member
                  ? { member: draft.member.account.username }
                  : {}),
              });
              setDraft(null);
              setPrepared(null);
            } catch (error) {
              if (error instanceof RecoveryNotStarted) setPrepared(null);
              throw new Error(
                uiText(
                  "Die Wiederherstellung konnte nicht abgeschlossen werden. Ein erneuter Versuch setzt denselben Vorgang fort. Die neue Phrase weiterhin sicher aufbewahren.",
                  "Recovery could not be completed. Retrying continues the same operation. Keep the new phrase securely backed up.",
                ),
              );
            }
          }}
        />
      </AuthLayout>
    );
  return (
    <AuthLayout title={uiText("Mandant wiederherstellen", "Recover tenant")}>
      <p>
        {uiText(
          "Die aktuelle Wiederherstellungsphrase ersetzt die bisherigen Zugangsschlüssel und legt ein neues Passwort für die Administration fest. Anschließend gilt eine neue Phrase. Der Betreiber erhält keinen Schlüssel.",
          "The current recovery phrase replaces the existing access keys and sets a new administrator password. A new phrase then applies. The provider receives no key.",
        )}
      </p>
      <MyForm
        notifyLoaded={(context) => {
          context.setValues({ restoreAdministrator: true, restoreMember });
        }}
        onSubmit={async (context) => {
          const values = context.getValues();
          if (values.password !== values.repeat)
            throw new Error(
              uiText(
                "Die Passwörter stimmen nicht überein.",
                "The passwords do not match.",
              ),
            );
          if (restoreMember && values.memberPassword !== values.memberRepeat)
            throw new Error(
              uiText(
                "Die Mitarbeiterpasswörter stimmen nicht überein.",
                "The member passwords do not match.",
              ),
            );
          try {
            setDraft(
              await recoveryDraft(
                client,
                String(values.tenant).trim().toLowerCase(),
                values.phrase,
                values.password,
                {
                  restoreAdministrator: values.restoreAdministrator === true,
                  ...(restoreMember
                    ? {
                        member: {
                          username: String(values.memberUsername ?? ""),
                          password: String(values.memberPassword ?? ""),
                        },
                      }
                    : {}),
                },
              ),
            );
          } catch (error) {
            if (error instanceof RecoveryMemberUnavailable)
              throw new Error(
                uiText(
                  "Das Mitarbeiterkonto wurde nicht gefunden oder ist gesperrt. Das primäre Administratorkonto wird über die eigene Auswahl wiederhergestellt.",
                  "The member account was not found or is disabled. The primary administrator is restored using its separate option.",
                ),
              );
            if (error instanceof RecoveryAccountUnavailable)
              throw new Error(
                uiText(
                  "Das bisherige Administratorkonto kann nicht wiederhergestellt werden. Ohne die Auswahl „Vorhandenes Administratorkonto wiederherstellen“ wird ein neues Konto angelegt.",
                  "The previous administrator account cannot be restored. Clear “Restore existing administrator account” to create a new account.",
                ),
              );
            throw new Error(
              uiText(
                "Mandant oder Wiederherstellungsphrase stimmen nicht überein. Nach einer bereits begonnenen Wiederherstellung die neue Phrase verwenden.",
                "Tenant or recovery phrase do not match. If recovery has already started, use the new phrase.",
              ),
            );
          }
        }}
      >
        <MyForm.Input
          name="tenant"
          labelText={uiText("Mandant", "Tenant")}
          autoComplete="organization"
          required
        />
        <MyForm.Input
          name="phrase"
          labelText={uiText(
            "Aktuelle Wiederherstellungsphrase",
            "Current recovery phrase",
          )}
          textArea
          autoComplete="off"
          spellCheck={false}
          required
        />
        <MyForm.Input
          name="password"
          labelText={uiText(
            "Neues Administratorpasswort",
            "New administrator password",
          )}
          type="password"
          autoComplete="new-password"
          required
          rules={[MyForm.Input.rules.min(12), MyForm.Input.rules.max(2000)]}
        />
        <MyForm.Input
          name="repeat"
          labelText={uiText("Passwort wiederholen", "Repeat password")}
          type="password"
          autoComplete="new-password"
          required
        />
        <MyForm.Checkbox
          name="restoreAdministrator"
          labelText={uiText(
            "Vorhandenes Administratorkonto wiederherstellen",
            "Restore existing administrator account",
          )}
        />
        <MyForm.Checkbox
          name="restoreMember"
          labelText={uiText(
            "Zusätzlich ein Mitarbeiterkonto wiederherstellen",
            "Also recover a member account",
          )}
          onValueChange={setRestoreMember}
        />
        {restoreMember && (
          <>
            <p>
              {uiText(
                "Die Wiederherstellung wechselt die Phrase und beendet sämtliche bisherigen Sitzungen des Mandanten. Das Mitarbeiterkonto behält seine Benutzerkennung, erhält aber erst nach erneuter Freigabe Zugang zu Fachdaten.",
                "Recovery changes the phrase and ends every existing tenant session. The member retains its user ID but receives business access only after a new approval.",
              )}
            </p>
            <MyForm.Input
              name="memberUsername"
              required
              autoComplete="off"
              labelText={uiText(
                "Anmeldename des Mitarbeiterkontos",
                "Member account username",
              )}
            />
            <MyForm.Input
              name="memberPassword"
              required
              type="password"
              autoComplete="new-password"
              labelText={uiText(
                "Neues Mitarbeiterpasswort",
                "New member password",
              )}
              rules={[MyForm.Input.rules.min(12), MyForm.Input.rules.max(2000)]}
            />
            <MyForm.Input
              name="memberRepeat"
              required
              type="password"
              autoComplete="new-password"
              labelText={uiText(
                "Mitarbeiterpasswort wiederholen",
                "Repeat member password",
              )}
            />
          </>
        )}
        <MyForm.SubmitButton>
          {uiText(
            "Phrase prüfen und Wiederherstellung vorbereiten",
            "Verify phrase and prepare recovery",
          )}
        </MyForm.SubmitButton>
      </MyForm>
      <Link to="/auth/login">{uiText("Zur Anmeldung", "Back to sign-in")}</Link>
    </AuthLayout>
  );
}
