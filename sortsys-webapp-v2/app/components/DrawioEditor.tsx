import { uiText, useI18n } from "~/lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type DrawioEvent = {
  event?: "init" | "autosave" | "save" | "exit" | "configure";
  xml?: string;
};

export function DrawioEditor(props: {
  editorUrl: string;
  fileName: string;
  xml: string;
  version: bigint;
  canEdit: boolean;
  onSave: (xml: string, version: bigint) => Promise<bigint>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const { locale } = useI18n();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const versionRef = useRef(props.version);
  const pendingXmlRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const editor = useMemo(() => {
    const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(props.editorUrl, baseUrl);
    url.searchParams.set("embed", "1");
    url.searchParams.set("proto", "json");
    url.searchParams.set("spin", "1");
    url.searchParams.set("ui", "min");
    url.searchParams.set("libraries", "1");
    url.searchParams.set("lang", locale === "en" ? "en" : "de");
    url.searchParams.set("noExitBtn", "1");

    if (!props.canEdit) {
      url.searchParams.set("chrome", "0");
      url.searchParams.set("lightbox", "1");
      url.searchParams.set("noSaveBtn", "1");
    }

    return {
      origin: url.origin,
      url: url.toString(),
    };
  }, [locale, props.canEdit, props.editorUrl]);

  const postToEditor = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(message), editor.origin);
  }, [editor.origin]);

  const flushSaves = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;

    try {
      while (pendingXmlRef.current != null) {
        const xml = pendingXmlRef.current;
        pendingXmlRef.current = null;
        setSaveState("saving");

        versionRef.current = await props.onSave(xml, versionRef.current);
      }

      setSaveState("saved");
      window.setTimeout(() => setSaveState(current => current === "saved" ? "idle" : current), 1_500);
      postToEditor({ action: "status", message: uiText("Gespeichert", "Saved"), modified: false });
    } catch (error) {
      setSaveState("failed");
      const message = error instanceof Error
        ? error.message
        : uiText("Das Diagramm konnte nicht gespeichert werden.", "The diagram could not be saved.");
      props.onError(message);
      postToEditor({ action: "status", message, modified: true });
    } finally {
      savingRef.current = false;
    }
  }, [postToEditor, props.onError, props.onSave]);

  useEffect(() => {
    const receiveMessage = (message: MessageEvent) => {
      if (message.source !== iframeRef.current?.contentWindow || message.origin !== editor.origin) {
        return;
      }

      let event: DrawioEvent;
      try {
        event = typeof message.data === "string" ? JSON.parse(message.data) : message.data;
      } catch {
        return;
      }

      if (event.event === "init") {
        postToEditor({
          action: "load",
          autosave: props.canEdit ? 1 : 0,
          saveAndExit: "0",
          title: props.fileName,
          xml: props.xml,
        });
        setReady(true);
        return;
      }

      if (props.canEdit && (event.event === "autosave" || event.event === "save") && event.xml) {
        pendingXmlRef.current = event.xml;
        void flushSaves();
        return;
      }

      if (event.event === "exit") {
        props.onClose();
      }
    };

    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [
    editor.origin,
    flushSaves,
    postToEditor,
    props.canEdit,
    props.fileName,
    props.onClose,
    props.xml,
  ]);

  return <div className="drawio-editor">
    {!ready && <div className="drawio-editor__loading" role="status">
      <span className="ss-loading-dots" aria-hidden="true"><i /><i /><i /></span>
      {uiText("Diagramm wird geöffnet", "Opening diagram")}
    </div>}

    {props.canEdit && saveState !== "idle" && <div
      className={`drawio-editor__save-state is-${saveState}`}
      role="status"
    >
      {saveState === "saving" && uiText("Speichert …", "Saving…")}
      {saveState === "saved" && uiText("Gespeichert", "Saved")}
      {saveState === "failed" && uiText("Speichern fehlgeschlagen", "Save failed")}
    </div>}

    <iframe
      ref={iframeRef}
      className="drawio-editor__frame"
      src={editor.url}
      title={props.fileName}
      allow="clipboard-read; clipboard-write"
    />
  </div>;
}
