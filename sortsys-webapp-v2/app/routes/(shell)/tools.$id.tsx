import { uiText } from "~/lib/i18n";
import {
  Callout,
  Heading,
  InlineNotification,
  Loading,
  Menu,
  MenuItem,
  Tag,
  Tile,
} from "@sortsys/react-components";
import { useParams } from "react-router";
import { of } from "rxjs";
import { MyHeader } from "~/components/MyHeader";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import {
  formatCurrency,
  formatDate,
  toolStatus,
  toolStatusTagType,
  toolTitle,
  userFullName,
} from "~/lib/format";
import type { Route } from "./+types";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { useMemo } from "react";
import { MyCallout } from "~/components/MyCallout";
import { MyDropdown } from "~/components/MyDropdown";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { Icons } from "~/lib/icons";
import { useMyModals } from "~/hooks/useMyModals";
import {
  showCreateToolInventoryModal,
  showDeleteToolModal,
  showModifyToolModal,
  showToolTransferModal,
  showTrackToolsModal,
} from "~/modals/tools";
import { Awaited } from "~/components/Awaited";
import { TrackingTable } from "~/components/TrackingTable";
import { MyLink } from "~/components/MyLink";
import { AttrList } from "~/components/AttrList";
import { MyDivider } from "~/components/MyDivider";
import { NotFound } from "./_404";
import { MyExpandable } from "~/components/MyExpandable";
import { Remarks } from "~/components/Remarks";
import { EntityActivityTimeline } from "~/components/EntityActivityTimeline";
import type { ToolTracking } from "~/type-helpers";

export default function ToolDetailPage() {
  const { id } = useParams();

  const sessionInfo = useSessionInfo();

  const modals = useMyModals();

  const [tool, err] = useClientStream(
    () => client.streamQuery("tools.get", { id: id! }),
    [id],
  );
  const toolIsReady = !!tool && tool.id === id && !err;
  // A booking-history load can span many encrypted areas. Let the current
  // tool and its availability finish before those queries join the queue.
  const [inventories, inventoriesError] = useClientStream(
    () =>
      toolIsReady
        ? client.streamQuery("tools.inventories.list", { toolId: id! })
        : of<[null, null]>([null, null]),
    [id, toolIsReady],
  );
  const [trackings, trackingsError] = useClientStream(
    () =>
      toolIsReady
        ? client.streamQuery("tools.trackings.list", { toolId: id! })
        : of<[null, null]>([null, null]),
    [id, toolIsReady],
  );

  useTitle(
    () => (tool ? `${tool.customId} ${toolTitle(tool)}` : null),
    [JSON.stringify(tool)],
  );

  const sortedTrackings = useMemo(() => {
    if (!trackings) return null;
    return [...trackings].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    );
  }, [trackings]);

  const sortedInventories = useMemo(() => {
    if (!inventories) return null;
    return [...inventories].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }, [inventories]);

  const activeTracking =
    sortedTrackings?.find((tracking) => !tracking.endedAt) ?? null;
  const trackingHistoryTitle =
    sortedTrackings && !trackingsError
      ? uiText(
          `Buchungshistorie (${sortedTrackings.length})`,
          `Booking history (${sortedTrackings.length})`,
        )
      : uiText("Buchungshistorie", "Booking history");
  const latestInventory = sortedInventories?.[0];
  const toolScope = `tool:${id}`;
  const canEditTool = sessionInfo.canAccess(toolScope, "master-data", "update");
  const canBookTool = sessionInfo.canBookTool(id);
  const trackingScope = activeTracking
    ? `tool-tracking:${activeTracking.id}`
    : null;
  const canEditTracking =
    !!trackingScope &&
    sessionInfo.canAccess(trackingScope, "master-data", "update");
  const canEditTransfers =
    !!trackingScope && sessionInfo.canAccess(trackingScope, "scope", "update");
  const canEditProjectUsage =
    !activeTracking?.projectId ||
    sessionInfo.canAccess(
      `project:${activeTracking.projectId}:tool-usage`,
      "master-data",
      "update",
    );
  const canReturnTool =
    canEditTool && canEditTracking && canEditTransfers && canEditProjectUsage;
  const canTransferTool =
    canBookTool && canEditTracking && canEditTransfers && canEditProjectUsage;
  const canRequestTransfer =
    !!activeTracking &&
    !!trackingScope &&
    sessionInfo.canAccess(trackingScope, "scope", "create") &&
    (sessionInfo.user.id === activeTracking.responsibleUserId ||
      sessionInfo.user.id === activeTracking.startedByUserId);
  function canDeleteTracking(tracking: ToolTracking) {
    const scope = `tool-tracking:${tracking.id}`;
    const canDeleteBooking = (
      ["master-data", "procurement", "scope"] as const
    ).every((facet) => sessionInfo.canAccess(scope, facet, "delete"));
    if (!canDeleteBooking) return false;
    if (!tracking.projectId) return true;
    const projectScope = `project:${tracking.projectId}:tool-usage`;
    return (
      sessionInfo.canAccess(projectScope, "master-data", "delete") &&
      sessionInfo.canAccess(projectScope, "procurement", "delete")
    );
  }
  const canDeleteTool =
    (["master-data", "procurement", "measurement"] as const).every((facet) =>
      sessionInfo.canAccess(toolScope, facet, "delete"),
    ) &&
    sessionInfo.canAccess("catalog:tools", "master-data", "update") &&
    !trackingsError &&
    !!sortedTrackings &&
    sortedTrackings.every(canDeleteTracking);

  useShortcut("Control+e", (e) => {
    if (!tool || !canEditTool) return;
    e.preventDefault();
    showModifyToolModal(modals, tool);
  });

  if (err) return <NotFound reason="resourceNotFound" />;
  if (!toolIsReady) return <Loading withOverlay />;

  return (
    <>
      <MyHeader
        title={`${tool.customId} ${toolTitle(tool)}`}
        subtitle={
          <>
            <Tag type={toolStatusTagType(tool)} size="md">
              {toolStatus(tool)}
            </Tag>
          </>
        }
        actions={
          <>
            <MyDropdown
              icon={Icons.DropdownMenu}
              items={[
                {
                  label: uiText("Buchen"),
                  renderIcon: Icons.Track,
                  hideIf: !tool.available || !canBookTool,
                  onClick: () => showTrackToolsModal(modals, { tools: [tool] }),
                },
                {
                  label: uiText("Zurückbuchen"),
                  renderIcon: Icons.TakeBack,
                  hideIf: tool.available || !canReturnTool,
                  onClick: async () => {
                    const [, err] = await client.mutate("tools.untrack", {
                      id: tool.id,
                    });
                    if (err) throw err;
                  },
                },
                {
                  label: canTransferTool
                    ? uiText("Umbuchen")
                    : uiText("Umbuchungsanfrage"),
                  renderIcon: Icons.Transfer,
                  hideIf:
                    !activeTracking || !(canTransferTool || canRequestTransfer),
                  onClick: () =>
                    showToolTransferModal(modals, {
                      tool,
                      tracking: activeTracking!,
                      isRequest: !canTransferTool,
                    }),
                },
                {
                  label: uiText("Inventur"),
                  renderIcon: Icons.ToolInventory,
                  hideIf: !sessionInfo.canAccess(
                    toolScope,
                    "measurement",
                    "create",
                  ),
                  onClick: () => showCreateToolInventoryModal(modals, tool),
                },
                {
                  label: uiText("Archivieren", "Archive"),
                  renderIcon: Icons.Archive,
                  hideIf: !!tool.archivedSince || !canEditTool,
                  onClick: async () => {
                    const [, err] = await client.mutate("tools.archive", {
                      id: tool.id,
                    });
                    if (err) throw err;
                  },
                },
                {
                  label: uiText("Aus Archiv holen"),
                  renderIcon: Icons.Archive,
                  hideIf: !tool.archivedSince || !canEditTool,
                  onClick: async () => {
                    const [, err] = await client.mutate("tools.unarchive", {
                      id: tool.id,
                    });
                    if (err) throw err;
                  },
                },
                {
                  label: uiText("Bearbeiten"),
                  renderIcon: Icons.Edit,
                  hideIf: !canEditTool,
                  onClick: () => showModifyToolModal(modals, tool),
                },
                {
                  label: uiText("Löschen"),
                  renderIcon: Icons.Delete,
                  hideIf: !canDeleteTool,
                  onClick: () => showDeleteToolModal(modals, tool),
                },
              ]}
            />
          </>
        }
      />

      {!!tool.archivedSince && (
        <MyCallout icon={Icons.Archive} color="grey">
          {uiText(
            `Werkzeug ist seit ${formatDate(tool.archivedSince)} archiviert.`,
            `Tool has been archived since ${formatDate(tool.archivedSince)}.`,
          )}
        </MyCallout>
      )}

      {!!inventoriesError && (
        <MyCallout
          kind="error"
          title={uiText(
            "Inventurdaten konnten nicht geladen werden",
            "Inventory data could not be loaded",
          )}
        />
      )}

      {!!latestInventory && (
        <MyCallout icon={Icons.Info} color="blue">
          {uiText("Letzte Inventur am")} {formatDate(latestInventory.createdAt)}
          {!!latestInventory.comment && (
            <>
              <br />
              <span className="light">{latestInventory.comment}</span>
            </>
          )}
        </MyCallout>
      )}

      <MyDivider />

      <AttrList>
        <AttrList.Attr name={uiText("Nummer")} value={tool.customId} />
        <AttrList.Attr
          name={uiText("Marke", "Brand")}
          value={
            <MyLink to={`/tools?brand=${encodeURIComponent(tool.brand)}`}>
              {tool.brand}
            </MyLink>
          }
        />
        <AttrList.Attr
          name={uiText("Kategorie", "Category")}
          value={
            <MyLink to={`/tools?category=${encodeURIComponent(tool.category)}`}>
              {tool.category}
            </MyLink>
          }
        />
        <AttrList.Attr
          name={uiText("Gebucht", "Booked")}
          value={!tool.available ? uiText("Ja", "Yes") : uiText("Nein", "No")}
        />
        {!!tool.label && (
          <AttrList.Attr name={uiText("Modell", "Model")} value={tool.label} />
        )}
        {!!tool.status && (
          <AttrList.Attr name={uiText("Status")} value={toolStatus(tool)} />
        )}
      </AttrList>

      <AttrList>
        {typeof tool.purchasePrice === "number" && (
          <AttrList.Attr
            name={uiText("Kaufpreis", "Purchase price")}
            value={formatCurrency(tool.purchasePrice)}
          />
        )}
        {typeof tool.usageCostPerDay === "number" && (
          <AttrList.Attr
            name={uiText("Nutzungskosten pro Tag", "Usage cost per day")}
            value={formatCurrency(tool.usageCostPerDay)}
          />
        )}
      </AttrList>

      <MyDivider />

      <Remarks resourceType="tool" resourceId={tool.id} />

      <EntityActivityTimeline resourceType="tool" resourceId={tool.id} />

      <MyExpandable initiallyExpanded title={trackingHistoryTitle}>
        <TrackingTable
          trackings={sortedTrackings ?? []}
          loading={!trackings}
          error={trackingsError}
          omit={["tool"]}
        />
      </MyExpandable>
    </>
  );
}
