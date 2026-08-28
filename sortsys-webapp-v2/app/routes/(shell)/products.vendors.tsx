import { uiText } from "~/lib/i18n";
import { useNavigate } from "react-router";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import type { Route } from "./+types";
import { SmallProductVendorTile } from "~/lib/tiles";
import { TableExportActions } from "~/components/TableExportActions";

export const meta: Route.MetaFunction = () => [
  { title: uiText("Händler") },
];

export default function ProductVendorsPage() {
  const navigate = useNavigate();

  const [vendors] = useClientStream(() => client.streamQuery('products.vendors.list', {}), []);

  return <>
    <div className="flex gap-2 w-full overflow-x-auto">
      <TableExportActions
        title={uiText("Händler")}
        fileName="Haendler"
        rows={vendors ?? []}
        disabled={!vendors}
        columns={[
          { header: uiText("Name"), value: vendor => vendor.name, width: '2fr' },
          { header: uiText("Beschreibung"), value: vendor => vendor.description, width: '2fr' },
          { header: uiText("Erstellt am"), value: vendor => vendor.createdAt },
          { header: uiText("Geändert am"), value: vendor => vendor.modifiedAt },
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
          label: uiText("Name"),
          render: row => row.name,
          sortKey: row => row.name.toLowerCase(),
        },
        {
          label: uiText("Beschreibung"),
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
