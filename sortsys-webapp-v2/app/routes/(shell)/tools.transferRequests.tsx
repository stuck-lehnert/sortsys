import { useMemo } from "react";
import { MyButton } from "~/components/MyButton";
import { MyExpandable } from "~/components/MyExpandable";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { formatDate, toolTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { MyLink } from "~/components/MyLink";

export default function ToolTransferRequestsPage() {
    const sessionInfo = useSessionInfo();

    let [requests] = useClientStream(() => client.streamQuery('tools.trackings.transfers.list', {}));
    requests ??= [];

    const open = useMemo(() => requests.filter(req => req.status === 'open'), [requests]);
    const accepted = useMemo(() => requests.filter(req => req.status === 'accepted'), [requests]);
    const denied = useMemo(() => requests.filter(req => req.status === 'denied'), [requests]);

    if (!requests) return;

    return <>
        <MyExpandable title="Offen" initiallyExpanded>
            <MyTable
                className="th-20rem"
                rows={open}
                columns={[
                    {
                        label: 'Aktionen',
                        render: row => {
                            const enabled = sessionInfo.canDo('manage:toolTrackings') || row.transferToUserId === sessionInfo.user.id;

                            const createAction = (action: 'accept' | 'deny') => async () => {
                                await client.mutate(`tools.trackings.transfers.${action}`, {
                                    id: row.id,
                                });
                            };

                            return <div className='flex'>
                                <MyButton kind="ghost" onClick={createAction('accept')} disabled={!enabled}><Icons.Accept /></MyButton>
                                <MyButton kind="ghost" onClick={createAction('deny')} disabled={!enabled}><Icons.Deny /></MyButton>
                            </div>;
                        },
                    },
                    {
                        label: 'Werkzeug',
                        render: async (row) => {
                            const [tool] = await client.query('tools.get', { id: row.toolId }, { strategy: 'cache-first' });
                            if (!tool) return 'Unbekannt';
                            return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
                        },
                    },
                    {
                        label: 'Verantwortlich',
                        render: async (row) => {
                            if (!row.responsibleUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.responsibleUserId }, { strategy: 'cache-first' });
                            if (!user) return 'Unbekannt';
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: 'Umbuchen auf',
                        render: async (row) => {
                            if (!row.transferToUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.transferToUserId }, { strategy: 'cache-first' });
                            if (!user) return 'Unbekannt';
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: '',
                        render: async (row) => {
                            if (!row.projectId) return;

                            const [project] = await client.query('projects.get', { id: row.projectId }, { strategy: 'cache-first' });
                            if (!project) return 'Unbekannt';
                            return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
                        },
                    },
                    {
                        label: 'Angefragt am',
                        render: row => formatDate(row.createdAt),
                    },
                ]}
                pagination={{}}
            />
        </MyExpandable>

        {!!accepted.length && <MyExpandable title="Genehmigt">
            <MyTable
                className="th-20rem"
                rows={accepted}
                columns={[
                    {
                        label: 'Werkzeug',
                        render: async (row) => {
                            const [tool] = await client.query('tools.get', { id: row.toolId }, { strategy: 'cache-first' });
                            if (!tool) return 'Unbekannt';
                            return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
                        },
                    },
                    {
                        label: 'Verantwortlich',
                        render: async (row) => {
                            if (!row.responsibleUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.responsibleUserId }, { strategy: 'cache-first' });
                            if (!user) return 'Unbekannt';
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: 'Umbuchen auf',
                        render: async (row) => {
                            if (!row.transferToUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.transferToUserId }, { strategy: 'cache-first' });
                            if (!user) return 'Unbekannt';
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: '',
                        render: async (row) => {
                            if (!row.projectId) return;
            
                            const [project] = await client.query('projects.get', { id: row.projectId }, { strategy: 'cache-first' });
                            if (!project) return 'Unbekannt';
                            return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
                        },
                    },
                    {
                        label: 'Angefragt am',
                        render: row => formatDate(row.createdAt),
                    },
                ]}
                pagination={{}}
            />
        </MyExpandable>}
        
        {!!denied.length && <MyExpandable title="Abgelehnt">
            <MyTable
                className="th-20rem"
                rows={denied}
                columns={[
                    {
                        label: 'Werkzeug',
                        render: async (row) => {
                            const [tool] = await client.query('tools.get', { id: row.toolId }, { strategy: 'cache-first' });
                            if (!tool) return 'Unbekannt';
                            return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
                        },
                    },
                    {
                        label: 'Verantwortlich',
                        render: async (row) => {
                            if (!row.responsibleUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.responsibleUserId }, { strategy: 'cache-first' });
                            if (!user) return 'Unbekannt';
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: 'Umbuchen auf',
                        render: async (row) => {
                            if (!row.transferToUserId) return;
            
                            const [user] = await client.query('users.get', { id: row.transferToUserId }, { strategy: 'cache-first' });
                            if (!user) return 'Unbekannt';
                            return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
                        },
                    },
                    {
                        label: '',
                        render: async (row) => {
                            if (!row.projectId) return;
            
                            const [project] = await client.query('projects.get', { id: row.projectId }, { strategy: 'cache-first' });
                            if (!project) return 'Unbekannt';
                            return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
                        },
                    },
                    {
                        label: 'Angefragt am',
                        render: row => formatDate(row.createdAt),
                    },
                ]}
                pagination={{}}
            />
        </MyExpandable>}
    </>;
}
