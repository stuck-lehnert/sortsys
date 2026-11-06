import { useGaebViewPreferences } from "~/hooks/useGaebViewPreferences";
import { MyCallout } from "./MyCallout";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button, Loading, Modal } from "@sortsys/react-components";
import {
  GaebEditor,
  GaebDocument,
  gaebNetAmount,
  mergeGaebDocuments,
  validateGaebInBrowser,
  connectXmlLive,
  SharedFields,
  type Collaborator,
  type ConnectionStatus,
} from "@sortsys/gaeb";
import "@sortsys/gaeb/styles.css";
import { useCommercialDialogFrame } from "./CommercialDialogFrame";
import { client, API_ENDPOINT, reportClientError } from "~/lib/client";
import { uiText, useI18n } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import type { CommercialDetail } from "~/lib/commercial";

export type GaebSavedRevision = {
  id: string;
  version: bigint;
  netAmount: string | null;
  title?: string;
};

type Session = QueryResult<"projects.files.xmlContent"> & {
  referenceXml?: string | null;
};
export type GaebWorkspaceHandle = {
  save: () => Promise<boolean>;
  requestClose: () => Promise<void>;
};
type Props = (
  | { projectId: string; fileId: string; caseId?: never; documentId?: never }
  | { caseId: string; documentId: string; projectId?: never; fileId?: never }
) & {
  fileName: string;
  onClose?: () => void;
  dialogTitle?: string;
  documentTitle?: string;
  projectTitle?: string;
  documentKind?: string;
  editable?: boolean;
  workspaceRef?: React.Ref<GaebWorkspaceHandle>;
  onSaved?: (revision: GaebSavedRevision) => void;
  onCaseChange?: (detail: CommercialDetail) => void;
  toolbarActions?: React.ReactNode;
  workflowNotice?: React.ReactNode;
};
export default function GaebFileModal({
  projectId,
  fileId,
  caseId,
  documentId,
  fileName,
  onClose,
  dialogTitle,
  documentTitle,
  projectTitle,
  documentKind,
  editable,
  workspaceRef,
  onSaved,
  onCaseChange,
  toolbarActions,
  workflowNotice,
}: Props) {
  const { locale } = useI18n();
  const frame = useCommercialDialogFrame();
  const [session, setSession] = useState<Session | null>(null);
  const [failure, setFailure] = useState("");
  const [retry, setRetry] = useState(0);
  const view = useGaebViewPreferences(retry);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [referenceXml, setReferenceXml] = useState<string>();
  const latest = useRef<Session | null>(null);
  const editor = useRef<{ save: () => Promise<boolean> }>(null);
  const live = useRef<ReturnType<typeof connectXmlLive> | null>(null);
  const [remoteXml, setRemoteXml] = useState<string>();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onCaseRef = useRef(onCaseChange);
  onCaseRef.current = onCaseChange;
  const [sharedFields] = useState(() => new SharedFields());
  useEffect(() => () => sharedFields.destroy(), [sharedFields]);
  const loadCurrent = useCallback(async (): Promise<Session> => {
    const [value, error] =
      caseId && documentId
        ? await client.query(
            "commercial.documents.get",
            { caseId, id: documentId },
            { strategy: "network-only" },
          )
        : await client.query(
            "projects.files.xmlContent",
            { projectId: projectId!, fileId: fileId! },
            { strategy: "network-only" },
          );
    if (error || !value) throw error ?? new Error("load-failed");
    if (!latest.current || value.version >= latest.current.version) {
      sharedFields.acknowledge(value.xml, value.fileName);
      latest.current = value;
    }
    return value;
  }, [projectId, fileId, caseId, documentId]);
  useEffect(() => {
    let active = true;
    setSession(null);
    setFailure("");
    setRemoteXml(undefined);
    setDirty(false);
    latest.current = null;
    void loadCurrent()
      .then((value) => {
        if (active) {
          setSession(value);
          setCanEdit(value.canEdit);
          setReferenceXml(value.referenceXml ?? undefined);
        }
      })
      .catch(() => {
        if (active)
          setFailure(
            uiText(
              "Die Datei konnte nicht geöffnet werden.",
              "The file could not be opened.",
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [loadCurrent, retry]);
  useEffect(() => {
    if (!session) return;
    const connection = connectXmlLive({
      initial: session,
      load: loadCurrent,
      url: (path) => {
        const url = new URL(`${API_ENDPOINT}${path}`, window.location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.href;
      },
      onSnapshot: (value) => {
        if (value.version >= (latest.current?.version ?? 0n)) {
          sharedFields.acknowledge(value.xml, session.fileName);
          setRemoteXml(value.xml);
          setCanEdit(value.canEdit);
          const ref = (value as Session).referenceXml;
          setReferenceXml(ref ?? undefined);
        }
      },
      onParticipants: setCollaborators,
      onStatus: setConnectionStatus,
      sharedFields,
      onCaseChange: (value) => {
        const detail = value as CommercialDetail;
        if (
          !detail.case ||
          !Array.isArray(detail.documents) ||
          detail.case.id !== caseId
        )
          return;
        const documents = detail.documents.map((document) => ({
          ...document,
          version: BigInt(document.version),
          sourceVersion:
            document.sourceVersion == null
              ? null
              : BigInt(document.sourceVersion),
          sourceCurrentVersion:
            document.sourceCurrentVersion == null
              ? null
              : BigInt(document.sourceCurrentVersion),
        }));
        onCaseRef.current?.({ ...detail, documents });
      },
    });
    live.current = connection;
    return () => {
      connection.close();
      live.current = null;
    };
  }, [session, loadCurrent]);
  const save = useCallback(
    async (source: string, base: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = latest.current;
        if (!current) throw new Error("save-failed");
        const merged = mergeGaebDocuments(
          sharedFields.project(base, current.fileName),
          sharedFields.project(source, current.fileName),
          sharedFields.project(current.xml, current.fileName),
          current.fileName,
        );
        if (merged !== source) {
          const document = new GaebDocument(merged, current.fileName);
          if (!(await validateGaebInBrowser(merged, document.identity)).valid)
            throw new Error("merge-conflict");
        }
        if (merged === current.xml) return merged;
        const [value, error] =
          caseId && documentId
            ? await client.mutate("commercial.documents.save", {
                caseId,
                id: documentId,
                version: current.version,
                xml: merged,
                netAmount: gaebNetAmount(merged),
              })
            : await client.mutate("projects.files.xmlSave", {
                projectId: projectId!,
                fileId: fileId!,
                version: current.version,
                xml: merged,
              });
        if (value && !error) {
          const saved = { ...current, xml: merged, version: value.version };
          if (!latest.current || value.version >= latest.current.version)
            latest.current = saved;
          live.current?.saved(saved);
          sharedFields.acknowledge(merged, current.fileName);
          setRemoteXml(latest.current!.xml);
          onSavedRef.current?.({
            id: documentId ?? fileId!,
            version: value.version,
            netAmount: gaebNetAmount(merged),
            title: new GaebDocument(merged, current.fileName)
              .explicitDocumentTitle,
          });
          return merged;
        }
        if (!error?.message.includes("changed in another editor"))
          throw error ?? new Error("save-failed");
        await loadCurrent();
      }
      throw new Error("save-conflict");
    },
    [projectId, fileId, caseId, documentId, loadCurrent],
  );
  useImperativeHandle(workspaceRef, () => ({
    save: async () => {
      await view.flush();
      return (await editor.current?.save()) ?? true;
    },
    requestClose: () => requestClose(),
  }));
  const close = () => {
    onClose?.();
    if (caseId) void client.invalidate("commercial.cases.list");
    void client.invalidate(
      caseId ? "commercial.cases.get" : "projects.files.list",
    );
  };
  const requestClose = async () => {
    await view.flush();
    if (!dirty || (await editor.current?.save())) close();
    else setDiscard(true);
  };
  const content = failure ? (
    <div className="gaeb-empty" role="alert">
      <p>{failure}</p>
      <Button onClick={() => setRetry((value) => value + 1)}>
        {uiText("Erneut versuchen", "Try again")}
      </Button>
    </div>
  ) : session && view.preferences ? (
    <GaebEditor
      searchPositions={async (query) => {
        const [result, error] = await client.query(
          "gaeb.positions.search",
          { query },
          { strategy: "network-only" },
        );
        if (error || !result)
          throw error ?? new Error("position-search-failed");
        return result;
      }}
      key={`${caseId ?? projectId}:${documentId ?? fileId}`}
      xml={session.xml}
      viewPreferences={view.preferences}
      onViewPreferencesChange={view.change}
      onPrint={async (xml, reference) => {
        const { exportGaebPdf } = await import("~/lib/gaebPrint");
        await exportGaebPdf(
          xml,
          session.fileName,
          locale === "de" ? "de" : "en",
          reference,
          { projectTitle, documentKind },
        );
      }}
      toolbarActions={toolbarActions}
      workflowNotice={
        <>
          {workflowNotice}
          {view.error && (
            <MyCallout
              kind="warning"
              title={uiText("Ansichtseinstellungen", "View preferences")}
            >
              {view.error}
              <Button
                kind="ghost"
                size="sm"
                onClick={() => {
                  void view.flush();
                  view.reload();
                }}
              >
                {uiText("Erneut versuchen", "Try again")}
              </Button>
            </MyCallout>
          )}
        </>
      }
      referenceXml={referenceXml}
      documentTitle={documentTitle}
      projectTitle={projectTitle}
      headingLabel={
        documentKind === "variation" &&
        ["83", "84"].includes(
          new GaebDocument(session.xml, session.fileName).phase,
        )
          ? uiText("Nachtragsangebot", "Variation offer")
          : undefined
      }
      fileName={session.fileName}
      canEdit={canEdit && editable !== false}
      locale={locale === "en" ? "en" : "de"}
      onSave={save}
      onSaveError={(error, stage) => {
        void reportClientError({
          level:
            stage === "drafts" || stage === "validation" ? "warning" : "error",
          source: "gaeb.autosave",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          metadata: {
            stage,
            caseId,
            documentId,
            projectId,
            fileId,
            version: String(latest.current?.version),
            versionType: typeof latest.current?.version,
          },
        });
      }}
      onDirtyChange={setDirty}
      editorRef={editor}
      remoteXml={remoteXml}
      collaborators={collaborators}
      sharedFields={sharedFields}
      onLiveSelection={(selection) => live.current?.selection(selection)}
      connectionStatus={connectionStatus}
      onActiveField={(field) => live.current?.field(field)}
      recoveryKey={
        session.recoveryScope
          ? `${session.recoveryScope}:${caseId ?? projectId}:${documentId ?? fileId}`
          : undefined
      }
    />
  ) : (
    <Loading
      className="commercial-editor-loading"
      active
      description={uiText("Dokument wird geöffnet …", "Opening document …")}
    />
  );
  return (
    <>
      {frame ? (
        content
      ) : (
        <Modal
          open
          passiveModal
          modalHeading={
            dialogTitle ??
            (!canEdit
              ? uiText("GAEB ansehen", "View GAEB")
              : uiText("GAEB bearbeiten", "Edit GAEB"))
          }
          modalLabel={fileName}
          closeButtonLabel={uiText("Schließen", "Close")}
          onRequestClose={() => void requestClose()}
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          className="project-files-office-modal commercial-editor-modal"
        >
          {content}
        </Modal>
      )}
      <Modal
        open={discard}
        passiveModal
        modalHeading={uiText(
          "Speichern noch nicht abgeschlossen",
          "Saving has not completed",
        )}
        onRequestClose={() => setDiscard(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        <p>
          {uiText(
            "Deine Änderungen konnten noch nicht automatisch gespeichert werden. Du kannst weiterarbeiten und es wird erneut versucht.",
            "Your changes could not be saved automatically yet. You can continue editing while autosave retries.",
          )}
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-4">
          <Button kind="ghost" onClick={() => setDiscard(false)}>
            {uiText("Weiter bearbeiten", "Continue editing")}
          </Button>
          <Button kind="danger" onClick={close}>
            {uiText("Verwerfen", "Discard")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
