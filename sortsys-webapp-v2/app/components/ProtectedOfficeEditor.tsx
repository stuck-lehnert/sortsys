import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loading } from "@sortsys/react-components";
import { client, projectFiles } from "~/lib/client";
import { openCryptPad } from "~/lib/cryptpadBridge";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

function application(file: string): "doc" | "sheet" | "presentation" {
  const extension = file.toLowerCase().split(".").pop() ?? "";
  if (/^(?:csv|xls[xbm]?|xlt[xm]?|ods|ots|fods|numbers|et|ett|sxc)$/.test(extension)) return "sheet";
  if (/^(?:ppt[xm]?|pps[xm]?|pot[xm]?|odp|otp|fodp|key|dps|dpt|sxi)$/.test(extension)) return "presentation";
  return "doc";
}

/** File bytes, capabilities and saves stay in the browser. A policy reset
 * removes the iframe synchronously, before another room can receive data. */
export function ProtectedOfficeEditor({ projectId, fileId }: { projectId: string; fileId: string }) {
  const context = useSyncExternalStore(projectFiles.listenEditorContext, projectFiles.editorContext, projectFiles.editorContext);
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ context: AbortSignal; project: string; file: string; ready: boolean; error: boolean } | null>(null);
  const locale = currentLocaleTag().startsWith("de") ? "de" : "en";
  const current = state?.context === context && state.project === projectId && state.file === fileId && !context.aborted ? state : null;
  useEffect(() => {
    const host = container.current; if (!host) return;
    const controller = new AbortController();
    let bridge: ReturnType<typeof openCryptPad> | undefined, ready = false, checking = false, checkAgain = false, epoch: string | null = null;
    let shared = false, contentVersion = "";
    let subscription: { unsubscribe(): void } | undefined;
    const frame = document.createElement("iframe");
    frame.className = "project-files-office-editor"; frame.title = uiText("Office-Dokument", "Office document");
    frame.style.border = "0"; frame.allow = "clipboard-read; clipboard-write; fullscreen";
    const live = () => { controller.signal.throwIfAborted(); context.throwIfAborted(); };
    const update = (ready: boolean, error: boolean) => { if (!controller.signal.aborted) setState({ context, project: projectId, file: fileId, ready, error }); };
    const dispose = () => { controller.abort(); subscription?.unsubscribe(); bridge?.close(); frame.remove(); };
    context.addEventListener("abort", dispose, { once: true });
    if (context.aborted) dispose();
    update(false, false);
    const check = async () => {
      if (!ready || controller.signal.aborted) return;
      if (checking) { checkAgain = true; return; }
      checking = true;
      try {
        const status = await projectFiles.officeStatus(projectId, fileId); live();
        if (status.epoch !== epoch || !shared && status.epoch && status.contentVersion !== contentVersion) { dispose(); setAttempt(value => value + 1); }
      } catch { if (!controller.signal.aborted) { dispose(); setState({ context, project: projectId, file: fileId, ready: false, error: true }); } }
      finally { checking = false; if (checkAgain) { checkAgain = false; void check(); } }
    };
    void (async () => {
      live(); const session = await projectFiles.office(projectId, fileId, AbortSignal.any([context, controller.signal])); live(); epoch = session.epoch; contentVersion = session.contentVersion;
      host.replaceChildren(frame);
      bridge = openCryptPad({ iframe: frame, editorOrigin: session.editorOrigin, document: session.document, fileName: session.fileName,
        application: application(session.fileName), locale, canEdit: session.canEdit, accessKey: session.accessKey, viewKey: session.viewKey,
        publishSession: async (previous, proposed) => {
          live(); const committed = await projectFiles.publishOfficeSession(projectId, fileId, previous, proposed); live(); epoch = committed.epoch; return committed;
        },
        save: async document => {
          live(); if (!epoch || !session.canEdit) throw new Error("Editor cannot save");
          await projectFiles.saveOffice(projectId, fileId, epoch, document); live();
        },
        onReady: () => { if (!controller.signal.aborted) { ready = true; update(true, false); void check(); } },
        onError: () => { if (!controller.signal.aborted) update(ready, true); },
        onSession: value => { shared = value; },
      });
      subscription = client.streamQuery("projects.files.list", { projectId }, { strategy: "network-only" }).subscribe(() => { void check(); });
    })().catch(() => { if (!controller.signal.aborted) { bridge?.close(); frame.remove(); update(false, true); } });
    return () => { context.removeEventListener("abort", dispose); dispose(); };
  }, [projectId, fileId, locale, attempt, context]);

  return <div className="project-files-office-editor-shell">
    {!current?.ready && !current?.error && <div className="project-files-office-loading" role="status">
      <Loading active description={uiText("Dokument wird geöffnet …", "Opening document…")} />
    </div>}
    {current?.error && <div className="project-files-office-status" role="alert">
      <MyCallout color="red">{uiText("Das Dokument konnte nicht geöffnet oder gespeichert werden.", "The document could not be opened or saved.")}</MyCallout>
      <MyButton kind="tertiary" onClick={() => setAttempt(value => value + 1)}>{uiText("Erneut versuchen", "Try again")}</MyButton>
    </div>}
    <div ref={container} className="project-files-office-editor" aria-hidden={!current?.ready} inert={!current?.ready} style={{ visibility: current?.ready ? "visible" : "hidden" }} />
  </div>;
}
