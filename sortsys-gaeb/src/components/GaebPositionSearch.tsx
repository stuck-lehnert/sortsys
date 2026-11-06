import { useEffect, useRef, useState } from "react";
import { ComboBox } from "@sortsys/react-components";
import type {
  GaebPositionSearch as Search,
  GaebPositionSuggestion,
} from "../core/positionLibrary";
import { text, type GaebLocale } from "../messages";
export function GaebPositionSearch({
  search,
  locale,
  onSelect,
}: {
  search: Search;
  locale: GaebLocale;
  onSelect: (item: GaebPositionSuggestion) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<GaebPositionSuggestion[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoading(true);
      setFailed(false);
      try {
        const result = await searchRef.current(query);
        if (active) {
          setItems(result.items);
          setLoading(result.indexing);
          if (result.indexing) timer = setTimeout(load, 400);
        }
      } catch {
        if (active) {
          setFailed(true);
          setLoading(false);
        }
      }
    };
    timer = setTimeout(load, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, query, generation]);
  const label = text(
    locale,
    "Bisherige Positionen durchsuchen",
    "Search previous items",
  );
  return (
    <div
      className="gaeb-position-search"
      onFocusCapture={() => setEnabled(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setEnabled(false);
      }}
    >
      <ComboBox
        key={generation}
        aria-label={label}
        placeholder={label}
        value={query}
        items={items}
        loading={loading}
        loadError={failed}
        itemToString={(item: GaebPositionSuggestion) =>
          `${item.shortText} ${item.description}`
        }
        itemToElement={(item: GaebPositionSuggestion) => (
          <div className="gaeb-position-option">
            <strong>{item.shortText}</strong>
            <span>{item.description}</span>
            <small>
              {[item.unit, item.sourceFile].filter(Boolean).join(" · ")}
            </small>
          </div>
        )}
        onInputChange={(value: string) => setQuery(value)}
        onChange={({
          selectedItem,
        }: {
          selectedItem: GaebPositionSuggestion | null;
        }) => {
          if (!selectedItem) return;
          setQuery("");
          setEnabled(false);
          setGeneration((value) => value + 1);
          onSelect(selectedItem);
        }}
      />
    </div>
  );
}
