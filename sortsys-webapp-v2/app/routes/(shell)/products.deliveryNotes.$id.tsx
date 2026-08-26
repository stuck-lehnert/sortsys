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
import { formatCurrency, formatDate, formatNumber, productTitle, userFullName } from "~/lib/format";
import { MyDivider } from "~/components/MyDivider";
import { useTitle } from "~/hooks/useTitle";
import { MyTable } from "~/components/MyTable";
import { useMemo, useState } from "react";
import { useShortcut } from "~/hooks/useShortcut";
import { MyExpandable } from "~/components/MyExpandable";
import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf, type PdfTableSection } from "~/lib/pdf";
import { showDeleteDeliveryNoteModal, showModifyDeliveryNoteModal } from "~/modals/deliveryNotes";
import { deliverBlob, downloadBlob, type BlobTarget, upmatchUnit } from "~/lib/utils";

function formatProductAmount(amount: number, unit: string) {
  const normalizedUnit = `${unit ?? ''}`.trim();
  return `${formatNumber(amount)}${normalizedUnit ? ` ${normalizedUnit}` : ''}`;
}

function formatBaseQuantity(baseQuantity: number, baseUnit: string, displayUnit: string) {
  const normalizedBaseUnit = `${baseUnit ?? ''}`.trim();
  const normalizedDisplayUnit = `${displayUnit ?? ''}`.trim();
  if (normalizedDisplayUnit === normalizedBaseUnit) return '-';
  return `${formatNumber(baseQuantity)}${normalizedBaseUnit ? ` ${normalizedBaseUnit}` : ''}`;
}

function quantityInUnit(product: any, baseQuantity: number, unit: string | null | undefined): [number, string] {
  if (!unit) return upmatchUnit(product, baseQuantity);
  if (unit === product.baseUnit) return [baseQuantity, unit];
  const factor = product.otherUnits?.[unit];
  if (!factor) return upmatchUnit(product, baseQuantity);
  return [baseQuantity / factor, unit];
}

function deliveryRecordCost(costs: any, recordId: string) {
  if (!costs) return null;
  const costRecord = costs.records.find(({ recordId: id }: any) => id === recordId);
  if (!costRecord || !costRecord.priceRecord) return null;
  return Number(costRecord.quantity * costRecord.priceRecord.price);
}

export default function DeliveryNoteDetailPage() {
  const { id } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();

  const [note, err] = useClientStream(() => client.streamQuery('deliveryNotes.get', { id: id! }), [id]);
  const [costs] = useClientStream(() => client.streamQuery('deliveryNotes.costs.get', { id: id! }), [id]);
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);

  const tableRecords = useMemo(() => {
    return note?.records.map(record => ({ ...record, costs }));
  }, [note, costs]);

  useTitle(() => note ? `Lieferschein #${note.autoId}` : null, [note?.autoId]);

  async function exportDeliveryNoteToPdf(target: BlobTarget = 'open') {
    const currentNote = note;
    if (!currentNote) return;
    const pdfWindow = target === 'open' ? window.open('', '_blank') : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const [project] = await client.query('projects.get', { id: currentNote.projectId }, { strategy: 'cache-first' });

      const productIds = [...new Set(currentNote.records.map((record) => record.productId))];
      const productEntries = await Promise.all(productIds.map(async (productId) => {
        const [product] = await client.query('products.get', { id: productId }, { strategy: 'cache-first' });
        return [productId, product ?? null] as const;
      }));
      const productMap = new Map(productEntries);

      const sortedRecords = [...currentNote.records].sort((left, right) => {
        const leftProduct = productMap.get(left.productId);
        const rightProduct = productMap.get(right.productId);

        const leftLabel = leftProduct ? `${leftProduct.customId} ${productTitle(leftProduct)}` : left.productId;
        const rightLabel = rightProduct ? `${rightProduct.customId} ${productTitle(rightProduct)}` : right.productId;
        return leftLabel.localeCompare(rightLabel, 'de', { sensitivity: 'base' });
      });

      const productRows = sortedRecords.map((record) => {
        const product = productMap.get(record.productId);
        const baseQuantity = Number(record.quantity ?? 0);
        const [amount, unit] = product ? quantityInUnit(product, baseQuantity, record.unit) : [baseQuantity, ''];
        const baseUnit = product?.baseUnit ?? '';
        const costRecord = costs?.records.find((entry) => entry.recordId === record.id);
        const totalCost = costRecord?.priceRecord
          ? Number(costRecord.quantity * costRecord.priceRecord.price)
          : null;
        const avgUnitPrice = baseQuantity > 0 && totalCost != null
          ? `${formatCurrency(totalCost / baseQuantity)}${baseUnit ? `/${baseUnit}` : ''}`
          : '-';

        return [
          product ? `${product.customId} ${productTitle(product)}` : 'Unbekannt',
          formatProductAmount(amount, unit),
          formatBaseQuantity(baseQuantity, baseUnit, unit),
          avgUnitPrice,
          totalCost != null ? formatCurrency(totalCost) : '-',
        ];
      });

      const sortedSpecialRecords = [...currentNote.specialRecords].sort((left, right) => {
        return `${left.name ?? ''}`.localeCompare(`${right.name ?? ''}`, 'de', { sensitivity: 'base' });
      });

      const specialRows = sortedSpecialRecords.map((record) => {
        const totalCost = record.pricePerUnit != null ? Number(record.amount * record.pricePerUnit) : null;
        return [
          record.name,
          `${formatNumber(record.amount)} ${record.unit}`,
          record.pricePerUnit != null ? formatCurrency(record.pricePerUnit) : '-',
          totalCost != null ? formatCurrency(totalCost) : '-',
        ];
      });

      const summaryRows: string[][] = [
        ['Projekt', project?.title ?? 'Unbekannt'],
        ['Datum', formatDate(currentNote.effectiveTimestamp, 'long')],
        ['Nummer', `#${currentNote.autoId}`],
      ];
      if (currentNote.comment) {
        summaryRows.push(['Kommentar', currentNote.comment]);
      }
      if (costs) {
        summaryRows.push(['Gesamtkosten', formatCurrency(costs.totalCost)]);
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

      if (productRows.length > 0) {
        sections.push({
          title: 'Produkte',
          columns: ['Bezeichnung', 'Menge', 'Basismenge', 'mittlerer EP', 'Kosten'],
          rows: productRows,
          align: ['left', 'right', 'right', 'right', 'right'],
          columnWidths: ['1.8fr', '1fr', '1fr', '1fr', '0.9fr'],
        });
      }

      if (specialRows.length > 0) {
        sections.push({
          title: 'Sonderposten',
          columns: ['Bezeichnung', 'Menge', 'Preis pro Einheit', 'Kosten'],
          rows: specialRows,
          align: ['left', 'right', 'right', 'right'],
          columnWidths: ['1.6fr', '1fr', '1fr', '1fr'],
        });
      }

      const pdfData = await renderStructuredPdf({
        title: `Lieferschein #${currentNote.autoId}`,
        reportLabel: 'Lieferschein',
        showReportLabel: false,
        sections,
        emptyMessage: 'Keine Daten zum Lieferschein verfügbar.',
      });

      const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
      deliverBlob(blob, `Lieferschein-${currentNote.autoId}.pdf`, target, pdfWindow);
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      setPdfExportErr((err as Error)?.message || 'Unbekannter Fehler beim PDF-Export.');
    } finally {
      setIsPdfExporting(false);
    }
  }

  useShortcut('Control+e', e => {
    if (!note || !sessionInfo.canDo('manage:deliveryNotes')) return;
    e.preventDefault();
    showModifyDeliveryNoteModal(modals, note);
  });

  useShortcut('Control+p', e => {
    if (!note || !sessionInfo.canDo('view:deliveryNotes')) return;
    e.preventDefault();
    if (isPdfExporting) return;
    void exportDeliveryNoteToPdf('open');
  });

  if (err) return <NotFound reason="resourceNotFound" />
  if (!note) return;

  async function exportDeliveryNoteToExcel() {
    const currentNote = note;
    if (!currentNote) return;

    const ExcelJS = await import('exceljs');

    const CURRENCY_NUM_FMT = '#,##0.00 [$€-407]';
    const DECIMAL_NUM_FMT = '#,##0.00';

    const [project] = await client.query('projects.get', { id: currentNote.projectId }, { strategy: 'cache-first' });

    const productIds = [...new Set(currentNote.records.map(record => record.productId))];
    const productEntries = await Promise.all(productIds.map(async productId => {
      const [product] = await client.query('products.get', { id: productId }, { strategy: 'cache-first' });
      return [productId, product ?? null] as const;
    }));
    const productMap = new Map(productEntries);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'exceljs';
    wb.created = new Date();

    const ws = wb.addWorksheet('Lieferschein');
    ws.getCell(1, 1).value = `Lieferschein #${currentNote.autoId}`;
    ws.getCell(1, 1).font = { size: 18, bold: true };
    ws.getCell(2, 1).value = `${formatDate(currentNote.effectiveTimestamp)} — ${project?.title ?? 'Unbekanntes Projekt'}`;
    ws.getCell(2, 1).font = { size: 12, italic: true };
    ws.mergeCells(1, 1, 1, 6);
    ws.mergeCells(2, 1, 2, 6);

    let cursor = 4;

    if (currentNote.comment) {
      ws.getCell(cursor, 1).value = 'Kommentar';
      ws.getCell(cursor, 1).font = { bold: true, size: 14 };
      cursor += 1;

      ws.mergeCells(cursor, 1, cursor + 1, 6);
      ws.getCell(cursor, 1).value = currentNote.comment;
      ws.getCell(cursor, 1).alignment = { wrapText: true, vertical: 'top' };
      cursor += 3;
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
    ) => {
      if (!rows.length) {
        return null as null | { firstDataRow: number; rowCount: number; };
      }

      const startRow = cursor;
      ws.addTable({
        name: `DeliveryNote_${cursor}_${columns.length}`,
        ref: ws.getCell(cursor, 1).address,
        headerRow: true,
        totalsRow: false,
        style: { theme: 'TableStyleLight1', showRowStripes: true },
        columns: columns.map(name => ({ name })),
        rows,
      });

      const rowCount = rows.length;
      cursor += rowCount + 2;

      return {
        firstDataRow: startRow + 1,
        rowCount,
      };
    };

    const productRows = currentNote.records.map(record => {
      const product = productMap.get(record.productId);
      const baseQuantity = Number(record.quantity ?? 0);
      const [amount, unit] = product ? quantityInUnit(product, baseQuantity, record.unit) : [baseQuantity, ''];
      const costRecord = costs?.records.find(entry => entry.recordId === record.id);
      const totalCost = costRecord?.priceRecord
        ? Number(costRecord.quantity * costRecord.priceRecord.price)
        : null;
      const baseUnit = product?.baseUnit ?? '';
      const avgUnitPrice = baseQuantity > 0 && totalCost != null
        ? totalCost / baseQuantity
        : null;

      return [
        product ? `${product.customId} ${productTitle(product)}` : 'Unbekannt',
        formatProductAmount(amount, unit),
        formatBaseQuantity(baseQuantity, baseUnit, unit),
        avgUnitPrice,
        totalCost,
      ] as Array<string | number | Date | null>;
    });
    let productsTable: { firstDataRow: number; rowCount: number; } | null = null;
    if (productRows.length) {
      addSectionTitle('Produkte');
      productsTable = addTable(
        ['Bezeichnung', 'Menge', 'Basismenge', 'mittlerer EP', 'Kosten'],
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

    const specialRows = currentNote.specialRecords.map(record => {
      const totalCost = record.pricePerUnit != null ? Number(record.amount * record.pricePerUnit) : null;
      return [
        record.name,
        Number(record.amount ?? 0),
        record.unit,
        record.pricePerUnit != null ? Number(record.pricePerUnit) : null,
        totalCost,
      ] as Array<string | number | Date | null>;
    });
    let specialTable: { firstDataRow: number; rowCount: number; } | null = null;
    if (specialRows.length) {
      addSectionTitle('Sonderposten');
      specialTable = addTable(
        ['Bezeichnung', 'Menge', 'Einheit', 'Preis pro Einheit', 'Gesamt'],
        specialRows,
      );
    }
    if (specialTable) {
      for (let i = 0; i < specialTable.rowCount; i++) {
        const row = specialTable.firstDataRow + i;
        ws.getCell(row, 2).numFmt = DECIMAL_NUM_FMT;
        ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;
        ws.getCell(row, 5).numFmt = CURRENCY_NUM_FMT;
      }
    }

    if (costs) {
      addSectionTitle('Gesamt');
      const totalsTable = addTable(
        ['Bereich', 'Kosten'],
        [['Lieferschein gesamt', Number(costs.totalCost ?? 0)]],
      );
      if (totalsTable) {
        ws.getCell(totalsTable.firstDataRow, 2).numFmt = CURRENCY_NUM_FMT;
      }
    }

    ws.columns = [
      { width: 40 },
      { width: 14 },
      { width: 14 },
      { width: 18 },
      { width: 14 },
      { width: 24 },
    ];

    const bytes = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
    const blob = new Blob([bytes] as any, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    downloadBlob(blob, `Lieferschein-${currentNote.autoId}.xlsx`);
  }

  return <>
    <MyHeader
      title={`Lieferschein #${note.autoId}`}
      actions={<MyDropdown items={[
        {
          label: isPdfExporting ? 'PDF wird erstellt...' : 'PDF',
          renderIcon: Icons.Download,
          hideIf: !sessionInfo.canDo('view:deliveryNotes'),
          disabled: isPdfExporting,
          onClick: () => exportDeliveryNoteToPdf(),
        },
        {
          label: 'Excel',
          renderIcon: Icons.Excel,
          hideIf: !sessionInfo.canDo('view:deliveryNotes'),
          onClick: exportDeliveryNoteToExcel,
        },
        {
          label: 'Bearbeiten',
          renderIcon: Icons.Edit,
          hideIf: !sessionInfo.canDo('manage:deliveryNotes'),
          onClick: () => showModifyDeliveryNoteModal(modals, note),
        },
        {
          label: 'Löschen',
          renderIcon: Icons.Delete,
          hideIf: !sessionInfo.canDo('delete:deliveryNotes'),
          onClick: () => showDeleteDeliveryNoteModal(modals, note),
        },
      ]} />}
    />

    {!!pdfExportErr && <MyCallout icon={Icons.Deny} color="red">
      PDF-Export fehlgeschlagen: {pdfExportErr}
    </MyCallout>}

    <AttrList>
      <AttrList.Attr name="Projekt" value={<Awaited promise={async () => {
        const [project] = await client.query('projects.get', { id: note.projectId }, { strategy: 'cache-first' });
        if (!project) return 'Unbekannt';
        return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
      }} />} />

      {!!note.comment && <AttrList.Attr name="Kommentar" value={note.comment} />}
      <AttrList.Attr name="Erstellt am" value={formatDate(note.createdAt)} />
      {!!note.createdByUserId && <AttrList.Attr name="Erstellt von" value={<Awaited promise={async () => {
        const [user] = await client.query('users.get', { id: note.createdByUserId! }, { strategy: 'cache-first' });
        if (!user) return 'Unbekannt';
        return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>
      }} />} />}

      {!!costs && <AttrList.Attr name="Kosten" value={formatCurrency(costs.totalCost)} />}
    </AttrList>

    <MyDivider />

    {!!note.records.length && <MyExpandable title="Produkte" initiallyExpanded>
      <MyTable
        className="th-25rem"
        persistentId="Products"
        rows={tableRecords ?? []}
        columns={[
          {
            label: 'Bezeichnung',
            render: async row => {
              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              if (!product) return 'Unbekannt';
              return <MyLink to={`/products/${product.id}`}>{productTitle(product)}</MyLink>;
            },
          },
          {
            label: 'Menge',
            render: async row => {
              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              if (!product) return `${formatNumber(row.quantity)} ???`;
              const [amount, unit] = quantityInUnit(product, row.quantity, (row as any).unit);
              return formatProductAmount(amount, unit);
            },
          },
          {
            label: 'Basismenge',
            render: async row => {
              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              if (!product) return formatNumber(row.quantity);
              const [, unit] = quantityInUnit(product, row.quantity, (row as any).unit);
              return formatBaseQuantity(Number(row.quantity ?? 0), product.baseUnit ?? '', unit);
            },
          },
          {
            label: 'mittlerer EP',
            render: async row => {
              const recordCost = deliveryRecordCost(row.costs, row.id);
              const baseQuantity = Number(row.quantity ?? 0);
              if (!baseQuantity || typeof recordCost !== 'number') return '-';

              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              return `${formatCurrency(recordCost / baseQuantity)}${product?.baseUnit ? `/${product.baseUnit}` : ''}`;
            },
            sortKey: row => {
              const recordCost = deliveryRecordCost(row.costs, row.id);
              const baseQuantity = Number(row.quantity ?? 0);
              if (!baseQuantity || typeof recordCost !== 'number') return 0;
              return recordCost / baseQuantity;
            },
          },
          {
            label: 'Kosten',
            render: row => {
              const recordCost = deliveryRecordCost(row.costs, row.id);
              if (typeof recordCost !== 'number') return '';
              return formatCurrency(recordCost);
            },
            sortKey: row => {
              const recordCost = deliveryRecordCost(row.costs, row.id);
              return typeof recordCost === 'number' ? recordCost : 0;
            },
          }
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!note.specialRecords?.length && <MyExpandable title="Sonderposten" initiallyExpanded>
      <MyTable
        className="th-25rem"
        rows={note.specialRecords}
        columns={[
          {
            label: 'Bezeichnung',
            render: row => row.name,
            sortKey: row => row.name,
          },
          {
            label: 'Menge',
            render: row => `${formatNumber(row.amount)} ${row.unit}`,
            sortKey: row => row.amount,
          },
          {
            label: 'Preis pro Einheit',
            render: row => row.pricePerUnit != null ? formatCurrency(row.pricePerUnit) : '',
            sortKey: row => row.pricePerUnit ?? 0,
          },
          {
            label: 'Gesamt',
            render: row => row.pricePerUnit != null ? formatCurrency(row.amount * row.pricePerUnit) : '',
            sortKey: row => row.pricePerUnit != null ? row.amount * row.pricePerUnit : 0,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

  </>;
}
