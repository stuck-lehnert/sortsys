import { downloadFileResource, useFileResource } from "~/lib/fileResources";
import type { QueryResult } from "@sortsys/v2-client";
import { Loading, Modal, useNotifications } from "@sortsys/react-components";
import { lazy, Suspense, useCallback, useState } from "react";
import { from } from "rxjs";
import { ProtectedDiagramEditor } from "~/components/ProtectedDiagramEditor";
import { MyCallout } from "~/components/MyCallout";
import { MyButton } from "~/components/MyButton";
import { ProtectedOfficeEditor } from "~/components/ProtectedOfficeEditor";
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
const GaebFileModal = lazy(() => import("~/components/GaebFileModal"));
const PlanViewer = lazy(() =>
  import("@sortsys/dwgviewer").then((module) => ({
    default: module.PlanViewer,
  })),
);

type ProjectFile = QueryResult<"projects.files.list">[number];

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
  if (kind === "office") {
    return <ProtectedOfficeEditor projectId={projectId} fileId={file.id} />;
  }
  return (
    <ProtectedDiagramEditor
      projectId={projectId}
      fileId={file.id}
      onClose={onClose}
    />
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
  const source = file.downloadUrl || file.downloadAttachmentUrl;
  const resource = useFileResource(["image", "video", "dwg"].includes(kind ?? "") ? source : null);
  const url = ["image", "video", "dwg"].includes(kind ?? "") ? resource.url : source;
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

  if (resource.loading) return <PreviewLoading />;
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
    return <PdfAttachmentViewer url={url} downloadUrl={downloadUrl} fileName={file.fileName} />;
  }

  if (kind === "eml" || kind === "msg") {
    return (
      <EmailAttachmentViewer
        url={url}
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
  const notifications = useNotifications();

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
  const kind = file ? projectFilePreviewKind(file) : null;
  const downloadUrl = file?.downloadAttachmentUrl || file?.downloadUrl;
  const unavailable = !supported || (!!files && !file);

  const closePreview = useCallback(() => {
    onClose();
    void client.invalidate("projects.files.list");
  }, [onClose]);

  if (file && kind === "gaeb") {
    return <Suspense fallback={<PreviewLoading />}><GaebFileModal projectId={target.projectId} fileId={file.id} fileName={file.fileName} onClose={closePreview} /></Suspense>;
  }

  return (
    <Modal
      open
      passiveModal
      modalHeading={uiText("Dateivorschau", "File preview")}
      modalLabel={file?.fileName}
      closeButtonLabel={uiText("Schließen", "Close")}
      onRequestClose={closePreview}
      edgeToEdge
      data-fullheight="true"
      data-fullwidth="true"
      className="project-files-office-modal chat-file-preview"
    >
      {downloadUrl && kind !== "pdf" && kind !== "eml" && kind !== "msg" && (
        <div className="chat-file-preview__toolbar">
          <MyButton kind="tertiary" size="sm" onClick={() => {
            void downloadFileResource(downloadUrl, file!.fileName).catch(() => notifications.danger({
              title: uiText("Download fehlgeschlagen", "Download failed"),
              content: uiText("Die Datei konnte nicht geladen werden.", "The file could not be loaded."),
            }));
          }}>
            {uiText("Herunterladen", "Download")}
          </MyButton>
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
