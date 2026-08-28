import { uiText } from "~/lib/i18n";
import { Fragment, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { contactName, customerName, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import type { Contact, Project } from "~/type-helpers";
import { FormAddress, processFormAddress } from "./_utils";
import { SmallContactTile, SmallCustomerTile, SmallUserTile } from "~/lib/tiles";
import { generateId, parseFloatCustom } from "~/lib/utils";

type ProjectContactFormContact = Contact & { label?: string | null };

type CreateProjectModalOptions = {
  initialQuery?: string;
  onCreated?: (project: Project) => void | Promise<void>;
};

function projectContactPayload(values: Record<string, any>) {
  const rowIds = new Set<string>();

  Object.keys(values).forEach(key => {
    if (!key.startsWith('projectContact:')) return;
    rowIds.add(key.split(':')[1]!);
  });

  return [...rowIds].map(id => {
    const contact = values[`projectContact:${id}:contact`]?.[0] as ProjectContactFormContact | undefined;
    if (!contact?.id) return null;

    return {
      contactId: contact.id,
      label: `${values[`projectContact:${id}:label`] ?? ''}`.trim() || null,
    };
  }).filter(Boolean) as { contactId: string; label: string | null }[];
}

function ProjectContactsFormFields({ context, modals, projectId }: {
  context: MyPublicFormContext;
  modals: MyModalsInterface;
  projectId?: string;
}) {
  const createEntityAction = useCreateEntityAction(modals);
  const [rowIds, setRowIds] = useState<string[]>([]);
  const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
  const initialValues = useRef<Record<string, { contact: ProjectContactFormContact; label: string | null }>>({}).current;

  return <>
    <h4>{uiText("Ansprechpartner")}</h4>
    <p className="light">{uiText("Mehrere Ansprechpartner können hinterlegt werden.")}</p>

    {rowIds.map(id => <Fragment key={id}>
      <div className="flex gap-2 items-end">
        <div className="grow flex flex-col gap-2">
          <MyForm.MultiSelect
            labelText={uiText("Kontakt")}
            name={`projectContact:${id}:contact`}
            autoFocus={autoFocusFieldName === `projectContact:${id}:contact`}
            minSelectedItems={1}
            maxSelectedItems={1}
            getOptions={async ({ query }) => {
              const [data, err] = await client.query('contacts.list', { search: query });
              if (err) throw err;
              return data ?? [];
            }}
            renderItem={({ item }) => contactName(item)}
            renderTile={item => <SmallContactTile data={item} noLink />}
            createAction={createEntityAction.contact}
          />

          <MyForm.Input
            name={`projectContact:${id}:label`}
            labelText={uiText("Rolle")}
            suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Ansprechpartner entfernen")} aria-label={uiText("Ansprechpartner entfernen")} onClick={() => {
              setRowIds(ids => ids.filter(_id => _id !== id));
            }}><Icons.Delete /></MyButton>}
          />
        </div>
      </div>

      <NotifyLoaded onLoad={() => {
        const initial = initialValues[id];
        if (!initial) return;

        context.setValues({
          [`projectContact:${id}:contact`]: [initial.contact],
          [`projectContact:${id}:label`]: initial.label ?? '',
        });
      }} />

      <div style={{ height: '1rem' }} />
    </Fragment>)}

    <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
      const id = generateId();
      setRowIds(ids => [...ids, id]);
      setAutoFocusFieldName(`projectContact:${id}:contact`);
    }}>{uiText("Ansprechpartner")}</MyButton>

    {!!projectId && <NotifyLoaded onLoad={async () => {
      const [contacts] = await client.query('projects.contacts.list', { projectId });
      if (!contacts) return;

      const ids = contacts.map(() => generateId());
      contacts.forEach((contact, index) => {
        initialValues[ids[index]!] = { contact, label: contact.label ?? null };
      });
      setRowIds(ids);
    }} />}
  </>;
}

export function showCreateProjectModal(modals: MyModalsInterface, options: CreateProjectModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.Input required name="title" labelText={uiText("Titel")} />
      {!!options.initialQuery && <NotifyLoaded onLoad={() => context.field('title')?.setValue(options.initialQuery)} />}
      <p className="light">{uiText("Verwende einen klaren Projektnamen, damit das Projekt in Listen schnell gefunden wird.")}</p>

      <MyForm.DateInput
        name="orderReceivedAt"
        labelText={uiText("Auftrag erhalten am")}
      />
      <p className="light">{uiText("Wann wurde der Auftrag bestätigt bzw. erhalten?")}</p>

      <MyDivider />

      <FormAddress />

      <MyDivider />

      <MyForm.MultiSelect
        labelText={uiText("Kunde")}
        name="customer"
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('customers.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => customerName(item)}
        renderTile={item => <SmallCustomerTile data={item} noLink />}
        createAction={createEntityAction.customer}
      />
      <p className="light">{uiText("Kunde für Zuordnung in Auswertungen und Exporten.")}</p>

      <MyForm.MultiSelect
        labelText={uiText("Verantwortlicher Projektleiter")}
        name="responsibleProjectLeader"
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('users.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => userFullName(item)}
        renderTile={item => <SmallUserTile data={item} noLink />}
        createAction={createEntityAction.user}
      />
      <p className="light">{uiText("Wer verantwortet das Projekt übergreifend?")}</p>

      <ProjectContactsFormFields context={context} modals={modals} />
    </>;
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      processFormAddress(values);

      const [data, err] = await client.mutate('projects.create', {
        title: values.title,
        address: values.address,
        customerId: values.customer.at(0)?.id ?? null,
        responsibleProjectLeaderUserId: values.responsibleProjectLeader?.at(0)?.id ?? null,
        orderReceivedAt: values.orderReceivedAt ?? null,
      });

      if (err) throw err;
      if (!data) return;

      const projectContacts = projectContactPayload(values);
      if (projectContacts.length) await client.mutate('projects.contacts.set', {
        projectId: data.id,
        contacts: projectContacts,
      });

      if (options.onCreated) {
        const [created, loadErr] = await client.query('projects.get', { id: data.id }, { strategy: 'network-first' });
        if (loadErr) throw loadErr;
        if (created) await options.onCreated(created);
        hide();
        return;
      }

      navigate(`/projects/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Projekt erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showModifyProjectModal(modals: MyModalsInterface, project: Project) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.Input required name="title" labelText={uiText("Titel")} />
      <p className="light">{uiText("Änderungen am Titel wirken sich direkt auf Suche, Listen und Exporte aus.")}</p>

      <MyForm.DateInput
        name="orderReceivedAt"
        labelText={uiText("Auftrag erhalten am")}
      />
      <p className="light">{uiText("Wann wurde der Auftrag bestätigt bzw. erhalten?")}</p>

      <MyDivider />

      <FormAddress initialChecked={!!project.address}>
        <NotifyLoaded onLoad={() => context.setValues(project.address ?? {})} />
      </FormAddress>

      <MyDivider />

      <MyForm.MultiSelect
        labelText={uiText("Kunde")}
        name="customer"
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('customers.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => customerName(item)}
        renderTile={item => <SmallCustomerTile data={item} noLink />}
        createAction={createEntityAction.customer}
      />
      <p className="light">{uiText("Kunde für Zuordnung in Auswertungen und Exporten.")}</p>

      <MyForm.MultiSelect
        labelText={uiText("Verantwortlicher Projektleiter")}
        name="responsibleProjectLeader"
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('users.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => userFullName(item)}
        renderTile={item => <SmallUserTile data={item} noLink />}
        createAction={createEntityAction.user}
      />
      <p className="light">{uiText("Wer verantwortet das Projekt übergreifend?")}</p>

      <ProjectContactsFormFields context={context} modals={modals} projectId={project.id} />

      <NotifyLoaded onLoad={() => {
        context.setValues(project);

        if (project.customerId) client.query('customers.get', { id: project.customerId }).then(([data]) => {
          if (data) context.setValues({ customer: [data] });
        });

        if (project.responsibleProjectLeaderUserId) client.query('users.get', { id: project.responsibleProjectLeaderUserId }).then(([data]) => {
          if (data) context.setValues({ responsibleProjectLeader: [data] });
        });

      }} />
    </>;
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      processFormAddress(values);

      const [[data, err]] = await Promise.all([
        client.mutate('projects.update', {
          id: project.id,
          data: {
            title: values.title,
            address: values.address,
            customerId: values.customer.at(0)?.id ?? null,
            responsibleProjectLeaderUserId: values.responsibleProjectLeader?.at(0)?.id ?? null,
            orderReceivedAt: values.orderReceivedAt ?? null,
          },
        }),
        client.mutate('projects.contacts.set', {
          projectId: project.id,
          contacts: projectContactPayload(values),
        }),
      ]);

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Projekt bearbeiten"),
      primaryButtonText: uiText("Speichern"),
      modalLabel: project.title,
    }),
  });
}

export function showDeleteProjectModal(modals: MyModalsInterface, project: Project) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Projekt in Verbindung stehenden Daten werden damit ebenfalls gelöscht.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('projects.delete', { id: project.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/projects/${project.id}`) navigate('/projects');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Projekt löschen"),
      modalLabel: project.title,
      primaryButtonText: uiText("Löschen"),
    }),
  });
}

export function showCreateProjectInterruptionModal(modals: MyModalsInterface, project: Project) {
  modals.showForm({
    content: ({ context }) => <>
      <div className="flex gap-2">
        <div className="basis-1/2 flex-1">
          <MyForm.DateInput required name="from" labelText={uiText("Von")} />
        </div>
        <div className="basis-1/2 flex-1">
          <MyForm.DateInput required name="to" labelText={uiText("Bis")} />
        </div>
      </div>

      <MyForm.Input required name="reason" labelText={uiText("Grund")} />
      <MyForm.Input textArea name="note" labelText={uiText("Kommentar")} />
      <p className="light">{uiText("Unterbrechungen erscheinen in der Einsatzplanung und markieren betroffene Einsätze.")}</p>

      <NotifyLoaded onLoad={() => {
        const today = startOfDay(new Date());
        context.setValues({
          from: today,
          to: today,
        });
      }} />
    </>,
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      const from = parseDateValue(values.from);
      const to = parseDateValue(values.to);
      if (!from || !to) throw new Error(uiText("Datum ist ungültig."));
      if (from.getTime() > to.getTime()) throw new Error(uiText("Von muss vor Bis liegen."));

      const reason = `${values.reason ?? ''}`.trim();
      if (!reason) throw new Error(uiText("Grund fehlt."));

      const [data, err] = await client.mutate('projects.unavailability.create', {
        projectId: project.id,
        from,
        to,
        reason,
        note: `${values.note ?? ''}`.trim() || null,
      });
      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Unterbrechung eintragen"),
      modalLabel: project.title,
      primaryButtonText: uiText("Eintragen"),
      noFullscreen: true,
    }),
  });
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function parseDateValue(value: unknown) {
  const date = value instanceof Date ? new Date(value) : new Date(`${value ?? ''}`);
  if (isNaN(date.getTime())) return null;
  return startOfDay(date);
}

type ProjectFinancialEntryType = 'offer' | 'invoice';

export type ProjectFinancialEntry = {
  id: string;
  projectId: string;
  type: ProjectFinancialEntryType;
  amount: number;
  comment: string | null;
  createdAt: Date;
  createdByUserId: string | null;
};

const financialEntryConfig: Record<ProjectFinancialEntryType, {
  createHeading: string;
  editHeading: string;
  deleteHeading: string;
  deleteNoun: string;
  label: string;
}> = {
  offer: {
    createHeading: uiText("Angebotssumme erfassen", "Record quotation total"),
    editHeading: uiText("Angebotssumme bearbeiten", "Edit quotation total"),
    deleteHeading: uiText("Angebotssumme löschen", "Delete quotation total"),
    deleteNoun: uiText("Angebotssumme", "quotation total"),
    label: uiText("Angebotssumme (EUR)"),
  },
  invoice: {
    createHeading: uiText("Rechnungssumme erfassen", "Record invoice total"),
    editHeading: uiText("Rechnungssumme bearbeiten", "Edit invoice total"),
    deleteHeading: uiText("Rechnungssumme löschen", "Delete invoice total"),
    deleteNoun: uiText("Rechnungssumme", "invoice total"),
    label: uiText("Rechnungssumme (EUR)"),
  },
};

function showCreateProjectFinancialEntryModal(modals: MyModalsInterface, project: Project, type: ProjectFinancialEntryType) {
  const config = financialEntryConfig[type];

  modals.showForm({
    content: () => <>
      <MyForm.Input
        required
        name="amount"
        labelText={config.label}
        rules={[MyForm.Input.rules.posnum]}
      />
      <p className="light">{uiText("Betrag als Nettowert in EUR eintragen, z.B. laut Angebot oder Rechnung.")}</p>

      <MyForm.Input
        textArea
        name="comment"
        labelText={uiText("Kommentar")}
      />
    </>,
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      const amount = parseFloatCustom(values.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;

      const [data, err] = await client.mutate('projects.costs.entries.create', {
        projectId: project.id,
        type,
        amount,
        comment: values.comment?.trim() ? values.comment.trim() : null,
      });

      if (err) throw err;
      if (!data) return;

      await client.invalidateCascading('projects.costs.get');

      hide();
    },
    modalProps: () => ({
      modalHeading: config.createHeading,
      modalLabel: project.title,
      primaryButtonText: uiText("Speichern"),
      noFullscreen: true,
    }),
  });
}

export function showCreateProjectOfferModal(modals: MyModalsInterface, project: Project) {
  showCreateProjectFinancialEntryModal(modals, project, 'offer');
}

export function showCreateProjectInvoiceModal(modals: MyModalsInterface, project: Project) {
  showCreateProjectFinancialEntryModal(modals, project, 'invoice');
}

export function showModifyProjectFinancialEntryModal(
  modals: MyModalsInterface,
  project: Project,
  entry: ProjectFinancialEntry,
) {
  const config = financialEntryConfig[entry.type];

  modals.showForm({
    content: ({ context }) => <>
      <MyForm.Input
        required
        name="amount"
        labelText={config.label}
        rules={[MyForm.Input.rules.posnum]}
      />
      <p className="light">{uiText("Betrag als Nettowert in EUR eintragen, z.B. laut Angebot oder Rechnung.")}</p>

      <MyForm.Input
        textArea
        name="comment"
        labelText={uiText("Kommentar")}
      />

      <NotifyLoaded onLoad={() => {
        context.setValues({
          amount: `${entry.amount}`,
          comment: entry.comment ?? '',
        });
      }} />
    </>,
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      const amount = parseFloatCustom(values.amount);
      if (!Number.isFinite(amount) || amount <= 0) return;

      const [data, err] = await client.mutate('projects.costs.entries.update', {
        projectId: project.id,
        id: entry.id,
        data: {
          amount,
          comment: values.comment?.trim() ? values.comment.trim() : null,
        },
      });

      if (err) throw err;
      if (!data) return;

      await client.invalidateCascading('projects.costs.get');

      hide();
    },
    modalProps: () => ({
      modalHeading: config.editHeading,
      modalLabel: project.title,
      primaryButtonText: uiText("Speichern"),
      noFullscreen: true,
    }),
  });
}

export function showDeleteProjectFinancialEntryModal(
  modals: MyModalsInterface,
  project: Project,
  entry: ProjectFinancialEntry,
) {
  const config = financialEntryConfig[entry.type];

  modals.showDefault({
    content: () => <>
      <p>{uiText("Soll die")}<b>{config.deleteNoun}</b>{uiText(" über ")}<b>{entry.amount.toFixed(2)}{uiText(" EUR")}</b>{uiText("wirklich gelöscht werden?")}{' '}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      {!!entry.comment && <p className="light">{uiText("Kommentar: ")}{entry.comment}</p>}
    </>,
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: config.deleteHeading,
      modalLabel: project.title,
      primaryButtonText: uiText("Löschen"),
    }),
    onPrimaryAction: async ({ hide }) => {
      const [data, err] = await client.mutate('projects.costs.entries.delete', {
        projectId: project.id,
        id: entry.id,
      });

      if (err) throw err;
      if (!data) return;

      await client.invalidateCascading('projects.costs.get');

      hide();
    },
  });
}
