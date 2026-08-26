import { DataTable, Pagination, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tile } from "@sortsys/react-components";
import { Fragment, useMemo, useState, type ComponentProps, type ReactNode } from "react";
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
} & Omit<ComponentProps<typeof TableContainer>, ''>) {
  let {
    tableClassName, rows, columns, pagination, persistentId, onRowClick,
    topPagination, viewportBreakpoint, renderSmallViewport, autoConvertSmallViewport,
    ...props
  } = _props;

  viewportBreakpoint ??= 1000;

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

  let sortBy: number | null = null;
  let sortOrder: 'ASC' | 'DESC' = 'ASC';
  let setSorting: (sortBy: number | null, sortOrder: 'ASC' | 'DESC' | null) => void;

  if (persistentId) {
    const [urlSort, setUrlSort] = useJsonUrlParam(`sort${persistentId}`);
    if (urlSort) {
      sortBy = (urlSort ?? [])[0];
      sortOrder = (urlSort ?? [])[1] ?? 'ASC';
    }

    setSorting = (sortBy, sortOrder) => {
      if (!sortOrder) setUrlSort(null);
      else setUrlSort([sortBy, sortOrder]);
    };
  } else {
    const [stateSort, setStateSort] = useState<[number | null, 'ASC' | 'DESC']>([null, 'ASC']);

    sortBy = stateSort[0];
    sortOrder = stateSort[1];

    setSorting = (sortBy, sortOrder) => {
      if (!sortOrder) setStateSort([null, 'ASC']);
      else setStateSort([sortBy, sortOrder]);
    };
  }

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

    return sortableRows.sort((a, b) => {
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
  }, [sortBy, sortOrder, sortableRows]);

  const hasPagination = typeof pagination === 'object' && pagination !== null;
  const pageSizes = pagination?.pageSizes ?? [25, 50, 100];

  let page = 0, pageSize = 1000000000;
  let setPage = (page: number) => { }, setPageSize = (pageSize: number) => { };
  if (hasPagination) {
    if (persistentId) {
      const [_page, _setPage] = useIntUrlParam(`page${persistentId}`);
      const [_pageSize, _setPageSize] = useIntUrlParam(`pageSize${persistentId}`);

      page = _page ?? 0;
      setPage = page => _setPage(page === 0 ? null : page);
      pageSize = _pageSize ?? pageSizes[0];
      if (!pageSizes.includes(pageSize)) pageSize = pageSizes[0];
      setPageSize = pageSize => _setPageSize(pageSize === pageSizes[0] ? null : pageSize);
    } else {
      [page, setPage] = useState(0);
      [pageSize, setPageSize] = useState(pageSizes[0]);
    }
  }

  const paginatedRows = useMemo(() => {
    const start = page * pageSize, end = start + pageSize;
    return sortedRows.slice(start, end);
  }, [sortedRows, page, pageSize]);

  const mappedRows = useMemo(() => {
    return paginatedRows.map(row => ({
      row,
      cells: columns.map(({ render }) => {
        const rendered = render(row);
        if (rendered instanceof Promise) return <Awaited promise={rendered} />;
        return rendered;
      }) as ReactNode[],
    }));
  }, [paginatedRows]);

  const _pagination = hasPagination && <Pagination
    totalItems={sortedRows.length}
    page={page + 1}
    pageSize={pageSize}
    pageSizes={pageSizes}
    onChange={({ page: _page, pageSize: _pageSize }: any) => {
      _page -= 1;
      if (page !== _page) setPage(_page);
      if (pageSize !== _pageSize) setPageSize(_pageSize);
    }}

    backwardText="Zurück"
    forwardText="Weiter"
    itemsPerPageText="Zeilen pro Seite"
    itemRangeText={(min: any, max: any, total: any) => `Zeile ${min}-${max} von ${total}`}
    pageRangeText={(curr: any, total: any) => `von ${total} Seiten`}
    size="md"
  />;

  if (renderSmallViewport || autoConvertSmallViewport) {
    const { width, height } = useDimensions();

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
          border: '1px solid var(--ss-border) !important',
        }}>
          {mappedRows.map(({ row, cells }) => <Fragment key={row.id}>
            {renderSmallViewport!(row, cells)}
          </Fragment>)}

          {!paginatedRows.length && <div style={{ height: '2rem' }} />}
        </Tile>

        {!topPagination && _pagination}
      </>;
    }
  }

  return <TableContainer {...props}>
    {!!topPagination && _pagination}

    <Table className={`sticky-header-table ${tableClassName ?? ''}`} isSortable>
      <TableHead>
        <TableRow>
          {columns.map(({ label, sortKey }, i) =>
            <TableHeader
              key={`${i}-${label}`}
              isSortable={!!sortKey}
              isSortHeader={sortBy === i}
              sortDirection={sortBy === i ? sortOrder : 'NONE'}
              onClick={sortKey ? () => {
                const prevDirection = sortBy === i ? sortOrder : null;
                setSorting(i, prevDirection === 'ASC' ? 'DESC' : prevDirection === 'DESC' ? null : 'ASC');
              } : undefined}
            >
              {label}
            </TableHeader>
          )}
        </TableRow>
      </TableHead>

      <TableBody>
        {mappedRows.map(({ cells, row }) => <TableRow key={row.id}
          onClick={() => onRowClick?.(row)}
          className={`${onRowClick ? 'cursor-pointer' : ''}`}
        >
          {cells.map((cell, i) => <TableCell key={i}>{cell}</TableCell>)}
        </TableRow>)}
      </TableBody>
    </Table>

    {!topPagination && _pagination}
  </TableContainer>
}
