import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { AuthLayout } from "~/components/AuthLayout";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyButton } from "~/components/MyButton";
import { RecoveryPhraseBackup } from "~/components/RecoveryPhraseBackup";
import { BackupPicker } from "~/components/BackupPicker";
import {
  rememberPendingBackup,
  validateBackupSelection,
  type BackupSelection,
} from "~/lib/backups/selection";
import { base64, randomSecret } from "@sortsys/zerotrust/sortsys";
import { client } from "~/lib/client";
import {
  commitOwner,
  prepareOwner,
  readTenantSetupLink,
} from "~/lib/crypto/tenantSetup";
import type { OwnerDraft } from "~/lib/crypto/tenantSetup";
import { uiText } from "~/lib/i18n";

export function meta() {
  return [{ title: uiText("Organisation einrichten", "Set up organization") }];
}

export default function OrganizationSetupPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<OwnerDraft | null>(null);
  const [backup, setBackup] = useState<BackupSelection | null | undefined>(
    null,
  );
  let link;
  try {
    link = readTenantSetupLink(location.hash);
  } catch {
    link = null;
  }
  if (!link)
    return (
      <AuthLayout
        title={uiText("Organisation einrichten", "Set up organization")}
      >
        <MyCallout color="red">
          {uiText(
            "Der Einrichtungslink ist unvollständig. Bitte den ursprünglichen Link erneut öffnen.",
            "The setup link is incomplete. Please reopen the original link.",
          )}
        </MyCallout>
        <Link to="/auth/login">{uiText("Zur Anmeldung", "Go to sign-in")}</Link>
      </AuthLayout>
    );
  if (draft)
    return (
      <AuthLayout
        wide
        title={uiText("Notfallzugang sichern", "Back up emergency access")}
      >
        <RecoveryPhraseBackup
          phrase={draft.phrase}
          onCancel={() => setDraft(null)}
          onConfirmed={async () => {
            await commitOwner(client, draft);
            if (backup && draft.setup.authority.context) {
              rememberPendingBackup(draft.setup.authority.context, backup);
            }
            setDraft(null);
            navigate("/dashboard", { replace: true });
          }}
        />
      </AuthLayout>
    );
  const setupLink = link;
  return (
    <AuthLayout
      title={uiText("Organisation einrichten", "Set up organization")}
    >
      <p>{setupLink.tenant}</p>
      <BackupPicker onChange={setBackup} />
      <MyForm
        key={backup?.ownerId ?? "new"}
        onSubmit={async (context) => {
          const values = context.getValues();
          if (backup === undefined)
            throw new Error(
              uiText(
                "Die Sicherung muss zuerst vollständig geprüft werden.",
                "The backup must be checked first.",
              ),
            );
          if (values.password !== values.confirmation)
            throw new Error(
              uiText(
                "Die Passwörter stimmen nicht überein.",
                "The passwords do not match.",
              ),
            );
          if (backup)
            await validateBackupSelection(backup, new AbortController().signal);
          setDraft(
            await prepareOwner(
              client,
              setupLink,
              backup?.username ?? values.username,
              values.password,
              backup
                ? {
                    userId: backup.ownerId,
                    context: `backup:${base64(randomSecret())}`,
                  }
                : {},
            ),
          );
        }}
      >
        {!backup && (
          <MyForm.Input
            name="username"
            labelText={uiText("Nutzername", "Username")}
            autoComplete="username"
            focusOnMount
            required
          />
        )}
        <MyForm.Input
          name="password"
          type="password"
          labelText={uiText("Passwort festlegen", "Set password")}
          autoComplete="new-password"
          focusOnMount={!!backup}
          required
        />
        <MyForm.Input
          name="confirmation"
          type="password"
          labelText={uiText("Passwort wiederholen", "Repeat password")}
          autoComplete="new-password"
          required
        />
        <MyForm.SubmitButton disabled={backup === undefined}>
          {uiText("Weiter", "Continue")}
        </MyForm.SubmitButton>
      </MyForm>
      <MyButton kind="tertiary" onClick={() => navigate("/auth/login")}>
        {uiText("Bereits eingerichtet? Anmelden", "Already set up? Sign in")}
      </MyButton>
    </AuthLayout>
  );
}
