import { uiText } from "~/lib/i18n";
import { Callout, Heading, InlineNotification, Loading, Menu, MenuItem, Tag, Tile } from "@sortsys/react-components";
import { useParams } from "react-router";
import { MyHeader } from "~/components/MyHeader";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { formatCurrency, formatDate, toolStatus, toolStatusTagType, toolTitle, userFullName } from "~/lib/format";
import type { Route } from "./+types";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { useMemo } from "react";
import { MyCallout } from "~/components/MyCallout";
import { MyDropdown } from "~/components/MyDropdown";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { Icons } from "~/lib/icons";
import { useMyModals } from "~/hooks/useMyModals";
import { showCreateToolInventoryModal, showDeleteToolModal, showModifyToolModal, showToolTransferModal, showTrackToolsModal } from "~/modals/tools";
import { Awaited } from "~/components/Awaited";
import { TrackingTable } from "~/components/TrackingTable";
import { MyLink } from "~/components/MyLink";
import { AttrList } from "~/components/AttrList";
import { MyDivider } from "~/components/MyDivider";
import { NotFound } from "./_404";
import { MyExpandable } from "~/components/MyExpandable";
import { Remarks } from "~/components/Remarks";
import { EntityActivityTimeline } from "~/components/EntityActivityTimeline";

export default function ToolDetailPage() {
    const { id } = useParams();

    const sessionInfo = useSessionInfo();

    const modals = useMyModals();

    const [tool, err] = useClientStream(() => client.streamQuery('tools.get', { id: id! }), [id]);
    const [inventories] = useClientStream(() => client.streamQuery('tools.inventories.list', { toolId: id! }), [id]);
    const [trackings] = useClientStream(() => client.streamQuery('tools.trackings.list', { toolId: id! }), [id]);

    useTitle(() => tool ? `${tool.customId} ${toolTitle(tool)}` : null, [JSON.stringify(tool)]);
    
    const sortedTrackings = useMemo(() => {
        if (!trackings) return null;
        return trackings.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }, [trackings]);

    const sortedInventories = useMemo(() => {
        if (!inventories) return null;
        return inventories.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }, [inventories]);

    const activeTracking = sortedTrackings?.find(tracking => !tracking.endedAt) ?? null;
    const latestInventory = sortedInventories?.[0];

    useShortcut('Control+e', e => {
        if (!tool || !sessionInfo.canDo('manage:tools')) return;
        e.preventDefault();
        showModifyToolModal(modals, tool);
    });

    if (err) return <NotFound reason="resourceNotFound" />;
    if (!tool) return;

    return <>
        <MyHeader
            title={`${tool.customId} ${toolTitle(tool)}`}
            subtitle={<>
                <Tag type={toolStatusTagType(tool)} size="md">{toolStatus(tool)}</Tag>
            </>}
            actions={<>
                <MyDropdown icon={Icons.DropdownMenu}
                    items={[
                        {
                            label: uiText("Buchen"),
                            renderIcon: Icons.Track,
                            hideIf: !tool.available || !sessionInfo.canDo('manage:toolTrackings'),
                            onClick: () => showTrackToolsModal(modals, { tools: [tool] }),
                        },
                        {
                            label: uiText("Zurückbuchen"),
                            renderIcon: Icons.TakeBack,
                            hideIf: tool.available || !sessionInfo.canDo('manage:toolTrackings'),
                            onClick: async () => {
                                const [, err] = await client.mutate('tools.untrack', { id: tool.id });
                                if (err) throw err;
                            },
                        },
                        {
                            label: sessionInfo.canDo("manage:toolTrackings") ? uiText("Umbuchen") : uiText("Umbuchungsanfrage"),
                            renderIcon: Icons.Transfer,
                            hideIf: !activeTracking || !(sessionInfo.canDo('manage:toolTrackings') || sessionInfo.user.id === activeTracking.id),
                            onClick: () => showToolTransferModal(modals, {
                                tool, tracking: activeTracking!,
                                isRequest: !sessionInfo.canDo('manage:toolTrackings'),
                            }),
                        },
                        {
                            label: uiText("Inventur"),
                            renderIcon: Icons.ToolInventory,
                            hideIf: !sessionInfo.canDo('manage:toolInventories'),
                            onClick: () => showCreateToolInventoryModal(modals, tool),
                        },
                        {
                            label: uiText("Archvieren"),
                            renderIcon: Icons.Archive,
                            hideIf: !!tool.archivedSince || !sessionInfo.canDo('manage:tools'),
                            onClick: async () => {
                                const [, err] = await client.mutate('tools.archive', { id: tool.id });
                                if (err) throw err;
                            },
                        },
                        {
                            label: uiText("Aus Archiv holen"),
                            renderIcon: Icons.Archive,
                            hideIf: !tool.archivedSince || !sessionInfo.canDo('manage:tools'),
                            onClick: async () => {
                                const [, err] = await client.mutate('tools.unarchive', { id: tool.id });
                                if (err) throw err;
                            },
                        },
                        {
                            label: uiText("Bearbeiten"),
                            renderIcon: Icons.Edit,
                            hideIf: !sessionInfo.canDo('manage:tools'),
                            onClick: () => showModifyToolModal(modals, tool),
                        },
                        {
                            label: uiText("Löschen"),
                            renderIcon: Icons.Delete,
                            hideIf: !sessionInfo.canDo('delete:tools'),
                            onClick: () => showDeleteToolModal(modals, tool),
                        },
                    ]}
                />
            </>}
        />

        {!!tool.archivedSince && <MyCallout icon={Icons.Archive} color="grey">{uiText("Werkzeug ist seit dem")}{formatDate(tool.archivedSince)}{uiText("archiviert")}</MyCallout>}

        {!!latestInventory && <MyCallout icon={Icons.Info} color="blue">{uiText("Letzte Inventur am")}{formatDate(latestInventory.createdAt)}
            {!!latestInventory.comment && <>
                <br /><span className="light">{latestInventory.comment}</span>
            </>}
        </MyCallout>}
        
        <MyDivider />

        <AttrList>
            <AttrList.Attr name={uiText("Nummer")} value={tool.customId} />
            <AttrList.Attr name="Marke" value={<MyLink to={`/tools?brand=${encodeURIComponent(tool.brand)}`}>{tool.brand}</MyLink>} />
            <AttrList.Attr name="Kategorie" value={<MyLink to={`/tools?category=${encodeURIComponent(tool.category)}`}>{tool.category}</MyLink>} />
            <AttrList.Attr name="Gebucht" value={!tool.available ? 'Ja' : 'Nein'} />
            {!!tool.label && <AttrList.Attr name="Modell" value={tool.label} />}
            {!!tool.status && <AttrList.Attr name="Status" value={toolStatus(tool)} />}
        </AttrList>

        <AttrList>
            {typeof tool.purchasePrice === 'number' && <AttrList.Attr name="Kaufpreis" value={formatCurrency(tool.purchasePrice)} />}
            {typeof tool.usageCostPerDay === 'number' && <AttrList.Attr name="Nutzungskosten pro Tag" value={formatCurrency(tool.usageCostPerDay)} />}
        </AttrList>

        <MyDivider />

        <Remarks resourceType="tool" resourceId={tool.id} canManage={sessionInfo.canDo('manage:tools')} />

        <EntityActivityTimeline resourceType="tool" resourceId={tool.id} />
                
        {!!sortedTrackings?.length && <MyExpandable initiallyExpanded title={`Buchungshistorie (${sortedTrackings?.length})`}>
            <TrackingTable trackings={sortedTrackings} omit={['tool']} />
        </MyExpandable>}
    </>;
}
