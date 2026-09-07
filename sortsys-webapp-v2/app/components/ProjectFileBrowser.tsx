import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";
import { formatDate } from "~/lib/format";
import { MyButton } from "~/components/MyButton";
import { MyDropdown } from "~/components/MyDropdown";
import type { NewProjectFileType } from "~/lib/blankProjectFiles";
import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

export type ProjectFileBrowserFolder = {
  id: string;
  projectId: string;
  parentFolderId: string | null;
  name: string;
  createdByUserId: string | null;
  createdAt: Date;
  modifiedAt: Date;
};

export type ProjectFileBrowserFile = {
  id: string;
  folderId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  createdAt: Date;
  modifiedAt: Date;
  downloadUrl?: string | null;
  downloadAttachmentUrl?: string | null;
  textExtractionStatus?: string;
};

type ContextTarget =
  | { kind: "folder"; folder: ProjectFileBrowserFolder }
  | { kind: "file"; file: ProjectFileBrowserFile };

type ContextMenuState = {
  x: number;
  y: number;
  target: ContextTarget;
};

type InternalDragPayload =
  | { kind: "files"; ids: string[] }
  | { kind: "folder"; id: string };

const INTERNAL_DRAG_TYPE = "application/x-sortsys-project-files";

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "–";
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

function extensionLabel(fileName: string) {
  const extension = fileName.split(".").pop();

  if (!extension || extension === fileName || extension.length > 6) return uiText("DATEI", "FILE");

  return extension.toLocaleUpperCase();
}

function fileTypeIcon(file: ProjectFileBrowserFile) {
  const extension = file.fileName.split(".").pop()?.toLocaleLowerCase() ?? "";
  const mimeType = file.mimeType.toLocaleLowerCase();

  if (extension === "pdf" || mimeType === "application/pdf") return { icon: Icons.FilePdf, kind: "pdf" };
  if (["doc", "docx", "odt", "rtf"].includes(extension)) return { icon: Icons.FileWord, kind: "word" };
  if (extension === "csv") return { icon: Icons.FileCsv, kind: "spreadsheet" };
  if (["xls", "xlsx", "ods"].includes(extension)) return { icon: Icons.FileSpreadsheet, kind: "spreadsheet" };
  if (["ppt", "pptx", "odp"].includes(extension)) return { icon: Icons.FilePresentation, kind: "presentation" };
  if (["drawio", "dio", "vsd", "vsdx"].includes(extension)) return { icon: Icons.FileDiagram, kind: "diagram" };
  if (["dwg", "dxf"].includes(extension)) return { icon: Icons.FileCad, kind: "cad" };

  if (mimeType.startsWith("image/")) return { icon: Icons.FileImage, kind: "image" };
  if (mimeType.startsWith("video/")) return { icon: Icons.FileVideo, kind: "video" };
  if (mimeType.startsWith("audio/")) return { icon: Icons.FileAudio, kind: "audio" };

  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(extension)) {
    return { icon: Icons.FileArchive, kind: "archive" };
  }

  if (extension === "json") return { icon: Icons.FileJson, kind: "code" };
  if (["xml", "xsd"].includes(extension)) return { icon: Icons.FileXml, kind: "code" };
  if (["js", "jsx", "ts", "tsx", "html", "css", "scss", "sql", "sh", "yaml", "yml", "toml"].includes(extension)) {
    return { icon: Icons.FileCode, kind: "code" };
  }
  if (["txt", "md", "log"].includes(extension) || mimeType.startsWith("text/")) {
    return { icon: Icons.FileText, kind: "text" };
  }

  return null;
}

function ProjectFileTypeIcon({ file }: { file: ProjectFileBrowserFile }) {
  const fileType = fileTypeIcon(file);
  const FileIcon = fileType?.icon;

  return <span className="project-file-browser__file-icon" data-file-type={fileType?.kind}>
    {FileIcon ? <FileIcon aria-hidden="true" /> : extensionLabel(file.fileName)}
  </span>;
}

function readInternalDrag(event: DragEvent): InternalDragPayload | null {
  const encoded = event.dataTransfer.getData(INTERNAL_DRAG_TYPE);
  if (!encoded) return null;

  try {
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== "object" || !("kind" in value)) return null;

    if (value.kind === "folder" && "id" in value && typeof value.id === "string") {
      return { kind: "folder", id: value.id };
    }

    if (value.kind === "files" && "ids" in value && Array.isArray(value.ids)) {
      const ids = value.ids.filter((id): id is string => typeof id === "string");
      return ids.length ? { kind: "files", ids } : null;
    }
  } catch {
    return null;
  }

  return null;
}

export function ProjectFileBrowser(props: {
  files: ProjectFileBrowserFile[];
  folders: ProjectFileBrowserFolder[];
  selectedFileIds: Set<string>;
  busy: boolean;
  onToggleFile: (fileId: string) => void;
  onOpenFile: (file: ProjectFileBrowserFile) => void;
  onDownloadFile: (file: ProjectFileBrowserFile) => void;
  onRenameFile: (file: ProjectFileBrowserFile) => void;
  onDeleteFile: (file: ProjectFileBrowserFile) => void;
  onMoveFiles: (fileIds: string[], folderId: string | null) => void;
  onChooseFileDestination: (fileIds: string[]) => void;
  onCreateFolder: (parentFolderId: string | null) => void;
  onRenameFolder: (folder: ProjectFileBrowserFolder) => void;
  onMoveFolder: (folder: ProjectFileBrowserFolder, parentFolderId: string | null) => void;
  onChooseFolderDestination: (folder: ProjectFileBrowserFolder) => void;
  onDeleteFolder: (folder: ProjectFileBrowserFolder) => void;
  onCreateFile: (type: NewProjectFileType, folderId: string | null) => void;
  onUploadFiles: (files: File[], folderId: string | null) => void;
  onChooseUpload: (folderId: string | null) => void;
}) {
  const {
    files,
    folders,
    selectedFileIds,
    busy,
    onToggleFile,
    onOpenFile,
    onDownloadFile,
    onRenameFile,
    onDeleteFile,
    onMoveFiles,
    onChooseFileDestination,
    onCreateFolder,
    onRenameFolder,
    onMoveFolder,
    onChooseFolderDestination,
    onDeleteFolder,
    onCreateFile,
    onUploadFiles,
    onChooseUpload,
  } = props;

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null | undefined>(undefined);

  const folderById = useMemo(() => {
    return new Map(folders.map(folder => [folder.id, folder]));
  }, [folders]);

  const documentFileIdSet = useMemo(() => new Set(files.map(file => file.id)), [files]);

  const breadcrumbs = useMemo(() => {
    const ancestors: ProjectFileBrowserFolder[] = [];
    const seen = new Set<string>();
    let folderId = currentFolderId;

    while (folderId) {
      if (seen.has(folderId)) break;
      seen.add(folderId);

      const folder = folderById.get(folderId);
      if (!folder) break;

      ancestors.unshift(folder);
      folderId = folder.parentFolderId;
    }

    return ancestors;
  }, [currentFolderId, folderById]);

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleFolders = folders
    .filter(folder => normalizedSearch
      ? folder.name.toLocaleLowerCase().includes(normalizedSearch)
      : folder.parentFolderId === currentFolderId)
    .sort((left, right) => left.name.localeCompare(right.name));
  const visibleFiles = files
    .filter(file => normalizedSearch
      ? file.fileName.toLocaleLowerCase().includes(normalizedSearch)
      : file.folderId === currentFolderId)
    .sort((left, right) => left.fileName.localeCompare(right.fileName));

  useEffect(() => {
    if (currentFolderId && !folderById.has(currentFolderId)) {
      setCurrentFolderId(null);
    }
  }, [currentFolderId, folderById]);

  useEffect(() => {
    if (!contextMenu) return;

    const close = () => setContextMenu(null);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  function openFolder(folder: ProjectFileBrowserFolder) {
    setCurrentFolderId(folder.id);
    setSearch("");
    setContextMenu(null);
  }

  function showContextMenu(event: MouseEvent, target: ContextTarget) {
    event.preventDefault();

    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 224),
      y: Math.min(event.clientY, window.innerHeight - 220),
      target,
    });
  }

  function showKeyboardContextMenu(event: KeyboardEvent<HTMLElement>, target: ContextTarget) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;

    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();

    setContextMenu({
      x: Math.min(bounds.left + 48, window.innerWidth - 224),
      y: Math.min(bounds.top + 32, window.innerHeight - 220),
      target,
    });
  }

  function startFileDrag(event: DragEvent, file: ProjectFileBrowserFile) {
    const selectedDocuments = [...selectedFileIds].filter(id => documentFileIdSet.has(id));
    const ids = selectedDocuments.includes(file.id) ? selectedDocuments : [file.id];
    const payload: InternalDragPayload = { kind: "files", ids };

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", file.fileName);
  }

  function startFolderDrag(event: DragEvent, folder: ProjectFileBrowserFolder) {
    const payload: InternalDragPayload = { kind: "folder", id: folder.id };

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", folder.name);
  }

  function allowDrop(event: DragEvent, folderId: string | null) {
    if (busy) return;

    const hasFiles = event.dataTransfer.types.includes("Files");
    const hasInternalItems = event.dataTransfer.types.includes(INTERNAL_DRAG_TYPE);
    if (!hasFiles && !hasInternalItems) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
    setDropTargetId(folderId);
  }

  function dropInto(event: DragEvent, folderId: string | null) {
    if (busy) return;

    event.preventDefault();
    event.stopPropagation();
    setDropTargetId(undefined);

    if (event.dataTransfer.files.length) {
      onUploadFiles(Array.from(event.dataTransfer.files), folderId);
      return;
    }

    const payload = readInternalDrag(event);
    if (!payload) return;

    if (payload.kind === "files") {
      onMoveFiles(payload.ids, folderId);
      return;
    }

    const folder = folderById.get(payload.id);
    if (folder && folder.id !== folderId) onMoveFolder(folder, folderId);
  }

  function locationLabel(folderId: string | null) {
    if (!folderId) return uiText("Anhänge", "Attachments");

    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = folderId;

    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = folderById.get(cursor);
      if (!folder) break;
      names.unshift(folder.name);
      cursor = folder.parentFolderId;
    }

    return names.join(" / ") || uiText("Anhänge", "Attachments");
  }

  const folderMenuItems = (folder: ProjectFileBrowserFolder) => [
    { label: uiText("Öffnen", "Open"), renderIcon: Icons.FolderOpen, onClick: () => openFolder(folder) },
    { label: uiText("Umbenennen", "Rename"), renderIcon: Icons.Edit, onClick: () => onRenameFolder(folder) },
    { label: uiText("Verschieben", "Move"), renderIcon: Icons.FolderMove, onClick: () => onChooseFolderDestination(folder) },
    { label: uiText("Löschen", "Delete"), renderIcon: Icons.Delete, onClick: () => onDeleteFolder(folder) },
  ];

  const fileMenuItems = (file: ProjectFileBrowserFile) => [
    { label: uiText("Öffnen", "Open"), renderIcon: Icons.Search, onClick: () => onOpenFile(file) },
    { label: uiText("Herunterladen", "Download"), renderIcon: Icons.Download, onClick: () => onDownloadFile(file) },
    { label: uiText("Umbenennen", "Rename"), renderIcon: Icons.Edit, onClick: () => onRenameFile(file) },
    { label: uiText("Verschieben", "Move"), renderIcon: Icons.FolderMove, onClick: () => onChooseFileDestination([file.id]) },
    { label: uiText("Löschen", "Delete"), renderIcon: Icons.Delete, onClick: () => onDeleteFile(file) },
  ];
  const createFileMenuItems = [
    { label: uiText("Word", "Word"), renderIcon: Icons.Word, onClick: () => onCreateFile("docx", currentFolderId) },
    { label: uiText("PowerPoint", "PowerPoint"), renderIcon: Icons.Presentation, onClick: () => onCreateFile("pptx", currentFolderId) },
    { label: uiText("Excel"), renderIcon: Icons.Excel, onClick: () => onCreateFile("xlsx", currentFolderId) },
    { label: uiText("DrawIO", "DrawIO"), renderIcon: Icons.Diagram, onClick: () => onCreateFile("drawio", currentFolderId) },
  ];


  return <section
    className={`project-file-browser${dropTargetId === currentFolderId ? " is-drop-target" : ""}`}
    aria-label={uiText("Dateiablage", "File storage")}
    onDragOver={(event) => allowDrop(event, currentFolderId)}
    onDragLeave={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropTargetId(undefined);
    }}
    onDrop={(event) => dropInto(event, currentFolderId)}
  >
    <div className="project-file-browser__navigation">
      <nav className="project-file-browser__breadcrumbs" aria-label={uiText("Ordnerpfad", "Folder path")}>
        <button
          type="button"
          className="project-file-browser__breadcrumb"
          onClick={() => {
            setCurrentFolderId(null);
            setSearch("");
          }}
          onDragOver={(event) => allowDrop(event, null)}
          onDrop={(event) => dropInto(event, null)}
        >
          {uiText("Anhänge", "Attachments")}
        </button>

        {breadcrumbs.map(folder => <span key={folder.id} className="project-file-browser__breadcrumb-part">
          <Icons.AccordionClosed aria-hidden="true" />
          <button
            type="button"
            className="project-file-browser__breadcrumb"
            onClick={() => setCurrentFolderId(folder.id)}
            onDragOver={(event) => allowDrop(event, folder.id)}
            onDrop={(event) => dropInto(event, folder.id)}
          >
            {folder.name}
          </button>
        </span>)}
      </nav>

      <div className="project-file-browser__tools">
        <label className="project-file-browser__search">
          <Icons.Search aria-hidden="true" />
          <span className="sr-only">{uiText("Anhänge durchsuchen", "Search attachments")}</span>
          <input
            type="search"
            value={search}
            placeholder={uiText("In Anhängen suchen", "Search attachments")}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </label>

        <MyDropdown
          icon={Icons.Plus}
          size="sm"
          label={uiText("Neu", "New")}
          ariaLabel={uiText("Neue Datei erstellen", "Create new file")}
          items={createFileMenuItems}
          menuClassName="project-file-browser__new-menu"
        />

        <MyButton
          size="sm"
          kind="ghost"
          renderIcon={Icons.Upload}
          disabled={busy}
          onClick={() => onChooseUpload(currentFolderId)}
        >
          {uiText("Dateien hochladen", "Upload files")}
        </MyButton>

        <MyButton
          size="sm"
          kind="ghost"
          renderIcon={Icons.FolderAdd}
          disabled={busy}
          onClick={() => onCreateFolder(currentFolderId)}
        >
          {uiText("Neuer Ordner", "New folder")}
        </MyButton>
      </div>
    </div>

    <div className="project-file-browser__list" role="list" aria-label={uiText("Dateien und Ordner", "Files and folders")}>
      <div className="project-file-browser__header" aria-hidden="true">
        <span aria-hidden="true" />
        <span>{uiText("Name", "Name")}</span>
        <span>{uiText("Geändert", "Modified")}</span>
        <span>{uiText("Größe", "Size")}</span>
        <span aria-hidden="true" />
      </div>

      {visibleFolders.map(folder => <div
        key={folder.id}
        className={`project-file-browser__row is-folder${dropTargetId === folder.id ? " is-drop-target" : ""}`}
        role="listitem"
        tabIndex={0}
        draggable={!busy}
        onDragStart={(event) => startFolderDrag(event, folder)}
        onDragOver={(event) => allowDrop(event, folder.id)}
        onDragLeave={() => setDropTargetId(undefined)}
        onDrop={(event) => dropInto(event, folder.id)}
        onContextMenu={(event) => showContextMenu(event, { kind: "folder", folder })}
        onKeyDown={(event) => showKeyboardContextMenu(event, { kind: "folder", folder })}
      >
        <span className="project-file-browser__select-spacer" aria-hidden="true" />
        <button type="button" className="project-file-browser__name" onClick={() => openFolder(folder)}>
          <span className="project-file-browser__file-icon is-folder"><Icons.Folder aria-hidden="true" /></span>
          <span className="project-file-browser__name-copy">
            <strong>{folder.name}</strong>
            {normalizedSearch && <small>{locationLabel(folder.parentFolderId)}</small>}
          </span>
        </button>
        <span className="project-file-browser__date">{formatDate(folder.modifiedAt)}</span>
        <span className="project-file-browser__size">–</span>
        <MyDropdown items={folderMenuItems(folder)} />
      </div>)}

      {visibleFiles.map(file => <div
        key={file.id}
        className={`project-file-browser__row is-file${selectedFileIds.has(file.id) ? " is-selected" : ""}`}
        role="listitem"
        tabIndex={0}
        draggable={!busy}
        onDragStart={(event) => startFileDrag(event, file)}
        onContextMenu={(event) => showContextMenu(event, { kind: "file", file })}
        onKeyDown={(event) => showKeyboardContextMenu(event, { kind: "file", file })}
      >
        <label className="project-file-browser__select">
          <span className="sr-only">{uiText("Datei auswählen", "Select file")}: {file.fileName}</span>
          <input
            type="checkbox"
            checked={selectedFileIds.has(file.id)}
            onChange={() => onToggleFile(file.id)}
          />
        </label>
        <button type="button" className="project-file-browser__name" onClick={() => onOpenFile(file)}>
          <ProjectFileTypeIcon file={file} />
          <span className="project-file-browser__name-copy">
            <strong>{file.fileName}</strong>
            {normalizedSearch && <small>{locationLabel(file.folderId)}</small>}
            {(file.textExtractionStatus === "pending"
              || file.textExtractionStatus === "queued"
              || file.textExtractionStatus === "processing") && <small>{uiText("Text wird erkannt …", "Recognizing text…")}</small>}
            {file.textExtractionStatus === "failed" && (
              <small className="is-failed">
                {uiText("Texterkennung fehlgeschlagen", "Text recognition failed")}
              </small>
            )}
          </span>
        </button>
        <span className="project-file-browser__date">{formatDate(file.modifiedAt)}</span>
        <span className="project-file-browser__size">{formatBytes(file.sizeBytes)}</span>
        <MyDropdown items={fileMenuItems(file)} />
      </div>)}

      {!visibleFolders.length && !visibleFiles.length && <div className="project-file-browser__empty">
        {normalizedSearch
          ? uiText("Keine passenden Anhänge gefunden.", "No matching attachments found.")
          : uiText("Dieser Ordner ist leer. Dateien können hier abgelegt oder hochgeladen werden.", "This folder is empty. Drop or upload files here.")}
      </div>}
    </div>

    <p className="project-file-browser__drop-hint">
      {uiText("Dateien hierher ziehen oder über „Dateien hochladen“ auswählen.", "Drop files here or choose Upload files.")}
    </p>

    {!!contextMenu && createPortal(
      <div
        className="project-file-browser__context-menu"
        role="menu"
        aria-label={uiText("Aktionen", "Actions")}
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        {(contextMenu.target.kind === "folder"
          ? folderMenuItems(contextMenu.target.folder)
          : fileMenuItems(contextMenu.target.file)
        ).map((item) => <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            setContextMenu(null);
            item.onClick();
          }}
        >
          <item.renderIcon aria-hidden="true" />
          <span>{item.label}</span>
        </button>)}
      </div>,
      document.body,
    )}
  </section>;
}
