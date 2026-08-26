import { OperationalTag } from "@sortsys/react-components";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyExpandable } from "~/components/MyExpandable";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { MyLink } from "~/components/MyLink";
import { MyTable } from "~/components/MyTable";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useMyModals } from "~/hooks/useMyModals";
import { useShortcut } from "~/hooks/useShortcut";
import { useIntUrlParam } from "~/hooks/useUrlParam";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf, type PdfTableSection } from "~/lib/pdf";
import { SmallTile } from "~/lib/tiles";
import { deliverBlob, downloadBlob, type BlobTarget } from "~/lib/utils";
import { exportToExcel } from "~/lib/xlsx";
import type { Route } from "./+types";

const DEFAULT_INVENTORY_DAYS = 30;

function positiveWholeDays(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inventoryDaysStorageKey(userId: string) {
  if (typeof window !== 'object') return `sortsys.inventory.days:default:${userId}`;

  const tenant = window.localStorage.getItem('sortsys.tenant')?.trim() || 'default';
  return `sortsys.inventory.days:${tenant}:${userId}`;
}

function readInventoryDays(storageKey: string) {
  if (typeof window !== 'object') return DEFAULT_INVENTORY_DAYS;

  try {
    return positiveWholeDays(window.localStorage.getItem(storageKey)) ?? DEFAULT_INVENTORY_DAYS;
  } catch {
    return DEFAULT_INVENTORY_DAYS;
  }
}

function persistInventoryDays(storageKey: string, days: number) {
  if (typeof window !== 'object') return;

  try {
    window.localStorage.setItem(storageKey, `${days}`);
  } catch {
    // A blocked browser store must not make the inventory overview unusable.
  }
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Inventur" },
  ];
}

export default function InventoryOverviewPage() {
  const navigate = useNavigate();
  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const inventoryDaysKey = inventoryDaysStorageKey(sessionInfo.user.id);
  const [persistedDays, setPersistedDays] = useState(DEFAULT_INVENTORY_DAYS);

  useEffect(() => {
    setPersistedDays(readInventoryDays(inventoryDaysKey));
  }, [inventoryDaysKey]);
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [pdfExportErr, setPdfExportErr] = useState<string | null>(null);

  const [daysParam, setDaysParam] = useIntUrlParam('days');
  const days = positiveWholeDays(daysParam) ?? persistedDays;

  const [inventoriedTools] = useClientStream(() => client.streamQuery('tools.inventories.overview', {
    days,
    hadInventory: true,
  }), [days]);

  const [missingTools] = useClientStream(() => client.streamQuery('tools.inventories.overview', {
    days,
    hadInventory: false,
  }), [days]);

  function showDaysFilterModal() {
    modals.showForm({
      content: ({ context }) => <>
        <MyForm.Input
          required
          name="days"
          labelText="Zeitraum in Tagen"
          type="number"
          rules={[MyForm.Input.rules.posnum]}
        />
        <p className="light">Es wird geprüft, ob innerhalb dieses Zeitraums eine Inventur erfasst wurde.</p>

        <NotifyLoaded onLoad={() => {
          context.setValues({ days });
        }} />
      </>,
      onSubmit: ({ context, hide }) => {
        const values = context.getValues();
        const nextDays = positiveWholeDays(values.days) ?? DEFAULT_INVENTORY_DAYS;

        setPersistedDays(nextDays);
        persistInventoryDays(inventoryDaysKey, nextDays);
        setDaysParam(nextDays);
        hide();
      },
      modalProps: () => ({
        noFullscreen: true,
        modalHeading: 'Inventurzeitraum setzen',
        primaryButtonText: 'Anwenden',
      }),
    });
  }

  async function exportInventoryOverviewToExcel() {
    const rows = [
      ...(inventoriedTools ?? []).map((tool: any) => [
        'Inventiert',
        tool.customId,
        inventoryToolTitle(tool),
        inventoryLastResponsibleLabel(tool),
        inventoryStatusLabel(tool),
        tool.lastInventoryAt ? formatDate(tool.lastInventoryAt, 'long') : '—',
      ]),
      ...(missingTools ?? []).map((tool: any) => [
        `Keine Inventur (${days} Tage)`,
        tool.customId,
        inventoryToolTitle(tool),
        inventoryLastResponsibleLabel(tool),
        inventoryStatusLabel(tool),
        tool.lastInventoryAt ? formatDate(tool.lastInventoryAt, 'long') : '—',
      ]),
    ];

    const bytes = await exportToExcel({
      sheetName: 'Inventurübersicht',
      columns: ['Bereich', 'Nummer', 'Werkzeug', 'Letzter Verantwortlicher', 'Status', 'Letzte Inventur'],
      rows,
    });

    const blob = new Blob([bytes] as any, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    downloadBlob(blob, `Inventuruebersicht-${days}Tage.xlsx`);
  }

  async function exportInventoryOverviewToPdf(target: BlobTarget = 'open') {
    const pdfWindow = target === 'open' ? window.open('', '_blank') : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      const sortedInventoriedTools = [...(inventoriedTools ?? [])].sort((left: any, right: any) => {
        const leftId = `${left.customId ?? ''}`;
        const rightId = `${right.customId ?? ''}`;
        const byId = leftId.localeCompare(rightId, 'de', { numeric: true, sensitivity: 'base' });
        if (byId !== 0) return byId;

        return inventoryToolTitle(left).localeCompare(inventoryToolTitle(right), 'de', { sensitivity: 'base' });
      });

      const sortedMissingTools = [...(missingTools ?? [])].sort((left: any, right: any) => {
        const leftId = `${left.customId ?? ''}`;
        const rightId = `${right.customId ?? ''}`;
        const byId = leftId.localeCompare(rightId, 'de', { numeric: true, sensitivity: 'base' });
        if (byId !== 0) return byId;

        return inventoryToolTitle(left).localeCompare(inventoryToolTitle(right), 'de', { sensitivity: 'base' });
      });

      const toToolRow = (tool: any) => [
        tool.customId,
        inventoryToolTitle(tool),
        inventoryLastResponsibleLabel(tool),
        inventoryStatusLabel(tool),
        tool.lastInventoryAt ? formatDate(tool.lastInventoryAt, 'long') : '—',
      ];

      const sections: PdfTableSection[] = [
        {
          title: 'Zusammenfassung',
          columns: ['Kennzahl', 'Wert'],
          rows: [
            ['Zeitraum', `${days} Tage`],
            ['Inventiert', `${sortedInventoriedTools.length}`],
            ['Keine Inventur', `${sortedMissingTools.length}`],
          ],
          withHeader: false,
          align: ['left', 'right'],
          columnWidths: ['2fr', '1fr'],
        },
      ];

      if (sortedInventoriedTools.length > 0) {
        sections.push({
          title: `Inventiert in den letzten ${days} Tagen`,
          columns: ['Nummer', 'Werkzeug', 'Letzter Verantwortlicher', 'Status', 'Letzte Inventur'],
          rows: sortedInventoriedTools.map(toToolRow),
          align: ['left', 'left', 'left', 'left', 'left'],
          columnWidths: ['0.8fr', '2fr', '1.5fr', '0.8fr', '1fr'],
        });
      }

      if (sortedMissingTools.length > 0) {
        sections.push({
          title: `Keine Inventur in den letzten ${days} Tagen`,
          columns: ['Nummer', 'Werkzeug', 'Letzter Verantwortlicher', 'Status', 'Letzte Inventur'],
          rows: sortedMissingTools.map(toToolRow),
          align: ['left', 'left', 'left', 'left', 'left'],
          columnWidths: ['0.8fr', '2fr', '1.5fr', '0.8fr', '1fr'],
        });
      }

      const pdfData = await renderStructuredPdf({
        title: `Inventur (${days} Tage)`,
        reportLabel: 'Inventurübersicht',
        sections,
        emptyMessage: 'Keine Inventurdaten verfügbar.',
      });

      const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
      deliverBlob(blob, `Inventuruebersicht-${days}Tage.pdf`, target, pdfWindow);
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      setPdfExportErr((err as Error)?.message || 'Unbekannter Fehler beim PDF-Export.');
    } finally {
      setIsPdfExporting(false);
    }
  }

  useShortcut('Control+p', e => {
    e.preventDefault();
    if (isPdfExporting) return;
    void exportInventoryOverviewToPdf('open');
  });

  const columns = [
    {
      label: 'Nummer',
      render: (row: any) => row.customId,
      sortKey: (row: any) => row.customId,
    },
    {
      label: 'Werkzeug',
      render: (row: any) => <MyLink to={`/tools/${row.id}`}>{inventoryToolTitle(row)}</MyLink>,
      sortKey: (row: any) => inventoryToolTitle(row).toLowerCase(),
    },
    {
      label: 'Letzter Verantwortlicher',
      render: (row: any) => {
        const label = inventoryLastResponsibleLabel(row);
        if (!row.lastResponsibleUserId) return label;
        return <MyLink to={`/users/${row.lastResponsibleUserId}`}>{label}</MyLink>;
      },
      sortKey: (row: any) => inventoryLastResponsibleLabel(row).toLowerCase(),
    },
    {
      label: 'Status',
      render: (row: any) => inventoryStatusLabel(row),
      sortKey: (row: any) => inventoryStatusLabel(row),
    },
    {
      label: 'Letzte Inventur',
      render: (row: any) => row.lastInventoryAt ? formatDate(row.lastInventoryAt, 'long') : '—',
      sortKey: (row: any) => row.lastInventoryAt ? row.lastInventoryAt.getTime() : 0,
    },
  ] as const;

  return <>
    <MyHeader
      title="Inventur"
      subtitle="Werkzeuge mit und ohne Inventur im gewählten Zeitraum"
    />

    <div className="flex gap-2 w-full overflow-x-auto">
      <OperationalTag
        renderIcon={Icons.Filter}
        text={`Zeitraum: ${days} Tage`}
        onClick={showDaysFilterModal}
      />
      <MyButton kind="ghost" size="sm" renderIcon={Icons.Download} loading={isPdfExporting} onClick={() => exportInventoryOverviewToPdf()}>PDF</MyButton>
      <MyButton kind="ghost" size="sm" renderIcon={Icons.Excel} onClick={exportInventoryOverviewToExcel}>Excel</MyButton>
    </div>

    {!!pdfExportErr && <MyCallout icon={Icons.Deny} color="red">
      PDF-Export fehlgeschlagen: {pdfExportErr}
    </MyCallout>}

    <div style={{ height: '1px' }} />

    <MyExpandable title={`Inventiert in den letzten ${days} Tagen (${inventoriedTools?.length ?? 0})`} initiallyExpanded>
      <MyTable
        topPagination
        persistentId="InventoriesRecent"
        rows={inventoriedTools ?? []}
        onRowClick={row => navigate(`/tools/${row.id}`)}
        columns={columns as any}
        pagination={{}}
        renderSmallViewport={row => <SmallTile
          icon={Icons.Tool}
          title={`${row.customId} ${inventoryToolTitle(row)}`}
          subtitle={row.lastInventoryAt ? `Letzte Inventur: ${formatDate(row.lastInventoryAt)}` : undefined}
          href={`/tools/${row.id}`}
        />}
      />
    </MyExpandable>

    <MyExpandable title={`Keine Inventur in den letzten ${days} Tagen (${missingTools?.length ?? 0})`}>
      <MyTable
        topPagination
        persistentId="InventoriesMissing"
        rows={missingTools ?? []}
        onRowClick={row => navigate(`/tools/${row.id}`)}
        columns={columns as any}
        pagination={{}}
        renderSmallViewport={row => <SmallTile
          icon={Icons.Tool}
          title={`${row.customId} ${inventoryToolTitle(row)}`}
          subtitle={row.lastInventoryAt ? `Letzte Inventur: ${formatDate(row.lastInventoryAt)}` : 'Noch nie inventiert'}
          href={`/tools/${row.id}`}
        />}
      />
    </MyExpandable>
  </>;
}

function inventoryToolTitle(tool: { brand: string; category: string; label: string | null; }) {
  return [tool.brand, tool.category, tool.label].filter(Boolean).join(' ');
}

function inventoryLastResponsibleLabel(tool: {
  lastResponsibleFirstName: string | null;
  lastResponsibleLastName: string | null;
}) {
  const name = [tool.lastResponsibleFirstName, tool.lastResponsibleLastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  return name || '—';
}

function inventoryStatusLabel(tool: {
  status: 'lost' | 'broken' | null;
  available: boolean;
}) {
  if (tool.status === 'lost') return 'abhanden';
  if (tool.status === 'broken') return 'defekt';
  return tool.available ? 'verfügbar' : 'gebucht';
}
