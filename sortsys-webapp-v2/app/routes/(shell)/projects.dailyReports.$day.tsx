import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { AttrList } from "~/components/AttrList";
import { Awaited } from "~/components/Awaited";
import { MyCallout } from "~/components/MyCallout";
import { MyLink } from "~/components/MyLink";
import { formatDate, formatNumber, userFullName } from "~/lib/format";
import { MyDivider } from "~/components/MyDivider";
import { useTitle } from "~/hooks/useTitle";
import { MyTable } from "~/components/MyTable";
import { MyExpandable } from "~/components/MyExpandable";
import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf, type PdfImageSection, type PdfTableSection } from "~/lib/pdf";
import { deliverBlob, type BlobTarget } from "~/lib/utils";
import { showDeleteDailyProjectReportModal, showModifyDailyProjectReportModal } from "~/modals/dailyProjectReport";
import { of } from 'rxjs';

export default function DailyProjectReportDetailPage() {
  const { id, day } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const [removingPhotoId, setRemovingPhotoId] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const dayKey = useMemo(() => {
    if (!day) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  }, [day]);

  const [report, err] = useClientStream(() => {
    if (!id || !dayKey) return of([null, null]);
    return client.streamQuery('projects.dailyReports.get', { projectId: id, day: dayKey });
  }, [id, dayKey]);

  useTitle(() => report ? `Bautagesbericht ${formatDate(report.day)}` : null, [report?.day]);

  async function exportDailyReportToPdf(target: BlobTarget = 'open') {
    const currentReport = report;
    if (!currentReport) return;
    const pdfWindow = target === 'open' ? window.open('', '_blank') : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const [project] = await client.query('projects.get', { id: currentReport.projectId }, { strategy: 'cache-first' });

      const userIds = [...new Set(currentReport.workHours.map((entry) => entry.userId).filter(Boolean))] as string[];
      const userEntries = await Promise.all(userIds.map(async (userId) => {
        const [user] = await client.query('users.get', { id: userId }, { strategy: 'cache-first' });
        return [userId, user ?? null] as const;
      }));
      const userMap = new Map(userEntries);

      const sortedWorkHours = [...currentReport.workHours].sort((left, right) => {
        const leftLabel = left.userId ? (userMap.get(left.userId) ? userFullName(userMap.get(left.userId)!) : left.userId) : 'Unbekannt';
        const rightLabel = right.userId ? (userMap.get(right.userId) ? userFullName(userMap.get(right.userId)!) : right.userId) : 'Unbekannt';
        return leftLabel.localeCompare(rightLabel, 'de', { sensitivity: 'base' });
      });

      const workHourRows = sortedWorkHours.map((entry) => {
        const user = entry.userId ? userMap.get(entry.userId) : null;
        return [
          user ? userFullName(user) : 'Unbekannt',
          formatNumber(entry.hours),
        ];
      });

      const totalHours = currentReport.workHours.reduce((sum, entry) => sum + Number(entry.hours ?? 0), 0);

      const summaryRows: string[][] = [
        ['Projekt', project?.title ?? 'Unbekannt'],
        ['Tag', formatDate(currentReport.day, 'long')],
        ['Gesamtstunden', formatNumber(totalHours)],
      ];
      if (currentReport.summary) {
        summaryRows.push(['Beschreibung der Arbeiten', currentReport.summary]);
      }

      const sections: PdfTableSection[] = [
        {
          title: 'Zusammenfassung',
          columns: ['Kennzahl', 'Wert'],
          rows: summaryRows,
          withHeader: false,
          align: ['left', 'left'],
          columnWidths: ['1fr', '2fr'],
        },
      ];

      if (workHourRows.length > 0) {
        sections.push({
          title: 'Arbeitszeit',
          columns: ['Mitarbeiter', 'Stunden'],
          rows: workHourRows,
          align: ['left', 'right'],
          columnWidths: ['2fr', '1fr'],
        });
      }

      if (currentReport.weather && Object.values(currentReport.weather).some(Boolean)) {
        const weatherRows: string[][] = [];
        if (currentReport.weather.summary) weatherRows.push(['Beschreibung', currentReport.weather.summary]);
        if (typeof currentReport.weather.temperatureC === 'number') weatherRows.push(['Temperatur', `${formatNumber(currentReport.weather.temperatureC)} °C`]);
        if (typeof currentReport.weather.precipitationMm === 'number') weatherRows.push(['Niederschlag', `${formatNumber(currentReport.weather.precipitationMm)} mm`]);
        if (typeof currentReport.weather.windKph === 'number') weatherRows.push(['Wind', `${formatNumber(currentReport.weather.windKph)} km/h`]);

        if (weatherRows.length > 0) {
          sections.push({
            title: 'Wetter',
            columns: ['Feld', 'Wert'],
            rows: weatherRows,
            withHeader: false,
            align: ['left', 'left'],
            columnWidths: ['1fr', '2fr'],
          });
        }
      }

      const photoImages = (currentReport.photos ?? [])
        .map(photo => ({
          title: photo.fileName,
          caption: formatDate(photo.createdAt),
          url: photo.downloadUrl || photo.previewUrl || photo.thumbnailUrl || '',
          fileName: photo.fileName,
          mimeType: photo.mimeType,
        }))
        .filter(image => !!image.url);
      const imageSections: PdfImageSection[] = photoImages.length
        ? [{
          title: 'Fotos',
          subtitle: `${photoImages.length} ${photoImages.length === 1 ? 'Foto' : 'Fotos'} zum Bautagesbericht`,
          images: photoImages,
        }]
        : [];

      const pdfData = await renderStructuredPdf({
        title: `Bautagesbericht ${formatDate(currentReport.day, 'long')}`,
        reportLabel: 'Bautagesbericht',
        showReportLabel: false,
        sections,
        imageSections,
        emptyMessage: 'Keine Daten zum Bautagesbericht verfügbar.',
      });

      const safeSuffix = currentReport.day.toISOString().slice(0, 10).replace(/[^\w\-]+/g, '-');
      const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
      deliverBlob(blob, `Bautagesbericht-${safeSuffix}.pdf`, target, pdfWindow);
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      setPdfExportErr((err as Error)?.message || 'Unbekannter Fehler beim PDF-Export.');
    } finally {
      setIsPdfExporting(false);
    }
  }

  useShortcut('Control+e', e => {
    if (!report || !sessionInfo.canDo('manage:dailyProjectReports')) return;
    e.preventDefault();
    showModifyDailyProjectReportModal(modals, report);
  });

  useShortcut('Control+p', e => {
    if (!report || !sessionInfo.canDo('view:dailyProjectReports')) return;
    e.preventDefault();
    if (isPdfExporting) return;
    void exportDailyReportToPdf('open');
  });

  async function uploadDailyReportPhotos(fileList: FileList | null) {
    if (!fileList?.length || !report || !dayKey) return;
    if (isPhotoUploading) return;

    setPhotoErr(null);
    setIsPhotoUploading(true);

    try {
      const files = Array.from(fileList);
      for (const file of files) {
        if (!file.type.toLowerCase().startsWith('image/')) {
          throw new Error(`${file.name} ist kein Bild.`);
        }

        const [uploadData, createErr] = await client.mutate('projects.files.createUpload', {
          projectId: report.projectId,
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
          throw new Error(`Foto-Upload fehlgeschlagen (${uploadRes.status})`);
        }

        const etag = uploadRes.headers.get('etag');
        const [, completeErr] = await client.mutate('projects.files.completeUpload', {
          projectId: report.projectId,
          fileId: uploadData.fileId,
          etag,
        });
        if (completeErr) throw completeErr;

        const [, attachErr] = await client.mutate('projects.dailyReports.photos.add', {
          projectId: report.projectId,
          day: dayKey,
          fileId: uploadData.fileId,
        });
        if (attachErr) throw attachErr;
      }

      await Promise.all([
        client.invalidate('projects.dailyReports.get'),
        client.invalidate('projects.dailyReports.list'),
        client.invalidate('projects.files.list'),
      ]);
    } catch (err) {
      setPhotoErr((err as Error)?.message || 'Fotos konnten nicht hochgeladen werden.');
    } finally {
      setIsPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  }

  async function removeDailyReportPhoto(fileId: string) {
    if (!report || !dayKey) return;
    if (removingPhotoId) return;

    setPhotoErr(null);
    setRemovingPhotoId(fileId);

    try {
      const [, err] = await client.mutate('projects.dailyReports.photos.remove', {
        projectId: report.projectId,
        day: dayKey,
        fileId,
      });
      if (err) throw err;

      await Promise.all([
        client.invalidate('projects.dailyReports.get'),
        client.invalidate('projects.dailyReports.list'),
      ]);
    } catch (err) {
      setPhotoErr((err as Error)?.message || 'Foto konnte nicht entfernt werden.');
    } finally {
      setRemovingPhotoId(null);
    }
  }

  if (err) return <NotFound reason="resourceNotFound" />
  if (!report) return;

  const hasWeather = !!report.weather && !!Object.values(report.weather).find(v => !!v);
  const photos = report.photos ?? [];
  const canManagePhotos = sessionInfo.supportsProjectFiles() && sessionInfo.canDo('manage:dailyProjectReports');

  return <>
    <input
      ref={photoInputRef}
      type="file"
      accept="image/*"
      multiple
      style={{ display: 'none' }}
      onChange={event => uploadDailyReportPhotos(event.target.files)}
    />

    <MyHeader
      title={`Bautagesbericht`}
      actions={<MyDropdown items={[
        {
          label: isPdfExporting ? 'PDF wird erstellt...' : 'PDF',
          renderIcon: Icons.Download,
          hideIf: !sessionInfo.canDo('view:dailyProjectReports'),
          disabled: isPdfExporting,
          onClick: () => exportDailyReportToPdf(),
        },
        {
          label: isPhotoUploading ? 'Fotos werden hochgeladen...' : 'Fotos hinzufügen',
          renderIcon: Icons.Create,
          hideIf: !canManagePhotos,
          disabled: isPhotoUploading,
          onClick: () => photoInputRef.current?.click(),
        },
        {
          label: 'Bearbeiten',
          renderIcon: Icons.Edit,
          hideIf: !sessionInfo.canDo('manage:dailyProjectReports'),
          onClick: () => showModifyDailyProjectReportModal(modals, report),
        },
        {
          label: 'Löschen',
          renderIcon: Icons.Delete,
          hideIf: !sessionInfo.canDo('delete:dailyProjectReports'),
          onClick: () => showDeleteDailyProjectReportModal(modals, report),
        },
      ]} />}
    />

    {!!pdfExportErr && <MyCallout icon={Icons.Deny} color="red">
      PDF-Export fehlgeschlagen: {pdfExportErr}
    </MyCallout>}

    {!!photoErr && <MyCallout icon={Icons.Deny} color="red">
      Foto-Aktion fehlgeschlagen: {photoErr}
    </MyCallout>}

    <AttrList>
      <AttrList.Attr name="Projekt" value={<Awaited promise={async () => {
        const [project] = await client.query('projects.get', { id: report.projectId }, { strategy: 'cache-first' });
        if (!project) return 'Unbekannt';
        return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
      }} />} />

      <AttrList.Attr name="Tag" value={formatDate(report.day)} />
      {!!report.summary && <AttrList.Attr name="Beschreibung der Arbeiten" value={report.summary} />}
      <AttrList.Attr name="Erstellt am" value={formatDate(report.createdAt)} />
      {!!report.createdByUserId && <AttrList.Attr name="Erstellt von" value={<Awaited promise={async () => {
        const [user] = await client.query('users.get', { id: report.createdByUserId! }, { strategy: 'cache-first' });
        if (!user) return 'Unbekannt';
        return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>
      }} />} />}
    </AttrList>

    <MyDivider />

    {!!report.workHours.length && <MyExpandable title="Arbeitszeit">
      <MyTable
        className="th-25rem"
        rows={report.workHours}
        columns={[
          {
            label: 'Mitarbeiter',
            render: async row => {
              if (!row.userId) return 'Unbekannt';
              const [user] = await client.query('users.get', { id: row.userId }, { strategy: 'cache-first' });
              if (!user) return 'Unbekannt';
              return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
            },
          },
          {
            label: 'Stunden',
            render: row => formatNumber(row.hours),
            sortKey: row => row.hours,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!report.weather && hasWeather && <MyExpandable title="Wetter" initiallyExpanded>
      <AttrList>
        {!!report.weather.summary && <AttrList.Attr name="Beschreibung" value={report.weather.summary} />}
        {typeof report.weather.temperatureC === 'number' && <AttrList.Attr name="Temperatur" value={`${formatNumber(report.weather.temperatureC)} °C`} />}
        {typeof report.weather.precipitationMm === 'number' && <AttrList.Attr name="Niederschlag" value={`${formatNumber(report.weather.precipitationMm)} mm`} />}
        {typeof report.weather.windKph === 'number' && <AttrList.Attr name="Wind" value={`${formatNumber(report.weather.windKph)} km/h`} />}
      </AttrList>
    </MyExpandable>}

    {!!photos.length && <MyExpandable title={`Fotos (${photos.length})`} initiallyExpanded>
      <div className="daily-report-photo-grid">
        {photos.map(photo => {
          const imageUrl = photo.previewUrl || photo.thumbnailUrl || photo.downloadUrl || null;
          return <div key={photo.id} className="daily-report-photo-card">
            {imageUrl
              ? <a href={photo.downloadUrl || imageUrl} target="_blank" rel="noreferrer">
                <img src={imageUrl} alt={photo.fileName} />
              </a>
              : <div className="daily-report-photo-placeholder">Keine Vorschau</div>}
            <div className="daily-report-photo-meta">
              <div className="daily-report-photo-title">{photo.fileName}</div>
              <div className="light">{formatDate(photo.createdAt)}</div>
              {canManagePhotos && <MyDropdown items={[{
                label: removingPhotoId === photo.id ? 'Wird entfernt...' : 'Aus Bericht entfernen',
                renderIcon: Icons.Delete,
                disabled: !!removingPhotoId,
                onClick: () => removeDailyReportPhoto(photo.id),
              }]} />}
            </div>
          </div>;
        })}
      </div>
    </MyExpandable>}
  </>;
}
