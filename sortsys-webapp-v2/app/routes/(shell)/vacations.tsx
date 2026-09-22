import { uiText } from "~/lib/i18n";
import type { Route } from "./+types/vacations";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { formatDate, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import type { User } from "~/type-helpers";
import { useMemo, useState } from "react";
import { TableExportActions } from "~/components/TableExportActions";
import { showCreateAbsenceModal } from "~/modals/absences";

type AbsenceType = 'vacation' | 'other';
type VacationStatus = 'requested' | 'approved' | 'denied';

type VacationUsage = {
  year: number;
  allowanceDays: number | null;
  approvedDays: number;
  requestedDays: number;
  remainingAfterApproval: number | null;
};

type VacationRow = {
  id: string;
  userId: string;
  from: Date;
  to: Date;
  type: AbsenceType;
  label: string | null;
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
  vacationUsage: VacationUsage[];
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: uiText("Abwesenheiten", "Absences") },
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

  function showAbsenceForm() {
    showCreateAbsenceModal(modals, {
      users: users ?? [],
      currentUser: sessionInfo.user as User,
      canManage: canManageVacations,
      onCreated: reload,
    });
  }

  useShortcut('Control+n', e => {
    e.preventDefault();
    showAbsenceForm();
  });

  function showDenyModal(vacation: VacationRow) {
    modals.showForm({
      content: () => <MyForm.Input required autoFocus textArea name="reason" labelText={uiText("Ablehnungsgrund")} />,
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
        modalHeading: uiText("Abwesenheit ablehnen", "Reject absence"),
        primaryButtonText: uiText("Ablehnen"),
        noFullscreen: true,
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

  function showApproveModal(vacation: VacationRow) {
    const user = userMap.get(vacation.userId);
    const missingAllowance = vacation.vacationUsage.some(usage => usage.allowanceDays === null);
    const exceededAllowance = vacation.vacationUsage.find(usage =>
      usage.remainingAfterApproval !== null && usage.remainingAfterApproval < 0
    );

    modals.showDefault({
      content: () => <div className="flex flex-col gap-3">
        <p>{uiText(
          `${absenceLabel(vacation)} für ${user ? userFullName(user) : 'den Benutzer'} vom ${formatDate(vacation.from)} bis ${formatDate(vacation.to)} freigeben?`,
          `Approve ${absenceLabel(vacation).toLowerCase()} for ${user ? userFullName(user) : 'the user'} from ${formatDate(vacation.from)} to ${formatDate(vacation.to)}?`,
        )}</p>

        {vacation.type === 'vacation' && missingAllowance && <MyCallout
          kind="warning"
          title={uiText("Kein Urlaubsanspruch hinterlegt", "No leave allowance recorded")}
          subtitle={uiText("Die Freigabe ist trotzdem möglich.", "The request can still be approved.")}
        />}

        {!!exceededAllowance && <MyCallout
          kind="warning"
          title={uiText("Urlaubsanspruch wird überschritten", "Leave allowance will be exceeded")}
          subtitle={uiText(
            `${Math.abs(exceededAllowance.remainingAfterApproval ?? 0)} Arbeitstage über dem Anspruch für ${exceededAllowance.year}.`,
            `${Math.abs(exceededAllowance.remainingAfterApproval ?? 0)} working days over the allowance for ${exceededAllowance.year}.`,
          )}
        />}

        {vacation.type === 'vacation' && vacation.vacationUsage.map(usage => <div key={usage.year}>
          <strong>{usage.year}</strong>
          <div>{uiText(
            `${usage.approvedDays} bereits freigegeben · ${usage.requestedDays} beantragt`,
            `${usage.approvedDays} already approved · ${usage.requestedDays} requested`,
          )}</div>
          {usage.allowanceDays !== null && <div>{uiText(
            `${usage.remainingAfterApproval} von ${usage.allowanceDays} Arbeitstagen verbleiben`,
            `${usage.remainingAfterApproval} of ${usage.allowanceDays} working days remaining`,
          )}</div>}
        </div>)}
      </div>,
      onPrimaryAction: async ({ hide }) => {
        const ok = await runVacationAction(`approve:${vacation.id}`, async () => {
          const [result, approveErr] = await client.mutate('users.vacations.approve', { id: vacation.id });
          if (approveErr) throw approveErr;
          if (result) reload();
        });

        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: uiText("Abwesenheit freigeben", "Approve absence"),
        primaryButtonText: uiText("Freigeben", "Approve"),
        secondaryButtonText: uiText("Abbrechen", "Cancel"),
        noFullscreen: true,
      }),
    });
  }

  function showDeleteVacationModal(vacation: VacationRow) {
    modals.showDefault({
      content: () => <p>
        {uiText(
          `${absenceLabel(vacation)} vom ${formatDate(vacation.from)} bis ${formatDate(vacation.to)} löschen?`,
          `Delete ${absenceLabel(vacation).toLowerCase()} from ${formatDate(vacation.from)} to ${formatDate(vacation.to)}?`,
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
        modalHeading: uiText("Abwesenheit löschen", "Delete absence"),
        primaryButtonText: uiText("Löschen", "Delete"),
        secondaryButtonText: uiText("Abbrechen", "Cancel"),
      }),
    });
  }

  return <>
    <MyHeader
      title={uiText("Abwesenheiten", "Absences")}
      actions={<>
        <TableExportActions
          title={uiText("Abwesenheiten", "Absences")}
          fileName={uiText("Abwesenheiten", "Absences")}
          rows={rows}
          disabled={!vacations}
          columns={[
            { header: uiText("Benutzer"), value: row => userMap.get(row.userId) ? userFullName(userMap.get(row.userId)!) : uiText('Unbekannter Benutzer'), width: '2fr' },
            { header: uiText("Typ", "Type"), value: row => absenceTypeLabel(row.type) },
            { header: uiText("Bezeichnung", "Label"), value: row => row.label ?? '' },
            { header: uiText("Von"), value: row => row.from },
            { header: uiText("Bis"), value: row => row.to },
            { header: uiText("Status"), value: row => vacationStatusLabel(row.status) },
            { header: uiText("Kommentar"), value: row => row.status === 'denied' ? row.denialReason ?? '' : row.note ?? '', width: '2fr' },
            { header: uiText("Entschieden am"), value: row => row.decidedAt },
          ]}
        />
        <MyButton renderIcon={Icons.Plus} onClick={showAbsenceForm}>
          {canManageVacations ? uiText('Abwesenheit eintragen', 'Add absence') : uiText('Abwesenheit beantragen', 'Request absence')}
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
          label: uiText("Typ", "Type"),
          render: row => absenceTypeLabel(row.type),
          sortKey: row => row.type,
        },
        {
          label: uiText("Bezeichnung", "Label"),
          render: row => row.label ?? '–',
          sortKey: row => row.label?.toLowerCase() ?? '',
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
            {row.canApprove && <MyButton size="sm" kind="ghost" renderIcon={Icons.Accept} loading={pendingAction === `approve:${row.id}`} disabled={!!pendingAction} onClick={() => showApproveModal(row)}>{uiText("Freigeben")}</MyButton>}
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

function absenceTypeLabel(type: AbsenceType) {
  return type === 'vacation'
    ? uiText('Urlaub', 'Leave')
    : uiText('Sonstige Abwesenheit', 'Other absence');
}

function absenceLabel(absence: Pick<VacationRow, 'type' | 'label'>) {
  return absence.type === 'vacation'
    ? absenceTypeLabel('vacation')
    : absence.label?.trim() || absenceTypeLabel('other');
}

function vacationStatusLabel(status: VacationStatus) {
  if (status === 'approved') return uiText('Freigegeben', 'Approved');
  if (status === 'denied') return uiText('Abgelehnt', 'Denied');
  return uiText('Beantragt');
}
