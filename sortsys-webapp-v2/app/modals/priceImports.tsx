import type { MutateResult, QueryResult } from "@sortsys/v2-client";
import { ComboBox } from "@sortsys/react-components";
import { useEffect, useMemo, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";

type DocumentScanResult = MutateResult<"deliveryNotes.scan.complete">;
type PriceListResult = NonNullable<DocumentScanResult["priceList"]>;
type Product = QueryResult<"products.list">[number];
type Vendor = QueryResult<"products.vendors.list">[number];

type EditablePriceRow = PriceListResult["rows"][number] & {
  included: boolean;
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

const pageSize = 50;

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
    titleText={label}
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

function PriceImportEditor({
  result,
  documentType,
  controller,
}: {
  result: PriceListResult;
  documentType: DocumentScanResult["documentType"];
  controller: PriceImportController;
}) {
  const [page, setPage] = useState(0);
  const [state, setState] = useState<PriceImportState>(() => ({
    vendorId: "",
    vendorName: "",
    effectiveDate: defaultEffectiveDate(result.effectiveDate),
    isRealPurchase: documentType === "invoice",
    rows: result.rows.map(row => ({ ...row, included: true })),
  }));

  controller.current = state;

  const selectedCount = state.rows.filter(row => row.included).length;
  const newProductCount = state.rows.filter(row => row.included && !row.productId).length;
  const pageCount = Math.max(1, Math.ceil(state.rows.length / pageSize));
  const visibleRows = useMemo(
    () => state.rows.slice(page * pageSize, (page + 1) * pageSize),
    [page, state.rows],
  );

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
    if (!product) {
      updateRow(indexOnPage, { productId: null, customId: null });
      return;
    }

    updateRow(indexOnPage, {
      productId: product.id,
      customId: product.customId,
      productName: product.name,
      baseUnit: product.baseUnit,
    });
  }

  return <div className="price-import-editor">
    <div className="price-import-fields">
      <AutocompleteSelect
        label={uiText("Händler", "Vendor")}
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

      <label>
        <span>{uiText("Preisstand", "Effective date")}</span>
        <input
          required
          type="date"
          value={state.effectiveDate}
          onChange={event => {
            const effectiveDate = event.currentTarget.value;
            setState(current => ({ ...current, effectiveDate }));
          }}
        />
      </label>

      <label className="price-import-checkbox">
        <input
          type="checkbox"
          checked={state.isRealPurchase}
          onChange={event => {
            const checked = event.currentTarget.checked;
            setState(current => ({ ...current, isRealPurchase: checked }));
          }}
        />
        <span>{uiText("Preise aus einem echten Einkauf", "Prices from an actual purchase")}</span>
      </label>
    </div>

    {!!result.warnings.length && <MyCallout
      kind="warning"
      title={uiText("Bitte prüfen", "Please review")}
      subtitle={result.warnings.join(" ")}
    />}

    <div className="price-import-summary">
      <strong>{uiText(
        `${selectedCount} Preise ausgewählt`,
        `${selectedCount} prices selected`,
      )}</strong>
      <span className="light">{uiText(
        `${newProductCount} neue Produkte vorgeschlagen`,
        `${newProductCount} new products proposed`,
      )}</span>
    </div>

    <div className="price-import-table-wrap">
      <table className="price-import-table">
        <thead>
          <tr>
            <th aria-label={uiText("Übernehmen", "Include")} />
            <th>{uiText("Produkt", "Product")}</th>
            <th>{uiText("Bezeichnung", "Name")}</th>
            <th>{uiText("Einheit", "Unit")}</th>
            <th>{uiText("Nettopreis je Basiseinheit", "Net price per base unit")}</th>
            <th>{uiText("Kommentar", "Comment")}</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, index) => <tr key={`${page}-${index}-${row.sourceText}`}>
            <td data-label={uiText("Übernehmen", "Include")}>
              <input
                type="checkbox"
                checked={row.included}
                aria-label={uiText("Zeile übernehmen", "Include row")}
                onChange={event => updateRow(index, { included: event.currentTarget.checked })}
              />
            </td>
            <td data-label={uiText("Produkt", "Product")}>
              <AutocompleteSelect
                placeholder={uiText("Produkt suchen", "Search products")}
                selectedId={row.productId}
                selectedLabel={row.productId
                  ? `${row.customId} · ${row.productName}`
                  : ""}
                initialQuery=""
                disabled={!row.included}
                loadOptions={loadProductOptions}
                onSelect={product => selectProduct(index, product)}
              />
            </td>
            <td data-label={uiText("Bezeichnung", "Name")}>
              <input
                value={row.productName}
                disabled={!row.included || !!row.productId}
                aria-label={uiText("Produktbezeichnung", "Product name")}
                onChange={event => updateRow(index, { productName: event.currentTarget.value })}
              />
              {!row.productId && <small>{uiText("wird neu angelegt", "will be created")}</small>}
            </td>
            <td data-label={uiText("Einheit", "Unit")}>
              <input
                value={row.baseUnit}
                disabled={!row.included || !!row.productId}
                aria-label={uiText("Basiseinheit", "Base unit")}
                onChange={event => updateRow(index, { baseUnit: event.currentTarget.value })}
              />
            </td>
            <td data-label={uiText("Nettopreis", "Net price")}>
              <input
                type="number"
                min="0"
                step="any"
                value={row.pricePerBaseUnit}
                disabled={!row.included}
                aria-label={uiText("Nettopreis", "Net price")}
                onChange={event => updateRow(index, {
                  pricePerBaseUnit: event.currentTarget.valueAsNumber,
                })}
              />
              <small>{uiText("EUR")} / {row.baseUnit}</small>
            </td>
            <td data-label={uiText("Kommentar", "Comment")}>
              <input
                value={row.comment ?? ""}
                disabled={!row.included}
                aria-label={uiText("Kommentar", "Comment")}
                onChange={event => updateRow(index, {
                  comment: event.currentTarget.value || null,
                })}
              />
            </td>
          </tr>)}
        </tbody>
      </table>
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
        ? uiText("Rechnung als Preisliste übernehmen", "Import invoice prices")
        : uiText("Preisliste übernehmen", "Import price list"),
      modalLabel: result.supplier ?? undefined,
      primaryButtonText: uiText("Preise speichern", "Save prices"),
      useFullscreen: true,
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

      const [saved, saveError] = await client.mutate("products.priceImports.apply", {
        vendorId: state.vendorId,
        effectiveAt: new Date(`${state.effectiveDate}T12:00:00`),
        isRealPurchase: state.isRealPurchase,
        rows: rows.map(row => ({
          productId: row.productId,
          productName: row.productName.trim(),
          baseUnit: row.baseUnit.trim(),
          pricePerBaseUnit: row.pricePerBaseUnit,
          comment: row.comment?.trim() || null,
        })),
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
