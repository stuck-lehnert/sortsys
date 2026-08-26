import { Checkbox, Modal, TextArea, TextInput, Tile } from "@sortsys/react-components";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Link } from "react-router";
import { ScriptCodePreview, ScriptEditor } from "~/components/ScriptEditor";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyForm } from "~/components/MyForm";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyHeader } from "~/components/MyHeader";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
import { ScriptConsole, useClientScriptRunner } from "~/lib/clientScriptRuntime";
import { NotFound } from "./_404";

type ClientScriptSummary = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
  modifiedAt: Date;
};

type ClientScriptDetail = ClientScriptSummary & {
  code: string;
};

const DEFAULT_SCRIPT = `const { client } = await import('sortsys-client');
const { requireConfirmation } = await import('sortsys-popups');
const { log } = await import('sortsys-log');

const confirmed = await requireConfirmation({
  title: 'Skript ausführen',
  content: '<p>Aktuelle Sitzung laden?</p>',
  buttonText: 'Laden',
});

if (confirmed) {
  const [sessionInfo, err] = await client.query('auth.sessionInfo', undefined, { strategy: 'network-first' });
  if (err) throw new Error(err.message);
  await log(sessionInfo);
}
`;

export function meta() {
  return [
    { title: "Client-Skripte" },
  ];
}

export default function ClientScriptsPage() {
  const sessionInfo = useSessionInfo();
  const modals = useMyModals();
  const canView = sessionInfo.canDo('view:clientScripts');
  const canManage = sessionInfo.canDo('manage:clientScripts');
  const canDelete = sessionInfo.canDo('delete:clientScripts');
  const [isScriptRunning, runScript, scriptLogs] = useClientScriptRunner();

  const [scripts, setScripts] = useState<ClientScriptSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadedScript, setLoadedScript] = useState<ClientScriptDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [code, setCode] = useState(DEFAULT_SCRIPT);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  const isDraft = !selectedId;
  const isCodeDirty = useMemo(() => {
    if (isDraft) return code !== DEFAULT_SCRIPT;
    if (!loadedScript) return false;
    return loadedScript.code !== code;
  }, [isDraft, loadedScript, code]);
  const isMetadataDirty = useMemo(() => {
    if (isDraft) return false;
    if (!loadedScript) return false;
    return loadedScript.name !== name.trim()
      || (loadedScript.description ?? '') !== description
      || loadedScript.enabled !== enabled;
  }, [isDraft, loadedScript, name, description, enabled]);

  async function loadScripts(selectId?: string | null) {
    setIsLoading(true);
    setError(null);
    try {
      const [data, err] = await (client.query as any)('clientScripts.list', { includeDisabled: true });
      if (err) throw err;
      const rows = (data ?? []) as ClientScriptSummary[];
      setScripts(rows);
      if (selectId !== undefined) {
        setSelectedId(selectId);
      } else if (!selectedId && rows[0]) {
        setSelectedId(rows[0].id);
      }
    } catch (err) {
      setError((err as Error)?.message || 'Client-Skripte konnten nicht geladen werden.');
    } finally {
      setIsLoading(false);
    }
  }

  async function loadScript(id: string | null) {
    if (!id) {
      setLoadedScript(null);
      setName('');
      setDescription('');
      setEnabled(true);
      setCode(DEFAULT_SCRIPT);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const [data, err] = await (client.query as any)('clientScripts.get', { id }, { strategy: 'network-first' });
      if (err) throw err;
      if (!data) throw new Error('Skript nicht gefunden.');

      const script = data as ClientScriptDetail;
      setLoadedScript(script);
      setName(script.name);
      setDescription(script.description ?? '');
      setEnabled(script.enabled);
      setCode(script.code);
    } catch (err) {
      setError((err as Error)?.message || 'Client-Skript konnte nicht geladen werden.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!canView) return;
    void loadScripts();
  }, [canView]);

  useEffect(() => {
    if (!canView) return;
    void loadScript(selectedId);
  }, [selectedId, canView]);

  function newScript() {
    setInfo(null);
    setError(null);

    modals.showForm({
      content: () => <MyForm.Input required name="name" labelText="Name" autoFocus />,
      onSubmit: async ({ context, hide }) => {
        const trimmedName = `${context.getValues().name ?? ''}`.trim();
        if (!trimmedName) return;

        setIsSaving(true);
        setError(null);
        setInfo(null);
        try {
          const [data, err] = await (client.mutate as any)('clientScripts.create', {
            name: trimmedName,
            description: null,
            enabled: true,
            code: DEFAULT_SCRIPT,
          });
          if (err) throw err;
          if (!data) throw new Error('Skript konnte nicht erstellt werden.');

          const script = data as ClientScriptDetail;
          hide();
          setInfo('Skript erstellt.');
          await loadScripts(script.id);
          await loadScript(script.id);
          setEditMode(true);
        } catch (err) {
          setError((err as Error)?.message || 'Skript konnte nicht erstellt werden.');
          throw err;
        } finally {
          setIsSaving(false);
        }
      },
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: 'Skript erstellen',
        primaryButtonText: 'Erstellen',
      }),
    });
  }

  async function saveMetadata() {
    if (!canManage || !selectedId) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name fehlt.');
      return;
    }

    setIsSaving(true);
    setError(null);
    setInfo(null);
    try {
      const [data, err] = await (client.mutate as any)('clientScripts.update', {
        id: selectedId,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          enabled,
        },
      });
      if (err) throw err;
      if (!data) throw new Error('Skript konnte nicht gespeichert werden.');

      const script = data as ClientScriptDetail;
      setInfo('Skript gespeichert.');
      setLoadedScript(current => current?.id === script.id
        ? {
          ...current,
          name: script.name,
          description: script.description,
          enabled: script.enabled,
          modifiedAt: script.modifiedAt,
        }
        : script);
      setName(script.name);
      setDescription(script.description ?? '');
      setEnabled(script.enabled);
      await loadScripts(script.id);
    } catch (err) {
      setError((err as Error)?.message || 'Skript konnte nicht gespeichert werden.');
    } finally {
      setIsSaving(false);
    }
  }

  async function saveCode() {
    if (!canManage || !selectedId) return;

    setIsSaving(true);
    setError(null);
    setInfo(null);
    try {
      const [data, err] = await (client.mutate as any)('clientScripts.update', {
        id: selectedId,
        data: {
          code,
        },
      });
      if (err) throw err;
      if (!data) throw new Error('Skript konnte nicht gespeichert werden.');

      const script = data as ClientScriptDetail;
      setInfo('Skript gespeichert.');
      setLoadedScript(current => current?.id === script.id
        ? { ...current, code: script.code, modifiedAt: script.modifiedAt }
        : script);
      setCode(script.code);
      await loadScripts(script.id);
    } catch (err) {
      setError((err as Error)?.message || 'Skript konnte nicht gespeichert werden.');
    } finally {
      setIsSaving(false);
    }
  }

  useShortcut('Control+s', e => {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    if (!isCodeDirty || isLoading || isSaving || !selectedId || !canManage) return;
    void saveCode();
  }, { disableTextInputs: false });

  async function deleteScript() {
    if (!canDelete || !selectedId || !loadedScript) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean, hide: () => void) => {
        if (settled) return;
        settled = true;
        resolve(value);
        hide();
      };

      modals.show(({ visible, hide }) => <Modal
        open={visible}
        danger
        modalHeading="Skript löschen"
        primaryButtonText="Löschen"
        secondaryButtonText="Abbrechen"
        onRequestClose={() => settle(false, hide)}
        onRequestSubmit={() => settle(true, hide)}
      >
        <p className="light">Das Skript <b>{loadedScript.name}</b> wird endgültig gelöscht.</p>
      </Modal>);
    });
    if (!confirmed) return;

    setIsSaving(true);
    setError(null);
    try {
      const [, err] = await (client.mutate as any)('clientScripts.delete', { id: selectedId });
      if (err) throw err;
      setInfo('Skript gelöscht.');
      await loadScripts(null);
      setSelectedId(null);
    } catch (err) {
      setError((err as Error)?.message || 'Skript konnte nicht gelöscht werden.');
    } finally {
      setIsSaving(false);
    }
  }

  async function runCurrentScript() {
    setError(null);
    setInfo(null);
    try {
      const result = await runScript(code);
      if (!result.ok) {
        setError(result.error?.message || 'Skript fehlgeschlagen.');
        return;
      }
    } catch (err) {
      setError((err as Error)?.message || 'Skript fehlgeschlagen.');
    }
  }

  if (!canView) return <NotFound reason="pageNotFound" />;

  if (editMode) {
    const canRunCurrentScript = !isScriptRunning && !!code.trim() && (enabled || isDraft);

    return <div className="script-edit-page">
      <div className="script-edit-bar">
        <MyButton kind="ghost" size="sm" renderIcon={Icons.Back} onClick={() => setEditMode(false)}>Zurück</MyButton>
        <div className="script-actions">
          <MyButton kind="ghost" size="sm" renderIcon={Icons.Resume} disabled={!canRunCurrentScript} onClick={runCurrentScript}>Ausführen</MyButton>
          {canManage && <MyButton size="sm" renderIcon={Icons.Accept} loading={isSaving} disabled={!isCodeDirty || isLoading || !selectedId} onClick={saveCode}>Speichern</MyButton>}
        </div>
      </div>

      {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}
      {!!info && <AutoHideSuccessCallout resetKey={info} onHidden={() => setInfo(null)}>{info}</AutoHideSuccessCallout>}

      <ScriptEditor value={code} onChange={setCode} onRun={() => {
        if (!canRunCurrentScript) return;
        void runCurrentScript();
      }} readOnly={!canManage} />
      <ScriptConsole entries={scriptLogs} resizable defaultHeight={220} />
    </div>;
  }

  return <>
    <MyHeader title="Client-Skripte" />

    <div className="script-page">
      <Tile className="script-list-tile">
        <div className="script-toolbar">
          <h3>Skripte</h3>
          {canManage && <MyButton size="sm" renderIcon={Icons.Plus} onClick={newScript}>Neu</MyButton>}
        </div>

        <div className="script-list">
          {scripts.map(script => <button
            key={script.id}
            type="button"
            className="script-list-item"
            data-active={(selectedId === script.id).toString()}
            onClick={() => setSelectedId(script.id)}
          >
            <b>{script.name}</b>
            <span>{script.enabled ? 'Aktiv' : 'Deaktiviert'}</span>
          </button>)}

          {!scripts.length && <p className="light">Noch keine Skripte.</p>}
        </div>
      </Tile>

      <Tile className="script-editor-tile">
        <div className="script-toolbar">
          <div>
            <div className="script-title-row">
              <h3>{isDraft ? 'Neues Skript' : loadedScript?.name ?? 'Skript'}</h3>
              <Link className="script-doc-link" to="/docs/client-skripte">Dokumentation</Link>
            </div>
          </div>

          <div className="script-actions">
            <MyButton kind="ghost" size="sm" renderIcon={Icons.Resume} disabled={isScriptRunning || !code.trim() || (!enabled && !isDraft)} onClick={runCurrentScript}>Ausführen</MyButton>
            {canManage && !isDraft && <MyButton kind="secondary" size="sm" renderIcon={Icons.Accept} loading={isSaving} disabled={!isMetadataDirty || isLoading} onClick={saveMetadata}>Speichern</MyButton>}
            {canManage && <MyButton size="sm" renderIcon={Icons.Edit} disabled={isLoading || !loadedScript} onClick={() => setEditMode(true)}>Bearbeiten</MyButton>}
            {canDelete && !isDraft && <MyButton kind="danger--tertiary" size="sm" renderIcon={Icons.Delete} loading={isSaving} onClick={deleteScript}>Löschen</MyButton>}
          </div>
        </div>

        {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}
        {!!info && <AutoHideSuccessCallout resetKey={info} onHidden={() => setInfo(null)}>{info}</AutoHideSuccessCallout>}

        <div className="script-meta-grid">
          <TextInput id="script-name" labelText="Name" value={name} disabled={!canManage} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.currentTarget.value)} />
          <Checkbox id="script-enabled" labelText="Aktiv" checked={enabled} disabled={!canManage} onChange={(e: ChangeEvent<HTMLInputElement>) => setEnabled(e.currentTarget.checked)} />
          <TextArea id="script-description" className="script-description-field" labelText="Beschreibung" value={description} disabled={!canManage} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.currentTarget.value)} />
        </div>

        <ScriptCodePreview value={code} />
        <ScriptConsole entries={scriptLogs} />
      </Tile>
    </div>
  </>;
}
