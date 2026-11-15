import { useGaebViewPreferences } from "~/hooks/useGaebViewPreferences";
import { MyCallout } from "./MyCallout";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import {
  client,
  projectFiles,
  gaebDocuments,
  API_ENDPOINT,
  reportClientError,
} from "~/lib/client";
import { errorHttpStatus } from "~/lib/errorTelemetry";
import { uiText, useI18n } from "~/lib/i18n";
import type { CommercialDetail } from "~/lib/commercial";
import { isWriteConflict } from "~/lib/data/atomicWrites";
import type { connectProtectedGaebLive } from "~/lib/data/gaebLive";
import type {
  DocumentEditorSession,
  DocumentContentView,
} from "~/lib/data/documentEditor";

export type GaebSavedRevision = {
  id: string;
  version: bigint;
  netAmount: string | null;
  title?: string;
};

type Session = DocumentEditorSession;
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
  const context = useSyncExternalStore(
    projectFiles.listenEditorContext,
    projectFiles.editorContext,
    projectFiles.editorContext,
  );
  const [opened, setOpened] = useState<{
    context: AbortSignal;
    session: Session;
    resource: string;
  } | null>(null);
  const resource = caseId
    ? `commercial:${caseId}:${documentId}`
    : `project:${projectId}:${fileId}`;
  const requested = useRef({ context, resource });
  requested.current = { context, resource };
  const assertCurrent = useCallback(() => {
    context.throwIfAborted();
    if (
      requested.current.context !== context ||
      requested.current.resource !== resource
    ) {
      throw new DOMException("Aborted", "AbortError");
    }
  }, [context, resource]);
  const session =
    opened?.context === context &&
    opened.resource === resource &&
    !context.aborted
      ? opened.session
      : null;
  const [failure, setFailure] = useState("");
  const [retry, setRetry] = useState(0);
  const view = useGaebViewPreferences(retry);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [frozenDraft, setFrozenDraft] = useState<{
    xml: string;
    fileName: string;
    partial: boolean;
  } | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [contentView, setContentView] = useState<
    DocumentContentView | undefined
  >();
  const [referenceXml, setReferenceXml] = useState<string>();
  const latest = useRef<Session | null>(null);
  const editor = useRef<{
    save: () => Promise<boolean>;
    snapshot?: () => string | undefined;
  }>(null);
  const live = useRef<
    | ReturnType<typeof connectXmlLive>
    | ReturnType<typeof connectProtectedGaebLive>
    | null
  >(null);
  const [remoteXml, setRemoteXml] = useState<string>();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [collaborationWarning, setCollaborationWarning] = useState(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onCaseRef = useRef(onCaseChange);
  onCaseRef.current = onCaseChange;
  const sharedFields = useMemo(
    () => new SharedFields(documentKind),
    [context, resource, documentKind],
  );
  useEffect(() => () => sharedFields.destroy(), [sharedFields]);
  const loadCurrent = useCallback(async (): Promise<Session> => {
    assertCurrent();
    let value: Session | null;
    if (caseId && documentId) {
      value = await gaebDocuments.open(caseId, documentId, context);
    } else {
      const [result, error] = await client.query(
        "projects.files.xmlContent",
        { projectId: projectId!, fileId: fileId! },
        { strategy: "network-only" },
      );
      if (error) {
        throw error;
      }
      value = result;
    }
    assertCurrent();
    if (!value) {
      throw new Error("load-failed");
    }
    if (!latest.current || value.version >= latest.current.version) {
      const previous = latest.current;
      if (value.frozen) {
        if (previous && !previous.frozen) {
          const draft =
            editor.current?.snapshot?.() ??
            sharedFields.project(previous.xml, previous.fileName);
          let unpublished = draft !== previous.xml;
          if (unpublished) {
            try {
              unpublished =
                mergeGaebDocuments(
                  previous.xml,
                  draft,
                  value.xml,
                  value.fileName,
                ) !== value.xml;
            } catch {
              // Keep a conflicting local draft separately from the final file.
            }
          }
          if (unpublished) {
            setFrozenDraft({
              xml: draft,
              fileName: previous.fileName,
              partial: previous.contentView?.access.complete === false,
            });
          }
        }
        live.current?.close();
        live.current = null;
        sharedFields.freeze(value.xml, value.fileName);
        if (!previous?.frozen || previous.version !== value.version) {
          setOpened({ context, session: value, resource });
        }
      } else {
        sharedFields.acknowledge(value.xml, value.fileName);
      }
      latest.current = value;
      setContentView(value.contentView);
    }
    return value;
  }, [
    projectId,
    fileId,
    caseId,
    documentId,
    assertCurrent,
    sharedFields,
    context,
    resource,
  ]);
  useEffect(() => {
    let active = true;
    setOpened(null);
    setContentView(undefined);
    setFailure("");
    setRemoteXml(undefined);
    setDirty(false);
    setFrozenDraft(null);
    setCollaborators([]);
    latest.current = null;
    void loadCurrent()
      .then((value) => {
        if (active) {
          setOpened({ context, session: value, resource });
          setCanEdit(value.canEdit);
          setReferenceXml(value.referenceXml ?? undefined);
        }
      })
      .catch(() => {
        if (active) {
          setFailure(
            uiText(
              "Die Datei konnte nicht geöffnet werden.",
              "The file could not be opened.",
            ),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [loadCurrent, retry]);
  useEffect(() => {
    if (!session) {
      return;
    }
    if (!session.livePath) {
      let active = true;
      setCollaborationWarning(false);
      const lifetime = new AbortController();
      void gaebDocuments
        .live({
          room: {
            scope: caseId ? `commercial:${caseId}` : `project:${projectId}`,
            document: documentId ?? fileId!,
          },
          initial: session,
          readableFacets: session.contentView?.access.readable,
          sharedFields,
          signal: AbortSignal.any([context, lifetime.signal]),
          onParticipants: setCollaborators,
          onStatus: setConnectionStatus,
          onRejectedMessage() {
            if (active) {
              setCollaborationWarning(true);
            }
          },
        })
        .then((connection) => {
          if (!active) {
            connection.close();
          } else {
            live.current = connection;
          }
        })
        .catch(() => {
          if (active) {
            setConnectionStatus("offline");
          }
        });
      const changed = () => {
        void loadCurrent()
          .then((value) => {
            if (!active) {
              return;
            }
            setRemoteXml(value.xml);
            setCanEdit(value.canEdit);
            setReferenceXml(value.referenceXml ?? undefined);
          })
          .catch(() => {
            if (active) {
              setConnectionStatus("offline");
            }
          });
      };
      const subscription = caseId
        ? client
            .streamQuery("commercial.cases.get", { id: caseId })
            .subscribe(([detail, error]) => {
              if (error) {
                setConnectionStatus("offline");
                return;
              }
              if (detail) {
                onCaseRef.current?.(detail);
              }
              changed();
            })
        : client
            .streamQuery(
              "projects.files.list",
              { projectId: projectId! },
              { strategy: "network-only" },
            )
            .subscribe(([, error]) => {
              if (error) {
                setConnectionStatus("offline");
              } else {
                changed();
              }
            });
      return () => {
        active = false;
        subscription.unsubscribe();
        live.current?.close();
        live.current = null;
        lifetime.abort();
      };
    }
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
        ) {
          return;
        }
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
  }, [session, loadCurrent, sharedFields, context]);
  const save = useCallback(
    async (source: string, base: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const liveProgress = await live.current?.flush();
        const liveSequence =
          typeof liveProgress === "string" ? liveProgress : undefined;
        const livePositions =
          typeof liveProgress === "object" ? liveProgress : undefined;
        assertCurrent();
        const current = latest.current;
        if (!current) {
          throw new Error("save-failed");
        }
        const merged = mergeGaebDocuments(
          sharedFields.project(base, current.fileName),
          sharedFields.project(source, current.fileName),
          sharedFields.project(current.xml, current.fileName),
          current.fileName,
        );
        if (
          merged !== source &&
          current.contentView &&
          !current.contentView.access.complete
        ) {
          if (!(await current.contentView.validate(merged, context)).valid) {
            throw new Error("merge-conflict");
          }
        } else if (merged !== source) {
          const document = new GaebDocument(merged, current.fileName);
          if (!(await validateGaebInBrowser(merged, document.identity)).valid) {
            throw new Error("merge-conflict");
          }
        }
        if (merged === current.xml && liveProgress === undefined) {
          return merged;
        }
        const [value, error] =
          caseId && documentId
            ? await client.mutate("commercial.documents.save", {
                caseId,
                id: documentId,
                version: current.version,
                xml: merged,
                netAmount:
                  current.contentView &&
                  !(
                    current.contentView.access.pricingSupported ??
                    current.contentView.access.complete
                  )
                    ? undefined
                    : gaebNetAmount(merged, current.referenceXml ?? undefined),
                liveSequence,
                livePositions,
              })
            : await client.mutate("projects.files.xmlSave", {
                projectId: projectId!,
                fileId: fileId!,
                version: current.version,
                xml: merged,
                liveSequence,
              });
        assertCurrent();
        if (value && !error) {
          const saved = { ...current, xml: merged, version: value.version };
          if (!latest.current || value.version >= latest.current.version) {
            latest.current = saved;
          }
          live.current?.saved(saved);
          sharedFields.acknowledge(merged, current.fileName);
          setRemoteXml(latest.current!.xml);
          onSavedRef.current?.({
            id: documentId ?? fileId!,
            version: value.version,
            netAmount:
              current.contentView &&
              !(
                current.contentView.access.pricingSupported ??
                current.contentView.access.complete
              )
                ? null
                : gaebNetAmount(merged, current.referenceXml ?? undefined),
            title: new GaebDocument(merged, current.fileName)
              .explicitDocumentTitle,
          });
          return merged;
        }
        if (
          !isWriteConflict(error) &&
          !error?.message.includes("changed in another editor")
        ) {
          throw error ?? new Error("save-failed");
        }
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
    if (caseId) {
      void client.invalidate("commercial.cases.list");
    }
    void client.invalidate(
      caseId ? "commercial.cases.get" : "projects.files.list",
    );
  };
  const requestClose = async () => {
    await view.flush();
    if (frozenDraft) {
      setDiscard(true);
      return;
    }
    const saved = editor.current ? await editor.current.save() : !dirty;
    if (saved) {
      close();
    } else {
      setDiscard(true);
    }
  };
  const downloadFrozenDraft = () => {
    if (!frozenDraft) return;
    assertCurrent();
    const data = frozenDraft.partial
      ? JSON.stringify(
          {
            format: "sortsys-gaeb-view-draft-v1",
            fileName: frozenDraft.fileName,
            xml: frozenDraft.xml,
          },
          null,
          2,
        )
      : frozenDraft.xml;
    const type = frozenDraft.partial ? "application/json" : "application/xml";
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = window.document.createElement("a");
    link.href = url;
    link.download = frozenDraft.partial
      ? `${frozenDraft.fileName}.teilansicht.json`
      : frozenDraft.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
        if (error || !result) {
          throw error ?? new Error("position-search-failed");
        }
        return result;
      }}
      key={`${resource}:${session.frozen ? session.version.toString() : "editable"}`}
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
          {collaborationWarning && (
            <MyCallout
              kind="warning"
              title={uiText("Gemeinsame Bearbeitung", "Collaboration")}
            >
              {uiText(
                "Eine nicht prüfbare gemeinsame Änderung wurde verworfen. Die übrigen Änderungen bleiben bearbeitbar.",
                "An unverifiable shared change was discarded. The remaining changes can still be edited.",
              )}
            </MyCallout>
          )}
          {frozenDraft && (
            <MyCallout
              kind="warning"
              title={uiText("Dokument abgeschlossen", "Document finalized")}
            >
              {uiText(
                "Das Dokument wurde inzwischen abgeschlossen. Noch nicht übernommene lokale Änderungen bleiben als separater Entwurf verfügbar.",
                "The document has been finalized. Local changes which were not included remain available as a separate draft.",
              )}
              <Button kind="ghost" size="sm" onClick={downloadFrozenDraft}>
                {uiText("Entwurf herunterladen", "Download draft")}
              </Button>
            </MyCallout>
          )}
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
      contentView={contentView}
      documentKind={documentKind}
      locale={locale === "en" ? "en" : "de"}
      onSave={save}
      onSaveError={(error, stage) => {
        void reportClientError({
          level:
            stage === "drafts" || stage === "validation" ? "warning" : "error",
          source: "gaeb.autosave",
          status: errorHttpStatus(error),
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
        modalHeading={
          frozenDraft
            ? uiText("Lokalen Entwurf sichern", "Keep the local draft")
            : uiText(
                "Speichern noch nicht abgeschlossen",
                "Saving has not completed",
              )
        }
        onRequestClose={() => setDiscard(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        <p>
          {frozenDraft
            ? uiText(
                "Der nicht übernommene Entwurf ist nur in diesem geöffneten Dialog verfügbar. Vor dem Schließen kann er heruntergeladen oder verworfen werden.",
                "The unpublished draft is available only in this open dialog. Download it or discard it before closing.",
              )
            : uiText(
                "Deine Änderungen konnten noch nicht automatisch gespeichert werden. Du kannst weiterarbeiten und es wird erneut versucht.",
                "Your changes could not be saved automatically yet. You can continue editing while autosave retries.",
              )}
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-4">
          <Button kind="ghost" onClick={() => setDiscard(false)}>
            {frozenDraft
              ? uiText("Zurück zum Dokument", "Back to document")
              : uiText("Weiter bearbeiten", "Continue editing")}
          </Button>
          {frozenDraft && (
            <Button onClick={downloadFrozenDraft}>
              {uiText("Entwurf herunterladen", "Download draft")}
            </Button>
          )}
          <Button kind="danger" onClick={close}>
            {uiText("Verwerfen", "Discard")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
