import { uiText } from "~/lib/i18n";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { contactName } from "~/lib/format";
import type { Contact } from "~/type-helpers";
import { ContactChannelsFormFields, FormAddress, processContactChannels, processFormAddress } from "./_utils";

type CreateContactModalOptions = {
  initialQuery?: string;
  onCreated?: (contact: Contact) => void | Promise<void>;
};

function splitContactQuery(query: string | undefined) {
  const parts = `${query ?? ''}`.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

export function showCreateContactModal(modals: MyModalsInterface, options: CreateContactModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => <>
        <MyForm.Input name="salutation" labelText={uiText("Anrede")} />
        <MyForm.Input name="firstName" labelText={uiText("Vorname")} />
        <MyForm.Input name="lastName" labelText={uiText("Nachname")} />

        {!!options.initialQuery && <NotifyLoaded onLoad={() => context.setValues(splitContactQuery(options.initialQuery))} />}

        <MyDivider />

        <FormAddress />

        <MyDivider />

        <ContactChannelsFormFields />
      </>,
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();
      processFormAddress(values);

      const firstName = `${values.firstName ?? ''}`.trim();
      const lastName = `${values.lastName ?? ''}`.trim();
      if (!firstName && !lastName) throw new Error(uiText("Vorname oder Nachname ist erforderlich"));

      const { emailAddresses, phoneNumbers } = processContactChannels(values);

      const [data, err] = await client.mutate('contacts.create', {
        salutation: values.salutation,
        firstName: firstName || null,
        lastName: lastName || null,
        address: values.address,
        emailAddresses,
        phoneNumbers: phoneNumbers,
      });

      if (err) throw err;
      if (!data) return;

      if (options.onCreated) {
        const [created, loadErr] = await client.query('contacts.get', { id: data.id }, { strategy: 'network-first' });
        if (loadErr) throw loadErr;
        if (created) await options.onCreated(created);
        hide();
        return;
      }

      navigate(`/contacts/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Kontakt erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}


export function showModifyContactModal(modals: MyModalsInterface, contact: Contact) {
  modals.showForm({
    content: ({ context }) => <>
        <MyForm.Input name="salutation" labelText={uiText("Anrede")} />
        <MyForm.Input name="firstName" labelText={uiText("Vorname")} />
        <MyForm.Input name="lastName" labelText={uiText("Nachname")} />

        <MyDivider />

        <FormAddress initialChecked={!!contact.address}>
          <NotifyLoaded onLoad={() => context.setValues(contact.address ?? {})} />
        </FormAddress>

        <MyDivider />

        <ContactChannelsFormFields phoneNumbers={contact.phoneNumbers} emailAddresses={contact.emailAddresses} />

        <NotifyLoaded onLoad={() => {
          context.setValues({
            salutation: contact.salutation,
            firstName: contact.firstName,
            lastName: contact.lastName,
          });

        }} />
      </>,
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();
      processFormAddress(values);

      const firstName = `${values.firstName ?? ''}`.trim();
      const lastName = `${values.lastName ?? ''}`.trim();
      if (!firstName && !lastName) throw new Error(uiText("Vorname oder Nachname ist erforderlich"));

      const { emailAddresses, phoneNumbers } = processContactChannels(values);

      const [data, err] = await client.mutate('contacts.update', {
        id: contact.id,
        data: {
          salutation: values.salutation,
          firstName: firstName || null,
          lastName: lastName || null,
          address: values.address,
          emailAddresses,
          phoneNumbers: phoneNumbers,
        }
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Kontakt bearbeiten"),
      modalLabel: contactName(contact),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}


export function showDeleteContactModal(modals: MyModalsInterface, contact: Contact) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Kontakt in Verbindung stehenden Daten werden damit ebenfalls gelöscht.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('contacts.delete', { id: contact.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/contacts/${contact.id}`) navigate('/contacts');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Kontakt löschen"),
      modalLabel: contactName(contact),
      primaryButtonText: uiText("Löschen"),
    }),
  });
}
