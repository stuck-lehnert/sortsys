import { useState } from "react";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { userFullName } from "~/lib/format";
import { uiText } from "~/lib/i18n";
import { SmallUserTile } from "~/lib/tiles";
import { startOfDay } from "~/lib/utils";
import type { PromiseOr, User } from "~/type-helpers";

type CreateAbsenceModalOptions = {
  users: User[];
  currentUser: User;
  canManage: boolean;
  initialDay?: Date;
  onCreated?: () => PromiseOr<void>;
};

export function showCreateAbsenceModal(
  modals: MyModalsInterface,
  options: CreateAbsenceModalOptions,
) {
  modals.showForm({
    content: ({ context }) => {
      const [absenceType, setAbsenceType] = useState<'vacation' | 'other'>('vacation');

      return <>
      <MyForm.Select
        name="absenceType"
        labelText={uiText("Typ", "Type")}
        getOptions={() => [
          { id: 'vacation', text: uiText("Urlaub", "Leave") },
          { id: 'other', text: uiText("Sonstige Abwesenheit", "Other absence") },
        ]}
        buildOption={({ id, text }) => ({ value: id, text })}
        onValueChange={value => setAbsenceType(value === 'other' ? 'other' : 'vacation')}
      />

      {absenceType === 'other' && <MyForm.Input
        required
        autoFocus
        name="label"
        labelText={uiText("Bezeichnung", "Label")}
        maxLength={63}
        placeholder={uiText("z. B. ÜLO oder Schulung", "e.g. training or time off")}
      />}

      {options.canManage && <MyForm.MultiSelect
        name="user"
        labelText={uiText("Benutzer")}
        minSelectedItems={1}
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const needle = query.trim().toLowerCase();
          return options.users.filter(user => {
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
        const initialDay = startOfDay(options.initialDay ?? new Date());
        context.setValues({
          absenceType: 'vacation',
          from: toDateInputValue(initialDay),
          to: toDateInputValue(initialDay),
          user: options.canManage ? [] : [options.currentUser],
        });
      }} />
    </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      const from = parseDateInputValue(values.from);
      const to = parseDateInputValue(values.to);
      if (!from || !to) throw new Error(uiText("Datum ist ungültig.", "The date is invalid."));
      if (from.getTime() > to.getTime()) {
        throw new Error(uiText("Von muss vor Bis liegen.", "From must be before to."));
      }

      const selectedUser = options.canManage
        ? values.user?.at(0) as User | undefined
        : options.currentUser;
      if (!selectedUser) {
        throw new Error(uiText("Benutzer muss ausgewählt sein.", "A user must be selected."));
      }

      const absenceType = values.absenceType === 'other' ? 'other' : 'vacation';
      const label = `${values.label ?? ''}`.trim();
      if (absenceType === 'other' && !label) {
        throw new Error(uiText("Bezeichnung ist erforderlich.", "A label is required."));
      }

      const note = `${values.note ?? ''}`.trim();
      const [created, error] = await client.mutate('users.vacations.create', {
        userId: selectedUser.id,
        from,
        to,
        type: absenceType,
        label: absenceType === 'other' ? label : null,
        note: note || null,
      });
      if (error) throw error;
      if (!created) return;

      await options.onCreated?.();
      hide();
    },
    modalProps: () => ({
      modalHeading: options.canManage
        ? uiText("Abwesenheit eintragen", "Add absence")
        : uiText("Abwesenheit beantragen", "Request absence"),
      primaryButtonText: options.canManage ? uiText("Eintragen", "Add") : uiText("Beantragen", "Request"),
      noFullscreen: true,
    }),
  });
}

function pad2(value: number) {
  return `${value}`.padStart(2, '0');
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

  return startOfDay(date);
}
