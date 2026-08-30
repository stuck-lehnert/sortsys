import { uiText } from "~/lib/i18n";
import type { Route } from "./+types/tools.transferRequests";
import { useMemo, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyExpandable } from "~/components/MyExpandable";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { formatDate, toolTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { MyLink } from "~/components/MyLink";
import { MyCallout } from "~/components/MyCallout";
import { MyHeader } from "~/components/MyHeader";

export function meta({}: Route.MetaArgs) {
    return [
        { title: uiText("Umbuchungsanfragen", "Transfer requests") },
    ];
}

export default function ToolTransferRequestsPage() {
    const sessionInfo = useSessionInfo();

    const [requests, requestsError] = useClientStream(() => client.streamQuery('tools.trackings.transfers.list', {}));
    const [pendingAction, setPendingAction] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const requestRows = requests ?? [];

    const open = useMemo(() => requestRows.filter(req => req.status === 'open'), [requestRows]);
    const accepted = useMemo(() => requestRows.filter(req => req.status === 'accepted'), [requestRows]);
    const denied = useMemo(() => requestRows.filter(req => req.status === 'denied'), [requestRows]);

    return <>
        <MyHeader title={uiText("Umbuchungsanfragen", "Transfer requests")} />

        {!!actionError && <MyCallout
            kind="error"
            title={uiText("Umbuchung konnte nicht verarbeitet werden", "Transfer request could not be processed")}
            subtitle={actionError}
        />}

        <MyExpandable title={uiText("Offen")} initiallyExpanded>
            <MyTable
                className="th-20rem"
                rows={open}
                loading={!requests}
                error={requestsError}
                columns={[
                    {
                        label: uiText("Aktionen"),
                        render: row => {
                            const enabled = sessionInfo.canDo('manage:toolTrackings') || row.transferToUserId === sessionInfo.user.id;

                            const createAction = (action: 'accept' | 'deny') => async () => {
                                const actionName = `${action}:${row.id}`;
                                setPendingAction(actionName);
                                setActionError(null);

                                try {
                                    const [, error] = await client.mutate(`tools.trackings.transfers.${action}`, {
                                        id: row.id,
                                    });
                                    if (error) throw error;
                                } catch (error) {
                                    setActionError(error instanceof Error ? error.message : uiText("Die Aktion ist fehlgeschlagen.", "The action failed."));
                                } finally {
                                    setPendingAction(null);
                                }
                            };

                            return <div className="flex gap-1 flex-wrap">
                                <MyButton size="sm" kind="ghost" renderIcon={Icons.Accept} loading={pendingAction === `accept:${row.id}`} onClick={createAction('accept')} disabled={!enabled || !!pendingAction}>{uiText("Annehmen", "Accept")}</MyButton>
                                <MyButton size="sm" kind="ghost" renderIcon={Icons.Deny} loading={pendingAction === `deny:${row.id}`} onClick={createAction('deny')} disabled={!enabled || !!pendingAction}>{uiText("Ablehnen", "Deny")}</MyButton>
                            </div>;
                        },
                    },
                    {
                        label: uiText("Werkzeug"),
                        render: async (row) => {
                            const [tool] = await client.query('tools.get', { id: row.toolId }, { strategy: 'cache-first' });
                            if (!tool) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Verantwortlich"),
                        render: async (row) => {
                            if (!row.responsibleUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.responsibleUserId }, { strategy: 'cache-first' });
                            if (!user) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Umbuchen auf"),
                        render: async (row) => {
                            if (!row.transferToUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.transferToUserId }, { strategy: 'cache-first' });
                            if (!user) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: uiText('Projekt', 'Project'),
                        render: async (row) => {
                            if (!row.projectId) return;

                            const [project] = await client.query('projects.get', { id: row.projectId }, { strategy: 'cache-first' });
                            if (!project) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Angefragt am"),
                        render: row => formatDate(row.createdAt),
                    },
                ]}
                pagination={{}}
            />
        </MyExpandable>

        {!!accepted.length && <MyExpandable title={uiText("Genehmigt")}>
            <MyTable
                className="th-20rem"
                rows={accepted}
                columns={[
                    {
                        label: uiText("Werkzeug"),
                        render: async (row) => {
                            const [tool] = await client.query('tools.get', { id: row.toolId }, { strategy: 'cache-first' });
                            if (!tool) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Verantwortlich"),
                        render: async (row) => {
                            if (!row.responsibleUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.responsibleUserId }, { strategy: 'cache-first' });
                            if (!user) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Umbuchen auf"),
                        render: async (row) => {
                            if (!row.transferToUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.transferToUserId }, { strategy: 'cache-first' });
                            if (!user) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: uiText('Projekt', 'Project'),
                        render: async (row) => {
                            if (!row.projectId) return;
            
                            const [project] = await client.query('projects.get', { id: row.projectId }, { strategy: 'cache-first' });
                            if (!project) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Angefragt am"),
                        render: row => formatDate(row.createdAt),
                    },
                ]}
                pagination={{}}
            />
        </MyExpandable>}
        
        {!!denied.length && <MyExpandable title={uiText("Abgelehnt")}>
            <MyTable
                className="th-20rem"
                rows={denied}
                columns={[
                    {
                        label: uiText("Werkzeug"),
                        render: async (row) => {
                            const [tool] = await client.query('tools.get', { id: row.toolId }, { strategy: 'cache-first' });
                            if (!tool) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Verantwortlich"),
                        render: async (row) => {
                            if (!row.responsibleUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.responsibleUserId }, { strategy: 'cache-first' });
                            if (!user) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Umbuchen auf"),
                        render: async (row) => {
                            if (!row.transferToUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.transferToUserId }, { strategy: 'cache-first' });
                            if (!user) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: uiText('Projekt', 'Project'),
                        render: async (row) => {
                            if (!row.projectId) return;
            
                            const [project] = await client.query('projects.get', { id: row.projectId }, { strategy: 'cache-first' });
                            if (!project) return uiText('Unbekannt', 'Unknown');
                            return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
                        },
                    },
                    {
                        label: uiText("Angefragt am"),
                        render: row => formatDate(row.createdAt),
                    },
                ]}
                pagination={{}}
            />
        </MyExpandable>}
    </>;
}
