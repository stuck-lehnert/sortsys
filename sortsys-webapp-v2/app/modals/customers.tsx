import { uiText } from "~/lib/i18n";
import { MyDivider } from '~/components/MyDivider';
import { MyForm } from '~/components/MyForm';
import { useCreateEntityAction } from '~/hooks/useCreateEntityAction';
import type { MyModalsInterface } from '~/hooks/useMyModals';
import { ContactChannelsFormFields, FormAddress, processContactChannels, processFormAddress } from './_utils';
import { client } from '~/lib/client';
import { contactName, customerName } from '~/lib/format';
import type { Customer } from '~/type-helpers';
import { NotifyLoaded } from '~/components/NotifyLoaded';

type CreateCustomerModalOptions = {
  initialQuery?: string;
  onCreated?: (customer: Customer) => void | Promise<void>;
};

export function showCreateCustomerModal(modals: MyModalsInterface, options: CreateCustomerModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.Input name="salutation" labelText={uiText("Anrede")} />
      <MyForm.Input required name="name" labelText={uiText("Name")} />
      {!!options.initialQuery && <NotifyLoaded onLoad={() => context.field('name')?.setValue(options.initialQuery)} />}

      <MyDivider />

      <FormAddress />

      <MyDivider />

      <ContactChannelsFormFields />

      <MyDivider />

      <MyForm.MultiSelect
        labelText={uiText("Ansprechpartner")}
        name="contacts"
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('contacts.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => contactName(item)}
        createAction={createEntityAction.contact}
      />
    </>;
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();
      processFormAddress(values);
      const { emailAddresses, phoneNumbers } = processContactChannels(values);

      const [data, err] = await client.mutate('customers.create', {
        name: values.name,
        salutation: values.salutation,
        address: values.address,
        emailAddresses,
        phoneNumbers,
      });

      if (err) throw err;
      if (!data) return;

      if (values.contacts.length) await client.mutate('customers.contacts.set', {
        customerId: data.id,
        contactIds: (values.contacts as any[]).map(contact => contact.id),
      });

      if (options.onCreated) {
        const [created, loadErr] = await client.query('customers.get', { id: data.id }, { strategy: 'network-first' });
        if (loadErr) throw loadErr;
        if (created) await options.onCreated(created);
        hide();
        return;
      }

      navigate(`/customers/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Kunde erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showModifyCustomerModal(modals: MyModalsInterface, customer: Customer) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.Input name="salutation" labelText={uiText("Anrede")} />
      <MyForm.Input required name="name" labelText={uiText("Name")} />

      <MyDivider />

      <FormAddress initialChecked={!!customer.address}>
        <NotifyLoaded onLoad={() => context.setValues(customer.address ?? {})} />
      </FormAddress>

      <MyDivider />

      <ContactChannelsFormFields phoneNumbers={customer.phoneNumbers} emailAddresses={customer.emailAddresses} />

      <MyDivider />

      <MyForm.MultiSelect
        labelText={uiText("Ansprechpartner")}
        name="contacts"
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('contacts.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => contactName(item)}
        createAction={createEntityAction.contact}
      />

      <NotifyLoaded onLoad={() => {
        context.setValues(customer);

        client.query('customers.contacts.list', { customerId: customer.id }).then(([data]) => {
          if (data) context.setValues({ contacts: data });
        });
      }} />
    </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      processFormAddress(values);
      const { emailAddresses, phoneNumbers } = processContactChannels(values);
      
      const [[data, err]] = await Promise.all([
        client.mutate('customers.update', {
          id: customer.id,
          data: {
            name: values.name,
            salutation: values.salutation,
            address: values.address,
            emailAddresses,
            phoneNumbers,
          },
        }),
        client.mutate('customers.contacts.set', {
          customerId: customer.id,
          contactIds: (values.contacts as any[]).map(contact => contact.id),
        })
      ]);

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Kunde bearbeiten"),
      modalLabel: customerName(customer),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteCustomerModal(modals: MyModalsInterface, customer: Customer) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Kunden in Verbindung stehenden Daten werden damit ebenfalls gelöscht.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('customers.delete', { id: customer.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/customers/${customer.id}`) navigate('/customers');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Kunde löschen"),
      modalLabel: customerName(customer),
      primaryButtonText: uiText("Löschen"),
    }),
  });
}
