import { uiText } from "~/lib/i18n";
import { Fragment, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { ProductRecordFields } from "~/components/ProductRecordFields";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client, contentAccess } from "~/lib/client";
import { deliveryCollection } from "~/lib/data/deliveryNoteData";
import { projectCollection } from "~/lib/data/projectData";
import { mapConcurrent } from "~/lib/data/runtime/concurrentReads";
import {
  scannedDeliveryRequestId,
  type DeliveryNotePrefill,
} from "~/lib/data/deliveryScanPrefill";
import { Icons } from "~/lib/icons";
import { SmallProjectTile } from "~/lib/tiles";
import { generateId, parseFloatCustom, upmatchUnit } from "~/lib/utils";
import type { DeliveryNote, Product } from "~/type-helpers";

function quantityInUnit(product: Product, baseQuantity: number, unit: string | null | undefined): [number, string | null] {
  if (!unit) return upmatchUnit(product, baseQuantity);
  if (unit === product.baseUnit) return [baseQuantity, unit];
  const factor = product.otherUnits?.[unit];
  if (!factor) return upmatchUnit(product, baseQuantity);
  return [baseQuantity / factor, unit];
}

export function showCreateDeliveryNoteModal(
  modals: MyModalsInterface,
  prefill?: DeliveryNotePrefill,
) {
  let submission: { key: string; requestId: string } | null = null;
  modals.showForm({
    content: ({ context }) => {
      const session = useSessionInfo();
      const initialRecordValues = useRef<Record<string, DeliveryNotePrefill["records"][number]>>({}).current;
      const initialSpecialRecordValues = useRef<Record<string, DeliveryNotePrefill["specialRecords"][number]>>({}).current;

      const [recordIds, setRecordIds] = useState<string[]>(() => {
        if (!prefill) return [generateId()];

        return prefill.records.map(record => {
          const id = generateId();
          initialRecordValues[id] = record;

          return id;
        });
      });
      const [specialRecordIds, setSpecialRecordIds] = useState<string[]>(() =>
        (prefill?.specialRecords ?? []).map(record => {
          const id = generateId();
          initialSpecialRecordValues[id] = record;

          return id;
        })
      );
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
      const createEntityAction = useCreateEntityAction(modals);
      const forceUpdate = useForceUpdate();
      const projectId = context.field("project")?.getValue()?.[0]?.id;
      const pricing = projectId ? deliveryCollection(projectId, true) : null;
      const canSeePrices = !!pricing &&
        session.canAccess(pricing.scope, pricing.facet, "read");
      const canWritePrices = !!pricing &&
        session.canAccess(pricing.scope, pricing.facet, "create");

      return (
        <>
          {prefill?.warnings?.map((warning, index) => (
            <MyCallout
              key={index}
              kind="warning"
              title={uiText("Bitte prüfen", "Please review")}
              subtitle={warning}
            />
          ))}

          <MyForm.MultiSelect
            onValueChange={forceUpdate}
            name="project"
            labelText={uiText("Projekt")}
            minSelectedItems={1}
            maxSelectedItems={1}
            getOptions={async ({ query }) => {
              const [data, error] = await client.query("projects.list", {
                search: query,
              });
              if (error) throw error;

              const access = await contentAccess.read();
              return (data ?? []).filter(({ id }) => {
                const area = deliveryCollection(id);
                return access?.can(area.scope, area.facet, "create");
              });
            }}
            renderItem={({ item }) => item.title}
            renderTile={(item) => <SmallProjectTile data={item} noLink />}
            createAction={createEntityAction.project}
          />
          <p className="light">
            {uiText(
              "Wähle das Projekt, zu dem der Lieferschein erfasst werden soll.",
            )}
          </p>

          <MyForm.DateInput
            required
            name="deliveryDate"
            labelText={uiText("Lieferdatum", "Delivery date")}
          />

          <MyForm.Input name="comment" labelText={uiText("Kommentar")} />
          <p className="light">
            {uiText(
              "Hinweise wie Lieferant, Baustellenbereich oder Besonderheiten.",
            )}
          </p>

          <MyDivider />

          <h4 className="text-lg leading-snug font-semibold">
            {uiText("Produkte")}
          </h4>
          <p className="light">
            {uiText("Erfasse gelieferte Produkte mit Menge und Einheit.")}
          </p>

          {recordIds.map((id) => {
            const prefix = `record:${id}:`;

            return (
              <Fragment key={id}>
                <ProductRecordFields
                  prefix={prefix}
                  focusProduct={autoFocusFieldName === `${prefix}product`}
                  createProduct={createEntityAction.product}
                  onProductChange={forceUpdate}
                  onRemove={() =>
                    setRecordIds((ids) => ids.filter((current) => current !== id))
                  }
                />

                <MyForm.Input
                  name={prefix + "comment"}
                  labelText={uiText("Positionskommentar", "Line comment")}
                />

                <NotifyLoaded
                  onLoad={() => {
                    const initial = initialRecordValues[id];
                    if (!initial) return;

                    context.setValues({
                      [prefix + "product"]: [initial.product],
                      [prefix + "amount"]: initial.amount,
                      [prefix + "comment"]: initial.comment ?? "",
                    });
                    window.setTimeout(() => {
                      context.setValues({ [prefix + "unit"]: initial.unit });
                    }, 0);
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
              setAutoFocusFieldName("record:" + id + ":product");
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
              "Sonderposten sind zusätzliche Leistungen oder Materialien, die nicht als Produktstamm vorhanden sind.",
            )}
          </p>

          {specialRecordIds.map((id) => {
            const prefix = "specialRecord:" + id + ":";

            return (
              <Fragment key={id}>
                <DeliverySpecialRecordFields
                  prefix={prefix}
                  canSeePrices={canSeePrices}
                  canWritePrices={canWritePrices}
                  focusOnMount={autoFocusFieldName === prefix + "name"}
                  includeComment
                  onRemove={() =>
                    setSpecialRecordIds((ids) =>
                      ids.filter((current) => current !== id),
                    )
                  }
                />

                <NotifyLoaded
                  onLoad={() => {
                    const initial = initialSpecialRecordValues[id];
                    if (!initial) return;

                    context.setValues({
                      [prefix + "name"]: initial.name,
                      [prefix + "unit"]: initial.unit,
                      [prefix + "amount"]: initial.amount,
                      [prefix + "pricePerUnit"]: initial.pricePerUnit ?? "",
                      [prefix + "comment"]: initial.comment ?? "",
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
              setAutoFocusFieldName("specialRecord:" + id + ":name");
            }}
          >
            {uiText("Sonderposten")}
          </MyButton>

          <NotifyLoaded
            onLoad={() => {
              context.setValues({
                comment: prefill?.comment ?? "",
                deliveryDate: prefill?.deliveryDate ?? new Date(),
              });

              if (prefill?.project) {
                context.setValues({ project: [prefill.project] });
              }
            }}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();
      const projectId = values.project?.[0]?.id;
      if (!projectId) return;

      const records: {
        productId: string;
        quantity: number;
        unit: string;
        comment: string | null;
      }[] = [];
      const specialRecords: {
        name: string;
        unit: string;
        amount: number;
        pricePerUnit: number | null;
        comment: string | null;
      }[] = [];

      const recordIds = new Set<string>();
      const specialRecordIds = new Set<string>();

      Object.keys(values).forEach(key => {
        if (!key.startsWith("record:")) return;

        const [, id] = key.split(":");
        recordIds.add(id);
      });
      Object.keys(values).forEach(key => {
        if (!key.startsWith("specialRecord:")) return;

        const [, id] = key.split(":");
        specialRecordIds.add(id);
      });

      recordIds.forEach(id => {
        const prefix = "record:" + id + ":";
        const product = values[prefix + "product"]?.at(0);
        if (!product?.id) throw new Error();

        const units = [product.baseUnit, ...Object.keys(product.otherUnits)] as string[];
        const quantity = parseFloatCustom(values[prefix + "amount"]);
        if (!quantity || isNaN(quantity)) throw new Error();

        const unit = values[prefix + "unit"];
        if (!units.includes(unit)) throw new Error();

        const factor = unit === product.baseUnit ? 1 : product.otherUnits[unit];
        const comment = String(values[prefix + "comment"] ?? "").trim() || null;

        records.push({
          productId: product.id,
          quantity: quantity * factor,
          unit,
          comment,
        });
      });

      specialRecordIds.forEach(id => {
        const prefix = "specialRecord:" + id + ":";
        const name = values[prefix + "name"];
        const unit = values[prefix + "unit"];
        const amount = parseFloatCustom(values[prefix + "amount"]);
        if (!name || !unit || !amount || isNaN(amount)) throw new Error();

        const rawPricePerUnit = values[prefix + "pricePerUnit"];
        let pricePerUnit: number | null = null;

        if (String(rawPricePerUnit ?? "").trim()) {
          pricePerUnit = parseFloatCustom(rawPricePerUnit);
          if (isNaN(pricePerUnit)) throw new Error();
        }

        specialRecords.push({
          name,
          unit,
          amount,
          pricePerUnit,
          comment: String(values[prefix + "comment"] ?? "").trim() || null,
        });
      });

      const access = await contentAccess.read();
      const pricing = deliveryCollection(projectId, true);
      const mayWritePrices = access?.can(pricing.scope, pricing.facet, "create") === true;
      const input = {
        projectId,
        effectiveTimestamp: values.deliveryDate ?? null,
        records,
        specialRecords: specialRecords.map((row) => ({
          ...row,
          pricePerUnit: mayWritePrices ? row.pricePerUnit : null,
        })),
        comment: String(values.comment ?? "").trim() || null,
      };
      const key = JSON.stringify(input);
      if (!submission || submission.key !== key) {
        const requestId = prefill?.scanId
          ? await scannedDeliveryRequestId(prefill.scanId, input)
          : crypto.randomUUID();
        submission = { key, requestId };
      }
      const [data, error] = await client.mutate("deliveryNotes.create", {
        ...input,
        requestId: submission.requestId,
      });

      if (error) throw error;
      if (!data) return;

      navigate("/products/deliveryNotes/" + data.id);
      hide();
    },
    modalProps: () => ({
      useFullscreen: true,
      modalHeading: uiText("Lieferschein schreiben"),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showModifyDeliveryNoteModal(modals: MyModalsInterface, note: DeliveryNote) {
  const pricing = deliveryCollection(note.projectId, true);
  const source = projectCollection(note.projectId);
  modals.showForm({
    content: ({ context }) => {
      const session = useSessionInfo();
      const canSeePrices = session.canAccess(pricing.scope, pricing.facet, "read");
      const canWritePrices = session.canAccess(pricing.scope, pricing.facet, "update");
      const canMove = !!note.revision && canSeePrices &&
        session.canAccess(source.scope, source.facet, "read");
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

      return (
        <>
          {canMove && <MyForm.MultiSelect
            name="project"
            labelText={uiText("Projekt")}
            minSelectedItems={1}
            maxSelectedItems={1}
            getOptions={async ({ query }) => {
              const [data, err] = await client.query("projects.list", {
                search: query,
              });
              if (err) throw err;
              return (data ?? []).filter(({ id }) => {
                if (id === note.projectId) return true;
                return [deliveryCollection(id), deliveryCollection(id, true)].every(
                  ({ scope, facet }) => session.canAccess(scope, facet, "read") &&
                    session.canAccess(scope, facet, "create"),
                );
              });
            }}
            renderItem={({ item }) => item.title}
            renderTile={(item) => <SmallProjectTile data={item} noLink />}
            createAction={createEntityAction.project}
          />}

          <MyForm.Input name="comment" labelText={uiText("Kommentar")} />
          <p className="light">
            {uiText(
              "Hinweise wie Lieferant, Baustellenbereich oder Besonderheiten.",
            )}
          </p>

          <MyDivider />

          <h4 className="text-lg leading-snug font-semibold">
            {uiText("Produkte")}
          </h4>
          <p className="light">
            {uiText("Erfasse gelieferte Produkte mit Menge und Einheit.")}
          </p>

          {recordIds.map((id) => {
            const prefix = `record:${id}:`;

            return (
              <Fragment key={id}>
                <ProductRecordFields
                  prefix={prefix}
                  focusProduct={autoFocusFieldName === `${prefix}product`}
                  createProduct={createEntityAction.product}
                  onProductChange={forceUpdate}
                  onRemove={() =>
                    setRecordIds((ids) => ids.filter((current) => current !== id))
                  }
                />

                <NotifyLoaded
                  onLoad={() => {
                    const initial = initialRecordValues[id];
                    if (!initial) return;

                    const values: Record<string, any> = {
                      [`record:${id}:amount`]: initial.amount,
                    };

                    if (initial.product)
                      values[`record:${id}:product`] = [initial.product];

                    context.setValues(values);
                    if (initial.unit) {
                      window.setTimeout(
                        () =>
                          context.setValues({
                            [`record:${id}:unit`]: initial.unit,
                          }),
                        0,
                      );
                    }
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
              "Sonderposten sind zusätzliche Leistungen oder Materialien, die nicht als Produktstamm vorhanden sind.",
            )}
          </p>

          {specialRecordIds.map((id) => {
            const prefix = `specialRecord:${id}:`;

            return (
              <Fragment key={id}>
                <DeliverySpecialRecordFields
                  prefix={prefix}
                  canSeePrices={canSeePrices}
                  canWritePrices={canWritePrices}
                  focusOnMount={autoFocusFieldName === prefix + "name"}
                  onRemove={() =>
                    setSpecialRecordIds((ids) =>
                      ids.filter((current) => current !== id),
                    )
                  }
                />

                <NotifyLoaded
                  onLoad={() => {
                    const initial = initialSpecialRecordValues[id];
                    if (!initial) return;

                    context.setValues({
                      [prefix + "name"]: initial.name,
                      [prefix + "unit"]: initial.unit,
                      [prefix + "amount"]: initial.amount,
                      [prefix + "pricePerUnit"]: initial.pricePerUnit ?? "",
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

          <NotifyLoaded
            onLoad={async () => {
              context.setValues({ comment: note.comment ?? "" });

              async function prefillProject() {
                if (!canMove) return;

                const [project] = await client.query(
                  "projects.get",
                  { id: note.projectId },
                  { strategy: "cache-first" },
                );
                if (project) context.setValues({ project: [project] });
              }

              const productIds = new Set(note.records.map((record) => record.productId));
              const [products] = await Promise.all([
                mapConcurrent([...productIds], 4, async (id) => {
                  const [product] = await client.query(
                    "products.get",
                    { id },
                    { strategy: "cache-first" },
                  );
                  return [id, product] as const;
                }),
                prefillProject(),
              ]);

              const productsById = new Map(products);
              const recordIdList = note.records.map((record) => {
                const id = record.id ?? generateId();
                const product = productsById.get(record.productId) ?? null;
                const [amount, unit] = product
                  ? quantityInUnit(product, record.quantity, record.unit)
                  : [record.quantity, null];
                initialRecordValues[id] = { product, amount, unit };
                return id;
              });

              const specialRecordIdList: string[] = [];
              note.specialRecords?.forEach((record) => {
                const id = record.id;
                specialRecordIdList.push(id);
                initialSpecialRecordValues[id] = {
                  name: record.name,
                  unit: record.unit,
                  amount: record.amount,
                  pricePerUnit: record.pricePerUnit ?? null,
                };
              });

              setRecordIds(recordIdList);
              setSpecialRecordIds(specialRecordIdList);
            }}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      const projectId = values.project?.[0]?.id ?? note.projectId;

      const records: {
        id?: string;
        productId: string;
        quantity: number;
        unit: string;
        comment?: string | null;
      }[] = [];

      const specialRecords: {
        id?: string;
        name: string;
        unit: string;
        amount: number;
        pricePerUnit?: number | null;
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

        records.push({ ...(note.records.some(record => record.id === id) ? { id } : {}), productId: product.id, quantity: inBaseUnits, unit });
      });

      const access = await contentAccess.read();
      const mayWritePrices = access?.can(pricing.scope, pricing.facet, "update") === true;
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
          ...(note.specialRecords.some(record => record.id === id) ? { id } : {}),
          name,
          unit,
          amount,
          ...(mayWritePrices ? { pricePerUnit } : {}),
        });
      });

      const [data, err] = await client.mutate('deliveryNotes.update', {
        id: note.id,
        expectedRevision: note.revision,
        expectedPriceRevision: note.priceRevision,
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
      useFullscreen: true,
      modalHeading: uiText("Lieferschein bearbeiten"),
      modalLabel: `#${note.autoId}`,
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteDeliveryNoteModal(modals: MyModalsInterface, note: DeliveryNote) {
  modals.showForm({
    content: () => (
      <>
        <p className="light">
          {uiText(
            "Alle mit diesem Lieferschein in Verbindung stehenden Daten werden damit ebenfalls gelöscht.",
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
      const [data, err] = await client.mutate('deliveryNotes.delete', {
        id: note.id,
        expectedRevision: note.revision,
      });
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

function DeliverySpecialRecordFields({
  prefix,
  canSeePrices,
  canWritePrices,
  focusOnMount,
  includeComment = false,
  onRemove,
}: {
  prefix: string;
  canSeePrices: boolean;
  canWritePrices: boolean;
  focusOnMount: boolean;
  includeComment?: boolean;
  onRemove: () => void;
}) {
  const removeLabel = uiText("Sonderposten entfernen");

  return (
    <div className="flex flex-col gap-2">
      <MyForm.Input
        required
        name={prefix + "name"}
        labelText={uiText("Bezeichnung")}
        focusOnMount={focusOnMount}
        suffix={
          <MyButton
            kind="ghost"
            size="sm"
            className="ss-input-suffix-btn"
            title={removeLabel}
            aria-label={removeLabel}
            onClick={onRemove}
          >
            <Icons.Delete />
          </MyButton>
        }
      />

      <div className="flex gap-2">
        <div className="min-w-0 basis-1/3 flex-1">
          <MyForm.Input
            required
            name={prefix + "amount"}
            labelText={uiText("Menge")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />
        </div>
        <div className="min-w-0 basis-1/3 flex-1">
          <MyForm.Input
            required
            name={prefix + "unit"}
            labelText={uiText("Einheit")}
          />
        </div>
        <div className={canSeePrices ? "min-w-0 basis-1/3 flex-1" : "hidden"}>
          <MyForm.Input
            name={prefix + "pricePerUnit"}
            labelText={uiText("Preis pro Einheit")}
            disabled={!canWritePrices}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />
        </div>
      </div>

      {includeComment && (
        <MyForm.Input
          name={prefix + "comment"}
          labelText={uiText("Positionskommentar", "Line comment")}
        />
      )}
    </div>
  );
}
