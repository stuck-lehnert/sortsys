import { uiText } from "~/lib/i18n";
import { Unauthenticated } from "~/components/Authenticated";
import type { Route } from "./+types/login";
import { Heading } from "@sortsys/react-components";
import { MyForm } from "~/components/MyForm";
import { client } from "~/lib/client";
import { useState } from "react";
import { MyButton } from "~/components/MyButton";
import { Icons } from "~/lib/icons";
import { getPasskeyCredential } from "~/lib/passkeys";
import { MyCallout } from "~/components/MyCallout";

export function meta({}: Route.MetaArgs) {
    return [
        { title: uiText("Anmelden") },
    ];
}

export default Unauthenticated(function () {
    const [passkeyLoading, setPasskeyLoading] = useState(false);
    const [passkeyErr, setPasskeyErr] = useState<string | null>(null);

    async function passkeyLogin() {
        setPasskeyErr(null);
        setPasskeyLoading(true);
        try {
            const [begin, beginErr] = await client.mutate('auth.passkeys.loginOptions', undefined);
            if (beginErr) throw beginErr;
            if (!begin) throw new Error(uiText("Passkey-Anmeldung konnte nicht gestartet werden."));

            const credential = await getPasskeyCredential(begin.options);
            const [login, loginErr] = await client.mutate('auth.passkeys.login', {
                challengeToken: begin.challengeToken,
                credential,
            });
            if (loginErr) throw loginErr;
            if (!login?.token) throw new Error(uiText("Passkey-Anmeldung fehlgeschlagen."));

            client.setToken(login.token);
        } catch (err) {
            setPasskeyErr((err as Error)?.message || uiText('Passkey-Anmeldung fehlgeschlagen.'));
        } finally {
            setPasskeyLoading(false);
        }
    }

    return <MyForm className="my-container" onSubmit={async (context) => {
        const values = context.getValues();

        const [username, tenant] = values.username.split('@');
        const password = values.password;

        if (typeof window === 'object') {
            window.localStorage.setItem('sortsys.tenant', tenant);
        }

        await client.login({ username, tenant, password });
    }}>
        <Heading>{uiText("Anmelden")}</Heading>
        <MyForm.Input name="username" labelText={uiText("Nutzername")} autoComplete="username" required rules={[
            MyForm.Input.rules.pattern(/^[a-zA-Z0-9_\-\.]+\@[a-zA-Z0-9_\-\.]+$/),
        ]} />
        <MyForm.Input name="password" labelText={uiText("Passwort")} autoComplete="current-password" type="password" required />
        <MyForm.SubmitButton>{uiText("Anmelden")}</MyForm.SubmitButton>
        <MyButton type="button" kind="secondary" renderIcon={Icons.Lock} loading={passkeyLoading} onClick={passkeyLogin}>{uiText("Mit Passkey anmelden")}</MyButton>
        {!!passkeyErr && <MyCallout icon={Icons.Deny} color="red">{passkeyErr}</MyCallout>}
    </MyForm>;
});
