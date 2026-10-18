import {
  buildProjectCostsPdfDocument,
  projectCostWeekRanges,
} from "@sortsys/business-logic/pdf";
import { currentLocaleTag } from "~/lib/i18n";
import { uiText } from "~/lib/i18n";
import { useOutletContext } from "react-router";
import { AttrList } from "~/components/AttrList";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyExpandable } from "~/components/MyExpandable";
import { MyLink } from "~/components/MyLink";
import { MyTable, type MyTableColumn } from "~/components/MyTable";
import { useState } from "react";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  gainOrLossColor,
  productTitle,
  toolTitle,
  userFullName,
} from "~/lib/format";
import { Icons } from "~/lib/icons";
import {
  renderStructuredPdf,
  buildPdfProductSection,
  formatPdfNumber,
  type PdfTableSection,
} from "~/lib/pdf";
import { buildWeeklyProjectCostsPdfDocument } from "~/lib/projectCostsPdf";
import {
  deliverBlob,
  endOfDay,
  startOfDay,
  type BlobTarget,
  upmatchUnit,
} from "~/lib/utils";
import { openExcelExport } from "~/lib/officeExports";
import { EXCEL_DATE_NUM_FMT } from "~/lib/xlsx";
import {
  showDeleteProjectFinancialEntryModal,
  showModifyProjectFinancialEntryModal,
  type ProjectFinancialEntry,
} from "~/modals/projects";
import type { Project } from "~/type-helpers";

function startOfIsoWeek(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const dayOfWeek = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - dayOfWeek);
  return result;
}

function getIsoWeekInfo(date: Date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);

  const day = (value.getDay() + 6) % 7;
  value.setDate(value.getDate() + 3 - day);

  const isoYear = value.getFullYear();

  const firstThursday = new Date(isoYear, 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() + 3 - firstDay);

  const weekNumber =
    1 +
    Math.round(
      (value.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );

  return {
    weekNumber,
    isoYear,
  };
}

function isoWeekLabel(date: Date) {
  const info = getIsoWeekInfo(date);
  return `KW ${info.weekNumber}/${info.isoYear}`;
}

const MISSING_INVOICE_NOTICE = uiText(
  "Gewinn/Verlust kann nicht berechnet werden, da Rechnungssummen fehlen.",
);

function hasNumberData(value: number | null | undefined) {
  return Math.abs(Number(value ?? 0)) > 0.000001;
}

function formatCurrencyOrDash(value: number | null | undefined) {
  return hasNumberData(value) ? formatCurrency(Number(value ?? 0)) : "-";
}

function formatGainOrLossPercentage(value: number, invoicesTotal: number) {
  if (!hasNumberData(invoicesTotal)) return null;
  return formatPercent((value / Math.abs(invoicesTotal)) * 100);
}

function formatGainOrLossText(value: number, invoicesTotal: number) {
  const percentage = formatGainOrLossPercentage(value, invoicesTotal);
  return `${percentage ? `(${percentage}) ` : ""}${formatCurrency(value)}`;
}

function GainOrLossText({
  value,
  invoicesTotal,
}: {
  value: number;
  invoicesTotal: number;
}) {
  return (
    <span style={{ color: gainOrLossColor(value), fontWeight: 700 }}>
      {formatGainOrLossText(value, invoicesTotal)}
    </span>
  );
}

function formatProductAmount(amount: number, unit: string) {
  const normalizedUnit = `${unit ?? ""}`.trim();
  return `${formatNumber(amount)}${normalizedUnit ? ` ${normalizedUnit}` : ""}`;
}

function formatBaseQuantity(
  baseQuantity: number,
  baseUnit: string,
  displayUnit: string,
) {
  const normalizedBaseUnit = `${baseUnit ?? ""}`.trim();
  const normalizedDisplayUnit = `${displayUnit ?? ""}`.trim();
  if (normalizedDisplayUnit === normalizedBaseUnit) return "-";
  return `${formatNumber(baseQuantity)}${normalizedBaseUnit ? ` ${normalizedBaseUnit}` : ""}`;
}

export default function ProjectDetailCosts() {
  const { project } = useOutletContext<{ project: Project }>();
  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const canManageProjectFinancialEntries = sessionInfo.canDo("manage:projects");

  const [costs] = useClientStream(
    () => client.streamQuery("projects.costs.get", { projectId: project.id }),
    [project.id],
  );
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);

  useShortcut("Control+p", (e) => {
    if (!costs) return;
    e.preventDefault();
    if (isPdfExporting) return;
    void exportCostsToPdf("overall", "open");
  });

  if (!costs) return;

  const offers: ProjectFinancialEntry[] = costs.offers ?? [];
  const invoices: ProjectFinancialEntry[] = costs.invoices ?? [];

  const offersTotal = Number(
    costs.totalCosts.offers ??
      offers.reduce((sum, entry) => sum + (entry.amount ?? 0), 0),
  );
  const invoicesTotal = Number(
    costs.totalCosts.invoices ??
      invoices.reduce((sum, entry) => sum + (entry.amount ?? 0), 0),
  );
  const hasFinancialEntries = offers.length > 0 || invoices.length > 0;
  const hasInvoices = invoices.length > 0;
  const gainOrLoss = invoicesTotal - Number(costs.totalCosts.overall ?? 0);

  const commonCosts = costs.commonCosts;
  const fallbackCommonCostsOverhead =
    Number(commonCosts.fgk.overheadCost ?? 0) +
    Number(commonCosts.mgk.overheadCost ?? 0) +
    Number(commonCosts.ngk.overheadCost ?? 0);
  const commonCostsOverhead = hasNumberData(commonCosts.overallOverhead)
    ? Number(commonCosts.overallOverhead ?? 0)
    : fallbackCommonCostsOverhead;
  const hasCommonCosts = hasNumberData(commonCostsOverhead);
  const subcontractorWorkHours = costs.subcontractorWorkHours ?? [];
  const regularWorkHours = costs.workHours ?? [];
  const workHoursTotal = Number(costs.totalCosts.workHours ?? 0);
  const subcontractorWorkHoursTotal = Number(
    costs.totalCosts.subcontractorWorkHours ??
      subcontractorWorkHours.reduce(
        (sum, entry) => sum + Number(entry.totalCost ?? 0),
        0,
      ),
  );

  async function exportCostsToPdf(
    mode: "overall" | "weekly" = "overall",
    target: BlobTarget = "open",
  ) {
    if (!costs) return;
    const pdfWindow = target === "open" ? window.open("", "_blank") : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const toolNameMap = new Map<string, string>();
      const userNameMap = new Map<string, string>();

      const productIds = [
        ...new Set((costs.products ?? []).map((entry) => entry.productId)),
      ];
      const toolIds = [
        ...new Set((costs.toolTrackings ?? []).map((entry) => entry.toolId)),
      ];
      const userIds = [
        ...new Set(
          [...regularWorkHours, ...subcontractorWorkHours]
            .map((entry) => entry.userId)
            .filter(Boolean),
        ),
      ] as string[];

      const [productEntries] = await Promise.all([
        Promise.all(
          productIds.map(async (id) => {
            const [product] = await client.query(
              "products.get",
              { id },
              { strategy: "cache-first" },
            );
            return [id, product ?? null] as const;
          }),
        ),
        Promise.all(
          toolIds.map(async (id) => {
            const [tool] = await client.query(
              "tools.get",
              { id },
              { strategy: "cache-first" },
            );
            toolNameMap.set(
              id,
              tool ? `${tool.customId} ${toolTitle(tool)}` : id,
            );
          }),
        ),
        Promise.all(
          userIds.map(async (id) => {
            const [user] = await client.query(
              "users.get",
              { id },
              { strategy: "cache-first" },
            );
            userNameMap.set(id, user ? userFullName(user) : id);
          }),
        ),
      ]);
      const productMap = new Map(productEntries);

      const noteCostsById = new Map<
        string,
        import("@sortsys/v2-client/contract").QueryOutputs["deliveryNotes.costs.get"]
      >();
      const weeklyCostsByStart = new Map<
        string,
        import("@sortsys/v2-client/contract").QueryOutputs["projects.costs.get"]
      >();
      if (mode === "weekly") {
        await Promise.all(
          costs.deliveryNotes.map(async (note) => {
            const [data, error] = await client.query(
              "deliveryNotes.costs.get",
              { id: note.noteId },
              { strategy: "network-first" },
            );
            if (error) throw error;
            if (!data) throw new Error("COST_DETAILS_REQUIRED");
            noteCostsById.set(note.noteId, data);
          }),
        );
        await Promise.all(
          projectCostWeekRanges(costs).map(async (range) => {
            const [data, error] = await client.query(
              "projects.costs.get",
              { projectId: project.id, ...range },
              { strategy: "network-first" },
            );
            if (error) throw error;
            if (!data) throw new Error("COST_DETAILS_REQUIRED");
            weeklyCostsByStart.set(range.from.toISOString(), data);
          }),
        );
      }
      const document = buildProjectCostsPdfDocument({
        costs,
        projectTitle: project.title,
        locale: currentLocaleTag(),
        mode,
        productsById: productMap,
        userNamesById: userNameMap,
        toolNamesById: toolNameMap,
        noteCostsById,
        weeklyCostsByStart,
      });
      const pdfData = await renderStructuredPdf(document);
      const safeTitle = project.title.replace(/[^\w\-]+/g, "-");
      const blob = new Blob([pdfData] as any, { type: "application/pdf" });
      deliverBlob(
        blob,
        `${mode === "weekly" ? "Projektkosten-wochenweise" : "Projektkosten"}-${safeTitle}.pdf`,
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

  const renderFinancialEntriesExpandable = (
    title: string,
    total: number,
    entries: Array<ProjectFinancialEntry>,
  ) => {
    const columns: MyTableColumn<ProjectFinancialEntry>[] = [
      {
        label: uiText("Erfasst am"),
        render: (row: ProjectFinancialEntry) =>
          formatDate(row.createdAt, "long"),
        sortKey: (row: ProjectFinancialEntry) => row.createdAt.getTime(),
      },
      {
        label: uiText("Betrag"),
        render: (row: ProjectFinancialEntry) => formatCurrency(row.amount),
        sortKey: (row: ProjectFinancialEntry) => row.amount,
      },
      {
        label: uiText("Kommentar"),
        render: (row: ProjectFinancialEntry) => row.comment || "",
        sortKey: (row: ProjectFinancialEntry) =>
          (row.comment || "").toLowerCase(),
      },
    ];

    if (canManageProjectFinancialEntries) {
      columns.push({
        label: uiText("Aktionen"),
        render: (row: ProjectFinancialEntry) => (
          <div className="flex items-center gap-1">
            <MyButton
              size="sm"
              kind="ghost"
              aria-label={uiText("Bearbeiten")}
              title={uiText("Bearbeiten")}
              onClick={() =>
                showModifyProjectFinancialEntryModal(modals, project, row)
              }
            >
              <Icons.Edit />
            </MyButton>

            <MyButton
              size="sm"
              kind="danger--tertiary"
              aria-label={uiText("Löschen")}
              title={uiText("Löschen")}
              onClick={() =>
                showDeleteProjectFinancialEntryModal(modals, project, row)
              }
            >
              <Icons.Delete />
            </MyButton>
          </div>
        ),
      });
    }

    return (
      <MyExpandable title={`${title} (${formatCurrency(total)})`}>
        <MyTable
          className="th-20rem"
          rows={entries}
          columns={columns}
          pagination={{}}
          autoConvertSmallViewport
        />
      </MyExpandable>
    );
  };

  return (
    <>
      <div className="flex justify-end gap-2">
        <MyButton
          kind="ghost"
          size="sm"
          renderIcon={Icons.Download}
          loading={isPdfExporting}
          onClick={() => exportCostsToPdf("overall")}
        >
          {uiText("PDF")}
        </MyButton>

        <MyButton
          kind="ghost"
          size="sm"
          renderIcon={Icons.Download}
          loading={isPdfExporting}
          onClick={() => exportCostsToPdf("weekly")}
        >
          {uiText("PDF (wochenweise)")}
        </MyButton>

        <MyButton
          kind="ghost"
          size="sm"
          renderIcon={Icons.Excel}
          onClick={async () => {
            if (!costs) return;

            const ExcelJS = await import("exceljs");

            const CURRENCY_NUM_FMT = "#,##0.00 [$€-407]";
            const DECIMAL_NUM_FMT = "#,##0.00";
            const PERCENT_NUM_FMT = "0.00%";

            const toColumnName = (column: number) => {
              let name = "";
              let current = column;
              while (current > 0) {
                const remainder = (current - 1) % 26;
                name = String.fromCharCode(65 + remainder) + name;
                current = Math.floor((current - 1) / 26);
              }
              return name;
            };

            const cellRef = (row: number, column: number) =>
              `${toColumnName(column)}${row}`;

            type TableMeta = {
              rowCount: number;
              firstDataRow: number;
              lastDataRow: number;
            };

            const sumFormula = (table: TableMeta | null, column: number) => {
              if (!table || table.rowCount === 0) return "0";
              return `SUM(${cellRef(table.firstDataRow, column)}:${cellRef(table.lastDataRow, column)})`;
            };

            const toNumber = (value: number | null | undefined) =>
              value == null ? null : Number(value);

            const productIds = [
              ...new Set(costs.products.map((record) => record.productId)),
            ];
            const productEntries = await Promise.all(
              productIds.map(async (productId) => {
                const [product] = await client.query(
                  "products.get",
                  { id: productId },
                  { strategy: "cache-first" },
                );
                return [productId, product ?? null] as const;
              }),
            );
            const productMap = new Map(productEntries);

            const toolIds = [
              ...new Set(costs.toolTrackings.map((record) => record.toolId)),
            ];
            const toolEntries = await Promise.all(
              toolIds.map(async (toolId) => {
                const [tool] = await client.query(
                  "tools.get",
                  { id: toolId },
                  { strategy: "cache-first" },
                );
                return [toolId, tool ?? null] as const;
              }),
            );
            const toolMap = new Map(toolEntries);

            const userIds = [
              ...new Set(
                [...regularWorkHours, ...subcontractorWorkHours]
                  .map((record) => record.userId)
                  .filter(Boolean),
              ),
            ] as string[];
            const userEntries = await Promise.all(
              userIds.map(async (userId) => {
                const [user] = await client.query(
                  "users.get",
                  { id: userId },
                  { strategy: "cache-first" },
                );
                return [userId, user ?? null] as const;
              }),
            );
            const userMap = new Map(userEntries);

            const wb = new ExcelJS.Workbook();
            wb.creator = "exceljs";
            wb.created = new Date();

            const ws = wb.addWorksheet("Projektkosten");
            ws.getCell(1, 1).value = "Projektkosten";
            ws.getCell(1, 1).font = { size: 18, bold: true };
            ws.getCell(2, 1).value = project.title;
            ws.getCell(2, 1).font = { size: 12, italic: true };
            ws.mergeCells(1, 1, 1, 6);
            ws.mergeCells(2, 1, 2, 6);

            let cursor = 4;

            const addSectionTitle = (label: string) => {
              ws.getCell(cursor, 1).value = label;
              ws.getCell(cursor, 1).font = { bold: true, size: 14 };
              ws.getRow(cursor + 1).height = 4;
              cursor += 2;
            };

            const addTable = (
              columns: string[],
              rows: Array<Array<string | number | Date | null>>,
            ): TableMeta | null => {
              if (!rows.length) {
                return null;
              }

              const startRow = cursor;

              ws.addTable({
                name: `Table_${cursor}_${columns.length}`,
                ref: ws.getCell(cursor, 1).address,
                headerRow: true,
                totalsRow: false,
                style: { theme: "TableStyleLight1", showRowStripes: true },
                columns: columns.map((name) => ({ name })),
                rows,
              });

              const rowCount = rows.length;
              cursor += rows.length + 2;

              return {
                rowCount,
                firstDataRow: startRow + 1,
                lastDataRow: startRow + rowCount,
              };
            };

            addSectionTitle("Gesamtkosten");
            const totalsTable = addTable(
              ["Bereich", uiText("Kosten"), "LKG", "MGK", "NUGK", "Gesamt"],
              [
                ["Produkte", 0, 0, 0, 0, 0],
                ["Sonderposten", 0, 0, 0, 0, 0],
                ["Lieferscheine", 0, 0, 0, 0, 0],
                ["Werkzeuge", 0, 0, 0, 0, 0],
                [uiText("Arbeitszeit"), 0, 0, 0, 0, 0],
                [uiText("Nachunternehmer-Arbeitszeit"), 0, 0, 0, 0, 0],
                ["Gesamt", 0, 0, 0, 0, 0],
              ],
            );

            const sortedProductsForExport = [...costs.products].sort(
              (left, right) => {
                const leftProduct = productMap.get(left.productId);
                const rightProduct = productMap.get(right.productId);

                const leftNumber =
                  `${leftProduct?.customId ?? ""}`.toLowerCase();
                const rightNumber =
                  `${rightProduct?.customId ?? ""}`.toLowerCase();
                const numberDiff = leftNumber.localeCompare(rightNumber, "de");
                if (numberDiff !== 0) return numberDiff;

                const leftDate = left.priceRecord?.timestamp
                  ? new Date(left.priceRecord.timestamp).getTime()
                  : 0;
                const rightDate = right.priceRecord?.timestamp
                  ? new Date(right.priceRecord.timestamp).getTime()
                  : 0;
                if (leftDate !== rightDate) return leftDate - rightDate;

                const leftTitle =
                  `${leftProduct ? productTitle(leftProduct) : ""}`.toLowerCase();
                const rightTitle =
                  `${rightProduct ? productTitle(rightProduct) : ""}`.toLowerCase();
                return leftTitle.localeCompare(rightTitle, "de");
              },
            );

            const productRows = sortedProductsForExport.map((record) => {
              const product = productMap.get(record.productId);
              const baseQuantity = Number(record.quantity ?? 0);
              const [amount, unit] = product
                ? upmatchUnit(product, baseQuantity)
                : [baseQuantity, ""];
              const totalCost = toNumber(record.totalCost);
              const baseUnit = product?.baseUnit ?? "";
              const baseText = formatBaseQuantity(baseQuantity, baseUnit, unit);
              const avgUnitPrice =
                baseQuantity > 0 &&
                totalCost != null &&
                hasNumberData(totalCost)
                  ? totalCost / baseQuantity
                  : null;
              return [
                product
                  ? `${product.customId} ${productTitle(product)}`
                  : "Unbekannt",
                formatProductAmount(amount, unit),
                baseText,
                avgUnitPrice,
                totalCost,
              ] as Array<string | number | Date | null>;
            });
            let productsTable: TableMeta | null = null;
            if (productRows.length) {
              addSectionTitle("Produkte");
              productsTable = addTable(
                [
                  "Bezeichnung",
                  "Menge",
                  "Basismenge",
                  "mittlerer EP",
                  uiText("Kosten"),
                ],
                productRows,
              );
            }
            if (productsTable) {
              for (let i = 0; i < productsTable.rowCount; i++) {
                const row = productsTable.firstDataRow + i;

                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;
                ws.getCell(row, 5).numFmt = CURRENCY_NUM_FMT;
              }
            }

            const specialRows = costs.specialRecords.map(
              (record) =>
                [
                  record.name,
                  Number(record.amount ?? 0),
                  record.unit,
                  toNumber(record.pricePerUnit),
                  toNumber(record.totalCost),
                  `#${record.noteAutoId}`,
                ] as Array<string | number | Date | null>,
            );
            let specialTable: TableMeta | null = null;
            if (specialRows.length) {
              addSectionTitle("Sonderposten");
              specialTable = addTable(
                [
                  "Bezeichnung",
                  "Menge",
                  "Einheit",
                  "pro Einheit",
                  "Gesamt",
                  uiText("Lieferschein"),
                ],
                specialRows,
              );
            }
            if (specialTable) {
              for (let i = 0; i < specialTable.rowCount; i++) {
                const row = specialTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = DECIMAL_NUM_FMT;
                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 5);
                totalCell.value = {
                  formula: `IF(${cellRef(row, 4)}="",0,${cellRef(row, 2)}*${cellRef(row, 4)})`,
                };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const sortedToolTrackingsForExport = [...costs.toolTrackings].sort(
              (left, right) =>
                left.startedAt.getTime() - right.startedAt.getTime(),
            );

            const toolRows = sortedToolTrackingsForExport.map((record) => {
              const tool = toolMap.get(record.toolId);

              let start = startOfDay(record.startedAt);
              let end = endOfDay(record.endedAt || new Date());
              const days = Math.ceil(
                (end.getTime() - start.getTime()) / (24 * 3600 * 1000),
              );

              return [
                tool ? `${tool.customId} ${toolTitle(tool)}` : "Unbekannt",
                start,
                record.endedAt ? startOfDay(record.endedAt) : null,
                Number(days),
                toNumber(record.toolUsageCostPerDay),
                toNumber(record.totalCost),
              ] as Array<string | number | Date | null>;
            });
            let toolsTable: TableMeta | null = null;
            if (toolRows.length) {
              addSectionTitle("Werkzeuge");
              toolsTable = addTable(
                [
                  uiText("Werkzeug"),
                  uiText("Von"),
                  uiText("Bis"),
                  "Tage",
                  "pro Tag",
                  "Gesamt",
                ],
                toolRows,
              );
            }
            if (toolsTable) {
              for (let i = 0; i < toolsTable.rowCount; i++) {
                const row = toolsTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = EXCEL_DATE_NUM_FMT;
                ws.getCell(row, 3).numFmt = EXCEL_DATE_NUM_FMT;

                ws.getCell(row, 4).value = {
                  formula: `IF(${cellRef(row, 2)}="",0,MAX(IF(${cellRef(row, 3)}="",TODAY(),${cellRef(row, 3)})-${cellRef(row, 2)}+1,0))`,
                };
                ws.getCell(row, 4).numFmt = "0";

                ws.getCell(row, 5).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 6);
                totalCell.value = {
                  formula: `IF(${cellRef(row, 5)}="",0,${cellRef(row, 4)}*${cellRef(row, 5)})`,
                };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const sortWorkHoursForExport = (records: typeof regularWorkHours) =>
              [...records].sort((left, right) => {
                const leftUser = left.userId ? userMap.get(left.userId) : null;
                const rightUser = right.userId
                  ? userMap.get(right.userId)
                  : null;

                const leftLastName =
                  `${leftUser?.lastName ?? ""}`.toLowerCase();
                const rightLastName =
                  `${rightUser?.lastName ?? ""}`.toLowerCase();
                const lastNameDiff = leftLastName.localeCompare(
                  rightLastName,
                  "de",
                );
                if (lastNameDiff !== 0) return lastNameDiff;

                const leftFirstName =
                  `${leftUser?.firstName ?? ""}`.toLowerCase();
                const rightFirstName =
                  `${rightUser?.firstName ?? ""}`.toLowerCase();
                const firstNameDiff = leftFirstName.localeCompare(
                  rightFirstName,
                  "de",
                );
                if (firstNameDiff !== 0) return firstNameDiff;

                return left.day.getTime() - right.day.getTime();
              });

            const workHourRows = sortWorkHoursForExport(regularWorkHours).map(
              (record) => {
                const user = record.userId ? userMap.get(record.userId) : null;
                return [
                  user ? userFullName(user) : "Unbekannt",
                  record.day ? startOfDay(record.day) : null,
                  Number(record.hours ?? 0),
                  toNumber(record.costPerHour),
                  toNumber(record.totalCost),
                ] as Array<string | number | Date | null>;
              },
            );
            let workHoursTable: TableMeta | null = null;
            if (workHourRows.length) {
              addSectionTitle(uiText("Arbeitszeit"));
              workHoursTable = addTable(
                [
                  "Mitarbeiter",
                  "Tag",
                  uiText("Stunden"),
                  "pro Stunde",
                  uiText("Kosten"),
                ],
                workHourRows,
              );
            }
            if (workHoursTable) {
              for (let i = 0; i < workHoursTable.rowCount; i++) {
                const row = workHoursTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = EXCEL_DATE_NUM_FMT;
                ws.getCell(row, 3).numFmt = DECIMAL_NUM_FMT;
                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 5);
                totalCell.value = {
                  formula: `IF(${cellRef(row, 4)}="",0,${cellRef(row, 3)}*${cellRef(row, 4)})`,
                };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const subcontractorWorkHourRows = sortWorkHoursForExport(
              subcontractorWorkHours,
            ).map((record) => {
              const user = record.userId ? userMap.get(record.userId) : null;
              return [
                user ? userFullName(user) : "Unbekannt",
                record.day ? startOfDay(record.day) : null,
                Number(record.hours ?? 0),
                toNumber(record.costPerHour),
                toNumber(record.totalCost),
              ] as Array<string | number | Date | null>;
            });
            let subcontractorWorkHoursTable: TableMeta | null = null;
            if (subcontractorWorkHourRows.length) {
              addSectionTitle(uiText("Nachunternehmer-Arbeitszeit"));
              subcontractorWorkHoursTable = addTable(
                [
                  "Mitarbeiter",
                  "Tag",
                  uiText("Stunden"),
                  "pro Stunde",
                  uiText("Kosten"),
                ],
                subcontractorWorkHourRows,
              );
            }
            if (subcontractorWorkHoursTable) {
              for (let i = 0; i < subcontractorWorkHoursTable.rowCount; i++) {
                const row = subcontractorWorkHoursTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = EXCEL_DATE_NUM_FMT;
                ws.getCell(row, 3).numFmt = DECIMAL_NUM_FMT;
                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 5);
                totalCell.value = {
                  formula: `IF(${cellRef(row, 4)}="",0,${cellRef(row, 3)}*${cellRef(row, 4)})`,
                };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const deliveryNoteRows = costs.deliveryNotes.map(
              (record) =>
                [`#${record.autoId}`, toNumber(record.totalCost)] as Array<
                  string | number | Date | null
                >,
            );
            let deliveryNotesTable: TableMeta | null = null;
            if (deliveryNoteRows.length) {
              addSectionTitle("Lieferscheine");
              deliveryNotesTable = addTable(
                [uiText("Lieferschein"), uiText("Kosten")],
                deliveryNoteRows,
              );
            }
            if (deliveryNotesTable) {
              for (let i = 0; i < deliveryNotesTable.rowCount; i++) {
                ws.getCell(deliveryNotesTable.firstDataRow + i, 2).numFmt =
                  CURRENCY_NUM_FMT;
              }
            }

            if (totalsTable) {
              const totalsStart = totalsTable.firstDataRow;

              const productsRow = totalsStart + 0;
              const specialRow = totalsStart + 1;
              const deliveryRow = totalsStart + 2;
              const toolsRow = totalsStart + 3;
              const workHoursRow = totalsStart + 4;
              const subcontractorWorkHoursRow = totalsStart + 5;
              const totalRow = totalsStart + 6;

              const fgkOverheadLiteral = Number(
                commonCosts.fgk.overheadCost ?? 0,
              );
              const mgkOverheadLiteral = Number(
                commonCosts.mgk.overheadCost ?? 0,
              );
              const ngkOverheadLiteral = Number(
                commonCosts.ngk.overheadCost ?? 0,
              );

              ws.getCell(productsRow, 2).value = {
                formula: sumFormula(productsTable, 5),
              };
              ws.getCell(productsRow, 3).value = { formula: "0" };
              ws.getCell(productsRow, 4).value = { formula: "0" };
              ws.getCell(productsRow, 5).value = { formula: "0" };
              ws.getCell(productsRow, 6).value = {
                formula: `${cellRef(productsRow, 2)}+${cellRef(productsRow, 3)}+${cellRef(productsRow, 4)}+${cellRef(productsRow, 5)}`,
              };

              ws.getCell(specialRow, 2).value = {
                formula: sumFormula(specialTable, 5),
              };
              ws.getCell(specialRow, 3).value = { formula: "0" };
              ws.getCell(specialRow, 4).value = { formula: "0" };
              ws.getCell(specialRow, 5).value = { formula: "0" };
              ws.getCell(specialRow, 6).value = {
                formula: `${cellRef(specialRow, 2)}+${cellRef(specialRow, 3)}+${cellRef(specialRow, 4)}+${cellRef(specialRow, 5)}`,
              };

              ws.getCell(deliveryRow, 2).value = {
                formula: sumFormula(deliveryNotesTable, 2),
              };
              ws.getCell(deliveryRow, 3).value = { formula: "0" };
              ws.getCell(deliveryRow, 4).value = {
                formula: `${mgkOverheadLiteral}`,
              };
              ws.getCell(deliveryRow, 5).value = { formula: "0" };
              ws.getCell(deliveryRow, 6).value = {
                formula: `${cellRef(deliveryRow, 2)}+${cellRef(deliveryRow, 3)}+${cellRef(deliveryRow, 4)}+${cellRef(deliveryRow, 5)}`,
              };

              ws.getCell(toolsRow, 2).value = {
                formula: sumFormula(toolsTable, 6),
              };
              ws.getCell(toolsRow, 3).value = { formula: "0" };
              ws.getCell(toolsRow, 4).value = { formula: "0" };
              ws.getCell(toolsRow, 5).value = { formula: "0" };
              ws.getCell(toolsRow, 6).value = {
                formula: `${cellRef(toolsRow, 2)}+${cellRef(toolsRow, 3)}+${cellRef(toolsRow, 4)}+${cellRef(toolsRow, 5)}`,
              };

              ws.getCell(workHoursRow, 2).value = {
                formula: sumFormula(workHoursTable, 5),
              };
              ws.getCell(workHoursRow, 3).value = {
                formula: `${fgkOverheadLiteral}`,
              };
              ws.getCell(workHoursRow, 4).value = { formula: "0" };
              ws.getCell(workHoursRow, 5).value = { formula: "0" };
              ws.getCell(workHoursRow, 6).value = {
                formula: `${cellRef(workHoursRow, 2)}+${cellRef(workHoursRow, 3)}+${cellRef(workHoursRow, 4)}+${cellRef(workHoursRow, 5)}`,
              };

              ws.getCell(subcontractorWorkHoursRow, 2).value = {
                formula: sumFormula(subcontractorWorkHoursTable, 5),
              };
              ws.getCell(subcontractorWorkHoursRow, 3).value = { formula: "0" };
              ws.getCell(subcontractorWorkHoursRow, 4).value = { formula: "0" };
              ws.getCell(subcontractorWorkHoursRow, 5).value = {
                formula: `${ngkOverheadLiteral}`,
              };
              ws.getCell(subcontractorWorkHoursRow, 6).value = {
                formula: `${cellRef(subcontractorWorkHoursRow, 2)}+${cellRef(subcontractorWorkHoursRow, 3)}+${cellRef(subcontractorWorkHoursRow, 4)}+${cellRef(subcontractorWorkHoursRow, 5)}`,
              };

              ws.getCell(totalRow, 2).value = {
                formula: `${cellRef(deliveryRow, 2)}+${cellRef(toolsRow, 2)}+${cellRef(workHoursRow, 2)}+${cellRef(subcontractorWorkHoursRow, 2)}`,
              };
              ws.getCell(totalRow, 3).value = {
                formula: `${cellRef(deliveryRow, 3)}+${cellRef(toolsRow, 3)}+${cellRef(workHoursRow, 3)}+${cellRef(subcontractorWorkHoursRow, 3)}`,
              };
              ws.getCell(totalRow, 4).value = {
                formula: `${cellRef(deliveryRow, 4)}+${cellRef(toolsRow, 4)}+${cellRef(workHoursRow, 4)}+${cellRef(subcontractorWorkHoursRow, 4)}`,
              };
              ws.getCell(totalRow, 5).value = {
                formula: `${cellRef(deliveryRow, 5)}+${cellRef(toolsRow, 5)}+${cellRef(workHoursRow, 5)}+${cellRef(subcontractorWorkHoursRow, 5)}`,
              };
              ws.getCell(totalRow, 6).value = {
                formula: `${cellRef(totalRow, 2)}+${cellRef(totalRow, 3)}+${cellRef(totalRow, 4)}+${cellRef(totalRow, 5)}`,
              };

              for (let i = 0; i < totalsTable.rowCount; i++) {
                const row = totalsStart + i;
                ws.getCell(row, 2).numFmt = CURRENCY_NUM_FMT;
                ws.getCell(row, 3).numFmt = CURRENCY_NUM_FMT;
                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;
                ws.getCell(row, 5).numFmt = CURRENCY_NUM_FMT;
                ws.getCell(row, 6).numFmt = CURRENCY_NUM_FMT;
              }

              ws.getCell(totalRow, 1).font = { bold: true };
              ws.getCell(totalRow, 2).font = { bold: true };
              ws.getCell(totalRow, 3).font = { bold: true };
              ws.getCell(totalRow, 4).font = { bold: true };
              ws.getCell(totalRow, 5).font = { bold: true };
              ws.getCell(totalRow, 6).font = { bold: true };
            }

            if (hasInvoices) {
              addSectionTitle("Deckung");
              const diff =
                Number(invoicesTotal ?? 0) -
                Number(costs.totalCosts.overall ?? 0);
              const balanceRows: Array<Array<string | number | Date | null>> = [
                [
                  "Gewinn/Verlust",
                  diff,
                  hasNumberData(invoicesTotal)
                    ? diff / Math.abs(invoicesTotal)
                    : null,
                ],
              ];
              const balanceTable = addTable(
                ["Bereich", "Betrag (absolut)", "Relativ"],
                balanceRows,
              );
              if (balanceTable) {
                for (let i = 0; i < balanceTable.rowCount; i++) {
                  const row = balanceTable.firstDataRow + i;
                  ws.getCell(row, 2).numFmt = CURRENCY_NUM_FMT;
                  ws.getCell(row, 3).numFmt = PERCENT_NUM_FMT;
                  ws.getCell(row, 1).font = { bold: true };
                  ws.getCell(row, 2).font = { bold: true };
                  ws.getCell(row, 3).font = { bold: true };
                }
              }
            } else {
              addSectionTitle("Hinweis");
              const row = cursor;
              ws.mergeCells(row, 1, row, 6);
              ws.getCell(row, 1).value = MISSING_INVOICE_NOTICE;
              ws.getCell(row, 1).font = {
                color: { argb: "FF6B7280" },
                italic: true,
              };
              ws.getCell(row, 1).alignment = {
                wrapText: true,
                vertical: "top",
              };
              cursor += 2;
            }

            ws.columns = [
              { width: 40 },
              { width: 16 },
              { width: 10 },
              { width: 14 },
              { width: 14 },
              { width: 14 },
            ];

            const bytes =
              (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
            const blob = new Blob([bytes] as any, {
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });
            const safeTitle = project.title.replace(/[^\w\-]+/g, "-");
            await openExcelExport(
              modals,
              blob,
              uiText(
                `Projektkosten-${safeTitle}.xlsx`,
                `Project-costs-${safeTitle}.xlsx`,
              ),
            );
          }}
        >
          {uiText("Excel")}
        </MyButton>
      </div>

      {!!pdfExportErr && (
        <MyCallout icon={Icons.Deny} color="red">
          {uiText("PDF-Export fehlgeschlagen:")} {pdfExportErr}
        </MyCallout>
      )}

      <AttrList>
        <AttrList.Attr
          name="Gesamtkosten"
          value={formatCurrency(costs.totalCosts.overall)}
        />
        <AttrList.Attr
          name="Angebotssummen"
          value={formatCurrency(offersTotal)}
          third={uiText(
            `${offers.length} ${offers.length === 1 ? "Eintrag" : "Einträge"}`,
            `${offers.length} ${offers.length === 1 ? "entry" : "entries"}`,
          )}
        />
        <AttrList.Attr
          name="Rechnungssummen"
          value={formatCurrency(invoicesTotal)}
          third={uiText(
            `${invoices.length} ${invoices.length === 1 ? "Eintrag" : "Einträge"}`,
            `${invoices.length} ${invoices.length === 1 ? "entry" : "entries"}`,
          )}
        />
        {hasInvoices && (
          <AttrList.Attr
            name="Gewinn/Verlust"
            value={
              <GainOrLossText
                value={gainOrLoss}
                invoicesTotal={invoicesTotal}
              />
            }
          />
        )}
        {!hasInvoices && (
          <AttrList.Attr name="Hinweis" value={MISSING_INVOICE_NOTICE} />
        )}
      </AttrList>

      {hasCommonCosts && (
        <MyExpandable
          title={`Gemeinkosten (${formatCurrency(commonCostsOverhead)})`}
        >
          <AttrList>
            <AttrList.Attr
              name="LKG"
              value={formatCurrency(commonCosts.fgk.overheadCost)}
              third={`Basis: ${formatCurrency(commonCosts.fgk.baseCost)}`}
            />
            <AttrList.Attr
              name="MGK"
              value={formatCurrency(commonCosts.mgk.overheadCost)}
              third={`Basis: ${formatCurrency(commonCosts.mgk.baseCost)}`}
            />
            <AttrList.Attr
              name="NUGK"
              value={formatCurrency(commonCosts.ngk.overheadCost)}
              third={`Basis: ${formatCurrency(commonCosts.ngk.baseCost)}`}
            />
          </AttrList>
        </MyExpandable>
      )}

      {!!costs.products?.length && (
        <MyExpandable
          title={`Produkte (${formatCurrency(costs.totalCosts.products)})`}
        >
          <MyTable
            className="th-25rem"
            rows={costs.products.map((p) => ({ ...p, id: p.productId }))}
            columns={[
              {
                label: uiText("Bezeichnung"),
                render: async (row) => {
                  const [product] = await client.query(
                    "products.get",
                    { id: row.productId },
                    { strategy: "cache-first" },
                  );
                  if (!product) return "Unbekannt";
                  return (
                    <MyLink to={`/products/${product.id}`}>
                      {productTitle(product)}
                    </MyLink>
                  );
                },
              },
              {
                label: uiText("Menge"),
                render: async (row) => {
                  const [product] = await client.query(
                    "products.get",
                    { id: row.productId },
                    { strategy: "cache-first" },
                  );
                  if (!product) return `${formatNumber(row.quantity)} ???`;
                  const [amount, unit] = upmatchUnit(product, row.quantity);
                  return formatProductAmount(amount, unit);
                },
              },
              {
                label: uiText("Basismenge"),
                render: async (row) => {
                  const [product] = await client.query(
                    "products.get",
                    { id: row.productId },
                    { strategy: "cache-first" },
                  );
                  if (!product) return formatNumber(row.quantity);
                  const [, unit] = upmatchUnit(product, row.quantity);
                  return formatBaseQuantity(
                    Number(row.quantity ?? 0),
                    product.baseUnit ?? "",
                    unit,
                  );
                },
              },
              {
                label: uiText("mittlerer EP"),
                render: async (row) => {
                  const [product] = await client.query(
                    "products.get",
                    { id: row.productId },
                    { strategy: "cache-first" },
                  );
                  const quantity = Number(row.quantity ?? 0);
                  if (
                    !product ||
                    quantity <= 0 ||
                    !hasNumberData(row.totalCost)
                  )
                    return "-";
                  return `${formatCurrency(Number(row.totalCost ?? 0) / quantity)}/${product.baseUnit}`;
                },
              },
              {
                label: uiText("Kosten"),
                render: (row) =>
                  !!row.totalCost && formatCurrency(row.totalCost),
                sortKey: (row) => row.totalCost,
              },
            ]}
            pagination={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {!!costs.specialRecords?.length && (
        <MyExpandable
          title={`Sonderposten (${formatCurrency(costs.totalCosts.specialRecords)})`}
        >
          <MyTable
            className="th-25rem"
            rows={costs.specialRecords}
            columns={[
              {
                label: uiText("Bezeichnung"),
                render: (row) => row.name,
                sortKey: (row) => row.name.toLowerCase(),
              },
              {
                label: uiText("Menge"),
                render: (row) => `${formatNumber(row.amount)} ${row.unit}`,
              },
              {
                label: uiText("Preis pro Einheit"),
                render: (row) =>
                  !!row.pricePerUnit && formatCurrency(row.pricePerUnit),
                sortKey: (row) => row.pricePerUnit ?? 0,
              },
              {
                label: uiText("Kosten"),
                render: (row) =>
                  !!row.totalCost && formatCurrency(row.totalCost),
                sortKey: (row) => row.totalCost,
              },
              {
                label: uiText("Lieferschein"),
                render: (row) => (
                  <MyLink
                    to={`/products/deliveryNotes/${row.noteId}`}
                  >{`#${row.noteAutoId}`}</MyLink>
                ),
                sortKey: (row) => row.noteAutoId,
              },
            ]}
            pagination={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {!!costs.toolTrackings?.length && (
        <MyExpandable
          title={`Werkzeuge (${formatCurrency(costs.totalCosts.toolTrackings)})`}
        >
          <MyTable
            className="th-25rem"
            rows={costs.toolTrackings}
            columns={[
              {
                label: uiText("Werkzeug"),
                render: async (row) => {
                  const [tool] = await client.query(
                    "tools.get",
                    { id: row.toolId },
                    { strategy: "cache-first" },
                  );
                  if (!tool) return "Unbekannt";
                  return (
                    <MyLink to={`/tools/${tool.id}`}>
                      {tool.customId} {toolTitle(tool)}
                    </MyLink>
                  );
                },
              },
              {
                label: uiText("Von"),
                render: (row) => formatDate(row.startedAt),
                sortKey: (row) => row.startedAt.getTime(),
              },
              {
                label: uiText("Bis"),
                render: (row) =>
                  row.endedAt ? formatDate(row.endedAt) : "offen",
                sortKey: (row) =>
                  row.endedAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
              },
              {
                label: uiText("Tage"),
                render: (row) => {
                  let start = startOfDay(row.startedAt);
                  let end = endOfDay(row.endedAt || new Date());
                  const days = Math.ceil(
                    (end.getTime() - start.getTime()) / (24 * 3600 * 1000),
                  );
                  return days.toString();
                },
                sortKey: (row) => {
                  let start = startOfDay(row.startedAt);
                  let end = endOfDay(row.endedAt || new Date());
                  return Math.ceil(
                    (end.getTime() - start.getTime()) / (24 * 3600 * 1000),
                  );
                },
              },
              // {
              //   label: 'Kosten pro Tag',
              //   render: row => formatCurrency(row.toolUsageCostPerDay!),
              //   sortKey: row => row.toolUsageCostPerDay!,
              // },
              {
                label: uiText("Kosten"),
                render: (row) =>
                  !!row.totalCost && formatCurrency(row.totalCost),
                sortKey: (row) => row.totalCost,
              },
            ]}
            pagination={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {!!regularWorkHours.length && (
        <MyExpandable
          title={uiText(
            `Arbeitszeit (${formatCurrency(workHoursTotal)})`,
            `Working time (${formatCurrency(workHoursTotal)})`,
          )}
        >
          <MyTable
            className="th-25rem"
            rows={regularWorkHours}
            columns={[
              {
                label: uiText("Benutzer"),
                render: async (row) => {
                  if (!row.userId) return "Unbekannt";
                  const [user] = await client.query(
                    "users.get",
                    { id: row.userId },
                    { strategy: "cache-first" },
                  );
                  if (!user) return "Unbekannt";
                  return (
                    <MyLink to={`/users/${user.id}`}>
                      {userFullName(user)}
                    </MyLink>
                  );
                },
              },
              {
                label: uiText("Tag"),
                render: (row) => formatDate(row.day),
                sortKey: (row) => row.day.getTime(),
              },
              {
                label: uiText("Stunden"),
                render: (row) => formatNumber(row.hours),
                sortKey: (row) => row.hours,
              },
              {
                label: uiText("Kosten"),
                render: (row) =>
                  !!row.totalCost && formatCurrency(row.totalCost),
                sortKey: (row) => row.totalCost,
              },
            ]}
            pagination={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {!!subcontractorWorkHours.length && (
        <MyExpandable
          title={uiText(
            `Nachunternehmer-Arbeitszeit (${formatCurrency(subcontractorWorkHoursTotal)})`,
            `Subcontractor work (${formatCurrency(subcontractorWorkHoursTotal)})`,
          )}
        >
          <MyTable
            className="th-25rem"
            rows={subcontractorWorkHours}
            columns={[
              {
                label: uiText("Benutzer"),
                render: async (row) => {
                  if (!row.userId) return "Unbekannt";
                  const [user] = await client.query(
                    "users.get",
                    { id: row.userId },
                    { strategy: "cache-first" },
                  );
                  if (!user) return "Unbekannt";
                  return (
                    <MyLink to={`/users/${user.id}`}>
                      {userFullName(user)}
                    </MyLink>
                  );
                },
              },
              {
                label: uiText("Tag"),
                render: (row) => formatDate(row.day),
                sortKey: (row) => row.day.getTime(),
              },
              {
                label: uiText("Stunden"),
                render: (row) => formatNumber(row.hours),
                sortKey: (row) => row.hours,
              },
              {
                label: uiText("Kosten"),
                render: (row) =>
                  !!row.totalCost && formatCurrency(row.totalCost),
                sortKey: (row) => row.totalCost,
              },
            ]}
            pagination={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {!!costs.deliveryNotes?.length && (
        <MyExpandable title={`Lieferscheine`}>
          <MyTable
            className="th-25rem"
            rows={costs.deliveryNotes.map((e) => ({ ...e, id: e.noteId }))}
            columns={[
              {
                label: uiText("Produkt"),
                render: (row) => (
                  <MyLink to={`/products/deliveryNotes/${row.id}`}>
                    {uiText(
                      `Lieferschein #${row.autoId}`,
                      `Delivery note #${row.autoId}`,
                    )}
                  </MyLink>
                ),
              },
              {
                label: uiText("Kosten"),
                render: (row) =>
                  !!row.totalCost && formatCurrency(row.totalCost),
                sortKey: (row) => row.totalCost,
              },
            ]}
            pagination={{}}
            autoConvertSmallViewport
          />
        </MyExpandable>
      )}

      {hasFinancialEntries && <div style={{ height: "1.5rem" }} />}

      {!!offers.length &&
        renderFinancialEntriesExpandable("Angebotssummen", offersTotal, offers)}
      {!!invoices.length &&
        renderFinancialEntriesExpandable(
          "Rechnungssummen",
          invoicesTotal,
          invoices,
        )}
    </>
  );
}
