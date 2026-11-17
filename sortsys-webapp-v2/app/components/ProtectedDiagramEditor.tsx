import { useCallback, useEffect, useRef } from "react";
import { Loading } from "@sortsys/react-components";
import type { QueryResult } from "@sortsys/v2-client";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { DrawioEditor } from "./DrawioEditor";
import { MyCallout } from "./MyCallout";
import { useProtectedState } from "~/hooks/useProtectedState";

type DiagramSession = QueryResult<"projects.files.drawioConfig">;
type Lifetime = {
  resource: string;
  context: AbortSignal;
  controller: AbortController;
};

export function ProtectedDiagramEditor({
  projectId,
  fileId,
  onClose,
}: {
  projectId: string;
  fileId: string;
  onClose: () => void;
}) {
  const resource = `${projectId}:${fileId}`;
  const [opened, setOpened, context] = useProtectedState<{
    resource: string;
    value: DiagramSession;
  } | null>(null);
  const [failure, setFailure] = useProtectedState<{
    resource: string;
    message: string;
  } | null>(null);
  const lifetime = useRef<Lifetime | null>(null);
  const requested = useRef({ context, resource });
  requested.current = { context, resource };
  const session = opened?.resource === resource ? opened.value : null;
  const error = failure?.resource === resource ? failure.message : null;

  const assertCurrent = useCallback(() => {
    context.throwIfAborted();
    const current = lifetime.current;
    if (
      !current ||
      current.context !== context ||
      current.resource !== resource ||
      requested.current.context !== context ||
      requested.current.resource !== resource
    ) {
      throw new DOMException("Diagram session changed", "AbortError");
    }
    current.controller.signal.throwIfAborted();
  }, [context, resource]);

  useEffect(() => {
    const current: Lifetime = {
      resource,
      context,
      controller: new AbortController(),
    };
    lifetime.current = current;
    const dispose = () => current.controller.abort();
    context.addEventListener("abort", dispose, { once: true });
    setOpened(null);
    setFailure(null);
    async function loadSession() {
      try {
        current.controller.signal.throwIfAborted();
        assertCurrent();
        const [value, failure] = await client.query(
          "projects.files.drawioConfig",
          { projectId, fileId },
          { strategy: "network-only" },
        );
        current.controller.signal.throwIfAborted();
        assertCurrent();
        if (failure || !value) {
          throw (
            failure ??
            new Error(
              uiText(
                "Das Diagramm konnte nicht geöffnet werden.",
                "The diagram could not be opened.",
              ),
            )
          );
        }
        setOpened({ resource, value });
      } catch (failure) {
        if (!current.controller.signal.aborted && !context.aborted)
          setFailure({
            resource,
            message:
              failure instanceof Error
                ? failure.message
                : uiText(
                    "Die Datei konnte nicht geöffnet werden.",
                    "The file could not be opened.",
                  ),
          });
      }
    }
    void loadSession();
    return () => {
      dispose();
      context.removeEventListener("abort", dispose);
    };
  }, [
    projectId,
    fileId,
    resource,
    context,
    assertCurrent,
    setOpened,
    setFailure,
  ]);

  const saveDrawio = useCallback(
    async (xml: string, version: bigint) => {
      // Already captured edits may finish after normal closing or switching
      // files. Their original resource and access context remain binding.
      context.throwIfAborted();
      const [result, failure] = await client.mutate(
        "projects.files.drawioSave",
        { projectId, fileId, xml, version },
        { signal: context },
      );
      context.throwIfAborted();
      if (failure || !result) {
        throw (
          failure ??
          new Error(
            uiText(
              "Das Diagramm konnte nicht gespeichert werden.",
              "The diagram could not be saved.",
            ),
          )
        );
      }
      return result.version;
    },
    [projectId, fileId, context],
  );

  const reportError = useCallback(
    (message: string) => {
      try {
        assertCurrent();
      } catch {
        return;
      }
      setFailure({ resource, message });
    },
    [resource, assertCurrent, setFailure],
  );
  const close = useCallback(() => {
    try {
      assertCurrent();
    } catch {
      return;
    }
    onClose();
  }, [assertCurrent, onClose]);

  return (
    <>
      {error && (
        <div className="project-files-office-status" role="alert">
          <MyCallout color="red">{error}</MyCallout>
        </div>
      )}
      {!session && !error && (
        <div className="project-files-office-status">
          <Loading
            active
            withOverlay={false}
            description={uiText("Vorschau wird geladen …", "Loading preview …")}
          />
        </div>
      )}
      {session && (
        <DrawioEditor
          editorUrl={session.editorUrl}
          fileName={session.fileName}
          xml={session.xml}
          version={session.version}
          canEdit={session.canEdit}
          onSave={saveDrawio}
          onClose={close}
          onError={reportError}
        />
      )}
    </>
  );
}
