import type { Route } from "./+types";
import { useNavigate } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { ContactTile } from "~/lib/tiles";
import { TableExportActions } from "~/components/TableExportActions";
import { formatAddress } from "~/lib/format";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Kontakte" },
  ];
}

export default function CustomersPage() {
  const navigate = useNavigate();

  const [constacts] = useClientStream(() => client.streamQuery('contacts.list', {}));

  return <>
    <MyHeader
      title="Kontakte"
      actions={<TableExportActions
        title="Kontakte"
        fileName="Kontakte"
        rows={constacts ?? []}
        disabled={!constacts}
        columns={[
          { header: 'Anrede', value: contact => contact.salutation },
          { header: 'Vorname', value: contact => contact.firstName },
          { header: 'Nachname', value: contact => contact.lastName },
          { header: 'Anschrift', value: contact => formatAddress(contact.address), width: '2fr' },
          { header: 'Telefon', value: contact => contact.phoneNumbers.map(entry => entry.number).join('\n'), width: '2fr' },
          { header: 'E-Mail', value: contact => contact.emailAddresses.map(entry => entry.email).join('\n'), width: '2fr' },
        ]}
      />}
    />

    <MyTable
      topPagination
      className=""
      persistentId="Contacts"
      rows={constacts ?? []}
      onRowClick={row => navigate(`/contacts/${row.id}`)}
      columns={[
        {
          label: 'Anrede',
          render: row => row.salutation,
          sortKey: row => row.salutation?.toLowerCase() ?? '',
        },
        {
          label: 'Vorname',
          render: row => row.firstName ?? '',
          sortKey: row => row.firstName?.toLowerCase() ?? '',
        },
        {
          label: 'Nachname',
          render: row => row.lastName,
          sortKey: row => row.lastName?.toLowerCase() ?? '',
        },
        {
          label: 'Anschrift',
          render: row => formatAddress(row.address),
          sortKey: row => formatAddress(row.address).toLowerCase(),
        },
      ]}
      pagination={{}}
      renderSmallViewport={contact => <ContactTile contact={contact} />}
    />
  </>;
}
