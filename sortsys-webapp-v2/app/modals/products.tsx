import { useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { productTitle } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProductVendorTile } from "~/lib/tiles";
import { generateId, parseFloatCustom, startOfDay } from "~/lib/utils";
import type { Product } from "~/type-helpers";

type CreateProductModalOptions = {
  initialQuery?: string;
  onCreated?: (product: Product) => void | Promise<void>;
};

export function showCreateProductModal(modals: MyModalsInterface, options: CreateProductModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => {
      const [otherUnitIds, setOtherUnitIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);

      return <>
        <p className="light">Nummer, Bezeichnung und Basiseinheit definieren den Produktstamm für Auswertungen und Lieferscheine.</p>

        <MyForm.Input
          required
          name="customId"
          labelText="Nummer"
          type="number"
          rules={[MyForm.Input.rules.posint]}
          suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Nummer automatisch vorschlagen" aria-label="Nummer automatisch vorschlagen" onClick={async () => {
            const [id, err] = await client.query('products.suggestNextCustomId', undefined);
            if (err) throw err;
            if (id) context.field('customId')?.setValue(id.toString());
          }}><Icons.Magic /></MyButton>}
        />

        <MyDivider />

        <MyForm.Input required
          name="name" labelText="Bezeichung" />
        {!!options.initialQuery && <NotifyLoaded onLoad={() => context.field('name')?.setValue(options.initialQuery)} />}

        <MyForm.Input
          name="brand" labelText="Hersteller" />

        <MyForm.Input
          name="description" labelText="Beschreibung" />

        <MyDivider />

        <MyForm.Input required
          name="baseUnit" labelText="Basiseinheit (kleinste)"
          rules={[MyForm.Input.rules.max(15)]} />
        <p className="light">Beispiel: m, kg oder Stk. Alle weiteren Einheiten werden darauf umgerechnet.</p>

        <MyDivider />

        {otherUnitIds.map(id => <div key={id} className="flex gap-2 items-end">
          <div className="grow flex gap-2">
            <div className="basis-1/2 flex-1">
              <MyForm.Input
                required
                name={`unit:${id}:name`} labelText="Einheit"
                autoFocus={autoFocusFieldName === `unit:${id}:name`}
                suggestions={{
                  prepare: () => client.query('products.units.list', undefined).then(([data]) => data ?? []),
                  getItems: ({ query, init }) => init.filter((unit) => {
                    return unit.toLowerCase().includes(query);
                  }).map(unit => ({ id: unit })),
                  stringify: ({ item }) => item.id,
                }}
              />
            </div>

            <div className="basis-1/2 flex-1">
              <MyForm.Input
                required
                name={`unit:${id}:value`} labelText="Basismenge"
                type="number"
                rules={[MyForm.Input.rules.posnum]}
                suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Einheit entfernen" aria-label="Einheit entfernen" onClick={() => {
                  setOtherUnitIds(ids => ids.filter(_id => _id !== id));
                }}><Icons.Delete /></MyButton>}
              />
            </div>
          </div>
        </div>)}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setOtherUnitIds(ids => [...ids, id]);
          setAutoFocusFieldName(`unit:${id}:name`);
        }}>Weitere Einheit</MyButton>
      </>
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const customId = parseInt(values.customId);
      if (isNaN(customId)) return;

      const otherUnitIds = new Set<string>();
      Object.keys(values).forEach((key) => {
        if (!key.startsWith('unit:')) return;

        const [, id] = key.split(':');
        otherUnitIds.add(id);
      });

      const otherUnits: Record<string, number> = {};
      for (const id of otherUnitIds) {
        const value = parseFloatCustom(values[`unit:${id}:value`]);
        if (isNaN(value)) return;

        otherUnits[values[`unit:${id}:name`]] = value;
      }

      const [data, err] = await client.mutate('products.create', {
        customId,
        name: values.name,
        brand: values.brand,
        description: values.description,
        baseUnit: values.baseUnit,
        otherUnits,
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
      modalHeading: 'Produkt erstellen',
      primaryButtonText: 'Erstellen',
    }),
  });
}

export function showModifyProductModal(modals: MyModalsInterface, product: Product) {
  modals.showForm({
    content: ({ context }) => {
      const [otherUnitIds, setOtherUnitIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);

      const initialOtherUnits = useRef<Record<string, [string, number]>>({}).current;

      return <>
        <p className="light">Pflege hier Stammdaten und Einheiten für korrekte Mengen- und Kostenberechnungen.</p>

        <MyForm.Input required
          name="name" labelText="Bezeichung" />

        <MyForm.Input
          name="brand" labelText="Hersteller" />

        <MyForm.Input
          name="description" labelText="Beschreibung" />

        <MyDivider />

        <MyForm.Input required
          name="baseUnit" labelText="Basiseinheit (kleinste)"
          rules={[MyForm.Input.rules.max(15)]} />
        <p className="light">Beispiel: m, kg oder Stk. Alle weiteren Einheiten werden darauf umgerechnet.</p>

        <MyDivider />

        {otherUnitIds.map(id => <div key={id} className="flex gap-2 items-end">
          <div className="grow flex gap-2">
            <div className="basis-1/2 flex-1">
              <MyForm.Input
                required
                name={`unit:${id}:name`} labelText="Einheit"
                autoFocus={autoFocusFieldName === `unit:${id}:name`}
                suggestions={{
                  prepare: () => client.query('products.units.list', undefined).then(([data]) => data ?? []),
                  getItems: ({ query, init }) => init.filter((unit) => {
                    return unit.toLowerCase().includes(query);
                  }).map(unit => ({ id: unit })),
                  stringify: ({ item }) => item.id,
                }}
              />
            </div>

            <div className="basis-1/2 flex-1">
              <MyForm.Input
                required
                name={`unit:${id}:value`} labelText="Basismenge"
                type="number"
                rules={[MyForm.Input.rules.posnum]}
                suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Einheit entfernen" aria-label="Einheit entfernen" onClick={() => {
                  setOtherUnitIds(ids => ids.filter(_id => _id !== id));
                }}><Icons.Delete /></MyButton>}
              />
            </div>
          </div>

          <NotifyLoaded onLoad={() => {
            if (!(id in initialOtherUnits)) return;
            context.setValues({
              [`unit:${id}:name`]: initialOtherUnits[id][0],
              [`unit:${id}:value`]: initialOtherUnits[id][1],
            });
          }} />
        </div>)}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setOtherUnitIds(ids => [...ids, id]);
          setAutoFocusFieldName(`unit:${id}:name`);
        }}>Weitere Einheit</MyButton>

        <NotifyLoaded onLoad={async () => {
          context.setValues({
            name: product.name,
            brand: product.brand ?? '',
            description: product.description ?? '',
            baseUnit: product.baseUnit,
          });

          const ids: string[] = [];
          Object.entries(product.otherUnits).forEach(([unit, value]) => {
            const id = generateId();
            initialOtherUnits[id] = [unit, value];
            ids.push(id);
          });

          setOtherUnitIds(ids);
        }} />
      </>
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const otherUnitIds = new Set<string>();
      Object.keys(values).forEach((key) => {
        if (!key.startsWith('unit:')) return;

        const [, id] = key.split(':');
        otherUnitIds.add(id);
      });

      const otherUnits: Record<string, number> = {};
      for (const id of otherUnitIds) {
        const value = parseFloatCustom(values[`unit:${id}:value`]);
        if (isNaN(value)) return;

        otherUnits[values[`unit:${id}:name`]] = value;
      }

      const [data, err] = await client.mutate('products.update', {
        id: product.id,
        data: {
          name: values.name,
          brand: values.brand,
          description: values.description,
          baseUnit: values.baseUnit,
          otherUnits,
        },
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: 'Produkt bearbeiten',
      modalLabel: productTitle(product),
      primaryButtonText: 'Speichern',
    }),
  });
}

export function showDeleteProductModal(modals: MyModalsInterface, product: Product) {
  modals.showForm({
    content: () => <>
      <p className="light">
        Alle mit diesem Produkt in Verbindung stehenden Daten werden damit ebenfalls gelöscht.
        Dies betrifft insbesondere auch Kostenschätzungen.
        {" "}<b>Diese Aktion kann nicht rückgängig gemacht werden.</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText="Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann."
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
      modalHeading: 'Produkt löschen',
      modalLabel: productTitle(product),
      primaryButtonText: 'Löschen',
    }),
  });
}

export function showSetProductCategoriesModal(modals: MyModalsInterface, product: Product) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.MultiSelect
        name="categories"
        labelText="Kategorien"
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
      modalHeading: 'Kategorien bearbeiten',
      modalLabel: productTitle(product),
      primaryButtonText: 'Speichern',
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
        name="price" labelText="Gesamtpreis (EUR)"
        rules={[MyForm.Input.rules.num]}
      />
      
      <div className="grow flex gap-2">
        <div className="basis-1/2 flex-1">
          <MyForm.Input
            required
            type="number"
            name="amount" labelText="Menge"
            rules={[MyForm.Input.rules.posnum]}
          />
        </div>

        <div className="basis-1/2 flex-1">
          <MyForm.Select
            name="unit" labelText="Einheit"
            getOptions={() => {
              return [product.baseUnit, ...Object.keys(product.otherUnits)].map(e => ({ id: e }));
            }}
            buildOption={({ id }) => ({ text: id, value: id })}
          />
        </div>
      </div>

      <MyForm.MultiSelect
        maxSelectedItems={1}
        name="vendor" labelText="Händler"
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('products.vendors.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => item.name}
        renderTile={item => <SmallProductVendorTile data={item} noLink />}
        createAction={createEntityAction.productVendor}
      />

      <MyForm.Input name="comment" labelText="Kommentar" />

      <MyForm.DateInput required name="date" labelText="Datum" />

      <MyForm.Checkbox name="isRealPurchase" labelText="Echter Einkauf?" />

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
      modalHeading: 'Preis verzeichnen',
      modalLabel: `${product.customId} ${productTitle(product)}`,
      primaryButtonText: 'Speichern',
    }),
  });
}
