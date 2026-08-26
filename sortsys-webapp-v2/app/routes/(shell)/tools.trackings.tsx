import { OperationalTag } from "@sortsys/react-components";
import { TrackingTable } from "~/components/TrackingTable";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useStringUrlParam } from "~/hooks/useUrlParam";
import { client } from "~/lib/client";
import { toolTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProjectTile, SmallToolTile, SmallUserTile } from "~/lib/tiles";
import { TableExportActions } from "~/components/TableExportActions";

export function meta() {
    return [
        { title: "Buchungshistorie" },
    ];
}

export default function ToolTrackingsPage() {
    const modals = useMyModals();

    const [projectId, setProjectId] = useStringUrlParam('project');
    const [authorId, setAuthorId] = useStringUrlParam('author');
    const [responsibleId, setResponsibleId] = useStringUrlParam('responsible');
    const [toolId, setToolId] = useStringUrlParam('tool');

    const hasFilter = !!(projectId || authorId || responsibleId || toolId);

    const [trackings] = useClientStream(() => client.streamQuery('tools.trackings.list', {
        projectId: projectId ?? undefined,
        startedByUserId: authorId ?? undefined,
        responsibleUserId: responsibleId ?? undefined,
        toolId: toolId ?? undefined,
    }), [projectId, authorId, responsibleId, toolId]);

    function showFilterModal() {
        modals.showForm({
            content: ({ context }) => <>
                <MyForm.MultiSelect
                    name="project"
                    labelText="Projekt"
                    maxSelectedItems={1}
                    getOptions={async ({ query }) => {
                        const [data, err] = await client.query('projects.list', { search: query });
                        if (err) throw err;
                        return data ?? [];
                    }}
                    renderItem={({ item }) => item.title}
                    renderTile={item => <SmallProjectTile data={item} noLink />}
                />

                <MyForm.MultiSelect
                    name="author"
                    labelText="Herausgeber"
                    maxSelectedItems={1}
                    getOptions={async ({ query }) => {
                        const [data, err] = await client.query('users.list', { search: query });
                        if (err) throw err;
                        return data ?? [];
                    }}
                    renderItem={({ item }) => userFullName(item)}
                    renderTile={item => <SmallUserTile data={item} noLink />}
                />

                <MyForm.MultiSelect
                    name="responsible"
                    labelText="Verantwortlicher"
                    maxSelectedItems={1}
                    getOptions={async ({ query }) => {
                        const [data, err] = await client.query('users.list', { search: query });
                        if (err) throw err;
                        return data ?? [];
                    }}
                    renderItem={({ item }) => userFullName(item)}
                    renderTile={item => <SmallUserTile data={item} noLink />}
                />

                <MyForm.MultiSelect
                    name="tool"
                    labelText="Werkzeug"
                    maxSelectedItems={1}
                    getOptions={async ({ query }) => {
                        const [data, err] = await client.query('tools.list', { search: query });
                        if (err) throw err;
                        return data ?? [];
                    }}
                    renderItem={({ item }) => `${item.customId} ${toolTitle(item)}`}
                    renderTile={item => <SmallToolTile data={item} noLink />}
                />

                <NotifyLoaded onLoad={() => {
                    const loadSelection = async () => {
                        const [project, author, responsible, tool] = await Promise.all([
                            projectId ? client.query('projects.get', { id: projectId }, { strategy: 'cache-first' }) : Promise.resolve([null, null] as const),
                            authorId ? client.query('users.get', { id: authorId }, { strategy: 'cache-first' }) : Promise.resolve([null, null] as const),
                            responsibleId ? client.query('users.get', { id: responsibleId }, { strategy: 'cache-first' }) : Promise.resolve([null, null] as const),
                            toolId ? client.query('tools.get', { id: toolId }, { strategy: 'cache-first' }) : Promise.resolve([null, null] as const),
                        ]);

                        context.setValues({
                            project: project[0] ? [project[0]] : [],
                            author: author[0] ? [author[0]] : [],
                            responsible: responsible[0] ? [responsible[0]] : [],
                            tool: tool[0] ? [tool[0]] : [],
                        });
                    };

                    void loadSelection();
                }} />
            </>,
            onSubmit: ({ context, hide }) => {
                const values = context.getValues();

                setProjectId(values.project?.at(0)?.id ?? null);
                setAuthorId(values.author?.at(0)?.id ?? null);
                setResponsibleId(values.responsible?.at(0)?.id ?? null);
                setToolId(values.tool?.at(0)?.id ?? null);

                hide();
            },
            modalProps: () => ({
                modalHeading: 'Buchungshistorie filtern',
                primaryButtonText: 'Filter anwenden',
            }),
        });
    }

    async function loadTrackingExportRows(): Promise<any[]> {
        let [tools] = await client.query('tools.list', {});
        let [users] = await client.query('users.list', {});
        let [projects] = await client.query('projects.list', {});

        tools ??= [];
        users ??= [];
        projects ??= [];

        const tool = (id?: string | null) => id ? tools.find(t => t.id === id) : null;
        const user = (id?: string | null) => id ? users.find(t => t.id === id) : null;
        const project = (id?: string | null) => id ? projects.find(t => t.id === id) : null;

        return (trackings ?? []).map(tracking => {
            const _tool = tool(tracking.toolId);
            const _responsible = user(tracking.responsibleUserId);
            const _author = user(tracking.startedByUserId);
            const _project = project(tracking.projectId);

            return {
                ...tracking,
                toolLabel: _tool ? `${_tool.customId} ${toolTitle(_tool)}` : 'Unbekannt',
                projectLabel: tracking.projectId ? _project?.title ?? 'Unbekannt' : '',
                responsibleLabel: tracking.responsibleUserId ? _responsible ? userFullName(_responsible) : 'Unbekannt' : '',
                authorLabel: tracking.startedByUserId ? _author ? userFullName(_author) : 'Unbekannt' : '',
            };
        });
    }

    return <>
        <div className="flex gap-2 w-full overlflow-x-auto items-center">
            {!hasFilter ? (
                <OperationalTag renderIcon={Icons.Filter} text="Filter" onClick={showFilterModal} />
            ) : (
                <>
                    <OperationalTag renderIcon={Icons.FilterEdit} text="Filter ändern" onClick={showFilterModal} />
                    <OperationalTag renderIcon={Icons.FilterRemove} text="Filter aus" onClick={() => {
                        setProjectId(null);
                        setAuthorId(null);
                        setResponsibleId(null);
                        setToolId(null);
                    }} />
                </>
            )}

            <TableExportActions
                title="Buchungshistorie"
                fileName="Buchungshistorie"
                rows={loadTrackingExportRows}
                disabled={!trackings}
                columns={[
                    { header: 'Werkzeug', value: tracking => tracking.toolLabel, width: '2fr' },
                    { header: 'Projekt', value: tracking => tracking.projectLabel, width: '2fr' },
                    { header: 'Verantwortlicher', value: tracking => tracking.responsibleLabel, width: '1.5fr' },
                    { header: 'Herausgeber', value: tracking => tracking.authorLabel, width: '1.5fr' },
                    { header: 'Von', value: tracking => tracking.startedAt },
                    { header: 'Bis', value: tracking => tracking.endedAt ?? 'offen' },
                ]}
            />
        </div>

        <div style={{ height: '1px' }} />

        <TrackingTable
            trackings={trackings ?? []}
            className=""
            topPagination
        />
    </>;
}
