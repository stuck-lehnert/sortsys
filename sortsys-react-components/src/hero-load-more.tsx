import { useLocale } from "@heroui/react";
import { Button } from "./hero-controls.js";

export interface LoadMoreProps {
  visibleItems: number;
  totalItems: number;
  onLoadMore: () => void;
  controls?: string;
  loading?: boolean;
  className?: string;
}

export function LoadMore({
  visibleItems,
  totalItems,
  onLoadMore,
  controls,
  loading = false,
  className = "",
}: LoadMoreProps) {
  const { locale } = useLocale();
  const english = locale.startsWith("en");
  const hasMore = visibleItems < totalItems;
  const summary = english
    ? `${visibleItems} of ${totalItems} entries`
    : `${visibleItems} von ${totalItems} Einträgen`;
  const label = loading
    ? english
      ? "Loading …"
      : "Wird geladen …"
    : hasMore
      ? english
        ? "Show more"
        : "Mehr anzeigen"
      : english
        ? "All entries shown"
        : "Alle Einträge angezeigt";

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 py-2 ${className}`}
    >
      <p role="status" aria-atomic="true" className="text-sm text-muted">
        {summary}
      </p>
      <Button
        kind="secondary"
        size="sm"
        loading={loading}
        aria-controls={controls}
        aria-disabled={loading || !hasMore}
        onPress={() => {
          if (!loading && hasMore) {
            onLoadMore();
          }
        }}
      >
        {label}
      </Button>
    </div>
  );
}
