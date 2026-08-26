import { OperationalTag, Tag } from "@sortsys/react-components";
import { useNavigate } from "react-router";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { toolStatus, toolStatusTagType } from "~/lib/format";
import type { Route } from "./+types";
import { Icons } from "~/lib/icons";
import { useBoolUrlParam, useStringUrlParam } from "~/hooks/useUrlParam";
import { useMyModals } from "~/hooks/useMyModals";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { SmallTile, SmallToolTile, ToolTile } from "~/lib/tiles";
import { useMemo } from "react";
import { TableExportActions } from "~/components/TableExportActions";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Werkzeuge" },
  ];
}

export default function ToolsPage() {
    const navigate = useNavigate();

    const modals = useMyModals();

    let [status, setStatus] = useStringUrlParam('status');
    if (status && !['available', 'unavailable', 'broken', 'lost'].includes(status)) status = null;

    const [brand, setBrand] = useStringUrlParam('brand');
    const [category, setCategory] = useStringUrlParam('category');
    const [archivedOnly, setArchivedOnly] = useBoolUrlParam('archived');

    const [data, err] = useClientStream(() => client.streamQuery('tools.list', {
        status: status as any,
        brand, category,
    }), [status, brand, category]);

    const filteredData = useMemo(() => {
        if (!data) return [];
        return data.filter(tool => archivedOnly ? !!tool.archivedSince : !tool.archivedSince);
    }, [data, archivedOnly]);

    function showFilterModal() {
        modals.showForm({
            content: ({ context }) => <>
                <MyForm.Select
                    name="status" labelText="Status"
                    getOptions={() => [
                        { id: 'none', label: 'Nicht ausgewählt' },
                        { id: 'available', label: 'Verfügbar' },
                        { id: 'unavailable', label: 'Gebucht' },
                        { id: 'lost', label: 'Abhanden' },
                        { id: 'broken', label: 'Defekt' },
                    ]}
                    buildOption={option => ({
                        text: option.label,
                        value: option.id,
                    })}
                />

                <MyForm.MultiSelect
                    name="brand" labelText="Marke"
                    maxSelectedItems={1}
                    prepare={async () => {
                        const [data, err] = await client.query('tools.brands', undefined);
                        if (err) throw err;
                        return data ?? [];
                    }}
                    getOptions={({ query, init }) => {
                        const normalized = query.toLowerCase();
                        return init
                            .filter((item) => item.toLowerCase().includes(normalized))
                            .map(item => ({ id: item }));
                    }}
                    renderItem={({ item }) => item.id}
                    renderTile={item => <SmallTile title={item.id} />}
                />

                <MyForm.MultiSelect
                    name="category" labelText="Kategorie"
                    maxSelectedItems={1}
                    prepare={async () => {
                        const [data, err] = await client.query('tools.categories', undefined);
                        if (err) throw err;
                        return data ?? [];
                    }}
                    getOptions={({ query, init }) => {
                        const normalized = query.toLowerCase();
                        return init
                            .filter((item) => item.toLowerCase().includes(normalized))
                            .map(item => ({ id: item }));
                    }}
                    renderItem={({ item }) => item.id}
                    renderTile={item => <SmallTile title={item.id} />}
                />

                <NotifyLoaded onLoad={() => {
                    context.setValues({
                        status: status ?? 'none',
                        brand: brand ? [{ id: brand }] : [],
                        category: category ? [{ id: category }] : [],
                    });
                }} />
            </>,
            onSubmit: ({ context, hide }) => {
                const values = context.getValues();

                if (values.status === 'none') values.status = null;

                setStatus(values.status);
                setBrand(values.brand?.at(0)?.id ?? null);
                setCategory(values.category?.at(0)?.id ?? null);

                hide();
            },
            modalProps: () => ({
                modalHeading: "Werkzeuge filtern",
                primaryButtonText: 'Filter anwenden',
            }),
        });
    }

    const hasFilter = !!(status || brand || category);

    return <>
        <div className="flex gap-2 w-full overlflow-x-auto">
            {!archivedOnly ? (
                <OperationalTag renderIcon={Icons.Archive} text="Nicht Archiviert" onClick={() => setArchivedOnly(true)} />
            ) : (
                <OperationalTag renderIcon={Icons.Archive} text="Archiviert" onClick={() => setArchivedOnly(false)} />
            )}

            {!hasFilter ? <>
                <OperationalTag renderIcon={Icons.Filter} text="Filter" onClick={showFilterModal} />
            </> : <>
                <OperationalTag renderIcon={Icons.FilterEdit} text="Filter ändern" onClick={showFilterModal} />
                <OperationalTag renderIcon={Icons.FilterRemove} text="Filter aus" onClick={() => {
                    setStatus(null);
                    setBrand(null);
                    setCategory(null);
                }} />
            </>}

            <TableExportActions
                title="Werkzeuge"
                fileName={archivedOnly ? 'Archivierte-Werkzeuge' : 'Werkzeuge'}
                rows={filteredData ?? []}
                disabled={!data}
                columns={[
                    { header: 'Nummer', value: tool => tool.customId, align: 'right' },
                    { header: 'Status', value: tool => toolStatus(tool) },
                    { header: 'Marke', value: tool => tool.brand },
                    { header: 'Kategorie', value: tool => tool.category },
                    { header: 'Modell', value: tool => tool.label, width: '2fr' },
                    { header: 'Archiviert am', value: tool => tool.archivedSince },
                ]}
            />
        </div>

        <div style={{ height: '1px' }} />

        <MyTable 
            topPagination
            className=""
            persistentId="Tools"
            rows={filteredData ?? []}
            onRowClick={row => navigate(`/tools/${row.id}`)}
            columns={[
                {
                    label: 'Nummer',
                    render: row => row.customId.toString(),
                    sortKey: row => row.customId,
                },
                {
                    label: 'Status',
                    render: row => <div>
                        <Tag type={toolStatusTagType(row)}>{toolStatus(row)}</Tag>
                    </div>,
                    sortKey: row => toolStatus(row).toLowerCase(),
                },
                {
                    label: 'Marke',
                    render: row => row.brand,
                    sortKey: row => row.brand.toLowerCase(),
                },
                {
                    label: 'Kategorie',
                    render: row => row.category,
                    sortKey: row => row.category.toLowerCase(),
                },
                {
                    label: 'Modell',
                    render: row => row.label,
                    sortKey: row => row.label?.toLowerCase() ?? '',
                },
            ]}
            pagination={{}}
            renderSmallViewport={tool => <SmallToolTile key={tool.id} data={tool} noIcon />}
        />
    </>;
}
