import { uiText } from "~/lib/i18n";
import { Fragment, useEffect, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client, contentAccess } from "~/lib/client";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { newProductRowId, publicId } from "~/lib/data/products";
import { regieReportForm } from "~/lib/regieReportForm";
import { productTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProductTile, SmallProjectTile, SmallUserTile } from "~/lib/tiles";
import { generateId, parseFloatCustom, upmatchUnit } from "~/lib/utils";
import {
  startOfIsoWeek,
  weekdayIndexInIsoWeek,
  WEEKDAY_NAMES,
} from "~/lib/week";
import type { Product, RegieReport, User } from "~/type-helpers";

const WEEKDAY_OPTIONS = WEEKDAY_NAMES.map((label, dayIndex) => ({
  id: `${dayIndex}`,
  label,
}));

export function showCreateRegieReportModal(modals: MyModalsInterface) {
  const operationId = publicId(newProductRowId());
  modals.showForm({
    content: ({ context }) => {
      const session = useSessionInfo(),
        [projectId, setProjectId] = useState<string | null>(null);
      const canHours = projectId
        ? session.canAccess(
            `project:${projectId}:regie-reports`,
            "personnel",
            "create",
          )
        : session.canCreate("regie-report");
      const [recordIds, setRecordIds] = useState<string[]>([]);
      const [specialRecordIds, setSpecialRecordIds] = useState<string[]>([]);
      const [workHourIds, setWorkHourIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<
        string | null
      >(null);
      const createEntityAction = useCreateEntityAction(modals);

      useEffect(() => {
        const id = generateId();
        setWorkHourIds([id]);
        context.setValues({ [`workHour:${id}:dayIndex`]: "0" });
      }, []);

      const forceUpdate = useForceUpdate();

      return (
        <>
          <MyForm.MultiSelect
            minSelectedItems={1}
            maxSelectedItems={1}
            name="project"
            onValueChange={(items) => setProjectId(items[0]?.id ?? null)}
            labelText={uiText("Projekt")}
            getOptions={async ({ query }) => {
              const [data] = await client.query("projects.list", {
                search: query,
              });
              return data ?? [];
            }}
            renderItem={({ item }) => item.title}
            renderTile={(item) => <SmallProjectTile data={item} noLink />}
            createAction={createEntityAction.project}
          />
          <p className="light">
            {uiText(
              "Wähle das Projekt, für das der Regiebericht erstellt wird.",
            )}
          </p>

          <MyForm.Input
            textArea
            name="summary"
            labelText={uiText("Beschreibung der Arbeiten")}
          />
          <p className="light">
            {uiText(
              "Beschreibe die ausgeführten Arbeiten für die gesamte Kalenderwoche.",
            )}
          </p>

          <MyForm.DateInput
            required
            name="week"
            labelText={uiText("Woche (beliebiger Tag)")}
            rules={[
              (date) => {
                if (!date) return null;
                const today = new Date();
                today.setHours(23, 59, 59, 999);
                if (date.getTime() > today.getTime())
                  return uiText("Datum darf nicht in der Zukunft liegen");
                return null;
              },
            ]}
          />
          <p className="light">
            {uiText(
              "Der Bericht gilt immer für Montag bis Sonntag der gewählten Kalenderwoche.",
            )}
          </p>

          <MyDivider />

          {canHours && (
            <>
              <h4 className="text-lg leading-snug font-semibold">
                {uiText("Arbeitszeit")}
              </h4>
              <p className="light">
                {uiText(
                  "Pro Eintrag Tag, Mitarbeiter und Stunden der ausgewählten Woche erfassen.",
                )}
              </p>

              {workHourIds.map((id) => {
                return (
                  <Fragment key={id}>
                    <div className="flex flex-col gap-2">
                      <MyForm.Select
                        required
                        name={`workHour:${id}:dayIndex`}
                        labelText={uiText("Tag")}
                        getOptions={() => WEEKDAY_OPTIONS}
                        buildOption={({ id: optionId, label }) => ({
                          text: label,
                          value: optionId,
                        })}
                      />

                      <MyForm.MultiSelect
                        name={`workHour:${id}:user`}
                        labelText={uiText("Mitarbeiter")}
                        focusOnMount={
                          autoFocusFieldName === `workHour:${id}:user`
                        }
                        minSelectedItems={1}
                        maxSelectedItems={1}
                        getOptions={async ({ query }) => {
                          const [data, err] = await client.query("users.list", {
                            search: query,
                          });
                          if (err) throw err;
                          return data ?? [];
                        }}
                        renderItem={({ item }) => userFullName(item)}
                        renderTile={(item) => (
                          <SmallUserTile data={item} noLink />
                        )}
                        createAction={createEntityAction.user}
                      />

                      <div className="flex gap-2 items-end">
                        <div className="grow">
                          <MyForm.Input
                            required
                            name={`workHour:${id}:hours`}
                            labelText={uiText("Stunden")}
                            type="number"
                            rules={[
                              MyForm.Input.rules.num,
                              (value) => {
                                if (!value.trim()) return null;
                                const hours = parseFloatCustom(value);
                                if (isNaN(hours)) return null;
                                if (hours < 0 || hours > 10)
                                  return uiText(
                                    "Stunden müssen zwischen 0 und 10 liegen",
                                    "Hours must be between 0 and 10",
                                  );
                                return null;
                              },
                            ]}
                            suffix={
                              <MyButton
                                kind="ghost"
                                size="sm"
                                className="ss-input-suffix-btn"
                                title={uiText("Arbeitszeit entfernen")}
                                aria-label={uiText("Arbeitszeit entfernen")}
                                onClick={() => {
                                  setWorkHourIds((ids) =>
                                    ids.filter((_id) => _id !== id),
                                  );
                                }}
                              >
                                <Icons.Delete />
                              </MyButton>
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <div style={{ height: "1rem" }} />
                  </Fragment>
                );
              })}

              <MyButton
                kind="secondary"
                renderIcon={Icons.Plus}
                onClick={() => {
                  const id = generateId();
                  setWorkHourIds((ids) => [...ids, id]);
                  setAutoFocusFieldName(`workHour:${id}:user`);
                  context.setValues({ [`workHour:${id}:dayIndex`]: "0" });
                }}
              >
                {uiText("Arbeitszeit")}
              </MyButton>

              <MyDivider />
            </>
          )}
          <h4 className="text-lg leading-snug font-semibold">
            {uiText("Produkte")}
          </h4>
          <p className="light">
            {uiText(
              "Verbrauchte Produkte inklusive Menge und Einheit dokumentieren.",
            )}
          </p>

          {recordIds.map((id) => {
            const currentProduct = () => {
              return (context?.field(`record:${id}:product`)?.getValue()?.[0] ??
                null) as Product | null;
            };

            return (
              <Fragment key={id}>
                <MyForm.MultiSelect
                  name={`record:${id}:product`}
                  labelText={uiText("Produkt")}
                  focusOnMount={autoFocusFieldName === `record:${id}:product`}
                  minSelectedItems={1}
                  maxSelectedItems={1}
                  getOptions={async ({ query }) => {
                    const [data, err] = await client.query("products.list", {
                      search: query,
                    });
                    if (err) throw err;
                    return data ?? [];
                  }}
                  renderItem={({ item }) =>
                    `${item.customId} ${productTitle(item)}`
                  }
                  renderTile={(item) => <SmallProductTile data={item} noLink />}
                  createAction={createEntityAction.product}
                  onValueChange={forceUpdate}
                />

                <div key={id} className="flex gap-2 items-end">
                  <div className="grow flex gap-2">
                    <div className="min-w-0 basis-1/2 flex-1">
                      <MyForm.Input
                        required
                        name={`record:${id}:amount`}
                        labelText={uiText("Anzahl")}
                        type="number"
                        rules={[MyForm.Input.rules.num]}
                      />
                    </div>

                    <div className="min-w-0 basis-1/2 flex-1">
                      <MyForm.Select
                        name={`record:${id}:unit`}
                        labelText={uiText("Einheit")}
                        getOptions={() => {
                          const _product = currentProduct();
                          if (!_product) return [];
                          return [
                            _product.baseUnit,
                            ...Object.keys(_product.otherUnits),
                          ].map((e) => ({ id: e }));
                        }}
                        getOptionsDeps={[currentProduct()?.id]}
                        buildOption={({ id }) => ({ text: id, value: id })}
                        suffix={
                          <MyButton
                            kind="ghost"
                            size="sm"
                            className="ss-input-suffix-btn"
                            title={uiText("Eintrag entfernen")}
                            aria-label={uiText("Eintrag entfernen")}
                            onClick={() => {
                              setRecordIds((ids) =>
                                ids.filter((_id) => _id !== id),
                              );
                            }}
                          >
                            <Icons.Delete />
                          </MyButton>
                        }
                      />
                    </div>
                  </div>
                </div>

                <div style={{ height: "1rem" }} />
              </Fragment>
            );
          })}

          <MyButton
            kind="secondary"
            renderIcon={Icons.Plus}
            onClick={() => {
              const id = generateId();
              setRecordIds((ids) => [...ids, id]);
              setAutoFocusFieldName(`record:${id}:product`);
            }}
          >
            {uiText("Eintrag")}
          </MyButton>

          <MyDivider />

          <h4 className="text-lg leading-snug font-semibold">
            {uiText("Sonderposten")}
          </h4>
          <p className="light">
            {uiText(
              "Weitere Positionen erfassen, die nicht als Produkt vorhanden sind.",
            )}
          </p>

          {specialRecordIds.map((id) => {
            return (
              <Fragment key={id}>
                <div className="flex gap-2 items-end">
                  <div className="grow flex flex-col gap-2">
                    <div>
                      <MyForm.Input
                        required
                        name={`specialRecord:${id}:name`}
                        labelText={uiText("Bezeichnung")}
                        focusOnMount={
                          autoFocusFieldName === `specialRecord:${id}:name`
                        }
                      />
                    </div>

                    <div className="flex gap-2">
                      <div className="min-w-0 basis-1/2 flex-1">
                        <MyForm.Input
                          required
                          name={`specialRecord:${id}:amount`}
                          labelText={uiText("Menge")}
                          type="number"
                          rules={[MyForm.Input.rules.num]}
                        />
                      </div>

                      <div className="min-w-0 basis-1/2 flex-1">
                        <MyForm.Input
                          required
                          name={`specialRecord:${id}:unit`}
                          labelText={uiText("Einheit")}
                          suffix={
                            <MyButton
                              kind="ghost"
                              size="sm"
                              className="ss-input-suffix-btn"
                              title={uiText("Sonderposten entfernen")}
                              aria-label={uiText("Sonderposten entfernen")}
                              onClick={() => {
                                setSpecialRecordIds((ids) =>
                                  ids.filter((_id) => _id !== id),
                                );
                              }}
                            >
                              <Icons.Delete />
                            </MyButton>
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ height: "1rem" }} />
              </Fragment>
            );
          })}

          <MyButton
            kind="secondary"
            renderIcon={Icons.Plus}
            onClick={() => {
              const id = generateId();
              setSpecialRecordIds((ids) => [...ids, id]);
              setAutoFocusFieldName(`specialRecord:${id}:name`);
            }}
          >
            {uiText("Sonderposten")}
          </MyButton>

          <NotifyLoaded
            onLoad={() => {
              context.field("week")?.setValue(new Date());
            }}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      const projectId = values.project[0]?.id;

      const access = await contentAccess.read();
      if (
        !access?.can(
          `project:${projectId}:regie-reports`,
          "master-data",
          "create",
        )
      )
        throw new Error(
          uiText(
            "Keine Anlageberechtigung für dieses Projekt.",
            "Creation is not permitted for this project.",
          ),
        );
      const changes = regieReportForm(values, {
        material: true,
        hours: access.can(
          `project:${projectId}:regie-reports`,
          "personnel",
          "create",
        ),
      });
      const [data, err] = await client.mutate("regieReports.create", {
        operationId,
        projectId,
        ...changes,
        day: changes.day!,
      });

      if (err) throw err;
      if (!data) return;

      navigate(`/regieReports/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Regiebericht erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showModifyRegieReportModal(
  modals: MyModalsInterface,
  report: RegieReport,
) {
  let initialized = false,
    displayed = { material: false, hours: false };
  modals.showForm({
    content: ({ context }) => {
      const session = useSessionInfo(),
        scope = `project:${report.projectId}:regie-reports`;
      const canMaterial = session.canAccess(scope, "master-data", "update");
      const canHours =
        report.workHoursAvailable !== false &&
        session.canAccess(
          scope,
          "personnel",
          report.hoursRevision && report.hoursRevision !== "0"
            ? "update"
            : "create",
        );
      displayed = { material: canMaterial, hours: canHours };
      const [recordIds, setRecordIds] = useState<string[]>([]);
      const [specialRecordIds, setSpecialRecordIds] = useState<string[]>([]);
      const [workHourIds, setWorkHourIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<
        string | null
      >(null);

      const initialRecordValues = useRef<
        Record<
          string,
          {
            product: Product | null;
            amount: number;
            unit: string | null;
          }
        >
      >({}).current;
      const initialSpecialRecordValues = useRef<
        Record<
          string,
          {
            name: string;
            unit: string;
            amount: number;
          }
        >
      >({}).current;
      const initialWorkHourValues = useRef<
        Record<
          string,
          {
            user: User | null;
            dayIndex: number;
            hours: number;
          }
        >
      >({}).current;

      const forceUpdate = useForceUpdate();
      const createEntityAction = useCreateEntityAction(modals);

      return (
        <>
          <MyForm.MultiSelect
            minSelectedItems={1}
            maxSelectedItems={1}
            name="project"
            labelText={uiText("Projekt")}
            disabled
            getOptions={async ({ query }) => {
              const [data] = await client.query("projects.list", {
                search: query,
              });
              return data ?? [];
            }}
            renderItem={({ item }) => item.title}
            renderTile={(item) => <SmallProjectTile data={item} noLink />}
          />
          <p className="light">
            {uiText(
              "Projektzuordnung ist fix; hier wird nur zur Einordnung angezeigt.",
            )}
          </p>

          <MyForm.Input
            textArea
            name="summary"
            disabled={!canMaterial}
            labelText={uiText("Zusammenfassung")}
          />
          <p className="light">
            {uiText(
              "Beschreibe die ausgeführten Arbeiten für die gesamte Kalenderwoche.",
            )}
          </p>

          <MyForm.DateInput
            required
            name="week"
            disabled={!canMaterial || !canHours}
            labelText={uiText("Woche (beliebiger Tag)")}
            rules={[
              (date) => {
                if (!date) return null;
                const today = new Date();
                today.setHours(23, 59, 59, 999);
                if (date.getTime() > today.getTime())
                  return uiText("Datum darf nicht in der Zukunft liegen");
                return null;
              },
            ]}
          />
          <p className="light">
            {uiText(
              "Der Bericht gilt immer für Montag bis Sonntag der gewählten Kalenderwoche.",
            )}
          </p>

          <MyDivider />

          {!canHours && (
            <p>
              {report.workHoursAvailable === false
                ? uiText(
                    "Arbeitszeiten nicht freigegeben",
                    "Work hours are not shared",
                  )
                : uiText("Arbeitszeiten: nur lesen", "Work hours: read only")}
            </p>
          )}
          {canHours && (
            <>
              <h4 className="text-lg leading-snug font-semibold">
                {uiText("Arbeitszeit")}
              </h4>
              <p className="light">
                {uiText(
                  "Pro Eintrag Tag, Mitarbeiter und Stunden der gewählten Woche erfassen.",
                )}
              </p>

              {workHourIds.map((id) => {
                return (
                  <Fragment key={id}>
                    <div className="flex flex-col gap-2">
                      <MyForm.Select
                        required
                        name={`workHour:${id}:dayIndex`}
                        labelText={uiText("Tag")}
                        getOptions={() => WEEKDAY_OPTIONS}
                        buildOption={({ id: optionId, label }) => ({
                          text: label,
                          value: optionId,
                        })}
                      />

                      {initialWorkHourValues[id] &&
                      !initialWorkHourValues[id].user ? (
                        <p>
                          {uiText("Mitarbeiter")}:{" "}
                          {uiText("Nicht freigegeben", "Not shared")}
                        </p>
                      ) : (
                        <MyForm.MultiSelect
                          name={`workHour:${id}:user`}
                          labelText={uiText("Mitarbeiter")}
                          focusOnMount={
                            autoFocusFieldName === `workHour:${id}:user`
                          }
                          minSelectedItems={1}
                          maxSelectedItems={1}
                          getOptions={async ({ query }) => {
                            const [data, err] = await client.query(
                              "users.list",
                              {
                                search: query,
                              },
                            );
                            if (err) throw err;
                            return data ?? [];
                          }}
                          renderItem={({ item }) => userFullName(item)}
                          renderTile={(item) => (
                            <SmallUserTile data={item} noLink />
                          )}
                          createAction={createEntityAction.user}
                        />
                      )}

                      <div className="flex gap-2 items-end">
                        <div className="grow">
                          <MyForm.Input
                            required
                            name={`workHour:${id}:hours`}
                            labelText={uiText("Stunden")}
                            type="number"
                            rules={[
                              MyForm.Input.rules.num,
                              (value) => {
                                if (!value.trim()) return null;
                                const hours = parseFloatCustom(value);
                                if (isNaN(hours)) return null;
                                if (hours < 0 || hours > 10)
                                  return uiText(
                                    "Stunden müssen zwischen 0 und 10 liegen",
                                    "Hours must be between 0 and 10",
                                  );
                                return null;
                              },
                            ]}
                            suffix={
                              <MyButton
                                kind="ghost"
                                size="sm"
                                className="ss-input-suffix-btn"
                                title={uiText("Arbeitszeit entfernen")}
                                aria-label={uiText("Arbeitszeit entfernen")}
                                onClick={() => {
                                  setWorkHourIds((ids) =>
                                    ids.filter((_id) => _id !== id),
                                  );
                                }}
                              >
                                <Icons.Delete />
                              </MyButton>
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <NotifyLoaded
                      onLoad={() => {
                        const initial = initialWorkHourValues[id];
                        if (!initial) return;

                        const values: Record<string, any> = {
                          [`workHour:${id}:dayIndex`]: `${initial.dayIndex}`,
                          [`workHour:${id}:hours`]: initial.hours,
                        };
                        if (initial.user)
                          values[`workHour:${id}:user`] = [initial.user];
                        context.setValues(values);
                      }}
                    />

                    <div style={{ height: "1rem" }} />
                  </Fragment>
                );
              })}

              <MyButton
                kind="secondary"
                renderIcon={Icons.Plus}
                onClick={() => {
                  const id = generateId();
                  setWorkHourIds((ids) => [...ids, id]);
                  setAutoFocusFieldName(`workHour:${id}:user`);
                  context.setValues({ [`workHour:${id}:dayIndex`]: "0" });
                }}
              >
                {uiText("Arbeitszeit")}
              </MyButton>

              <MyDivider />
            </>
          )}
          {canMaterial && (
            <>
              <h4 className="text-lg leading-snug font-semibold">
                {uiText("Produkte")}
              </h4>
              <p className="light">
                {uiText(
                  "Verbrauchte Produkte inklusive Menge und Einheit dokumentieren.",
                )}
              </p>

              {recordIds.map((id) => {
                const currentProduct = () => {
                  return (context
                    ?.field(`record:${id}:product`)
                    ?.getValue()?.[0] ?? null) as Product | null;
                };

                return (
                  <Fragment key={id}>
                    {initialRecordValues[id] &&
                    !initialRecordValues[id].product ? (
                      <p>
                        {uiText("Produkt")}:{" "}
                        {uiText("Nicht freigegeben", "Not shared")}
                      </p>
                    ) : (
                      <MyForm.MultiSelect
                        name={`record:${id}:product`}
                        labelText={uiText("Produkt")}
                        focusOnMount={
                          autoFocusFieldName === `record:${id}:product`
                        }
                        minSelectedItems={1}
                        maxSelectedItems={1}
                        getOptions={async ({ query }) => {
                          const [data, err] = await client.query(
                            "products.list",
                            {
                              search: query,
                            },
                          );
                          if (err) throw err;
                          return data ?? [];
                        }}
                        renderItem={({ item }) =>
                          `${item.customId} ${productTitle(item)}`
                        }
                        renderTile={(item) => (
                          <SmallProductTile data={item} noLink />
                        )}
                        createAction={createEntityAction.product}
                        onValueChange={forceUpdate}
                      />
                    )}

                    <div key={id} className="flex gap-2 items-end">
                      <div className="grow flex gap-2">
                        <div className="min-w-0 basis-1/2 flex-1">
                          <MyForm.Input
                            required
                            name={`record:${id}:amount`}
                            labelText={uiText("Anzahl")}
                            type="number"
                            rules={[MyForm.Input.rules.num]}
                          />
                        </div>

                        <div className="min-w-0 basis-1/2 flex-1">
                          <MyForm.Select
                            name={`record:${id}:unit`}
                            labelText={uiText("Einheit")}
                            getOptions={() => {
                              const _product = currentProduct();
                              if (!_product) return [];
                              return [
                                _product.baseUnit,
                                ...Object.keys(_product.otherUnits),
                              ].map((e) => ({ id: e }));
                            }}
                            getOptionsDeps={[currentProduct()?.id]}
                            buildOption={({ id }) => ({ text: id, value: id })}
                            suffix={
                              <MyButton
                                kind="ghost"
                                size="sm"
                                className="ss-input-suffix-btn"
                                title={uiText("Eintrag entfernen")}
                                aria-label={uiText("Eintrag entfernen")}
                                onClick={() => {
                                  setRecordIds((ids) =>
                                    ids.filter((_id) => _id !== id),
                                  );
                                }}
                              >
                                <Icons.Delete />
                              </MyButton>
                            }
                          />
                        </div>
                      </div>
                    </div>

                    <NotifyLoaded
                      onLoad={() => {
                        const initial = initialRecordValues[id];
                        if (!initial) return;

                        const values: Record<string, any> = {
                          [`record:${id}:amount`]: initial.amount,
                        };

                        if (initial.product)
                          values[`record:${id}:product`] = [initial.product];
                        if (initial.unit)
                          values[`record:${id}:unit`] = initial.unit;

                        context.setValues(values);

                        // if (initial.unit) setTimeout(() => {
                        //   context.setValues({
                        //     [`record:${id}:unit`]: initial.unit,
                        //   });
                        // }, 10);
                      }}
                    />

                    <div style={{ height: "1rem" }} />
                  </Fragment>
                );
              })}

              <MyButton
                kind="secondary"
                renderIcon={Icons.Plus}
                onClick={() => {
                  const id = generateId();
                  setRecordIds((ids) => [...ids, id]);
                  setAutoFocusFieldName(`record:${id}:product`);
                }}
              >
                {uiText("Eintrag")}
              </MyButton>

              <MyDivider />

              <h4 className="text-lg leading-snug font-semibold">
                {uiText("Sonderposten")}
              </h4>
              <p className="light">
                {uiText(
                  "Weitere Positionen erfassen, die nicht als Produkt vorhanden sind.",
                )}
              </p>

              {specialRecordIds.map((id) => {
                return (
                  <Fragment key={id}>
                    <div className="flex gap-2 items-end">
                      <div className="grow flex flex-col gap-2">
                        <div>
                          <MyForm.Input
                            required
                            name={`specialRecord:${id}:name`}
                            labelText={uiText("Bezeichnung")}
                            focusOnMount={
                              autoFocusFieldName === `specialRecord:${id}:name`
                            }
                          />
                        </div>

                        <div className="flex gap-2">
                          <div className="min-w-0 basis-1/2 flex-1">
                            <MyForm.Input
                              required
                              name={`specialRecord:${id}:amount`}
                              labelText={uiText("Menge")}
                              type="number"
                              rules={[MyForm.Input.rules.num]}
                            />
                          </div>

                          <div className="min-w-0 basis-1/2 flex-1">
                            <MyForm.Input
                              required
                              name={`specialRecord:${id}:unit`}
                              labelText={uiText("Einheit")}
                              suffix={
                                <MyButton
                                  kind="ghost"
                                  size="sm"
                                  className="ss-input-suffix-btn"
                                  title={uiText("Sonderposten entfernen")}
                                  aria-label={uiText("Sonderposten entfernen")}
                                  onClick={() => {
                                    setSpecialRecordIds((ids) =>
                                      ids.filter((_id) => _id !== id),
                                    );
                                  }}
                                >
                                  <Icons.Delete />
                                </MyButton>
                              }
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    <NotifyLoaded
                      onLoad={() => {
                        const initial = initialSpecialRecordValues[id];
                        if (!initial) return;

                        context.setValues({
                          [`specialRecord:${id}:name`]: initial.name,
                          [`specialRecord:${id}:unit`]: initial.unit,
                          [`specialRecord:${id}:amount`]: initial.amount,
                        });
                      }}
                    />

                    <div style={{ height: "1rem" }} />
                  </Fragment>
                );
              })}

              <MyButton
                kind="secondary"
                renderIcon={Icons.Plus}
                onClick={() => {
                  const id = generateId();
                  setSpecialRecordIds((ids) => [...ids, id]);
                  setAutoFocusFieldName(`specialRecord:${id}:name`);
                }}
              >
                {uiText("Sonderposten")}
              </MyButton>
            </>
          )}
          <NotifyLoaded
            onLoad={async () => {
              const weekStart = startOfIsoWeek(new Date(report.day));

              context.setValues({
                summary: report.summary ?? "",
                week: report.day,
              });

              if (report.projectId) {
                const [project] = await client.query(
                  "projects.get",
                  { id: report.projectId },
                  { strategy: "cache-first" },
                );
                if (project) context.setValues({ project: [project] });
              }

              const recordIdList: string[] = [];
              for (const record of report.products) {
                const id = record.id;
                recordIdList.push(id);

                const [product] = await client.query(
                  "products.get",
                  { id: record.productId },
                  { strategy: "cache-first" },
                );
                const [amount, unit] = product
                  ? upmatchUnit(product, record.quantity)
                  : [record.quantity, null];
                initialRecordValues[id] = {
                  product: product ?? null,
                  amount,
                  unit,
                };
              }

              const specialRecordIdList: string[] = [];
              report.specialRecords?.forEach((record) => {
                const id = record.id;
                specialRecordIdList.push(id);
                initialSpecialRecordValues[id] = {
                  name: record.name,
                  unit: record.unit,
                  amount: record.amount,
                };
              });

              const workHourIdList: string[] = [];
              for (const record of report.workHours) {
                const id = record.id;
                workHourIdList.push(id);

                let user: User | null = null;
                if (record.userId) {
                  const [data] = await client.query(
                    "users.get",
                    { id: record.userId },
                    { strategy: "cache-first" },
                  );
                  user = data ?? null;
                }

                const deltaDays = weekdayIndexInIsoWeek(
                  new Date(record.day),
                  weekStart,
                );
                const dayIndex =
                  deltaDays >= 0 && deltaDays < WEEKDAY_NAMES.length
                    ? deltaDays
                    : 0;

                initialWorkHourValues[id] = {
                  user,
                  dayIndex,
                  hours: record.hours,
                };
              }

              setRecordIds(recordIdList);
              setSpecialRecordIds(specialRecordIdList);
              setWorkHourIds(workHourIdList);
              initialized = true;
            }}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      const access = await contentAccess.read(),
        scope = `project:${report.projectId}:regie-reports`;
      const material = access?.can(scope, "master-data", "update") === true;
      const hours =
        report.workHoursAvailable !== false &&
        access?.can(
          scope,
          "personnel",
          report.hoursRevision && report.hoursRevision !== "0"
            ? "update"
            : "create",
        ) === true;
      if (!material && !hours)
        throw new Error(
          uiText(
            "Keine Bearbeitungsfreigabe für diesen Bericht.",
            "Editing is not permitted for this report.",
          ),
        );
      if (!initialized)
        throw new Error(
          uiText(
            "Der Bericht wird noch geladen.",
            "The report is still loading.",
          ),
        );
      if ((displayed.material && !material) || (displayed.hours && !hours))
        throw new Error(
          uiText(
            "Die Freigaben haben sich geändert. Bitte den Bericht erneut öffnen.",
            "Permissions changed. Please reopen the report.",
          ),
        );
      const changes = regieReportForm(values, displayed, report);
      const [data, err] = await client.mutate("regieReports.update", {
        id: report.id,
        expectedRevision: report.revision,
        expectedHoursRevision: report.hoursRevision,
        data: changes,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Regiebericht bearbeiten"),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteRegieReportModal(
  modals: MyModalsInterface,
  report: RegieReport,
) {
  modals.showForm({
    content: () => (
      <>
        <p className="light">
          {uiText(
            "Alle mit diesem Regiebericht in Verbindung stehenden Daten werden damit ebenfalls gelöscht.",
          )}{" "}
          <b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
        </p>
        <MyForm.Checkbox
          required
          name="_understood"
          labelText={uiText(
            "Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.",
          )}
        />
      </>
    ),
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate("regieReports.delete", {
        id: report.id,
      });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/regieReports/${report.id}`) navigate("/regieReports");
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Regiebericht löschen"),
      primaryButtonText: uiText("Löschen"),
    }),
  });
}
