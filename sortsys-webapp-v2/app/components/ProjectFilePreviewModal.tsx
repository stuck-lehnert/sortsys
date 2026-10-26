import type { QueryResult } from "@sortsys/v2-client";
import { Loading, Modal } from "@sortsys/react-components";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { from } from "rxjs";
import { DrawioEditor } from "~/components/DrawioEditor";
import { MyCallout } from "~/components/MyCallout";
import { OnlyOfficeEditor } from "~/components/OnlyOfficeEditor";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import { ZoomableImage } from "~/components/ZoomableImage";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import type { ProjectFileTarget } from "~/lib/projectFileLinks";
import { projectFilePreviewKind } from "~/lib/projectFilePreview";

const PdfAttachmentViewer = lazy(
  () => import("~/components/PdfAttachmentViewer"),
);
const EmailAttachmentViewer = lazy(
  () => import("~/components/EmailAttachmentViewer"),
);
const PlanViewer = lazy(() =>
  import("@sortsys/dwgviewer").then((module) => ({
    default: module.PlanViewer,
  })),
);

type ProjectFile = QueryResult<"projects.files.list">[number];
type EditorSession =
  | { kind: "office"; value: QueryResult<"projects.files.officeConfig"> }
  | { kind: "drawio"; value: QueryResult<"projects.files.drawioConfig"> };

function PreviewLoading() {
  return (
    <div className="project-files-office-status">
      <Loading
        active
        withOverlay={false}
        description={uiText("Vorschau wird geladen …", "Loading preview …")}
      />
    </div>
  );
}

function FileEditor({
  file,
  projectId,
  kind,
  onClose,
}: {
  file: ProjectFile;
  projectId: string;
  kind: "office" | "drawio";
  onClose: () => void;
}) {
  const [session, setSession] = useState<EditorSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadSession() {
      try {
        const input = { projectId, fileId: file.id };

        if (kind === "office") {
          const [value, failure] = await client.query(
            "projects.files.officeConfig",
            input,
            { strategy: "network-only" },
          );

          if (failure || !value) {
            throw (
              failure ??
              new Error(
                uiText(
                  "Das Dokument konnte nicht geöffnet werden.",
                  "The document could not be opened.",
                ),
              )
            );
          }

          if (active) {
            setSession({ kind, value });
          }
        } else {
          const [value, failure] = await client.query(
            "projects.files.drawioConfig",
            input,
            { strategy: "network-only" },
          );

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

          if (active) {
            setSession({ kind, value });
          }
        }
      } catch (failure) {
        if (active) {
          setError(
            failure instanceof Error
              ? failure.message
              : uiText(
                  "Die Datei konnte nicht geöffnet werden.",
                  "The file could not be opened.",
                ),
          );
        }
      }
    }

    void loadSession();

    return () => {
      active = false;
    };
  }, [projectId, file.id, kind]);

  const saveDrawio = useCallback(
    async (xml: string, version: bigint) => {
      const [result, failure] = await client.mutate(
        "projects.files.drawioSave",
        {
          projectId,
          fileId: file.id,
          xml,
          version,
        },
      );

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
    [projectId, file.id],
  );

  return (
    <>
      {error && (
        <div className="project-files-office-status" role="alert">
          <MyCallout color="red">{error}</MyCallout>
        </div>
      )}
      {!session && !error && <PreviewLoading />}
      {session?.kind === "office" && (
        <OnlyOfficeEditor
          apiUrl={session.value.apiUrl}
          config={session.value.config}
          onError={setError}
          onRequestClose={onClose}
        />
      )}
      {session?.kind === "drawio" && (
        <DrawioEditor
          editorUrl={session.value.editorUrl}
          fileName={session.value.fileName}
          xml={session.value.xml}
          version={session.value.version}
          canEdit={session.value.canEdit}
          onSave={saveDrawio}
          onClose={onClose}
          onError={setError}
        />
      )}
    </>
  );
}

function FilePreview({
  file,
  projectId,
  onClose,
}: {
  file: ProjectFile;
  projectId: string;
  onClose: () => void;
}) {
  const kind = projectFilePreviewKind(file);
  const url = file.downloadUrl || file.downloadAttachmentUrl;
  const [videoError, setVideoError] = useState(false);

  if (kind === "office" || kind === "drawio") {
    return (
      <FileEditor
        file={file}
        projectId={projectId}
        kind={kind}
        onClose={onClose}
      />
    );
  }

  if (!url) {
    return (
      <div className="project-files-office-status" role="alert">
        <MyCallout color="amber">
          {uiText(
            "Für diese Datei ist kein Download-Link verfügbar.",
            "No download link is available for this file.",
          )}
        </MyCallout>
      </div>
    );
  }

  const downloadUrl = file.downloadAttachmentUrl || url;

  if (kind === "pdf") {
    return <PdfAttachmentViewer url={url} downloadUrl={downloadUrl} />;
  }

  if (kind === "eml" || kind === "msg") {
    return (
      <EmailAttachmentViewer
        url={url}
        downloadUrl={downloadUrl}
        format={kind}
      />
    );
  }

  if (kind === "image") {
    return (
      <div className="project-files-media-viewer">
        <ZoomableImage
          src={url}
          alt={file.fileName}
          hasMultipleImages={false}
          onPrevious={() => {}}
          onNext={() => {}}
        />
      </div>
    );
  }

  if (kind === "dwg") {
    return (
      <div className="project-files-dwg-viewer">
        <div className="project-files-dwg-canvas">
          <PlanViewer
            document={{
              type: "dwg",
              name: file.fileName,
              source: { kind: "url", url },
            }}
            defaultUnit="m"
          />
        </div>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="project-files-media-viewer">
        {videoError ? (
          <MyCallout color="amber">
            {uiText(
              "Das Video kann in diesem Browser nicht wiedergegeben werden.",
              "This video cannot be played in this browser.",
            )}
          </MyCallout>
        ) : (
          <video
            controls
            playsInline
            preload="metadata"
            aria-label={file.fileName}
            src={url}
            onError={() => setVideoError(true)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="project-files-office-status">
      <MyCallout color="blue">
        {uiText(
          "Für diesen Dateityp ist keine Vorschau verfügbar.",
          "No preview is available for this file type.",
        )}
      </MyCallout>
    </div>
  );
}

export default function ProjectFilePreviewModal({
  target,
  onClose,
}: {
  target: ProjectFileTarget;
  onClose: () => void;
}) {
  const session = useSessionInfo();
  const supported = session.supportsProjectFiles();

  const [files, failure] = useClientStream(
    () =>
      supported
        ? client.streamQuery(
            "projects.files.list",
            { projectId: target.projectId },
            { strategy: "network-only" },
          )
        : from([[[], null] as [ProjectFile[], null]]),
    [target.projectId, supported],
  );

  const file =
    supported && !failure
      ? files?.find(
          (entry) => entry.id === target.fileId && entry.status === "uploaded",
        )
      : undefined;
  const downloadUrl = file?.downloadAttachmentUrl || file?.downloadUrl;
  const unavailable = !supported || (!!files && !file);

  const closePreview = useCallback(() => {
    onClose();
    void client.invalidate("projects.files.list");
  }, [onClose]);

  return (
    <Modal
      open
      passiveModal
      modalHeading={uiText("Dateivorschau", "File preview")}
      modalLabel={file?.fileName}
      closeButtonLabel={uiText("Schließen", "Close")}
      onRequestClose={closePreview}
      data-fullheight="true"
      data-fullwidth="true"
      className="project-files-office-modal chat-file-preview"
    >
      {downloadUrl && (
        <div className="chat-file-preview__toolbar">
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            download
          >
            {uiText("Herunterladen", "Download")}
          </a>
        </div>
      )}
      <div className="chat-file-preview__body">
        {failure || unavailable ? (
          <div className="project-files-office-status" role="alert">
            <MyCallout color="red">
              {failure?.message ??
                uiText(
                  "Die Datei ist nicht verfügbar oder du hast keinen Zugriff darauf.",
                  "The file is unavailable or you do not have access to it.",
                )}
            </MyCallout>
          </div>
        ) : file ? (
          <ScopedErrorBoundary scope="chat-file-preview" resetKey={file.id}>
            <Suspense fallback={<PreviewLoading />}>
              <FilePreview
                file={file}
                projectId={target.projectId}
                onClose={closePreview}
              />
            </Suspense>
          </ScopedErrorBoundary>
        ) : (
          <PreviewLoading />
        )}
      </div>
    </Modal>
  );
}
