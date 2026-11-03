import { Button as UIAction } from "@sortsys/react-components";
import { uiText } from "~/lib/i18n";
import {
  Checkbox,
  Modal,
  TextArea,
  TextInput,
  Tile,
  useNotifications,
} from "@sortsys/react-components";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router";
import { ScriptCodePreview, ScriptEditor } from "~/components/ScriptEditor";
import { MyForm } from "~/components/MyForm";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyHeader } from "~/components/MyHeader";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
import {
  ScriptConsole,
  useClientScriptRunner,
} from "~/lib/clientScriptRuntime";
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
  title: ${JSON.stringify(uiText('Skript ausführen', 'Run script'))},
  content: ${JSON.stringify(uiText('<p>Aktuelle Sitzung laden?</p>', '<p>Load the current session?</p>'))},
  buttonText: ${JSON.stringify(uiText('Laden', 'Load'))},
});

if (confirmed) {
  const [sessionInfo, err] = await client.query('auth.sessionInfo', undefined, { strategy: 'network-first' });
  if (err) throw new Error(err.message);
  await log(sessionInfo);
}
`;

export function meta() {
  return [
    { title: uiText("Client-Skripte") },
  ];
}

export default function ClientScriptsPage() {
  const sessionInfo = useSessionInfo();
  const modals = useMyModals();
  const notifications = useNotifications();
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
  const [editMode, setEditMode] = useState(false);
  const detailRequest = useRef(0);

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
      const [data, err] = await client.query('clientScripts.list', { includeDisabled: true });
      if (err) throw err;
      const rows = (data ?? []) as ClientScriptSummary[];
      setScripts(rows);
      if (selectId !== undefined) {
        setSelectedId(selectId);
      }
    } catch (err) {
      setError((err as Error)?.message || uiText('Client-Skripte konnten nicht geladen werden.'));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadScript(id: string | null) {
    const request = ++detailRequest.current;
    setLoadedScript(null);

    if (!id) {
      setName('');
      setDescription('');
      setEnabled(true);
      setCode(DEFAULT_SCRIPT);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const [data, err] = await client.query(
        'clientScripts.get',
        { id },
        { strategy: 'network-first' },
      );

      if (request !== detailRequest.current) {
        return;
      }

      if (err) {
        throw err;
      }

      if (!data) {
        throw new Error(uiText("Skript nicht gefunden."));
      }

      const script = data as ClientScriptDetail;
      setLoadedScript(script);
      setName(script.name);
      setDescription(script.description ?? '');
      setEnabled(script.enabled);
      setCode(script.code);
    } catch (err) {
      if (request === detailRequest.current) {
        setError((err as Error)?.message || uiText('Client-Skript konnte nicht geladen werden.'));
      }
    } finally {
      if (request === detailRequest.current) {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!canView) return;
    void loadScripts();
  }, [canView]);

  useEffect(() => {
    if (!canView) return;
    void loadScript(selectedId);

    return () => {
      detailRequest.current += 1;
    };
  }, [selectedId, canView]);

  function newScript() {
    setError(null);

    modals.showForm({
      content: () => (
        <MyForm.Input
          required
          name="name"
          labelText={uiText("Name")}
          autoFocus
        />
      ),
      onSubmit: async ({ context, hide }) => {
        const trimmedName = `${context.getValues().name ?? ''}`.trim();
        if (!trimmedName) return;

        setIsSaving(true);
        setError(null);
        try {
          const [data, err] = await client.mutate('clientScripts.create', {
            name: trimmedName,
            description: null,
            enabled: true,
            code: DEFAULT_SCRIPT,
          });
          if (err) throw err;
          if (!data) throw new Error(uiText("Skript konnte nicht erstellt werden."));

          const script = data as ClientScriptDetail;
          hide();
          notifications.success({ title: uiText("Skript erstellt", "Script created") });
          await loadScripts(script.id);
          await loadScript(script.id);
          setEditMode(true);
        } catch (err) {
          setError((err as Error)?.message || uiText('Skript konnte nicht erstellt werden.'));
          throw err;
        } finally {
          setIsSaving(false);
        }
      },
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Skript erstellen"),
        primaryButtonText: uiText("Erstellen"),
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
    try {
      const [data, err] = await client.mutate('clientScripts.update', {
        id: selectedId,
        data: {
          name: trimmedName,
          description: description.trim() || null,
          enabled,
        },
      });
      if (err) throw err;
      if (!data) throw new Error(uiText("Skript konnte nicht gespeichert werden."));

      const script = data as ClientScriptDetail;
      notifications.success({ title: uiText("Skript gespeichert", "Script saved") });
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
      setError((err as Error)?.message || uiText('Skript konnte nicht gespeichert werden.'));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveCode() {
    if (!canManage || !selectedId) return;

    setIsSaving(true);
    setError(null);
    try {
      const [data, err] = await client.mutate('clientScripts.update', {
        id: selectedId,
        data: {
          code,
        },
      });
      if (err) throw err;
      if (!data) throw new Error(uiText("Skript konnte nicht gespeichert werden."));

      const script = data as ClientScriptDetail;
      notifications.success({ title: uiText("Skript gespeichert", "Script saved") });
      setLoadedScript(current => current?.id === script.id
        ? { ...current, code: script.code, modifiedAt: script.modifiedAt }
        : script);
      setCode(script.code);
      await loadScripts(script.id);
    } catch (err) {
      setError((err as Error)?.message || uiText('Skript konnte nicht gespeichert werden.'));
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

      modals.show(({ visible, hide }) => (
        <Modal
          open={visible}
          danger
          modalHeading={uiText("Skript löschen")}
          primaryButtonText={uiText("Löschen")}
          secondaryButtonText={uiText("Abbrechen")}
          onRequestClose={() => settle(false, hide)}
          onRequestSubmit={() => settle(true, hide)}
        >
          <p className="light">
            {uiText("Das Skript ")}
            <b>{loadedScript.name}</b>
            {uiText(" wird endgültig gelöscht.")}
          </p>
        </Modal>
      ));
    });
    if (!confirmed) return;

    setIsSaving(true);
    setError(null);
    try {
      const [, err] = await client.mutate('clientScripts.delete', { id: selectedId });
      if (err) throw err;
      notifications.success({ title: uiText("Skript gelöscht", "Script deleted") });
      await loadScripts(null);
      setSelectedId(null);
    } catch (err) {
      setError((err as Error)?.message || uiText('Skript konnte nicht gelöscht werden.', 'Script could not be deleted.'));
    } finally {
      setIsSaving(false);
    }
  }

  async function runCurrentScript() {
    if (!selectedId || loadedScript?.id !== selectedId || isLoading) {
      return;
    }

    setError(null);
    try {
      const result = await runScript(code);
      if (!result.ok) {
        setError(result.error?.message || uiText('Skript fehlgeschlagen.'));
        return;
      }
    } catch (err) {
      setError((err as Error)?.message || uiText('Skript fehlgeschlagen.'));
    }
  }

  if (!canView) return <NotFound reason="pageNotFound" />;

  if (editMode && selectedId && loadedScript?.id === selectedId) {
    const canRunCurrentScript = !isScriptRunning && !!code.trim() && (enabled || isDraft);

    return (
      <div
        className={[
          "script-edit-page flex h-[calc(100dvh-7rem)] min-h-0 min-w-0",
          "flex-col gap-4 [&>.script-editor]:min-h-0",
          "[&>.script-editor]:border-0",
        ].join(" ")}
      >
        <div className="script-edit-bar flex flex-wrap items-center justify-between gap-3">
          <MyButton
            kind="ghost"
            size="sm"
            renderIcon={Icons.Back}
            onClick={() => setEditMode(false)}
          >
            {uiText("Zurück")}
          </MyButton>
          <div className="script-actions flex shrink-0 flex-wrap items-center gap-2">
            <MyButton
              kind="ghost"
              size="sm"
              renderIcon={Icons.Resume}
              disabled={!canRunCurrentScript}
              onClick={runCurrentScript}
            >
              {uiText("Ausführen")}
            </MyButton>
            {canManage && (
              <MyButton
                size="sm"
                renderIcon={Icons.Accept}
                loading={isSaving}
                disabled={!isCodeDirty || isLoading || !selectedId}
                onClick={saveCode}
              >
                {uiText("Speichern")}
              </MyButton>
            )}
          </div>
        </div>

        {!!error && (
          <MyCallout icon={Icons.Deny} color="red">
            {error}
          </MyCallout>
        )}

        <ScriptEditor
          value={code}
          onChange={setCode}
          onRun={() => {
            if (!canRunCurrentScript) return;
            void runCurrentScript();
          }}
          readOnly={!canManage}
        />
        <ScriptConsole entries={scriptLogs} resizable defaultHeight={220} />
      </div>
    );
  }

  return (
    <>
      <MyHeader title={uiText("Client-Skripte")} />

      {!!error && (
        <MyCallout icon={Icons.Deny} color="red">
          {error}
        </MyCallout>
      )}

      <div className="script-page grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Tile className="script-list-tile min-w-0 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto">
          <div className="script-toolbar flex flex-wrap items-center gap-3">
            <h3 className="text-xl leading-snug font-semibold">
              {uiText("Skripte")}
            </h3>
            {canManage && (
              <MyButton size="sm" renderIcon={Icons.Plus} onClick={newScript}>
                {uiText("Neu")}
              </MyButton>
            )}
          </div>

          <div className="script-list divide-y divide-separator">
            {scripts.map((script) => (
              <UIAction
                kind="ghost"
                key={script.id}
                type="button"
                className={[
                  "script-list-item h-auto min-h-14 w-full flex-col items-start",
                  "gap-1 whitespace-normal py-3 text-left",
                  "data-[active=true]:bg-accent-soft data-[active=true]:text-accent",
                  "[&_span]:text-xs [&_span]:font-normal [&_span]:text-muted",
                ].join(" ")}
                data-active={(selectedId === script.id).toString()}
                onClick={() => setSelectedId(script.id)}
              >
                <b>{script.name}</b>
                <span>
                  {script.enabled
                    ? uiText("Aktiv", "Active")
                    : uiText("Deaktiviert", "Inactive")}
                </span>
              </UIAction>
            ))}

            {!scripts.length && (
              <p className="light">{uiText("Noch keine Skripte.")}</p>
            )}
          </div>
        </Tile>

        {selectedId && loadedScript?.id === selectedId && (
          <Tile
            className={[
              "script-editor-tile flex min-h-0 flex-1 flex-col gap-3",
              "lg:h-[calc(100dvh-9rem)]",
            ].join(" ")}
          >
            <div className="script-toolbar flex flex-wrap items-center gap-3">
              <div>
                <div className="script-title-row flex min-w-0 items-center gap-2">
                  <h3 className="text-xl leading-snug font-semibold">
                    {isDraft
                      ? uiText("Neues Skript", "New script")
                      : (loadedScript?.name ?? uiText("Skript", "Script"))}
                  </h3>
                  <Link
                    className={[
                      "script-doc-link inline-flex min-h-11 items-center gap-2 text-sm",
                      "text-accent",
                    ].join(" ")}
                    to="/docs/client-skripte"
                  >
                    {uiText("Dokumentation")}
                  </Link>
                </div>
              </div>

              <div className="script-actions flex shrink-0 flex-wrap items-center gap-2">
                <MyButton
                  kind="ghost"
                  size="sm"
                  renderIcon={Icons.Resume}
                  disabled={
                    isScriptRunning || !code.trim() || (!enabled && !isDraft)
                  }
                  onClick={runCurrentScript}
                >
                  {uiText("Ausführen")}
                </MyButton>
                {canManage && !isDraft && (
                  <MyButton
                    kind="secondary"
                    size="sm"
                    renderIcon={Icons.Accept}
                    loading={isSaving}
                    disabled={!isMetadataDirty || isLoading}
                    onClick={saveMetadata}
                  >
                    {uiText("Speichern")}
                  </MyButton>
                )}
                {canManage && (
                  <MyButton
                    size="sm"
                    renderIcon={Icons.Edit}
                    disabled={isLoading || !loadedScript}
                    onClick={() => setEditMode(true)}
                  >
                    {uiText("Bearbeiten")}
                  </MyButton>
                )}
                {canDelete && !isDraft && (
                  <MyButton
                    kind="danger--tertiary"
                    size="sm"
                    renderIcon={Icons.Delete}
                    loading={isSaving}
                    onClick={deleteScript}
                  >
                    {uiText("Löschen")}
                  </MyButton>
                )}
              </div>
            </div>

            <div
              className={[
                "script-meta-grid grid items-end gap-3",
                "md:grid-cols-[minmax(0,1fr)_auto]",
              ].join(" ")}
            >
              <TextInput
                id="script-name"
                labelText={uiText("Name")}
                value={name}
                disabled={!canManage}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setName(e.currentTarget.value)
                }
              />
              <div className="flex min-h-11 items-center">
                <Checkbox
                  id="script-enabled"
                  labelText={uiText("Aktiv")}
                  checked={enabled}
                  disabled={!canManage}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setEnabled(e.currentTarget.checked)
                  }
                />
              </div>
              <TextArea
                id="script-description"
                className="script-description-field min-w-0 w-full md:col-span-2"
                labelText={uiText("Beschreibung")}
                value={description}
                disabled={!canManage}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setDescription(e.currentTarget.value)
                }
              />
            </div>

            <ScriptCodePreview value={code} />
            <ScriptConsole entries={scriptLogs} />
          </Tile>
        )}
      </div>
    </>
  );
}
