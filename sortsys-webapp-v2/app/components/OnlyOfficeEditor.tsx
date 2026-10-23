import { useEffect, useId, useRef, useState } from "react";
import { probeEditorResource, startEditorWithRetry } from "~/lib/editorStartup";
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
  if (window.DocsAPI) {
    return Promise.resolve();
  }

  const pending = pendingScripts.get(apiUrl);

  if (pending) {
    return pending;
  }

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-onlyoffice-api="${CSS.escape(apiUrl)}"]`,
    );
    const script = existing ?? document.createElement("script");
    const timeout = window.setTimeout(() => {
      fail(new Error("Editor API load timed out"));
    }, 10_000);

    function cleanup() {
      window.clearTimeout(timeout);
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    }

    function fail(error: Error) {
      cleanup();
      script.remove();
      reject(error);
    }

    function handleLoad() {
      cleanup();

      if (window.DocsAPI) {
        resolve();
        return;
      }

      fail(
        new Error(
          uiText(
            "Euro-Office wurde nicht initialisiert.",
            "Euro-Office did not initialize.",
          ),
        ),
      );
    }

    function handleError() {
      fail(
        new Error(
          uiText(
            "Euro-Office konnte nicht geladen werden.",
            "Euro-Office could not be loaded.",
          ),
        ),
      );
    }

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
  const callbacks = useRef({ onError, onRequestClose });
  const elementId = `onlyoffice-editor-${reactId.replaceAll(":", "")}`;
  callbacks.current = { onError, onRequestClose };

  useEffect(() => {
    const editorContainer = editorContainerRef.current;

    if (!editorContainer) {
      return;
    }

    return startEditorWithRetry({
      onWaiting: () => setIsReady(false),
      onReady: () => setIsReady(true),
      start: (attempt) => {
        let editor: OnlyOfficeEditorInstance | null = null;

        // DocsAPI replaces its target with an iframe. Keep that node outside
        // React's tree, including when an unavailable editor needs a fresh try.
        const editorTarget = document.createElement("div");
        editorTarget.id = elementId;
        editorTarget.className = "project-files-office-editor";
        editorContainer.replaceChildren(editorTarget);

        attempt.signal.addEventListener(
          "abort",
          () => {
            try {
              editor?.destroyEditor();
            } finally {
              editorContainer.replaceChildren();
            }
          },
          { once: true },
        );

        void probeEditorResource(apiUrl, window.location.origin, attempt.signal)
          .then(() => {
            if (attempt.signal.aborted) {
              return;
            }

            return loadOnlyOfficeApi(apiUrl);
          })
          .then(() => {
            if (attempt.signal.aborted || !window.DocsAPI) {
              return;
            }

            editor = new window.DocsAPI.DocEditor(elementId, {
              ...config,
              events: {
                onAppReady: attempt.ready,
                onError: (event: OnlyOfficeEvent) => {
                  if (attempt.signal.aborted) {
                    return;
                  }

                  const message =
                    event.data?.errorDescription ??
                    uiText(
                      `Euro-Office-Fehler ${event.data?.errorCode ?? "unbekannt"}`,
                      `Euro-Office error ${event.data?.errorCode ?? "unknown"}`,
                    );
                  callbacks.current.onError(message);
                },
                onRequestClose: () => {
                  if (!attempt.signal.aborted) {
                    callbacks.current.onRequestClose();
                  }
                },
              },
            });
          })
          .catch(attempt.unavailable);
      },
    });
  }, [apiUrl, config, elementId]);

  return (
    <div className="project-files-office-editor-shell">
      <div
        className="project-files-office-loading"
        role="status"
        aria-label={uiText("Euro-Office wird geladen", "Loading Euro-Office")}
        hidden={isReady}
      >
        <span className="ss-loading" aria-hidden="true">
          <span className="ss-spinner" />
        </span>
      </div>

      <div
        ref={editorContainerRef}
        className="project-files-office-editor"
        aria-hidden={!isReady}
        inert={!isReady}
        style={{ visibility: isReady ? "visible" : "hidden" }}
      />
    </div>
  );
}
