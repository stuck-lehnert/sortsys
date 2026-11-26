import { uiText } from "~/lib/i18n";
import { useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { productTitle } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProductVendorTile } from "~/lib/tiles";
import { generateId, parseFloatCustom, startOfDay } from "~/lib/utils";
import type { Product } from "~/type-helpers";

type UnitRow = {
  id: string;
  saved?: [name: string, factor: number];
};

function ProductFields({ context, product, initialQuery }: {
  context: MyPublicFormContext;
  product?: Product;
  initialQuery?: string;
}) {
  const [units, setUnits] = useState<UnitRow[]>(() => {
    const savedUnits = Object.entries(product?.otherUnits ?? {});
    return savedUnits.map(saved => ({ id: generateId(), saved }));
  });
  const [focusUnitId, setFocusUnitId] = useState<string | null>(null);

  return <>
    <MyForm.Input required
      name="name" labelText={uiText("Bezeichung")} />

    <MyForm.Input
      name="brand" labelText={uiText("Hersteller")} />

    <MyForm.Input
      name="description" labelText={uiText("Beschreibung")} />

    <MyForm.Input
      name="regieReportName" labelText={uiText("Bezeichnung für Regieberichte", "Designation for time-and-material reports")}
      rules={[MyForm.Input.rules.max(255)]} />
    <p className="light">{uiText("Optional. Ohne Angabe wird im Regiebericht die bisherige Bezeichnung verwendet.", "Optional. If empty, time-and-material reports use the existing designation.")}</p>

    <MyDivider />

    <MyForm.Input required
      name="baseUnit" labelText={uiText("Basiseinheit (kleinste)")}
      rules={[MyForm.Input.rules.max(15)]} />
    <p className="light">{uiText("Beispiel: m, kg oder Stk. Alle weiteren Einheiten werden darauf umgerechnet.")}</p>

    <MyDivider />

    {units.map(({ id, saved }) => <div key={id} className="flex gap-2 items-end">
      <div className="grow flex gap-2">
        <div className="min-w-0 basis-1/2 flex-1">
          <MyForm.Input
            required
            name={`unit:${id}:name`} labelText={uiText("Einheit")}
            focusOnMount={focusUnitId === id}
            suggestions={{
              prepare: async () => {
                const [units] = await client.query('products.units.list', undefined);
                return units ?? [];
              },
              getItems: ({ query, init }) => init
                .filter(unit => unit.toLowerCase().includes(query))
                .map(unit => ({ id: unit })),
              stringify: ({ item }) => item.id,
            }}
          />
        </div>

        <div className="min-w-0 basis-1/2 flex-1">
          <MyForm.Input
            required
            name={`unit:${id}:value`} labelText={uiText("Basismenge")}
            type="number"
            rules={[MyForm.Input.rules.posnum]}
            suffix={
              <MyButton
                kind="ghost"
                size="sm"
                className="ss-input-suffix-btn"
                title={uiText("Einheit entfernen")}
                aria-label={uiText("Einheit entfernen")}
                onClick={() => setUnits(rows => rows.filter(row => row.id !== id))}
              >
                <Icons.Delete />
              </MyButton>
            }
          />
        </div>
      </div>
      {saved && <NotifyLoaded onLoad={() => {
        const [name, value] = saved;
        context.setValues({
          [`unit:${id}:name`]: name,
          [`unit:${id}:value`]: value,
        });
      }} />}
    </div>)}

    <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
      const id = generateId();
      setUnits(rows => [...rows, { id }]);
      setFocusUnitId(id);
    }}>{uiText("Weitere Einheit")}</MyButton>

    <NotifyLoaded onLoad={() => {
      if (product) {
        context.setValues({
          name: product.name,
          brand: product.brand ?? '',
          description: product.description ?? '',
          regieReportName: product.regieReportName ?? '',
          baseUnit: product.baseUnit,
        });
      } else if (initialQuery) {
        context.field('name')?.setValue(initialQuery);
      }
    }} />
  </>;
}

function readProductFields(values: ReturnType<MyPublicFormContext['getValues']>) {
  const unitIds = new Set<string>();
  for (const key of Object.keys(values)) {
    if (!key.startsWith('unit:')) continue;
    const [, id] = key.split(':');
    unitIds.add(id);
  }

  const unitEntries: [name: string, factor: number][] = [];
  for (const id of unitIds) {
    const value = parseFloatCustom(values[`unit:${id}:value`]);
    if (isNaN(value)) return null;

    unitEntries.push([values[`unit:${id}:name`], value]);
  }

  return {
    name: values.name,
    brand: values.brand,
    description: values.description,
    regieReportName: values.regieReportName?.trim() || null,
    baseUnit: values.baseUnit,
    otherUnits: Object.fromEntries(unitEntries),
  };
}

type CreateProductModalOptions = {
  initialQuery?: string;
  onCreated?: (product: Product) => void | Promise<void>;
};

export function showCreateProductModal(modals: MyModalsInterface, options: CreateProductModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => <>
      <p className="light">{uiText("Nummer, Bezeichnung und Basiseinheit definieren den Produktstamm für Auswertungen und Lieferscheine.")}</p>

      <MyForm.Input
        required
        name="customId"
        labelText={uiText("Nummer")}
        type="number"
        rules={[MyForm.Input.rules.posint]}
        suffix={
          <MyButton
            kind="ghost"
            size="sm"
            className="ss-input-suffix-btn"
            title={uiText("Nummer automatisch vorschlagen")}
            aria-label={uiText("Nummer automatisch vorschlagen")}
            onClick={async () => {
              const [id, err] = await client.query('products.suggestNextCustomId', undefined);
              if (err) throw err;

              if (id) context.field('customId')?.setValue(id.toString());
            }}
          >
            <Icons.Magic />
          </MyButton>
        }
      />

      <MyDivider />

      <ProductFields context={context} initialQuery={options.initialQuery} />
    </>,
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const customId = parseInt(values.customId);
      if (isNaN(customId)) return;

      const fields = readProductFields(values);
      if (!fields) return;

      const [data, err] = await client.mutate('products.create', {
        customId,
        ...fields,
      });

      if (err) throw err;
      if (!data) return;

      if (options.onCreated) {
        const [created, loadErr] = await client.query('products.get', { id: data.id }, { strategy: 'network-first' });
        if (loadErr) throw loadErr;
        if (created) await options.onCreated(created);
        hide();
        return;
      }

      navigate(`/products/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Produkt erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showModifyProductModal(modals: MyModalsInterface, product: Product) {
  modals.showForm({
    content: ({ context }) => <>
      <p className="light">{uiText("Pflege hier Stammdaten und Einheiten für korrekte Mengen- und Kostenberechnungen.")}</p>
      <ProductFields context={context} product={product} />
    </>,
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      const fields = readProductFields(values);
      if (!fields) return;

      const [data, err] = await client.mutate('products.update', {
        id: product.id,
        data: fields,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Produkt bearbeiten"),
      modalLabel: productTitle(product),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteProductModal(modals: MyModalsInterface, product: Product) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Produkt in Verbindung stehenden Daten werden damit ebenfalls gelöscht. Dies betrifft insbesondere auch Kostenschätzungen.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('products.delete', { id: product.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/products/${product.id}`) navigate('/products');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Produkt löschen"),
      modalLabel: productTitle(product),
      primaryButtonText: uiText("Löschen"),
    }),
  });
}

export function showSetProductCategoriesModal(modals: MyModalsInterface, product: Product) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.MultiSelect
        name="categories"
        labelText={uiText("Kategorien")}
        prepare={async () => {
          const [data, err] = await client.query('products.categories.list', undefined);
          if (err) throw err;
          return data ?? [];
        }}
        getOptions={({ query, init }) => {
          const normalized = query.toLowerCase();
          return init
            .filter((category) => category.toLowerCase().includes(normalized))
            .map(category => ({ id: category }));
        }}
        renderItem={({ item }) => item.id}
      />

      <NotifyLoaded onLoad={() => {
        context.setValues({
          categories: product.categories.map(category => ({ id: category })),
        });
      }} />
    </>,
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      const categories = (values.categories ?? []).map((item: { id: string }) => item.id);

      const [data, err] = await client.mutate('products.categories.set', {
        id: product.id,
        categories,
      });
      if (err) throw err;
      if (!data) return;

      client.invalidate('products.get');
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Kategorien bearbeiten"),
      modalLabel: productTitle(product),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showCreateProductPriceRecordModal(modals: MyModalsInterface, product: Product) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.Input
        required
        type="number"
        name="price" labelText={uiText("Gesamtpreis (EUR)")}
        rules={[MyForm.Input.rules.num]}
      />
      
      <div className="grow flex gap-2">
        <div className="min-w-0 basis-1/2 flex-1">
          <MyForm.Input
            required
            type="number"
            name="amount" labelText={uiText("Menge")}
            rules={[MyForm.Input.rules.posnum]}
          />
        </div>

        <div className="min-w-0 basis-1/2 flex-1">
          <MyForm.Select
            name="unit" labelText={uiText("Einheit")}
            getOptions={() => {
              return [product.baseUnit, ...Object.keys(product.otherUnits)].map(e => ({ id: e }));
            }}
            buildOption={({ id }) => ({ text: id, value: id })}
          />
        </div>
      </div>

      <MyForm.MultiSelect
        maxSelectedItems={1}
        name="vendor" labelText={uiText("Händler")}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('products.vendors.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => item.name}
        renderTile={item => <SmallProductVendorTile data={item} noLink />}
        createAction={createEntityAction.productVendor}
      />

      <MyForm.Input name="comment" labelText={uiText("Kommentar")} />

      <MyForm.DateInput required name="date" labelText={uiText("Datum")} />

      <MyForm.Checkbox name="isRealPurchase" labelText={uiText("Echter Einkauf?")} />

      <NotifyLoaded onLoad={() => {
        context.field('date')?.setValue(startOfDay(new Date()));
      }} />
    </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      const price = parseFloatCustom(values.price);
      if (isNaN(price)) return;

      const amount = parseFloatCustom(values.amount);
      if (isNaN(amount)) return;

      let inBaseUnits = 1;
      if (values.unit !== product.baseUnit) inBaseUnits = product.otherUnits[values.unit];

      const pricePerBaseUnit = price / (amount * inBaseUnits);
      if (isNaN(pricePerBaseUnit)) return;

      if (!(values.date instanceof Date)) return;

      const [data, err] = await client.mutate('products.priceRecords.create', {
        productId: product.id,
        pricePerBaseUnit,
        isRealPurchase: values.isRealPurchase || false,
        timestamp: startOfDay(values.date),
        comment: values.comment,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Preis verzeichnen"),
      modalLabel: `${product.customId} ${productTitle(product)}`,
      primaryButtonText: uiText("Speichern"),
    }),
  });
}
