import { currentLocaleTag, uiText } from "~/lib/i18n";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { parseDateInputValue, toDateInputValue } from "~/lib/calendarDate";
import { formatDate, productTitle } from "~/lib/format";
import { renderStructuredPdfBatch } from "~/lib/pdf";
import { buildRegieReportPdfDocument } from "~/lib/regieReportPdf";
import { appendRegieMaterials, appendRegieWorkHours } from "~/lib/regieWorkbook";
import { deliverBlob } from "~/lib/utils";
import { prepareExcelExport } from "~/lib/officeExports";
import { addUniqueWorksheet, workbookSections } from "~/lib/workbookSections";
import {
  readDeliveryExportCosts,
  readExportReferences,
} from "~/lib/exportReferences";
import { dayInIsoWeek, isoWeekLabel, startOfIsoWeek, WEEKDAY_NAMES } from "~/lib/week";
import type { Project } from "~/type-helpers";

function parseDateInput(value: unknown, fieldLabel: string) {
  const text = `${value ?? ""}`.trim();
  if (!text) throw new Error(`${fieldLabel} fehlt`);

  const parsed = parseDateInputValue(text);
  if (!parsed) {
    throw new Error(uiText(`${fieldLabel} ist ungültig`, `${fieldLabel} is invalid`));
  }

  return parsed;
}

function formatDateTime(value: Date) {
  return value.toLocaleString(currentLocaleTag(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sanitizeFilePart(value: string) {
  const fallback = value.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
  return fallback || "export";
}

export function showExportProjectDeliveryNotesTimespanModal(modals: MyModalsInterface, project: Project) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.Input
        required
        name="fromDate"
        labelText={uiText("Von")}
        type="date"
      />

      <MyForm.Input
        required
        name="toDate"
        labelText={uiText("Bis")}
        type="date"
      />

      <p className="light">{uiText("Es werden alle Lieferscheine des Projekts im ausgewählten Zeitraum konsolidiert.")}</p>

      <NotifyLoaded onLoad={() => {
        const now = new Date();
        const start = new Date(now);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);

        context.setValues({
          fromDate: toDateInputValue(start),
          toDate: toDateInputValue(now),
        });
      }} />
    </>,
    onSubmit: async ({ context, hide }) => {
      const openExcel = prepareExcelExport(modals);
      const values = context.getValues();

      const fromDate = parseDateInput(values.fromDate, uiText("Von"));
      const toDateInclusive = parseDateInput(values.toDate, uiText("Bis"));
      if (fromDate.getTime() > toDateInclusive.getTime()) {
        throw new Error(uiText("Von darf nicht nach Bis liegen"));
      }

      const from = new Date(fromDate);
      from.setHours(0, 0, 0, 0);

      const toExclusive = new Date(toDateInclusive);
      toExclusive.setHours(0, 0, 0, 0);
      toExclusive.setDate(toExclusive.getDate() + 1);

      const [notes, notesErr] = await client.query("deliveryNotes.list", {
        projectId: project.id,
      });
      if (notesErr) throw notesErr;

      const filteredNotes = (notes ?? [])
        .filter(note => {
          const effective = new Date(note.effectiveTimestamp);
          return effective.getTime() >= from.getTime() && effective.getTime() < toExclusive.getTime();
        })
        .sort((left, right) => {
          const diff = new Date(left.effectiveTimestamp).getTime() - new Date(right.effectiveTimestamp).getTime();
          if (diff !== 0) return diff;
          return Number(left.autoId) - Number(right.autoId);
        });

      if (!filteredNotes.length) {
        throw new Error(
          uiText(
            "Im ausgewählten Zeitraum sind keine Lieferscheine vorhanden",
            "There are no delivery notes in the selected period",
          ),
        );
      }

      const costsByNote = await readDeliveryExportCosts(
        client,
        filteredNotes.map(({ id }) => id),
      );
      const noteDetails = filteredNotes.map((note) => {
        const costs = costsByNote.get(note.id);
        if (!costs) {
          throw new Error(
            uiText(
              `Kosten für Lieferschein #${note.autoId} konnten nicht geladen werden`,
              `Costs for delivery note #${note.autoId} could not be loaded`,
            ),
          );
        }

        return { note, costs };
      });

      const productsById = await readExportReferences(
        client,
        "products.get",
        noteDetails.flatMap(({ costs }) =>
          costs.records.map((record) => record.productId),
        ),
      );

      const ExcelJS = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      wb.creator = "exceljs";
      wb.created = new Date();

      const CURRENCY_NUM_FMT = "#,##0.00 [$€-407]";
      const DECIMAL_NUM_FMT = "#,##0.00";

      const summarySheet = wb.addWorksheet("Lieferscheine");
      summarySheet.getCell(1, 1).value = uiText("Lieferschein Export (Zeitraum)");
      summarySheet.getCell(1, 1).font = { bold: true, size: 16 };
      summarySheet.mergeCells(1, 1, 1, 6);

      summarySheet.getCell(2, 1).value = uiText(`Projekt: ${project.title}`, `Project: ${project.title}`);
      summarySheet.mergeCells(2, 1, 2, 6);
      summarySheet.getCell(3, 1).value = uiText(`Von: ${formatDate(fromDate, 'long')}`, `From: ${formatDate(fromDate, 'long')}`);
      summarySheet.mergeCells(3, 1, 3, 6);
      summarySheet.getCell(4, 1).value = uiText(`Bis: ${formatDate(toDateInclusive, 'long')}`, `To: ${formatDate(toDateInclusive, 'long')}`);
      summarySheet.mergeCells(4, 1, 4, 6);

      summarySheet.addTable({
        name: "DeliveryNotesSummary",
        ref: "A6",
        headerRow: true,
        totalsRow: false,
        style: { theme: "TableStyleLight1", showRowStripes: true },
        columns: [
          { name: uiText("Lieferschein") },
          { name: "Zeitstempel" },
          { name: "Produkte" },
          { name: "Sonderposten" },
          { name: "Gesamtkosten" },
          { name: uiText("Kommentar") },
        ],
        rows: noteDetails.map(({ note, costs }) => [
          `#${note.autoId}`,
          formatDateTime(new Date(note.effectiveTimestamp)),
          Number(costs.records.length),
          Number(costs.specialRecords.length),
          Number(costs.totalCost ?? 0),
          note.comment ?? "",
        ]),
      });

      for (let i = 0; i < noteDetails.length; i++) {
        const row = 7 + i;
        summarySheet.getCell(row, 5).numFmt = CURRENCY_NUM_FMT;
      }

      summarySheet.columns = [
        { width: 16 },
        { width: 22 },
        { width: 12 },
        { width: 14 },
        { width: 16 },
        { width: 44 },
      ];

      const itemRows: Array<Array<string | number | null>> = [];
      noteDetails.forEach(({ note, costs }) => {
        const noteLabel = `#${note.autoId}`;
        const effectiveLabel = formatDateTime(new Date(note.effectiveTimestamp));

        costs.records.forEach(record => {
          const product = productsById.get(record.productId);
          const productName = product
            ? `${product.customId} ${productTitle(product)}`
            : "Unbekannt";
          const quantity = Number(record.quantity ?? 0);
          const pricePerUnit = record.priceRecord?.price != null ? Number(record.priceRecord.price) : null;

          itemRows.push([
            noteLabel,
            effectiveLabel,
            "Produkt",
            productName,
            quantity,
            product?.baseUnit ?? "",
            pricePerUnit,
            pricePerUnit != null ? quantity * pricePerUnit : null,
            "",
          ]);
        });

        costs.specialRecords.forEach(record => {
          itemRows.push([
            noteLabel,
            effectiveLabel,
            "Sonderposten",
            record.name,
            Number(record.amount ?? 0),
            record.unit,
            record.pricePerUnit != null ? Number(record.pricePerUnit) : null,
            Number(record.totalCost ?? 0),
            record.comment ?? "",
          ]);
        });
      });

      if (itemRows.length) {
        const summaryTableLastRow = 6 + noteDetails.length;
        const itemSectionTitleRow = summaryTableLastRow + 2;
        const itemTableStartRow = itemSectionTitleRow + 1;

        summarySheet.getCell(itemSectionTitleRow, 1).value = "Positionen";
        summarySheet.getCell(itemSectionTitleRow, 1).font = { bold: true, size: 12 };
        summarySheet.mergeCells(itemSectionTitleRow, 1, itemSectionTitleRow, 9);

        summarySheet.addTable({
          name: "DeliveryNotesItems",
          ref: summarySheet.getCell(itemTableStartRow, 1).address,
          headerRow: true,
          totalsRow: false,
          style: { theme: "TableStyleLight1", showRowStripes: true },
          columns: [
            { name: uiText("Lieferschein") },
            { name: "Zeitstempel" },
            { name: "Typ" },
            { name: "Artikel" },
            { name: "Menge" },
            { name: "Einheit" },
            { name: "Preis" },
            { name: uiText("Kosten") },
            { name: uiText("Kommentar") },
          ],
          rows: itemRows,
        });

        for (let i = 0; i < itemRows.length; i++) {
          const row = itemTableStartRow + 1 + i;
          summarySheet.getCell(row, 5).numFmt = DECIMAL_NUM_FMT;
          summarySheet.getCell(row, 7).numFmt = CURRENCY_NUM_FMT;
          summarySheet.getCell(row, 8).numFmt = CURRENCY_NUM_FMT;
        }
      }

      summarySheet.columns = [
        { width: 16 },
        { width: 22 },
        { width: 14 },
        { width: 38 },
        { width: 12 },
        { width: 10 },
        { width: 14 },
        { width: 14 },
        { width: 30 },
      ];

      const safeTitle = sanitizeFilePart(project.title);
      const fromPart = toDateInputValue(fromDate).replace(/[^0-9]/g, "");
      const toPart = toDateInputValue(toDateInclusive).replace(/[^0-9]/g, "");
      await openExcel(wb, uiText(
        `Lieferscheine-Zeitraum-${safeTitle}-${fromPart}-${toPart}.xlsx`,
        `Delivery-notes-period-${safeTitle}-${fromPart}-${toPart}.xlsx`,
      ));

      hide();
    },
    modalProps: () => ({
      noFullscreen: true,
      modalHeading: uiText("Lieferscheine als Excel exportieren"),
      modalLabel: project.title,
      primaryButtonText: uiText("Exportieren"),
    }),
  });
}

export function showExportProjectRegieReportsModal(
  modals: MyModalsInterface,
  project: Project,
  format: 'excel' | 'pdf' = 'excel',
) {
  modals.showForm({
    content: () => <>
      {format === 'pdf'
        ? <p className="light">{uiText("Es werden alle Regieberichte des Projekts in einer PDF-Datei exportiert. Jeder Bericht umfasst eine Kalenderwoche, startet auf einer neuen Seite und endet mit Signaturfeldern fur Bauleiter und Bauherr.")}</p>
        : <p className="light">{uiText("Es werden alle Regieberichte des Projekts exportiert. Jeder Bericht wird in einem eigenen Tabellenblatt mit Stundenmatrix je Mitarbeiter und Wochentag abgelegt.")}</p>}
    </>,
    onSubmit: async ({ hide }) => {
      const openExcel = prepareExcelExport(modals);
      const [reports, reportsErr] = await client.query("regieReports.list", {
        projectId: project.id,
        limit: 10000,
        offset: 0,
      });
      if (reportsErr) throw reportsErr;

      const reportList = (reports ?? [])
        .slice()
        .sort((left, right) => {
          const dayDiff = new Date(left.day).getTime() - new Date(right.day).getTime();
          if (dayDiff !== 0) return dayDiff;
          return Number(left.autoId) - Number(right.autoId);
        });

      if (!reportList.length) {
        throw new Error(uiText("Fur dieses Projekt sind keine Regieberichte vorhanden"));
      }

      const [productsById, usersById] = await Promise.all([
        readExportReferences(
          client,
          "products.get",
          reportList.flatMap((report) =>
            report.products.map((entry) => entry.productId),
          ),
        ),
        readExportReferences(
          client,
          "users.get",
          reportList.flatMap((report) =>
            report.workHours.map((entry) => entry.userId),
          ),
        ),
      ]);

      if (format === 'pdf') {
        const documents = reportList.map((report) => {
          return buildRegieReportPdfDocument({
            report,
            projectTitle: project.title,
            productsById,
            usersById,
          });
        });

        const pdfData = await renderStructuredPdfBatch({ documents });
        const blob = new Blob([pdfData] as any, { type: "application/pdf" });

        const safeTitle = sanitizeFilePart(project.title);
        deliverBlob(blob, uiText(`Regieberichte-${safeTitle}.pdf`, `Time-and-material reporte-${safeTitle}.pdf`));
        hide();
        return;
      }

      const ExcelJS = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      wb.creator = "exceljs";
      wb.created = new Date();


      reportList.forEach((report, index) => {
        const weekStart = startOfIsoWeek(new Date(report.day));
        const weekEnd = dayInIsoWeek(weekStart, WEEKDAY_NAMES.length - 1);
        const weekLabel = isoWeekLabel(weekStart);

        const ws = addUniqueWorksheet(
          wb,
          `Regie #${report.autoId} ${weekLabel}`,
        );

        ws.getCell(1, 1).value = uiText(`Regiebericht #${report.autoId}`, `Time-and-material report #${report.autoId}`);
        ws.getCell(1, 1).font = { size: 16, bold: true };
        ws.mergeCells(1, 1, 1, 9);

        ws.getCell(2, 1).value = uiText(`Projekt: ${project.title}`, `Project: ${project.title}`);
        ws.mergeCells(2, 1, 2, 9);

        ws.getCell(3, 1).value = `Kalenderwoche: ${weekLabel}`;
        ws.mergeCells(3, 1, 3, 9);

        ws.getCell(4, 1).value = uiText(`Zeitraum: ${formatDate(weekStart)} bis ${formatDate(weekEnd)}`, `Period: ${formatDate(weekStart)} to ${formatDate(weekEnd)}`);
        ws.mergeCells(4, 1, 4, 9);

        let cursor = 6;
        if (`${report.summary ?? ""}`.trim()) {
          ws.getCell(cursor, 1).value = uiText("Beschreibung der Arbeiten");
          ws.getCell(cursor, 1).font = { bold: true, size: 12 };
          cursor += 1;

          const summary = `${report.summary ?? ""}`.trim();
          const summaryRows = Math.max(2, Math.ceil(summary.length / 100));
          const summaryEnd = cursor + summaryRows - 1;
          ws.mergeCells(cursor, 1, summaryEnd, 9);
          ws.getCell(cursor, 1).value = summary;
          ws.getCell(cursor, 1).alignment = { wrapText: true, vertical: "top" };
          cursor = summaryEnd + 2;
        }

        const sections = workbookSections(ws, cursor, {
          heading: { size: 12 },
        });
        appendRegieWorkHours(
          ws,
          sections,
          report,
          weekStart,
          usersById,
          `RegieWorkHours_${index + 1}`,
        );
        appendRegieMaterials(ws, sections, report, productsById, {
          includeComment: true,
          productTableName: `RegieProducts_${index + 1}`,
          specialTableName: `RegieSpecial_${index + 1}`,
        });
      });

      const safeTitle = sanitizeFilePart(project.title);
      await openExcel(wb, uiText(
        `Regieberichte-${safeTitle}.xlsx`,
        `Time-and-material-reports-${safeTitle}.xlsx`,
      ));

      hide();
    },
    modalProps: () => ({
      noFullscreen: true,
      modalHeading: format === 'pdf'
        ? uiText("Regieberichte als PDF exportieren")
        : uiText("Regieberichte als Excel exportieren"),
      modalLabel: project.title,
      primaryButtonText: uiText("Exportieren"),
    }),
  });
}
