import { uiText } from "~/lib/i18n";
import { Tile } from "@sortsys/react-components";
import { useState } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import type { Route } from "./+types/settings";

export function meta({}: Route.MetaArgs) {
  return [{ title: uiText("Passwort | Einstellungen") }];
}

export default function PasswordSettingsPage() {
  const sessionInfo = useSessionInfo();
  const [message, setMessage] = useState<string | null>(null);

  async function changePassword(context: MyPublicFormContext) {
    setMessage(null);

    const values = context.getValues();
    const password = `${values.password ?? ""}`;
    const passwordConfirm = `${values.passwordConfirm ?? ""}`;
    if (password !== passwordConfirm) {
      throw new Error(uiText("Passwörter stimmen nicht überein."));
    }

    const [, err] = await client.mutate("auth.setPassword", {
      username: sessionInfo.user.username,
      password,
    });
    if (err) throw err;

    context.setValues({ password: "", passwordConfirm: "" });
    setMessage(uiText("Passwort gespeichert."));
  }

  return (
    <Tile className="settings-section">
      {!!message && (
        <AutoHideSuccessCallout resetKey={message} onHidden={() => setMessage(null)}>
          {message}
        </AutoHideSuccessCallout>
      )}

      <MyForm className="settings-form" onSubmit={changePassword}>
        <MyForm.Input
          required
          name="password"
          labelText={uiText("Neues Passwort")}
          type="password"
          autoComplete="new-password"
          rules={[MyForm.Input.rules.min(10)]}
        />
        <MyForm.Input
          required
          name="passwordConfirm"
          labelText={uiText("Passwort wiederholen")}
          type="password"
          autoComplete="new-password"
          rules={[MyForm.Input.rules.min(10)]}
        />
        <MyForm.SubmitButton>{uiText("Speichern")}</MyForm.SubmitButton>
      </MyForm>
    </Tile>
  );
}
