import AddAlt from "@carbon/icons-react/es/AddAlt";
import TextHeading from "@carbon/icons-react/es/Paragraph";
import Copy from "@carbon/icons-react/es/Copy";
import TrashCan from "@carbon/icons-react/es/TrashCan";
import { EditorIconButton } from "./EditorIconButton";
import type { GaebDocument, GaebEntry } from "../core/document";
import {
  defaultMeasureShape,
  measureShapesForUnit,
  newMeasurement,
  type Measurement,
  type MeasureMode,
  type MeasureShape,
} from "../core/takeoff";
import {
  measurementKey,
  measureModeName,
  measureShapeName,
} from "../core/takeoffLabels";
import { text, type GaebLocale } from "../messages";

export function TakeoffTools(props: {
  document: GaebDocument;
  entry?: GaebEntry;
  reference?: GaebDocument;
  activeId?: string;
  editable: boolean;
  locale: GaebLocale;
  run: (action: () => void) => boolean;
  change: (operation: (doc: GaebDocument) => string) => void;
  focus: (entryKey: string, id: string, key: string) => void;
}) {
  const { document: model, entry, locale, editable, activeId } = props;
  const t = (de: string, en: string) => text(locale, de, en);
  const state = entry?.kind === "item" ? model.takeoff(entry) : undefined;
  const heading = state?.headings.find(
    (row) => row.value.id === activeId,
  )?.value;
  const current = heading
    ? undefined
    : (state?.rows.find((row) => row.value.id === activeId)?.value ??
      state?.rows[0]?.value);
  const enabled = editable && !!entry && !state?.mismatch;
  const getEntry = (doc: GaebDocument) =>
    doc.entries.find((candidate) => candidate.key === entry!.key)!;
  const patch = (value: Partial<Omit<Measurement, "id">>) => {
    if (!current || !entry) return;
    props.run(() =>
      props.change((doc) =>
        doc.setMeasurement(getEntry(doc), current.id, value),
      ),
    );
  };
  const contextual =
    props.reference?.items.find(
      (item) =>
        item.element.getAttribute("ID") === entry?.element.getAttribute("ID"),
    ) ?? props.reference?.items.find((item) => item.oz === entry?.oz);
  const unit =
    model.value(entry?.element, "QU") ||
    (contextual && props.reference?.value(contextual.element, "QU")) ||
    "";
  const add = (duplicate = false) => {
    if (!entry) return;
    const id = crypto.randomUUID();
    const done = props.run(() =>
      props.change((doc) => {
        const target = getEntry(doc);
        const previous = doc
          .takeoff(target)
          .rows.find((row) => row.value.id === current?.id)?.value;
        const row =
          duplicate && previous
            ? { ...previous, id }
            : {
                ...newMeasurement(
                  previous?.shape ?? defaultMeasureShape(unit),
                  id,
                ),
                location: previous?.location ?? "",
              };
        return doc.addMeasurement(target, row, heading?.id ?? previous?.id);
      }),
    );
    if (done)
      props.focus(
        entry.key,
        id,
        measurementKey(
          entry.key,
          id,
          duplicate || current?.location ? "label" : "location",
        ),
      );
  };
  return (
    <div
      className="gaeb-takeoff-tools"
      role="group"
      aria-label={t("Maßansätze", "Measurements")}
    >
      <EditorIconButton
        showLabel
        icon={AddAlt}
        label={t("Maßansatz hinzufügen", "Add measurement")}
        disabled={!enabled}
        onClick={() => add()}
      />
      <EditorIconButton
        showLabel
        icon={TextHeading}
        label={t("Zwischenüberschrift hinzufügen", "Add measurement heading")}
        disabled={!enabled}
        onClick={() => {
          if (!entry) return;
          const id = crypto.randomUUID();
          if (
            props.run(() =>
              props.change((doc) =>
                doc.addTakeoffHeading(
                  getEntry(doc),
                  { id, title: t("Neuer Bereich", "New section") },
                  heading?.id ?? current?.id,
                ),
              ),
            )
          )
            props.focus(entry.key, id, `${entry.key}:heading:${id}`);
        }}
      />
      <EditorIconButton
        showLabel
        icon={Copy}
        label={t("Maßansatz duplizieren", "Duplicate measurement")}
        disabled={!enabled || !current}
        onClick={() => add(true)}
      />
      <div className="gaeb-takeoff-options">
        <label>
          {t("Maßansatz", "Measurement")}
          <select
            aria-label={t("Maßansatz auswählen", "Select measurement")}
            disabled={!state?.rows.length}
            value={current?.id ?? ""}
            onChange={(event) => {
              if (entry)
                props.focus(
                  entry.key,
                  event.target.value,
                  measurementKey(entry.key, event.target.value, "label"),
                );
            }}
          >
            {!current && (
              <option value="">
                {t("Noch kein Maßansatz", "No measurements yet")}
              </option>
            )}
            {state?.rows.map(({ value }, index) => (
              <option value={value.id} key={value.id}>
                {index + 1}.{" "}
                {value.label || measureShapeName(value.shape, locale)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Berechnung", "Calculation")}
          <select
            aria-label={t("Berechnungsart", "Calculation type")}
            aria-keyshortcuts="Control+q Control+w"
            disabled={!enabled || !current}
            value={current?.shape ?? defaultMeasureShape("")}
            onChange={(event) => {
              const shape = event.target.value as MeasureShape;
              patch({
                shape,
                ...(current?.mode === "opening" &&
                !["area", "triangle", "trapezoid", "factor"].includes(shape)
                  ? { mode: "deduct" }
                  : {}),
              });
            }}
          >
            {measureShapesForUnit(unit, current?.shape).map((shape) => (
              <option value={shape} key={shape}>
                {measureShapeName(shape, locale)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="gaeb-takeoff-options">
        <label>
          {t("Vorzeichen", "Sign")}
          <select
            aria-label={t("Zugang oder Abzug", "Addition or deduction")}
            disabled={!enabled || !current}
            value={current?.mode ?? "add"}
            onChange={(event) =>
              patch({ mode: event.target.value as MeasureMode })
            }
          >
            {(["add", "deduct", "opening"] as const).map((mode) => (
              <option
                key={mode}
                value={mode}
                disabled={
                  mode === "opening" &&
                  !["area", "triangle", "trapezoid", "factor"].includes(
                    current?.shape ?? "",
                  )
                }
              >
                {measureModeName(mode, locale)}
              </option>
            ))}
          </select>
        </label>
        {current?.mode === "opening" ? (
          <label>
            {t("Übermessen", "Do not deduct")}
            <select
              aria-label={t("Übermessungsregel", "Opening deduction rule")}
              disabled={!enabled}
              value={current.threshold}
              onChange={(event) => patch({ threshold: event.target.value })}
            >
              <option value="">
                {t("Alle Öffnungen abziehen", "Deduct every opening")}
              </option>
              <option value="2.5">
                {t("Bis 2,50 m² je Öffnung", "Up to 2.50 m² per opening")}
              </option>
              <option value="0.5">
                {t("Bis 0,50 m² je Öffnung", "Up to 0.50 m² per opening")}
              </option>
              {current.threshold &&
                !["2.5", "0.5"].includes(current.threshold) && (
                  <option value={current.threshold}>
                    ≤ {current.threshold} m²
                  </option>
                )}
            </select>
          </label>
        ) : null}
      </div>
      <EditorIconButton
        showLabel
        icon={TrashCan}
        label={
          heading
            ? t("Zwischenüberschrift löschen", "Delete measurement heading")
            : t("Maßansatz löschen", "Delete measurement")
        }
        disabled={!enabled || (!current && !heading)}
        onClick={() => {
          if (!entry) return;
          if (heading) {
            props.run(() =>
              props.change((doc) =>
                doc.removeTakeoffHeading(getEntry(doc), heading.id),
              ),
            );
            return;
          }
          if (!current) return;
          const next = state?.rows.find(
            (row) => row.value.id !== current.id,
          )?.value;
          if (
            props.run(() =>
              props.change((doc) =>
                doc.removeMeasurement(getEntry(doc), current.id),
              ),
            ) &&
            next
          )
            props.focus(
              entry.key,
              next.id,
              measurementKey(entry.key, next.id, "label"),
            );
        }}
      />
    </div>
  );
}
