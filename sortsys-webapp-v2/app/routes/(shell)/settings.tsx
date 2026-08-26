import { Tile } from "@sortsys/react-components";
import { useState } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { createPasskeyCredential, isPasskeySupported } from "~/lib/passkeys";
import type { Route } from "./+types/settings";

type Passkey = {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Einstellungen' },
  ];
}

export default function SettingsPage() {
  const sessionInfo = useSessionInfo();
  const [reloadCounter, setReloadCounter] = useState(0);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passkeyMessage, setPasskeyMessage] = useState<string | null>(null);
  const [passkeyErr, setPasskeyErr] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  const [passkeys, passkeysErr] = useClientStream<Passkey[] | null, any>(() => {
    return (client.streamQuery as any)('auth.passkeys.list', undefined, { strategy: 'network-first' });
  }, [reloadCounter]);
  const fullName = [sessionInfo.user.firstName, sessionInfo.user.lastName].filter(Boolean).join(' ');
  const passkeyCount = passkeys?.length ?? 0;
  const passkeySupported = isPasskeySupported();

  async function addPasskey() {
    setPasskeyErr(null);
    setPasskeyMessage(null);

    const label = window.prompt('Name für den Passkey', `Passkey ${new Date().toLocaleDateString('de-DE')}`)?.trim();
    if (!label) return;

    setPasskeyLoading(true);
    try {
      const [begin, beginErr] = await (client.mutate as any)('auth.passkeys.registerOptions', undefined);
      if (beginErr) throw beginErr;
      if (!begin) throw new Error('Passkey-Registrierung konnte nicht gestartet werden.');

      const credential = await createPasskeyCredential(begin.options);
      const [, finishErr] = await (client.mutate as any)('auth.passkeys.register', {
        challengeToken: begin.challengeToken,
        label,
        credential,
      });
      if (finishErr) throw finishErr;

      setReloadCounter(value => value + 1);
      setPasskeyMessage('Passkey gespeichert.');
    } catch (err) {
      setPasskeyErr((err as Error)?.message || 'Passkey konnte nicht gespeichert werden.');
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function deletePasskey(passkey: Passkey) {
    if (!window.confirm(`Passkey "${passkey.label}" entfernen?`)) return;

    setPasskeyErr(null);
    setPasskeyMessage(null);
    const [, err] = await (client.mutate as any)('auth.passkeys.delete', { id: passkey.id });
    if (err) {
      setPasskeyErr(err.message || 'Passkey konnte nicht entfernt werden.');
      return;
    }

    setReloadCounter(value => value + 1);
    setPasskeyMessage('Passkey entfernt.');
  }

  return <div className="settings-page">
    <MyHeader
      title="Einstellungen"
      subtitle="Konto, Passwort und Passkeys verwalten"
    />

    <Tile className="settings-hero">
      <div className="settings-identity">
        <span className="settings-identity-icon"><Icons.Settings /></span>
        <div>
          <p className="settings-eyebrow">Angemeldetes Konto</p>
          <h2>{fullName || sessionInfo.user.username}</h2>
          <p className="light">{sessionInfo.user.username}</p>
        </div>
      </div>

      <div className="settings-facts">
        <div className="settings-fact">
          <span>Mandant</span>
          <strong>{sessionInfo.tenant.companyName || '-'}</strong>
        </div>
        <div className="settings-fact">
          <span>E-Mail</span>
          <strong>{sessionInfo.user.email || '-'}</strong>
        </div>
        <div className="settings-fact">
          <span>Passkeys</span>
          <strong>{passkeyCount}</strong>
        </div>
      </div>
    </Tile>

    <div className="settings-grid">
      <Tile className="settings-card settings-card--password">
        <div className="settings-card-header">
          <div>
            <p className="settings-eyebrow">Klassische Anmeldung</p>
            <h2>Passwort</h2>
            <p className="light">Setzt dein eigenes Passwort für Login mit Nutzername und Passwort.</p>
          </div>
          <Icons.SetPassword className="settings-card-icon" />
        </div>

        {!!passwordMessage && <AutoHideSuccessCallout resetKey={passwordMessage} onHidden={() => setPasswordMessage(null)}>{passwordMessage}</AutoHideSuccessCallout>}

        <MyForm className="settings-form" onSubmit={async context => {
          setPasswordMessage(null);
          const values = context.getValues();
          const password = `${values.password ?? ''}`;
          const passwordConfirm = `${values.passwordConfirm ?? ''}`;
          if (password !== passwordConfirm) throw new Error('Passwörter stimmen nicht überein.');

          const [, err] = await (client.mutate as any)('auth.setPassword', {
            username: sessionInfo.user.username,
            password,
          });
          if (err) throw err;

          context.setValues({ password: '', passwordConfirm: '' });
          setPasswordMessage('Passwort gespeichert.');
        }}>
          <MyForm.Input
            required
            name="password"
            labelText="Neues Passwort"
            type="password"
            autoComplete="new-password"
            rules={[MyForm.Input.rules.min(10)]}
          />
          <MyForm.Input
            required
            name="passwordConfirm"
            labelText="Neues Passwort wiederholen"
            type="password"
            autoComplete="new-password"
            rules={[MyForm.Input.rules.min(10)]}
          />
          <MyForm.SubmitButton renderIcon={Icons.SetPassword}>Passwort speichern</MyForm.SubmitButton>
        </MyForm>
      </Tile>

      <Tile className="settings-card settings-card--passkeys">
        <div className="settings-card-header">
          <div>
            <p className="settings-eyebrow">Passwortlose Anmeldung</p>
            <h2>Passkeys</h2>
            <p className="light">Geräte-PIN, Fingerabdruck oder Sicherheitsschlüssel statt Passwort.</p>
          </div>
          <MyButton renderIcon={Icons.Lock} loading={passkeyLoading} disabled={!passkeySupported} onClick={addPasskey}>
            Hinzufügen
          </MyButton>
        </div>

        <div className="settings-passkey-summary">
          <span>{passkeyCount} {passkeyCount === 1 ? 'Passkey' : 'Passkeys'}</span>
          <span>{passkeySupported ? 'Browser unterstützt Passkeys' : 'Browser unterstützt keine Passkeys'}</span>
        </div>

        {!passkeySupported && <MyCallout icon={Icons.Deny} color="red">
          Dieser Browser unterstützt keine Passkeys.
        </MyCallout>}
        {!!passkeyErr && <MyCallout icon={Icons.Deny} color="red">{passkeyErr}</MyCallout>}
        {!!passkeysErr && <MyCallout icon={Icons.Deny} color="red">Passkeys konnten nicht geladen werden.</MyCallout>}
        {!!passkeyMessage && <AutoHideSuccessCallout resetKey={passkeyMessage} onHidden={() => setPasskeyMessage(null)}>{passkeyMessage}</AutoHideSuccessCallout>}

        <div className="settings-passkey-list">
          {(passkeys ?? []).map(passkey => <div key={passkey.id} className="settings-passkey-row">
            <div className="settings-passkey-main">
              <span className="settings-passkey-icon"><Icons.Lock /></span>
              <div>
                <strong>{passkey.label}</strong>
                <div className="light text-sm">
                  Erstellt: {formatDate(passkey.createdAt, 'long')}
                  {passkey.lastUsedAt ? ` · Zuletzt genutzt: ${formatDate(passkey.lastUsedAt, 'long')}` : ''}
                </div>
              </div>
            </div>
            <MyButton kind="danger--tertiary" size="sm" renderIcon={Icons.Delete} onClick={() => deletePasskey(passkey)}>
              Entfernen
            </MyButton>
          </div>)}

          {passkeys && passkeys.length === 0 && <div className="settings-empty">
            <strong>Keine Passkeys gespeichert</strong>
            <span className="light">Füge einen Passkey hinzu, um dich ohne Passwort anzumelden.</span>
          </div>}
        </div>
      </Tile>
    </div>
  </div>;
}
