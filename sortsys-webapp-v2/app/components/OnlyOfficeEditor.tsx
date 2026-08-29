import { useEffect, useId, useRef, useState } from "react";
import { uiText } from "~/lib/i18n";

type OnlyOfficeEditorConfig = Record<string, unknown>;

type OnlyOfficeEditorProps = {
  apiUrl: string;
  config: OnlyOfficeEditorConfig;
  onError: (message: string) => void;
  onRequestClose: () => void;
};

type OnlyOfficeEvent = {
  data?: {
    errorCode?: number;
    errorDescription?: string;
  };
};

type OnlyOfficeEditorInstance = {
  destroyEditor: () => void;
};

type OnlyOfficeApi = {
  DocEditor: new (
    elementId: string,
    config: OnlyOfficeEditorConfig,
  ) => OnlyOfficeEditorInstance;
};

declare global {
  interface Window {
    DocsAPI?: OnlyOfficeApi;
  }
}

const pendingScripts = new Map<string, Promise<void>>();

function loadOnlyOfficeApi(apiUrl: string) {
  if (window.DocsAPI) return Promise.resolve();

  const pending = pendingScripts.get(apiUrl);
  if (pending) return pending;

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-onlyoffice-api="${CSS.escape(apiUrl)}"]`,
    );

    const script = existing ?? document.createElement("script");

    const handleLoad = () => {
      if (window.DocsAPI) {
        resolve();
        return;
      }

      script.remove();
      reject(new Error(uiText(
        "ONLYOFFICE wurde nicht initialisiert.",
        "ONLYOFFICE did not initialize.",
      )));
    };

    const handleError = () => {
      script.remove();
      reject(new Error(uiText(
        "ONLYOFFICE konnte nicht geladen werden.",
        "ONLYOFFICE could not be loaded.",
      )));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });

    if (!existing) {
      script.src = apiUrl;
      script.async = true;
      script.dataset.onlyofficeApi = apiUrl;
      document.head.append(script);
    }
  });

  pendingScripts.set(apiUrl, promise);

  promise.catch(() => {
    pendingScripts.delete(apiUrl);
  });

  return promise;
}

export function OnlyOfficeEditor({
  apiUrl,
  config,
  onError,
  onRequestClose,
}: OnlyOfficeEditorProps) {
  const reactId = useId();
  const [isReady, setIsReady] = useState(false);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const elementId = `onlyoffice-editor-${reactId.replaceAll(":", "")}`;

  useEffect(() => {
    const editorContainer = editorContainerRef.current;
    if (!editorContainer) return;

    let disposed = false;
    let editor: OnlyOfficeEditorInstance | null = null;

    // DocsAPI replaces its target node with an iframe. Create that target
    // outside React's tree so React never tries to reconcile a removed node.
    const editorTarget = document.createElement("div");
    editorTarget.id = elementId;
    editorTarget.className = "project-files-office-editor";
    editorContainer.replaceChildren(editorTarget);

    setIsReady(false);

    loadOnlyOfficeApi(apiUrl)
      .then(() => {
        if (disposed || !window.DocsAPI) return;

        editor = new window.DocsAPI.DocEditor(elementId, {
          ...config,
          events: {
            onAppReady: () => {
              if (!disposed) setIsReady(true);
            },
            onError: (event: OnlyOfficeEvent) => {
              if (disposed) return;

              const message = event.data?.errorDescription
                ?? uiText(
                  `ONLYOFFICE-Fehler ${event.data?.errorCode ?? "unbekannt"}`,
                  `ONLYOFFICE error ${event.data?.errorCode ?? "unknown"}`,
                );

              onError(message);
            },
            onRequestClose: () => {
              if (!disposed) onRequestClose();
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;

        onError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      editor?.destroyEditor();
      editorContainer.replaceChildren();
    };
  }, [apiUrl, config, elementId, onError, onRequestClose]);

  return (
    <div className="project-files-office-editor-shell">
      <div
        className="project-files-office-loading"
        role="status"
        hidden={isReady}
      >
        <span className="ss-loading" aria-hidden="true">
          <span className="ss-spinner" />
        </span>
      </div>

      <div ref={editorContainerRef} className="project-files-office-editor" />
    </div>
  );
}
