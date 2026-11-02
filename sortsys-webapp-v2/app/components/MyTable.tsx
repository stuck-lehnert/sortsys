import { Button, EmptyState, Table as HeroTable } from "@heroui/react";
import { Loading, LoadMore, Tile } from "@sortsys/react-components";
import {
  Fragment,
  useId,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useDimensions } from "~/hooks/useDimensions";
import { useJsonUrlParam } from "~/hooks/useUrlParam";
import { uiText } from "~/lib/i18n";
import type { PromiseOr } from "~/type-helpers";
import { AttrList } from "./AttrList";
import { Awaited } from "./Awaited";
import { useRowWindow } from "~/hooks/useRowWindow";

export interface MyTableColumn<RowT extends object> {
  label: string;
  render: (row: RowT) => PromiseOr<ReactNode>;
  sortKey?: ((row: RowT) => string) | ((row: RowT) => number);
  wrap?: boolean;
}

export function MyTable<
  RowT extends object & { id: string | number | bigint },
>({
  tableClassName,
  rows,
  columns,
  loadMore,
  persistentId,
  onRowClick,
  viewportBreakpoint = 1000,
  renderSmallViewport,
  autoConvertSmallViewport,
  loading = false,
  emptyMessage = uiText("Keine Einträge vorhanden.", "No entries available."),
  error,
  ...props
}: {
  persistentId?: string;
  rows: RowT[];
  columns: MyTableColumn<RowT>[];
  onRowClick?: (row: RowT) => PromiseOr<void>;
  loadMore?: { batchSize?: number };
  tableClassName?: string;
  viewportBreakpoint?: number;
  renderSmallViewport?: (row: RowT, cells: ReactNode[]) => ReactNode;
  autoConvertSmallViewport?: boolean;
  loading?: boolean;
  emptyMessage?: ReactNode;
  error?: unknown;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  const { width } = useDimensions();
  const [urlSort, setUrlSort] = useJsonUrlParam(
    `sort${persistentId ?? "local"}`,
  );
  const [stateSort, setStateSort] = useState<[number | null, "ASC" | "DESC"]>([
    null,
    "ASC",
  ]);
  const sortBy = persistentId ? (urlSort?.[0] ?? null) : stateSort[0];
  const sortOrder = persistentId ? (urlSort?.[1] ?? "ASC") : stateSort[1];
  const activeColumn = typeof sortBy === "number" ? columns[sortBy] : undefined;

  const toggleSorting = (column: number) => {
    const previous = sortBy === column ? sortOrder : null;
    const next =
      previous === "ASC" ? "DESC" : previous === "DESC" ? null : "ASC";
    if (persistentId) {
      setUrlSort(next ? [column, next] : null);
    } else {
      setStateSort(next ? [column, next] : [null, "ASC"]);
    }
  };

  const sortedRows = useMemo(() => {
    const sortKey = activeColumn?.sortKey;
    if (!sortKey) {
      return rows;
    }

    return [...rows].sort((left, right) => {
      const leftKey = sortKey(left);
      const rightKey = sortKey(right);
      if (typeof leftKey === "string" && typeof rightKey === "string") {
        if (!leftKey) {
          return 1;
        }

        if (!rightKey) {
          return -1;
        }

        const order = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        return sortOrder === "ASC" ? order : -order;
      }

      return sortOrder === "ASC"
        ? Number(leftKey) - Number(rightKey)
        : Number(rightKey) - Number(leftKey);
    });
  }, [rows, activeColumn, sortOrder]);

  const tableId = useId();
  const cardsId = `${tableId}-cards`;
  const gridId = `${tableId}-grid`;
  const useCards = Boolean(
    (renderSmallViewport || autoConvertSmallViewport) &&
      width < viewportBreakpoint,
  );
  const requestedBatchSize = loadMore?.batchSize ?? 25;
  const batchSize =
    Number.isSafeInteger(requestedBatchSize) && requestedBatchSize > 0
      ? requestedBatchSize
      : 25;
  const { visibleCount, showMore } = useRowWindow(
    sortedRows.map((row) => String(row.id)),
    batchSize,
    JSON.stringify([sortBy, sortOrder]),
    persistentId,
  );
  const rowLimit = loadMore ? visibleCount : sortedRows.length;

  const mappedRows = useMemo(() => {
    return sortedRows.slice(0, rowLimit).map((row) => ({
      id: String(row.id),
      row,
      cells: columns.map(({ render }) => {
        const content = render(row);
        return content instanceof Promise ? (
          <Awaited promise={content} />
        ) : (
          content
        );
      }),
    }));
  }, [columns, sortedRows, rowLimit]);

  const moreControl = loadMore &&
    !loading &&
    !error &&
    sortedRows.length > batchSize && (
      <LoadMore
        visibleItems={mappedRows.length}
        totalItems={sortedRows.length}
        controls={useCards ? cardsId : gridId}
        onLoadMore={showMore}
      />
    );

  const stateContent = error ? (
    <div role="alert" className="p-6 text-danger">
      {uiText(
        "Einträge konnten nicht geladen werden.",
        "Entries could not be loaded.",
      )}
    </div>
  ) : loading ? (
    <Loading
      description={uiText("Einträge werden geladen …", "Loading entries …")}
    />
  ) : mappedRows.length === 0 ? (
    <EmptyState className="py-10">
      <p className="text-sm text-muted">{emptyMessage}</p>
    </EmptyState>
  ) : null;

  if (useCards) {
    return (
      <section
        {...props}
        aria-busy={loading}
        className={`space-y-4 ${props.className ?? ""}`}
      >
        <div id={cardsId} className="space-y-3">
          {stateContent ??
            mappedRows.map(({ id, row, cells }) => (
              <Fragment key={id}>
                {renderSmallViewport ? (
                  renderSmallViewport(row, cells)
                ) : (
                  <Tile>
                    <AttrList>
                      {columns.map(({ label }, index) => (
                        <AttrList.Attr
                          key={index}
                          name={label}
                          value={cells[index]}
                        />
                      ))}
                    </AttrList>
                    {onRowClick && (
                      <Button
                        variant="secondary"
                        onPress={() => {
                          void onRowClick(row);
                        }}
                      >
                        {uiText("Eintrag öffnen", "Open entry")}
                      </Button>
                    )}
                  </Tile>
                )}
              </Fragment>
            ))}
        </div>
        {moreControl}
      </section>
    );
  }

  return (
    <HeroTable {...props} className={`min-w-0 ${props.className ?? ""}`}>
      <HeroTable.ScrollContainer id={gridId}>
        <HeroTable.Content
          aria-label={props["aria-label"] ?? uiText("Einträge", "Entries")}
          aria-busy={loading}
          className={tableClassName}
          sortDescriptor={
            activeColumn?.sortKey
              ? {
                  column: `column-${sortBy}`,
                  direction: sortOrder === "ASC" ? "ascending" : "descending",
                }
              : undefined
          }
          onSortChange={({ column }) => {
            toggleSorting(Number(String(column).replace("column-", "")));
          }}
          onRowAction={
            onRowClick
              ? (key) => {
                  const entry = mappedRows.find(({ id }) => id === String(key));
                  if (entry) {
                    void onRowClick(entry.row);
                  }
                }
              : undefined
          }
        >
          <HeroTable.Header>
            {columns.map(({ label, sortKey }, index) => (
              <HeroTable.Column
                key={index}
                id={`column-${index}`}
                isRowHeader={index === 0}
                allowsSorting={Boolean(sortKey)}
              >
                {({ sortDirection }) =>
                  sortKey ? (
                    <HeroTable.SortableColumnHeader
                      sortDirection={sortDirection}
                    >
                      {label}
                    </HeroTable.SortableColumnHeader>
                  ) : (
                    label
                  )
                }
              </HeroTable.Column>
            ))}
          </HeroTable.Header>
          <HeroTable.Body
            items={stateContent ? [] : mappedRows}
            renderEmptyState={() => stateContent}
          >
            {({ id, cells }) => (
              <HeroTable.Row
                id={id}
                className={onRowClick ? "cursor-pointer" : undefined}
              >
                {cells.map((cell, index) => (
                  <HeroTable.Cell
                    key={`cell-${id}-${index}`}
                    className={
                      columns[index].wrap
                        ? "my-table-cell--wrap whitespace-normal break-words"
                        : undefined
                    }
                  >
                    {cell}
                  </HeroTable.Cell>
                ))}
              </HeroTable.Row>
            )}
          </HeroTable.Body>
        </HeroTable.Content>
      </HeroTable.ScrollContainer>
      {moreControl}
    </HeroTable>
  );
}
