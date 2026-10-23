import { uiText, useI18n } from "~/lib/i18n";
import {
  probeEditorResource,
  startEditorWithRetry,
  type EditorAttempt,
} from "~/lib/editorStartup";
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
  const frameSequenceRef = useRef(0);
  const frameAttemptRef = useRef<EditorAttempt | null>(null);
  const loadedWindowRef = useRef<Window | null>(null);
  const [frame, setFrame] = useState<{
    id: number;
    url: string;
    attempt: EditorAttempt;
  } | null>(null);
  const versionRef = useRef(props.version);
  const pendingXmlRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "failed"
  >("idle");

  const editor = useMemo(() => {
    const baseUrl =
      typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin;
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

  useEffect(() => {
    return startEditorWithRetry({
      onWaiting: () => {
        loadedWindowRef.current = null;
        setReady(false);
        setFrame(null);
      },
      onReady: () => setReady(true),
      start: (attempt) => {
        void probeEditorResource(
          editor.url,
          window.location.origin,
          attempt.signal,
        )
          .then(() => {
            if (attempt.signal.aborted) {
              return;
            }

            frameSequenceRef.current += 1;
            setFrame({
              id: frameSequenceRef.current,
              url: editor.url,
              attempt,
            });
          })
          .catch(attempt.unavailable);
      },
    });
  }, [editor.url, props.fileName, props.xml]);

  const attachFrame = useCallback(
    (node: HTMLIFrameElement | null) => {
      iframeRef.current = node;
      frameAttemptRef.current = node ? (frame?.attempt ?? null) : null;
    },
    [frame],
  );

  const postToEditor = useCallback(
    (message: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify(message),
        editor.origin,
      );
    },
    [editor.origin],
  );

  const flushSaves = useCallback(async () => {
    if (savingRef.current) {
      return;
    }

    savingRef.current = true;

    try {
      while (pendingXmlRef.current != null) {
        const xml = pendingXmlRef.current;
        pendingXmlRef.current = null;
        setSaveState("saving");

        versionRef.current = await props.onSave(xml, versionRef.current);
      }

      setSaveState("saved");
      window.setTimeout(
        () =>
          setSaveState((current) => (current === "saved" ? "idle" : current)),
        1_500,
      );
      postToEditor({
        action: "status",
        message: uiText("Gespeichert", "Saved"),
        modified: false,
      });
    } catch (error) {
      setSaveState("failed");
      const message =
        error instanceof Error
          ? error.message
          : uiText(
              "Das Diagramm konnte nicht gespeichert werden.",
              "The diagram could not be saved.",
            );
      props.onError(message);
      postToEditor({ action: "status", message, modified: true });
    } finally {
      savingRef.current = false;
    }
  }, [postToEditor, props.onError, props.onSave]);

  useEffect(() => {
    const receiveMessage = (message: MessageEvent) => {
      const attempt = frameAttemptRef.current;

      if (
        !attempt ||
        attempt.signal.aborted ||
        message.source !== iframeRef.current?.contentWindow ||
        message.origin !== editor.origin
      ) {
        return;
      }

      let event: DrawioEvent;

      try {
        event =
          typeof message.data === "string"
            ? JSON.parse(message.data)
            : message.data;
      } catch {
        return;
      }

      if (!event || typeof event !== "object") {
        return;
      }

      if (event.event === "init") {
        const editorWindow = iframeRef.current?.contentWindow;

        if (!editorWindow || loadedWindowRef.current === editorWindow) {
          return;
        }

        // Ignore duplicate init messages so original XML never replaces edits.
        loadedWindowRef.current = editorWindow;
        postToEditor({
          action: "load",
          autosave: props.canEdit ? 1 : 0,
          saveAndExit: "0",
          title: props.fileName,
          xml: props.xml,
        });
        attempt.ready();
        return;
      }

      if (
        props.canEdit &&
        (event.event === "autosave" || event.event === "save") &&
        event.xml
      ) {
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

  return (
    <div className="drawio-editor">
      {!ready && (
        <div className="drawio-editor__loading" role="status">
          <span className="ss-loading" aria-hidden="true">
            <span className="ss-spinner" />
          </span>
          {uiText("Diagramm wird geöffnet", "Opening diagram")}
        </div>
      )}

      {props.canEdit && saveState !== "idle" && (
        <div
          className={`drawio-editor__save-state is-${saveState}`}
          role="status"
        >
          {saveState === "saving" && uiText("Speichert …", "Saving…")}
          {saveState === "saved" && uiText("Gespeichert", "Saved")}
          {saveState === "failed" &&
            uiText("Speichern fehlgeschlagen", "Save failed")}
        </div>
      )}

      {frame && (
        <iframe
          key={frame.id}
          ref={attachFrame}
          className="drawio-editor__frame"
          src={frame.url}
          title={props.fileName}
          allow="clipboard-read; clipboard-write"
          aria-hidden={!ready}
          inert={!ready}
          style={{ visibility: ready ? "visible" : "hidden" }}
        />
      )}
    </div>
  );
}
