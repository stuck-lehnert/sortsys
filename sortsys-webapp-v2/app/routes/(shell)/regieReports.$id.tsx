import { uiText } from "~/lib/i18n";
import { useState } from "react";
import { useParams } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { AttrList } from "~/components/AttrList";
import { Awaited } from "~/components/Awaited";
import { MyCallout } from "~/components/MyCallout";
import { memberLink, productLink, projectLink } from "~/lib/recordLinks";
import {
  formatDate,
  formatNumber,
  regieProductTitle,
} from "~/lib/format";
import { MyDivider } from "~/components/MyDivider";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { MyTable } from "~/components/MyTable";
import { MyExpandable } from "~/components/MyExpandable";
import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf } from "~/lib/pdf";
import { buildRegieReportPdfDocument } from "~/lib/regieReportPdf";
import { appendRegieMaterials, appendRegieWorkHours } from "~/lib/regieWorkbook";
import { readRegieExportReferences } from "~/lib/exportReferences";
import type { RegieReport } from "~/type-helpers";
import {
  showDeleteRegieReportModal,
  showModifyRegieReportModal,
} from "~/modals/regieReports";
import { deliverBlob, type BlobTarget } from "~/lib/utils";
import { productQuantityColumns } from "~/lib/productQuantityColumns";
import { prepareExcelExport } from "~/lib/officeExports";
import { workbookSections } from "~/lib/workbookSections";
import {
  dayInIsoWeek,
  isoWeekLabel,
  startOfIsoWeek,
  WEEKDAY_NAMES,
} from "~/lib/week";

async function readReportExportData(report: RegieReport) {
  const [[project], references] = await Promise.all([
    client.query(
      "projects.get",
      { id: report.projectId },
      { strategy: "cache-first" },
    ),
    readRegieExportReferences(client, [report]),
  ]);

  return { projectTitle: project?.title ?? "Unbekannt", ...references };
}

export default function RegieReportDetailPage() {
  const { id } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);

  const [report, err] = useClientStream(
    () => client.streamQuery("regieReports.get", { id: id! }),
    [id],
  );

  useTitle(
    () =>
      report
        ? uiText(
            `Regiebericht ${isoWeekLabel(new Date(report.day))}`,
            `Time-and-material report ${isoWeekLabel(new Date(report.day))}`,
          )
        : null,
    [report?.day],
  );

  useShortcut("Control+e", (e) => {
    if (
      !report ||
      !(
        sessionInfo.canAccess(
          `project:${report.projectId}:regie-reports`,
          "master-data",
          "update",
        ) ||
        sessionInfo.canAccess(
          `project:${report.projectId}:regie-reports`,
          "personnel",
          "update",
        )
      )
    )
      return;
    e.preventDefault();
    showModifyRegieReportModal(modals, report);
  });

  useShortcut("Control+p", (e) => {
    if (!report || !sessionInfo.canDo("view:regieReports")) return;
    e.preventDefault();
    if (isPdfExporting) return;
    void exportRegieReportToPdf("open");
  });

  if (err) return <NotFound reason="resourceNotFound" />;
  if (!report) return;

  const weekStart = startOfIsoWeek(new Date(report.day));
  const weekEnd = dayInIsoWeek(weekStart, WEEKDAY_NAMES.length - 1);

  async function exportRegieReportToPdf(target: BlobTarget = "open") {
    const currentReport = report;
    if (!currentReport) return;
    const pdfWindow = target === "open" ? window.open("", "_blank") : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const exportData = await readReportExportData(currentReport);

      const pdfData = await renderStructuredPdf(
        buildRegieReportPdfDocument({
          report: currentReport,
          ...exportData,
        }),
      );

      const blob = new Blob([pdfData] as any, { type: "application/pdf" });
      const safeSuffix = `${currentReport.autoId}`.replace(/[^\w\-]+/g, "-");
      deliverBlob(
        blob,
        uiText(
          `Regiebericht-${safeSuffix}.pdf`,
          `Time-and-material report-${safeSuffix}.pdf`,
        ),
        target,
        pdfWindow,
      );
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      setPdfExportErr(
        (err as Error)?.message ||
          uiText("Unbekannter Fehler beim PDF-Export."),
      );
    } finally {
      setIsPdfExporting(false);
    }
  }

  return (
    <>
      <MyHeader
        title={uiText(
          `Regiebericht #${report.autoId}`,
          `Time-and-material report #${report.autoId}`,
        )}
        actions={
          <MyDropdown
            items={[
              {
                label: isPdfExporting
                  ? uiText("PDF wird erstellt...")
                  : uiText("PDF"),
                renderIcon: Icons.Download,
                hideIf: !sessionInfo.canDo("view:regieReports"),
                disabled: isPdfExporting,
                onClick: () => exportRegieReportToPdf(),
              },
              {
                label: uiText("Excel"),
                renderIcon: Icons.Excel,
                hideIf: !sessionInfo.canDo("view:regieReports"),
                onClick: async () => {
                  const openExcel = prepareExcelExport(modals);
                  const [ExcelJS, { projectTitle, productsById, usersById }] =
                    await Promise.all([
                      import("exceljs"),
                      readReportExportData(report),
                    ]);

                  const wb = new ExcelJS.Workbook();
                  wb.creator = "exceljs";
                  wb.created = new Date();

                  const ws = wb.addWorksheet(uiText("Regiebericht"));
                  const title = uiText(
                    `Regiebericht #${report.autoId}`,
                    `Time-and-material report #${report.autoId}`,
                  );
                  const weekStart = startOfIsoWeek(new Date(report.day));
                  const weekEnd = dayInIsoWeek(
                    weekStart,
                    WEEKDAY_NAMES.length - 1,
                  );
                  const subtitle = uiText(
                    `${isoWeekLabel(weekStart)} (${formatDate(weekStart)} bis ${formatDate(weekEnd)}) — ${projectTitle}`,
                    `${isoWeekLabel(weekStart)} (${formatDate(weekStart)} to ${formatDate(weekEnd)}) — ${projectTitle}`,
                  );

                  ws.getCell(1, 1).value = title;
                  ws.getCell(1, 1).font = { size: 18, bold: true };
                  ws.getCell(2, 1).value = subtitle;
                  ws.getCell(2, 1).font = { size: 12, italic: true };
                  ws.mergeCells(1, 1, 1, 9);
                  ws.mergeCells(2, 1, 2, 9);

                  let cursor = 4;
                  if (report.summary) {
                    const summaryTitleRow = 4;
                    ws.getCell(summaryTitleRow, 1).value = "Zusammenfassung";
                    ws.getCell(summaryTitleRow, 1).font = {
                      bold: true,
                      size: 14,
                    };

                    const height = (report.summary.length / 90) * 15;
                    const rowHeight = Math.ceil(height / 3);

                    const summaryRow = summaryTitleRow + 1;
                    ws.mergeCells(summaryRow, 1, summaryRow + 2, 9);
                    ws.getCell(summaryRow, 1).value = report.summary ?? "";
                    ws.getCell(summaryRow, 1).alignment = {
                      wrapText: true,
                      vertical: "top",
                    };
                    ws.getRow(summaryRow).height = rowHeight;
                    ws.getRow(summaryRow + 1).height = rowHeight;
                    ws.getRow(summaryRow + 2).height = rowHeight;

                    cursor = summaryRow + 4;
                  }

                  const sections = workbookSections(ws, cursor);
                  appendRegieWorkHours(ws, sections, report, weekStart, usersById);
                  appendRegieMaterials(ws, sections, report, productsById);

                  const safeSuffix = `${report.autoId}`.replace(
                    /[^\w\-]+/g,
                    "-",
                  );
                  await openExcel(
                    wb,
                    uiText(
                      `Regiebericht-${safeSuffix}.xlsx`,
                      `Time-and-material report-${safeSuffix}.xlsx`,
                    ),
                  );
                },
              },
              {
                label: uiText("Bearbeiten"),
                renderIcon: Icons.Edit,
                hideIf: !(
                  sessionInfo.canAccess(
                    `project:${report.projectId}:regie-reports`,
                    "master-data",
                    "update",
                  ) ||
                  sessionInfo.canAccess(
                    `project:${report.projectId}:regie-reports`,
                    "personnel",
                    "update",
                  )
                ),
                onClick: () => showModifyRegieReportModal(modals, report),
              },
              {
                label: uiText("Löschen"),
                renderIcon: Icons.Delete,
                hideIf: !sessionInfo.canAccess(
                  `project:${report.projectId}:regie-reports`,
                  "master-data",
                  "delete",
                ),
                onClick: () => showDeleteRegieReportModal(modals, report),
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

      <AttrList>
        <AttrList.Attr
          name={uiText("Projekt")}
          value={<Awaited promise={() => projectLink(report.projectId)} />}
        />

        {!!report.summary && (
          <AttrList.Attr name="Zusammenfassung" value={report.summary} />
        )}
        <AttrList.Attr name="Kalenderwoche" value={isoWeekLabel(weekStart)} />
        <AttrList.Attr
          name={uiText("Zeitraum")}
          value={uiText(
            `${formatDate(weekStart)} bis ${formatDate(weekEnd)}`,
            `${formatDate(weekStart)} to ${formatDate(weekEnd)}`,
          )}
        />
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

      {report.workHoursAvailable === false && (
        <p>
          {uiText(
            "Arbeitszeiten nicht freigegeben",
            "Work hours are not shared",
          )}
        </p>
      )}
      {!!report.workHours.length && (
        <MyExpandable title={uiText("Arbeitszeit")}>
          <MyTable
            className="th-25rem"
            rows={report.workHours}
            columns={[
              {
                label: uiText("Tag"),
                render: (row) => formatDate(row.day),
                sortKey: (row) => new Date(row.day).getTime(),
              },
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

      {!!report.products.length && (
        <MyExpandable title={uiText("Produkte")}>
          <MyTable
            className="th-25rem"
            persistentId="Products"
            rows={report.products}
            columns={[
              {
                label: uiText("Bezeichnung"),
                render: (row) => productLink(row.productId, regieProductTitle),
              },
              ...productQuantityColumns(client),
            ]}
            loadMore={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {!!report.specialRecords.length && (
        <MyExpandable title={uiText("Sonderposten")}>
          <MyTable
            className="th-25rem"
            rows={report.specialRecords}
            columns={[
              {
                label: uiText("Bezeichnung"),
                render: (row) => row.name,
                sortKey: (row) => row.name,
              },
              {
                label: uiText("Menge"),
                render: (row) => `${formatNumber(row.amount)} ${row.unit}`,
                sortKey: (row) => row.amount,
              },
            ]}
            loadMore={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}
    </>
  );
}
