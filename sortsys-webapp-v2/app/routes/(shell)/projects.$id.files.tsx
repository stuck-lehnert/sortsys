import { FileResourceImage } from "~/components/FileResourceImage";
import {
  downloadFileResource,
  fetchFileResource,
  useFileResource,
} from "~/lib/fileResources";
import { projectFiles as privateProjectFiles } from "~/lib/client";
import { Loading, Select, SelectItem } from "@sortsys/react-components";
import { Button as UIAction } from "@sortsys/react-components";
import { Input as UIInput } from "@heroui/react";
import { RpcClientError } from "@sortsys/v2-client";
import { uiText } from "~/lib/i18n";
import { Modal, useNotifications } from "@sortsys/react-components";
import { PlanViewer, type PlanDocument } from "@sortsys/dwgviewer";
import { ProtectedOfficeEditor } from "~/components/ProtectedOfficeEditor";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import { ZoomableImage } from "~/components/ZoomableImage";
import {
  ProjectFileBrowser,
  type ProjectFileBrowserFile,
  type ProjectFileBrowserFolder,
} from "~/components/ProjectFileBrowser";
import { useOutletContext } from "react-router";
import { useProjectFileLocation } from "~/hooks/useProjectFileLocation";
import type { GaebWorkspaceHandle } from "~/components/GaebFileModal";
import { from } from "rxjs";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyDropdown } from "~/components/MyDropdown";
import { MyExpandable } from "~/components/MyExpandable";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useTitle } from "~/hooks/useTitle";
import {
  createBlankProjectFile,
  NEW_PROJECT_FILE_TYPES,
  type NewProjectFileType,
} from "~/lib/blankProjectFiles";
import { client } from "~/lib/client";
import { attachmentPreviewKind } from "~/lib/attachmentPreview";
import {
  isGaebAttachment,
  isDwgAttachment,
  isVideoAttachment,
  projectFileEditor,
} from "~/lib/projectFilePreview";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { downloadBlob } from "~/lib/utils";
import type { Project } from "~/type-helpers";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const PdfAttachmentViewer = lazy(
  () => import("~/components/PdfAttachmentViewer"),
);
const EmailAttachmentViewer = lazy(
  () => import("~/components/EmailAttachmentViewer"),
);
const GaebFileModal = lazy(() => import("~/components/GaebFileModal"));
const ProjectFilePreviewModal = lazy(
  () => import("~/components/ProjectFilePreviewModal"),
);

type ProjectFileEntry = {
  id: string;
  projectId: string;
  folderId: string | null;
  fileName: string;
  mimeType: string;
  kind: "image" | "file";
  sizeBytes: number | null;
  status: "pending" | "uploaded";
  thumbnailStatus?: "none" | "queued" | "processing" | "ready" | "failed";
  thumbnailUrl?: string | null;
  thumbnailExpiresAt?: Date | null;
  previewUrl?: string | null;
  previewExpiresAt?: Date | null;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
  textExtractionStatus: string;
  createdByUserId: string | null;
  createdAt: Date;
  modifiedAt: Date;
  uploadedAt: Date | null;
  downloadUrl?: string | null;
  downloadExpiresAt?: Date | null;
  downloadAttachmentUrl?: string | null;
  downloadAttachmentExpiresAt?: Date | null;
};

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "-";

  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = -1;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function safeZipEntryName(fileName: string, fallbackName: string) {
  const cleaned = `${fileName ?? ""}`
    .replace(/[\/]+/g, "-")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();

  const value = cleaned || fallbackName;
  return value.slice(0, 180);
}

function ensureUniqueFileName(fileName: string, usedNames: Set<string>) {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const dotIndex = fileName.lastIndexOf(".");
  const hasExtension = dotIndex > 0;
  const base = hasExtension ? fileName.slice(0, dotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(dotIndex) : "";

  let counter = 2;
  while (counter < 10000) {
    const candidate = `${base} (${counter})${extension}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter += 1;
  }

  const fallback = `${base}-${Date.now()}${extension}`;
  usedNames.add(fallback);
  return fallback;
}

export default function ProjectFilesPage() {
  const { project } = useOutletContext<{
    project: Pick<Project, "id" | "title">;
  }>();
  const sessionInfo = useSessionInfo();
  const modals = useMyModals();
  const notifications = useNotifications();

  const supportsProjectFiles = sessionInfo.supportsProjectFiles();

  const [projectFiles, projectFilesErr] = useClientStream(() => {
    if (!supportsProjectFiles) {
      return from([[[], null] as [Array<ProjectFileEntry>, null]]);
    }

    return client.streamQuery("projects.files.list", {
      projectId: project.id!,
    });
  }, [project.id, supportsProjectFiles]);

  const [projectFolders, projectFoldersErr] = useClientStream(() => {
    if (!supportsProjectFiles) {
      return from([[[], null] as [Array<ProjectFileBrowserFolder>, null]]);
    }

    return client.streamQuery("projects.files.folders.list", {
      projectId: project.id!,
    });
  }, [project.id, supportsProjectFiles]);

  const [isUploading, setIsUploading] = useState(false);
  const [batchBusyAction, setBatchBusyAction] = useState<
    "download" | "delete" | "move" | "organize" | null
  >(null);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>(
    [],
  );
  const [activeImageIndex, setActiveImageIndex] = useState<number | null>(null);
  const [activeVideoFileId, setActiveVideoFileId] = useState<string | null>(
    null,
  );
  const [videoError, setVideoError] = useState<string | null>(null);
  const [activeDwgFileId, setActiveDwgFileId] = useState<string | null>(null);
  const [officeSelection, setOfficeSelection] = useState<{
    file: ProjectFileEntry;
    context: AbortSignal;
  } | null>(null);
  const [activePreviewFileId, setActivePreviewFileId] = useState<string | null>(
    null,
  );
  const [activeGaebFileId, setActiveGaebFileId] = useState<string | null>(null);
  const [activeFallbackFileId, setActiveFallbackFileId] = useState<
    string | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadDestinationRef = useRef<string | null>(null);
  const pendingOpenFileIdRef = useRef<string | null>(null);
  const openedUrlFileIdRef = useRef<string | null>(null);

  const gaebWorkspace = useRef<GaebWorkspaceHandle>(null);
  const fileLocation = useProjectFileLocation(project.id, () => {
    if (activeGaebFileId && gaebWorkspace.current)
      void gaebWorkspace.current.requestClose();
    else closeAllViewers();
  });
  const resetViewers = () => {
    setActiveImageIndex(null);
    setActiveVideoFileId(null);
    setActiveDwgFileId(null);
    setOfficeSelection(null);
    setActivePreviewFileId(null);
    setActiveGaebFileId(null);
    setActiveFallbackFileId(null);
  };
  const closeFileLocation = useCallback(() => {
    openedUrlFileIdRef.current = null;
    fileLocation.close();
  }, [fileLocation.close]);
  const closeAllViewers = () => {
    resetViewers();
    closeFileLocation();
  };

  useTitle(
    () =>
      project.title
        ? uiText(`Anhänge – ${project.title}`, `Attachments – ${project.title}`)
        : uiText("Projektanhänge", "Project attachments"),
    [project.title],
  );

  const attachments = useMemo(() => {
    return ((projectFiles ?? []) as ProjectFileEntry[])
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [projectFiles]);
  useEffect(() => {
    const requestedFileId = fileLocation.requestedFileId;
    const pendingFileId = pendingOpenFileIdRef.current;
    const fileId = pendingFileId ?? requestedFileId;
    if (!fileId) return;
    if (!pendingFileId && openedUrlFileIdRef.current === fileId) return;

    const file = attachments.find((candidate) => candidate.id === fileId);
    if (!file) {
      if (supportsProjectFiles && projectFiles != null && !projectFilesErr) {
        openedUrlFileIdRef.current = fileId;
        setActiveFallbackFileId(fileId);
        fileLocation.open(fileId);
      }
      return;
    }

    pendingOpenFileIdRef.current = null;
    if (requestedFileId === fileId) {
      openedUrlFileIdRef.current = fileId;
    }
    openBrowserFile(file);
  }, [
    attachments,
    fileLocation.requestedFileId,
    projectFiles,
    projectFilesErr,
    supportsProjectFiles,
  ]);

  const selectedAttachmentIdSet = useMemo(() => {
    return new Set(selectedAttachmentIds);
  }, [selectedAttachmentIds]);

  const selectedAttachments = useMemo(() => {
    return attachments.filter((entry) => selectedAttachmentIdSet.has(entry.id));
  }, [attachments, selectedAttachmentIdSet]);

  const imageFiles = useMemo(() => {
    return attachments.filter(
      (entry) => entry.kind === "image" && !isDwgAttachment(entry),
    );
  }, [attachments]);

  const activeImage = useMemo(() => {
    if (activeImageIndex == null) return null;
    return imageFiles[activeImageIndex] ?? null;
  }, [activeImageIndex, imageFiles]);

  const activeVideo = useMemo(() => {
    if (!activeVideoFileId) return null;
    return attachments.find((file) => file.id === activeVideoFileId) ?? null;
  }, [activeVideoFileId, attachments]);

  const activeDwgFile = useMemo(() => {
    if (!activeDwgFileId) return null;
    return attachments.find((file) => file.id === activeDwgFileId) ?? null;
  }, [activeDwgFileId, attachments]);

  const listedOfficeFile = attachments.find(
    (file) =>
      file.id === officeSelection?.file.id && file.projectId === project.id,
  );
  // Keep the already open editor mounted while the list cannot be reached.
  // An access change or a successful list without the file clears the choice.
  const canKeepOfficeSelection =
    supportsProjectFiles &&
    officeSelection?.file.projectId === project.id &&
    !officeSelection.context.aborted &&
    RpcClientError.isUnavailable(projectFilesErr);
  const activeOfficeFile =
    listedOfficeFile ?? (canKeepOfficeSelection ? officeSelection.file : null);
  const activePreviewFile = useMemo(() => {
    return attachments.find((file) => file.id === activePreviewFileId) ?? null;
  }, [activePreviewFileId, attachments]);
  const documentFiles = useMemo(() => {
    return attachments.filter(
      (entry) => entry.kind !== "image" || isDwgAttachment(entry),
    );
  }, [attachments]);

  const folders = useMemo(() => {
    return ((projectFolders ?? []) as ProjectFileBrowserFolder[]).slice();
  }, [projectFolders]);

  const selectedDocumentIds = useMemo(() => {
    const documentIds = new Set(documentFiles.map((file) => file.id));
    return selectedAttachmentIds.filter((id) => documentIds.has(id));
  }, [documentFiles, selectedAttachmentIds]);

  useEffect(() => {
    setSelectedAttachmentIds((previous) => {
      const available = new Set(attachments.map((entry) => entry.id));
      const filtered = previous.filter((id) => available.has(id));
      if (filtered.length === previous.length) return previous;
      return filtered;
    });
  }, [attachments]);

  useEffect(() => {
    if (!activeVideoFileId) return;
    if (attachments.some((entry) => entry.id === activeVideoFileId)) return;
    setActiveVideoFileId(null);
  }, [activeVideoFileId, attachments]);

  useEffect(() => {
    if (!activeDwgFileId) return;
    if (attachments.some((entry) => entry.id === activeDwgFileId)) return;
    setActiveDwgFileId(null);
  }, [activeDwgFileId, attachments]);

  useEffect(() => {
    if (!officeSelection) return;
    if (listedOfficeFile) {
      const context = privateProjectFiles.editorContext();
      if (
        listedOfficeFile !== officeSelection.file ||
        context !== officeSelection.context
      )
        setOfficeSelection({ file: listedOfficeFile, context });
    } else if (!canKeepOfficeSelection) {
      setOfficeSelection(null);
    }
  }, [officeSelection, listedOfficeFile, canKeepOfficeSelection]);
  useEffect(() => {
    if (
      activePreviewFileId &&
      !attachments.some((file) => file.id === activePreviewFileId)
    ) {
      setActivePreviewFileId(null);
    }
  }, [activePreviewFileId, attachments]);
  const imageCardUrl = (file: ProjectFileEntry) =>
    file.previewUrl || file.thumbnailUrl || file.downloadUrl || null;
  const attachmentDownloadUrl = (file: ProjectFileEntry) =>
    file.downloadAttachmentUrl || file.downloadUrl || null;

  const activeImageResource = useFileResource(activeImage?.downloadUrl);
  const activeVideoResource = useFileResource(
    activeVideo?.downloadUrl || activeVideo?.downloadAttachmentUrl,
  );
  const activeDwgSource = activeDwgFile
    ? activeDwgFile.downloadUrl || activeDwgFile.downloadAttachmentUrl || null
    : null;

  const activeDwgResource = useFileResource(activeDwgSource);
  const activeDwgDownloadUrl = activeDwgResource.url;
  const activeDwgDocument = useMemo<PlanDocument | null>(() => {
    if (!activeDwgFile || !activeDwgDownloadUrl) return null;

    return {
      type: "dwg",
      name: activeDwgFile.fileName,
      source: { kind: "url", url: activeDwgDownloadUrl },
    };
  }, [activeDwgDownloadUrl, activeDwgFile?.fileName]);

  const imageCardFallback = (file: ProjectFileEntry) => {
    if (
      file.thumbnailStatus === "queued" ||
      file.thumbnailStatus === "processing"
    ) {
      return uiText("Vorschau wird erstellt");
    }

    if (file.thumbnailStatus === "failed") {
      return uiText("Vorschau fehlgeschlagen");
    }

    return uiText("Keine Vorschau");
  };

  const closeImageViewer = () => {
    setActiveImageIndex(null);
    closeFileLocation();
  };

  const openVideoViewer = (file: ProjectFileEntry) => {
    if (!attachmentDownloadUrl(file)) return;
    setVideoError(null);
    setActiveVideoFileId(file.id);
  };

  const closeVideoViewer = () => {
    setActiveVideoFileId(null);
    setVideoError(null);
    closeFileLocation();
  };

  const openDwgViewer = (file: ProjectFileEntry) => {
    if (!attachmentDownloadUrl(file)) return;
    setActiveDwgFileId(file.id);
  };

  const closeDwgViewer = () => {
    setActiveDwgFileId(null);
    closeFileLocation();
  };

  const openOfficeEditor = (file: ProjectFileEntry) => {
    setOfficeSelection({ file, context: privateProjectFiles.editorContext() });
  };

  const closeOfficeEditor = useCallback(() => {
    setOfficeSelection(null);
    closeFileLocation();

    void client.invalidate("projects.files.list");
  }, [closeFileLocation]);
  const closeAttachmentPreview = useCallback(() => {
    setActivePreviewFileId(null);
    closeFileLocation();
  }, [closeFileLocation]);
  const toggleAttachmentSelection = (fileId: string) => {
    setSelectedAttachmentIds((previous) => {
      if (previous.includes(fileId)) {
        return previous.filter((id) => id !== fileId);
      }

      return [...previous, fileId];
    });
  };

  const selectAllAttachments = () => {
    setSelectedAttachmentIds(attachments.map((file) => file.id));
  };

  const clearAttachmentSelection = () => {
    setSelectedAttachmentIds([]);
  };

  const openImageOrToggleSelection = (imageId: string, imageIndex: number) => {
    if (batchBusyAction) return;

    if (selectedAttachmentIds.length > 0) {
      toggleAttachmentSelection(imageId);
      return;
    }

    setActiveImageIndex(imageIndex);
    fileLocation.open(imageId);
  };

  const selectionMenuItems = useMemo<
    Parameters<typeof MyDropdown>[0]["items"]
  >(() => {
    const items: Parameters<typeof MyDropdown>[0]["items"] = [
      {
        label: uiText("Alle auswählen"),
        renderIcon: Icons.Accept,
        hideIf: !attachments.length,
        disabled: !!batchBusyAction,
        onClick: selectAllAttachments,
      },
      {
        label: uiText("Auswahl aufheben"),
        renderIcon: Icons.Reset,
        hideIf: !selectedAttachmentIds.length,
        disabled: !!batchBusyAction,
        onClick: clearAttachmentSelection,
      },
    ];

    return items;
  }, [attachments.length, batchBusyAction, selectedAttachmentIds.length]);

  const showImage = (direction: number) => {
    if (activeImageIndex == null || !imageFiles.length) return;
    const index =
      (activeImageIndex + direction + imageFiles.length) % imageFiles.length;
    setActiveImageIndex(index);
    fileLocation.open(imageFiles[index]!.id);
  };
  const showPreviousImage = () => showImage(-1);
  const showNextImage = () => showImage(1);

  useEffect(() => {
    if (activeImageIndex == null) return;

    if (!imageFiles.length) {
      setActiveImageIndex(null);
      return;
    }

    if (activeImageIndex >= imageFiles.length) {
      setActiveImageIndex(imageFiles.length - 1);
    }
  }, [activeImageIndex, imageFiles.length]);

  useEffect(() => {
    if (activeImageIndex == null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImageViewer();
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        showPreviousImage();
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        showNextImage();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeImageIndex, imageFiles.length]);

  async function uploadProjectFile(file: File, folderId: string | null) {
    return privateProjectFiles.upload({
      projectId: project.id,
      folderId,
      name: file.name,
      mime: file.type || "application/octet-stream",
      blob: file,
    });
  }

  async function uploadSelectedFiles(
    fileList: FileList | File[] | null,
    folderId: string | null = null,
  ) {
    if (!fileList?.length) return;
    if (isUploading) return;
    if (batchBusyAction) return;

    setIsUploading(true);

    const selected = Array.from(fileList);

    try {
      for (const file of selected) {
        await uploadProjectFile(file, folderId);
      }

      await client.invalidate("projects.files.list");
      notifications.success({
        title:
          selected.length === 1
            ? uiText("Datei hochgeladen", "File uploaded")
            : uiText(
                `${selected.length} Dateien hochgeladen`,
                `${selected.length} files uploaded`,
              ),
      });
    } catch (err) {
      notifications.danger({
        title: uiText("Upload fehlgeschlagen", "Upload failed"),
        content:
          (err as Error)?.message ||
          uiText(
            "Die Datei konnte nicht hochgeladen werden.",
            "The file could not be uploaded.",
          ),
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function chooseFilesForUpload(folderId: string | null) {
    uploadDestinationRef.current = folderId;
    fileInputRef.current?.click();
  }

  function invalidateFileBrowser() {
    return Promise.all([
      client.invalidate("projects.files.list"),
      client.invalidate("projects.files.folders.list"),
    ]);
  }

  function notifyOrganizationError(error: unknown) {
    notifications.danger({
      title: uiText("Aktion fehlgeschlagen", "Action failed"),
      content:
        error instanceof Error
          ? error.message
          : uiText(
              "Die Dateiablage konnte nicht aktualisiert werden.",
              "The file storage could not be updated.",
            ),
    });
  }

  function folderPath(folder: ProjectFileBrowserFolder) {
    const names = [folder.name];
    const seen = new Set([folder.id]);
    let parentFolderId = folder.parentFolderId;

    while (parentFolderId && !seen.has(parentFolderId)) {
      seen.add(parentFolderId);
      const parent = folders.find(
        (candidate) => candidate.id === parentFolderId,
      );
      if (!parent) break;

      names.unshift(parent.name);
      parentFolderId = parent.parentFolderId;
    }

    return names.join(" / ");
  }

  function isFolderInside(candidateId: string, ancestorId: string) {
    const seen = new Set<string>();
    let folderId: string | null = candidateId;

    while (folderId && !seen.has(folderId)) {
      if (folderId === ancestorId) return true;
      seen.add(folderId);
      folderId =
        folders.find((folder) => folder.id === folderId)?.parentFolderId ??
        null;
    }

    return false;
  }

  async function moveFiles(fileIds: string[], folderId: string | null) {
    if (!fileIds.length) return;

    setBatchBusyAction("move");

    try {
      const [, error] = await client.mutate("projects.files.move", {
        projectId: project.id,
        fileIds,
        folderId,
      });
      if (error) throw error;

      await invalidateFileBrowser();
      setSelectedAttachmentIds((previous) =>
        previous.filter((id) => !fileIds.includes(id)),
      );
      notifications.success({
        title:
          fileIds.length === 1
            ? uiText("Datei verschoben", "File moved")
            : uiText("Dateien verschoben", "Files moved"),
      });
    } finally {
      setBatchBusyAction(null);
    }
  }

  function showMoveFilesModal(fileIds: string[]) {
    if (!fileIds.length) return;

    const firstFile = documentFiles.find((file) => file.id === fileIds[0]);
    const destinationRef = { current: firstFile?.folderId ?? "" };
    const destinations = folders
      .slice()
      .sort((left, right) => folderPath(left).localeCompare(folderPath(right)));

    modals.showDefault({
      content: () => (
        <Select
          labelText={uiText("Zielordner", "Destination folder")}
          className="w-full"
          defaultValue={destinationRef.current}
          onChange={(event: {
            target: { value: string };
            currentTarget: { value: string };
          }) => {
            destinationRef.current = event.currentTarget.value;
          }}
        >
          <SelectItem value="">{uiText("Anhänge", "Attachments")}</SelectItem>
          {destinations.map((folder) => (
            <SelectItem key={folder.id} value={folder.id}>
              {folderPath(folder)}
            </SelectItem>
          ))}
        </Select>
      ),
      modalProps: () => ({
        noFullscreen: true,
        modalHeading:
          fileIds.length === 1
            ? uiText("Datei verschieben", "Move file")
            : uiText("Dateien verschieben", "Move files"),
        modalLabel: project.title,
        primaryButtonText: uiText("Verschieben", "Move"),
      }),
      onPrimaryAction: async ({ hide }) => {
        await moveFiles(fileIds, destinationRef.current || null);
        hide();
      },
    });
  }

  async function moveFolder(
    folder: ProjectFileBrowserFolder,
    parentFolderId: string | null,
  ) {
    if (folder.parentFolderId === parentFolderId) return;

    setBatchBusyAction("organize");

    try {
      const [, error] = await client.mutate("projects.files.folders.move", {
        projectId: project.id,
        folderId: folder.id,
        parentFolderId,
      });
      if (error) throw error;

      await invalidateFileBrowser();
      notifications.success({
        title: uiText("Ordner verschoben", "Folder moved"),
      });
    } finally {
      setBatchBusyAction(null);
    }
  }

  function showMoveFolderModal(folder: ProjectFileBrowserFolder) {
    const destinationRef = { current: folder.parentFolderId ?? "" };
    const destinations = folders
      .filter((candidate) => !isFolderInside(candidate.id, folder.id))
      .sort((left, right) => folderPath(left).localeCompare(folderPath(right)));

    modals.showDefault({
      content: () => (
        <Select
          labelText={uiText("Zielordner", "Destination folder")}
          className="w-full"
          defaultValue={destinationRef.current}
          onChange={(event: {
            target: { value: string };
            currentTarget: { value: string };
          }) => {
            destinationRef.current = event.currentTarget.value;
          }}
        >
          <SelectItem value="">{uiText("Anhänge", "Attachments")}</SelectItem>
          {destinations.map((destination) => (
            <SelectItem key={destination.id} value={destination.id}>
              {folderPath(destination)}
            </SelectItem>
          ))}
        </Select>
      ),
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Ordner verschieben", "Move folder"),
        modalLabel: folder.name,
        primaryButtonText: uiText("Verschieben", "Move"),
      }),
      onPrimaryAction: async ({ hide }) => {
        await moveFolder(folder, destinationRef.current || null);
        hide();
      },
    });
  }

  function showCreateFileModal(
    type: NewProjectFileType,
    folderId: string | null,
  ) {
    const definition = NEW_PROJECT_FILE_TYPES.find(
      (candidate) => candidate.type === type,
    );
    if (!definition) return;

    const defaultBaseName: Record<NewProjectFileType, string> = {
      docx: uiText("Unbenanntes Dokument", "Untitled document"),
      pptx: uiText("Neue Präsentation", "New presentation"),
      xlsx: uiText("Neue Arbeitsmappe", "New workbook"),
      drawio: uiText("Neues Diagramm", "New diagram"),
      x83: uiText("Neue Angebotsaufforderung", "New invitation to tender"),
      x84: uiText("Neues Angebot", "New bid"),
      x86: uiText("Neue Auftragserteilung", "New contract award"),
      x87: uiText("Neue Auftragsbestätigung", "New order confirmation"),
      x31: uiText("Neues Aufmaß", "New quantity takeoff"),
    };
    const nameRef = {
      current: `${defaultBaseName[type]}${definition.extension}`,
    };

    modals.showDefault({
      content: () => (
        <label className="project-file-dialog-field">
          <span>{uiText("Dateiname", "File name")}</span>
          <UIInput
            variant="secondary"
            className="ss-input"
            autoFocus
            defaultValue={nameRef.current}
            maxLength={255}
            onFocus={(event) => {
              const extensionStart =
                event.currentTarget.value.length - definition.extension.length;
              event.currentTarget.setSelectionRange(
                0,
                Math.max(0, extensionStart),
              );
            }}
            onChange={(event) => {
              nameRef.current = event.currentTarget.value;
            }}
          />
        </label>
      ),
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Neue Datei", "New file"),
        modalLabel: uiText(definition.germanLabel, definition.englishLabel),
        primaryButtonText: uiText("Erstellen", "Create"),
      }),
      onPrimaryAction: async ({ hide }) => {
        let fileName = nameRef.current.trim();
        if (!fileName) {
          throw new Error(
            uiText("Gib einen Dateinamen ein.", "Enter a file name."),
          );
        }
        if (!fileName.toLocaleLowerCase().endsWith(definition.extension)) {
          fileName += definition.extension;
        }

        setIsUploading(true);
        try {
          const file = await createBlankProjectFile(type, fileName);
          const fileId = await uploadProjectFile(file, folderId);
          pendingOpenFileIdRef.current = fileId;

          await client.invalidate("projects.files.list");
          notifications.success({
            title: uiText("Datei erstellt", "File created"),
            content: fileName,
          });
          hide();
        } finally {
          setIsUploading(false);
        }
      },
    });
  }

  function showCreateFolderModal(parentFolderId: string | null) {
    const nameRef = { current: "" };

    modals.showDefault({
      content: () => (
        <label className="project-file-dialog-field">
          <span>{uiText("Ordnername", "Folder name")}</span>
          <UIInput
            variant="secondary"
            className="ss-input"
            autoFocus
            maxLength={255}
            onChange={(event) => {
              nameRef.current = event.currentTarget.value;
            }}
          />
        </label>
      ),
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Neuer Ordner", "New folder"),
        modalLabel: project.title,
        primaryButtonText: uiText("Erstellen", "Create"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const name = nameRef.current.trim();
        if (!name)
          throw new Error(
            uiText("Gib einen Ordnernamen ein.", "Enter a folder name."),
          );

        const [, error] = await client.mutate("projects.files.folders.create", {
          projectId: project.id,
          parentFolderId,
          name,
        });
        if (error) throw error;

        await invalidateFileBrowser();
        notifications.success({
          title: uiText("Ordner erstellt", "Folder created"),
        });
        hide();
      },
    });
  }

  function showRenameFolderModal(folder: ProjectFileBrowserFolder) {
    const nameRef = { current: folder.name };

    modals.showDefault({
      content: () => (
        <label className="project-file-dialog-field">
          <span>{uiText("Ordnername", "Folder name")}</span>
          <UIInput
            variant="secondary"
            className="ss-input"
            autoFocus
            defaultValue={folder.name}
            maxLength={255}
            onChange={(event) => {
              nameRef.current = event.currentTarget.value;
            }}
          />
        </label>
      ),
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Ordner umbenennen", "Rename folder"),
        modalLabel: folder.name,
        primaryButtonText: uiText("Speichern", "Save"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const name = nameRef.current.trim();
        if (!name)
          throw new Error(
            uiText("Gib einen Ordnernamen ein.", "Enter a folder name."),
          );

        const [, error] = await client.mutate("projects.files.folders.rename", {
          projectId: project.id,
          folderId: folder.id,
          name,
        });
        if (error) throw error;

        await invalidateFileBrowser();
        notifications.success({
          title: uiText("Ordner umbenannt", "Folder renamed"),
        });
        hide();
      },
    });
  }

  function showRenameFileModal(file: ProjectFileBrowserFile) {
    const nameRef = { current: file.fileName };

    modals.showDefault({
      content: () => (
        <label className="project-file-dialog-field">
          <span>{uiText("Dateiname", "File name")}</span>
          <UIInput
            variant="secondary"
            className="ss-input"
            autoFocus
            defaultValue={file.fileName}
            maxLength={255}
            onChange={(event) => {
              nameRef.current = event.currentTarget.value;
            }}
          />
        </label>
      ),
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Datei umbenennen", "Rename file"),
        modalLabel: file.fileName,
        primaryButtonText: uiText("Speichern", "Save"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const fileName = nameRef.current.trim();
        if (!fileName)
          throw new Error(
            uiText("Gib einen Dateinamen ein.", "Enter a file name."),
          );

        const [, error] = await client.mutate("projects.files.rename", {
          projectId: project.id,
          fileId: file.id,
          fileName,
        });
        if (error) throw error;

        await invalidateFileBrowser();
        notifications.success({
          title: uiText("Datei umbenannt", "File renamed"),
        });
        hide();
      },
    });
  }

  function showDeleteFolderModal(folder: ProjectFileBrowserFolder) {
    const hasContents =
      folders.some((candidate) => candidate.parentFolderId === folder.id) ||
      documentFiles.some((file) => file.folderId === folder.id);

    if (hasContents) {
      notifications.warning({
        title: uiText("Ordner ist nicht leer", "Folder is not empty"),
        content: uiText(
          "Verschiebe oder lösche zuerst die enthaltenen Dateien und Unterordner.",
          "Move or delete the contained files and subfolders first.",
        ),
      });
      return;
    }

    modals.showDefault({
      content: () => (
        <p>
          {uiText(
            `Soll der Ordner „${folder.name}“ gelöscht werden?`,
            `Delete the folder “${folder.name}”?`,
          )}
        </p>
      ),
      modalProps: () => ({
        danger: true,
        noFullscreen: true,
        modalHeading: uiText("Ordner löschen", "Delete folder"),
        modalLabel: project.title,
        primaryButtonText: uiText("Löschen", "Delete"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const [, error] = await client.mutate("projects.files.folders.delete", {
          projectId: project.id,
          folderId: folder.id,
        });
        if (error) throw error;

        await invalidateFileBrowser();
        notifications.success({
          title: uiText("Ordner gelöscht", "Folder deleted"),
        });
        hide();
      },
    });
  }

  function openBrowserFile(file: ProjectFileBrowserFile) {
    const attachment = attachments.find(
      (candidate) => candidate.id === file.id,
    );
    if (!attachment) return;

    resetViewers();
    openedUrlFileIdRef.current = attachment.id;
    fileLocation.open(attachment.id);
    if (attachment.kind === "image" && !isDwgAttachment(attachment)) {
      setActiveImageIndex(
        imageFiles.findIndex((image) => image.id === attachment.id),
      );
    } else if (isGaebAttachment(attachment)) {
      setActiveGaebFileId(attachment.id);
    } else if (attachmentPreviewKind(attachment)) {
      setActivePreviewFileId(attachment.id);
    } else if (isDwgAttachment(attachment)) {
      openDwgViewer(attachment);
    } else if (isVideoAttachment(attachment)) {
      openVideoViewer(attachment);
    } else if (projectFileEditor(attachment.fileName)) {
      openOfficeEditor(attachment);
    } else {
      setActiveFallbackFileId(attachment.id);
    }
  }

  async function downloadResource(url: string, name: string) {
    try {
      await downloadFileResource(url, name);
    } catch {
      notifications.danger({
        title: uiText("Download fehlgeschlagen", "Download failed"),
        content: uiText(
          "Die Datei konnte nicht geladen werden.",
          "The file could not be loaded.",
        ),
      });
    }
  }
  function downloadBrowserFile(file: ProjectFileBrowserFile) {
    const attachment = attachments.find(
      (candidate) => candidate.id === file.id,
    );
    const url = attachment ? attachmentDownloadUrl(attachment) : null;
    if (url) void downloadResource(url, file.fileName);
  }

  async function downloadSelectedAsZip() {
    if (!selectedAttachments.length) return;
    if (batchBusyAction) return;

    setBatchBusyAction("download");

    try {
      const candidates = selectedAttachments.filter(
        (file) => !!attachmentDownloadUrl(file),
      );
      if (!candidates.length) {
        throw new Error(
          uiText(
            "Für die Auswahl sind aktuell keine Download-Links verfügbar.",
          ),
        );
      }

      const { default: JSZip } = await import("jszip");

      const zip = new JSZip();
      const usedNames = new Set<string>();

      for (let index = 0; index < candidates.length; index += 1) {
        const file = candidates[index]!;
        const url = attachmentDownloadUrl(file);
        if (!url) continue;

        const response = await fetchFileResource(url);
        if (!response.ok) {
          throw new Error(
            uiText(
              `Download fehlgeschlagen: ${file.fileName} (${response.status})`,
              `Download failed: ${file.fileName} (${response.status})`,
            ),
          );
        }

        const bytes = await response.arrayBuffer();
        const fallbackName = `datei-${index + 1}`;
        const safeName = safeZipEntryName(file.fileName, fallbackName);
        const uniqueName = ensureUniqueFileName(safeName, usedNames);

        zip.file(uniqueName, bytes);
      }

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      const safeProjectTitle =
        `${project.title ?? ""}`
          .trim()
          .replace(/[^\w\-]+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "projekt";

      downloadBlob(
        zipBlob,
        uiText(
          `Projektanhaenge-${safeProjectTitle}.zip`,
          `Projectanhaenge-${safeProjectTitle}.zip`,
        ),
      );
      notifications.success({
        title: uiText("ZIP-Archiv heruntergeladen", "ZIP archive downloaded"),
        content:
          candidates.length === 1
            ? uiText("1 Datei enthalten", "Contains 1 file")
            : uiText(
                `${candidates.length} Dateien enthalten`,
                `Contains ${candidates.length} files`,
              ),
      });
    } catch (err) {
      notifications.danger({
        title: uiText("ZIP-Download fehlgeschlagen", "ZIP download failed"),
        content:
          (err as Error)?.message ||
          uiText(
            "Das ZIP-Archiv konnte nicht erstellt werden.",
            "The ZIP archive could not be created.",
          ),
      });
    } finally {
      setBatchBusyAction(null);
    }
  }

  function showDeleteSelectedFilesConfirmModal(
    filesToDelete: readonly ProjectFileEntry[],
  ) {
    if (!filesToDelete.length) return;

    modals.showDefault({
      content: () => (
        <>
          <p>
            {filesToDelete.length === 1
              ? uiText(
                  "Soll die ausgewählte Datei wirklich gelöscht werden?",
                  "Delete the selected file?",
                )
              : uiText(
                  `Sollen ${filesToDelete.length} ausgewählte Dateien wirklich gelöscht werden?`,
                  `Delete ${filesToDelete.length} selected files?`,
                )}{" "}
            <b>
              {uiText(
                "Diese Aktion kann nicht rückgängig gemacht werden.",
                "This action cannot be undone.",
              )}
            </b>
          </p>
        </>
      ),
      modalProps: () => ({
        danger: true,
        noFullscreen: true,
        modalHeading: uiText("Auswahl löschen"),
        modalLabel: project.title,
        primaryButtonText: uiText("Löschen"),
      }),
      onPrimaryAction: async ({ hide }) => {
        if (batchBusyAction) return;

        setBatchBusyAction("delete");

        const selectedIds = filesToDelete.map((file) => file.id);
        const selectedIdsSet = new Set(selectedIds);

        try {
          for (const fileId of selectedIds) {
            const [, err] = await client.mutate("projects.files.delete", {
              projectId: project.id,
              fileId,
            });

            if (err) throw err;
          }

          await client.invalidate("projects.files.list");

          setSelectedAttachmentIds((previous) =>
            previous.filter((id) => !selectedIdsSet.has(id)),
          );
          notifications.success({
            title:
              selectedIds.length === 1
                ? uiText("Datei gelöscht", "File deleted")
                : uiText(
                    `${selectedIds.length} Dateien gelöscht`,
                    `${selectedIds.length} files deleted`,
                  ),
          });
          hide();
        } catch (err) {
          notifications.danger({
            title: uiText("Löschen fehlgeschlagen", "Deletion failed"),
            content:
              (err as Error)?.message ||
              uiText(
                "Die Dateien konnten nicht gelöscht werden.",
                "The files could not be deleted.",
              ),
          });
        } finally {
          setBatchBusyAction(null);
        }
      },
    });
  }

  if (!supportsProjectFiles) {
    return (
      <MyCallout icon={Icons.Info} color="amber">
        {uiText("Anhänge sind für dieses Mandanten-Setup nicht aktiviert.")}
      </MyCallout>
    );
  }

  if (
    (projectFiles == null && !projectFilesErr) ||
    (projectFolders == null && !projectFoldersErr)
  ) {
    return (
      <Loading
        description={uiText("Anhänge werden geladen.", "Loading attachments.")}
      />
    );
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) =>
          uploadSelectedFiles(event.target.files, uploadDestinationRef.current)
        }
      />

      <div className="project-files-toolbar mb-2">
        <div className="project-files-toolbar-left">
          {!!selectedAttachmentIds.length && (
            <>
              <MyButton
                size="sm"
                kind="ghost"
                renderIcon={Icons.Download}
                disabled={!!batchBusyAction}
                loading={batchBusyAction === "download"}
                onClick={downloadSelectedAsZip}
              >
                {uiText("Auswahl ZIP")}
              </MyButton>

              {!!selectedDocumentIds.length && (
                <MyButton
                  size="sm"
                  kind="ghost"
                  renderIcon={Icons.FolderMove}
                  disabled={!!batchBusyAction}
                  loading={batchBusyAction === "move"}
                  onClick={() => showMoveFilesModal(selectedDocumentIds)}
                >
                  {uiText("Auswahl verschieben", "Move selection")}
                </MyButton>
              )}

              <MyButton
                size="sm"
                kind="danger--tertiary"
                renderIcon={Icons.Delete}
                disabled={!!batchBusyAction}
                loading={batchBusyAction === "delete"}
                onClick={() =>
                  showDeleteSelectedFilesConfirmModal(selectedAttachments)
                }
              >
                {uiText("Auswahl löschen")}
              </MyButton>

              <MyButton
                size="sm"
                kind="ghost"
                renderIcon={Icons.Reset}
                disabled={!!batchBusyAction}
                onClick={clearAttachmentSelection}
              >
                {uiText("Auswahl aufheben")}
              </MyButton>
            </>
          )}

          {isUploading && <span>{uiText("Upload läuft...")}</span>}
        </div>

        {!!attachments.length && (
          <div className="project-files-toolbar-right">
            <MyDropdown
              icon={Icons.FilterEdit}
              items={selectionMenuItems}
              menuClassName="project-files-selection-menu"
            />
          </div>
        )}
      </div>

      {!!(projectFilesErr || projectFoldersErr) && (
        <MyCallout icon={Icons.Info} color="amber">
          {uiText("Anhänge konnten nicht geladen werden:")}{" "}
          {`${(projectFilesErr ?? (projectFoldersErr as Error | null))?.message ?? uiText("Unbekannter Fehler")}`}
        </MyCallout>
      )}

      {!!imageFiles.length && (
        <MyExpandable
          title={uiText(
            `Bilder (${imageFiles.length})`,
            `Images (${imageFiles.length})`,
          )}
          initiallyExpanded
        >
          <div
            className={[
              "grid grid-cols-[repeat(auto-fill,minmax(min(100%,10rem),1fr))] gap-2",
            ].join(" ")}
          >
            {imageFiles.map((image, imageIndex) => (
              <div
                key={image.id}
                className={`project-files-image-tile-wrap${selectedAttachmentIdSet.has(image.id) ? " is-selected" : ""}`}
              >
                <UIAction
                  kind="ghost"
                  type="button"
                  title={image.fileName}
                  onClick={() =>
                    openImageOrToggleSelection(image.id, imageIndex)
                  }
                  className="project-files-image-tile"
                >
                  {imageCardUrl(image) ? (
                    <FileResourceImage
                      src={imageCardUrl(image) ?? undefined}
                      alt={image.fileName}
                      className="block size-full object-cover"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center p-2 text-center">
                      <span className="text-xs text-muted">
                        {imageCardFallback(image)}
                      </span>
                    </div>
                  )}
                </UIAction>

                <MyButton
                  size="sm"
                  kind={
                    selectedAttachmentIdSet.has(image.id)
                      ? "primary"
                      : "secondary"
                  }
                  className="size-11 min-h-11 min-w-11 rounded-full p-0"
                  renderIcon={
                    selectedAttachmentIdSet.has(image.id)
                      ? Icons.Accept
                      : Icons.Plus
                  }
                  data-image-select-toggle="true"
                  aria-pressed={selectedAttachmentIdSet.has(image.id)}
                  title={
                    selectedAttachmentIdSet.has(image.id)
                      ? uiText("Aus Auswahl entfernen", "Remove from selection")
                      : uiText("Zur Auswahl hinzufügen", "Add to selection")
                  }
                  aria-label={
                    selectedAttachmentIdSet.has(image.id)
                      ? uiText(
                          `${image.fileName} aus der Auswahl entfernen`,
                          `Remove ${image.fileName} from selection`,
                        )
                      : uiText(
                          `${image.fileName} zur Auswahl hinzufügen`,
                          `Add ${image.fileName} to selection`,
                        )
                  }
                  onClick={() => toggleAttachmentSelection(image.id)}
                />
              </div>
            ))}
          </div>
        </MyExpandable>
      )}

      <section className="project-files-documents">
        <h3 className="text-xl leading-snug font-semibold">
          {uiText(
            `Dateien (${documentFiles.length})`,
            `Files (${documentFiles.length})`,
          )}
        </h3>

        <ProjectFileBrowser
          files={documentFiles}
          folders={folders}
          selectedFileIds={selectedAttachmentIdSet}
          busy={isUploading || !!batchBusyAction}
          onToggleFile={toggleAttachmentSelection}
          onOpenFile={openBrowserFile}
          onDownloadFile={downloadBrowserFile}
          onRenameFile={showRenameFileModal}
          onDeleteFile={(file) => {
            const attachment = attachments.find(
              (candidate) => candidate.id === file.id,
            );
            if (attachment) showDeleteSelectedFilesConfirmModal([attachment]);
          }}
          onMoveFiles={(fileIds, folderId) => {
            void moveFiles(fileIds, folderId).catch(notifyOrganizationError);
          }}
          onChooseFileDestination={showMoveFilesModal}
          onCreateFolder={showCreateFolderModal}
          onCreateFile={showCreateFileModal}
          onRenameFolder={showRenameFolderModal}
          onMoveFolder={(folder, parentFolderId) => {
            void moveFolder(folder, parentFolderId).catch(
              notifyOrganizationError,
            );
          }}
          onChooseFolderDestination={showMoveFolderModal}
          onDeleteFolder={showDeleteFolderModal}
          onUploadFiles={(files, folderId) => {
            void uploadSelectedFiles(files, folderId);
          }}
          onChooseUpload={chooseFilesForUpload}
        />
      </section>

      {activeFallbackFileId && (
        <Suspense fallback={null}>
          <ProjectFilePreviewModal
            target={{ projectId: project.id, fileId: activeFallbackFileId }}
            onClose={closeAllViewers}
          />
        </Suspense>
      )}
      {activeGaebFileId &&
        attachments.some((file) => file.id === activeGaebFileId) && (
          <Suspense fallback={null}>
            <GaebFileModal
              projectId={project.id}
              fileId={activeGaebFileId}
              fileName={
                attachments.find((file) => file.id === activeGaebFileId)!
                  .fileName
              }
              workspaceRef={gaebWorkspace}
              onClose={() => {
                setActiveGaebFileId(null);
                closeFileLocation();
              }}
            />
          </Suspense>
        )}
      {!!activePreviewFile && (
        <Modal
          open
          passiveModal
          modalHeading={
            attachmentPreviewKind(activePreviewFile) === "pdf"
              ? uiText("PDF ansehen", "View PDF")
              : uiText("E-Mail ansehen", "View email")
          }
          modalLabel={activePreviewFile.fileName}
          closeButtonLabel={uiText("Schließen", "Close")}
          onRequestClose={closeAttachmentPreview}
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          className="project-files-office-modal"
        >
          <ScopedErrorBoundary
            scope="project-attachment-preview"
            resetKey={activePreviewFile.id}
          >
            <Suspense
              fallback={
                <div className="project-files-office-status" role="status">
                  {uiText("Vorschau wird geladen …", "Loading preview …")}
                </div>
              }
            >
              {activePreviewFile.downloadUrl ||
              activePreviewFile.downloadAttachmentUrl ? (
                attachmentPreviewKind(activePreviewFile) === "pdf" ? (
                  <PdfAttachmentViewer
                    key={activePreviewFile.id}
                    url={
                      (activePreviewFile.downloadUrl ||
                        activePreviewFile.downloadAttachmentUrl)!
                    }
                    downloadUrl={attachmentDownloadUrl(activePreviewFile)!}
                    fileName={activePreviewFile.fileName}
                  />
                ) : (
                  <EmailAttachmentViewer
                    key={activePreviewFile.id}
                    url={
                      (activePreviewFile.downloadUrl ||
                        activePreviewFile.downloadAttachmentUrl)!
                    }
                    format={
                      attachmentPreviewKind(activePreviewFile) === "msg"
                        ? "msg"
                        : "eml"
                    }
                  />
                )
              ) : (
                <div className="project-files-office-status">
                  <MyCallout color="amber" icon={Icons.Info}>
                    {uiText(
                      "Für diese Datei ist kein Download-Link verfügbar.",
                      "No download link is available for this file.",
                    )}
                  </MyCallout>
                </div>
              )}
            </Suspense>
          </ScopedErrorBoundary>
        </Modal>
      )}

      {!!activeOfficeFile && (
        <Modal
          open
          passiveModal
          modalHeading={
            projectFileEditor(activeOfficeFile.fileName) === "diagram"
              ? uiText("Diagramm", "Diagram")
              : uiText("Dokument", "Document")
          }
          modalLabel={activeOfficeFile.fileName}
          closeButtonLabel={uiText("Schließen", "Close")}
          onRequestClose={closeOfficeEditor}
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          className="project-files-office-modal"
        >
          <ProtectedOfficeEditor
            projectId={project.id}
            fileId={activeOfficeFile.id}
          />
        </Modal>
      )}

      {!!activeDwgFile && (
        <Modal
          open
          passiveModal
          modalHeading={uiText("DWG Viewer")}
          modalLabel={activeDwgFile.fileName}
          closeButtonLabel={uiText("Schließen")}
          onRequestClose={closeDwgViewer}
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          className="project-files-dwg-modal"
        >
          <div className="project-files-dwg-viewer">
            <div className="project-files-dwg-header">
              <div>
                <div style={{ fontWeight: 600 }}>{activeDwgFile.fileName}</div>
                <div className="light" style={{ fontSize: ".9rem" }}>
                  {formatBytes(activeDwgFile.sizeBytes)} ·{" "}
                  {formatDate(activeDwgFile.createdAt)}
                </div>
              </div>

              <MyDropdown
                items={[
                  {
                    label: uiText("Herunterladen"),
                    renderIcon: Icons.Download,
                    hideIf:
                      !activeDwgFile.downloadAttachmentUrl &&
                      !activeDwgFile.downloadUrl,
                    onClick: () => {
                      const attachmentUrl =
                        activeDwgFile.downloadAttachmentUrl ||
                        activeDwgFile.downloadUrl;
                      if (!attachmentUrl) return;
                      void downloadResource(
                        attachmentUrl,
                        activeDwgFile.fileName,
                      );
                    },
                  },
                ]}
              />
            </div>

            <div className="project-files-dwg-canvas">
              {activeDwgResource.loading ? (
                <Loading
                  active
                  description={uiText("Datei wird geöffnet …", "Opening file…")}
                />
              ) : activeDwgDocument ? (
                <PlanViewer document={activeDwgDocument} defaultUnit="m" />
              ) : (
                <MyCallout icon={Icons.Info} color="amber">
                  {uiText(
                    "Für diese DWG-Datei ist aktuell kein Download-Link verfügbar.",
                  )}
                </MyCallout>
              )}
            </div>
          </div>
        </Modal>
      )}

      {!!activeVideo && (
        <Modal
          open
          passiveModal
          modalHeading={uiText("Video", "Video")}
          modalLabel={activeVideo.fileName}
          closeButtonLabel={uiText("Schließen", "Close")}
          onRequestClose={closeVideoViewer}
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          className="project-files-video-modal"
        >
          <div className="project-files-media-viewer">
            <div className="project-files-media-header">
              <div className="project-files-media-details">
                <strong>{activeVideo.fileName}</strong>
                <span>
                  {formatBytes(activeVideo.sizeBytes)} ·{" "}
                  {formatDate(activeVideo.createdAt)}
                </span>
              </div>

              <MyDropdown
                items={[
                  {
                    label: uiText("Herunterladen", "Download"),
                    renderIcon: Icons.Download,
                    hideIf:
                      !activeVideo.downloadAttachmentUrl &&
                      !activeVideo.downloadUrl,
                    onClick: () => {
                      const url =
                        activeVideo.downloadAttachmentUrl ||
                        activeVideo.downloadUrl;
                      if (url) void downloadResource(url, activeVideo.fileName);
                    },
                  },
                ]}
              />
            </div>

            <div className="project-files-video-stage">
              {activeVideoResource.loading ? (
                <Loading
                  active
                  description={uiText("Datei wird geöffnet …", "Opening file…")}
                />
              ) : videoError ? (
                <MyCallout icon={Icons.Deny} color="red">
                  {videoError}
                </MyCallout>
              ) : (
                <video
                  key={activeVideo.id}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={activeVideo.fileName}
                  onError={() =>
                    setVideoError(
                      uiText(
                        "Das Video kann in diesem Browser nicht wiedergegeben werden.",
                        "This video cannot be played in this browser.",
                      ),
                    )
                  }
                >
                  <source
                    src={activeVideoResource.url || undefined}
                    type={
                      activeVideo.mimeType
                        .toLocaleLowerCase()
                        .startsWith("video/")
                        ? activeVideo.mimeType
                        : undefined
                    }
                  />
                </video>
              )}
            </div>
          </div>
        </Modal>
      )}

      {!!activeImage && (
        <Modal
          open
          passiveModal
          modalHeading={uiText("Bilder")}
          modalLabel={activeImage.fileName}
          closeButtonLabel={uiText("Schließen")}
          onRequestClose={closeImageViewer}
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          className="project-files-image-modal"
        >
          <div className="project-files-media-viewer">
            <div className="project-files-media-header">
              <div className="project-files-media-details">
                <strong>{activeImage.fileName}</strong>
                <span>
                  {uiText("Bild", "Image")} {(activeImageIndex ?? 0) + 1}{" "}
                  {uiText("von", "of")} {imageFiles.length} ·{" "}
                  {formatBytes(activeImage.sizeBytes)} ·{" "}
                  {formatDate(activeImage.createdAt)}
                </span>
              </div>

              <MyDropdown
                items={[
                  {
                    label: uiText("Herunterladen", "Download"),
                    renderIcon: Icons.Download,
                    hideIf:
                      !activeImage.downloadAttachmentUrl &&
                      !activeImage.downloadUrl,
                    onClick: () => {
                      const url =
                        activeImage.downloadAttachmentUrl ||
                        activeImage.downloadUrl;
                      if (url) void downloadResource(url, activeImage.fileName);
                    },
                  },
                ]}
              />
            </div>

            {activeImageResource.loading ? (
              <Loading
                active
                description={uiText("Datei wird geöffnet …", "Opening file…")}
              />
            ) : activeImageResource.url ? (
              <ZoomableImage
                src={activeImageResource.url}
                alt={activeImage.fileName}
                hasMultipleImages={imageFiles.length > 1}
                onPrevious={showPreviousImage}
                onNext={showNextImage}
              />
            ) : (
              <div className="project-files-media-unavailable">
                <MyCallout icon={Icons.Info} color="amber">
                  {uiText(
                    "Für dieses Bild konnte keine Vorschau geladen werden.",
                  )}
                </MyCallout>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
