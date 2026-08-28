import { uiText } from "~/lib/i18n";
import { Loading, Tile } from "@sortsys/react-components";
import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { h2 } from "~/lib/primitives";
import { Icons } from "~/lib/icons";
import { adminClient, loginGlobalAdmin, restoreAdminSession } from "~/lib/adminClient";
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

  return <div className="my-container" style={{ maxWidth: "36rem", paddingTop: "2rem" }}>
    <Tile>
      <div className="space-y-2">
        <h2 className={h2()}>{uiText("Global Admin")}</h2>

        {!!errMsg && (
          <MyCallout icon={Icons.Deny} color="red">
            {errMsg}
          </MyCallout>
        )}

        <MyForm className="max-w-none p-0" onSubmit={async (context) => {
          const values = context.getValues();
          const password = `${values.password ?? ""}`;

          const [, err] = await loginGlobalAdmin(password);
          if (!err) {
            setErrMsg(null);
            return;
          }

          setErrMsg(err.message || uiText("Anmeldung fehlgeschlagen"));
        }}>
          <MyForm.Input
            required
            autoComplete="current-password"
            type="password"
            name="password"
            labelText={uiText("Global Admin Passwort")}
          />

          <MyForm.SubmitButton>{uiText("Anmelden")}</MyForm.SubmitButton>
        </MyForm>
      </div>
    </Tile>
  </div>;
}
