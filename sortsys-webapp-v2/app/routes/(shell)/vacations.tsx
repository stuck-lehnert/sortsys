import { uiText } from "~/lib/i18n";
import type { Route } from "./+types/vacations";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { formatDate, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallUserTile } from "~/lib/tiles";
import type { User } from "~/type-helpers";
import { useMemo, useState } from "react";
import { TableExportActions } from "~/components/TableExportActions";

type VacationStatus = 'requested' | 'approved' | 'denied';

type VacationRow = {
  id: string;
  userId: string;
  from: Date;
  to: Date;
  status: VacationStatus;
  note: string | null;
  denialReason: string | null;
  requestedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  modifiedAt: Date;
  canApprove: boolean;
  canDeny: boolean;
  canDelete: boolean;
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: uiText("Urlaub") },
  ];
}

export default function VacationsPage() {
  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const canManageVacations = sessionInfo.canDo('manage:userVacations' as any);
  const canViewUsers = sessionInfo.canDo('view:users');
  const [reloadCounter, setReloadCounter] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [vacations, err] = useClientStream<VacationRow[] | null, any>(() => {
    return client.streamQuery('users.vacations.list', {}, { strategy: 'cache-first' });
  }, [reloadCounter]);
  const [users, usersError] = useClientStream(() => client.streamQuery('users.list', {
    includeArchived: canViewUsers ? true : undefined,
  }), [canViewUsers]);

  const userMap = useMemo(() => {
    const map = new Map<string, User>();
    (users ?? []).forEach(user => map.set(user.id, user));
    map.set(sessionInfo.user.id, sessionInfo.user as User);
    return map;
  }, [sessionInfo.user, users]);

  const rows = (vacations ?? []).map(row => ({ ...row, id: row.id }));

  const reload = () => setReloadCounter(value => value + 1);

  function showVacationForm() {
    modals.showForm({
      content: ({ context }) => <>
        {canManageVacations && <MyForm.MultiSelect
          name="user"
          labelText={uiText("Benutzer")}
          minSelectedItems={1}
          maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const needle = query.trim().toLowerCase();
            return (users ?? []).filter(user => {
              if (!needle) return true;
              return userFullName(user).toLowerCase().includes(needle);
            });
          }}
          renderItem={({ item }) => userFullName(item)}
          renderTile={item => <SmallUserTile data={item} noLink />}
        />}

        <div className="flex gap-2">
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="from" labelText={uiText("Von")} type="date" />
          </div>
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="to" labelText={uiText("Bis")} type="date" />
          </div>
        </div>

        <MyForm.Input textArea name="note" labelText={uiText("Kommentar")} />

        <NotifyLoaded onLoad={() => {
          const today = startOfDay(new Date());
          context.setValues({
            from: toDateInputValue(today),
            to: toDateInputValue(today),
            user: canManageVacations ? [] : [sessionInfo.user],
          });
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const values = context.getValues();
        const from = parseDateInputValue(values.from);
        const to = parseDateInputValue(values.to);
        if (!from || !to) throw new Error(uiText("Datum ist ungültig."));
        if (from.getTime() > to.getTime()) throw new Error(uiText("Von muss vor Bis liegen."));

        const selectedUser = canManageVacations
          ? values.user?.at(0) as User | undefined
          : sessionInfo.user as User;
        if (!selectedUser) throw new Error(uiText("Benutzer muss ausgewählt sein."));

        const noteText = `${values.note ?? ''}`.trim();
        const [created, createErr] = await client.mutate('users.vacations.create', {
          userId: selectedUser.id,
          from,
          to,
          note: noteText ? noteText : null,
        });
        if (createErr) throw createErr;
        if (!created) return;

        reload();
        hide();
      },
      modalProps: () => ({
        modalHeading: canManageVacations ? uiText("Urlaub eintragen") : uiText("Urlaub beantragen"),
        primaryButtonText: canManageVacations ? uiText("Eintragen") : uiText("Beantragen"),
      }),
    });
  }

  useShortcut('Control+n', e => {
    e.preventDefault();
    showVacationForm();
  });

  function showDenyModal(vacation: VacationRow) {
    modals.showForm({
      content: () => <MyForm.Input required textArea name="reason" labelText={uiText("Ablehnungsgrund")} />,
      onSubmit: async ({ context, hide }) => {
        const reason = `${context.getValues().reason ?? ''}`.trim();
        if (!reason) throw new Error(uiText("Ablehnungsgrund fehlt."));
        const [result, denyErr] = await client.mutate('users.vacations.deny', { id: vacation.id, reason });
        if (denyErr) throw denyErr;
        if (!result) return;
        reload();
        hide();
      },
      modalProps: () => ({
        danger: true,
        modalHeading: uiText("Urlaub ablehnen"),
        primaryButtonText: uiText("Ablehnen"),
      }),
    });
  }

  async function runVacationAction(actionName: string, action: () => Promise<void>) {
    setPendingAction(actionName);
    setActionError(null);

    try {
      await action();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : uiText("Die Aktion ist fehlgeschlagen.", "The action failed."));
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function approveVacation(vacation: VacationRow) {
    await runVacationAction(`approve:${vacation.id}`, async () => {
      const [result, approveErr] = await client.mutate('users.vacations.approve', { id: vacation.id });
      if (approveErr) throw approveErr;
      if (result) reload();
    });
  }

  function showDeleteVacationModal(vacation: VacationRow) {
    modals.showDefault({
      content: () => <p>
        {uiText(
          `Urlaub vom ${formatDate(vacation.from)} bis ${formatDate(vacation.to)} löschen?`,
          `Delete vacation from ${formatDate(vacation.from)} to ${formatDate(vacation.to)}?`,
        )} {uiText("Diese Aktion kann nicht rückgängig gemacht werden.", "This action cannot be undone.")}
      </p>,
      onPrimaryAction: async ({ hide }) => {
        const ok = await runVacationAction(`delete:${vacation.id}`, async () => {
          const [result, deleteErr] = await client.mutate('users.vacations.delete', { id: vacation.id });
          if (deleteErr) throw deleteErr;
          if (result) reload();
        });

        if (ok) hide();
      },
      modalProps: () => ({
        danger: true,
        modalHeading: uiText("Urlaub löschen", "Delete vacation"),
        primaryButtonText: uiText("Löschen", "Delete"),
        secondaryButtonText: uiText("Abbrechen", "Cancel"),
      }),
    });
  }

  return <>
    <MyHeader
      title={uiText("Urlaub")}
      actions={<>
        <TableExportActions
          title={uiText("Urlaub")}
          fileName={uiText("Urlaub")}
          rows={rows}
          disabled={!vacations}
          columns={[
            { header: uiText("Benutzer"), value: row => userMap.get(row.userId) ? userFullName(userMap.get(row.userId)!) : uiText('Unbekannter Benutzer'), width: '2fr' },
            { header: uiText("Von"), value: row => row.from },
            { header: uiText("Bis"), value: row => row.to },
            { header: uiText("Status"), value: row => vacationStatusLabel(row.status) },
            { header: uiText("Kommentar"), value: row => row.status === 'denied' ? row.denialReason ?? '' : row.note ?? '', width: '2fr' },
            { header: uiText("Entschieden am"), value: row => row.decidedAt },
          ]}
        />
        <MyButton renderIcon={Icons.Plus} onClick={showVacationForm}>
          {canManageVacations ? uiText('Urlaub eintragen') : uiText('Urlaub beantragen')}
        </MyButton>
      </>}
    />

    {!!usersError && <MyCallout kind="error" title={uiText("Benutzerdaten konnten nicht geladen werden", "User data could not be loaded")} />}

    {!!actionError && <MyCallout kind="error" title={uiText("Aktion fehlgeschlagen", "Action failed")} subtitle={actionError} />}

    <MyTable
      topPagination
      persistentId="Vacations"
      rows={rows}
      loading={!vacations}
      error={err}
      columns={[
        {
          label: uiText("Benutzer"),
          render: row => userMap.get(row.userId) ? userFullName(userMap.get(row.userId)!) : uiText('Unbekannter Benutzer'),
          sortKey: row => userMap.get(row.userId) ? userFullName(userMap.get(row.userId)!).toLowerCase() : '',
        },
        {
          label: uiText("Von"),
          render: row => formatDate(row.from),
          sortKey: row => row.from.getTime(),
        },
        {
          label: uiText("Bis"),
          render: row => formatDate(row.to),
          sortKey: row => row.to.getTime(),
        },
        {
          label: uiText("Status"),
          render: row => vacationStatusLabel(row.status),
          sortKey: row => row.status,
        },
        {
          label: uiText("Kommentar"),
          render: row => row.status === 'denied' ? row.denialReason ?? '' : row.note ?? '',
          sortKey: row => (row.note ?? row.denialReason ?? '').toLowerCase(),
        },
        {
          label: uiText("Aktionen"),
          render: row => <div className="flex gap-1 flex-wrap">
            {row.canApprove && <MyButton size="sm" kind="ghost" renderIcon={Icons.Accept} loading={pendingAction === `approve:${row.id}`} disabled={!!pendingAction} onClick={() => void approveVacation(row)}>{uiText("Freigeben")}</MyButton>}
            {row.canDeny && <MyButton size="sm" kind="ghost" renderIcon={Icons.Deny} onClick={() => showDenyModal(row)}>{uiText("Ablehnen")}</MyButton>}
            {row.canDelete && <MyButton size="sm" kind="ghost" renderIcon={Icons.Delete} disabled={!!pendingAction} onClick={() => showDeleteVacationModal(row)}>{uiText("Löschen")}</MyButton>}
          </div>,
          sortKey: () => '',
        },
      ]}
      pagination={{}}
      autoConvertSmallViewport
    />
  </>;
}

function vacationStatusLabel(status: VacationStatus) {
  if (status === 'approved') return uiText('Freigegeben', 'Approved');
  if (status === 'denied') return uiText('Abgelehnt', 'Denied');
  return uiText('Beantragt');
}

function pad2(value: number) {
  return `${value}`.padStart(2, '0');
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function toDateInputValue(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateInputValue(value: unknown): Date | null {
  const text = `${value ?? ''}`.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year) return null;
  if (date.getMonth() !== month - 1) return null;
  if (date.getDate() !== day) return null;

  date.setHours(0, 0, 0, 0);
  return date;
}
