import { uiText } from "~/lib/i18n";
import { Tile, useNotifications } from "@sortsys/react-components";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import type { Route } from "./+types/settings";

export function meta({}: Route.MetaArgs) {
  return [{ title: uiText("Passwort | Einstellungen") }];
}

export default function PasswordSettingsPage() {
  const sessionInfo = useSessionInfo();
  const notifications = useNotifications();

  async function changePassword(context: MyPublicFormContext) {
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
    notifications.success({ title: uiText("Passwort gespeichert", "Password saved") });
  }

  return (
    <Tile className="settings-section">
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
