import { uiText } from "~/lib/i18n";
import { OperationalTag } from "@sortsys/react-components";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyExpandable } from "~/components/MyExpandable";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { MyLink } from "~/components/MyLink";
import { MyTable, type MyTableColumn } from "~/components/MyTable";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { usePersonnelNames } from "~/hooks/usePersonnelNames";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useMyModals } from "~/hooks/useMyModals";
import { useShortcut } from "~/hooks/useShortcut";
import { useIntUrlParam } from "~/hooks/useUrlParam";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf, type PdfTableSection } from "~/lib/pdf";
import { SmallTile } from "~/lib/tiles";
import { deliverBlob, type BlobTarget } from "~/lib/utils";
import { prepareExcelExport } from "~/lib/officeExports";
import { createTableWorkbook } from "~/lib/xlsx";
import type { QueryResult } from "@sortsys/v2-client";
import type { Route } from "./+types";

type InventoryTool = QueryResult<"tools.inventories.overview">[number];

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
    { title: uiText("Inventur") },
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

  const [inventoriedTools, inventoriedToolsError] = useClientStream(() => client.streamQuery('tools.inventories.overview', {
    days,
    hadInventory: true,
  }), [days]);

  const [missingTools, missingToolsError] = useClientStream(() => client.streamQuery('tools.inventories.overview', {
    days,
    hadInventory: false,
  }), [days]);

  function canReadResponsible(id: string) {
    return sessionInfo.canAccess(`personnel:${id}`, "master-data", "read");
  }

  const responsibleIds = [...(inventoriedTools ?? []), ...(missingTools ?? [])]
    .flatMap(({ lastResponsibleUserId: id }) =>
      id && canReadResponsible(id) ? [id] : [],
    );
  const { names, pending: namesPending, context } = usePersonnelNames(client, responsibleIds);
  const canExport = !!inventoriedTools && !!missingTools && !namesPending;

  function responsibleName(id: string | null) {
    return id && canReadResponsible(id) ? names?.get(id) : undefined;
  }

  function exportRow(tool: InventoryTool, dateStyle: "short" | "long") {
    return [
      tool.customId,
      inventoryToolTitle(tool),
      responsibleName(tool.lastResponsibleUserId) ?? "—",
      inventoryStatusLabel(tool),
      tool.lastInventoryAt ? formatDate(tool.lastInventoryAt, dateStyle) : "—",
    ];
  }

  function showDaysFilterModal() {
    modals.showForm({
      content: ({ context }) => (
        <>
          <MyForm.Input
            required
            name="days"
            labelText={uiText("Zeitraum in Tagen")}
            type="number"
            rules={[MyForm.Input.rules.posnum]}
          />
          <p className="light">
            {uiText(
              "Es wird geprüft, ob innerhalb dieses Zeitraums eine Inventur erfasst wurde.",
            )}
          </p>

          <NotifyLoaded
            onLoad={() => {
              context.setValues({ days });
            }}
          />
        </>
      ),
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
        modalHeading: uiText("Inventurzeitraum setzen"),
        primaryButtonText: uiText("Anwenden"),
      }),
    });
  }

  async function exportInventoryOverviewToExcel() {
    if (!canExport) return;

    const openExcel = prepareExcelExport(modals);
    const rows = [
      ...(inventoriedTools ?? []).map((tool) => [
        uiText('Inventiert'),
        ...exportRow(tool, "long"),
      ]),
      ...(missingTools ?? []).map((tool) => [
        uiText(`Keine Inventur (${days} Tage)`, `No inventory (${days} days)`),
        ...exportRow(tool, "long"),
      ]),
    ];

    const workbook = await createTableWorkbook({
      sheetName: uiText("Inventurübersicht"),
      columns: ['Bereich', uiText('Nummer'), uiText('Werkzeug'), uiText('Letzter Verantwortlicher'), 'Status', uiText('Letzte Inventur')],
      rows,
    });

    await openExcel(workbook, uiText(
      `Inventuruebersicht-${days}Tage.xlsx`,
      `Inventory-overview-${days}-days.xlsx`,
    ));
  }

  async function exportInventoryOverviewToPdf(target: BlobTarget = 'open') {
    if (!canExport) return;

    const pdfWindow = target === 'open' ? window.open('', '_blank') : null;

    setPdfExportErr(null);
    setIsPdfExporting(true);

    try {
      function compareTools(left: InventoryTool, right: InventoryTool) {
        const leftId = `${left.customId ?? ''}`;
        const rightId = `${right.customId ?? ''}`;
        const byId = leftId.localeCompare(rightId, 'de', { numeric: true, sensitivity: 'base' });
        if (byId !== 0) return byId;

        return inventoryToolTitle(left).localeCompare(inventoryToolTitle(right), 'de', { sensitivity: 'base' });
      }

      const sortedInventoriedTools = [...(inventoriedTools ?? [])].sort(compareTools);
      const sortedMissingTools = [...(missingTools ?? [])].sort(compareTools);
      const toToolRow = (tool: InventoryTool) => exportRow(tool, "short");

      const sections: PdfTableSection[] = [
        {
          title: uiText("Zusammenfassung"),
          presentation: 'summary',
          subtitle: uiText("Zuerst werden Werkzeuge ohne Inventur im Prüfzeitraum aufgeführt.", "Tools without an inventory check in the review period are listed first."),
          columns: [uiText('Kennzahl'), uiText('Wert')],
          rows: [
            [uiText('Zeitraum'), `${days} Tage`],
            [uiText('Keine Inventur'), { value: `${sortedMissingTools.length}`, bold: true }],
            [uiText('Inventiert'), { value: `${sortedInventoriedTools.length}`, emphasis: 'secondary' }],
          ],
          withHeader: false,
          align: ['left', 'right'],
          columnWidths: ['2fr', '1fr'],
        },
      ];

      if (sortedMissingTools.length > 0) {
        sections.push({
          title: uiText(`Keine Inventur in den letzten ${days} Tagen`, `No inventory in the last ${days} days`),
          columns: [uiText('Nummer'), uiText('Werkzeug'), uiText('Letzter Verantwortlicher'), 'Status', uiText('Letzte Inventur')],
          rows: sortedMissingTools.map(toToolRow),
          align: ['left', 'left', 'left', 'left', 'left'],
          columnWidths: ['0.8fr', '2.1fr', '1.55fr', '0.95fr', '1.15fr'],
        });
      }

      if (sortedInventoriedTools.length > 0) {
        sections.push({
          title: uiText(`Inventiert in den letzten ${days} Tagen`, `Inventoried in the last ${days} days`),
          columns: [uiText('Nummer'), uiText('Werkzeug'), uiText('Letzter Verantwortlicher'), 'Status', uiText('Letzte Inventur')],
          rows: sortedInventoriedTools.map(toToolRow),
          align: ['left', 'left', 'left', 'left', 'left'],
          columnWidths: ['0.8fr', '2.1fr', '1.55fr', '0.95fr', '1.15fr'],
        });
      }

      const pdfData = await renderStructuredPdf({
        title: uiText("Inventurübersicht"),
        reportLabel: uiText(`Prüfzeitraum: letzte ${days} Tage`, `Review period: last ${days} days`),
        sections,
        emptyMessage: uiText("Keine Inventurdaten verfügbar."),
      });
      context.throwIfAborted();

      const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
      deliverBlob(blob, uiText(`Inventuruebersicht-${days}Tage.pdf`, `Inventoryuebersicht-${days}Tage.pdf`), target, pdfWindow);
    } catch (err) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      if (!context.aborted) {
        setPdfExportErr((err as Error)?.message || uiText('Unbekannter Fehler beim PDF-Export.'));
      }
    } finally {
      setIsPdfExporting(false);
    }
  }

  useShortcut('Control+p', e => {
    e.preventDefault();
    if (isPdfExporting) return;
    void exportInventoryOverviewToPdf('open');
  });

  const columns: MyTableColumn<InventoryTool>[] = [
    {
      label: uiText("Nummer"),
      render: (row) => row.customId,
      sortKey: (row) => row.customId,
    },
    {
      label: uiText("Werkzeug"),
      render: (row) => (
        <MyLink to={`/tools/${row.id}`}>{inventoryToolTitle(row)}</MyLink>
      ),
      sortKey: (row) => inventoryToolTitle(row).toLowerCase(),
    },
    {
      label: uiText("Letzter Verantwortlicher"),
      render: (row) => {
        const label = responsibleName(row.lastResponsibleUserId);
        if (!label) return "—";
        return (
          <MyLink to={`/users/${row.lastResponsibleUserId}`}>{label}</MyLink>
        );
      },
      sortKey: (row) =>
        (responsibleName(row.lastResponsibleUserId) ?? "—").toLowerCase(),
    },
    {
      label: uiText("Status"),
      render: inventoryStatusLabel,
      sortKey: inventoryStatusLabel,
    },
    {
      label: uiText("Letzte Inventur"),
      render: (row) => row.lastInventoryAt ? formatDate(row.lastInventoryAt, 'long') : '—',
      sortKey: (row) => row.lastInventoryAt?.getTime() ?? 0,
    },
  ];

  return (
    <>
      <MyHeader
        title={uiText("Inventur")}
        subtitle={uiText(
          "Werkzeuge mit und ohne Inventur im gewählten Zeitraum",
        )}
        actions={
          <div className="list-page-actions">
            <OperationalTag
              renderIcon={Icons.Filter}
              text={uiText(`Zeitraum: ${days} Tage`, `Period: ${days} days`)}
              onClick={showDaysFilterModal}
            />
            <MyButton
              kind="ghost"
              size="sm"
              renderIcon={Icons.Download}
              loading={isPdfExporting}
              disabled={!canExport}
              onClick={() => exportInventoryOverviewToPdf()}
            >
              {uiText("PDF")}
            </MyButton>
            <MyButton
              kind="ghost"
              size="sm"
              renderIcon={Icons.Excel}
              disabled={!canExport}
              onClick={exportInventoryOverviewToExcel}
            >
              {uiText("Excel")}
            </MyButton>
          </div>
        }
      />

      {!!pdfExportErr && (
        <MyCallout icon={Icons.Deny} color="red">
          {uiText("PDF-Export fehlgeschlagen:")} {pdfExportErr}
        </MyCallout>
      )}

      <MyExpandable
        title={uiText(
          `Inventiert in den letzten ${days} Tagen (${inventoriedTools?.length ?? 0})`,
          `Inventoried in the last ${days} days (${inventoriedTools?.length ?? 0})`,
        )}
        initiallyExpanded
      >
        <MyTable
          persistentId="InventoriesRecent"
          rows={inventoriedTools ?? []}
          onRowClick={(row) => navigate(`/tools/${row.id}`)}
          loading={!inventoriedTools}
          error={inventoriedToolsError}
          columns={columns}
          loadMore={{}}
          renderSmallViewport={(row) => (
            <SmallTile
              icon={Icons.Tool}
              title={`${row.customId} ${inventoryToolTitle(row)}`}
              subtitle={
                row.lastInventoryAt
                  ? uiText(
                      `Letzte Inventur: ${formatDate(row.lastInventoryAt)}`,
                      `Last inventory: ${formatDate(row.lastInventoryAt)}`,
                    )
                  : undefined
              }
              href={`/tools/${row.id}`}
            />
          )}
        />
      </MyExpandable>

      <MyExpandable
        title={uiText(
          `Keine Inventur in den letzten ${days} Tagen (${missingTools?.length ?? 0})`,
          `No inventory in the last ${days} days (${missingTools?.length ?? 0})`,
        )}
      >
        <MyTable
          persistentId="InventoriesMissing"
          rows={missingTools ?? []}
          onRowClick={(row) => navigate(`/tools/${row.id}`)}
          loading={!missingTools}
          error={missingToolsError}
          columns={columns}
          loadMore={{}}
          renderSmallViewport={(row) => (
            <SmallTile
              icon={Icons.Tool}
              title={`${row.customId} ${inventoryToolTitle(row)}`}
              subtitle={
                row.lastInventoryAt
                  ? uiText(
                      `Letzte Inventur: ${formatDate(row.lastInventoryAt)}`,
                      `Last inventory: ${formatDate(row.lastInventoryAt)}`,
                    )
                  : uiText("Noch nie inventiert")
              }
              href={`/tools/${row.id}`}
            />
          )}
        />
      </MyExpandable>
    </>
  );
}

function inventoryToolTitle(tool: { brand: string; category: string; label: string | null; }) {
  return [tool.brand, tool.category, tool.label].filter(Boolean).join(' ');
}

function inventoryStatusLabel(tool: {
  status: 'lost' | 'broken' | null;
  available: boolean;
}) {
  if (tool.status === 'lost') return 'abhanden';
  if (tool.status === 'broken') return 'defekt';
  return tool.available ? uiText('verfügbar', 'available') : uiText('gebucht', 'booked');
}
