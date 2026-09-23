import type { MutateResult, QueryResult } from "@sortsys/v2-client";
import { Checkbox, ComboBox, TextArea, TextInput } from "@sortsys/react-components";
import { Icons } from "~/lib/icons";
import { type ChangeEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { currentLocaleTag, uiText } from "~/lib/i18n";

type DocumentScanResult = MutateResult<"deliveryNotes.scan.complete">;
type PriceListResult = NonNullable<DocumentScanResult["priceList"]>;
type Product = QueryResult<"products.list">[number];
type Vendor = QueryResult<"products.vendors.list">[number];

type EditablePriceRow = PriceListResult["rows"][number] & {
  included: boolean;
  conversionsText: string;
  conversionWarning: string | null;
};

type PriceImportState = {
  vendorId: string;
  vendorName: string;
  effectiveDate: string;
  isRealPurchase: boolean;
  rows: EditablePriceRow[];
};

type PriceImportController = {
  current: PriceImportState | null;
};

type AutocompleteOption<T> = {
  id: string;
  label: string;
  detail?: string;
  value: T;
};

const pageSize = 25;

function formatPrice(value: number) {
  if (!Number.isFinite(value)) return "—";

  return new Intl.NumberFormat(currentLocaleTag(), {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function warningWithoutSource(warning: string, sourceText: string) {
  return warning.replace(`„${sourceText}“`, "").replace(`“${sourceText}”`, "").trim();
}

async function loadVendorOptions(query: string): Promise<AutocompleteOption<Vendor>[]> {
  const [vendors, error] = await client.query(
    "products.vendors.list",
    { search: query },
    { strategy: "network-first" },
  );
  if (error) throw error;

  return (vendors ?? []).map(vendor => ({
    id: vendor.id,
    label: vendor.name,
    value: vendor,
  }));
}

async function loadProductOptions(query: string): Promise<AutocompleteOption<Product>[]> {
  const [products, error] = await client.query(
    "products.list",
    { search: query, category: null },
    { strategy: "network-first" },
  );
  if (error) throw error;

  return (products ?? []).map(product => ({
    id: product.id,
    label: `${product.customId} · ${product.name}`,
    detail: product.baseUnit,
    value: product,
  }));
}

function AutocompleteSelect<T>({
  label,
  className,
  helperText,
  placeholder,
  selectedId,
  selectedLabel,
  initialQuery = "",
  autoSelectExact = false,
  disabled = false,
  loadOptions,
  onSelect,
}: {
  label?: string;
  className?: string;
  helperText?: string;
  placeholder: string;
  selectedId: string | null;
  selectedLabel: string;
  initialQuery?: string;
  autoSelectExact?: boolean;
  disabled?: boolean;
  loadOptions: (query: string) => Promise<AutocompleteOption<T>[]>;
  onSelect: (value: T | null) => void;
}) {
  const [query, setQuery] = useState(selectedLabel || initialQuery);
  const inputId = useId();
  const [options, setOptions] = useState<AutocompleteOption<T>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loadOptionsRef = useRef(loadOptions);
  const onSelectRef = useRef(onSelect);

  loadOptionsRef.current = loadOptions;
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (selectedId && selectedLabel) setQuery(selectedLabel);
  }, [selectedId, selectedLabel]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized || (selectedId && normalized === selectedLabel)) {
      setOptions([]);
      return;
    }

    let active = true;
    const timeout = window.setTimeout(() => {
      void loadOptionsRef.current(normalized)
        .then(next => {
          if (!active) return;

          setOptions(next.slice(0, 20));
          setError(null);

          if (autoSelectExact && !selectedId) {
            const exact = next.find(option =>
              option.label.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase(),
            );
            if (exact) onSelectRef.current(exact.value);
          }
        })
        .catch(cause => {
          if (!active) return;
          setOptions([]);
          setError(cause instanceof Error ? cause.message : uiText("Suche fehlgeschlagen", "Search failed"));
        });
    }, 200);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [autoSelectExact, query, selectedId, selectedLabel]);

  return <ComboBox
    id={inputId}
    className={className}
    titleText={label}
    helperText={helperText}
    placeholder={placeholder}
    value={query}
    items={options}
    disabled={disabled}
    invalid={!!error}
    invalidText={error}
    itemToString={(option: AutocompleteOption<T>) => option.label}
    itemToElement={(option: AutocompleteOption<T>) => <>
      <span>{option.label}</span>
      {!!option.detail && <small>{option.detail}</small>}
    </>}
    onInputChange={(next: string) => {
      setQuery(next);

      const exact = options.find(option => option.label === next);
      if (exact) {
        onSelectRef.current(exact.value);
      } else if (selectedId && next !== selectedLabel) {
        onSelectRef.current(null);
      }
    }}
  />;
}

function defaultEffectiveDate(value: string | null) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function unitFactor(unit: string, baseUnit: string, otherUnits?: Record<string, number>) {
  const normalized = unit.trim().toLocaleLowerCase();
  if (normalized === baseUnit.trim().toLocaleLowerCase()) return 1;

  return Object.entries(otherUnits ?? {}).find(([otherUnit]) =>
    otherUnit.trim().toLocaleLowerCase() === normalized)?.[1] ?? null;
}

function formatConversions(units?: Record<string, number>) {
  return Object.entries(units ?? {})
    .map(([unit, factor]) => `${unit} = ${factor}`)
    .join("\n");
}

function parseConversions(text: string, baseUnit: string) {
  const units: Record<string, number> = {};

  for (const line of text.split(/[\n;]/)) {
    if (!line.trim()) continue;

    const match = line.trim().match(/^(.+?)\s*=\s*(\d+(?:[.,]\d+)?)$/);
    if (!match) return null;

    const unit = match[1]!.trim();
    const factor = Number(match[2]!.replace(",", "."));
    if (!unit || unit.length > 32 || unit.toLocaleLowerCase() === baseUnit.toLocaleLowerCase()
      || !Number.isFinite(factor) || factor <= 0
      || Object.keys(units).some(existing => existing.toLocaleLowerCase() === unit.toLocaleLowerCase())) {
      return null;
    }

    units[unit] = factor;
  }

  return units;
}

function PriceImportEditor({
  result,
  documentType,
  controller,
}: {
  result: PriceListResult;
  documentType: DocumentScanResult["documentType"];
  controller: PriceImportController;
}) {
  const formId = useId();
  const [page, setPage] = useState(0);
  const [expandedRow, setExpandedRow] = useState<number | null>(0);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [state, setState] = useState<PriceImportState>(() => ({
    vendorId: "",
    vendorName: "",
    effectiveDate: defaultEffectiveDate(result.effectiveDate),
    isRealPurchase: documentType === "invoice",
    rows: result.rows.map(row => ({
      ...row,
      included: true,
      conversionsText: formatConversions(row.otherUnits),
      conversionWarning: null,
    })),
  }));

  controller.current = state;

  const selectedCount = state.rows.filter(row => row.included).length;
  const newProductCount = state.rows.filter(row => row.included && !row.productId).length;
  const pageCount = Math.max(1, Math.ceil(state.rows.length / pageSize));
  const visibleRows = useMemo(
    () => state.rows.slice(page * pageSize, (page + 1) * pageSize),
    [page, state.rows],
  );
  const warningsByRow = useMemo(
    () => result.rows.map(row => row.sourceText
      ? result.warnings.filter(warning => warning.includes(row.sourceText))
      : []),
    [result],
  );
  const generalWarnings = useMemo(() => {
    const assigned = new Set(warningsByRow.flat());
    return result.warnings.filter(warning => !assigned.has(warning));
  }, [result.warnings, warningsByRow]);

  function updateRow(indexOnPage: number, changes: Partial<EditablePriceRow>) {
    const index = page * pageSize + indexOnPage;
    setState(current => ({
      ...current,
      rows: current.rows.map((row, rowIndex) => rowIndex === index
        ? { ...row, ...changes }
        : row),
    }));
  }

  function selectProduct(indexOnPage: number, product: Product | null) {
    const index = page * pageSize + indexOnPage;
    const row = state.rows[index];
    if (!row) return;

    if (!product) {
      const original = result.rows[index];
      if (original) {
        updateRow(indexOnPage, {
          ...original,
          conversionsText: formatConversions(original.otherUnits),
          conversionWarning: null,
        });
      }
      return;
    }

    const oldFactor = unitFactor(row.sourceUnit, row.baseUnit, row.otherUnits);
    const newFactor = unitFactor(row.sourceUnit, product.baseUnit, product.otherUnits);
    const convertedPrice = oldFactor && newFactor
      ? row.pricePerBaseUnit * oldFactor / newFactor
      : row.pricePerBaseUnit;

    updateRow(indexOnPage, {
      productId: product.id,
      customId: product.customId,
      productName: product.name,
      baseUnit: product.baseUnit,
      brand: product.brand,
      description: product.description,
      otherUnits: product.otherUnits,
      conversionsText: formatConversions(product.otherUnits),
      pricePerBaseUnit: convertedPrice,
      conversionWarning: oldFactor && newFactor ? null : uiText(
        `Keine Umrechnung von ${row.sourceUnit} nach ${product.baseUnit} vorhanden. Nettopreis prüfen.`,
        `No conversion from ${row.sourceUnit} to ${product.baseUnit}. Check the net price.`,
      ),
    });
  }

  return <div className="price-import-editor">
    <div className="price-import-fields">
      <AutocompleteSelect
        label={uiText("Händler", "Vendor")}
        helperText={!state.vendorId ? uiText(
          "Händler aus der Trefferliste auswählen.",
          "Select a vendor from the results.",
        ) : undefined}
        placeholder={uiText("Händler suchen", "Search vendors")}
        selectedId={state.vendorId || null}
        selectedLabel={state.vendorName}
        initialQuery={result.supplier ?? ""}
        autoSelectExact
        loadOptions={loadVendorOptions}
        onSelect={vendor => setState(current => ({
          ...current,
          vendorId: vendor?.id ?? "",
          vendorName: vendor?.name ?? "",
        }))}
      />

      <TextInput
        id={`${formId}-effective-date`}
        labelText={uiText("Preisstand", "Effective date")}
        required
        type="date"
        value={state.effectiveDate}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const effectiveDate = event.currentTarget.value;
          setState(current => ({ ...current, effectiveDate }));
        }}
      />
    </div>

    <Checkbox
      id={`${formId}-real-purchase`}
      className="price-import-checkbox"
      labelText={uiText("Tatsächlicher Einkauf", "Actual purchase")}
      checked={state.isRealPurchase}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const checked = event.currentTarget.checked;
        setState(current => ({ ...current, isRealPurchase: checked }));
      }}
    />

    <div className="price-import-summary">
      <div>
        <strong>{uiText(
          `${selectedCount} von ${state.rows.length} Preisen ausgewählt`,
          `${selectedCount} of ${state.rows.length} prices selected`,
        )}</strong>
        <span>{uiText(
          `${newProductCount} neue Produkte`,
          `${newProductCount} new products`,
        )}</span>
      </div>
      <Checkbox
        id={`${formId}-select-page`}
        className="price-import-select-page"
        labelText={uiText("Alle auf dieser Seite", "All on this page")}
        checked={visibleRows.every(row => row.included)}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const included = event.currentTarget.checked;
          setState(current => ({
            ...current,
            rows: current.rows.map((row, index) =>
              index >= page * pageSize && index < (page + 1) * pageSize
                ? { ...row, included }
                : row),
          }));
        }}
      />
    </div>

    {!!generalWarnings.length && <details
      className="price-import-notices"
      onToggle={event => setWarningsOpen(event.currentTarget.open)}
    >
      <summary>{uiText(
        `${generalWarnings.length} Hinweise zum Scan`,
        `${generalWarnings.length} scan notes`,
      )}</summary>
      {warningsOpen && <ul>{generalWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </details>}

    <div className="price-import-list">
      {visibleRows.map((row, index) => {
        const absoluteIndex = page * pageSize + index;
        const expanded = expandedRow === absoluteIndex;
        const rowWarnings = warningsByRow[absoluteIndex] ?? [];

        return <article
          className="price-import-row"
          data-included={row.included}
          data-needs-review={rowWarnings.length > 0}
          key={absoluteIndex}
        >
          <div className="price-import-row-head">
            <Checkbox
              id={`${formId}-row-${absoluteIndex}-included`}
              className="price-import-row-checkbox"
              checked={row.included}
              aria-label={uiText(
                `Preis ${absoluteIndex + 1} übernehmen`,
                `Include price ${absoluteIndex + 1}`,
              )}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                updateRow(index, { included: event.currentTarget.checked })}
            />
            <button
              type="button"
              className="price-import-row-toggle"
              aria-expanded={expanded}
              aria-label={uiText(
                `Details für ${row.productName} ${expanded ? "schließen" : "öffnen"}`,
                `${expanded ? "Close" : "Open"} details for ${row.productName}`,
              )}
              onClick={() => setExpandedRow(current => current === absoluteIndex ? null : absoluteIndex)}
            >
              <span className="price-import-row-identification">
                <strong>{row.productName || row.sourceText}</strong>
                <small>
                  {row.productId
                    ? uiText("Vorhandenes Produkt", "Existing product")
                    : uiText("Neues Produkt", "New product")}
                  {row.brand ? ` · ${row.brand}` : ""}
                  {rowWarnings.length > 0 ? ` · ${uiText("Prüfen", "Review")}` : ""}
                </small>
              </span>
              <span className="price-import-row-price">
                <strong>{formatPrice(row.pricePerBaseUnit)}</strong>
                <small>/ {row.baseUnit}</small>
              </span>
              {expanded ? <Icons.AccordionExpanded /> : <Icons.AccordionClosed />}
            </button>
          </div>

          {expanded && <div className="price-import-row-body">
            <div className="price-import-source">
              <span>{uiText("Originalzeile", "Source line")}</span>
              <p>{row.sourceText}</p>
            </div>

            {rowWarnings.length > 0 && <ul className="price-import-row-notices">
              {rowWarnings.map((warning, warningIndex) =>
                <li key={warningIndex}>{warningWithoutSource(warning, row.sourceText)}</li>)}
            </ul>}

            <div className="price-import-row-fields">
              <AutocompleteSelect
                className="price-import-field--wide"
                label={uiText("Produktzuordnung", "Product match")}
                helperText={!row.productId ? uiText(
                  "Ohne Zuordnung wird ein neues Produkt angelegt.",
                  "Without a match, a new product will be created.",
                ) : undefined}
                placeholder={uiText("Vorhandenes Produkt suchen", "Search existing products")}
                selectedId={row.productId}
                selectedLabel={row.productId
                  ? `${row.customId} · ${row.productName}`
                  : ""}
                initialQuery={row.productId ? "" : row.productName}
                disabled={!row.included}
                loadOptions={loadProductOptions}
                onSelect={product => selectProduct(index, product)}
              />

              {!row.productId && <>
                <TextInput
                  id={`${formId}-row-${absoluteIndex}-name`}
                  labelText={uiText("Bezeichnung", "Name")}
                  value={row.productName}
                  disabled={!row.included}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    updateRow(index, { productName: event.currentTarget.value })}
                />
                <TextInput
                  id={`${formId}-row-${absoluteIndex}-brand`}
                  labelText={uiText("Hersteller", "Manufacturer")}
                  value={row.brand ?? ""}
                  disabled={!row.included}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    updateRow(index, { brand: event.currentTarget.value || null })}
                />
                <TextInput
                  id={`${formId}-row-${absoluteIndex}-description`}
                  className="price-import-field--wide"
                  labelText={uiText("Beschreibung", "Description")}
                  value={row.description ?? ""}
                  disabled={!row.included}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    updateRow(index, { description: event.currentTarget.value || null })}
                />
                <TextInput
                  id={`${formId}-row-${absoluteIndex}-base-unit`}
                  labelText={uiText("Basiseinheit", "Base unit")}
                  value={row.baseUnit}
                  disabled={!row.included}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    updateRow(index, { baseUnit: event.currentTarget.value })}
                />
                <TextArea
                  id={`${formId}-row-${absoluteIndex}-other-units`}
                  labelText={uiText(`Weitere Einheiten in ${row.baseUnit}`, `Other units in ${row.baseUnit}`)}
                  rows={2}
                  value={row.conversionsText}
                  placeholder={uiText("Sack = 30", "Bag = 30")}
                  disabled={!row.included}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                    updateRow(index, { conversionsText: event.currentTarget.value })}
                />
              </>}

              <TextInput
                id={`${formId}-row-${absoluteIndex}-net-price`}
                labelText={uiText(`Nettopreis je ${row.baseUnit}`, `Net price per ${row.baseUnit}`)}
                type="number"
                min="0"
                step="any"
                value={row.pricePerBaseUnit}
                disabled={!row.included}
                invalid={!!row.conversionWarning}
                invalidText={row.conversionWarning}
                onChange={(event: ChangeEvent<HTMLInputElement>) => updateRow(index, {
                  pricePerBaseUnit: event.currentTarget.valueAsNumber,
                  conversionWarning: null,
                })}
              />
              <TextInput
                id={`${formId}-row-${absoluteIndex}-comment`}
                labelText={uiText("Kommentar", "Comment")}
                value={row.comment ?? ""}
                disabled={!row.included}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateRow(index, { comment: event.currentTarget.value || null })}
              />
            </div>
          </div>}
        </article>;
      })}
    </div>

    {pageCount > 1 && <div className="price-import-pagination">
      <MyButton
        kind="secondary"
        size="sm"
        disabled={page === 0}
        onClick={() => setPage(current => Math.max(0, current - 1))}
      >
        {uiText("Zurück", "Previous")}
      </MyButton>
      <span>{uiText(
        `Seite ${page + 1} von ${pageCount}`,
        `Page ${page + 1} of ${pageCount}`,
      )}</span>
      <MyButton
        kind="secondary"
        size="sm"
        disabled={page + 1 >= pageCount}
        onClick={() => setPage(current => Math.min(pageCount - 1, current + 1))}
      >
        {uiText("Weiter", "Next")}
      </MyButton>
    </div>}
  </div>;
}

export function showPriceImportModal(
  modals: MyModalsInterface,
  result: PriceListResult,
  documentType: DocumentScanResult["documentType"],
) {
  const controller: PriceImportController = { current: null };

  modals.showDefault({
    content: () => <PriceImportEditor
      result={result}
      documentType={documentType}
      controller={controller}
    />,
    modalProps: () => ({
      modalHeading: documentType === "invoice"
        ? uiText("Preise aus Rechnung übernehmen", "Import invoice prices")
        : uiText("Preise aus Preisliste übernehmen", "Import price list prices"),
      className: "price-import-modal",
      primaryButtonText: uiText("Preise speichern", "Save prices"),
    }),
    onPrimaryAction: async ({ hide }) => {
      const state = controller.current;
      if (!state?.vendorId) {
        throw new Error(uiText("Bitte wähle einen Händler aus.", "Choose a vendor."));
      }
      if (!state.effectiveDate) {
        throw new Error(uiText("Bitte gib einen Preisstand an.", "Choose an effective date."));
      }

      const rows = state.rows.filter(row => row.included);
      if (rows.length === 0) {
        throw new Error(uiText("Wähle mindestens eine Preiszeile aus.", "Select at least one price row."));
      }
      if (rows.some(row => !row.productName.trim() || !row.baseUnit.trim()
        || !Number.isFinite(row.pricePerBaseUnit) || row.pricePerBaseUnit < 0)) {
        throw new Error(uiText(
          "Prüfe Bezeichnung, Einheit und Nettopreis der ausgewählten Zeilen.",
          "Check the name, unit, and net price of the selected rows.",
        ));
      }

      if (rows.some(row => row.conversionWarning)) {
        throw new Error(uiText(
          "Prüfe die Nettopreise der Zeilen ohne passende Umrechnung.",
          "Check the net prices of rows without a matching conversion.",
        ));
      }

      const preparedRows = rows.map(row => {
        const otherUnits = row.productId ? {} : parseConversions(row.conversionsText, row.baseUnit.trim());
        if (!otherUnits) {
          throw new Error(uiText(
            "Prüfe die Umrechnungen der neuen Produkte (z. B. Sack = 30).",
            "Check the new products' unit conversions (e.g. bag = 30).",
          ));
        }

        return {
          productId: row.productId,
          productName: row.productName.trim(),
          brand: row.brand?.trim() || null,
          description: row.description?.trim() || null,
          baseUnit: row.baseUnit.trim(),
          otherUnits,
          pricePerBaseUnit: row.pricePerBaseUnit,
          comment: row.comment?.trim() || null,
        };
      });

      const [saved, saveError] = await client.mutate("products.priceImports.apply", {
        vendorId: state.vendorId,
        effectiveAt: new Date(`${state.effectiveDate}T12:00:00`),
        isRealPurchase: state.isRealPurchase,
        rows: preparedRows,
      });
      if (saveError) throw saveError;
      if (!saved) return;

      await Promise.all([
        client.invalidateCascading("products.list"),
        client.invalidateCascading("products.priceRecords.list"),
      ]);
      hide();
    },
  });
}
