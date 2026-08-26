import { Fragment, useEffect, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { productTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProductTile, SmallProjectTile, SmallUserTile } from "~/lib/tiles";
import { generateId, parseFloatCustom, upmatchUnit } from "~/lib/utils";
import { dayInIsoWeek, formatCalendarDateWithOffset, startOfIsoWeek, WEEKDAY_NAMES } from "~/lib/week";
import type { Product, RegieReport } from "~/type-helpers";

function parseWeekdayIndex(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= WEEKDAY_NAMES.length) {
    throw new Error("Ungültiger Wochentag");
  }
  return parsed;
}

const WEEKDAY_OPTIONS = WEEKDAY_NAMES.map((label, dayIndex) => ({
  id: `${dayIndex}`,
  label,
}));

export function showCreateRegieReportModal(modals: MyModalsInterface) {
  modals.showForm({
    content: ({ context }) => {
      const [recordIds, setRecordIds] = useState<string[]>([]);
      const [specialRecordIds, setSpecialRecordIds] = useState<string[]>([]);
      const [workHourIds, setWorkHourIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
      const createEntityAction = useCreateEntityAction(modals);

      useEffect(() => {
        const id = generateId();
        setWorkHourIds([id]);
        setAutoFocusFieldName(`workHour:${id}:user`);
        context.setValues({ [`workHour:${id}:dayIndex`]: '0' });
      }, []);

      const forceUpdate = useForceUpdate();

      return <>
        <MyForm.MultiSelect
          minSelectedItems={1} maxSelectedItems={1}
          name="project" labelText="Projekt"
          getOptions={async ({ query }) => {
            const [data] = await client.query('projects.list', { search: query });
            return data ?? [];
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          createAction={createEntityAction.project}
        />
        <p className="light">Wähle das Projekt, für das der Regiebericht erstellt wird.</p>

        <MyForm.Input textArea name="summary" labelText="Beschreibung der Arbeiten" />
        <p className="light">Beschreibe die ausgeführten Arbeiten für die gesamte Kalenderwoche.</p>

        <MyForm.DateInput
          required
          name="week"
          labelText="Woche (beliebiger Tag)"
          rules={[date => {
            if (!date) return null;
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            if (date.getTime() > today.getTime()) return 'Datum darf nicht in der Zukunft liegen';
            return null;
          }]}
        />
        <p className="light">Der Bericht gilt immer für Montag bis Sonntag der gewählten Kalenderwoche.</p>

        <MyDivider />
        
        <h4>Arbeitszeit</h4>
        <p className="light">Pro Eintrag Tag, Mitarbeiter und Stunden der ausgewählten Woche erfassen.</p>

        {workHourIds.map(id => {
          return <Fragment key={id}>
            <div className="flex flex-col gap-2">
              <MyForm.Select
                required
                name={`workHour:${id}:dayIndex`}
                labelText="Tag"
                getOptions={() => WEEKDAY_OPTIONS}
                buildOption={({ id: optionId, label }) => ({ text: label, value: optionId })}
              />

              <MyForm.MultiSelect
                name={`workHour:${id}:user`}
                labelText="Mitarbeiter"
                autoFocus={autoFocusFieldName === `workHour:${id}:user`}
                minSelectedItems={1} maxSelectedItems={1}
                getOptions={async ({ query }) => {
                  const [data, err] = await client.query('users.list', { search: query });
                  if (err) throw err;
                  return data ?? [];
                }}
                renderItem={({ item }) => userFullName(item)}
                renderTile={item => <SmallUserTile data={item} noLink />}
                createAction={createEntityAction.user}
              />

              <div className="flex gap-2 items-end">
                <div className="grow">
                  <MyForm.Input
                    required
                    name={`workHour:${id}:hours`}
                    labelText="Stunden"
                    type="number"
                    rules={[
                      MyForm.Input.rules.num,
                      value => {
                        if (!value.trim()) return null;
                        const hours = parseFloatCustom(value);
                        if (isNaN(hours)) return null;
                        if (hours < 0 || hours > 10) return 'Stunden müssen zwischen 0 und 10 liegen';
                        return null;
                      },
                    ]}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Arbeitszeit entfernen" aria-label="Arbeitszeit entfernen" onClick={() => {
                      setWorkHourIds(ids => ids.filter(_id => _id !== id));
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
          setWorkHourIds(ids => [...ids, id]);
          setAutoFocusFieldName(`workHour:${id}:user`);
          context.setValues({ [`workHour:${id}:dayIndex`]: '0' });
        }}>Arbeitszeit</MyButton>

        <MyDivider />

        <h4>Produkte</h4>
        <p className="light">Verbrauchte Produkte inklusive Menge und Einheit dokumentieren.</p>

        {recordIds.map(id => {
          const currentProduct = () => {
            return (context?.field(`record:${id}:product`)?.getValue()?.[0] ?? null) as Product | null;
          };

          return <Fragment key={id}>
            <MyForm.MultiSelect
              name={`record:${id}:product`}
              labelText="Produkt"
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
                    name={`record:${id}:amount`} labelText="Anzahl"
                    type="number"
                    rules={[MyForm.Input.rules.num]}
                  />
                </div>

                <div className="basis-1/2 flex-1">
                  <MyForm.Select
                    name={`record:${id}:unit`}
                    labelText="Einheit"
                    getOptions={() => {
                      const _product = currentProduct();
                      if (!_product) return [];
                      return [_product.baseUnit, ...Object.keys(_product.otherUnits)].map(e => ({ id: e }));
                    }}
                    getOptionsDeps={[currentProduct()?.id]}
                    buildOption={({ id })=> ({ text: id, value: id })}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Eintrag entfernen" aria-label="Eintrag entfernen" onClick={() => {
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
        }}>Eintrag</MyButton>

        <MyDivider />

        <h4>Sonderposten</h4>
        <p className="light">Weitere Positionen erfassen, die nicht als Produkt vorhanden sind.</p>

        {specialRecordIds.map(id => {
          return <Fragment key={id}>
            <div className="flex gap-2 items-end">
              <div className="grow flex flex-col gap-2">
                <div>
                  <MyForm.Input
                    required
                    name={`specialRecord:${id}:name`}
                    labelText="Bezeichnung"
                    autoFocus={autoFocusFieldName === `specialRecord:${id}:name`}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="basis-1/2 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:amount`}
                      labelText="Menge"
                      type="number"
                      rules={[MyForm.Input.rules.num]}
                    />
                  </div>

                  <div className="basis-1/2 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:unit`}
                      labelText="Einheit"
                      suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Sonderposten entfernen" aria-label="Sonderposten entfernen" onClick={() => {
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
        }}>Sonderposten</MyButton>

        <NotifyLoaded onLoad={() => {
          context.field('week')?.setValue(new Date());
        }} />
      </>;
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const projectId = values.project[0]?.id;

      const weekInput = values.week ? new Date(values.week) : new Date();
      if (isNaN(weekInput.getTime())) throw new Error('Ungültige Woche');
      const weekStart = startOfIsoWeek(weekInput);

      const records: {
        productId: string;
        quantity: number;
        comment?: string | null;
      }[] = [];

      const specialRecords: {
        name: string;
        unit: string;
        amount: number;
      }[] = [];

      const workHours: {
        userId?: string | null;
        day: string;
        hours: number;
      }[] = [];

      const recordIds = new Set<string>();
      const specialRecordIds = new Set<string>();
      const workHourIds = new Set<string>();
      Object.keys(values).forEach(key => {
        if (!key.startsWith('record:')) return;
        const [,id] = key.split(':');
        recordIds.add(id);
      });

      Object.keys(values).forEach(key => {
        if (!key.startsWith('specialRecord:')) return;
        const [,id] = key.split(':');
        specialRecordIds.add(id);
      });

      Object.keys(values).forEach(key => {
        if (!key.startsWith('workHour:')) return;
        const [,id] = key.split(':');
        workHourIds.add(id);
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

        records.push({ productId: product.id,quantity: inBaseUnits });
      });

      specialRecordIds.forEach(id => {
        const name = values[`specialRecord:${id}:name`];
        if (!name) throw new Error();

        const unit = values[`specialRecord:${id}:unit`];
        if (!unit) throw new Error();

        const amount = parseFloatCustom(values[`specialRecord:${id}:amount`]);
        if (!amount || isNaN(amount)) throw new Error();

        specialRecords.push({
          name,
          unit,
          amount,
        });
      });

      workHourIds.forEach(id => {
        const user = values[`workHour:${id}:user`]?.at(0);

        const dayIndex = parseWeekdayIndex(values[`workHour:${id}:dayIndex`] ?? '0');
        const day = dayInIsoWeek(weekStart, dayIndex);

        const hours = parseFloatCustom(values[`workHour:${id}:hours`]);
        if (!hours || isNaN(hours)) throw new Error();

        workHours.push({
          userId: user?.id ?? null,
          day: formatCalendarDateWithOffset(day),
          hours,
        });
      });

      const [data, err] = await client.mutate('regieReports.create', {
        projectId: projectId,
        day: formatCalendarDateWithOffset(weekStart),
        summary: values.summary,
        products: records,
        specialRecords,
        workHours,
      });

      if (err) throw err;
      if (!data) return;

      navigate(`/regieReports/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: 'Regiebericht erstellen',
      primaryButtonText: 'Erstellen',
    }),
  });
}

export function showModifyRegieReportModal(modals: MyModalsInterface, report: RegieReport) {
  modals.showForm({
    content: ({ context }) => {
      const [recordIds, setRecordIds] = useState<string[]>([]);
      const [specialRecordIds, setSpecialRecordIds] = useState<string[]>([]);
      const [workHourIds, setWorkHourIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);

      const initialRecordValues = useRef<Record<string, {
        product: Product | null;
        amount: number;
        unit: string | null;
      }>>({}).current;
      const initialSpecialRecordValues = useRef<Record<string, {
        name: string;
        unit: string;
        amount: number;
      }>>({}).current;
      const initialWorkHourValues = useRef<Record<string, {
        user: any | null;
        dayIndex: number;
        hours: number;
      }>>({}).current;

      const forceUpdate = useForceUpdate();
      const createEntityAction = useCreateEntityAction(modals);

      return <>
        <MyForm.MultiSelect
          minSelectedItems={1} maxSelectedItems={1}
          name="project" labelText="Projekt"
          disabled
          getOptions={async ({ query }) => {
            const [data] = await client.query('projects.list', { search: query });
            return data ?? [];
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
        />
        <p className="light">Projektzuordnung ist fix; hier wird nur zur Einordnung angezeigt.</p>

        <MyForm.Input textArea name="summary" labelText="Zusammenfassung" />
        <p className="light">Beschreibe die ausgeführten Arbeiten für die gesamte Kalenderwoche.</p>

        <MyForm.DateInput
          required
          name="week"
          labelText="Woche (beliebiger Tag)"
          rules={[date => {
            if (!date) return null;
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            if (date.getTime() > today.getTime()) return 'Datum darf nicht in der Zukunft liegen';
            return null;
          }]}
        />
        <p className="light">Der Bericht gilt immer für Montag bis Sonntag der gewählten Kalenderwoche.</p>

        <MyDivider />

        <h4>Arbeitszeit</h4>
        <p className="light">Pro Eintrag Tag, Mitarbeiter und Stunden der gewählten Woche erfassen.</p>

        {workHourIds.map(id => {
          return <Fragment key={id}>
            <div className="flex flex-col gap-2">
              <MyForm.Select
                required
                name={`workHour:${id}:dayIndex`}
                labelText="Tag"
                getOptions={() => WEEKDAY_OPTIONS}
                buildOption={({ id: optionId, label }) => ({ text: label, value: optionId })}
              />

              <MyForm.MultiSelect
                name={`workHour:${id}:user`}
                labelText="Mitarbeiter"
                autoFocus={autoFocusFieldName === `workHour:${id}:user`}
                minSelectedItems={1} maxSelectedItems={1}
                getOptions={async ({ query }) => {
                  const [data, err] = await client.query('users.list', { search: query });
                  if (err) throw err;
                  return data ?? [];
                }}
                renderItem={({ item }) => userFullName(item)}
                renderTile={item => <SmallUserTile data={item} noLink />}
                createAction={createEntityAction.user}
              />

              <div className="flex gap-2 items-end">
                <div className="grow">
                  <MyForm.Input
                    required
                    name={`workHour:${id}:hours`}
                    labelText="Stunden"
                    type="number"
                    rules={[
                      MyForm.Input.rules.num,
                      value => {
                        if (!value.trim()) return null;
                        const hours = parseFloatCustom(value);
                        if (isNaN(hours)) return null;
                        if (hours < 0 || hours > 10) return 'Stunden müssen zwischen 0 und 10 liegen';
                        return null;
                      },
                    ]}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Arbeitszeit entfernen" aria-label="Arbeitszeit entfernen" onClick={() => {
                      setWorkHourIds(ids => ids.filter(_id => _id !== id));
                    }}><Icons.Delete /></MyButton>}
                  />
                </div>
              </div>
            </div>

            <NotifyLoaded onLoad={() => {
              const initial = initialWorkHourValues[id];
              if (!initial) return;

              const values: Record<string, any> = {
                [`workHour:${id}:dayIndex`]: `${initial.dayIndex}`,
                [`workHour:${id}:hours`]: initial.hours,
              };
              if (initial.user) values[`workHour:${id}:user`] = [initial.user];
              context.setValues(values);
            }} />

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setWorkHourIds(ids => [...ids, id]);
          setAutoFocusFieldName(`workHour:${id}:user`);
          context.setValues({ [`workHour:${id}:dayIndex`]: '0' });
        }}>Arbeitszeit</MyButton>

        <MyDivider />

        <h4>Produkte</h4>
        <p className="light">Verbrauchte Produkte inklusive Menge und Einheit dokumentieren.</p>

        {recordIds.map(id => {
          const currentProduct = () => {
            return (context?.field(`record:${id}:product`)?.getValue()?.[0] ?? null) as Product | null;
          };

          return <Fragment key={id}>
            <MyForm.MultiSelect
              name={`record:${id}:product`}
              labelText="Produkt"
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
                    name={`record:${id}:amount`} labelText="Anzahl"
                    type="number"
                    rules={[MyForm.Input.rules.num]}
                  />
                </div>

                <div className="basis-1/2 flex-1">
                  <MyForm.Select
                    name={`record:${id}:unit`}
                    labelText="Einheit"
                    getOptions={() => {
                      const _product = currentProduct();
                      if (!_product) return [];
                      return [_product.baseUnit, ...Object.keys(_product.otherUnits)].map(e => ({ id: e }));
                    }}
                    getOptionsDeps={[currentProduct()?.id]}
                    buildOption={({ id })=> ({ text: id, value: id })}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Eintrag entfernen" aria-label="Eintrag entfernen" onClick={() => {
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
              if (initial.unit) values[`record:${id}:unit`] = initial.unit;

              context.setValues(values);

              // if (initial.unit) setTimeout(() => {
              //   context.setValues({
              //     [`record:${id}:unit`]: initial.unit,
              //   });
              // }, 10);
            }} />

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setRecordIds(ids => [...ids, id]);
          setAutoFocusFieldName(`record:${id}:product`);
        }}>Eintrag</MyButton>

        <MyDivider />

        <h4>Sonderposten</h4>
        <p className="light">Weitere Positionen erfassen, die nicht als Produkt vorhanden sind.</p>

        {specialRecordIds.map(id => {
          return <Fragment key={id}>
            <div className="flex gap-2 items-end">
              <div className="grow flex flex-col gap-2">
                <div>
                  <MyForm.Input
                    required
                    name={`specialRecord:${id}:name`}
                    labelText="Bezeichnung"
                    autoFocus={autoFocusFieldName === `specialRecord:${id}:name`}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="basis-1/2 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:amount`}
                      labelText="Menge"
                      type="number"
                      rules={[MyForm.Input.rules.num]}
                    />
                  </div>

                  <div className="basis-1/2 flex-1">
                    <MyForm.Input
                      required
                      name={`specialRecord:${id}:unit`}
                      labelText="Einheit"
                      suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Sonderposten entfernen" aria-label="Sonderposten entfernen" onClick={() => {
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
              });
            }} />

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setSpecialRecordIds(ids => [...ids, id]);
          setAutoFocusFieldName(`specialRecord:${id}:name`);
        }}>Sonderposten</MyButton>

        <NotifyLoaded onLoad={async () => {
          const weekStart = startOfIsoWeek(new Date(report.day));

          context.setValues({
            summary: report.summary ?? '',
            week: report.day,
          });

          if (report.projectId) {
            const [project] = await client.query('projects.get', { id: report.projectId }, { strategy: 'cache-first' });
            if (project) context.setValues({ project: [project] });
          }

          const recordIdList: string[] = [];
          for (const record of report.products) {
            const id = generateId();
            recordIdList.push(id);

            const [product] = await client.query('products.get', { id: record.productId }, { strategy: 'cache-first' });
            const [amount, unit] = product ? upmatchUnit(product, record.quantity) : [record.quantity, null];
            initialRecordValues[id] = {
              product: product ?? null,
              amount,
              unit,
            };
          }

          const specialRecordIdList: string[] = [];
          report.specialRecords?.forEach(record => {
            const id = generateId();
            specialRecordIdList.push(id);
            initialSpecialRecordValues[id] = {
              name: record.name,
              unit: record.unit,
              amount: record.amount,
            };
          });

          const workHourIdList: string[] = [];
          for (const record of report.workHours ?? []) {
            const id = generateId();
            workHourIdList.push(id);

            let user: any | null = null;
            if (record.userId) {
              const [data] = await client.query('users.get', { id: record.userId }, { strategy: 'cache-first' });
              user = data ?? null;
            }

            const recordDay = new Date(record.day);
            recordDay.setHours(0, 0, 0, 0);
            const deltaDays = Math.floor((recordDay.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
            const dayIndex = deltaDays >= 0 && deltaDays < WEEKDAY_NAMES.length ? deltaDays : 0;

            initialWorkHourValues[id] = {
              user,
              dayIndex,
              hours: record.hours,
            };
          }

          setRecordIds(recordIdList);
          setSpecialRecordIds(specialRecordIdList);
          setWorkHourIds(workHourIdList);
        }} />
      </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      const weekInput = values.week ? new Date(values.week) : new Date();
      if (isNaN(weekInput.getTime())) throw new Error('Ungültige Woche');
      const weekStart = startOfIsoWeek(weekInput);

      const records: {
        productId: string;
        quantity: number;
        comment?: string | null;
      }[] = [];

      const specialRecords: {
        name: string;
        unit: string;
        amount: number;
      }[] = [];

      const workHours: {
        userId?: string | null;
        day: string;
        hours: number;
      }[] = [];

      const recordIds = new Set<string>();
      const specialRecordIds = new Set<string>();
      const workHourIds = new Set<string>();
      Object.keys(values).forEach(key => {
        if (!key.startsWith('record:')) return;
        const [,id] = key.split(':');
        recordIds.add(id);
      });

      Object.keys(values).forEach(key => {
        if (!key.startsWith('specialRecord:')) return;
        const [,id] = key.split(':');
        specialRecordIds.add(id);
      });

      Object.keys(values).forEach(key => {
        if (!key.startsWith('workHour:')) return;
        const [,id] = key.split(':');
        workHourIds.add(id);
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

        records.push({ productId: product.id,quantity: inBaseUnits });
      });

      specialRecordIds.forEach(id => {
        const name = values[`specialRecord:${id}:name`];
        if (!name) throw new Error();

        const unit = values[`specialRecord:${id}:unit`];
        if (!unit) throw new Error();

        const amount = parseFloatCustom(values[`specialRecord:${id}:amount`]);
        if (!amount || isNaN(amount)) throw new Error();

        specialRecords.push({
          name,
          unit,
          amount,
        });
      });

      workHourIds.forEach(id => {
        const user = values[`workHour:${id}:user`]?.at(0);

        const dayIndex = parseWeekdayIndex(values[`workHour:${id}:dayIndex`] ?? '0');
        const day = dayInIsoWeek(weekStart, dayIndex);

        const hours = parseFloatCustom(values[`workHour:${id}:hours`]);
        if (!hours || isNaN(hours)) throw new Error();

        workHours.push({
          userId: user?.id ?? null,
          day: formatCalendarDateWithOffset(day),
          hours,
        });
      });

      const [data, err] = await client.mutate('regieReports.update', {
        id: report.id,
        data: {
          day: formatCalendarDateWithOffset(weekStart),
          summary: values.summary,
          products: records,
          specialRecords,
          workHours,
        },
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: 'Regiebericht bearbeiten',
      primaryButtonText: 'Speichern',
    }),
  });
}

export function showDeleteRegieReportModal(modals: MyModalsInterface, report: RegieReport) {
  modals.showForm({
    content: () => <>
      <p className="light">
        Alle mit diesem Regiebericht in Verbindung stehenden Daten werden damit ebenfalls gelöscht.
        {" "}<b>Diese Aktion kann nicht rückgängig gemacht werden.</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText="Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann."
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('regieReports.delete', { id: report.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/regieReports/${report.id}`) navigate('/regieReports');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: 'Regiebericht löschen',
      primaryButtonText: 'Löschen',
    }),
  });
}
