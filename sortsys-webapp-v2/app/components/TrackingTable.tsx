import { uiText } from "~/lib/i18n";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import type { ToolTracking } from "~/type-helpers";
import { MyTable, type MyTableColumn } from "./MyTable";
import { client } from "~/lib/client";
import { MyLink } from './MyLink';
import { formatDate, toolTitle, userFullNameComma } from "~/lib/format";
import { TrackingTile } from "~/lib/tiles";

export function TrackingTable(props: {
    trackings: ToolTracking[];
    omit?: ("tool" | "project" | "author" | "responsible" | "timestamps")[];
    className?: string;
    topPagination?: boolean;
}) {
    const sessionInfo = useSessionInfo();

    const columns: MyTableColumn<ToolTracking>[] = [];

    if (!props.omit?.includes("tool")) {
        columns.push({
            label: uiText("Werkzeug"),
            render: async (tracking) => {
                const [tool] = await client.query('tools.get', { id: tracking.toolId }, { strategy: 'cache-first' });
                if (!tool) return 'Unbekannt';
                return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
            },
        });
    }

    if (!props.omit?.includes("project")) {
        columns.push({
            label: uiText("Projekt"),
            render: async (tracking) => {
                if (!tracking.projectId) return;

                const [project] = await client.query('projects.get', { id: tracking.projectId }, { strategy: 'cache-first' });
                if (!project) return 'Unbekannt';
                return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
            },
        });
    }

    if (!props.omit?.includes("responsible")) {
        columns.push({
            label: uiText("Verantwortlicher"),
            render: async (tracking) => {
                if (!tracking.responsibleUserId) return;

                const [user] = await client.query('users.get', { id: tracking.responsibleUserId }, { strategy: 'cache-first' });
                if (!user) return 'Unbekannt';
                return <MyLink to={`/users/${user.id}`}>{userFullNameComma(user)}</MyLink>;
            },
        });
    }

    if (!props.omit?.includes("author")) {
        columns.push({
            label: uiText("Herausgeber"),
            render: async (tracking) => {
                if (!tracking.startedByUserId) return;

                const [user] = await client.query('users.get', { id: tracking.startedByUserId }, { strategy: 'cache-first' });
                if (!user) return 'Unbekannt';
                return <MyLink to={`/users/${user.id}`}>{userFullNameComma(user)}</MyLink>;
            },
        });
    }

    if (!props.omit?.includes("timestamps")) {
        columns.push({
            label: uiText("Von"),
            render: (tracking) => formatDate(tracking.startedAt),
            sortKey: (tracking) => tracking.startedAt.getTime(),
        });

        columns.push({
            label: uiText("Bis"),
            render: (tracking) => tracking.endedAt ? formatDate(tracking.endedAt) : 'offen',
            sortKey: (tracking) => (tracking.endedAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
        });
    }

    if (!props.trackings?.length) return;

    return <MyTable
        rows={props.trackings}
        columns={columns}
        pagination={{}}
        className={props.className ?? 'th-20rem'}
        topPagination={props.topPagination}
        renderSmallViewport={tracking => <TrackingTile tracking={tracking} omit={props.omit} />}
        viewportBreakpoint={1400}
    />;
}
