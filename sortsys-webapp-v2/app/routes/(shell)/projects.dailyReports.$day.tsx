import {
  client,
  projectFiles as privateProjectFiles,
  protectedContent,
} from "~/lib/client";
import { inspectProjectFile } from "~/lib/fileInspection";
import { uiText } from "~/lib/i18n";
import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useProtectedState } from "~/hooks/useProtectedState";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { AttrList } from "~/components/AttrList";
import { Awaited } from "~/components/Awaited";
import { MyCallout } from "~/components/MyCallout";
import { formatDate, formatNumber, userFullName } from "~/lib/format";
import { readExportReferences } from "~/lib/exportReferences";
import { memberLink, projectLink } from "~/lib/recordLinks";
import { MyDivider } from "~/components/MyDivider";
import { useTitle } from "~/hooks/useTitle";
import { MyTable } from "~/components/MyTable";
import { MyExpandable } from "~/components/MyExpandable";
import { MyDropdown } from "~/components/MyDropdown";
import { FileResourceImage } from "~/components/FileResourceImage";
import ProjectFilePreviewModal from "~/components/ProjectFilePreviewModal";
import { Icons } from "~/lib/icons";
import type { ProjectFileTarget } from "~/lib/projectFileLinks";
import {
  renderStructuredPdf,
  formatPdfNumber,
  type PdfImageSection,
  type PdfTableSection,
} from "~/lib/pdf";
import { deliverBlob, type BlobTarget } from "~/lib/utils";
import {
  showDeleteDailyProjectReportModal,
  showModifyDailyProjectReportModal,
} from "~/modals/dailyProjectReport";
import type { DailyProjectReport } from "~/type-helpers";
import { of } from "rxjs";

function describeWeather(weather: DailyProjectReport["weather"]) {
  const rows: [label: string, value: string][] = [];
  if (!weather) return rows;

  if (weather.summary) rows.push([uiText("Beschreibung"), weather.summary]);

  const measurements = [
    ["Temperatur", weather.temperatureC, "°C"],
    ["Niederschlag", weather.precipitationMm, "mm"],
    ["Wind", weather.windKph, "km/h"],
  ] as const;
  for (const [label, value, unit] of measurements) {
    if (typeof value === "number") {
      rows.push([label, `${formatNumber(value)} ${unit}`]);
    }
  }

  return rows;
}

export default function DailyProjectReportDetailPage() {
  const { id, day } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);
  const [photoErr, setPhotoErr] = useProtectedState<string | null>(null);
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const [removingPhotoId, setRemovingPhotoId] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto, contentContext] =
    useProtectedState<ProjectFileTarget | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const dayKey = useMemo(() => {
    if (!day) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  }, [day]);

  const [report, err] = useClientStream(() => {
    if (!id || !dayKey) return of([null, null]);
    return client.streamQuery("projects.dailyReports.get", {
      projectId: id,
      day: dayKey,
    });
  }, [id, dayKey]);

  useTitle(
    () =>
      report
        ? uiText(
            `Bautagesbericht ${formatDate(report.day)}`,
            `Daily report ${formatDate(report.day)}`,
          )
        : null,
    [report?.day],
  );

  async function exportDailyReportToPdf(target: BlobTarget = "open") {
    const currentReport = report;
    if (!currentReport) return;
    const pdfWindow = target === "open" ? window.open("", "_blank") : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const [project] = await client.query(
        "projects.get",
        { id: currentReport.projectId },
        { strategy: "cache-first" },
      );

      const userMap = await readExportReferences(
        client,
        "users.get",
        currentReport.workHours.map((entry) => entry.userId),
      );

      const sortedWorkHours = [...currentReport.workHours].sort(
        (left, right) => {
          const leftLabel = left.userId
            ? userMap.get(left.userId)
              ? userFullName(userMap.get(left.userId)!)
              : left.userId
            : "Unbekannt";
          const rightLabel = right.userId
            ? userMap.get(right.userId)
              ? userFullName(userMap.get(right.userId)!)
              : right.userId
            : "Unbekannt";
          return leftLabel.localeCompare(rightLabel, "de", {
            sensitivity: "base",
          });
        },
      );

      const workHourRows = sortedWorkHours.map((entry) => {
        const user = entry.userId ? userMap.get(entry.userId) : null;
        return [
          user ? userFullName(user) : "Unbekannt",
          formatPdfNumber(entry.hours),
        ];
      });

      const totalHours = currentReport.workHours.reduce(
        (sum, entry) => sum + Number(entry.hours ?? 0),
        0,
      );

      const summaryRows: PdfTableSection["rows"] = [
        [uiText("Projekt"), project?.title ?? "Unbekannt"],
        ["Tag", formatDate(currentReport.day, "long")],
        [
          uiText("Gesamtstunden", "Total hours"),
          { value: `${formatPdfNumber(totalHours)} h`, bold: true },
        ],
      ];

      const sections: PdfTableSection[] = [
        {
          title: uiText("Zusammenfassung"),
          columns: [uiText("Kennzahl"), uiText("Wert")],
          rows: summaryRows,
          presentation: "summary",
          withHeader: false,
          align: ["left", "left"],
          columnWidths: ["1fr", "2fr"],
        },
      ];

      if (currentReport.summary?.trim()) {
        sections.push({
          title: uiText("Beschreibung der Arbeiten"),
          columns: [""],
          rows: [[currentReport.summary]],
          withHeader: false,
        });
      }

      if (workHourRows.length > 0) {
        sections.push({
          title: uiText("Arbeitszeit"),
          columns: ["Mitarbeiter", uiText("Stunden")],
          rows: workHourRows,
          totalRows: [[uiText("Gesamt", "Total"), formatPdfNumber(totalHours)]],
          align: ["left", "right"],
          columnWidths: ["2fr", "1fr"],
        });
      }

      const weatherRows = describeWeather(currentReport.weather);
      if (weatherRows.length > 0) {
        sections.push({
          title: uiText("Wetter"),
          columns: ["Feld", uiText("Wert")],
          rows: weatherRows,
          withHeader: false,
          align: ["left", "left"],
          columnWidths: ["1fr", "2fr"],
        });
      }

      const photoImages = (currentReport.photos ?? [])
        .map((photo, index) => ({
          title: uiText(`Foto ${index + 1}`, `Photo ${index + 1}`),
          caption: `${photo.fileName} · ${formatDate(photo.createdAt)}`,
          url:
            photo.downloadUrl || photo.previewUrl || photo.thumbnailUrl || "",
          fileName: photo.fileName,
          mimeType: photo.mimeType,
        }))
        .filter((image) => !!image.url);
      const imageSections: PdfImageSection[] = photoImages.length
        ? [
            {
              title: uiText("Fotos"),
              subtitle: uiText(
                `${photoImages.length} ${photoImages.length === 1 ? "Foto" : "Fotos"} zum Bautagesbericht`,
                `${photoImages.length} ${photoImages.length === 1 ? "photo" : "photos"} for the daily report`,
              ),
              images: photoImages,
            },
          ]
        : [];

      const pdfData = await renderStructuredPdf({
        title: uiText(
          `Bautagesbericht ${formatDate(currentReport.day, "long")}`,
          `Daily report ${formatDate(currentReport.day, "long")}`,
        ),
        reportLabel: uiText("Bautagesbericht"),
        showReportLabel: false,
        sections,
        imageSections,
        emptyMessage: uiText("Keine Daten zum Bautagesbericht verfügbar."),
      });

      const safeSuffix = currentReport.day
        .toISOString()
        .slice(0, 10)
        .replace(/[^\w\-]+/g, "-");
      contentContext.throwIfAborted();
      if (contentContext !== protectedContent.context())
        throw new DOMException("Aborted", "AbortError");
      const blob = new Blob([pdfData] as any, { type: "application/pdf" });
      deliverBlob(
        blob,
        uiText(
          `Bautagesbericht-${safeSuffix}.pdf`,
          `Daily report-${safeSuffix}.pdf`,
        ),
        target,
        pdfWindow,
      );
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      if (
        contentContext.aborted ||
        contentContext !== protectedContent.context()
      )
        return;
      setPdfExportErr(
        (err as Error)?.message ||
          uiText("Unbekannter Fehler beim PDF-Export."),
      );
    } finally {
      setIsPdfExporting(false);
    }
  }

  useShortcut("Control+e", (e) => {
    if (
      !report ||
      !sessionInfo.canAccess(
        `project:${id}:daily-reports`,
        "master-data",
        "update",
      )
    )
      return;
    e.preventDefault();
    showModifyDailyProjectReportModal(modals, report);
  });

  useShortcut("Control+p", (e) => {
    if (!report || !sessionInfo.canDo("view:dailyProjectReports")) return;
    e.preventDefault();
    if (isPdfExporting) return;
    void exportDailyReportToPdf("open");
  });

  const canManagePhotos =
    sessionInfo.supportsProjectFiles() &&
    sessionInfo.canAccess(
      `project:${id}:daily-reports`,
      "master-data",
      "update",
    );
  const canAddPhotos =
    canManagePhotos &&
    sessionInfo.canAccess(`project:${id}`, "attachment", "read") &&
    sessionInfo.canAccess(`project:${id}`, "attachment", "create");

  async function uploadDailyReportPhotos(fileList: FileList | null) {
    if (!fileList?.length || !report || !dayKey || !canAddPhotos) return;
    if (isPhotoUploading) return;

    setPhotoErr(null);
    setIsPhotoUploading(true);

    try {
      const files = Array.from(fileList);
      for (const file of files) {
        contentContext.throwIfAborted();
        if (!file.type.toLowerCase().startsWith("image/")) {
          throw new Error(
            uiText(
              `${file.name} ist kein Bild.`,
              `${file.name} is not an image.`,
            ),
          );
        }

        const fileId = await privateProjectFiles.upload({
          projectId: report.projectId,
          name: file.name,
          mime: file.type || "application/octet-stream",
          blob: file,
          inspect: (signal) =>
            inspectProjectFile(file, AbortSignal.any([signal, contentContext])),
        });
        contentContext.throwIfAborted();

        const [, attachErr] = await client.mutate(
          "projects.dailyReports.photos.add",
          {
            projectId: report.projectId,
            day: dayKey,
            fileId,
          },
        );
        if (attachErr) throw attachErr;
      }

      await Promise.all([
        client.invalidate("projects.dailyReports.get"),
        client.invalidate("projects.dailyReports.list"),
        client.invalidate("projects.files.list"),
      ]);
    } catch (err) {
      setPhotoErr(
        (err as Error)?.message ||
          uiText("Fotos konnten nicht hochgeladen werden."),
      );
    } finally {
      setIsPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  async function removeDailyReportPhoto(fileId: string) {
    if (!report || !dayKey || !canManagePhotos || contentContext.aborted) return;
    if (removingPhotoId) return;

    setPhotoErr(null);
    setRemovingPhotoId(fileId);

    try {
      const [, err] = await client.mutate(
        "projects.dailyReports.photos.remove",
        {
          projectId: report.projectId,
          day: dayKey,
          fileId,
        },
      );
      if (err) throw err;

      await Promise.all([
        client.invalidate("projects.dailyReports.get"),
        client.invalidate("projects.dailyReports.list"),
      ]);
    } catch (err) {
      setPhotoErr(
        (err as Error)?.message || uiText("Foto konnte nicht entfernt werden."),
      );
    } finally {
      setRemovingPhotoId(null);
    }
  }

  if (err) return <NotFound reason="resourceNotFound" />;
  if (!report) return;

  const weatherRows = describeWeather(report.weather);
  const photos = report.photos ?? [];

  return (
    <>
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(event) => uploadDailyReportPhotos(event.target.files)}
      />

      <MyHeader
        title={uiText(`Bautagesbericht`)}
        actions={
          <MyDropdown
            items={[
              {
                label: isPdfExporting
                  ? uiText("PDF wird erstellt...")
                  : uiText("PDF"),
                renderIcon: Icons.Download,
                hideIf: !sessionInfo.canDo("view:dailyProjectReports"),
                disabled: isPdfExporting,
                onClick: () => exportDailyReportToPdf(),
              },
              {
                label: isPhotoUploading
                  ? uiText("Fotos werden hochgeladen...")
                  : uiText("Fotos hinzufügen"),
                renderIcon: Icons.Create,
                hideIf: !canAddPhotos,
                disabled: isPhotoUploading,
                onClick: () => photoInputRef.current?.click(),
              },
              {
                label: uiText("Bearbeiten"),
                renderIcon: Icons.Edit,
                hideIf: !sessionInfo.canAccess(
                  `project:${id}:daily-reports`,
                  "master-data",
                  "update",
                ),
                onClick: () =>
                  showModifyDailyProjectReportModal(modals, report),
              },
              {
                label: uiText("Löschen"),
                renderIcon: Icons.Delete,
                hideIf: !sessionInfo.canAccess(
                  `project:${id}:daily-reports`,
                  "master-data",
                  "delete",
                ),
                onClick: () =>
                  showDeleteDailyProjectReportModal(modals, report),
              },
            ]}
          />
        }
      />

      {!!pdfExportErr && (
        <MyCallout icon={Icons.Deny} color="red">
          {uiText("PDF-Export fehlgeschlagen:")} {pdfExportErr}
        </MyCallout>
      )}

      {!!photoErr && (
        <MyCallout icon={Icons.Deny} color="red">
          {uiText("Foto-Aktion fehlgeschlagen:")} {photoErr}
        </MyCallout>
      )}

      <AttrList>
        <AttrList.Attr
          name={uiText("Projekt")}
          value={<Awaited promise={() => projectLink(report.projectId)} />}
        />

        <AttrList.Attr name="Tag" value={formatDate(report.day)} />
        {!!report.summary && (
          <AttrList.Attr
            name={uiText("Beschreibung der Arbeiten")}
            value={report.summary}
          />
        )}
        <AttrList.Attr
          name={uiText("Erstellt am")}
          value={formatDate(report.createdAt)}
        />
        {!!report.createdByUserId && (
          <AttrList.Attr
            name={uiText("Erstellt von")}
            value={<Awaited promise={() => memberLink(report.createdByUserId)} />}
          />
        )}
      </AttrList>

      <MyDivider />

      {!!report.workHours.length && (
        <MyExpandable title={uiText("Arbeitszeit")}>
          <MyTable
            className="th-25rem"
            rows={report.workHours}
            columns={[
              {
                label: uiText("Mitarbeiter"),
                render: (row) => memberLink(row.userId),
              },
              {
                label: uiText("Stunden"),
                render: (row) => formatNumber(row.hours),
                sortKey: (row) => row.hours,
              },
            ]}
            loadMore={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {weatherRows.length > 0 && (
        <MyExpandable title={uiText("Wetter")} initiallyExpanded>
          <AttrList>
            {weatherRows.map(([label, value]) => (
              <AttrList.Attr key={label} name={label} value={value} />
            ))}
          </AttrList>
        </MyExpandable>
      )}

      {!!photos.length && (
        <MyExpandable
          title={uiText(
            `Fotos (${photos.length})`,
            `Photos (${photos.length})`,
          )}
          initiallyExpanded
        >
          <div className="daily-report-photo-grid">
            {photos.map((photo) => {
              const imageUrl =
                photo.previewUrl ||
                photo.thumbnailUrl ||
                photo.downloadUrl ||
                null;
              return (
                <div key={photo.id} className="daily-report-photo-card">
                  {imageUrl ? (
                    <button
                      type="button"
                      className="daily-report-photo-preview"
                      onClick={() =>
                        setSelectedPhoto({
                          projectId: report.projectId,
                          fileId: photo.id,
                        })
                      }
                    >
                      <FileResourceImage src={imageUrl} alt={photo.fileName} />
                    </button>
                  ) : (
                    <div className="daily-report-photo-placeholder">
                      {uiText("Keine Vorschau")}
                    </div>
                  )}
                  <div className="daily-report-photo-meta">
                    <div className="daily-report-photo-title">
                      {photo.fileName}
                    </div>
                    <div className="light">{formatDate(photo.createdAt)}</div>
                    {canManagePhotos && (
                      <MyDropdown
                        items={[
                          {
                            label:
                              removingPhotoId === photo.id
                                ? uiText("Wird entfernt...")
                                : uiText("Aus Bericht entfernen"),
                            renderIcon: Icons.Delete,
                            disabled: !!removingPhotoId,
                            onClick: () => removeDailyReportPhoto(photo.id),
                          },
                        ]}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </MyExpandable>
      )}
      {selectedPhoto?.projectId === report.projectId &&
        photos.some((photo) => photo.id === selectedPhoto.fileId) && (
          <ProjectFilePreviewModal
            target={selectedPhoto}
            onClose={() => setSelectedPhoto(null)}
          />
        )}
    </>
  );
}
