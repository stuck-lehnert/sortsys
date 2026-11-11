import { useState } from "react";
import { Link } from "react-router";
import { Loading } from "@sortsys/react-components";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { commitTenantSetup, prepareTenantSetup } from "~/lib/crypto/setup";
import type { SetupDraft } from "~/lib/crypto/setup";
import { unlockedAccount } from "~/lib/crypto/session";
import { uiText } from "~/lib/i18n";
import { MyForm } from "./MyForm";
import { MyCallout } from "./MyCallout";
import { MyButton } from "./MyButton";
import { RecoveryPhraseBackup } from "./RecoveryPhraseBackup";
import OrganizationInvitations from "./OrganizationInvitations";

export default function OrganizationEncryption() {
  const session = useSessionInfo();
  const [status, error] = useClientStream(() => client.streamQuery("zerotrust.status", undefined, { strategy: "network-first" }), []);
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  if (error) return <MyCallout color="red">{uiText("Die Kontoeinstellungen konnten nicht geladen werden.", "Account settings could not be loaded.")}</MyCallout>;
  if (!status) return <Loading active description={uiText("Kontoeinstellungen werden geladen …", "Loading account settings…")} />;
  if (draft) return <RecoveryPhraseBackup phrase={draft.phrase} onCancel={() => setDraft(null)} onConfirmed={async () => {
    await commitTenantSetup(client, draft, session.user.username);
    setDraft(null);
    await client.invalidate("zerotrust.status");
  }} />;
  return <div className="max-w-3xl space-y-5">
    <h2 className="text-xl font-semibold">{uiText("Wiederherstellung", "Recovery")}</h2>
    {status.phase === "unenrolled" ? <>
      <p>{uiText("Die Wiederherstellungsphrase sichert den Notfallzugang zur Organisation. Sie bleibt beim Unternehmen; sortsys speichert keine Kopie davon.", "The recovery phrase provides emergency access to the organization. The company keeps it; sortsys does not store a copy.")}</p>
      <p>{uiText("Die anschließende Vorbereitung des Arbeitsbereichs erfolgt automatisch.","The workspace is then prepared automatically.")}</p>
      {unlockedAccount() ? <MyButton onClick={async () => {
        setDraft(await prepareTenantSetup(status.tenant, `user:${session.user.id}`, session.user.username));
      }}>{uiText("Wiederherstellung einrichten", "Set up recovery")}</MyButton> : <MyForm onSubmit={async context => {
        const values = context.getValues();
        const password: string = values.password;
        await client.login({tenant:status.tenant,username:session.user.username,password});
        setDraft(await prepareTenantSetup(status.tenant, `user:${session.user.id}`, session.user.username));
      }}>
        <MyForm.Input name="password" labelText={uiText("Anmeldepasswort bestätigen", "Confirm sign-in password")} type="password" autoComplete="current-password" required rules={[MyForm.Input.rules.max(2000)]} />
        <MyForm.SubmitButton>{uiText("Weiter", "Continue")}</MyForm.SubmitButton>
      </MyForm>}
    </> : <>
      <p>{status.phase === "active"
        ? uiText("Der Notfallzugang ist eingerichtet. Die normale Anmeldung funktioniert wie gewohnt.", "Emergency access is configured. Normal sign-in works as usual.")
        : uiText("Der Notfallzugang ist eingerichtet. Der Arbeitsbereich wird noch vorbereitet.", "Emergency access is configured. The workspace is still being prepared.")}</p>
      <Link to="/auth/recovery">{uiText("Organisation mit Wiederherstellungsphrase wiederherstellen", "Recover organization using the recovery phrase")}</Link>
      <OrganizationInvitations />
    </>}
  </div>;
}
