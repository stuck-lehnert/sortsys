import { uiText } from "~/lib/i18n";
import { Modal, useNotifications } from "@sortsys/react-components";
import { PlanViewer, type PlanDocument } from "@sortsys/dwgviewer";
import { DrawioEditor } from "~/components/DrawioEditor";
import { OnlyOfficeEditor } from "~/components/OnlyOfficeEditor";
import { ZoomableImage } from "~/components/ZoomableImage";
import {
  ProjectFileBrowser,
  type ProjectFileBrowserFile,
  type ProjectFileBrowserFolder,
} from "~/components/ProjectFileBrowser";
import { useOutletContext, useSearchParams } from "react-router";
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
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { downloadBlob } from "~/lib/utils";
import type { Project } from "~/type-helpers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ProjectFileEntry = {
  id: string;
  projectId: string;
  folderId: string | null;
  fileName: string;
  mimeType: string;
  kind: 'image' | 'file';
  sizeBytes: number | null;
  status: 'pending' | 'uploaded';
  thumbnailStatus?: 'none' | 'queued' | 'processing' | 'ready' | 'failed';
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

type OnlyOfficeSession = {
  apiUrl: string;
  canEdit: boolean;
  config: Record<string, unknown>;
};

type DrawioSession = {
  editorUrl: string;
  canEdit: boolean;
  fileName: string;
  version: bigint;
  xml: string;
};

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return '-';

  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = -1;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function safeZipEntryName(fileName: string, fallbackName: string) {
  const cleaned = `${fileName ?? ''}`
    .replace(/[\/]+/g, '-')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();

  const value = cleaned || fallbackName;
  return value.slice(0, 180);
}

function ensureUniqueFileName(fileName: string, usedNames: Set<string>) {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const dotIndex = fileName.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const base = hasExtension ? fileName.slice(0, dotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(dotIndex) : '';

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


function isDwgAttachment(file: ProjectFileEntry) {
  const fileName = file.fileName.toLowerCase();
  const mimeType = file.mimeType.toLowerCase();
  return fileName.endsWith(".dwg")
    || mimeType === "application/acad"
    || mimeType === "application/x-acad"
    || mimeType === "application/autocad_dwg"
    || mimeType === "image/vnd.dwg"
    || mimeType.includes("dwg");
}

function isOnlyOfficeAttachment(file: ProjectFileEntry) {
  const extension = file.fileName.toLowerCase().split(".").pop();

  return !!extension && new Set([
    "csv", "djvu", "doc", "docm", "docx", "dot", "dotm", "dotx", "dps",
    "dpt", "epub", "et", "ett", "fb2", "fodp", "fods", "fodt", "hml",
    "htm", "html", "hwp", "hwpx", "key", "md", "mht", "mhtml", "numbers",
    "odg", "odp", "ods", "odt", "otp", "ots", "ott", "oxps", "pages",
    "pdf", "pot", "potm", "potx", "pps", "ppsm", "ppsx", "ppt", "pptm",
    "pptx", "rtf", "stw", "sxc", "sxi", "sxw", "txt", "vsdm", "vsdx",
    "vssm", "vssx", "vstm", "vstx", "wps", "wpt", "xls", "xlsb", "xlsm",
    "xlsx", "xlt", "xltm", "xltx", "xps",
  ]).has(extension);
}

function isDrawioAttachment(file: ProjectFileEntry) {
  return file.fileName.toLocaleLowerCase().endsWith(".drawio");
}

function isVideoAttachment(file: ProjectFileEntry) {
  if (file.mimeType.toLocaleLowerCase().startsWith("video/")) return true;

  const extension = file.fileName.toLocaleLowerCase().split(".").pop();
  return !!extension && new Set([
    "3g2", "3gp", "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "ogg", "webm",
  ]).has(extension);
}

export default function ProjectFilesPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionInfo = useSessionInfo();
  const modals = useMyModals();
  const notifications = useNotifications();

  const supportsProjectFiles = sessionInfo.supportsProjectFiles();

  const [projectFiles, projectFilesErr] = useClientStream(
    () => {
      if (!supportsProjectFiles) {
        return from([[[], null] as [Array<ProjectFileEntry>, null]]);
      }

      return client.streamQuery('projects.files.list', { projectId: project.id! });
    },
    [project.id, supportsProjectFiles],
  );

  const [projectFolders, projectFoldersErr] = useClientStream(
    () => {
      if (!supportsProjectFiles) {
        return from([[[], null] as [Array<ProjectFileBrowserFolder>, null]]);
      }

      return client.streamQuery("projects.files.folders.list", { projectId: project.id! });
    },
    [project.id, supportsProjectFiles],
  );

  const [isUploading, setIsUploading] = useState(false);
  const [batchBusyAction, setBatchBusyAction] = useState<'download' | 'delete' | 'move' | 'organize' | null>(null);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [activeImageIndex, setActiveImageIndex] = useState<number | null>(null);
  const [activeVideoFileId, setActiveVideoFileId] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [activeDwgFileId, setActiveDwgFileId] = useState<string | null>(null);
  const [activeOfficeFileId, setActiveOfficeFileId] = useState<string | null>(null);
  const [officeSession, setOfficeSession] = useState<OnlyOfficeSession | null>(null);
  const [officeError, setOfficeError] = useState<string | null>(null);
  const [officeLoading, setOfficeLoading] = useState(false);
  const [activeDrawioFileId, setActiveDrawioFileId] = useState<string | null>(null);
  const [drawioSession, setDrawioSession] = useState<DrawioSession | null>(null);
  const [drawioError, setDrawioError] = useState<string | null>(null);
  const [drawioLoading, setDrawioLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadDestinationRef = useRef<string | null>(null);
  const pendingOpenFileIdRef = useRef<string | null>(null);
  const openedUrlFileIdRef = useRef<string | null>(null);

  const clearOpenFileParam = useCallback(() => {
    if (!searchParams.has("file")) return;

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("file");
    openedUrlFileIdRef.current = null;
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useTitle(() => project ? uiText(`Anhänge – ${project.title}`, `Attachments – ${project.title}`) : null, [JSON.stringify(project)]);

  const attachments = useMemo(() => {
    return ((projectFiles ?? []) as ProjectFileEntry[])
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [projectFiles]);
  useEffect(() => {
    const requestedFileId = searchParams.get("file");
    const pendingFileId = pendingOpenFileIdRef.current;
    const fileId = pendingFileId ?? requestedFileId;
    if (!fileId) return;
    if (!pendingFileId && openedUrlFileIdRef.current === fileId) return;

    const file = attachments.find(candidate => candidate.id === fileId);
    if (!file) return;

    pendingOpenFileIdRef.current = null;
    if (requestedFileId === fileId) {
      openedUrlFileIdRef.current = fileId;
    }
    openBrowserFile(file);
  }, [attachments, searchParams]);


  const selectedAttachmentIdSet = useMemo(() => {
    return new Set(selectedAttachmentIds);
  }, [selectedAttachmentIds]);

  const selectedAttachments = useMemo(() => {
    return attachments.filter(entry => selectedAttachmentIdSet.has(entry.id));
  }, [attachments, selectedAttachmentIdSet]);

  const imageFiles = useMemo(() => {
    return attachments.filter(entry => entry.kind === 'image' && !isDwgAttachment(entry));
  }, [attachments]);

  const activeImage = useMemo(() => {
    if (activeImageIndex == null) return null;
    return imageFiles[activeImageIndex] ?? null;
  }, [activeImageIndex, imageFiles]);

  const activeVideo = useMemo(() => {
    if (!activeVideoFileId) return null;
    return attachments.find(file => file.id === activeVideoFileId) ?? null;
  }, [activeVideoFileId, attachments]);

  const activeDwgFile = useMemo(() => {
    if (!activeDwgFileId) return null;
    return attachments.find(file => file.id === activeDwgFileId) ?? null;
  }, [activeDwgFileId, attachments]);

  const activeOfficeFile = useMemo(() => {
    if (!activeOfficeFileId) return null;
    return attachments.find(file => file.id === activeOfficeFileId) ?? null;
  }, [activeOfficeFileId, attachments]);
  const activeDrawioFile = useMemo(() => {
    if (!activeDrawioFileId) return null;
    return attachments.find(file => file.id === activeDrawioFileId) ?? null;
  }, [activeDrawioFileId, attachments]);


  const documentFiles = useMemo(() => {
    return attachments.filter(entry => entry.kind !== 'image' || isDwgAttachment(entry));
  }, [attachments]);

  const folders = useMemo(() => {
    return ((projectFolders ?? []) as ProjectFileBrowserFolder[]).slice();
  }, [projectFolders]);

  const selectedDocumentIds = useMemo(() => {
    const documentIds = new Set(documentFiles.map(file => file.id));
    return selectedAttachmentIds.filter(id => documentIds.has(id));
  }, [documentFiles, selectedAttachmentIds]);

  useEffect(() => {
    setSelectedAttachmentIds((previous) => {
      const available = new Set(attachments.map(entry => entry.id));
      const filtered = previous.filter(id => available.has(id));
      if (filtered.length === previous.length) return previous;
      return filtered;
    });
  }, [attachments]);

  useEffect(() => {
    if (!activeVideoFileId) return;
    if (attachments.some(entry => entry.id === activeVideoFileId)) return;
    setActiveVideoFileId(null);
  }, [activeVideoFileId, attachments]);

  useEffect(() => {
    if (!activeDwgFileId) return;
    if (attachments.some(entry => entry.id === activeDwgFileId)) return;
    setActiveDwgFileId(null);
  }, [activeDwgFileId, attachments]);

  useEffect(() => {
    if (!activeOfficeFileId) return;
    if (attachments.some(entry => entry.id === activeOfficeFileId)) return;

    setActiveOfficeFileId(null);
    setOfficeSession(null);
  }, [activeOfficeFileId, attachments]);
  useEffect(() => {
    if (!activeDrawioFileId) return;
    if (attachments.some(entry => entry.id === activeDrawioFileId)) return;

    setActiveDrawioFileId(null);
    setDrawioSession(null);
  }, [activeDrawioFileId, attachments]);


  const imageCardUrl = (file: ProjectFileEntry) => file.previewUrl || file.thumbnailUrl || file.downloadUrl || null;
  const attachmentDownloadUrl = (file: ProjectFileEntry) => file.downloadAttachmentUrl || file.downloadUrl || null;

  const activeDwgDownloadUrl = activeDwgFile ? activeDwgFile.downloadUrl || activeDwgFile.downloadAttachmentUrl || null : null;

  const activeDwgDocument = useMemo<PlanDocument | null>(() => {
    if (!activeDwgFile || !activeDwgDownloadUrl) return null;

    return {
      type: "dwg",
      name: activeDwgFile.fileName,
      source: { kind: "url", url: activeDwgDownloadUrl },
    };
  }, [activeDwgDownloadUrl, activeDwgFile?.fileName]);

  const imageCardFallback = (file: ProjectFileEntry) => {
    if (file.thumbnailStatus === 'queued' || file.thumbnailStatus === 'processing') {
      return uiText('Vorschau wird erstellt');
    }

    if (file.thumbnailStatus === 'failed') {
      return uiText('Vorschau fehlgeschlagen');
    }

    return uiText('Keine Vorschau');
  };

  const closeImageViewer = () => {
    setActiveImageIndex(null);
    clearOpenFileParam();
  };

  const openVideoViewer = (file: ProjectFileEntry) => {
    if (!attachmentDownloadUrl(file)) return;
    setVideoError(null);
    setActiveVideoFileId(file.id);
  };

  const closeVideoViewer = () => {
    setActiveVideoFileId(null);
    setVideoError(null);
    clearOpenFileParam();
  };

  const openDwgViewer = (file: ProjectFileEntry) => {
    if (!attachmentDownloadUrl(file)) return;
    setActiveDwgFileId(file.id);
  };

  const closeDwgViewer = () => {
    setActiveDwgFileId(null);
    clearOpenFileParam();
  };

  const openOfficeEditor = async (file: ProjectFileEntry) => {
    setActiveOfficeFileId(file.id);
    setOfficeSession(null);
    setOfficeError(null);
    setOfficeLoading(true);

    const [session, error] = await client.query("projects.files.officeConfig", {
      fileId: file.id,
      projectId: project.id,
    });

    setOfficeLoading(false);

    if (error || !session) {
      setOfficeError(
        error?.message
          ?? uiText("Das Dokument konnte nicht geöffnet werden.", "The document could not be opened."),
      );
      return;
    }

    setOfficeSession(session);
  };

  const closeOfficeEditor = useCallback(() => {
    setActiveOfficeFileId(null);
    setOfficeSession(null);
    setOfficeError(null);
    clearOpenFileParam();

    void client.invalidate("projects.files.list");
  }, [clearOpenFileParam]);
  const openDrawioEditor = async (file: ProjectFileEntry) => {
    setActiveDrawioFileId(file.id);
    setDrawioSession(null);
    setDrawioError(null);
    setDrawioLoading(true);

    const [session, error] = await client.query("projects.files.drawioConfig", {
      fileId: file.id,
      projectId: project.id,
    });

    setDrawioLoading(false);

    if (error || !session) {
      setDrawioError(
        error?.message
          ?? uiText("Das Diagramm konnte nicht geöffnet werden.", "The diagram could not be opened."),
      );
      return;
    }

    setDrawioSession(session);
  };

  const closeDrawioEditor = useCallback(() => {
    setActiveDrawioFileId(null);
    setDrawioSession(null);
    setDrawioError(null);
    clearOpenFileParam();

    void client.invalidate("projects.files.list");
  }, [clearOpenFileParam]);

  const saveDrawio = useCallback(async (xml: string, version: bigint) => {
    if (!activeDrawioFileId) {
      throw new Error(uiText("Das Diagramm ist nicht mehr geöffnet.", "The diagram is no longer open."));
    }

    const [result, error] = await client.mutate("projects.files.drawioSave", {
      projectId: project.id,
      fileId: activeDrawioFileId,
      version,
      xml,
    });
    if (error || !result) {
      throw error ?? new Error(uiText("Das Diagramm konnte nicht gespeichert werden.", "The diagram could not be saved."));
    }

    return result.version;
  }, [activeDrawioFileId, project.id]);


  const toggleAttachmentSelection = (fileId: string) => {
    setSelectedAttachmentIds((previous) => {
      if (previous.includes(fileId)) {
        return previous.filter(id => id !== fileId);
      }

      return [...previous, fileId];
    });
  };

  const selectAllAttachments = () => {
    setSelectedAttachmentIds(attachments.map(file => file.id));
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
  };

  const selectionMenuItems = useMemo<Parameters<typeof MyDropdown>[0]['items']>(() => {
    const items: Parameters<typeof MyDropdown>[0]['items'] = [
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

  const showPreviousImage = () => {
    setActiveImageIndex((value) => {
      if (value == null || !imageFiles.length) return value;
      if (value <= 0) return imageFiles.length - 1;
      return value - 1;
    });
  };

  const showNextImage = () => {
    setActiveImageIndex((value) => {
      if (value == null || !imageFiles.length) return value;
      if (value >= imageFiles.length - 1) return 0;
      return value + 1;
    });
  };

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
      if (event.key === 'Escape') {
        event.preventDefault();
        closeImageViewer();
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showPreviousImage();
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        showNextImage();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeImageIndex, imageFiles.length]);

  async function uploadProjectFile(file: File, folderId: string | null) {
    const [uploadData, createError] = await client.mutate("projects.files.createUpload", {
      projectId: project.id,
      folderId,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: Number.isFinite(file.size) ? file.size : null,
    });
    if (createError || !uploadData) {
      throw createError ?? new Error(uiText("Upload konnte nicht vorbereitet werden.", "Upload could not be prepared."));
    }

    const response = await fetch(uploadData.uploadUrl, {
      method: uploadData.uploadMethod,
      headers: uploadData.uploadHeaders,
      body: file,
    });
    if (!response.ok) {
      throw new Error(uiText(
        `Datei-Upload fehlgeschlagen (${response.status})`,
        `File upload failed (${response.status})`,
      ));
    }

    const [, completeError] = await client.mutate("projects.files.completeUpload", {
      projectId: project.id,
      fileId: uploadData.fileId,
      etag: response.headers.get("etag"),
    });
    if (completeError) throw completeError;

    return uploadData.fileId;
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

      await client.invalidate('projects.files.list');
      notifications.success({
        title: selected.length === 1
          ? uiText("Datei hochgeladen", "File uploaded")
          : uiText(`${selected.length} Dateien hochgeladen`, `${selected.length} files uploaded`),
      });
    } catch (err) {
      notifications.danger({
        title: uiText("Upload fehlgeschlagen", "Upload failed"),
        content: (err as Error)?.message || uiText("Die Datei konnte nicht hochgeladen werden.", "The file could not be uploaded."),
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
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
      content: error instanceof Error
        ? error.message
        : uiText("Die Dateiablage konnte nicht aktualisiert werden.", "The file storage could not be updated."),
    });
  }

  function folderPath(folder: ProjectFileBrowserFolder) {
    const names = [folder.name];
    const seen = new Set([folder.id]);
    let parentFolderId = folder.parentFolderId;

    while (parentFolderId && !seen.has(parentFolderId)) {
      seen.add(parentFolderId);
      const parent = folders.find(candidate => candidate.id === parentFolderId);
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
      folderId = folders.find(folder => folder.id === folderId)?.parentFolderId ?? null;
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
      setSelectedAttachmentIds(previous => previous.filter(id => !fileIds.includes(id)));
      notifications.success({
        title: fileIds.length === 1
          ? uiText("Datei verschoben", "File moved")
          : uiText("Dateien verschoben", "Files moved"),
      });
    } finally {
      setBatchBusyAction(null);
    }
  }

  function showMoveFilesModal(fileIds: string[]) {
    if (!fileIds.length) return;

    const firstFile = documentFiles.find(file => file.id === fileIds[0]);
    const destinationRef = { current: firstFile?.folderId ?? "" };
    const destinations = folders.slice().sort((left, right) => folderPath(left).localeCompare(folderPath(right)));

    modals.showDefault({
      content: () => <label className="project-file-dialog-field">
        <span>{uiText("Zielordner", "Destination folder")}</span>
        <select
          className="ss-input"
          defaultValue={destinationRef.current}
          onChange={(event) => {
            destinationRef.current = event.currentTarget.value;
          }}
        >
          <option value="">{uiText("Anhänge", "Attachments")}</option>
          {destinations.map(folder => <option key={folder.id} value={folder.id}>{folderPath(folder)}</option>)}
        </select>
      </label>,
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: fileIds.length === 1
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

  async function moveFolder(folder: ProjectFileBrowserFolder, parentFolderId: string | null) {
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
      notifications.success({ title: uiText("Ordner verschoben", "Folder moved") });
    } finally {
      setBatchBusyAction(null);
    }
  }

  function showMoveFolderModal(folder: ProjectFileBrowserFolder) {
    const destinationRef = { current: folder.parentFolderId ?? "" };
    const destinations = folders
      .filter(candidate => !isFolderInside(candidate.id, folder.id))
      .sort((left, right) => folderPath(left).localeCompare(folderPath(right)));

    modals.showDefault({
      content: () => <label className="project-file-dialog-field">
        <span>{uiText("Zielordner", "Destination folder")}</span>
        <select
          className="ss-input"
          defaultValue={destinationRef.current}
          onChange={(event) => {
            destinationRef.current = event.currentTarget.value;
          }}
        >
          <option value="">{uiText("Anhänge", "Attachments")}</option>
          {destinations.map(destination => <option key={destination.id} value={destination.id}>
            {folderPath(destination)}
          </option>)}
        </select>
      </label>,
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

  function showCreateFileModal(type: NewProjectFileType, folderId: string | null) {
    const definition = NEW_PROJECT_FILE_TYPES.find(candidate => candidate.type === type);
    if (!definition) return;

    const defaultBaseName: Record<NewProjectFileType, string> = {
      docx: uiText("Unbenanntes Dokument", "Untitled document"),
      pptx: uiText("Neue Präsentation", "New presentation"),
      xlsx: uiText("Neue Arbeitsmappe", "New workbook"),
      drawio: uiText("Neues Diagramm", "New diagram"),
    };
    const nameRef = { current: `${defaultBaseName[type]}${definition.extension}` };

    modals.showDefault({
      content: () => <label className="project-file-dialog-field">
        <span>{uiText("Dateiname", "File name")}</span>
        <input
          className="ss-input"
          autoFocus
          defaultValue={nameRef.current}
          maxLength={255}
          onFocus={(event) => {
            const extensionStart = event.currentTarget.value.length - definition.extension.length;
            event.currentTarget.setSelectionRange(0, Math.max(0, extensionStart));
          }}
          onChange={(event) => {
            nameRef.current = event.currentTarget.value;
          }}
        />
      </label>,
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Neue Datei", "New file"),
        modalLabel: uiText(definition.germanLabel, definition.englishLabel),
        primaryButtonText: uiText("Erstellen", "Create"),
      }),
      onPrimaryAction: async ({ hide }) => {
        let fileName = nameRef.current.trim();
        if (!fileName) {
          throw new Error(uiText("Gib einen Dateinamen ein.", "Enter a file name."));
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
      content: () => <label className="project-file-dialog-field">
        <span>{uiText("Ordnername", "Folder name")}</span>
        <input
          className="ss-input"
          autoFocus
          maxLength={255}
          onChange={(event) => {
            nameRef.current = event.currentTarget.value;
          }}
        />
      </label>,
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Neuer Ordner", "New folder"),
        modalLabel: project.title,
        primaryButtonText: uiText("Erstellen", "Create"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const name = nameRef.current.trim();
        if (!name) throw new Error(uiText("Gib einen Ordnernamen ein.", "Enter a folder name."));

        const [, error] = await client.mutate("projects.files.folders.create", {
          projectId: project.id,
          parentFolderId,
          name,
        });
        if (error) throw error;

        await invalidateFileBrowser();
        notifications.success({ title: uiText("Ordner erstellt", "Folder created") });
        hide();
      },
    });
  }

  function showRenameFolderModal(folder: ProjectFileBrowserFolder) {
    const nameRef = { current: folder.name };

    modals.showDefault({
      content: () => <label className="project-file-dialog-field">
        <span>{uiText("Ordnername", "Folder name")}</span>
        <input
          className="ss-input"
          autoFocus
          defaultValue={folder.name}
          maxLength={255}
          onChange={(event) => {
            nameRef.current = event.currentTarget.value;
          }}
        />
      </label>,
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Ordner umbenennen", "Rename folder"),
        modalLabel: folder.name,
        primaryButtonText: uiText("Speichern", "Save"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const name = nameRef.current.trim();
        if (!name) throw new Error(uiText("Gib einen Ordnernamen ein.", "Enter a folder name."));

        const [, error] = await client.mutate("projects.files.folders.rename", {
          projectId: project.id,
          folderId: folder.id,
          name,
        });
        if (error) throw error;

        await invalidateFileBrowser();
        notifications.success({ title: uiText("Ordner umbenannt", "Folder renamed") });
        hide();
      },
    });
  }

  function showRenameFileModal(file: ProjectFileBrowserFile) {
    const nameRef = { current: file.fileName };

    modals.showDefault({
      content: () => <label className="project-file-dialog-field">
        <span>{uiText("Dateiname", "File name")}</span>
        <input
          className="ss-input"
          autoFocus
          defaultValue={file.fileName}
          maxLength={255}
          onChange={(event) => {
            nameRef.current = event.currentTarget.value;
          }}
        />
      </label>,
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: uiText("Datei umbenennen", "Rename file"),
        modalLabel: file.fileName,
        primaryButtonText: uiText("Speichern", "Save"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const fileName = nameRef.current.trim();
        if (!fileName) throw new Error(uiText("Gib einen Dateinamen ein.", "Enter a file name."));

        const [, error] = await client.mutate("projects.files.rename", {
          projectId: project.id,
          fileId: file.id,
          fileName,
        });
        if (error) throw error;

        await invalidateFileBrowser();
        notifications.success({ title: uiText("Datei umbenannt", "File renamed") });
        hide();
      },
    });
  }

  function showDeleteFolderModal(folder: ProjectFileBrowserFolder) {
    const hasContents = folders.some(candidate => candidate.parentFolderId === folder.id)
      || documentFiles.some(file => file.folderId === folder.id);

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
      content: () => <p>{uiText(
        `Soll der Ordner „${folder.name}“ gelöscht werden?`,
        `Delete the folder “${folder.name}”?`,
      )}</p>,
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
        notifications.success({ title: uiText("Ordner gelöscht", "Folder deleted") });
        hide();
      },
    });
  }

  function openBrowserFile(file: ProjectFileBrowserFile) {
    const attachment = attachments.find(candidate => candidate.id === file.id);
    if (!attachment) return;

    if (isDwgAttachment(attachment)) {
      openDwgViewer(attachment);
    } else if (isVideoAttachment(attachment)) {
      openVideoViewer(attachment);
    } else if (isDrawioAttachment(attachment)) {
      void openDrawioEditor(attachment);
    } else if (isOnlyOfficeAttachment(attachment)) {
      void openOfficeEditor(attachment);
    } else {
      const url = attachment.downloadUrl || attachment.downloadAttachmentUrl;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function downloadBrowserFile(file: ProjectFileBrowserFile) {
    const attachment = attachments.find(candidate => candidate.id === file.id);
    const url = attachment ? attachmentDownloadUrl(attachment) : null;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  async function downloadSelectedAsZip() {
    if (!selectedAttachments.length) return;
    if (batchBusyAction) return;

    setBatchBusyAction('download');

    try {
      const candidates = selectedAttachments.filter(file => !!attachmentDownloadUrl(file));
      if (!candidates.length) {
        throw new Error(uiText("Für die Auswahl sind aktuell keine Download-Links verfügbar."));
      }

      const { default: JSZip } = await import('jszip');

      const zip = new JSZip();
      const usedNames = new Set<string>();

      for (let index = 0; index < candidates.length; index += 1) {
        const file = candidates[index]!;
        const url = attachmentDownloadUrl(file);
        if (!url) continue;

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(uiText(`Download fehlgeschlagen: ${file.fileName} (${response.status})`, `Download failed: ${file.fileName} (${response.status})`));
        }

        const bytes = await response.arrayBuffer();
        const fallbackName = `datei-${index + 1}`;
        const safeName = safeZipEntryName(file.fileName, fallbackName);
        const uniqueName = ensureUniqueFileName(safeName, usedNames);

        zip.file(uniqueName, bytes);
      }

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const safeProjectTitle = `${project.title ?? ''}`
        .trim()
        .replace(/[^\w\-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'projekt';

      downloadBlob(zipBlob, uiText(`Projektanhaenge-${safeProjectTitle}.zip`, `Projectanhaenge-${safeProjectTitle}.zip`));
      notifications.success({
        title: uiText("ZIP-Archiv heruntergeladen", "ZIP archive downloaded"),
        content: candidates.length === 1
          ? uiText("1 Datei enthalten", "Contains 1 file")
          : uiText(`${candidates.length} Dateien enthalten`, `Contains ${candidates.length} files`),
      });
    } catch (err) {
      notifications.danger({
        title: uiText("ZIP-Download fehlgeschlagen", "ZIP download failed"),
        content: (err as Error)?.message || uiText("Das ZIP-Archiv konnte nicht erstellt werden.", "The ZIP archive could not be created."),
      });
    } finally {
      setBatchBusyAction(null);
    }
  }

  function showDeleteSelectedFilesConfirmModal(filesToDelete = selectedAttachments) {
    if (!filesToDelete.length) return;

    modals.showDefault({
      content: () => <>
        <p>
          {filesToDelete.length === 1
            ? uiText("Soll die ausgewählte Datei wirklich gelöscht werden?", "Delete the selected file?")
            : uiText(
              `Sollen ${filesToDelete.length} ausgewählte Dateien wirklich gelöscht werden?`,
              `Delete ${filesToDelete.length} selected files?`,
            )}{" "}
          <b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.", "This action cannot be undone.")}</b>
        </p>
      </>,
      modalProps: () => ({
        danger: true,
        noFullscreen: true,
        modalHeading: uiText("Auswahl löschen"),
        modalLabel: project.title,
        primaryButtonText: uiText("Löschen"),
      }),
      onPrimaryAction: async ({ hide }) => {
        if (batchBusyAction) return;

        setBatchBusyAction('delete');

        const selectedIds = filesToDelete.map(file => file.id);
        const selectedIdsSet = new Set(selectedIds);

        try {
          for (const fileId of selectedIds) {
            const [, err] = await client.mutate('projects.files.delete', {
              projectId: project.id,
              fileId,
            });

            if (err) throw err;
          }

          await client.invalidate('projects.files.list');

          setSelectedAttachmentIds(previous => previous.filter(id => !selectedIdsSet.has(id)));
          notifications.success({
            title: selectedIds.length === 1
              ? uiText("Datei gelöscht", "File deleted")
              : uiText(`${selectedIds.length} Dateien gelöscht`, `${selectedIds.length} files deleted`),
          });
          hide();
        } catch (err) {
          notifications.danger({
            title: uiText("Löschen fehlgeschlagen", "Deletion failed"),
            content: (err as Error)?.message || uiText("Die Dateien konnten nicht gelöscht werden.", "The files could not be deleted."),
          });
        } finally {
          setBatchBusyAction(null);
        }
      },
    });
  }

  if (!supportsProjectFiles) {
    return <MyCallout icon={Icons.Info} color="amber">{uiText("Anhänge sind für dieses Mandanten-Setup nicht aktiviert.")}</MyCallout>;
  }

  return <>
    <input
      ref={fileInputRef}
      type="file"
      multiple
      style={{ display: 'none' }}
      onChange={(event) => uploadSelectedFiles(event.target.files, uploadDestinationRef.current)}
    />

    <div className="project-files-toolbar mb-2">
      <div className="project-files-toolbar-left">
        {!!selectedAttachmentIds.length && <>
          <MyButton
            size="sm"
            kind="ghost"
            renderIcon={Icons.Download}
            disabled={!!batchBusyAction}
            loading={batchBusyAction === 'download'}
            onClick={downloadSelectedAsZip}
          >{uiText("Auswahl ZIP")}</MyButton>

          {!!selectedDocumentIds.length && <MyButton
            size="sm"
            kind="ghost"
            renderIcon={Icons.FolderMove}
            disabled={!!batchBusyAction}
            loading={batchBusyAction === 'move'}
            onClick={() => showMoveFilesModal(selectedDocumentIds)}
          >{uiText("Auswahl verschieben", "Move selection")}</MyButton>}

          <MyButton
            size="sm"
            kind="danger--tertiary"
            renderIcon={Icons.Delete}
            disabled={!!batchBusyAction}
            loading={batchBusyAction === 'delete'}
            onClick={showDeleteSelectedFilesConfirmModal}
          >{uiText("Auswahl löschen")}</MyButton>

          <MyButton
            size="sm"
            kind="ghost"
            renderIcon={Icons.Reset}
            disabled={!!batchBusyAction}
            onClick={clearAttachmentSelection}
          >{uiText("Auswahl aufheben")}</MyButton>
        </>}

        {isUploading && <span>{uiText("Upload läuft...")}</span>}
      </div>

      {!!attachments.length && <div className="project-files-toolbar-right">
        <MyDropdown icon={Icons.FilterEdit} items={selectionMenuItems} menuClassName="project-files-selection-menu" />
      </div>}
    </div>

    {!!(projectFilesErr || projectFoldersErr) && (
      <MyCallout icon={Icons.Info} color="amber">{uiText("Anhänge konnten nicht geladen werden:")} {`${(projectFilesErr ?? projectFoldersErr as Error | null)?.message ?? uiText('Unbekannter Fehler')}`}
      </MyCallout>
    )}

    {!attachments.length && !folders.length && (
      <div className="light">{uiText("Noch keine Projektanhänge vorhanden.")}</div>
    )}

    {!!imageFiles.length && <MyExpandable title={`Bilder (${imageFiles.length})`} initiallyExpanded>
      <div
        style={{
          display: 'grid',
          gap: '0.1rem',
          gridTemplateColumns: 'repeat(auto-fill, minmax(11.2rem, 1fr))',
        }}
      >
        {imageFiles.map((image, imageIndex) => (
          <div
            key={image.id}
            className={`project-files-image-tile-wrap${selectedAttachmentIdSet.has(image.id) ? ' is-selected' : ''}`}
          >
            <button
              type="button"
              title={image.fileName}
              onClick={() => openImageOrToggleSelection(image.id, imageIndex)}
              className="project-files-image-tile"
              style={{
                border: 'none',
                padding: 0,
                background: '#f4f4f4',
                cursor: 'pointer',
                display: 'block',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
              }}
            >
              {imageCardUrl(image)
                ? <img
                  src={imageCardUrl(image) ?? undefined}
                  alt={image.fileName}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
                : <div style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 6,
                  textAlign: 'center',
                }}>
                  <span className="light" style={{ fontSize: '.75rem' }}>{imageCardFallback(image)}</span>
                </div>
              }
            </button>

            <MyButton
              size="sm"
              kind="ghost"
              data-image-select-toggle="true"
              title={selectedAttachmentIdSet.has(image.id) ? uiText('Aus Auswahl entfernen', 'Remove from selection') : uiText('Zur Auswahl hinzufügen', 'Add to selection')}
              aria-label={selectedAttachmentIdSet.has(image.id) ? uiText('Aus Auswahl entfernen', 'Remove from selection') : uiText('Zur Auswahl hinzufügen', 'Add to selection')}
              style={{
                inlineSize: '1.55rem',
                blockSize: '1.55rem',
                minInlineSize: '1.55rem',
                minBlockSize: '1.55rem',
                padding: 0,
              }}
              onClick={() => toggleAttachmentSelection(image.id)}
            >
              {selectedAttachmentIdSet.has(image.id) ? <Icons.Accept /> : null}
            </MyButton>
          </div>
        ))}
      </div>
    </MyExpandable>}

    <section className="project-files-documents">
      <h3>{uiText(`Dateien (${documentFiles.length})`, `Files (${documentFiles.length})`)}</h3>

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
          const attachment = attachments.find(candidate => candidate.id === file.id);
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
          void moveFolder(folder, parentFolderId).catch(notifyOrganizationError);
        }}
        onChooseFolderDestination={showMoveFolderModal}
        onDeleteFolder={showDeleteFolderModal}
        onUploadFiles={(files, folderId) => {
          void uploadSelectedFiles(files, folderId);
        }}
        onChooseUpload={chooseFilesForUpload}
      />
    </section>


    {!!activeDrawioFile && (
      <Modal
        open
        passiveModal
        modalHeading={drawioSession?.canEdit
          ? uiText("Diagramm bearbeiten", "Edit diagram")
          : uiText("Diagramm ansehen", "View diagram")}
        modalLabel={activeDrawioFile.fileName}
        closeButtonLabel={uiText("Schließen", "Close")}
        onRequestClose={closeDrawioEditor}
        data-fullheight="true"
        data-fullwidth="true"
        className="project-files-drawio-modal"
      >
        {drawioLoading && (
          <div className="project-files-office-status">
            {uiText("Diagramm wird geöffnet …", "Opening diagram …")}
          </div>
        )}

        {!!drawioError && (
          <div className="project-files-office-status">
            <MyCallout icon={Icons.Deny} color="red">{drawioError}</MyCallout>
          </div>
        )}

        {!!drawioSession && (
          <DrawioEditor
            editorUrl={drawioSession.editorUrl}
            fileName={drawioSession.fileName}
            xml={drawioSession.xml}
            version={drawioSession.version}
            canEdit={drawioSession.canEdit}
            onSave={saveDrawio}
            onClose={closeDrawioEditor}
            onError={setDrawioError}
          />
        )}
      </Modal>
    )}

    {!!activeOfficeFile && (
      <Modal
        open
        passiveModal
        modalHeading={officeSession?.canEdit
          ? uiText("Dokument bearbeiten", "Edit document")
          : uiText("Dokument ansehen", "View document")}
        modalLabel={activeOfficeFile.fileName}
        closeButtonLabel={uiText("Schließen", "Close")}
        onRequestClose={closeOfficeEditor}
        data-fullheight="true"
        data-fullwidth="true"
        className="project-files-office-modal"
      >
        {officeLoading && (
          <div className="project-files-office-status">
            {uiText("Dokument wird geöffnet …", "Opening document …")}
          </div>
        )}

        {!!officeError && (
          <div className="project-files-office-status">
            <MyCallout icon={Icons.Deny} color="red">{officeError}</MyCallout>
          </div>
        )}

        {!!officeSession && (
          <OnlyOfficeEditor
            apiUrl={officeSession.apiUrl}
            config={officeSession.config}
            onError={setOfficeError}
            onRequestClose={closeOfficeEditor}
          />
        )}
      </Modal>
    )}


    {!!activeDwgFile && (
      <Modal
        open
        passiveModal
        modalHeading={uiText("DWG Viewer")}
        modalLabel={project.title}
        closeButtonLabel={uiText("Schließen")}
        onRequestClose={closeDwgViewer}
        data-fullheight="true"
        data-fullwidth="true"
        className="project-files-dwg-modal"
      >
        <div className="project-files-dwg-viewer">
          <div className="project-files-dwg-header">
            <div>
              <div style={{ fontWeight: 600 }}>{activeDwgFile.fileName}</div>
              <div className="light" style={{ fontSize: ".9rem" }}>
                {formatBytes(activeDwgFile.sizeBytes)} · {formatDate(activeDwgFile.createdAt)}
              </div>
            </div>

            <MyDropdown
              items={[
                {
                  label: uiText("Original öffnen"),
                  renderIcon: Icons.Search,
                  hideIf: !activeDwgFile.downloadUrl,
                  onClick: () => {
                    if (!activeDwgFile.downloadUrl) return;
                    window.open(activeDwgFile.downloadUrl, "_blank", "noopener,noreferrer");
                  },
                },
                {
                  label: uiText("Herunterladen"),
                  renderIcon: Icons.Download,
                  hideIf: !activeDwgFile.downloadAttachmentUrl && !activeDwgFile.downloadUrl,
                  onClick: () => {
                    const attachmentUrl = activeDwgFile.downloadAttachmentUrl || activeDwgFile.downloadUrl;
                    if (!attachmentUrl) return;
                    window.open(attachmentUrl, "_blank", "noopener,noreferrer");
                  },
                },
              ]}
            />
          </div>

          <div className="project-files-dwg-canvas">
            {activeDwgDocument
              ? <PlanViewer
                document={activeDwgDocument}
                defaultUnit="m"
              />
              : <MyCallout icon={Icons.Info} color="amber">{uiText("Für diese DWG-Datei ist aktuell kein Download-Link verfügbar.")}</MyCallout>
            }
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
        data-fullheight="true"
        data-fullwidth="true"
        className="project-files-video-modal"
      >
        <div className="project-files-media-viewer">
          <div className="project-files-media-header">
            <div className="project-files-media-details">
              <strong>{activeVideo.fileName}</strong>
              <span>{formatBytes(activeVideo.sizeBytes)} · {formatDate(activeVideo.createdAt)}</span>
            </div>

            <MyDropdown
              items={[
                {
                  label: uiText("Original öffnen", "Open original"),
                  renderIcon: Icons.Search,
                  hideIf: !activeVideo.downloadUrl,
                  onClick: () => {
                    if (!activeVideo.downloadUrl) return;
                    window.open(activeVideo.downloadUrl, "_blank", "noopener,noreferrer");
                  },
                },
                {
                  label: uiText("Herunterladen", "Download"),
                  renderIcon: Icons.Download,
                  hideIf: !activeVideo.downloadAttachmentUrl && !activeVideo.downloadUrl,
                  onClick: () => {
                    const url = activeVideo.downloadAttachmentUrl || activeVideo.downloadUrl;
                    if (url) window.open(url, "_blank", "noopener,noreferrer");
                  },
                },
              ]}
            />
          </div>

          <div className="project-files-video-stage">
            {videoError
              ? <MyCallout icon={Icons.Deny} color="red">{videoError}</MyCallout>
              : <video
                key={activeVideo.id}
                controls
                playsInline
                preload="metadata"
                aria-label={activeVideo.fileName}
                onError={() => setVideoError(uiText(
                  "Das Video kann in diesem Browser nicht wiedergegeben werden.",
                  "This video cannot be played in this browser.",
                ))}
              >
                <source
                  src={activeVideo.downloadUrl || activeVideo.downloadAttachmentUrl || undefined}
                  type={activeVideo.mimeType.toLocaleLowerCase().startsWith("video/") ? activeVideo.mimeType : undefined}
                />
              </video>}
          </div>
        </div>
      </Modal>
    )}

    {!!activeImage && (
      <Modal
        open
        passiveModal
        modalHeading={uiText("Bilder")}
        modalLabel={project.title}
        closeButtonLabel={uiText("Schließen")}
        onRequestClose={closeImageViewer}
        data-fullheight="true"
        data-fullwidth="true"
        className="project-files-image-modal"
      >
        <div className="project-files-media-viewer">
          <div className="project-files-media-header">
            <div className="project-files-media-details">
              <strong>{activeImage.fileName}</strong>
              <span>{uiText("Bild", "Image")} {(activeImageIndex ?? 0) + 1} {uiText("von", "of")} {imageFiles.length} · {formatBytes(activeImage.sizeBytes)} · {formatDate(activeImage.createdAt)}</span>
            </div>

            <MyDropdown
              items={[
                {
                  label: uiText("Original öffnen", "Open original"),
                  renderIcon: Icons.Search,
                  hideIf: !activeImage.downloadUrl,
                  onClick: () => {
                    if (!activeImage.downloadUrl) return;
                    window.open(activeImage.downloadUrl, "_blank", "noopener,noreferrer");
                  },
                },
                {
                  label: uiText("Herunterladen", "Download"),
                  renderIcon: Icons.Download,
                  hideIf: !activeImage.downloadAttachmentUrl && !activeImage.downloadUrl,
                  onClick: () => {
                    const url = activeImage.downloadAttachmentUrl || activeImage.downloadUrl;
                    if (url) window.open(url, "_blank", "noopener,noreferrer");
                  },
                },
              ]}
            />
          </div>

          {activeImage.downloadUrl
            ? <ZoomableImage
                src={activeImage.downloadUrl}
                alt={activeImage.fileName}
                hasMultipleImages={imageFiles.length > 1}
                onPrevious={showPreviousImage}
                onNext={showNextImage}
              />
            : <div className="project-files-media-unavailable">
              <MyCallout icon={Icons.Info} color="amber">{uiText("Für dieses Bild konnte keine Vorschau geladen werden.")}</MyCallout>
            </div>}
        </div>
      </Modal>
    )}
  </>;
}
