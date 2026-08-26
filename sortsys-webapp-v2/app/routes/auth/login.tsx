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
        { title: 'Anmelden' },
    ];
}

export default Unauthenticated(function () {
    const [passkeyLoading, setPasskeyLoading] = useState(false);
    const [passkeyErr, setPasskeyErr] = useState<string | null>(null);

    async function passkeyLogin() {
        setPasskeyErr(null);
        setPasskeyLoading(true);
        try {
            if (typeof window === 'object') {
                window.localStorage.removeItem('__sortsys-v2_admin_token');
            }

            const [begin, beginErr] = await (client.mutate as any)('auth.passkeys.loginOptions', undefined);
            if (beginErr) throw beginErr;
            if (!begin) throw new Error('Passkey-Anmeldung konnte nicht gestartet werden.');

            const credential = await getPasskeyCredential(begin.options);
            const [login, loginErr] = await (client.mutate as any)('auth.passkeys.login', {
                challengeToken: begin.challengeToken,
                credential,
            });
            if (loginErr) throw loginErr;
            if (!login?.token) throw new Error('Passkey-Anmeldung fehlgeschlagen.');

            client.setToken(login.token);
        } catch (err) {
            setPasskeyErr((err as Error)?.message || 'Passkey-Anmeldung fehlgeschlagen.');
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
            window.localStorage.removeItem('__sortsys-v2_admin_token');
        }

        await client.login({ username, tenant, password });
    }}>
        <Heading>Anmelden</Heading>
        <MyForm.Input name="username" labelText="Nutzername" autoComplete="username" required rules={[
            MyForm.Input.rules.pattern(/^[a-zA-Z0-9_\-\.]+\@[a-zA-Z0-9_\-\.]+$/),
        ]} />
        <MyForm.Input name="password" labelText="Passwort" autoComplete="current-password" type="password" required />
        <MyForm.SubmitButton>Anmelden</MyForm.SubmitButton>
        <MyButton type="button" kind="secondary" renderIcon={Icons.Lock} loading={passkeyLoading} onClick={passkeyLogin}>
            Mit Passkey anmelden
        </MyButton>
        {!!passkeyErr && <MyCallout icon={Icons.Deny} color="red">{passkeyErr}</MyCallout>}
    </MyForm>;
});
