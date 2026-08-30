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
import { formatCurrency, formatDate, formatNumber, formatPercent, gainOrLossColor, productTitle, toolTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf, renderStructuredPdfBatch, type PdfTableSection } from "~/lib/pdf";
import { deliverBlob, endOfDay, startOfDay, type BlobTarget, upmatchUnit } from "~/lib/utils";
import { openExcelExport } from "~/lib/officeExports";
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

  const weekNumber = 1 + Math.round((value.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));

  return {
    weekNumber,
    isoYear,
  };
}

function isoWeekLabel(date: Date) {
  const info = getIsoWeekInfo(date);
  return `KW ${info.weekNumber}/${info.isoYear}`;
}

const MISSING_INVOICE_NOTICE = uiText('Gewinn/Verlust kann nicht berechnet werden, da Rechnungssummen fehlen.');

function hasNumberData(value: number | null | undefined) {
  return Math.abs(Number(value ?? 0)) > 0.000001;
}

function formatCurrencyOrDash(value: number | null | undefined) {
  return hasNumberData(value) ? formatCurrency(Number(value ?? 0)) : '-';
}

function formatGainOrLossPercentage(value: number, invoicesTotal: number) {
  if (!hasNumberData(invoicesTotal)) return null;
  return formatPercent((value / Math.abs(invoicesTotal)) * 100);
}

function formatGainOrLossText(value: number, invoicesTotal: number) {
  const percentage = formatGainOrLossPercentage(value, invoicesTotal);
  return `${percentage ? `(${percentage}) ` : ''}${formatCurrency(value)}`;
}

function GainOrLossText({ value, invoicesTotal }: { value: number; invoicesTotal: number }) {
  return <span style={{ color: gainOrLossColor(value), fontWeight: 700 }}>{formatGainOrLossText(value, invoicesTotal)}</span>;
}

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

export default function ProjectDetailCosts() {
  const { project } = useOutletContext<{ project: Project }>();
  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const canManageProjectFinancialEntries = sessionInfo.canDo('manage:projects');

  const [costs] = useClientStream(() => client.streamQuery('projects.costs.get', { projectId: project.id }), [project.id]);
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);

  useShortcut('Control+p', e => {
    if (!costs) return;
    e.preventDefault();
    if (isPdfExporting) return;
    void exportCostsToPdf('overall', 'open');
  });

  if (!costs) return;

  const offers: ProjectFinancialEntry[] = costs.offers ?? [];
  const invoices: ProjectFinancialEntry[] = costs.invoices ?? [];

  const offersTotal = Number(costs.totalCosts.offers ?? offers.reduce((sum, entry) => sum + (entry.amount ?? 0), 0));
  const invoicesTotal = Number(costs.totalCosts.invoices ?? invoices.reduce((sum, entry) => sum + (entry.amount ?? 0), 0));
  const hasFinancialEntries = offers.length > 0 || invoices.length > 0;
  const hasInvoices = invoices.length > 0;
  const gainOrLoss = invoicesTotal - Number(costs.totalCosts.overall ?? 0);

  const commonCosts = costs.commonCosts;
  const fallbackCommonCostsOverhead = Number(commonCosts.fgk.overheadCost ?? 0)
    + Number(commonCosts.mgk.overheadCost ?? 0)
    + Number(commonCosts.ngk.overheadCost ?? 0);
  const commonCostsOverhead = hasNumberData(commonCosts.overallOverhead)
    ? Number(commonCosts.overallOverhead ?? 0)
    : fallbackCommonCostsOverhead;
  const hasCommonCosts = hasNumberData(commonCostsOverhead);
  const subcontractorWorkHours = costs.subcontractorWorkHours ?? [];
  const regularWorkHours = costs.workHours ?? [];
  const workHoursTotal = Number(costs.totalCosts.workHours ?? 0);
  const subcontractorWorkHoursTotal = Number(costs.totalCosts.subcontractorWorkHours ?? subcontractorWorkHours.reduce((sum, entry) => sum + Number(entry.totalCost ?? 0), 0));

  async function exportCostsToPdf(mode: 'overall' | 'weekly' = 'overall', target: BlobTarget = 'open') {
    if (!costs) return;
    const pdfWindow = target === 'open' ? window.open('', '_blank') : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const toolNameMap = new Map<string, string>();
      const userNameMap = new Map<string, string>();

      const productIds = [...new Set((costs.products ?? []).map((entry) => entry.productId))];
      const toolIds = [...new Set((costs.toolTrackings ?? []).map((entry) => entry.toolId))];
      const userIds = [...new Set([...regularWorkHours, ...subcontractorWorkHours].map((entry) => entry.userId).filter(Boolean))] as string[];

      const [productEntries] = await Promise.all([
        Promise.all(productIds.map(async (id) => {
          const [product] = await client.query('products.get', { id }, { strategy: 'cache-first' });
          return [id, product ?? null] as const;
        })),
        Promise.all(toolIds.map(async (id) => {
          const [tool] = await client.query('tools.get', { id }, { strategy: 'cache-first' });
          toolNameMap.set(id, tool ? `${tool.customId} ${toolTitle(tool)}` : id);
        })),
        Promise.all(userIds.map(async (id) => {
          const [user] = await client.query('users.get', { id }, { strategy: 'cache-first' });
          userNameMap.set(id, user ? userFullName(user) : id);
        })),
      ]);
      const productMap = new Map(productEntries);

      const sections: PdfTableSection[] = [];

      const buildCommonCostsSection = (sourceCommonCosts = commonCosts): PdfTableSection => ({
        title: uiText("Gemeinkosten"),
        columns: ['Kostenart', 'Basis', 'Gemeinkosten'],
        rows: [
          ['LKG', formatCurrencyOrDash(sourceCommonCosts.fgk.baseCost), formatCurrencyOrDash(sourceCommonCosts.fgk.overheadCost)],
          ['MGK', formatCurrencyOrDash(sourceCommonCosts.mgk.baseCost), formatCurrencyOrDash(sourceCommonCosts.mgk.overheadCost)],
          ['NUGK', formatCurrencyOrDash(sourceCommonCosts.ngk.baseCost), formatCurrencyOrDash(sourceCommonCosts.ngk.overheadCost)],
        ],
        align: ['left', 'right', 'right'],
        columnWidths: ['1.2fr', '1fr', '1fr'],
      });

      const buildFinancialEntrySection = (title: string, entries: ProjectFinancialEntry[]): PdfTableSection | null => {
        const rows = [...entries]
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .map((entry) => [
            formatDate(entry.createdAt, 'long'),
            formatCurrencyOrDash(entry.amount),
            entry.comment || '-',
          ]);
        if (!rows.length) return null;

        return {
          title,
          columns: ['Erfasst am', 'Betrag', uiText('Kommentar')],
          rows,
          align: ['left', 'right', 'left'],
          columnWidths: ['1fr', '0.8fr', '2fr'],
        };
      };

      const summaryRows: PdfTableSection['rows'] = [
        ['Gesamtkosten', { value: formatCurrencyOrDash(costs.totalCosts.overall), bold: true }],
      ];
      if (offers.length > 0 || hasNumberData(offersTotal)) {
        const offersAmount = formatCurrencyOrDash(offersTotal);
        const offersSummary = offers.length > 1
          ? uiText(`${offersAmount} (${offers.length} Einträge)`, `${offersAmount} (${offers.length} entries)`)
          : offersAmount;
        summaryRows.push(['Angebotssummen', offersSummary]);
      }
      if (invoices.length > 0 || hasNumberData(invoicesTotal)) {
        summaryRows.push(['Rechnungssummen', formatCurrencyOrDash(invoicesTotal)]);
      }
      if (hasInvoices) {
        const balanceColor = gainOrLossColor(gainOrLoss);
        summaryRows.push([
          'Gewinn/Verlust',
          { value: formatGainOrLossText(gainOrLoss, invoicesTotal), bold: true, color: balanceColor },
        ]);
      }
      sections.push({
        title: uiText("Zusammenfassung"),
        subtitle: !hasInvoices ? MISSING_INVOICE_NOTICE : undefined,
        columns: [uiText('Kennzahl'), uiText('Wert')],
        rows: summaryRows,
        withHeader: false,
        align: ['left', 'right'],
        columnWidths: ['2fr', '1fr'],
      });

      const offerSection = buildFinancialEntrySection('Angebotssummen', offers);
      if (offerSection) sections.push(offerSection);
      const invoiceSection = buildFinancialEntrySection('Rechnungssummen', invoices);
      if (invoiceSection) sections.push(invoiceSection);

      const costAreaRows: string[][] = [];
      if (hasNumberData(costs.totalCosts.products)) costAreaRows.push(['Produkte', formatCurrencyOrDash(costs.totalCosts.products)]);
      if (hasNumberData(costs.totalCosts.specialRecords)) costAreaRows.push(['Sonderposten', formatCurrencyOrDash(costs.totalCosts.specialRecords)]);
      if (hasNumberData(costs.totalCosts.toolTrackings)) costAreaRows.push(['Werkzeuge', formatCurrencyOrDash(costs.totalCosts.toolTrackings)]);
      if (hasNumberData(workHoursTotal)) costAreaRows.push([uiText('Arbeitszeit'), formatCurrencyOrDash(workHoursTotal)]);
      if (hasNumberData(subcontractorWorkHoursTotal)) costAreaRows.push([uiText('Nachunternehmer-Arbeitszeit'), formatCurrencyOrDash(subcontractorWorkHoursTotal)]);
      if (hasNumberData(commonCostsOverhead)) costAreaRows.push(['Gemeinkosten', formatCurrencyOrDash(commonCostsOverhead)]);
      if (costAreaRows.length > 0) {
        sections.push({
          title: uiText("Kostenbereiche"),
          columns: ['Bereich', 'Betrag'],
          rows: costAreaRows,
          withHeader: false,
          align: ['left', 'right'],
          columnWidths: ['2fr', '1fr'],
        });
      }

      if (hasCommonCosts) {
        sections.push(buildCommonCostsSection());
      }

      if (mode === 'weekly') {
        type WeeklyBucket = {
          weekStart: Date;
          weekEnd: Date;
          weekLabel: string;
          products: number;
          specialRecordsCost: number;
          workHours: number;
          subcontractorWorkHours: number;
          toolTrackingsCost: number;
          productTotals: Map<string, { quantityBase: number; totalCost: number; }>;
          deliveryNotes: typeof costs.deliveryNotes;
          specialRecords: typeof costs.specialRecords;
          workHourEntries: typeof costs.workHours;
          subcontractorWorkHourEntries: typeof costs.workHours;
          toolTrackings: typeof costs.toolTrackings;
          offers: ProjectFinancialEntry[];
          invoices: ProjectFinancialEntry[];
          commonCosts?: typeof commonCosts;
        };

        const weeklyBuckets = new Map<string, WeeklyBucket>();

        const ensureWeeklyBucket = (value: Date | null | undefined) => {
          if (!value) return null;
          const weekStart = startOfIsoWeek(value);
          const key = weekStart.toISOString();

          const existing = weeklyBuckets.get(key);
          if (existing) return existing;

          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekEnd.getDate() + 6);

          const bucket: WeeklyBucket = {
            weekStart,
            weekEnd,
            weekLabel: isoWeekLabel(weekStart),
            products: 0,
            specialRecordsCost: 0,
            workHours: 0,
            subcontractorWorkHours: 0,
            toolTrackingsCost: 0,
            productTotals: new Map(),
            deliveryNotes: [],
            specialRecords: [],
            workHourEntries: [],
            subcontractorWorkHourEntries: [],
            toolTrackings: [],
            offers: [],
            invoices: [],
          };

          weeklyBuckets.set(key, bucket);
          return bucket;
        };

        const noteCostEntries = await Promise.all((costs.deliveryNotes ?? []).map(async (note) => {
          const [noteCosts, noteCostsErr] = await client.query('deliveryNotes.costs.get', { id: note.noteId }, { strategy: 'cache-first' });
          if (noteCostsErr) throw noteCostsErr;
          return { note, noteCosts };
        }));

        noteCostEntries.forEach(({ note, noteCosts }) => {
          const bucket = ensureWeeklyBucket(note.effectiveTimestamp);
          if (!bucket) return;

          bucket.deliveryNotes.push(note);

          const records = ((noteCosts as any)?.records ?? []) as Array<any>;
          records.forEach((record) => {
            const productId = `${record?.productId ?? ''}`;
            if (!productId) return;

            const current = bucket.productTotals.get(productId) ?? {
              quantityBase: 0,
              totalCost: 0,
            };

            const quantityBase = Number(record?.quantity ?? 0);
            const totalCost = record?.priceRecord
              ? quantityBase * Number(record.priceRecord.price ?? 0)
              : 0;

            bucket.products += totalCost;
            current.quantityBase += quantityBase;
            current.totalCost += totalCost;

            bucket.productTotals.set(productId, current);
          });
        });

        (costs.specialRecords ?? []).forEach((entry) => {
          const bucket = ensureWeeklyBucket(entry.effectiveTimestamp);
          if (!bucket) return;
          bucket.specialRecords.push(entry);
          bucket.specialRecordsCost += Number(entry.totalCost ?? 0);
        });

        regularWorkHours.forEach((entry) => {
          const bucket = ensureWeeklyBucket(entry.day);
          if (!bucket) return;

          bucket.workHours += Number(entry.totalCost ?? 0);
          bucket.workHourEntries.push(entry);
        });

        subcontractorWorkHours.forEach((entry) => {
          const bucket = ensureWeeklyBucket(entry.day);
          if (!bucket) return;

          bucket.subcontractorWorkHours += Number(entry.totalCost ?? 0);
          bucket.subcontractorWorkHourEntries.push(entry);
        });

        (costs.toolTrackings ?? []).forEach((entry) => {
          const bucket = ensureWeeklyBucket(entry.startedAt);
          if (!bucket) return;
          bucket.toolTrackings.push(entry);
          bucket.toolTrackingsCost += Number(entry.totalCost ?? 0);
        });

        offers.forEach((entry) => {
          const bucket = ensureWeeklyBucket(entry.createdAt);
          if (!bucket) return;
          bucket.offers.push(entry);
        });

        invoices.forEach((entry) => {
          const bucket = ensureWeeklyBucket(entry.createdAt);
          if (!bucket) return;
          bucket.invoices.push(entry);
        });

        const weeklyEntries = Array.from(weeklyBuckets.values())
          .sort((left, right) => left.weekStart.getTime() - right.weekStart.getTime());

        await Promise.all(weeklyEntries.map(async (entry) => {
          const [weekCosts, weekCostsErr] = await client.query('projects.costs.get', {
            projectId: project.id,
            from: entry.weekStart,
            to: endOfDay(entry.weekEnd),
          }, { strategy: 'cache-first' });
          if (weekCostsErr) throw weekCostsErr;
          entry.commonCosts = weekCosts?.commonCosts;
        }));

        if (weeklyEntries.length > 0) {
          sections.push({
            title: uiText("Wochenweise Kosten"),
            columns: ['Woche', 'Produkte', 'Sonderposten', 'Werkzeuge', uiText('Arbeitszeit'), uiText('NU-Arbeitszeit'), 'Gesamt'],
            rows: weeklyEntries.map((entry) => [
              entry.weekLabel,
              formatCurrencyOrDash(entry.products),
              formatCurrencyOrDash(entry.specialRecordsCost),
              formatCurrencyOrDash(entry.toolTrackingsCost),
              formatCurrencyOrDash(entry.workHours),
              formatCurrencyOrDash(entry.subcontractorWorkHours),
              formatCurrencyOrDash(entry.products + entry.specialRecordsCost + entry.workHours + entry.subcontractorWorkHours + entry.toolTrackingsCost),
            ]),
            align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
            columnWidths: ['1.2fr', '0.86fr', '0.86fr', '0.86fr', '0.86fr', '0.86fr', '0.86fr'],
          });
        }

        const weeklyDocuments = weeklyEntries.map((entry) => {
          const weeklySections: PdfTableSection[] = [];

          const weeklyTotal = entry.products + entry.specialRecordsCost + entry.workHours + entry.subcontractorWorkHours + entry.toolTrackingsCost;
          const weeklySummaryRows: PdfTableSection['rows'] = [
            ['Gesamtkosten', { value: formatCurrencyOrDash(weeklyTotal), bold: true }],
            ['Produkte', formatCurrencyOrDash(entry.products)],
            ['Sonderposten', formatCurrencyOrDash(entry.specialRecordsCost)],
            [uiText('Arbeitszeit'), formatCurrencyOrDash(entry.workHours)],
          ];

          if (hasNumberData(entry.subcontractorWorkHours)) {
            weeklySummaryRows.push([uiText('Nachunternehmer-Arbeitszeit'), formatCurrencyOrDash(entry.subcontractorWorkHours)]);
          }

          if (hasNumberData(entry.toolTrackingsCost)) {
            weeklySummaryRows.push(['Werkzeuge', formatCurrencyOrDash(entry.toolTrackingsCost)]);
          }

          weeklySections.push({
            title: uiText("Zusammenfassung"),
            columns: [uiText('Kennzahl'), uiText('Wert')],
            rows: weeklySummaryRows,
            withHeader: false,
            align: ['left', 'right'],
            columnWidths: ['2fr', '1fr'],
          });

          const weeklyOfferSection = buildFinancialEntrySection('Angebotssummen', entry.offers);
          if (weeklyOfferSection) weeklySections.push(weeklyOfferSection);
          const weeklyInvoiceSection = buildFinancialEntrySection('Rechnungssummen', entry.invoices);
          if (weeklyInvoiceSection) weeklySections.push(weeklyInvoiceSection);

          const weeklyCommonCostsOverhead = Number(entry.commonCosts?.overallOverhead ?? 0);
          if (hasNumberData(weeklyCommonCostsOverhead) && entry.commonCosts) {
            weeklySections.push(buildCommonCostsSection(entry.commonCosts));
          }

          const weeklyProductRows = Array.from(entry.productTotals.entries())
            .sort((left, right) => {
              const leftProduct = productMap.get(left[0]);
              const rightProduct = productMap.get(right[0]);

              const leftLabel = leftProduct
                ? `${leftProduct.customId} ${productTitle(leftProduct)}`
                : left[0];
              const rightLabel = rightProduct
                ? `${rightProduct.customId} ${productTitle(rightProduct)}`
                : right[0];

              return leftLabel.localeCompare(rightLabel, 'de', { sensitivity: 'base' });
            })
            .map(([productId, total]) => {
              const product = productMap.get(productId);
              const [amount, unit] = product ? upmatchUnit(product, total.quantityBase) : [total.quantityBase, ''];
              const baseUnit = product?.baseUnit ?? '';
              const inBaseUnits = formatBaseQuantity(total.quantityBase, baseUnit, unit);
              const avgUnitPrice = total.quantityBase > 0 && hasNumberData(total.totalCost)
                ? `${formatCurrency(total.totalCost / total.quantityBase)}${baseUnit ? `/${baseUnit}` : ''}`
                : '-';

              return [
                product ? `${product.customId} ${productTitle(product)}` : productId,
                formatProductAmount(amount, unit),
                inBaseUnits,
                avgUnitPrice,
                formatCurrencyOrDash(total.totalCost),
              ];
            });

          if (weeklyProductRows.length > 0) {
            weeklySections.push({
              title: uiText("Produkte"),
              columns: ['Bezeichnung', 'Menge', 'Basismenge', 'mittlerer EP', uiText('Kosten')],
              rows: weeklyProductRows,
              align: ['left', 'right', 'right', 'right', 'right'],
              columnWidths: ['1.95fr', '0.95fr', '1fr', '1fr', '0.9fr'],
            });
          }

          const weeklySpecialRows = [...(entry.specialRecords ?? [])]
            .sort((left, right) => `${left.name ?? ''}`.localeCompare(`${right.name ?? ''}`, 'de', { sensitivity: 'base' }))
            .map((specialRecord) => [
              specialRecord.name,
              `${formatNumber(specialRecord.amount)} ${specialRecord.unit}`,
              formatCurrencyOrDash(specialRecord.totalCost),
              `#${specialRecord.noteAutoId}`,
            ]);

          if (weeklySpecialRows.length > 0) {
            weeklySections.push({
              title: uiText("Sonderposten"),
              columns: ['Bezeichnung', 'Menge', uiText('Kosten'), uiText('Lieferschein')],
              rows: weeklySpecialRows,
              align: ['left', 'right', 'right', 'right'],
              columnWidths: ['1.9fr', '1fr', '1fr', '0.8fr'],
            });
          }

          const weeklyWorkHourRows = [...(entry.workHourEntries ?? [])]
            .sort((left, right) => left.day.getTime() - right.day.getTime())
            .map((workHourEntry) => [
              formatDate(workHourEntry.day, 'long'),
              workHourEntry.userId ? (userNameMap.get(workHourEntry.userId) ?? workHourEntry.userId) : 'Unbekannt',
              formatNumber(workHourEntry.hours),
              formatCurrencyOrDash(workHourEntry.totalCost),
            ]);

          if (weeklyWorkHourRows.length > 0) {
            weeklySections.push({
              title: uiText("Arbeitszeit"),
              columns: ['Tag', 'Mitarbeiter', uiText('Stunden'), uiText('Kosten')],
              rows: weeklyWorkHourRows,
              align: ['left', 'left', 'right', 'right'],
              columnWidths: ['0.9fr', '1.7fr', '0.7fr', '0.9fr'],
            });
          }

          const weeklySubcontractorWorkHourRows = [...(entry.subcontractorWorkHourEntries ?? [])]
            .sort((left, right) => left.day.getTime() - right.day.getTime())
            .map((workHourEntry) => [
              formatDate(workHourEntry.day, 'long'),
              workHourEntry.userId ? (userNameMap.get(workHourEntry.userId) ?? workHourEntry.userId) : 'Unbekannt',
              formatNumber(workHourEntry.hours),
              formatCurrencyOrDash(workHourEntry.totalCost),
            ]);

          if (weeklySubcontractorWorkHourRows.length > 0) {
            weeklySections.push({
              title: uiText("Nachunternehmer-Arbeitszeit"),
              columns: ['Tag', 'Mitarbeiter', uiText('Stunden'), uiText('Kosten')],
              rows: weeklySubcontractorWorkHourRows,
              align: ['left', 'left', 'right', 'right'],
              columnWidths: ['0.9fr', '1.7fr', '0.7fr', '0.9fr'],
            });
          }

          const weeklyDeliveryRows = [...(entry.deliveryNotes ?? [])]
            .sort((left, right) => {
              const leftTime = left.effectiveTimestamp ? new Date(left.effectiveTimestamp).getTime() : 0;
              const rightTime = right.effectiveTimestamp ? new Date(right.effectiveTimestamp).getTime() : 0;
              return leftTime - rightTime;
            })
            .map((deliveryEntry) => [
              deliveryEntry.effectiveTimestamp ? formatDate(deliveryEntry.effectiveTimestamp, 'long') : '-',
              `#${deliveryEntry.autoId}`,
              formatCurrencyOrDash(deliveryEntry.totalCost),
            ]);

          if (weeklyDeliveryRows.length > 0) {
            weeklySections.push({
              title: uiText("Lieferscheine"),
              columns: [uiText('Datum'), uiText('Nummer'), uiText('Kosten')],
              rows: weeklyDeliveryRows,
              align: ['left', 'left', 'right'],
              columnWidths: ['1.2fr', '1fr', '1fr'],
            });
          }

          const weeklyToolRows = [...(entry.toolTrackings ?? [])]
            .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
            .map((toolTrackingEntry) => {
              const start = startOfDay(toolTrackingEntry.startedAt);
              const end = endOfDay(toolTrackingEntry.endedAt || new Date());
              const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000)));

              return [
                toolNameMap.get(toolTrackingEntry.toolId) ?? toolTrackingEntry.toolId,
                formatDate(toolTrackingEntry.startedAt, 'long'),
                toolTrackingEntry.endedAt ? formatDate(toolTrackingEntry.endedAt, 'long') : 'offen',
                formatNumber(days),
                formatCurrencyOrDash(toolTrackingEntry.totalCost),
              ];
            });

          if (weeklyToolRows.length > 0) {
            weeklySections.push({
              title: uiText("Werkzeuge"),
              columns: [uiText('Werkzeug'), uiText('Von'), uiText('Bis'), 'Tage', uiText('Kosten')],
              rows: weeklyToolRows,
              align: ['left', 'center', 'center', 'right', 'right'],
              columnWidths: ['2fr', '0.9fr', '0.9fr', '0.6fr', '0.9fr'],
            });
          }

          return {
            title: `${project.title} — ${entry.weekLabel}`,
            reportLabel: uiText("Projektkostenbericht Wochenweise"),
            sections: weeklySections,
            emptyMessage: uiText("Keine Kosteninformationen verfügbar."),
          };
        });

        const documents = [
          {
            title: project.title,
            reportLabel: uiText("Projektkostenbericht Wochenweise"),
            sections,
            emptyMessage: uiText("Keine Kosteninformationen verfügbar."),
          },
          ...weeklyDocuments,
        ];

        const pdfData = await renderStructuredPdfBatch({ documents });

        const safeTitle = project.title.replace(/[^\w\-]+/g, '-');
        const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
        deliverBlob(blob, uiText(`Projektkosten-wochenweise-${safeTitle}.pdf`, `Projectkosten-wochenweise-${safeTitle}.pdf`), target, pdfWindow);
        return;
      }

      const sortedProducts = [...(costs.products ?? [])].sort((left, right) => {
        const leftProduct = productMap.get(left.productId);
        const rightProduct = productMap.get(right.productId);

        const leftLabel = leftProduct
          ? `${leftProduct.customId} ${productTitle(leftProduct)}`
          : left.productId;
        const rightLabel = rightProduct
          ? `${rightProduct.customId} ${productTitle(rightProduct)}`
          : right.productId;

        return leftLabel.localeCompare(rightLabel, 'de', { sensitivity: 'base' });
      });

      const productRows = sortedProducts.map((entry) => {
        const product = productMap.get(entry.productId);
        const baseQuantity = Number(entry.quantity ?? 0);
        const [amount, unit] = product ? upmatchUnit(product, baseQuantity) : [baseQuantity, ''];
        const baseUnit = product?.baseUnit ?? '';
        const inBaseUnits = formatBaseQuantity(baseQuantity, baseUnit, unit);
        const avgUnitPrice = baseQuantity > 0 && hasNumberData(entry.totalCost)
          ? `${formatCurrency(Number(entry.totalCost ?? 0) / baseQuantity)}${baseUnit ? `/${baseUnit}` : ''}`
          : '-';
        return [
          product ? `${product.customId} ${productTitle(product)}` : entry.productId,
          formatProductAmount(amount, unit),
          inBaseUnits,
          avgUnitPrice,
          formatCurrencyOrDash(entry.totalCost),
        ];
      });
      if (productRows.length > 0) {
        sections.push({
          title: uiText("Produkte"),
          columns: ['Bezeichnung', 'Menge', 'Basismenge', 'mittlerer EP', uiText('Kosten')],
          rows: productRows,
          align: ['left', 'right', 'right', 'right', 'right'],
          columnWidths: ['1.95fr', '0.95fr', '1fr', '1fr', '0.9fr'],
        });
      }

      const sortedSpecialRecords = [...(costs.specialRecords ?? [])].sort((left, right) => {
        return `${left.name ?? ''}`.localeCompare(`${right.name ?? ''}`, 'de', { sensitivity: 'base' });
      });

      const specialRows = sortedSpecialRecords.map((entry) => [
        entry.name,
        `${formatNumber(entry.amount)} ${entry.unit}`,
        formatCurrencyOrDash(entry.totalCost),
        `#${entry.noteAutoId}`,
      ]);
      if (specialRows.length > 0) {
        sections.push({
          title: uiText("Sonderposten"),
          columns: ['Bezeichnung', 'Menge', uiText('Kosten'), uiText('Lieferschein')],
          rows: specialRows,
          align: ['left', 'right', 'right', 'right'],
          columnWidths: ['1.9fr', '1fr', '1fr', '0.8fr'],
        });
      }

      const sortedToolTrackings = [...(costs.toolTrackings ?? [])]
        .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());

      const toolRows = sortedToolTrackings.map((entry) => {
        const start = startOfDay(entry.startedAt);
        const end = endOfDay(entry.endedAt || new Date());
        const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000)));

        return [
          toolNameMap.get(entry.toolId) ?? entry.toolId,
          formatDate(entry.startedAt, 'long'),
          entry.endedAt ? formatDate(entry.endedAt, 'long') : 'offen',
          formatNumber(days),
          formatCurrencyOrDash(entry.totalCost),
        ];
      });

      const sortedWorkHours = [...regularWorkHours].sort((left, right) => left.day.getTime() - right.day.getTime());

      const workHourRows = sortedWorkHours.map((entry) => [
        formatDate(entry.day, 'long'),
        entry.userId ? (userNameMap.get(entry.userId) ?? entry.userId) : 'Unbekannt',
        formatNumber(entry.hours),
        formatCurrencyOrDash(entry.totalCost),
      ]);
      if (workHourRows.length > 0) {
        sections.push({
          title: uiText("Arbeitszeit"),
          columns: ['Tag', 'Mitarbeiter', uiText('Stunden'), uiText('Kosten')],
          rows: workHourRows,
          align: ['left', 'left', 'right', 'right'],
          columnWidths: ['0.9fr', '1.7fr', '0.7fr', '0.9fr'],
        });
      }

      const sortedSubcontractorWorkHours = [...subcontractorWorkHours].sort((left, right) => left.day.getTime() - right.day.getTime());

      const subcontractorWorkHourRows = sortedSubcontractorWorkHours.map((entry) => [
        formatDate(entry.day, 'long'),
        entry.userId ? (userNameMap.get(entry.userId) ?? entry.userId) : 'Unbekannt',
        formatNumber(entry.hours),
        formatCurrencyOrDash(entry.totalCost),
      ]);
      if (subcontractorWorkHourRows.length > 0) {
        sections.push({
          title: uiText("Nachunternehmer-Arbeitszeit"),
          columns: ['Tag', 'Mitarbeiter', uiText('Stunden'), uiText('Kosten')],
          rows: subcontractorWorkHourRows,
          align: ['left', 'left', 'right', 'right'],
          columnWidths: ['0.9fr', '1.7fr', '0.7fr', '0.9fr'],
        });
      }

      const deliveryRows = (costs.deliveryNotes ?? []).map((entry) => [
        entry.effectiveTimestamp ? formatDate(entry.effectiveTimestamp, 'long') : '-',
        `#${entry.autoId}`,
        formatCurrencyOrDash(entry.totalCost),
      ]);
      if (deliveryRows.length > 0) {
        sections.push({
          title: uiText("Lieferscheine"),
          columns: [uiText('Datum'), uiText('Nummer'), uiText('Kosten')],
          rows: deliveryRows,
          align: ['left', 'left', 'right'],
          columnWidths: ['1.2fr', '1fr', '1fr'],
        });
      }

      if (toolRows.length > 0) {
        sections.push({
          title: uiText("Werkzeuge"),
          columns: [uiText('Werkzeug'), uiText('Von'), uiText('Bis'), 'Tage', uiText('Kosten')],
          rows: toolRows,
          align: ['left', 'center', 'center', 'right', 'right'],
          columnWidths: ['2fr', '0.9fr', '0.9fr', '0.6fr', '0.9fr'],
        });
      }

      const pdfData = await renderStructuredPdf({
        title: project.title,
        reportLabel: uiText("Projektkostenbericht"),
        sections,
        emptyMessage: uiText("Keine Kosteninformationen verfügbar."),
      });

      const safeTitle = project.title.replace(/[^\w\-]+/g, '-');
      const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
      deliverBlob(blob, uiText(`Projektkosten-${safeTitle}.pdf`, `Projectkosten-${safeTitle}.pdf`), target, pdfWindow);
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      setPdfExportErr((err as Error)?.message || uiText('Unbekannter Fehler beim PDF-Export.'));
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
        render: (row: ProjectFinancialEntry) => formatDate(row.createdAt, 'long'),
        sortKey: (row: ProjectFinancialEntry) => row.createdAt.getTime(),
      },
      {
        label: uiText("Betrag"),
        render: (row: ProjectFinancialEntry) => formatCurrency(row.amount),
        sortKey: (row: ProjectFinancialEntry) => row.amount,
      },
      {
        label: uiText("Kommentar"),
        render: (row: ProjectFinancialEntry) => row.comment || '',
        sortKey: (row: ProjectFinancialEntry) => (row.comment || '').toLowerCase(),
      },
    ];

    if (canManageProjectFinancialEntries) {
      columns.push({
        label: uiText("Aktionen"),
        render: (row: ProjectFinancialEntry) => <div className="flex items-center gap-1">
          <MyButton
            size="sm"
            kind="ghost"
            aria-label={uiText("Bearbeiten")}
            title={uiText("Bearbeiten")}
            onClick={() => showModifyProjectFinancialEntryModal(modals, project, row)}
          ><Icons.Edit /></MyButton>

          <MyButton
            size="sm"
            kind="danger--tertiary"
            aria-label={uiText("Löschen")}
            title={uiText("Löschen")}
            onClick={() => showDeleteProjectFinancialEntryModal(modals, project, row)}
          ><Icons.Delete /></MyButton>
        </div>,
      });
    }

    return <MyExpandable title={`${title} (${formatCurrency(total)})`}>
      <MyTable
        className="th-20rem"
        rows={entries}
        columns={columns}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>;
  };

  return <>
    <div className="flex justify-end gap-2">
      <MyButton
        kind="ghost"
        size="sm"
        renderIcon={Icons.Download}
        loading={isPdfExporting}
        onClick={() => exportCostsToPdf('overall')}
      >{uiText("PDF")}</MyButton>

      <MyButton
        kind="ghost"
        size="sm"
        renderIcon={Icons.Download}
        loading={isPdfExporting}
        onClick={() => exportCostsToPdf('weekly')}
      >{uiText("PDF (wochenweise)")}</MyButton>

      <MyButton
        kind="ghost"
        size="sm"
        renderIcon={Icons.Excel}
        onClick={async () => {
            if (!costs) return;

            const ExcelJS = await import('exceljs');

            const CURRENCY_NUM_FMT = '#,##0.00 [$€-407]';
            const DECIMAL_NUM_FMT = '#,##0.00';
            const DATE_NUM_FMT = 'dd.mm.yyyy';
            const PERCENT_NUM_FMT = '0.00%';

            const toColumnName = (column: number) => {
              let name = '';
              let current = column;
              while (current > 0) {
                const remainder = (current - 1) % 26;
                name = String.fromCharCode(65 + remainder) + name;
                current = Math.floor((current - 1) / 26);
              }
              return name;
            };

            const cellRef = (row: number, column: number) => `${toColumnName(column)}${row}`;

            type TableMeta = {
              rowCount: number;
              firstDataRow: number;
              lastDataRow: number;
            };

            const sumFormula = (table: TableMeta | null, column: number) => {
              if (!table || table.rowCount === 0) return '0';
              return `SUM(${cellRef(table.firstDataRow, column)}:${cellRef(table.lastDataRow, column)})`;
            };

            const toNumber = (value: number | null | undefined) => (value == null ? null : Number(value));

            const productIds = [...new Set(costs.products.map(record => record.productId))];
            const productEntries = await Promise.all(productIds.map(async productId => {
              const [product] = await client.query('products.get', { id: productId }, { strategy: 'cache-first' });
              return [productId, product ?? null] as const;
            }));
            const productMap = new Map(productEntries);

            const toolIds = [...new Set(costs.toolTrackings.map(record => record.toolId))];
            const toolEntries = await Promise.all(toolIds.map(async toolId => {
              const [tool] = await client.query('tools.get', { id: toolId }, { strategy: 'cache-first' });
              return [toolId, tool ?? null] as const;
            }));
            const toolMap = new Map(toolEntries);

            const userIds = [...new Set([...regularWorkHours, ...subcontractorWorkHours].map(record => record.userId).filter(Boolean))] as string[];
            const userEntries = await Promise.all(userIds.map(async userId => {
              const [user] = await client.query('users.get', { id: userId }, { strategy: 'cache-first' });
              return [userId, user ?? null] as const;
            }));
            const userMap = new Map(userEntries);

            const wb = new ExcelJS.Workbook();
            wb.creator = "exceljs";
            wb.created = new Date();

            const ws = wb.addWorksheet('Projektkosten');
            ws.getCell(1, 1).value = 'Projektkosten';
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
                columns: columns.map(name => ({ name })),
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

            addSectionTitle('Gesamtkosten');
            const totalsTable = addTable(
              ['Bereich', uiText('Kosten'), 'LKG', 'MGK', 'NUGK', 'Gesamt'],
              [
                ['Produkte', 0, 0, 0, 0, 0],
                ['Sonderposten', 0, 0, 0, 0, 0],
                ['Lieferscheine', 0, 0, 0, 0, 0],
                ['Werkzeuge', 0, 0, 0, 0, 0],
                [uiText('Arbeitszeit'), 0, 0, 0, 0, 0],
                [uiText('Nachunternehmer-Arbeitszeit'), 0, 0, 0, 0, 0],
                ['Gesamt', 0, 0, 0, 0, 0],
              ],
            );

            const sortedProductsForExport = [...costs.products].sort((left, right) => {
              const leftProduct = productMap.get(left.productId);
              const rightProduct = productMap.get(right.productId);

              const leftNumber = `${leftProduct?.customId ?? ''}`.toLowerCase();
              const rightNumber = `${rightProduct?.customId ?? ''}`.toLowerCase();
              const numberDiff = leftNumber.localeCompare(rightNumber, 'de');
              if (numberDiff !== 0) return numberDiff;

              const leftDate = left.priceRecord?.timestamp ? new Date(left.priceRecord.timestamp).getTime() : 0;
              const rightDate = right.priceRecord?.timestamp ? new Date(right.priceRecord.timestamp).getTime() : 0;
              if (leftDate !== rightDate) return leftDate - rightDate;

              const leftTitle = `${leftProduct ? productTitle(leftProduct) : ''}`.toLowerCase();
              const rightTitle = `${rightProduct ? productTitle(rightProduct) : ''}`.toLowerCase();
              return leftTitle.localeCompare(rightTitle, 'de');
            });

            const productRows = sortedProductsForExport.map(record => {
              const product = productMap.get(record.productId);
              const baseQuantity = Number(record.quantity ?? 0);
              const [amount, unit] = product ? upmatchUnit(product, baseQuantity) : [baseQuantity, ''];
              const totalCost = toNumber(record.totalCost);
              const baseUnit = product?.baseUnit ?? '';
              const baseText = formatBaseQuantity(baseQuantity, baseUnit, unit);
              const avgUnitPrice = baseQuantity > 0 && totalCost != null && hasNumberData(totalCost)
                ? totalCost / baseQuantity
                : null;
              return [
                product ? `${product.customId} ${productTitle(product)}` : 'Unbekannt',
                formatProductAmount(amount, unit),
                baseText,
                avgUnitPrice,
                totalCost,
              ] as Array<string | number | Date | null>;
            });
            let productsTable: TableMeta | null = null;
            if (productRows.length) {
              addSectionTitle('Produkte');
              productsTable = addTable(
                ['Bezeichnung', 'Menge', 'Basismenge', 'mittlerer EP', uiText('Kosten')],
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

            const specialRows = costs.specialRecords.map(record => [
              record.name,
              Number(record.amount ?? 0),
              record.unit,
              toNumber(record.pricePerUnit),
              toNumber(record.totalCost),
              `#${record.noteAutoId}`,
            ] as Array<string | number | Date | null>);
            let specialTable: TableMeta | null = null;
            if (specialRows.length) {
              addSectionTitle('Sonderposten');
              specialTable = addTable(
                ['Bezeichnung', 'Menge', 'Einheit', 'pro Einheit', 'Gesamt', uiText('Lieferschein')],
                specialRows,
              );
            }
            if (specialTable) {
              for (let i = 0; i < specialTable.rowCount; i++) {
                const row = specialTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = DECIMAL_NUM_FMT;
                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 5);
                totalCell.value = { formula: `IF(${cellRef(row, 4)}="",0,${cellRef(row, 2)}*${cellRef(row, 4)})` };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const sortedToolTrackingsForExport = [...costs.toolTrackings]
              .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());

            const toolRows = sortedToolTrackingsForExport.map(record => {
              const tool = toolMap.get(record.toolId);

              let start = startOfDay(record.startedAt);
              let end = endOfDay(record.endedAt || new Date());
              const days = Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000));

              return [
                tool ? `${tool.customId} ${toolTitle(tool)}` : 'Unbekannt',
                start,
                record.endedAt ? startOfDay(record.endedAt) : null,
                Number(days),
                toNumber(record.toolUsageCostPerDay),
                toNumber(record.totalCost),
              ] as Array<string | number | Date | null>;
            });
            let toolsTable: TableMeta | null = null;
            if (toolRows.length) {
              addSectionTitle('Werkzeuge');
              toolsTable = addTable(
                [uiText('Werkzeug'), uiText('Von'), uiText('Bis'), 'Tage', 'pro Tag', 'Gesamt'],
                toolRows,
              );
            }
            if (toolsTable) {
              for (let i = 0; i < toolsTable.rowCount; i++) {
                const row = toolsTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = DATE_NUM_FMT;
                ws.getCell(row, 3).numFmt = DATE_NUM_FMT;

                ws.getCell(row, 4).value = {
                  formula: `IF(${cellRef(row, 2)}="",0,MAX(IF(${cellRef(row, 3)}="",TODAY(),${cellRef(row, 3)})-${cellRef(row, 2)}+1,0))`,
                };
                ws.getCell(row, 4).numFmt = '0';

                ws.getCell(row, 5).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 6);
                totalCell.value = { formula: `IF(${cellRef(row, 5)}="",0,${cellRef(row, 4)}*${cellRef(row, 5)})` };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const sortWorkHoursForExport = (records: typeof regularWorkHours) => [...records].sort((left, right) => {
              const leftUser = left.userId ? userMap.get(left.userId) : null;
              const rightUser = right.userId ? userMap.get(right.userId) : null;

              const leftLastName = `${leftUser?.lastName ?? ''}`.toLowerCase();
              const rightLastName = `${rightUser?.lastName ?? ''}`.toLowerCase();
              const lastNameDiff = leftLastName.localeCompare(rightLastName, 'de');
              if (lastNameDiff !== 0) return lastNameDiff;

              const leftFirstName = `${leftUser?.firstName ?? ''}`.toLowerCase();
              const rightFirstName = `${rightUser?.firstName ?? ''}`.toLowerCase();
              const firstNameDiff = leftFirstName.localeCompare(rightFirstName, 'de');
              if (firstNameDiff !== 0) return firstNameDiff;

              return left.day.getTime() - right.day.getTime();
            });

            const workHourRows = sortWorkHoursForExport(regularWorkHours).map(record => {
              const user = record.userId ? userMap.get(record.userId) : null;
              return [
                user ? userFullName(user) : 'Unbekannt',
                record.day ? startOfDay(record.day) : null,
                Number(record.hours ?? 0),
                toNumber(record.costPerHour),
                toNumber(record.totalCost),
              ] as Array<string | number | Date | null>;
            });
            let workHoursTable: TableMeta | null = null;
            if (workHourRows.length) {
              addSectionTitle(uiText('Arbeitszeit'));
              workHoursTable = addTable(
                ['Mitarbeiter', 'Tag', uiText('Stunden'), 'pro Stunde', uiText('Kosten')],
                workHourRows,
              );
            }
            if (workHoursTable) {
              for (let i = 0; i < workHoursTable.rowCount; i++) {
                const row = workHoursTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = DATE_NUM_FMT;
                ws.getCell(row, 3).numFmt = DECIMAL_NUM_FMT;
                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 5);
                totalCell.value = { formula: `IF(${cellRef(row, 4)}="",0,${cellRef(row, 3)}*${cellRef(row, 4)})` };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const subcontractorWorkHourRows = sortWorkHoursForExport(subcontractorWorkHours).map(record => {
              const user = record.userId ? userMap.get(record.userId) : null;
              return [
                user ? userFullName(user) : 'Unbekannt',
                record.day ? startOfDay(record.day) : null,
                Number(record.hours ?? 0),
                toNumber(record.costPerHour),
                toNumber(record.totalCost),
              ] as Array<string | number | Date | null>;
            });
            let subcontractorWorkHoursTable: TableMeta | null = null;
            if (subcontractorWorkHourRows.length) {
              addSectionTitle(uiText('Nachunternehmer-Arbeitszeit'));
              subcontractorWorkHoursTable = addTable(
                ['Mitarbeiter', 'Tag', uiText('Stunden'), 'pro Stunde', uiText('Kosten')],
                subcontractorWorkHourRows,
              );
            }
            if (subcontractorWorkHoursTable) {
              for (let i = 0; i < subcontractorWorkHoursTable.rowCount; i++) {
                const row = subcontractorWorkHoursTable.firstDataRow + i;

                ws.getCell(row, 2).numFmt = DATE_NUM_FMT;
                ws.getCell(row, 3).numFmt = DECIMAL_NUM_FMT;
                ws.getCell(row, 4).numFmt = CURRENCY_NUM_FMT;

                const totalCell = ws.getCell(row, 5);
                totalCell.value = { formula: `IF(${cellRef(row, 4)}="",0,${cellRef(row, 3)}*${cellRef(row, 4)})` };
                totalCell.numFmt = CURRENCY_NUM_FMT;
              }
            }

            const deliveryNoteRows = costs.deliveryNotes.map(record => [
              `#${record.autoId}`,
              toNumber(record.totalCost),
            ] as Array<string | number | Date | null>);
            let deliveryNotesTable: TableMeta | null = null;
            if (deliveryNoteRows.length) {
              addSectionTitle('Lieferscheine');
              deliveryNotesTable = addTable(
                [uiText('Lieferschein'), uiText('Kosten')],
                deliveryNoteRows,
              );
            }
            if (deliveryNotesTable) {
              for (let i = 0; i < deliveryNotesTable.rowCount; i++) {
                ws.getCell(deliveryNotesTable.firstDataRow + i, 2).numFmt = CURRENCY_NUM_FMT;
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

              const fgkOverheadLiteral = Number(commonCosts.fgk.overheadCost ?? 0);
              const mgkOverheadLiteral = Number(commonCosts.mgk.overheadCost ?? 0);
              const ngkOverheadLiteral = Number(commonCosts.ngk.overheadCost ?? 0);

              ws.getCell(productsRow, 2).value = { formula: sumFormula(productsTable, 5) };
              ws.getCell(productsRow, 3).value = { formula: '0' };
              ws.getCell(productsRow, 4).value = { formula: '0' };
              ws.getCell(productsRow, 5).value = { formula: '0' };
              ws.getCell(productsRow, 6).value = {
                formula: `${cellRef(productsRow, 2)}+${cellRef(productsRow, 3)}+${cellRef(productsRow, 4)}+${cellRef(productsRow, 5)}`,
              };

              ws.getCell(specialRow, 2).value = { formula: sumFormula(specialTable, 5) };
              ws.getCell(specialRow, 3).value = { formula: '0' };
              ws.getCell(specialRow, 4).value = { formula: '0' };
              ws.getCell(specialRow, 5).value = { formula: '0' };
              ws.getCell(specialRow, 6).value = {
                formula: `${cellRef(specialRow, 2)}+${cellRef(specialRow, 3)}+${cellRef(specialRow, 4)}+${cellRef(specialRow, 5)}`,
              };

              ws.getCell(deliveryRow, 2).value = { formula: sumFormula(deliveryNotesTable, 2) };
              ws.getCell(deliveryRow, 3).value = { formula: '0' };
              ws.getCell(deliveryRow, 4).value = { formula: `${mgkOverheadLiteral}` };
              ws.getCell(deliveryRow, 5).value = { formula: '0' };
              ws.getCell(deliveryRow, 6).value = {
                formula: `${cellRef(deliveryRow, 2)}+${cellRef(deliveryRow, 3)}+${cellRef(deliveryRow, 4)}+${cellRef(deliveryRow, 5)}`,
              };

              ws.getCell(toolsRow, 2).value = { formula: sumFormula(toolsTable, 6) };
              ws.getCell(toolsRow, 3).value = { formula: '0' };
              ws.getCell(toolsRow, 4).value = { formula: '0' };
              ws.getCell(toolsRow, 5).value = { formula: '0' };
              ws.getCell(toolsRow, 6).value = {
                formula: `${cellRef(toolsRow, 2)}+${cellRef(toolsRow, 3)}+${cellRef(toolsRow, 4)}+${cellRef(toolsRow, 5)}`,
              };

              ws.getCell(workHoursRow, 2).value = { formula: sumFormula(workHoursTable, 5) };
              ws.getCell(workHoursRow, 3).value = { formula: `${fgkOverheadLiteral}` };
              ws.getCell(workHoursRow, 4).value = { formula: '0' };
              ws.getCell(workHoursRow, 5).value = { formula: '0' };
              ws.getCell(workHoursRow, 6).value = {
                formula: `${cellRef(workHoursRow, 2)}+${cellRef(workHoursRow, 3)}+${cellRef(workHoursRow, 4)}+${cellRef(workHoursRow, 5)}`,
              };

              ws.getCell(subcontractorWorkHoursRow, 2).value = { formula: sumFormula(subcontractorWorkHoursTable, 5) };
              ws.getCell(subcontractorWorkHoursRow, 3).value = { formula: '0' };
              ws.getCell(subcontractorWorkHoursRow, 4).value = { formula: '0' };
              ws.getCell(subcontractorWorkHoursRow, 5).value = { formula: `${ngkOverheadLiteral}` };
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
              addSectionTitle('Deckung');
              const diff = Number(invoicesTotal ?? 0) - Number(costs.totalCosts.overall ?? 0);
              const balanceRows: Array<Array<string | number | Date | null>> = [[
                'Gewinn/Verlust',
                diff,
                hasNumberData(invoicesTotal) ? diff / Math.abs(invoicesTotal) : null,
              ]];
              const balanceTable = addTable(['Bereich', 'Betrag (absolut)', 'Relativ'], balanceRows);
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
              addSectionTitle('Hinweis');
              const row = cursor;
              ws.mergeCells(row, 1, row, 6);
              ws.getCell(row, 1).value = MISSING_INVOICE_NOTICE;
              ws.getCell(row, 1).font = { color: { argb: 'FF6B7280' }, italic: true };
              ws.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' };
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

            const bytes = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
            const blob = new Blob([bytes] as any, {
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });
            const safeTitle = project.title.replace(/[^\w\-]+/g, '-');
            await openExcelExport(modals, blob, uiText(`Projektkosten-${safeTitle}.xlsx`, `Project-costs-${safeTitle}.xlsx`));
        }}
      >{uiText("Excel")}</MyButton>
    </div>

    {!!pdfExportErr && <MyCallout icon={Icons.Deny} color="red">{uiText("PDF-Export fehlgeschlagen:")} {pdfExportErr}
    </MyCallout>}

    <AttrList>
      <AttrList.Attr name="Gesamtkosten" value={formatCurrency(costs.totalCosts.overall)} />
      <AttrList.Attr
        name="Angebotssummen"
        value={formatCurrency(offersTotal)}
        third={uiText(`${offers.length} ${offers.length === 1 ? 'Eintrag' : 'Einträge'}`, `${offers.length} ${offers.length === 1 ? 'entry' : 'entries'}`)}
      />
      <AttrList.Attr
        name="Rechnungssummen"
        value={formatCurrency(invoicesTotal)}
        third={uiText(`${invoices.length} ${invoices.length === 1 ? 'Eintrag' : 'Einträge'}`, `${invoices.length} ${invoices.length === 1 ? 'entry' : 'entries'}`)}
      />
      {hasInvoices && <AttrList.Attr
        name="Gewinn/Verlust"
        value={<GainOrLossText value={gainOrLoss} invoicesTotal={invoicesTotal} />}
      />}
      {!hasInvoices && <AttrList.Attr
        name="Hinweis"
        value={MISSING_INVOICE_NOTICE}
      />}
    </AttrList>

    {hasCommonCosts && <MyExpandable title={`Gemeinkosten (${formatCurrency(commonCostsOverhead)})`}>
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
    </MyExpandable>}

    {!!costs.products?.length && <MyExpandable title={`Produkte (${formatCurrency(costs.totalCosts.products)})`}>
      <MyTable
        className="th-25rem"
        rows={costs.products.map(p => ({ ...p, id: p.productId }))}
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
              return formatProductAmount(amount, unit);
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
          {
            label: uiText("mittlerer EP"),
            render: async row => {
              const [product] = await client.query('products.get', { id: row.productId }, { strategy: 'cache-first' });
              const quantity = Number(row.quantity ?? 0);
              if (!product || quantity <= 0 || !hasNumberData(row.totalCost)) return '-';
              return `${formatCurrency(Number(row.totalCost ?? 0) / quantity)}/${product.baseUnit}`;
            },
          },
          {
            label: uiText("Kosten"),
            render: row => !!row.totalCost && formatCurrency(row.totalCost),
            sortKey: row => row.totalCost,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!costs.specialRecords?.length && <MyExpandable title={`Sonderposten (${formatCurrency(costs.totalCosts.specialRecords)})`}>
      <MyTable
        className="th-25rem"
        rows={costs.specialRecords}
        columns={[
          {
            label: uiText("Bezeichnung"),
            render: row => row.name,
            sortKey: row => row.name.toLowerCase(),
          },
          {
            label: uiText("Menge"),
            render: row => `${formatNumber(row.amount)} ${row.unit}`,
          },
          {
            label: uiText("Preis pro Einheit"),
            render: row => !!row.pricePerUnit && formatCurrency(row.pricePerUnit),
            sortKey: row => row.pricePerUnit ?? 0,
          },
          {
            label: uiText("Kosten"),
            render: row => !!row.totalCost && formatCurrency(row.totalCost),
            sortKey: row => row.totalCost,
          },
          {
            label: uiText("Lieferschein"),
            render: row => <MyLink to={`/products/deliveryNotes/${row.noteId}`}>{`#${row.noteAutoId}`}</MyLink>,
            sortKey: row => row.noteAutoId,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!costs.toolTrackings?.length && <MyExpandable title={`Werkzeuge (${formatCurrency(costs.totalCosts.toolTrackings)})`}>
      <MyTable
        className="th-25rem"
        rows={costs.toolTrackings}
        columns={[
          {
            label: uiText("Werkzeug"),
            render: async row => {
              const [tool] = await client.query('tools.get', { id: row.toolId }, { strategy: 'cache-first' });
              if (!tool) return 'Unbekannt';
              return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
            },
          },
          {
            label: uiText("Von"),
            render: row => formatDate(row.startedAt),
            sortKey: row => row.startedAt.getTime(),
          },
          {
            label: uiText("Bis"),
            render: row => row.endedAt ? formatDate(row.endedAt) : 'offen',
            sortKey: row => (row.endedAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
          },
          {
            label: uiText("Tage"),
            render: row => {
              let start = startOfDay(row.startedAt);
              let end = endOfDay(row.endedAt || new Date());
              const days = Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000));
              return days.toString();
            },
            sortKey: row => {
              let start = startOfDay(row.startedAt);
              let end = endOfDay(row.endedAt || new Date());
              return Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000));
            },
          },
          // {
          //   label: 'Kosten pro Tag',
          //   render: row => formatCurrency(row.toolUsageCostPerDay!),
          //   sortKey: row => row.toolUsageCostPerDay!,
          // },
          {
            label: uiText("Kosten"),
            render: row => !!row.totalCost && formatCurrency(row.totalCost),
            sortKey: row => row.totalCost,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!regularWorkHours.length && <MyExpandable title={uiText(`Arbeitszeit (${formatCurrency(workHoursTotal)})`, `Working time (${formatCurrency(workHoursTotal)})`)}>
      <MyTable
        className="th-25rem"
        rows={regularWorkHours}
        columns={[
          {
            label: uiText("Benutzer"),
            render: async row => {
              if (!row.userId) return 'Unbekannt';
              const [user] = await client.query('users.get', { id: row.userId }, { strategy: 'cache-first' });
              if (!user) return 'Unbekannt';
              return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
            },
          },
          {
            label: uiText("Tag"),
            render: row => formatDate(row.day),
            sortKey: row => row.day.getTime(),
          },
          {
            label: uiText("Stunden"),
            render: row => formatNumber(row.hours),
            sortKey: row => row.hours,
          },
          {
            label: uiText("Kosten"),
            render: row => !!row.totalCost && formatCurrency(row.totalCost),
            sortKey: row => row.totalCost,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!subcontractorWorkHours.length && <MyExpandable title={uiText(`Nachunternehmer-Arbeitszeit (${formatCurrency(subcontractorWorkHoursTotal)})`, `Subcontractor work (${formatCurrency(subcontractorWorkHoursTotal)})`)}>
      <MyTable
        className="th-25rem"
        rows={subcontractorWorkHours}
        columns={[
          {
            label: uiText("Benutzer"),
            render: async row => {
              if (!row.userId) return 'Unbekannt';
              const [user] = await client.query('users.get', { id: row.userId }, { strategy: 'cache-first' });
              if (!user) return 'Unbekannt';
              return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
            },
          },
          {
            label: uiText("Tag"),
            render: row => formatDate(row.day),
            sortKey: row => row.day.getTime(),
          },
          {
            label: uiText("Stunden"),
            render: row => formatNumber(row.hours),
            sortKey: row => row.hours,
          },
          {
            label: uiText("Kosten"),
            render: row => !!row.totalCost && formatCurrency(row.totalCost),
            sortKey: row => row.totalCost,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {!!costs.deliveryNotes?.length && <MyExpandable title={`Lieferscheine`}>
      <MyTable
        className="th-25rem"
        rows={costs.deliveryNotes.map(e => ({ ...e, id: e.noteId }))}
        columns={[
          {
            label: uiText("Produkt"),
            render: row => <MyLink to={`/products/deliveryNotes/${row.id}`}>{uiText(`Lieferschein #${row.autoId}`, `Delivery note #${row.autoId}`)}</MyLink>,
          },
          {
            label: uiText("Kosten"),
            render: row => !!row.totalCost && formatCurrency(row.totalCost),
            sortKey: row => row.totalCost,
          },
        ]}
        pagination={{}}
        autoConvertSmallViewport
      />
    </MyExpandable>}

    {hasFinancialEntries && <div style={{ height: '1.5rem' }} />}

    {!!offers.length && renderFinancialEntriesExpandable('Angebotssummen', offersTotal, offers)}
    {!!invoices.length && renderFinancialEntriesExpandable('Rechnungssummen', invoicesTotal, invoices)}
  </>;
}
