import { uiText } from "~/lib/i18n";
import { Loading } from "@sortsys/react-components";
import { AuthLayout } from "~/components/AuthLayout";
import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { Icons } from "~/lib/icons";
import {
  adminClient,
  loginGlobalAdmin,
  restoreAdminSession,
} from "~/lib/adminClient";
import { useForceUpdate } from "~/hooks/useForceUpdate";

export function meta() {
  return [
    { title: uiText("Global Admin Login") },
  ];
}

export default function GlobalAdminLoginPage() {
  const forceUpdate = useForceUpdate();
  const [restored, setRestored] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    restoreAdminSession().finally(() => setRestored(true));
  }, []);

  useEffect(() => adminClient.listenAuthState(forceUpdate), []);

  if (!restored) {
    return <Loading active withOverlay />;
  }

  if (adminClient.loggedIn()) {
    return <Navigate to="/__admin/tenants" replace />;
  }

  return (
    <AuthLayout title={uiText("Global Admin")}>
      {!!errMsg && (
        <MyCallout icon={Icons.Deny} color="red">
          {errMsg}
        </MyCallout>
      )}

      <MyForm
        className="max-w-none p-0"
        onSubmit={async (context) => {
          const values = context.getValues();
          const password = `${values.password ?? ""}`;

          const [, err] = await loginGlobalAdmin(password);
          if (!err) {
            setErrMsg(null);
            return;
          }

          setErrMsg(err.message || uiText("Anmeldung fehlgeschlagen"));
        }}
      >
        <MyForm.Input
          required
          autoComplete="current-password"
          type="password"
          name="password"
          labelText={uiText("Global Admin Passwort")}
        />

        <MyForm.SubmitButton>{uiText("Anmelden")}</MyForm.SubmitButton>
      </MyForm>
    </AuthLayout>
  );
}
