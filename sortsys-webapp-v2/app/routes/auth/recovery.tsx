import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { RecoveryPlan } from "@sortsys/zerotrust";
import { AuthLayout } from "~/components/AuthLayout";
import { MyForm } from "~/components/MyForm";
import { MyButton } from "~/components/MyButton";
import { RecoveryPhraseBackup } from "~/components/RecoveryPhraseBackup";
import { client } from "~/lib/client";
import { commitRecovery, recoveryDraft, recoveryPlan, RecoveryNotStarted } from "~/lib/crypto/recovery";
import type { RecoveryDraft } from "~/lib/crypto/recovery";
import { lockCryptoSession } from "~/lib/crypto/session";
import { uiText } from "~/lib/i18n";

export function meta() { return [{ title: uiText("Mandant wiederherstellen", "Recover tenant") }]; }

export default function RecoveryPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<RecoveryDraft | null>(null);
  const [prepared, setPrepared] = useState<RecoveryPlan | null>(null);
  const [completed, setCompleted] = useState<{ tenant: string; username: string } | null>(null);
  if (completed) return <AuthLayout title={uiText("Mandant wiederhergestellt", "Tenant recovered")}>
    <p>{uiText("Die bisherige Phrase und alle bisherigen Sitzungen sind jetzt ungültig. Für die nächste Wiederherstellung gilt ausschließlich die neu gesicherte Phrase.", "The previous phrase and all previous sessions are now invalid. Only the newly backed-up phrase can authorize the next recovery.")}</p>
    <p>{uiText("Neues Administratorkonto", "New administrator account")}: <strong className="select-all">{completed.username}@{completed.tenant}</strong></p>
    <MyButton onClick={() => navigate("/auth/login")}>{uiText("Mit neuem Konto anmelden", "Sign in with new account")}</MyButton>
  </AuthLayout>;
  if (draft) return <AuthLayout wide title={uiText("Neue Wiederherstellungsphrase sichern", "Back up new recovery phrase")}>
    <RecoveryPhraseBackup phrase={draft.newPhrase} onCancel={() => { setDraft(null); setPrepared(null); }} onConfirmed={async () => {
      try {
        const plan = prepared ?? await recoveryPlan(client, draft);
        setPrepared(plan);
        await commitRecovery(client, plan);
        await lockCryptoSession(true);
        client.setToken(null);
        setCompleted({ tenant: draft.tenant, username: plan.username });
        setDraft(null); setPrepared(null);
      } catch (error) {
        if (error instanceof RecoveryNotStarted) setPrepared(null);
        throw new Error(uiText("Die Wiederherstellung konnte nicht abgeschlossen werden. Ein erneuter Versuch setzt denselben Vorgang fort. Die neue Phrase weiterhin sicher aufbewahren.", "Recovery could not be completed. Retrying continues the same operation. Keep the new phrase securely backed up."));
      }
    }} />
  </AuthLayout>;
  return <AuthLayout title={uiText("Mandant wiederherstellen", "Recover tenant")}>
    <p>{uiText("Die aktuelle Wiederherstellungsphrase ersetzt die bisherigen Zugangsschlüssel. Danach gelten ein neues Administratorkonto und eine neue Phrase. Der Betreiber erhält keinen Schlüssel.", "The current recovery phrase replaces the existing access keys. A new administrator account and a new phrase then apply. The provider receives no key.")}</p>
    <MyForm onSubmit={async context => {
      const values = context.getValues();
      if (values.password !== values.repeat) throw new Error(uiText("Die Passwörter stimmen nicht überein.", "The passwords do not match."));
      try { setDraft(await recoveryDraft(client, String(values.tenant).trim().toLowerCase(), values.phrase, values.password)); }
      catch { throw new Error(uiText("Mandant oder Wiederherstellungsphrase stimmen nicht überein. Nach einer bereits begonnenen Wiederherstellung die neue Phrase verwenden.", "Tenant or recovery phrase do not match. If recovery has already started, use the new phrase.")); }
    }}>
      <MyForm.Input name="tenant" labelText={uiText("Mandant", "Tenant")} autoComplete="organization" required />
      <MyForm.Input name="phrase" labelText={uiText("Aktuelle Wiederherstellungsphrase", "Current recovery phrase")} textArea autoComplete="off" spellCheck={false} required />
      <MyForm.Input name="password" labelText={uiText("Passwort für das neue Administratorkonto", "Password for the new administrator account")} type="password" autoComplete="new-password" required rules={[MyForm.Input.rules.min(12), MyForm.Input.rules.max(2000)]} />
      <MyForm.Input name="repeat" labelText={uiText("Passwort wiederholen", "Repeat password")} type="password" autoComplete="new-password" required />
      <MyForm.SubmitButton>{uiText("Phrase prüfen und Wiederherstellung vorbereiten", "Verify phrase and prepare recovery")}</MyForm.SubmitButton>
    </MyForm>
    <Link to="/auth/login">{uiText("Zur Anmeldung", "Back to sign-in")}</Link>
  </AuthLayout>;
}
