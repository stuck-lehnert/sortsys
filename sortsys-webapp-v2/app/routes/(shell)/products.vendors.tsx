import { useNavigate } from "react-router";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import type { Route } from "./+types";
import { SmallProductVendorTile } from "~/lib/tiles";
import { TableExportActions } from "~/components/TableExportActions";

export const meta: Route.MetaFunction = () => [
  { title: 'Händler' },
];

export default function ProductVendorsPage() {
  const navigate = useNavigate();

  const [vendors] = useClientStream(() => client.streamQuery('products.vendors.list', {}), []);

  return <>
    <div className="flex gap-2 w-full overflow-x-auto">
      <TableExportActions
        title="Händler"
        fileName="Haendler"
        rows={vendors ?? []}
        disabled={!vendors}
        columns={[
          { header: 'Name', value: vendor => vendor.name, width: '2fr' },
          { header: 'Beschreibung', value: vendor => vendor.description, width: '2fr' },
          { header: 'Erstellt am', value: vendor => vendor.createdAt },
          { header: 'Geändert am', value: vendor => vendor.modifiedAt },
        ]}
      />
    </div>

    <div style={{ height: '1px' }} />

    <MyTable
      topPagination
      className=""
      rows={vendors ?? []}
      columns={[
        {
          label: 'Name',
          render: row => row.name,
          sortKey: row => row.name.toLowerCase(),
        },
        {
          label: 'Beschreibung',
          render: row => row.description,
          sortKey: row => row.description?.toLowerCase() ?? '',
        },
      ]}
      pagination={{}}
      onRowClick={row => navigate(`/products/vendors/${row.id}`)}
      renderSmallViewport={row => <SmallProductVendorTile data={row} />}
    />
  </>;
}
