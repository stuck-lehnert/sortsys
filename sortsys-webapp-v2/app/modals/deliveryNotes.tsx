import { uiText } from "~/lib/i18n";
import { Fragment, useEffect, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { productTitle } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProductTile, SmallProjectTile } from "~/lib/tiles";
import { generateId, parseFloatCustom, upmatchUnit } from "~/lib/utils";
import type { DeliveryNote, Product } from "~/type-helpers";

function quantityInUnit(product: Product, baseQuantity: number, unit: string | null | undefined): [number, string | null] {
  if (!unit) return upmatchUnit(product, baseQuantity);
  if (unit === product.baseUnit) return [baseQuantity, unit];
  const factor = product.otherUnits?.[unit];
  if (!factor) return upmatchUnit(product, baseQuantity);
  return [baseQuantity / factor, unit];
}

export function showCreateDeliveryNoteModal(modals: MyModalsInterface) {
  modals.showForm({
    content: ({ context }) => {
      const [recordIds, setRecordIds] = useState<string[]>([]);
      const [specialRecordIds, setSpecialRecordIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
      const createEntityAction = useCreateEntityAction(modals);

      useEffect(() => {
        const id = generateId();
        setRecordIds([id]);
        setAutoFocusFieldName(`record:${id}:product`);
      }, []);

      const forceUpdate = useForceUpdate();

      return <>
        <MyForm.MultiSelect name="project" labelText={uiText("Projekt")}
          minSelectedItems={1} maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const [data, err] = await client.query('projects.list', { search: query });
            if (err) throw err;
            return data ?? [];
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          createAction={createEntityAction.project}
        />
        <p className="light">{uiText("Wähle das Projekt, zu dem der Lieferschein erfasst werden soll.")}</p>

        <MyForm.Input name="comment" labelText={uiText("Kommentar")} />
        <p className="light">{uiText("Hinweise wie Lieferant, Baustellenbereich oder Besonderheiten.")}</p>

        <MyDivider />

        <h4>{uiText("Produkte")}</h4>
        <p className="light">{uiText("Erfasse gelieferte Produkte mit Menge und Einheit.")}</p>

        {recordIds.map(id => {
          const currentProduct = () => {
            return (context?.field(`record:${id}:product`)?.getValue()?.[0] ?? null) as Product | null;
          };

          return <Fragment key={id}>
            <MyForm.MultiSelect
              name={`record:${id}:product`}
              labelText={uiText("Produkt")}
              autoFocus={autoFocusFieldName === `record:${id}:product`}
              minSelectedItems={1} maxSelectedItems={1}
              getOptions={async ({ query }) => {
                const [data, err] = await client.query('products.list', { search: query });
                if (err) throw err;
                return data ?? [];
              }}
              renderItem={({ item }) => `${item.customId} ${productTitle(item)}`}
              renderTile={item => <SmallProductTile data={item} noLink />}
              createAction={createEntityAction.product}
              onValueChange={forceUpdate}
            />

            <div key={id} className="flex gap-2 items-end">
              <div className="grow flex gap-2">
                <div className="basis-1/2 flex-1">
                  <MyForm.Input
                    required
                    name={`record:${id}:amount`} labelText={uiText("Anzahl")}
                    type="number"
                    rules={[MyForm.Input.rules.num]}
                  />
                </div>

                <div className="basis-1/2 flex-1">
                  <MyForm.Select
                    name={`record:${id}:unit`}
                    labelText={uiText("Einheit")}
                    getOptions={() => {
                      const _product = currentProduct();
                      if (!_product) return [];
                      return [_product.baseUnit, ...Object.keys(_product.otherUnits)].map(e => ({ id: e }));
                    }}
                    getOptionsDeps={[currentProduct()?.id]}
                    buildOption={({ id }) => ({ text: id, value: id })}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Eintrag entfernen")} aria-label={uiText("Eintrag entfernen")} onClick={() => {
                      setRecordIds(ids => ids.filter(_id => _id !== id));
                    }}><Icons.Delete /></MyButton>}
                  />
                </div>
              </div>

            </div>

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setRecordIds(ids => [...ids, id]);
          setAutoFocusFieldName(`record:${id}:product`);
        }}>{uiText("Eintrag")}</MyButton>

        <MyDivider />

        <h4>{uiText("Sonderposten")}</h4>
        <p className="light">{uiText("Sonderposten sind zusätzliche Leistungen oder Materialien, die nicht als Produktstamm vorhanden sind.")}</p>

        {specialRecordIds.map(id => {
          return <Fragment key={id}>
            <div className="flex gap-2 items-end">
              <div className="grow flex flex-col gap-2">
                <div>
                  <MyForm.Input
                    required
                    name={`specialRecord:${id}:name`}
                    labelText={uiText("Bezeichnung")}
                    autoFocus={autoFocusFieldName === `specialRecord:${id}:name`}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="basis-1/3 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:amount`}
                      labelText={uiText("Menge")}
                      type="number"
                      rules={[MyForm.Input.rules.num]}
                    />
                  </div>

                  <div className="basis-1/3 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:unit`}
                      labelText={uiText("Einheit")}
                    />
                  </div>

                  <div className="basis-1/3 flex-1">
                    <MyForm.Input
                      name={`specialRecord:${id}:pricePerUnit`}
                      labelText={uiText("Preis pro Einheit")}
                      type="number"
                      rules={[MyForm.Input.rules.num]}
                      suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Sonderposten entfernen")} aria-label={uiText("Sonderposten entfernen")} onClick={() => {
                        setSpecialRecordIds(ids => ids.filter(_id => _id !== id));
                      }}><Icons.Delete /></MyButton>}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setSpecialRecordIds(ids => [...ids, id]);
          setAutoFocusFieldName(`specialRecord:${id}:name`);
        }}>{uiText("Sonderposten")}</MyButton>
      </>;
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const projectId = values.project[0].id;
      if (!projectId) return;

      const records: {
        productId: string;
        quantity: number;
        unit: string;
        comment?: string | null;
      }[] = [];

      const specialRecords: {
        name: string;
        unit: string;
        amount: number;
        pricePerUnit: number | null;
      }[] = [];

      const recordIds = new Set<string>();
      const specialRecordIds = new Set<string>();
      Object.keys(values).forEach(key => {
        if (!key.startsWith('record:')) return;
        const [, id] = key.split(':');
        recordIds.add(id);
      });

      Object.keys(values).forEach(key => {
        if (!key.startsWith('specialRecord:')) return;
        const [, id] = key.split(':');
        specialRecordIds.add(id);
      });

      recordIds.forEach(id => {
        const product = values[`record:${id}:product`]?.at(0);
        if (!product?.id) throw new Error();

        const units = [product.baseUnit, ...Object.keys(product.otherUnits)] as string[];

        const quantity = parseFloatCustom(values[`record:${id}:amount`]);
        if (!quantity || isNaN(quantity)) throw new Error();

        const unit = values[`record:${id}:unit`];
        if (!units.includes(unit)) throw new Error();

        let inBaseUnits = quantity;
        if (unit !== product.baseUnit) {
          inBaseUnits *= product.otherUnits[unit];
        }

        records.push({ productId: product.id, quantity: inBaseUnits, unit });
      });

      specialRecordIds.forEach(id => {
        const name = values[`specialRecord:${id}:name`];
        if (!name) throw new Error();

        const unit = values[`specialRecord:${id}:unit`];
        if (!unit) throw new Error();

        const amount = parseFloatCustom(values[`specialRecord:${id}:amount`]);
        if (!amount || isNaN(amount)) throw new Error();

        const rawPricePerUnit = values[`specialRecord:${id}:pricePerUnit`];
        let pricePerUnit: number | null = null;
        if (`${rawPricePerUnit ?? ''}`.trim()) {
          const parsedPrice = parseFloatCustom(rawPricePerUnit);
          if (isNaN(parsedPrice)) throw new Error();
          pricePerUnit = parsedPrice;
        }

        specialRecords.push({
          name,
          unit,
          amount,
          pricePerUnit,
        });
      });

      const [data, err] = await client.mutate('deliveryNotes.create', {
        projectId,
        records,
        specialRecords,
        comment: values.comment,
      });

      if (err) throw err;
      if (!data) return;

      navigate(`/products/deliveryNotes/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Lieferschein schreiben"),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showModifyDeliveryNoteModal(modals: MyModalsInterface, note: DeliveryNote) {
  modals.showForm({
    content: ({ context }) => {
      const [recordIds, setRecordIds] = useState<string[]>([]);
      const [specialRecordIds, setSpecialRecordIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
      const createEntityAction = useCreateEntityAction(modals);

      const initialRecordValues = useRef<Record<string, {
        product: Product | null;
        amount: number;
        unit: string | null;
      }>>({}).current;
      const initialSpecialRecordValues = useRef<Record<string, {
        name: string;
        unit: string;
        amount: number;
        pricePerUnit: number | null;
      }>>({}).current;

      const forceUpdate = useForceUpdate();

      return <>
        <MyForm.MultiSelect name="project" labelText={uiText("Projekt")}
          minSelectedItems={1} maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const [data, err] = await client.query('projects.list', { search: query });
            if (err) throw err;
            return data ?? [];
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          createAction={createEntityAction.project}
        />
        <p className="light">{uiText("Wähle das Projekt, zu dem der Lieferschein erfasst werden soll.")}</p>

        <MyForm.Input name="comment" labelText={uiText("Kommentar")} />
        <p className="light">{uiText("Hinweise wie Lieferant, Baustellenbereich oder Besonderheiten.")}</p>

        <MyDivider />

        <h4>{uiText("Produkte")}</h4>
        <p className="light">{uiText("Erfasse gelieferte Produkte mit Menge und Einheit.")}</p>

        {recordIds.map(id => {
          const currentProduct = () => {
            return (context?.field(`record:${id}:product`)?.getValue()?.[0] ?? null) as Product | null;
          };

          return <Fragment key={id}>
            <MyForm.MultiSelect
              name={`record:${id}:product`}
              labelText={uiText("Produkt")}
              autoFocus={autoFocusFieldName === `record:${id}:product`}
              minSelectedItems={1} maxSelectedItems={1}
              getOptions={async ({ query }) => {
                const [data, err] = await client.query('products.list', { search: query });
                if (err) throw err;
                return data ?? [];
              }}
              renderItem={({ item }) => `${item.customId} ${productTitle(item)}`}
              renderTile={item => <SmallProductTile data={item} noLink />}
              createAction={createEntityAction.product}
              onValueChange={forceUpdate}
            />

            <div key={id} className="flex gap-2 items-end">
              <div className="grow flex gap-2">
                <div className="basis-1/2 flex-1">
                  <MyForm.Input
                    required
                    name={`record:${id}:amount`} labelText={uiText("Anzahl")}
                    type="number"
                    rules={[MyForm.Input.rules.num]}
                  />
                </div>

                <div className="basis-1/2 flex-1">
                  <MyForm.Select
                    name={`record:${id}:unit`}
                    labelText={uiText("Einheit")}
                    getOptions={() => {
                      const _product = currentProduct();
                      if (!_product) return [];
                      return [_product.baseUnit, ...Object.keys(_product.otherUnits)].map(e => ({ id: e }));
                    }}
                    getOptionsDeps={[currentProduct()?.id]}
                    buildOption={({ id }) => ({ text: id, value: id })}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Eintrag entfernen")} aria-label={uiText("Eintrag entfernen")} onClick={() => {
                      setRecordIds(ids => ids.filter(_id => _id !== id));
                    }}><Icons.Delete /></MyButton>}
                  />
                </div>
              </div>

            </div>

            <NotifyLoaded onLoad={() => {
              const initial = initialRecordValues[id];
              if (!initial) return;

              const values: Record<string, any> = {
                [`record:${id}:amount`]: initial.amount,
              };

              if (initial.product) values[`record:${id}:product`] = [initial.product];

              context.setValues(values);
              if (initial.unit) {
                window.setTimeout(() => context.setValues({ [`record:${id}:unit`]: initial.unit }), 0);
              }
            }} />

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setRecordIds(ids => [...ids, id]);
          setAutoFocusFieldName(`record:${id}:product`);
        }}>{uiText("Eintrag")}</MyButton>

        <MyDivider />

        <h4>{uiText("Sonderposten")}</h4>
        <p className="light">{uiText("Sonderposten sind zusätzliche Leistungen oder Materialien, die nicht als Produktstamm vorhanden sind.")}</p>

        {specialRecordIds.map(id => {
          return <Fragment key={id}>
            <div className="flex gap-2 items-end">
              <div className="grow flex flex-col gap-2">
                <div>
                  <MyForm.Input
                    required
                    name={`specialRecord:${id}:name`}
                    labelText={uiText("Bezeichnung")}
                    autoFocus={autoFocusFieldName === `specialRecord:${id}:name`}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="basis-1/3 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:amount`}
                      labelText={uiText("Menge")}
                      type="number"
                      rules={[MyForm.Input.rules.num]}
                    />
                  </div>

                  <div className="basis-1/3 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:unit`}
                      labelText={uiText("Einheit")}
                    />
                  </div>

                  <div className="basis-1/3 flex-1">
                    <MyForm.Input
                      name={`specialRecord:${id}:pricePerUnit`}
                      labelText={uiText("Preis pro Einheit")}
                      type="number"
                      rules={[MyForm.Input.rules.num]}
                      suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Sonderposten entfernen")} aria-label={uiText("Sonderposten entfernen")} onClick={() => {
                        setSpecialRecordIds(ids => ids.filter(_id => _id !== id));
                      }}><Icons.Delete /></MyButton>}
                    />
                  </div>
                </div>
              </div>
            </div>

            <NotifyLoaded onLoad={() => {
              const initial = initialSpecialRecordValues[id];
              if (!initial) return;

              context.setValues({
                [`specialRecord:${id}:name`]: initial.name,
                [`specialRecord:${id}:unit`]: initial.unit,
                [`specialRecord:${id}:amount`]: initial.amount,
                [`specialRecord:${id}:pricePerUnit`]: initial.pricePerUnit ?? '',
              });
            }} />

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setSpecialRecordIds(ids => [...ids, id]);
          setAutoFocusFieldName(`specialRecord:${id}:name`);
        }}>{uiText("Sonderposten")}</MyButton>

        <NotifyLoaded onLoad={async () => {
          context.setValues({ comment: note.comment ?? '' });

          if (note.projectId) {
            const [project] = await client.query('projects.get', { id: note.projectId }, { strategy: 'cache-first' });
            if (project) context.setValues({ project: [project] });
          }

          const recordIdList: string[] = [];
          for (const record of note.records) {
            const id = record.id ?? generateId();
            recordIdList.push(id);

            const [product] = await client.query('products.get', { id: record.productId }, { strategy: 'cache-first' });
            const [amount, unit] = product ? quantityInUnit(product, record.quantity, record.unit) : [record.quantity, null];
            initialRecordValues[id] = {
              product: product ?? null,
              amount,
              unit,
            };
          }

          const specialRecordIdList: string[] = [];
          note.specialRecords?.forEach(record => {
            const id = generateId();
            specialRecordIdList.push(id);
            initialSpecialRecordValues[id] = {
              name: record.name,
              unit: record.unit,
              amount: record.amount,
              pricePerUnit: record.pricePerUnit ?? null,
            };
          });

          setRecordIds(recordIdList.length ? recordIdList : []);
          setSpecialRecordIds(specialRecordIdList);
        }} />
      </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      const projectId = values.project[0].id;
      if (!projectId) return;

      const records: {
        productId: string;
        quantity: number;
        unit: string;
        comment?: string | null;
      }[] = [];

      const specialRecords: {
        name: string;
        unit: string;
        amount: number;
        pricePerUnit: number | null;
      }[] = [];

      const recordIds = new Set<string>();
      const specialRecordIds = new Set<string>();
      Object.keys(values).forEach(key => {
        if (!key.startsWith('record:')) return;
        const [, id] = key.split(':');
        recordIds.add(id);
      });

      Object.keys(values).forEach(key => {
        if (!key.startsWith('specialRecord:')) return;
        const [, id] = key.split(':');
        specialRecordIds.add(id);
      });

      recordIds.forEach(id => {
        const product = values[`record:${id}:product`]?.at(0);
        if (!product?.id) throw new Error();

        const units = [product.baseUnit, ...Object.keys(product.otherUnits)] as string[];

        const quantity = parseFloatCustom(values[`record:${id}:amount`]);
        if (!quantity || isNaN(quantity)) throw new Error();

        const unit = values[`record:${id}:unit`];
        if (!units.includes(unit)) throw new Error();

        let inBaseUnits = quantity;
        if (unit !== product.baseUnit) {
          inBaseUnits *= product.otherUnits[unit];
        }

        records.push({ productId: product.id, quantity: inBaseUnits, unit });
      });

      specialRecordIds.forEach(id => {
        const name = values[`specialRecord:${id}:name`];
        if (!name) throw new Error();

        const unit = values[`specialRecord:${id}:unit`];
        if (!unit) throw new Error();

        const amount = parseFloatCustom(values[`specialRecord:${id}:amount`]);
        if (!amount || isNaN(amount)) throw new Error();

        const rawPricePerUnit = values[`specialRecord:${id}:pricePerUnit`];
        let pricePerUnit: number | null = null;
        if (`${rawPricePerUnit ?? ''}`.trim()) {
          const parsedPrice = parseFloatCustom(rawPricePerUnit);
          if (isNaN(parsedPrice)) throw new Error();
          pricePerUnit = parsedPrice;
        }

        specialRecords.push({
          name,
          unit,
          amount,
          pricePerUnit,
        });
      });

      const [data, err] = await client.mutate('deliveryNotes.update', {
        id: note.id,
        data: {
          projectId,
          records,
          specialRecords,
          comment: values.comment,
        },
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Lieferschein bearbeiten"),
      modalLabel: `#${note.autoId}`,
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteDeliveryNoteModal(modals: MyModalsInterface, note: DeliveryNote) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Lieferschein in Verbindung stehenden Daten werden damit ebenfalls gelöscht.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('deliveryNotes.delete', { id: note.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/products/deliveryNotes/${note.id}`) navigate('/products/deliveryNotes');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Lieferschein löschen"),
      modalLabel: `#${note.autoId}`,
      primaryButtonText: uiText("Löschen"),
    }),
  });
}
