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
import { MyLink } from "~/components/MyLink";
import { formatDate, formatNumber, productTitle, userFullName } from "~/lib/format";
import { MyDivider } from "~/components/MyDivider";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { MyTable } from "~/components/MyTable";
import { MyExpandable } from "~/components/MyExpandable";
import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf } from "~/lib/pdf";
import { buildRegieReportPdfDocument } from "~/lib/regieReportPdf";
import { showDeleteRegieReportModal, showModifyRegieReportModal } from "~/modals/regieReports";
import { deliverBlob, type BlobTarget, upmatchUnit } from "~/lib/utils";
import { openExcelExport } from "~/lib/officeExports";
import { dayInIsoWeek, isoWeekLabel, startOfIsoWeek, WEEKDAY_NAMES, WEEKDAY_SHORT_NAMES, weekdayIndexInIsoWeek } from "~/lib/week";

function formatBaseQuantity(baseQuantity: number, baseUnit: string, displayUnit: string) {
  const normalizedBaseUnit = `${baseUnit ?? ''}`.trim();
  const normalizedDisplayUnit = `${displayUnit ?? ''}`.trim();
  if (normalizedDisplayUnit === normalizedBaseUnit) return '-';
  return `${formatNumber(baseQuantity)}${normalizedBaseUnit ? ` ${normalizedBaseUnit}` : ''}`;
}

export default function RegieReportDetailPage() {
  const { id } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);

  const [report, err] = useClientStream(() => client.streamQuery('regieReports.get', { id: id! }), [id]);

  useTitle(() => report ? uiText(`Regiebericht ${isoWeekLabel(new Date(report.day))}`, `Time-and-material report ${isoWeekLabel(new Date(report.day))}`) : null, [report?.day]);

  useShortcut('Control+e', e => {
    if (!report || !sessionInfo.canDo('manage:regieReports')) return;
    e.preventDefault();
    showModifyRegieReportModal(modals, report);
  });

  useShortcut('Control+p', e => {
    if (!report || !sessionInfo.canDo('view:regieReports')) return;
    e.preventDefault();
    if (isPdfExporting) return;
    void exportRegieReportToPdf('open');
  });

  if (err) return <NotFound reason="resourceNotFound" />
  if (!report) return;

  const weekStart = startOfIsoWeek(new Date(report.day));
  const weekEnd = dayInIsoWeek(weekStart, WEEKDAY_NAMES.length - 1);

  async function exportRegieReportToPdf(target: BlobTarget = 'open') {
    const currentReport = report;
    if (!currentReport) return;
    const pdfWindow = target === 'open' ? window.open('', '_blank') : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const [project] = await client.query('projects.get', { id: currentReport.projectId }, { strategy: 'cache-first' });

      const productIds = [...new Set(currentReport.products.map((record) => record.productId))];
      const productEntries = await Promise.all(productIds.map(async (productId) => {
        const [product] = await client.query('products.get', { id: productId }, { strategy: 'cache-first' });
        return [productId, product ?? null] as const;
      }));
      const productMap = new Map(productEntries);

      const userIds = [...new Set(currentReport.workHours.map((record) => record.userId).filter(Boolean))] as string[];
      const userEntries = await Promise.all(userIds.map(async (userId) => {
        const [user] = await client.query('users.get', { id: userId }, { strategy: 'cache-first' });
        return [userId, user ?? null] as const;
      }));
      const userMap = new Map(userEntries);

      const pdfData = await renderStructuredPdf(buildRegieReportPdfDocument({
        report: currentReport,
        projectTitle: project?.title ?? 'Unbekannt',
        productsById: productMap,
        usersById: userMap,
      }));

      const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
      const safeSuffix = `${currentReport.autoId}`.replace(/[^\w\-]+/g, '-');
      deliverBlob(blob, uiText(`Regiebericht-${safeSuffix}.pdf`, `Time-and-material report-${safeSuffix}.pdf`), target, pdfWindow);
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      setPdfExportErr((err as Error)?.message || uiText('Unbekannter Fehler beim PDF-Export.'));
    } finally {
      setIsPdfExporting(false);
    }
  }

  return <>
    <MyHeader
      title={uiText(`Regiebericht #${report.autoId}`, `Time-and-material report #${report.autoId}`)}
      actions={<MyDropdown items={[
        {
          label: isPdfExporting ? uiText("PDF wird erstellt...") : uiText("PDF"),
          renderIcon: Icons.Download,
          hideIf: !sessionInfo.canDo('view:regieReports'),
          disabled: isPdfExporting,
          onClick: () => exportRegieReportToPdf(),
        },
        {
          label: uiText("Excel"),
          renderIcon: Icons.Excel,
          hideIf: !sessionInfo.canDo('view:regieReports'),
          onClick: async () => {
            const ExcelJS = await import('exceljs');

            const DECIMAL_NUM_FMT = '#,##0.00';
            const DECIMAL_ZERO_DASH_NUM_FMT = '#,##0.00;-#,##0.00;-';

            type TableMeta = {
              rowCount: number;
              firstDataRow: number;
            };

            const [project] = await client.query('projects.get', { id: report.projectId }, { strategy: 'cache-first' });

            const productIds = [...new Set(report.products.map(record => record.productId))];
            const productEntries = await Promise.all(productIds.map(async productId => {
              const [product] = await client.query('products.get', { id: productId }, { strategy: 'cache-first' });
              return [productId, product ?? null] as const;
            }));
            const productMap = new Map(productEntries);

            const userIds = [...new Set(report.workHours.map(record => record.userId).filter(Boolean))] as string[];
            const userEntries = await Promise.all(userIds.map(async userId => {
              const [user] = await client.query('users.get', { id: userId }, { strategy: 'cache-first' });
              return [userId, user ?? null] as const;
            }));
            const userMap = new Map(userEntries);

            const wb = new ExcelJS.Workbook();
            wb.creator = "exceljs";
            wb.created = new Date();

            const ws = wb.addWorksheet(uiText('Regiebericht'));
            const title = uiText(`Regiebericht #${report.autoId}`, `Time-and-material report #${report.autoId}`);
            const weekStart = startOfIsoWeek(new Date(report.day));
            const weekEnd = dayInIsoWeek(weekStart, WEEKDAY_NAMES.length - 1);
            const subtitle = uiText(`${isoWeekLabel(weekStart)} (${formatDate(weekStart)} bis ${formatDate(weekEnd)}) — ${project?.title ?? 'Unbekannt'}`, `${isoWeekLabel(weekStart)} (${formatDate(weekStart)} to ${formatDate(weekEnd)}) — ${project?.title ?? 'Unbekannt'}`);

            ws.getCell(1, 1).value = title;
            ws.getCell(1, 1).font = { size: 18, bold: true };
            ws.getCell(2, 1).value = subtitle;
            ws.getCell(2, 1).font = { size: 12, italic: true };
            ws.mergeCells(1, 1, 1, 9);
            ws.mergeCells(2, 1, 2, 9);


            let cursor = 4;
            if (report.summary) {
              const summaryTitleRow = 4;
              ws.getCell(summaryTitleRow, 1).value = 'Zusammenfassung';
              ws.getCell(summaryTitleRow, 1).font = { bold: true, size: 14 };

              const height = (report.summary.length / 90) * 15;
              const rowHeight = Math.ceil(height / 3);

              const summaryRow = summaryTitleRow + 1;
              ws.mergeCells(summaryRow, 1, summaryRow + 2, 9);
              ws.getCell(summaryRow, 1).value = report.summary ?? '';
              ws.getCell(summaryRow, 1).alignment = { wrapText: true, vertical: 'top' };
              ws.getRow(summaryRow).height = rowHeight;
              ws.getRow(summaryRow + 1).height = rowHeight;
              ws.getRow(summaryRow + 2).height = rowHeight;

              cursor = summaryRow + 4;
            }

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
                columns: columns.map(name => ({ name })),
                rows,
              });

              const rowCount = rows.length;
              cursor += rows.length + 2;

              return {
                rowCount,
                firstDataRow: startRow + 1,
              };
            };

            const hoursByUser = new Map<string, { name: string; values: number[] }>();
            report.workHours.forEach(record => {
              const dayIndex = weekdayIndexInIsoWeek(new Date(record.day), weekStart);
              if (dayIndex < 0 || dayIndex >= WEEKDAY_NAMES.length) return;

              const key = record.userId ?? '__unknown__';
              const user = record.userId ? userMap.get(record.userId) : null;
              const name = user ? userFullName(user) : 'Unbekannt';
              const current = hoursByUser.get(key) ?? {
                name,
                values: Array.from({ length: WEEKDAY_NAMES.length }, () => 0),
              };

              current.values[dayIndex] += Number(record.hours ?? 0);
              hoursByUser.set(key, current);
            });

            const workHourRows = Array.from(hoursByUser.values())
              .sort((left, right) => left.name.localeCompare(right.name, 'de', { sensitivity: 'base' }))
              .map(row => {
                const total = row.values.reduce((sum, value) => sum + Number(value ?? 0), 0);
                return [row.name, ...row.values, total] as Array<string | number | Date | null>;
              });
            let workHoursTable: TableMeta | null = null;
            if (workHourRows.length) {
              addSectionTitle(uiText('Arbeitszeit je Mitarbeiter und Tag'));
              workHoursTable = addTable(
                ['Mitarbeiter', ...WEEKDAY_SHORT_NAMES, 'Gesamt'],
                workHourRows,
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

            const productRows = report.products.map(record => {
              const product = productMap.get(record.productId);
              const baseQuantity = Number(record.quantity ?? 0);
              const [amount, unit] = product ? upmatchUnit(product, baseQuantity) : [baseQuantity, ''];
              const baseUnit = product?.baseUnit ?? '';
              return [
                product ? productTitle(product) : 'Unbekannt',
                `${formatNumber(amount)}${unit ? ` ${unit}` : ''}`,
                formatBaseQuantity(baseQuantity, baseUnit, unit),
              ] as Array<string | number | Date | null>;
            });
            if (productRows.length) {
              addSectionTitle('Produkte');
              addTable(
                ['Bezeichnung', 'Menge', 'Basismenge'],
                productRows,
              );
            }

            const specialRows = report.specialRecords.map(record => {
              return [
                record.name,
                Number(record.amount ?? 0),
                record.unit,
              ] as Array<string | number | Date | null>;
            });
            let specialTable: TableMeta | null = null;
            if (specialRows.length) {
              addSectionTitle('Sonderposten');
              specialTable = addTable(
                ['Bezeichnung', 'Menge', 'Einheit'],
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

            const bytes = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;

            const blob = new Blob([bytes] as any, {
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });

            const safeSuffix = `${report.autoId}`.replace(/[^\w\-]+/g, '-');
            await openExcelExport(modals, blob, uiText(`Regiebericht-${safeSuffix}.xlsx`, `Time-and-material report-${safeSuffix}.xlsx`));
          },
        },
        {
          label: uiText("Bearbeiten"),
          renderIcon: Icons.Edit,
          hideIf: !sessionInfo.canDo('manage:regieReports'),
          onClick: () => showModifyRegieReportModal(modals, report),
        },
        {
          label: uiText("Löschen"),
          renderIcon: Icons.Delete,
          hideIf: !sessionInfo.canDo('delete:regieReports'),
          onClick: () => showDeleteRegieReportModal(modals, report),
        },
      ]} />}
    />

    {!!pdfExportErr && <MyCallout icon={Icons.Deny} color="red">{uiText("PDF-Export fehlgeschlagen:")} {pdfExportErr}
    </MyCallout>}

    <AttrList>
      <AttrList.Attr name={uiText("Projekt")} value={<Awaited promise={async () => {
        const [project] = await client.query('projects.get', { id: report.projectId }, { strategy: 'cache-first' });
        if (!project) return 'Unbekannt';
        return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
      }} />} />

      {!!report.summary && <AttrList.Attr name="Zusammenfassung" value={report.summary} />}
      <AttrList.Attr name="Kalenderwoche" value={isoWeekLabel(weekStart)} />
      <AttrList.Attr name={uiText("Zeitraum")} value={uiText(`${formatDate(weekStart)} bis ${formatDate(weekEnd)}`, `${formatDate(weekStart)} to ${formatDate(weekEnd)}`)} />
      <AttrList.Attr name={uiText("Erstellt am")} value={formatDate(report.createdAt)} />
      {!!report.createdByUserId && <AttrList.Attr name={uiText("Erstellt von")} value={<Awaited promise={async () => {
        const [user] = await client.query('users.get', { id: report.createdByUserId }, { strategy: 'cache-first' });
        if (!user) return 'Unbekannt';
        return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>
      }} />} />}
    </AttrList>

    <MyDivider />

    {!!report.workHours.length && <MyExpandable title={uiText("Arbeitszeit")}>
      <MyTable
        className="th-25rem"
        rows={report.workHours}
        columns={[
          {
            label: uiText("Tag"),
            render: row => formatDate(row.day),
            sortKey: row => new Date(row.day).getTime(),
          },
          {
            label: uiText("Mitarbeiter"),
            render: async row => {
              if (!row.userId) return 'Unbekannt';
              const [user] = await client.query('users.get', { id: row.userId }, { strategy: 'cache-first' });
              if (!user) return 'Unbekannt';
              return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
            },
          },
          {
            label: uiText("Stunden"),
            render: row => formatNumber(row.hours),
            sortKey: row => row.hours,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!report.products.length && <MyExpandable title={uiText("Produkte")}>
      <MyTable
        className="th-25rem"
        persistentId="Products"
        rows={report.products}
        columns={[
          {
            label: uiText("Bezeichnung"),
            render: async row => {
              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              if (!product) return 'Unbekannt';
              return <MyLink to={`/products/${product.id}`}>{productTitle(product)}</MyLink>;
            },
          },
          {
            label: uiText("Menge"),
            render: async row => {
              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              if (!product) return `${formatNumber(row.quantity)} ???`;
              const [amount, unit] = upmatchUnit(product, row.quantity);
              return `${formatNumber(amount)} ${unit}`;
            },
          },
          {
            label: uiText("Basismenge"),
            render: async row => {
              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              if (!product) return formatNumber(row.quantity);
              const [, unit] = upmatchUnit(product, row.quantity);
              return formatBaseQuantity(Number(row.quantity ?? 0), product.baseUnit ?? '', unit);
            },
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!report.specialRecords.length && <MyExpandable title={uiText("Sonderposten")}>
      <MyTable
        className="th-25rem"
        rows={report.specialRecords}
        columns={[
          {
            label: uiText("Bezeichnung"),
            render: row => row.name,
            sortKey: row => row.name,
          },
          {
            label: uiText("Menge"),
            render: row => `${formatNumber(row.amount)} ${row.unit}`,
            sortKey: row => row.amount,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}
  </>;
}
