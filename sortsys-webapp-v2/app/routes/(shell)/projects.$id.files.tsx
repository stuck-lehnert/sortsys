import { Modal } from "@sortsys/react-components";
import { PlanViewer, type PlanDocument } from "@sortsys/dwgviewer";
import { useOutletContext } from "react-router";
import { from } from "rxjs";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyDropdown } from "~/components/MyDropdown";
import { MyExpandable } from "~/components/MyExpandable";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useTitle } from "~/hooks/useTitle";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { downloadBlob } from "~/lib/utils";
import type { Project } from "~/type-helpers";
import { useEffect, useMemo, useRef, useState } from "react";

type ProjectFileEntry = {
  id: string;
  projectId: string;
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
  createdByUserId: string | null;
  createdAt: Date;
  uploadedAt: Date | null;
  downloadUrl?: string | null;
  downloadExpiresAt?: Date | null;
  downloadAttachmentUrl?: string | null;
  downloadAttachmentExpiresAt?: Date | null;
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

export default function ProjectFilesPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const sessionInfo = useSessionInfo();
  const modals = useMyModals();

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

  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [uploadInfo, setUploadInfo] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [batchBusyAction, setBatchBusyAction] = useState<'download' | 'delete' | null>(null);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [activeImageIndex, setActiveImageIndex] = useState<number | null>(null);
  const [activeDwgFileId, setActiveDwgFileId] = useState<string | null>(null);
  const [isImageViewerMobile, setIsImageViewerMobile] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useTitle(() => project ? `Anhänge – ${project.title}` : null, [JSON.stringify(project)]);

  const attachments = useMemo(() => {
    return ((projectFiles ?? []) as ProjectFileEntry[])
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [projectFiles]);

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

  const activeDwgFile = useMemo(() => {
    if (!activeDwgFileId) return null;
    return attachments.find(file => file.id === activeDwgFileId) ?? null;
  }, [activeDwgFileId, attachments]);

  const documentFiles = useMemo(() => {
    return attachments.filter(entry => entry.kind !== 'image' || isDwgAttachment(entry));
  }, [attachments]);

  const documentRows = useMemo(() => {
    return documentFiles.map((entry) => ({
      ...entry,
      isSelected: selectedAttachmentIdSet.has(entry.id),
    }));
  }, [documentFiles, selectedAttachmentIdSet]);

  useEffect(() => {
    setSelectedAttachmentIds((previous) => {
      const available = new Set(attachments.map(entry => entry.id));
      const filtered = previous.filter(id => available.has(id));
      if (filtered.length === previous.length) return previous;
      return filtered;
    });
  }, [attachments]);

  useEffect(() => {
    if (!activeDwgFileId) return;
    if (attachments.some(entry => entry.id === activeDwgFileId)) return;
    setActiveDwgFileId(null);
  }, [activeDwgFileId, attachments]);

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
      return 'Vorschau wird erstellt';
    }

    if (file.thumbnailStatus === 'failed') {
      return 'Vorschau fehlgeschlagen';
    }

    return 'Keine Vorschau';
  };

  const closeImageViewer = () => {
    setActiveImageIndex(null);
  };

  const openDwgViewer = (file: ProjectFileEntry) => {
    if (!attachmentDownloadUrl(file)) return;
    setActiveDwgFileId(file.id);
  };

  const closeDwgViewer = () => {
    setActiveDwgFileId(null);
  };

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
        label: 'Alle auswählen',
        renderIcon: Icons.Accept,
        hideIf: !attachments.length,
        disabled: !!batchBusyAction,
        onClick: selectAllAttachments,
      },
      {
        label: 'Auswahl aufheben',
        renderIcon: Icons.Reset,
        hideIf: !selectedAttachmentIds.length,
        disabled: !!batchBusyAction,
        onClick: clearAttachmentSelection,
      },
    ];

    attachments.forEach((attachment) => {
      items.push({
        selectable: true,
        selected: selectedAttachmentIdSet.has(attachment.id),
        label: `[${attachment.kind === 'image' ? 'Bild' : 'Datei'}] ${attachment.fileName}`,
        disabled: !!batchBusyAction,
        onClick: () => toggleAttachmentSelection(attachment.id),
      });
    });

    return items;
  }, [attachments, batchBusyAction, selectedAttachmentIdSet, selectedAttachmentIds.length]);

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
    const update = () => {
      setIsImageViewerMobile(window.innerWidth < 768);
    };

    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (activeImageIndex == null) return;

    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

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
      document.body.style.overflow = oldOverflow;
    };
  }, [activeImageIndex, imageFiles.length]);

  async function uploadSelectedFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    if (isUploading) return;
    if (batchBusyAction) return;

    setUploadErr(null);
    setUploadInfo(null);
    setIsUploading(true);

    const selected = Array.from(fileList);

    try {
      for (const file of selected) {
        const [uploadData, createErr] = await client.mutate('projects.files.createUpload', {
          projectId: project.id,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: Number.isFinite(file.size) ? file.size : null,
        });
        if (createErr || !uploadData) throw createErr ?? new Error('Upload konnte nicht vorbereitet werden.');

        const uploadRes = await fetch(uploadData.uploadUrl, {
          method: uploadData.uploadMethod,
          headers: uploadData.uploadHeaders,
          body: file,
        });
        if (!uploadRes.ok) {
          throw new Error(`Datei-Upload fehlgeschlagen (${uploadRes.status})`);
        }

        const etag = uploadRes.headers.get('etag');
        const [, completeErr] = await client.mutate('projects.files.completeUpload', {
          projectId: project.id,
          fileId: uploadData.fileId,
          etag,
        });
        if (completeErr) throw completeErr;
      }

      await client.invalidate('projects.files.list');
      setUploadInfo(`${selected.length} Datei(en) erfolgreich hochgeladen.`);
    } catch (err) {
      setUploadErr((err as Error)?.message || 'Datei-Upload fehlgeschlagen.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function downloadSelectedAsZip() {
    if (!selectedAttachments.length) return;
    if (batchBusyAction) return;

    setUploadErr(null);
    setUploadInfo(null);
    setBatchBusyAction('download');

    try {
      const candidates = selectedAttachments.filter(file => !!attachmentDownloadUrl(file));
      if (!candidates.length) {
        throw new Error('Für die Auswahl sind aktuell keine Download-Links verfügbar.');
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
          throw new Error(`Download fehlgeschlagen: ${file.fileName} (${response.status})`);
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

      downloadBlob(zipBlob, `Projektanhaenge-${safeProjectTitle}.zip`);
      setUploadInfo(`${candidates.length} Datei(en) als ZIP heruntergeladen.`);
    } catch (err) {
      setUploadErr((err as Error)?.message || 'ZIP-Download fehlgeschlagen.');
    } finally {
      setBatchBusyAction(null);
    }
  }

  function showDeleteSelectedFilesConfirmModal() {
    if (!selectedAttachments.length) return;

    modals.showDefault({
      content: () => <>
        <p>
          Soll{selectedAttachments.length === 1 ? '' : 'en'} <b>{selectedAttachments.length} ausgewählte Datei(en)</b> wirklich gelöscht werden?
          {' '}<b>Diese Aktion kann nicht rückgängig gemacht werden.</b>
        </p>
      </>,
      modalProps: () => ({
        danger: true,
        noFullscreen: true,
        modalHeading: 'Auswahl löschen',
        modalLabel: project.title,
        primaryButtonText: 'Löschen',
      }),
      onPrimaryAction: async ({ hide }) => {
        if (batchBusyAction) return;

        setUploadErr(null);
        setUploadInfo(null);
        setBatchBusyAction('delete');

        const selectedIds = selectedAttachments.map(file => file.id);
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
          setUploadInfo(`${selectedIds.length} Datei(en) wurden entfernt.`);
          hide();
        } catch (err) {
          setUploadErr((err as Error)?.message || 'Dateien konnten nicht entfernt werden.');
        } finally {
          setBatchBusyAction(null);
        }
      },
    });
  }

  if (!supportsProjectFiles) {
    return <MyCallout icon={Icons.Info} color="amber">
      Anhänge sind für dieses Mandanten-Setup nicht aktiviert.
    </MyCallout>;
  }

  return <>
    <input
      ref={fileInputRef}
      type="file"
      multiple
      style={{ display: 'none' }}
      onChange={(event) => uploadSelectedFiles(event.target.files)}
    />

    <div className="project-files-toolbar mb-2">
      <div className="project-files-toolbar-left">
        <MyButton
          size="sm"
          kind="ghost"
          renderIcon={Icons.Create}
          loading={isUploading}
          disabled={!!batchBusyAction}
          onClick={() => fileInputRef.current?.click()}
        >
          Dateien hochladen
        </MyButton>

        {!!selectedAttachmentIds.length && <>
          <MyButton
            size="sm"
            kind="ghost"
            renderIcon={Icons.Download}
            disabled={!!batchBusyAction}
            loading={batchBusyAction === 'download'}
            onClick={downloadSelectedAsZip}
          >
            Auswahl ZIP
          </MyButton>

          <MyButton
            size="sm"
            kind="danger--tertiary"
            renderIcon={Icons.Delete}
            disabled={!!batchBusyAction}
            loading={batchBusyAction === 'delete'}
            onClick={showDeleteSelectedFilesConfirmModal}
          >
            Auswahl löschen
          </MyButton>

          <MyButton
            size="sm"
            kind="ghost"
            renderIcon={Icons.Reset}
            disabled={!!batchBusyAction}
            onClick={clearAttachmentSelection}
          >
            Auswahl aufheben
          </MyButton>
        </>}

        {isUploading && <span>Upload läuft...</span>}
      </div>

      {!!attachments.length && <div className="project-files-toolbar-right">
        <MyDropdown icon={Icons.FilterEdit} items={selectionMenuItems} menuClassName="project-files-selection-menu" />
      </div>}
    </div>

    {!!projectFilesErr && (
      <MyCallout icon={Icons.Info} color="amber">
        Anhänge konnten nicht geladen werden: {`${(projectFilesErr as any)?.message ?? 'Unbekannter Fehler'}`}
      </MyCallout>
    )}

    {!!uploadInfo && (
      <AutoHideSuccessCallout resetKey={uploadInfo} onHidden={() => setUploadInfo(null)}>{uploadInfo}</AutoHideSuccessCallout>
    )}

    {!!uploadErr && (
      <MyCallout icon={Icons.Deny} color="red">{uploadErr}</MyCallout>
    )}

    {!attachments.length && (
      <div className="light">Noch keine Projektanhänge vorhanden.</div>
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
              title={selectedAttachmentIdSet.has(image.id) ? 'Aus Auswahl entfernen' : 'Zur Auswahl hinzufügen'}
              aria-label={selectedAttachmentIdSet.has(image.id) ? 'Aus Auswahl entfernen' : 'Zur Auswahl hinzufügen'}
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

    {!!documentFiles.length && <MyExpandable title={`Dateien (${documentFiles.length})`} initiallyExpanded>
      <MyTable
        tableClassName="project-files-table"
        rows={documentRows}
        columns={[
          {
            label: '',
            render: (row) => {
              const isSelected = row.isSelected;

              return <MyButton
                size="sm"
                kind="ghost"
                title={isSelected ? 'Aus Auswahl entfernen' : 'Zur Auswahl hinzufügen'}
                aria-label={isSelected ? 'Aus Auswahl entfernen' : 'Zur Auswahl hinzufügen'}
                renderIcon={isSelected ? Icons.Accept : undefined}
                style={{
                  inlineSize: '1.55rem',
                  blockSize: '1.55rem',
                  minInlineSize: '1.55rem',
                  minBlockSize: '1.55rem',
                  padding: 0,
                }}
                onClick={() => toggleAttachmentSelection(row.id)}
              />;
            },
          },
          {
            label: 'Datei',
            render: (row) => {
              const url = attachmentDownloadUrl(row);
              if (!url) return row.fileName;

              if (isDwgAttachment(row)) {
                return <button
                  type="button"
                  className="ss-link project-files-file-link"
                  onClick={() => openDwgViewer(row)}
                >
                  {row.fileName}
                </button>;
              }

              return <a href={url} target="_blank" rel="noreferrer" className="ss-link">{row.fileName}</a>;
            },
            sortKey: (row) => row.fileName.toLowerCase(),
          },
          {
            label: 'Größe',
            render: (row) => formatBytes(row.sizeBytes),
            sortKey: (row) => row.sizeBytes ?? 0,
          },
          {
            label: 'Erfasst',
            render: (row) => formatDate(row.createdAt),
            sortKey: (row) => row.createdAt.getTime(),
          },
        ]}
        pagination={{ pageSizes: [10, 25, 50] }}
      />
    </MyExpandable>}


    {!!activeDwgFile && (
      <Modal
        open
        passiveModal
        modalHeading="DWG Viewer"
        modalLabel={project.title}
        closeButtonLabel="Schließen"
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
                  label: "Original öffnen",
                  renderIcon: Icons.Search,
                  hideIf: !activeDwgFile.downloadUrl,
                  onClick: () => {
                    if (!activeDwgFile.downloadUrl) return;
                    window.open(activeDwgFile.downloadUrl, "_blank", "noopener,noreferrer");
                  },
                },
                {
                  label: "Herunterladen",
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
              : <MyCallout icon={Icons.Info} color="amber">
                Für diese DWG-Datei ist aktuell kein Download-Link verfügbar.
              </MyCallout>
            }
          </div>
        </div>
      </Modal>
    )}

    {!!activeImage && (
      <Modal
        open
        passiveModal
        modalHeading="Bilder"
        modalLabel={project.title}
        closeButtonLabel="Schließen"
        onRequestClose={closeImageViewer}
        data-fullheight="true"
        data-fullwidth="true"
        className="project-files-image-modal"
      >
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--ss-surface)',
        }}>
          <div
            className="flex flex-wrap gap-2 items-center justify-between"
            style={{
              padding: isImageViewerMobile ? '0.65rem 0.75rem' : '0.75rem 1rem',
              borderBottom: '1px solid var(--ss-border)',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{activeImage.fileName}</div>
              <div className="light" style={{ fontSize: '.9rem' }}>
                Bild {(activeImageIndex ?? 0) + 1} von {imageFiles.length} · {formatBytes(activeImage.sizeBytes)} · {formatDate(activeImage.createdAt)}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <MyDropdown
                items={[
                  {
                    label: 'Original öffnen',
                    renderIcon: Icons.Search,
                    hideIf: !activeImage.downloadUrl,
                    onClick: () => {
                      if (!activeImage.downloadUrl) return;
                      window.open(activeImage.downloadUrl, '_blank', 'noopener,noreferrer');
                    },
                  },
                  {
                    label: 'Herunterladen',
                    renderIcon: Icons.Download,
                    hideIf: !activeImage.downloadAttachmentUrl && !activeImage.downloadUrl,
                    onClick: () => {
                      const attachmentUrl = activeImage.downloadAttachmentUrl || activeImage.downloadUrl;
                      if (!attachmentUrl) return;
                      window.open(attachmentUrl, '_blank', 'noopener,noreferrer');
                    },
                  },
                ]}
              />
            </div>
          </div>

          <div
            className="flex flex-wrap gap-2 items-center justify-between"
            style={{
              padding: isImageViewerMobile ? '0.6rem 0.75rem' : '0.65rem 1rem',
              borderBottom: '1px solid var(--ss-border)',
            }}
          >
            <MyButton size="sm" kind="secondary" onClick={showPreviousImage}>
              ← Zurück
            </MyButton>

            <MyButton size="sm" kind="secondary" onClick={showNextImage}>
              Weiter →
            </MyButton>
          </div>

          <div style={{
            minHeight: 0,
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            background: 'var(--ss-surface-muted)',
          }}>
            {activeImage.downloadUrl
              ? <img
                src={activeImage.downloadUrl}
                alt={activeImage.fileName}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  display: 'block',
                }}
              />
              : <MyCallout icon={Icons.Info} color="amber">
                Für dieses Bild konnte keine Vorschau geladen werden.
              </MyCallout>
            }
          </div>
        </div>
      </Modal>
    )}
  </>;
}
