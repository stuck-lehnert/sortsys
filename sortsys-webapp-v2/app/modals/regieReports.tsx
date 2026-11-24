import { uiText } from "~/lib/i18n";
import { Fragment, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { ProductRecordFields } from "~/components/ProductRecordFields";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { ReportWorkHourFields } from "~/components/ReportWorkHourFields";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client, contentAccess } from "~/lib/client";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { newProductRowId, publicId } from "~/lib/data/products";
import { mapConcurrent } from "~/lib/data/runtime/concurrentReads";
import { regieReportForm } from "~/lib/regieReportForm";
import { validateReportDate } from "~/lib/reportForm";
import { Icons } from "~/lib/icons";
import { SmallProjectTile } from "~/lib/tiles";
import { generateId, upmatchUnit } from "~/lib/utils";
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

type InitialWorkHour = { user: User | null; dayIndex: number; hours: number };

function RegieWorkHours({
  ids,
  initialValues,
  context,
  createUser,
  focusField,
  setFocusField,
  setIds,
}: {
  ids: string[];
  initialValues?: Record<string, InitialWorkHour>;
  context: MyPublicFormContext;
  createUser: ReturnType<typeof useCreateEntityAction>["user"];
  focusField: string | null;
  setFocusField: (name: string) => void;
  setIds: Dispatch<SetStateAction<string[]>>;
}) {
  return (
    <>
      <h4 className="text-lg leading-snug font-semibold">
        {uiText("Arbeitszeit")}
      </h4>
      <p className="light">
        {uiText(
          "Pro Eintrag Tag, Mitarbeiter und Stunden der ausgewählten Woche erfassen.",
        )}
      </p>

      {ids.map((id) => {
        const prefix = `workHour:${id}:`;
        const initial = initialValues?.[id];

        return (
          <Fragment key={id}>
            <ReportWorkHourFields
              fieldPrefix={`workHour:${id}`}
              createUser={createUser}
              focusEmployee={focusField === `${prefix}user`}
              unavailableEmployee={
                initial && !initial.user
                  ? uiText("Nicht freigegeben", "Not shared")
                  : undefined
              }
              numberRule="num"
              onRemove={() => setIds((ids) => ids.filter((item) => item !== id))}
            >
              <MyForm.Select
                required
                name={`${prefix}dayIndex`}
                labelText={uiText("Tag")}
                getOptions={() => WEEKDAY_OPTIONS}
                buildOption={({ id: optionId, label }) => ({
                  text: label,
                  value: optionId,
                })}
              />

            </ReportWorkHourFields>

            {initial && (
              <NotifyLoaded
                onLoad={() =>
                  context.setValues({
                    [`${prefix}dayIndex`]: `${initial.dayIndex}`,
                    [`${prefix}hours`]: initial.hours,
                    ...(initial.user ? { [`${prefix}user`]: [initial.user] } : {}),
                  })
                }
              />
            )}

            <div style={{ height: "1rem" }} />
          </Fragment>
        );
      })}

      <MyButton
        kind="secondary"
        renderIcon={Icons.Plus}
        onClick={() => {
          const id = generateId();
          setIds((ids) => [...ids, id]);
          setFocusField(`workHour:${id}:user`);
          context.setValues({ [`workHour:${id}:dayIndex`]: "0" });
        }}
      >
        {uiText("Arbeitszeit")}
      </MyButton>

      <MyDivider />
    </>
  );
}

type InitialProduct = {
  product: Product | null;
  amount: number;
  unit: string | null;
};
type InitialSpecialRecord = { name: string; unit: string; amount: number };
type MaterialRows<T> = {
  ids: string[];
  setIds: Dispatch<SetStateAction<string[]>>;
  initialValues?: Record<string, T>;
};

function RegieMaterialFields({
  products,
  specialRecords,
  context,
  createProduct,
  onProductChange,
  focusField,
  setFocusField,
}: {
  products: MaterialRows<InitialProduct>;
  specialRecords: MaterialRows<InitialSpecialRecord>;
  context: MyPublicFormContext;
  createProduct: ReturnType<typeof useCreateEntityAction>["product"];
  onProductChange: () => void;
  focusField: string | null;
  setFocusField: (name: string) => void;
}) {
  return (
    <>
      <h4 className="text-lg leading-snug font-semibold">
        {uiText("Produkte")}
      </h4>
      <p className="light">
        {uiText(
          "Verbrauchte Produkte inklusive Menge und Einheit dokumentieren.",
        )}
      </p>

      {products.ids.map((id) => {
        const prefix = `record:${id}:`;
        const initial = products.initialValues?.[id];

        return (
          <Fragment key={id}>
            <ProductRecordFields
              prefix={prefix}
              focusProduct={focusField === `${prefix}product`}
              productHidden={!!initial && !initial.product}
              createProduct={createProduct}
              onProductChange={onProductChange}
              onRemove={() =>
                products.setIds((ids) => ids.filter((current) => current !== id))
              }
            />

            {initial && (
              <NotifyLoaded
                onLoad={() => {
                  context.setValues({
                    [`${prefix}amount`]: initial.amount,
                    ...(initial.product && {
                      [`${prefix}product`]: [initial.product],
                    }),
                    ...(initial.unit && { [`${prefix}unit`]: initial.unit }),
                  });
                }}
              />
            )}

            <div style={{ height: "1rem" }} />
          </Fragment>
        );
      })}

      <MyButton
        kind="secondary"
        renderIcon={Icons.Plus}
        onClick={() => {
          const id = generateId();
          products.setIds((ids) => [...ids, id]);
          setFocusField(`record:${id}:product`);
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

      {specialRecords.ids.map((id) => {
        const prefix = `specialRecord:${id}:`;

        return (
          <Fragment key={id}>
            <div className="flex gap-2 items-end">
              <div className="grow flex flex-col gap-2">
                <div>
                  <MyForm.Input
                    required
                    name={`${prefix}name`}
                    labelText={uiText("Bezeichnung")}
                    focusOnMount={focusField === `${prefix}name`}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="min-w-0 basis-1/2 flex-1">
                    <MyForm.Input
                      required
                      name={`${prefix}amount`}
                      labelText={uiText("Menge")}
                      type="number"
                      rules={[MyForm.Input.rules.num]}
                    />
                  </div>

                  <div className="min-w-0 basis-1/2 flex-1">
                    <MyForm.Input
                      required
                      name={`${prefix}unit`}
                      labelText={uiText("Einheit")}
                      suffix={
                        <MyButton
                          kind="ghost"
                          size="sm"
                          className="ss-input-suffix-btn"
                          title={uiText("Sonderposten entfernen")}
                          aria-label={uiText("Sonderposten entfernen")}
                          onClick={() =>
                            specialRecords.setIds((ids) =>
                              ids.filter((current) => current !== id),
                            )
                          }
                        >
                          <Icons.Delete />
                        </MyButton>
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            {specialRecords.initialValues && (
              <NotifyLoaded
                onLoad={() => {
                  const initial = specialRecords.initialValues?.[id];
                  if (!initial) return;

                  context.setValues({
                    [`${prefix}name`]: initial.name,
                    [`${prefix}unit`]: initial.unit,
                    [`${prefix}amount`]: initial.amount,
                  });
                }}
              />
            )}

            <div style={{ height: "1rem" }} />
          </Fragment>
        );
      })}

      <MyButton
        kind="secondary"
        renderIcon={Icons.Plus}
        onClick={() => {
          const id = generateId();
          specialRecords.setIds((ids) => [...ids, id]);
          setFocusField(`specialRecord:${id}:name`);
        }}
      >
        {uiText("Sonderposten")}
      </MyButton>
    </>
  );
}

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
            rules={[validateReportDate]}
          />
          <p className="light">
            {uiText(
              "Der Bericht gilt immer für Montag bis Sonntag der gewählten Kalenderwoche.",
            )}
          </p>

          <MyDivider />

          {canHours && (
            <RegieWorkHours
              ids={workHourIds}
              context={context}
              createUser={createEntityAction.user}
              focusField={autoFocusFieldName}
              setFocusField={setAutoFocusFieldName}
              setIds={setWorkHourIds}
            />
          )}
          <RegieMaterialFields
            products={{ ids: recordIds, setIds: setRecordIds }}
            specialRecords={{
              ids: specialRecordIds,
              setIds: setSpecialRecordIds,
            }}
            context={context}
            createProduct={createEntityAction.product}
            onProductChange={forceUpdate}
            focusField={autoFocusFieldName}
            setFocusField={setAutoFocusFieldName}
          />

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

      const initialRecordValues = useRef<Record<string, InitialProduct>>({})
        .current;
      const initialSpecialRecordValues = useRef<
        Record<string, InitialSpecialRecord>
      >({}).current;
      const initialWorkHourValues = useRef<Record<string, InitialWorkHour>>({})
        .current;

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
            rules={[validateReportDate]}
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
            <RegieWorkHours
              ids={workHourIds}
              initialValues={initialWorkHourValues}
              context={context}
              createUser={createEntityAction.user}
              focusField={autoFocusFieldName}
              setFocusField={setAutoFocusFieldName}
              setIds={setWorkHourIds}
            />
          )}
          {canMaterial && (
            <RegieMaterialFields
              products={{
                ids: recordIds,
                setIds: setRecordIds,
                initialValues: initialRecordValues,
              }}
              specialRecords={{
                ids: specialRecordIds,
                setIds: setSpecialRecordIds,
                initialValues: initialSpecialRecordValues,
              }}
              context={context}
              createProduct={createEntityAction.product}
              onProductChange={forceUpdate}
              focusField={autoFocusFieldName}
              setFocusField={setAutoFocusFieldName}
            />
          )}
          <NotifyLoaded
            onLoad={async () => {
              const weekStart = startOfIsoWeek(new Date(report.day));

              context.setValues({
                summary: report.summary ?? "",
                week: report.day,
              });

              const loadProject = async () => {
                if (!report.projectId) return;

                const [project] = await client.query(
                  "projects.get",
                  { id: report.projectId },
                  { strategy: "cache-first" },
                );
                if (project) context.setValues({ project: [project] });
              };

              const loadProduct = async (
                record: RegieReport["products"][number],
              ) => {
                const [product] = await client.query(
                  "products.get",
                  { id: record.productId },
                  { strategy: "cache-first" },
                );
                const [amount, unit] = product
                  ? upmatchUnit(product, record.quantity)
                  : [record.quantity, null];
                initialRecordValues[record.id] = {
                  product: product ?? null,
                  amount,
                  unit,
                };
              };

              const loadWorkHour = async (
                record: RegieReport["workHours"][number],
              ) => {
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

                initialWorkHourValues[record.id] = {
                  user,
                  dayIndex,
                  hours: record.hours,
                };
              };

              const reads = [
                loadProject,
                ...report.products.map((record) => () => loadProduct(record)),
                ...report.workHours.map((record) => () => loadWorkHour(record)),
              ];
              await mapConcurrent(reads, 4, (read) => read());

              const specialRecords = report.specialRecords ?? [];
              for (const { id, name, unit, amount } of specialRecords) {
                initialSpecialRecordValues[id] = { name, unit, amount };
              }

              setRecordIds(report.products.map(({ id }) => id));
              setSpecialRecordIds(specialRecords.map(({ id }) => id));
              setWorkHourIds(report.workHours.map(({ id }) => id));
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
