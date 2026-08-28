import { uiText } from "~/lib/i18n";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import type { ProductVendor } from "~/type-helpers";

type CreateProductVendorModalOptions = {
  initialQuery?: string;
  onCreated?: (vendor: ProductVendor) => void | Promise<void>;
};

export function showCreateProductVendorModal(modals: MyModalsInterface, options: CreateProductVendorModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.Input required name="name" labelText={uiText("Name")} />
      <MyForm.Input name="description" labelText={uiText("Beschreibung")} />
      {!!options.initialQuery && <NotifyLoaded onLoad={() => context.field('name')?.setValue(options.initialQuery)} />}
    </>,
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const [data, err] = await client.mutate('products.vendors.create', {
        name: values.name,
        description: values.description,
      });

      if (err) throw err;
      if (!data) return;

      if (options.onCreated) {
        const [created, loadErr] = await client.query('products.vendors.get', { id: data.id }, { strategy: 'network-first' });
        if (loadErr) throw loadErr;
        if (created) await options.onCreated(created);
        hide();
        return;
      }

      navigate(`/products/vendors/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Händler erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showModifyProductVendorModal(modals: MyModalsInterface, vendor: ProductVendor) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.Input required name="name" labelText={uiText("Name")} />
      <MyForm.Input name="description" labelText={uiText("Beschreibung")} />

      <NotifyLoaded onLoad={() => context.setValues(vendor)} />
    </>,
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const [data, err] = await client.mutate('products.vendors.update', {
        id: vendor.id,
        data: {
          name: values.name,
          description: values.description,
        },
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Händler bearbeiten"),
      modalLabel: vendor.name,
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteProductVendorModal(modals: MyModalsInterface, vendor: ProductVendor) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Händler in Verbindung stehenden Daten werden damit ebenfalls gelöscht.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('products.vendors.delete', { id: vendor.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/products/vendors/${vendor.id}`) navigate('/products/vendors');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Händler löschen"),
      modalLabel: vendor.name,
      primaryButtonText: uiText("Löschen"),
    }),
  });
}
