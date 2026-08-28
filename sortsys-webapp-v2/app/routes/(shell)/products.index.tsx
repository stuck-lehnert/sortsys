import { uiText } from "~/lib/i18n";
import { OperationalTag } from "@sortsys/react-components";
import type { Route } from "./+types";
import { useNavigate } from "react-router";
import { useMemo } from "react";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { MyTable } from "~/components/MyTable";
import { ProductTile, SmallProductTile, SmallTile } from "~/lib/tiles";
import { useMyModals } from "~/hooks/useMyModals";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { Icons } from "~/lib/icons";
import { useStringUrlParam } from "~/hooks/useUrlParam";
import { formatCurrency } from "~/lib/format";
import { TableExportActions } from "~/components/TableExportActions";
import { EXCEL_CURRENCY_NUM_FMT } from "~/lib/xlsx";

export function meta({}: Route.MetaArgs) {
  return [
    { title: uiText("Produkte") },
  ];
}

export default function ProductsPage() {
  const navigate = useNavigate();
  const modals = useMyModals();

  const [category, setCategory] = useStringUrlParam('category');
  const [brand, setBrand] = useStringUrlParam('brand');

  const [products] = useClientStream(() => client.streamQuery('products.list', {
    category,
  }), [category]);

  const filteredProducts = useMemo(() => {
    if (!products) return [];
    if (!brand) return products;
    const normalized = brand.toLowerCase();
    return products.filter(product => (product.brand ?? '').toLowerCase() === normalized);
  }, [products, brand]);

  function showFilterModal() {
    modals.showForm({
      content: ({ context }) => <>
        <MyForm.MultiSelect
          name="brand"
          labelText={uiText("Hersteller")}
          maxSelectedItems={1}
          prepare={async () => {
            const [data, err] = await client.query('products.brands.list', undefined);
            if (err) throw err;
            return data ?? [];
          }}
          getOptions={({ query, init }) => {
            const normalized = query.toLowerCase();
            return init
              .filter((item) => item.toLowerCase().includes(normalized))
              .map(item => ({ id: item }));
          }}
          renderItem={({ item }) => item.id}
          renderTile={item => <SmallTile title={item.id} />}
        />

        <MyForm.MultiSelect
          name="category"
          labelText={uiText("Kategorie")}
          maxSelectedItems={1}
          prepare={async () => {
            const [data, err] = await client.query('products.categories.list', undefined);
            if (err) throw err;
            return data ?? [];
          }}
          getOptions={({ query, init }) => {
            const normalized = query.toLowerCase();
            return init
              .filter((item) => item.toLowerCase().includes(normalized))
              .map(item => ({ id: item }));
          }}
          renderItem={({ item }) => item.id}
          renderTile={item => <SmallTile title={item.id} />}
        />

        <NotifyLoaded onLoad={() => {
          context.setValues({
            brand: brand ? [{ id: brand }] : [],
            category: category ? [{ id: category }] : [],
          });
        }} />
      </>,
      onSubmit: ({ context, hide }) => {
        const values = context.getValues();
        setBrand(values.brand?.at(0)?.id ?? null);
        setCategory(values.category?.at(0)?.id ?? null);
        hide();
      },
      modalProps: () => ({
        modalHeading: uiText("Produkte filtern"),
        primaryButtonText: uiText("Filter anwenden"),
      }),
    });
  }

  const hasFilter = !!(category || brand);

  async function loadProductExportRows(): Promise<any[]> {
    const [priceRecords, priceRecordsErr] = await client.query('products.priceRecords.list', {});
    if (priceRecordsErr) throw priceRecordsErr;

    const latestPriceRecordByProductId = new Map<string, any>();
    (priceRecords ?? []).forEach((record: any) => {
      const previous = latestPriceRecordByProductId.get(record.productId);
      if (!previous || record.timestamp.getTime() > previous.timestamp.getTime()) {
        latestPriceRecordByProductId.set(record.productId, record);
      }
    });

    return (filteredProducts ?? []).map((product: any) => {
      const latestPriceRecord = latestPriceRecordByProductId.get(product.id);
      return {
        ...product,
        latestPrice: latestPriceRecord?.price != null ? Number(latestPriceRecord.price) : null,
      };
    });
  }

  return <>
    <div className="flex gap-2 w-full overlflow-x-auto">
      {!hasFilter ? <>
        <OperationalTag renderIcon={Icons.Filter} text={uiText("Filter")} onClick={showFilterModal} />
      </> : <>
        <OperationalTag renderIcon={Icons.FilterEdit} text={uiText("Filter ändern")} onClick={showFilterModal} />
        <OperationalTag renderIcon={Icons.FilterRemove} text={uiText("Filter aus")} onClick={() => {
          setBrand(null);
          setCategory(null);
        }} />
      </>}

      <TableExportActions
        title={uiText("Produkte")}
        fileName="Produkte"
        rows={loadProductExportRows}
        disabled={!products}
        columns={[
          { header: uiText("Nummer"), value: product => product.customId, align: 'right' },
          { header: uiText("Bezeichnung"), value: product => product.name, width: '2fr' },
          { header: uiText("Hersteller"), value: product => product.brand },
          { header: uiText("Kategorie"), value: product => product.categories?.join(', '), width: '1.5fr' },
          { header: uiText("Basiseinheit"), value: product => product.baseUnit },
          {
            header: uiText("Aktueller Preis"),
            value: product => product.latestPrice,
            format: value => value == null ? '' : formatCurrency(Number(value)),
            excelNumberFormat: EXCEL_CURRENCY_NUM_FMT,
            align: 'right',
          },
        ]}
      />
    </div>

    <div style={{ height: '1px' }} />

    <MyTable
      topPagination
      className=""
      persistentId="Products"
      rows={filteredProducts ?? []}
      onRowClick={row => navigate(`/products/${row.id}`)}
      columns={[
        {
          label: uiText("Nummer"),
          render: row => row.customId.toString(),
          sortKey: row => row.customId,
        },
        {
          label: uiText("Bezeichnung"),
          render: row => row.name,
          sortKey: row => row.name.toLowerCase(),
        },
        {
          label: uiText("Hersteller"),
          render: row => row.brand,
          sortKey: row => row.brand?.toLowerCase() ?? '',
        },
        // {
        //   label: 'Beschreibung',
        //   render: row => row.description,
        //   sortKey: row => row.description?.toLowerCase() ?? '',
        // },
      ]}
      pagination={{}}
      renderSmallViewport={product => <SmallProductTile data={product} />}
    />
  </>;
}
