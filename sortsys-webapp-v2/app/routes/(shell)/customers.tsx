import { uiText } from "~/lib/i18n";
import type { Route } from "./+types";
import { useNavigate } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { formatAddress } from "~/lib/format";
import { CustomerTile } from "~/lib/tiles";
import { TableExportActions } from "~/components/TableExportActions";

export function meta({}: Route.MetaArgs) {
  return [
    { title: uiText("Kunden") },
  ];
}

export default function CustomersPage() {
  const navigate = useNavigate();

  const [customers] = useClientStream(() => client.streamQuery('customers.list', {}));

  return <>
    <MyHeader
      title={uiText("Kunden")}
      actions={<TableExportActions
        title={uiText("Kunden")}
        fileName="Kunden"
        rows={customers ?? []}
        disabled={!customers}
        columns={[
          { header: uiText("Anrede"), value: customer => customer.salutation },
          { header: uiText("Name"), value: customer => customer.name, width: '2fr' },
          { header: uiText("Anschrift"), value: customer => formatAddress(customer.address), width: '2fr' },
          { header: uiText("Telefon"), value: customer => customer.phoneNumbers.map(entry => entry.number).join('\n'), width: '2fr' },
          { header: uiText("E-Mail"), value: customer => customer.emailAddresses.map(entry => entry.email).join('\n'), width: '2fr' },
        ]}
      />}
    />

    <MyTable
      className=""
      topPagination
      persistentId="Customers"
      rows={customers ?? []}
      onRowClick={row => navigate(`/customers/${row.id}`)}
      columns={[
        {
          label: uiText("Anrede"),
          render: row => row.salutation,
          sortKey: row => row.salutation?.toLowerCase() ?? '',
        },
        {
          label: uiText("Name"),
          render: row => row.name,
          sortKey: row => row.name.toLowerCase(),
        },
        {
          label: uiText("Anschrift"),
          render: row => formatAddress(row.address),
          sortKey: row => formatAddress(row.address).toLowerCase(),
        },
        {
          label: uiText("Telefon"),
          render: row => row.phoneNumbers.map(entry => entry.number).join('\n'),
          sortKey: row => row.phoneNumbers.map(entry => entry.number).join(' ').toLowerCase(),
        },
        {
          label: uiText("E-Mail"),
          render: row => row.emailAddresses.map(entry => entry.email).join('\n'),
          sortKey: row => row.emailAddresses.map(entry => entry.email).join(' ').toLowerCase(),
        },
      ]}
      pagination={{}}
      renderSmallViewport={customer => <CustomerTile customer={customer} />}
    />
  </>;
}
