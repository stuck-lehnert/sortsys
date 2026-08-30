import { uiText } from "~/lib/i18n";
import { DataTable, Pagination, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tile } from "@sortsys/react-components";
import { Fragment, useMemo, useState, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useIntUrlParam, useJsonUrlParam } from "~/hooks/useUrlParam";
import type { PromiseOr } from "~/type-helpers";
import { Awaited } from "./Awaited";
import { useDimensions } from "~/hooks/useDimensions";
import { AttrList } from "./AttrList";


export interface MyTableColumn<RowT extends object> {
  label: string;
  render: (row: RowT) => PromiseOr<ReactNode>;
  sortKey?: ((row: RowT) => string) | ((row: RowT) => number);
}

export function MyTable<RowT extends Record<string, any> & { id: string | number | bigint; }>(_props: {
  persistentId?: string;

  rows: RowT[];
  columns: MyTableColumn<RowT>[];

  onRowClick?: (row: RowT) => PromiseOr<void>;

  pagination?: {
    pageSizes?: number[];
  };

  tableClassName?: string;
  topPagination?: boolean;

  viewportBreakpoint?: number;
  renderSmallViewport?: (row: RowT, cells: ReactNode[]) => ReactNode;
  autoConvertSmallViewport?: boolean;
  loading?: boolean;
  emptyMessage?: ReactNode;
  error?: unknown;
} & Omit<ComponentProps<typeof TableContainer>, ''>) {
  let {
    tableClassName, rows, columns, pagination, persistentId, onRowClick,
    topPagination, viewportBreakpoint, renderSmallViewport, autoConvertSmallViewport,
    loading = false,
    emptyMessage = uiText("Keine Einträge vorhanden.", "No entries available."),
    error,
    ...props
  } = _props;

  viewportBreakpoint ??= 1000;
  const { width } = useDimensions();

  // const mappedHeaders = columns.map((column, i) => ({
  //     header: column.label,
  //     key: i.toString(),
  // }));

  // const mappedRows = useMemo(() => rows.map((row) => {
  //     const mappedRow: any = { id: row.id };
  //     columns.forEach((column, i) => mappedRow[i.toString()] = column.render(row));
  //     return mappedRow;
  // }), [JSON.stringify(mappedHeaders), rows]);

  // return <DataTable
  //     headers={mappedHeaders}
  //     rows={mappedRows}
  // />;

  const [urlSort, setUrlSort] = useJsonUrlParam(`sort${persistentId ?? 'local'}`);
  const [stateSort, setStateSort] = useState<[number | null, 'ASC' | 'DESC']>([null, 'ASC']);
  const sortBy = persistentId ? (urlSort?.[0] ?? null) : stateSort[0];
  const sortOrder = persistentId ? (urlSort?.[1] ?? 'ASC') : stateSort[1];

  const setSorting = (nextSortBy: number | null, nextSortOrder: 'ASC' | 'DESC' | null) => {
    if (persistentId) {
      if (!nextSortOrder) setUrlSort(null);
      else setUrlSort([nextSortBy, nextSortOrder]);
    } else {
      if (!nextSortOrder) setStateSort([null, 'ASC']);
      else setStateSort([nextSortBy, nextSortOrder]);
    }
  };

  const sortableRows = useMemo(() => {
    return rows.map((row) => {
      const sortableRow: Record<string, any> = { row };

      columns.forEach(({ sortKey }, i) => {
        if (!sortKey) return;
        sortableRow[i] = sortKey(row);
      });

      return sortableRow;
    });
  }, [rows, JSON.stringify(columns.map(({ label }) => label))]);

  const sortedRows = useMemo(() => {
    { // check if should sort
      const sortColumn = typeof sortBy === 'number' ? columns[sortBy] : null;
      if (!sortColumn || !sortColumn.sortKey) return rows;
    }

    return [...sortableRows].sort((a, b) => {
      const aKey = a[sortBy!], bKey = b[sortBy!];
      if (typeof aKey === 'string') {
        if (!aKey) return 1;
        if (!bKey) return -1;
        if (aKey < bKey) return sortOrder === "ASC" ? -1 : 1;
        if (aKey > bKey) return sortOrder === "ASC" ? 1 : -1;
        return 0;
      } else {
        return sortOrder === "ASC" ? (aKey - bKey) : (bKey - aKey);
      }
    }).map(({ row }) => row);
  }, [columns, rows, sortBy, sortOrder, sortableRows]);

  const hasPagination = typeof pagination === 'object' && pagination !== null;
  const pageSizes = pagination?.pageSizes ?? [25, 50, 100];

  let page = 0, pageSize = 1000000000;
  let setPage = (page: number) => { }, setPageSize = (pageSize: number) => { };
  const [urlPage, setUrlPage] = useIntUrlParam(`page${persistentId ?? 'local'}`);
  const [urlPageSize, setUrlPageSize] = useIntUrlParam(`pageSize${persistentId ?? 'local'}`);
  const [statePage, setStatePage] = useState(0);
  const [statePageSize, setStatePageSize] = useState(pageSizes[0]);

  if (hasPagination) {
    if (persistentId) {
      page = urlPage ?? 0;
      setPage = nextPage => setUrlPage(nextPage === 0 ? null : nextPage);
      pageSize = urlPageSize ?? pageSizes[0];
      if (!pageSizes.includes(pageSize)) pageSize = pageSizes[0];
      setPageSize = nextPageSize => setUrlPageSize(nextPageSize === pageSizes[0] ? null : nextPageSize);
    } else {
      page = statePage;
      setPage = setStatePage;
      pageSize = statePageSize;
      setPageSize = setStatePageSize;
    }
  }

  const lastPage = hasPagination ? Math.max(0, Math.ceil(sortedRows.length / pageSize) - 1) : 0;
  const visiblePage = Math.min(Math.max(page, 0), lastPage);

  const paginatedRows = useMemo(() => {
    const start = visiblePage * pageSize, end = start + pageSize;
    return sortedRows.slice(start, end);
  }, [sortedRows, visiblePage, pageSize]);

  const mappedRows = useMemo(() => {
    return paginatedRows.map(row => ({
      row,
      cells: columns.map(({ render }) => {
        const rendered = render(row);
        if (rendered instanceof Promise) return <Awaited promise={rendered} />;
        return rendered;
      }) as ReactNode[],
    }));
  }, [columns, paginatedRows]);

  const _pagination = hasPagination && !loading && !!sortedRows.length && <Pagination
    totalItems={sortedRows.length}
    page={visiblePage + 1}
    pageSize={pageSize}
    pageSizes={pageSizes}
    onChange={({ page: _page, pageSize: _pageSize }: { page: number; pageSize: number }) => {
      _page -= 1;
      if (page !== _page) setPage(_page);
      if (pageSize !== _pageSize) setPageSize(_pageSize);
    }}

    backwardText={uiText("Zurück")}
    forwardText={uiText("Weiter")}
    itemsPerPageText={uiText("Zeilen pro Seite")}
    itemRangeText={(min: number, max: number, total: number) => uiText(`Zeile ${min}–${max} von ${total}`, `Rows ${min}–${max} of ${total}`)}
    pageRangeText={(curr: number, total: number) => uiText(`Seite ${curr} von ${total}`, `Page ${curr} of ${total}`)}
    size="md"
  />;

  const stateContent = error
    ? <div className="my-table-state my-table-state--error" role="alert">
      {uiText("Einträge konnten nicht geladen werden.", "Entries could not be loaded.")}
    </div>
    : loading
    ? <div className="my-table-state" role="status" aria-live="polite">
      <span className="my-table-state__spinner" aria-hidden="true" />
      <span>{uiText("Einträge werden geladen …", "Loading entries …")}</span>
    </div>
    : !mappedRows.length
      ? <div className="my-table-state" role="status">{emptyMessage}</div>
      : null;

  const isInteractiveTarget = (target: EventTarget | null, currentTarget: EventTarget) => {
    if (!(target instanceof Element) || !(currentTarget instanceof Element)) return false;
    const interactive = target.closest("a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']");
    return !!interactive && interactive !== currentTarget;
  };

  const activateRow = (row: RowT, event: MouseEvent | KeyboardEvent) => {
    if (!onRowClick || isInteractiveTarget(event.target, event.currentTarget)) return;
    void onRowClick(row);
  };

  if (renderSmallViewport || autoConvertSmallViewport) {
    renderSmallViewport ??= (row, cells) => {
      return <Tile>
        <AttrList>
          {columns.map(({ label }, i) => <AttrList.Attr key={`${i}_${label}`} name={label} value={cells[i]} />)}
        </AttrList>
      </Tile>;
    };

    if (width < viewportBreakpoint) {
      return <>
        {!!topPagination && _pagination}

        <Tile className={`w-full space-y-2 overflow-y-auto ${props.className ?? ''}`} style={{
          padding: '0.5rem',
          backgroundColor: 'color-mix(in srgb, var(--ss-surface) 20%, transparent)',
          border: '1px solid var(--ss-border)',
        }}>
          {stateContent ?? mappedRows.map(({ row, cells }) => <Fragment key={row.id}>
            {renderSmallViewport!(row, cells)}
          </Fragment>)}
        </Tile>

        {!topPagination && _pagination}
      </>;
    }
  }

  return <TableContainer {...props} aria-busy={loading}>
    {!!topPagination && _pagination}

    <Table className={`sticky-header-table ${tableClassName ?? ''}`} isSortable>
      <TableHead>
        <TableRow>
          {columns.map(({ label, sortKey }, i) => {
            const toggleSorting = () => {
              const prevDirection = sortBy === i ? sortOrder : null;
              setSorting(i, prevDirection === 'ASC' ? 'DESC' : prevDirection === 'DESC' ? null : 'ASC');
            };

            return <TableHeader
              key={`${i}-${label}`}
              isSortable={!!sortKey}
              isSortHeader={sortBy === i}
              sortDirection={sortBy === i ? sortOrder : 'NONE'}
              aria-sort={!sortKey ? undefined : sortBy !== i ? 'none' : sortOrder === 'ASC' ? 'ascending' : 'descending'}
              tabIndex={sortKey ? 0 : undefined}
              onClick={sortKey ? toggleSorting : undefined}
              onKeyDown={sortKey ? (event: KeyboardEvent) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggleSorting();
              } : undefined}
            >
              {label}
            </TableHeader>;
          })}
        </TableRow>
      </TableHead>

      <TableBody>
        {!!stateContent && <TableRow>
          <TableCell colSpan={Math.max(columns.length, 1)} className="my-table-state-cell">
            {stateContent}
          </TableCell>
        </TableRow>}

        {!stateContent && mappedRows.map(({ cells, row }) => <TableRow key={row.id}
          onClick={(event: MouseEvent) => activateRow(row, event)}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            activateRow(row, event);
          }}
          tabIndex={onRowClick ? 0 : undefined}
          className={onRowClick ? 'my-table-row--interactive' : undefined}
        >
          {cells.map((cell, i) => <TableCell key={i}>{cell}</TableCell>)}
        </TableRow>)}
      </TableBody>
    </Table>

    {!topPagination && _pagination}
  </TableContainer>
}
