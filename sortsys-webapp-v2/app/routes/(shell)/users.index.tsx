import { useNavigate } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { MyTable } from "~/components/MyTable";
import { userContractName } from "~/lib/format";
import { SmallUserTile } from "~/lib/tiles";
import { OperationalTag } from "@sortsys/react-components";
import { Icons } from "~/lib/icons";
import { useBoolUrlParam } from "~/hooks/useUrlParam";
import { TableExportActions } from "~/components/TableExportActions";

export function meta() {
  return [
    { title: "Benutzer" },
  ];
}

export default function UsersPage() {
  const navigate = useNavigate();

  const [archivedOnly, setArchivedOnly] = useBoolUrlParam('archived');
  const [users] = useClientStream(() => client.streamQuery('users.list', {
    includeArchived: archivedOnly || undefined,
  }), [archivedOnly]);

  const visibleUsers = archivedOnly
    ? (users ?? []).filter(user => !!user.archivedAt)
    : (users ?? []);

  return <>
    <div className="flex gap-2 w-full overlflow-x-auto">
      {!archivedOnly ? (
        <OperationalTag renderIcon={Icons.Archive} text="Nicht Archviert" onClick={() => setArchivedOnly(true)} />
      ) : (
        <OperationalTag renderIcon={Icons.Archive} text="Archiviert" onClick={() => setArchivedOnly(false)} />
      )}

      <TableExportActions
        title="Benutzer"
        fileName={archivedOnly ? 'Archivierte-Benutzer' : 'Benutzer'}
        rows={visibleUsers}
        disabled={!users}
        columns={[
          { header: 'Vorname', value: user => user.firstName },
          { header: 'Nachname', value: user => user.lastName },
          { header: 'Vertrag', value: user => userContractName(user) },
          { header: 'E-Mail', value: user => user.email, width: '2fr' },
          { header: 'Telefon', value: user => user.phone },
          { header: 'Deaktiviert am', value: user => user.deactivatedAt },
        ]}
      />
    </div>

    <div style={{ height: '1px' }} />
    
    <MyTable
      topPagination
      className=""
      persistentId="Users"
      rows={visibleUsers}
      onRowClick={row => navigate(`/users/${row.id}`)}
      columns={[
        {
          label: 'Vorname',
          render: row => row.firstName,
          sortKey: row => row.firstName.toLowerCase(),
        },
        {
          label: 'Nachname',
          render: row => row.lastName,
          sortKey: row => row.lastName?.toLowerCase() ?? '',
        },
        // {
        //   label: 'E-Mail',
        //   render: row => row.email,
        //   sortKey: row => row.email?.toLowerCase() ?? '',
        // },
        // {
        //   label: 'Telefon',
        //   render: row => row.phone,
        //   sortKey: row => row.phone?.toLowerCase() ?? '',
        // },
        {
          label: 'Vertrag',
          render: row => userContractName(row),
          sortKey: row => userContractName(row).toLowerCase(),
        },
      ]}
      pagination={{}}
      renderSmallViewport={user => <SmallUserTile data={user} />}
    />
  </>;
}
