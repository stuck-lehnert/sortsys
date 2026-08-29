import { currentLocaleTag, uiText } from "~/lib/i18n";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { formatDate, formatNumber, productTitle, userFullName } from "~/lib/format";
import { renderStructuredPdfBatch } from "~/lib/pdf";
import { buildRegieReportPdfDocument } from "~/lib/regieReportPdf";
import { deliverBlob, upmatchUnit } from "~/lib/utils";
import { openExcelExport } from "~/lib/officeExports";
import { dayInIsoWeek, isoWeekLabel, startOfIsoWeek, WEEKDAY_NAMES, WEEKDAY_SHORT_NAMES, weekdayIndexInIsoWeek } from "~/lib/week";
import type { Project } from "~/type-helpers";

function pad2(value: number) {
  return `${value}`.padStart(2, "0");
}

function toDateInputValue(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateInput(value: unknown, fieldLabel: string) {
  const text = `${value ?? ""}`.trim();
  if (!text) throw new Error(`${fieldLabel} fehlt`);

  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(uiText(`${fieldLabel} ist ungültig`, `${fieldLabel} is invalid`));

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  if (
    isNaN(parsed.getTime())
    || parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    throw new Error(uiText(`${fieldLabel} ist ungültig`, `${fieldLabel} is invalid`));
  }

  parsed.setHours(0, 0, 0, 0);
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

function sanitizeWorksheetName(value: string) {
  const cleaned = value.replace(/[:\\/?*\[\]]/g, " ").trim();
  return (cleaned || "Sheet").slice(0, 31);
}

function formatBaseQuantity(baseQuantity: number, baseUnit: string, displayUnit: string) {
  const normalizedBaseUnit = `${baseUnit ?? ""}`.trim();
  const normalizedDisplayUnit = `${displayUnit ?? ""}`.trim();
  if (normalizedDisplayUnit === normalizedBaseUnit) return "-";
  return `${formatNumber(baseQuantity)}${normalizedBaseUnit ? ` ${normalizedBaseUnit}` : ""}`;
}

function addUniqueWorksheet(workbook: any, baseName: string, usedNames: Set<string>) {
  let candidate = sanitizeWorksheetName(baseName);
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return workbook.addWorksheet(candidate);
  }

  let index = 2;
  while (true) {
    const suffix = ` (${index})`;
    const truncated = sanitizeWorksheetName(candidate.slice(0, Math.max(1, 31 - suffix.length)) + suffix);
    if (!usedNames.has(truncated)) {
      usedNames.add(truncated);
      return workbook.addWorksheet(truncated);
    }

    index += 1;
  }
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
        throw new Error(uiText("Im ausgewahlten Zeitraum sind keine Lieferscheine vorhanden"));
      }

      const noteDetails = await Promise.all(filteredNotes.map(async (note) => {
        const [costs, costsErr] = await client.query("deliveryNotes.costs.get", {
          id: note.id,
        }, { strategy: "cache-first" });

        if (costsErr) throw costsErr;
        if (!costs) throw new Error(uiText(`Kosten für Lieferschein #${note.autoId} konnten nicht geladen werden`, `Costs for delivery note #${note.autoId} could not be loaded`));

        return { note, costs };
      }));

      const productIds = [...new Set(noteDetails
        .flatMap(entry => entry.costs.records)
        .map(record => record.productId))];
      const productEntries = await Promise.all(productIds.map(async (productId) => {
        const [product] = await client.query("products.get", { id: productId }, { strategy: "cache-first" });
        return [productId, product ?? null] as const;
      }));
      const productsById = new Map(productEntries);

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

      const bytes = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
      const blob = new Blob([bytes] as any, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const safeTitle = sanitizeFilePart(project.title);
      const fromPart = toDateInputValue(fromDate).replace(/[^0-9]/g, "");
      const toPart = toDateInputValue(toDateInclusive).replace(/[^0-9]/g, "");
      await openExcelExport(modals, blob, uiText(`Lieferscheine-Zeitraum-${safeTitle}-${fromPart}-${toPart}.xlsx`, `Delivery-notes-period-${safeTitle}-${fromPart}-${toPart}.xlsx`));

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

      const productIds = [...new Set(
        reportList
          .flatMap(report => report.products)
          .map(entry => entry.productId),
      )];
      const userIds = [...new Set(
        reportList
          .flatMap(report => report.workHours)
          .map(entry => entry.userId)
          .filter(Boolean),
      )] as string[];

      const [productEntries, userEntries] = await Promise.all([
        Promise.all(productIds.map(async (productId) => {
          const [product] = await client.query("products.get", { id: productId }, { strategy: "cache-first" });
          return [productId, product ?? null] as const;
        })),
        Promise.all(userIds.map(async (userId) => {
          const [user] = await client.query("users.get", { id: userId }, { strategy: "cache-first" });
          return [userId, user ?? null] as const;
        })),
      ]);

      const productsById = new Map(productEntries);
      const usersById = new Map(userEntries);

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

      const DECIMAL_NUM_FMT = "#,##0.00";
      const DECIMAL_ZERO_DASH_NUM_FMT = "#,##0.00;-#,##0.00;-";
      const usedWorksheetNames = new Set<string>();

      reportList.forEach((report, index) => {
        const weekStart = startOfIsoWeek(new Date(report.day));
        const weekEnd = dayInIsoWeek(weekStart, WEEKDAY_NAMES.length - 1);
        const weekLabel = isoWeekLabel(weekStart);

        const ws = addUniqueWorksheet(
          wb,
          `Regie #${report.autoId} ${weekLabel}`,
          usedWorksheetNames,
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

        const addSectionTitle = (title: string) => {
          ws.getCell(cursor, 1).value = title;
          ws.getCell(cursor, 1).font = { bold: true, size: 12 };
          cursor += 2;
        };

        const addTable = (name: string, columns: string[], rows: Array<Array<string | number | Date | null>>) => {
          if (!rows.length) return null;

          ws.addTable({
            name,
            ref: ws.getCell(cursor, 1).address,
            headerRow: true,
            totalsRow: false,
            style: { theme: "TableStyleLight1", showRowStripes: true },
            columns: columns.map(column => ({ name: column })),
            rows,
          });

          const firstDataRow = cursor + 1;
          const rowCount = rows.length;
          cursor += rowCount + 2;

          return { firstDataRow, rowCount };
        };

        const hoursByUser = new Map<string, { name: string; values: number[] }>();
        report.workHours.forEach(entry => {
          const dayIndex = weekdayIndexInIsoWeek(new Date(entry.day), weekStart);
          if (dayIndex < 0 || dayIndex >= WEEKDAY_NAMES.length) return;

          const key = entry.userId ?? '__unknown__';
          const user = entry.userId ? usersById.get(entry.userId) : null;
          const name = user ? userFullName(user) : 'Unbekannt';
          const current = hoursByUser.get(key) ?? {
            name,
            values: Array.from({ length: WEEKDAY_NAMES.length }, () => 0),
          };

          current.values[dayIndex] += Number(entry.hours ?? 0);
          hoursByUser.set(key, current);
        });

        const workHoursRows = Array.from(hoursByUser.values())
          .sort((left, right) => left.name.localeCompare(right.name, 'de', { sensitivity: 'base' }))
          .map(row => {
            const total = row.values.reduce((sum, value) => sum + Number(value ?? 0), 0);
            return [row.name, ...row.values, total] as Array<string | number | Date | null>;
          });
        let workHoursTable: { firstDataRow: number; rowCount: number; } | null = null;
        if (workHoursRows.length) {
          addSectionTitle(uiText("Arbeitszeit je Mitarbeiter und Tag"));
          workHoursTable = addTable(
            `RegieWorkHours_${index + 1}`,
            ["Mitarbeiter", ...WEEKDAY_SHORT_NAMES, "Gesamt"],
            workHoursRows,
          );
        }
        if (workHoursTable) {
          for (let i = 0; i < workHoursTable.rowCount; i++) {
            const row = workHoursTable.firstDataRow + i;
            for (let col = 2; col <= 2 + WEEKDAY_SHORT_NAMES.length; col++) {
              ws.getCell(row, col).numFmt = DECIMAL_ZERO_DASH_NUM_FMT;
            }
          }
        }

        const productsRows = report.products.map(entry => {
          const product = productsById.get(entry.productId);
          const baseQuantity = Number(entry.quantity ?? 0);
          const [amount, unit] = product ? upmatchUnit(product, baseQuantity) : [baseQuantity, ""];
          const baseUnit = product?.baseUnit ?? "";
          return [
            product ? `${product.customId} ${productTitle(product)}` : "Unbekannt",
            `${formatNumber(amount)}${unit ? ` ${unit}` : ""}`,
            formatBaseQuantity(baseQuantity, baseUnit, unit),
          ] as Array<string | number | Date | null>;
        });
        if (productsRows.length) {
          addSectionTitle("Produkte");
          addTable(
            `RegieProducts_${index + 1}`,
            ["Bezeichnung", "Menge", "Basismenge"],
            productsRows,
          );
        }

        const specialRows = report.specialRecords.map(entry => {
          return [
            entry.name,
            Number(entry.amount ?? 0),
            entry.unit,
            entry.comment ?? "",
          ] as Array<string | number | Date | null>;
        });
        let specialTable: { firstDataRow: number; rowCount: number; } | null = null;
        if (specialRows.length) {
          addSectionTitle("Sonderposten");
          specialTable = addTable(
            `RegieSpecial_${index + 1}`,
            ["Bezeichnung", "Menge", "Einheit", uiText("Kommentar")],
            specialRows,
          );
        }
        if (specialTable) {
          for (let i = 0; i < specialTable.rowCount; i++) {
            const row = specialTable.firstDataRow + i;
            ws.getCell(row, 2).numFmt = DECIMAL_NUM_FMT;
          }
        }

        ws.columns = [
          { width: 30 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 14 },
        ];
      });

      const bytes = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
      const blob = new Blob([bytes] as any, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const safeTitle = sanitizeFilePart(project.title);
      await openExcelExport(modals, blob, uiText(`Regieberichte-${safeTitle}.xlsx`, `Time-and-material-reports-${safeTitle}.xlsx`));

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
