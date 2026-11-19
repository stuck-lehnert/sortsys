import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loading } from "@sortsys/react-components";
import { RpcClientError } from "@sortsys/v2-client";
import { client, projectFiles } from "~/lib/client";
import { openCryptPad } from "~/lib/cryptpadBridge";
import type { OfficeDraftRecovery } from "~/lib/data/projectFiles";
import {
  OfficeDraftUnavailable,
  officeDraftFormat,
  readOfficeDraft,
} from "~/lib/officeDraft";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

function application(
  file: string,
): "doc" | "sheet" | "presentation" | "diagram" {
  const extension = file.toLowerCase().split(".").pop() ?? "";
  if (extension === "drawio") return "diagram";
  if (
    /^(?:csv|xls[xbm]?|xlt[xm]?|ods|ots|fods|numbers|et|ett|sxc)$/.test(
      extension,
    )
  )
    return "sheet";
  if (
    /^(?:ppt[xm]?|pps[xm]?|pot[xm]?|odp|otp|fodp|key|dps|dpt|sxi)$/.test(
      extension,
    )
  )
    return "presentation";
  return "doc";
}

/** File bytes, capabilities and saves stay in the browser. A policy reset
 * removes the iframe synchronously, before another room can receive data. */
export function ProtectedOfficeEditor({
  projectId,
  fileId,
}: {
  projectId: string;
  fileId: string;
}) {
  const context = useSyncExternalStore(
    projectFiles.listenEditorContext,
    projectFiles.editorContext,
    projectFiles.editorContext,
  );
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    context: AbortSignal;
    project: string;
    file: string;
    ready: boolean;
    error: boolean;
    connectionPaused: boolean;
    draftUnavailable: boolean;
    draft: OfficeDraftRecovery | null;
  } | null>(null);
  const [confirmedVersion, setConfirmedVersion] = useState<{
    context: AbortSignal;
    project: string;
    file: string;
  } | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<{
    context: AbortSignal;
    project: string;
    file: string;
    recovery: OfficeDraftRecovery;
  } | null>(null);
  const locale = currentLocaleTag().startsWith("de") ? "de" : "en";
  const current =
    state?.context === context &&
    state.project === projectId &&
    state.file === fileId &&
    !context.aborted
      ? state
      : null;
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const controller = new AbortController();
    let bridge: ReturnType<typeof openCryptPad> | undefined,
      ready = false,
      checking = false,
      checkAgain = false,
      epoch: string | null = null;
    let shared = false,
      contentVersion = "",
      canEdit = false;
    let review: OfficeDraftRecovery | null = null;
    let connectionPaused = false;
    let editorError = false;
    let retrySave = false;
    let reconnectDelay = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { unsubscribe(): void } | undefined;
    const frame = document.createElement("iframe");
    let recoveryFrame: HTMLIFrameElement | undefined;
    frame.className = "project-files-office-editor";
    frame.title = uiText("Dokumenteditor", "Document editor");
    frame.style.border = "0";
    frame.allow = "clipboard-read; clipboard-write; fullscreen";
    const live = () => {
      controller.signal.throwIfAborted();
      context.throwIfAborted();
    };
    const update = (
      ready: boolean,
      error: boolean,
      draftUnavailable = false,
      draft: OfficeDraftRecovery | null = review,
    ) => {
      if (!controller.signal.aborted)
        setState({
          context,
          project: projectId,
          file: fileId,
          ready,
          error,
          connectionPaused,
          draftUnavailable,
          draft,
        });
    };
    const dispose = () => {
      controller.abort();
      clearTimeout(reconnectTimer);
      subscription?.unsubscribe();
      bridge?.close();
      frame.remove();
      recoveryFrame?.remove();
    };
    const discardContext = () => {
      dispose();
      setState(null);
      setSelectedDraft(null);
      setConfirmedVersion(null);
    };
    context.addEventListener("abort", discardContext, { once: true });
    if (context.aborted) discardContext();
    update(false, false);
    const pauseConnection = () => {
      if (!ready || controller.signal.aborted) return;
      connectionPaused = true;
      update(true, editorError);
      if (reconnectTimer !== undefined) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void check();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
    const check = async () => {
      if (!ready || controller.signal.aborted) return;
      if (!navigator.onLine) {
        pauseConnection();
        return;
      }
      if (checking) {
        checkAgain = true;
        return;
      }
      checking = true;
      try {
        const status = await projectFiles.officeStatus(projectId, fileId);
        live();
        if (
          status.epoch !== epoch ||
          status.canEdit !== canEdit ||
          (!shared && status.epoch && status.contentVersion !== contentVersion)
        ) {
          dispose();
          setAttempt((value) => value + 1);
        } else if (!navigator.onLine) {
          pauseConnection();
        } else if (connectionPaused) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
          if (!retrySave) reconnectDelay = 1000;
          connectionPaused = false;
          update(true, editorError);
          if (retrySave && !editorError) {
            retrySave = false;
            bridge?.saveCurrent();
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (RpcClientError.isUnavailable(error)) {
            pauseConnection();
            return;
          }
          dispose();
          setState({
            context,
            project: projectId,
            file: fileId,
            ready: false,
            error: true,
            connectionPaused: false,
            draftUnavailable: false,
            draft: null,
          });
        }
      } finally {
        checking = false;
        if (checkAgain) {
          checkAgain = false;
          void check();
        }
      }
    };
    if (!controller.signal.aborted) {
      const reconnect = () => void check();
      window.addEventListener("online", reconnect);
      window.addEventListener("offline", pauseConnection);
      controller.signal.addEventListener(
        "abort",
        () => {
          window.removeEventListener("online", reconnect);
          window.removeEventListener("offline", pauseConnection);
        },
        { once: true },
      );
    }
    void (async () => {
      live();
      const session = await projectFiles.office(
        projectId,
        fileId,
        AbortSignal.any([context, controller.signal]),
      );
      live();
      epoch = session.epoch;
      contentVersion = session.contentVersion;
      canEdit = session.canEdit;
      let content = session.document;
      let fileName = session.fileName;
      let recovered: OfficeDraftRecovery | undefined;
      if (session.previousSession) {
        const useConfirmed =
          confirmedVersion?.context === context &&
          confirmedVersion.project === projectId &&
          confirmedVersion.file === fileId;
        const useSelected =
          !useConfirmed &&
          selectedDraft?.context === context &&
          selectedDraft.project === projectId &&
          selectedDraft.file === fileId &&
          selectedDraft.recovery.epoch === session.previousSession.epoch &&
          selectedDraft.recovery.version === session.previousSession.version;
        if (useSelected) {
          content = selectedDraft.recovery.document;
          fileName = selectedDraft.recovery.fileName ?? fileName;
        } else if (!useConfirmed) {
          recoveryFrame = document.createElement("iframe");
          recoveryFrame.className = frame.className;
          recoveryFrame.title = uiText(
            "Bearbeitungsstand wird übernommen",
            "Recovering document draft",
          );
          recoveryFrame.style.border = "0";
          host.replaceChildren(recoveryFrame);
          content = await readOfficeDraft({
            iframe: recoveryFrame,
            editorOrigin: session.editorOrigin,
            document: content,
            fileName,
            application: application(fileName),
            locale,
            viewKey: session.previousSession.viewKey,
            signal: AbortSignal.any([context, controller.signal]),
          });
          live();
          fileName = officeDraftFormat(
            fileName,
            application(fileName),
          ).fileName;
          recoveryFrame.remove();
          recoveryFrame = undefined;
        }
        recovered = {
          epoch: session.previousSession.epoch,
          version: session.previousSession.version,
          document: content,
          fileName: useConfirmed ? undefined : fileName,
        };
        if (!useConfirmed && !useSelected) review = recovered;
      }
      host.replaceChildren(frame);
      bridge = openCryptPad({
        iframe: frame,
        editorOrigin: session.editorOrigin,
        document: content,
        fileName,
        application: application(fileName),
        locale,
        canEdit: session.canEdit && !review,
        accessKey: review ? undefined : session.accessKey,
        viewKey: review ? undefined : session.viewKey,
        publishSession: async (previous, proposed) => {
          live();
          if (review)
            throw new Error("Draft review cannot publish an editor room");
          const committed = await projectFiles.publishOfficeSession(
            projectId,
            fileId,
            previous,
            proposed,
            recovered,
          );
          live();
          epoch = committed.epoch;
          return committed;
        },
        save: async (document) => {
          live();
          if (!epoch || !session.canEdit || review)
            throw new Error("Editor cannot save");
          await projectFiles.saveOffice(projectId, fileId, epoch, document);
          live();
          reconnectDelay = 1000;
        },
        onReady: () => {
          if (!controller.signal.aborted) {
            ready = true;
            editorError = false;
            update(true, false, false, review);
            void check();
          }
        },
        onError: () => {
          if (!controller.signal.aborted) {
            editorError = true;
            update(ready, true);
          }
        },
        onSaveError: (error) => {
          if (controller.signal.aborted) return;
          if (RpcClientError.isUnavailable(error)) {
            retrySave = true;
            pauseConnection();
          } else {
            editorError = true;
            update(ready, true);
            void check();
          }
        },
        onSession: (value) => {
          shared = value;
        },
      });
      subscription = client
        .streamQuery(
          "projects.files.list",
          { projectId },
          { strategy: "network-only" },
        )
        .subscribe(() => {
          void check();
        });
    })().catch((error) => {
      if (!controller.signal.aborted) {
        bridge?.close();
        frame.remove();
        recoveryFrame?.remove();
        update(false, true, error instanceof OfficeDraftUnavailable);
      }
    });
    return () => {
      context.removeEventListener("abort", discardContext);
      dispose();
    };
  }, [
    projectId,
    fileId,
    locale,
    attempt,
    context,
    confirmedVersion,
    selectedDraft,
  ]);

  const interactive =
    current?.ready && !current.error && !current.connectionPaused;
  return (
    <div className="project-files-office-editor-shell">
      {interactive && current?.draft && (
        <div
          className="project-files-office-draft-review"
          role="region"
          aria-label={uiText(
            "Bearbeitungsstand prüfen",
            "Review document draft",
          )}
        >
          <p>
            {uiText(
              "Vorschau des nicht bestätigten Bearbeitungsstands.",
              "Preview of the unconfirmed editing draft.",
            )}
          </p>
          <MyButton
            kind="primary"
            onClick={() => {
              if (!current.draft) return;
              setSelectedDraft({
                context,
                project: projectId,
                file: fileId,
                recovery: current.draft,
              });
            }}
          >
            {uiText("Bearbeitungsstand übernehmen", "Use editing draft")}
          </MyButton>
          <MyButton
            kind="tertiary"
            onClick={() =>
              setConfirmedVersion({
                context,
                project: projectId,
                file: fileId,
              })
            }
          >
            {uiText("Gespeicherten Dateistand öffnen", "Open saved file")}
          </MyButton>
        </div>
      )}
      {!current?.ready && !current?.error && (
        <div className="project-files-office-loading" role="status">
          <Loading
            active
            description={uiText(
              "Dokument wird geöffnet …",
              "Opening document…",
            )}
          />
        </div>
      )}
      {current?.error && (
        <div className="project-files-office-status" role="alert">
          <MyCallout color="red">
            {current.draftUnavailable
              ? uiText(
                  "Der letzte Bearbeitungsstand ist derzeit nicht erreichbar. Beim Öffnen des gespeicherten Dateistands werden diese Änderungen nicht übernommen.",
                  "The latest editing draft is currently unavailable. Opening the saved file will not include those changes.",
                )
              : uiText(
                  "Das Dokument konnte nicht geöffnet oder gespeichert werden.",
                  "The document could not be opened or saved.",
                )}
          </MyCallout>
          <MyButton
            kind="tertiary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {uiText("Erneut versuchen", "Try again")}
          </MyButton>
          {current.draftUnavailable && (
            <MyButton
              kind="tertiary"
              onClick={() =>
                setConfirmedVersion({
                  context,
                  project: projectId,
                  file: fileId,
                })
              }
            >
              {uiText("Gespeicherten Dateistand öffnen", "Open saved file")}
            </MyButton>
          )}
        </div>
      )}
      {current?.connectionPaused && !current.error && (
        <div className="project-files-office-status" role="status">
          <MyCallout color="yellow">
            {uiText(
              "Verbindung unterbrochen. Der Editor bleibt offen und wartet auf die erneute Rechteprüfung.",
              "Connection interrupted. The editor stays open while access is checked again.",
            )}
          </MyCallout>
        </div>
      )}
      <div
        ref={container}
        className="project-files-office-editor"
        aria-hidden={!interactive}
        inert={!interactive}
        style={{ visibility: current?.ready ? "visible" : "hidden" }}
      />
    </div>
  );
}
