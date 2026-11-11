import { Loading, Modal } from "@sortsys/react-components";
import { useCallback, useEffect, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client, projectFiles } from "~/lib/client";
import { openCryptPad } from "~/lib/cryptpadBridge";
import { Icons } from "~/lib/icons";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { downloadBlob } from "~/lib/utils";

type ExportOfficeSession = { origin: string; document: Blob; context: AbortSignal };

function ExportOfficeModal({ fileName, hide, session, visible }: {
  fileName: string; hide: () => void; session: ExportOfficeSession; visible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const bridge = useRef<ReturnType<typeof openCryptPad> | undefined>(undefined);
  const latest = useRef(session.document);
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [exporting, setExporting] = useState(false);
  const onClose = useRef(hide); onClose.current = hide;
  const close = useCallback(() => onClose.current(), []);
  const locale = currentLocaleTag().startsWith("de") ? "de" : "en";
  useEffect(() => {
    if (!visible || !host.current) return;
    let active = true;
    const frame = document.createElement("iframe");
    frame.className = "project-files-office-editor"; frame.title = uiText("Excel-Export", "Excel export");
    frame.style.border = "0"; frame.allow = "clipboard-read; clipboard-write; fullscreen";
    const live = () => { session.context.throwIfAborted(); if (!active || session.context !== projectFiles.context()) throw new DOMException("Export closed", "AbortError"); };
    const dispose = () => { active = false; bridge.current?.close(); bridge.current = undefined; frame.remove(); };
    const cancel = () => { dispose(); close(); };
    session.context.addEventListener("abort", cancel, { once: true });
    setReady(false); setError(false);
    try {
      live(); host.current.replaceChildren(frame);
      bridge.current = openCryptPad({ iframe: frame, editorOrigin: session.origin, document: latest.current,
        fileName, application: "sheet", locale, canEdit: true, persistentSession: false,
        // An export is an unsaved browser workspace. Its fresh room capability
        // is never published in project metadata or sent to the sortsys API.
        publishSession: async (_previous, proposed) => { live(); return proposed; },
        save: async document => { live(); latest.current = document; },
        onReady: () => { if (active) setReady(true); },
        onError: () => { if (active) setError(true); },
      });
    } catch { dispose(); if (!session.context.aborted) setError(true); }
    return () => { session.context.removeEventListener("abort", cancel); dispose(); };
  }, [fileName, session, visible, close, locale]);
  const download = async () => {
    const editor = bridge.current; if (!editor || exporting) return;
    setExporting(true);
    try {
      const document = await editor.export("xlsx"); session.context.throwIfAborted();
      if (bridge.current !== editor || session.context !== projectFiles.context()) return;
      downloadBlob(document, fileName);
    } catch { if (!session.context.aborted && bridge.current === editor) setError(true); }
    finally { setExporting(false); }
  };
  return <Modal open={visible} passiveModal modalHeading={fileName} modalLabel={uiText("Excel-Export", "Excel export")}
    closeButtonLabel={uiText("Schließen", "Close")} onRequestClose={close} edgeToEdge data-fullheight="true" data-fullwidth="true" className="project-files-office-modal">
    <div className="flex shrink-0 justify-end px-3 py-2">
      <MyButton disabled={!ready || exporting} onClick={() => { void download(); }} renderIcon={Icons.Download}>
        {uiText("Herunterladen", "Download")}
      </MyButton>
    </div>
    {error && <div className="project-files-office-status"><MyCallout icon={Icons.Deny} color="red">
      {uiText("Der Excel-Export konnte nicht geöffnet oder heruntergeladen werden.", "The Excel export could not be opened or downloaded.")}
    </MyCallout></div>}
    <div className="project-files-office-editor-shell">
      {!ready && !error && <div className="project-files-office-loading" role="status"><Loading active description={uiText("Tabelle wird geöffnet …", "Opening spreadsheet…")} /></div>}
      <div ref={host} className="project-files-office-editor" aria-hidden={!ready} inert={!ready} style={{ visibility: ready ? "visible" : "hidden" }} />
    </div>
  </Modal>;
}

function showExportError(modals: MyModalsInterface) {
  modals.showDefault({
    content: () => <MyCallout icon={Icons.Deny} color="red">{uiText("Der Excel-Export konnte nicht geöffnet werden.", "The Excel export could not be opened.")}</MyCallout>,
    modalProps: () => ({ passiveModal: true, modalHeading: uiText("Excel-Export fehlgeschlagen", "Excel export failed"), closeButtonLabel: uiText("Schließen", "Close") }),
  });
}

export async function openExcelExport(modals: MyModalsInterface, blob: Blob, fileName: string) {
  const context = projectFiles.context();
  try {
    context.throwIfAborted();
    const [config, error] = await client.query("zerotrust.editors.config", undefined, { strategy: "network-only" });
    context.throwIfAborted();
    if (context !== projectFiles.context()) return;
    if (error || !config?.officeOrigin) throw new Error("Private editor unavailable");
    const session = { origin: config.officeOrigin, document: blob, context };
    modals.show(({ visible, hide }) => <ExportOfficeModal fileName={fileName} hide={hide} session={session} visible={visible} />);
  } catch { if (!context.aborted && context === projectFiles.context()) showExportError(modals); }
}
