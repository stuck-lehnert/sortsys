import { uiText } from "~/lib/i18n";
import type { Route } from "./+types";
import { useNavigate } from "react-router";
import { useMemo } from "react";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { MyTable } from "~/components/MyTable";
import { ProductTile, SmallProductTile } from "~/lib/tiles";
import { useMyModals } from "~/hooks/useMyModals";
import { InventoryFacetField } from "~/components/InventoryFacetField";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useStringUrlParam } from "~/hooks/useUrlParam";
import { formatCurrency } from "~/lib/format";
import { TableExportActions } from "~/components/TableExportActions";
import { EXCEL_CURRENCY_NUM_FMT } from "~/lib/xlsx";
import { MyHeader } from "~/components/MyHeader";
import { ListFilterActions } from "~/components/ListFilterActions";

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

  const [products, productsError] = useClientStream(() => client.streamQuery('products.list', {
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
      content: ({ context }) => (
        <>
          <InventoryFacetField
            catalog="products"
            name="brand"
            labelText={uiText("Hersteller")}
          />

          <InventoryFacetField
            catalog="products"
            name="category"
            labelText={uiText("Kategorie")}
          />

          <NotifyLoaded
            onLoad={() => {
              context.setValues({
                brand: brand ? [{ id: brand }] : [],
                category: category ? [{ id: category }] : [],
              });
            }}
          />
        </>
      ),
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

  return (
    <>
      <MyHeader
        title={uiText("Produkte")}
        actions={
          <div className="list-page-actions">
            <ListFilterActions
              active={hasFilter}
              onEdit={showFilterModal}
              onClear={() => {
                setBrand(null);
                setCategory(null);
              }}
            />

            <TableExportActions
              title={uiText("Produkte")}
              fileName="Produkte"
              rows={loadProductExportRows}
              disabled={!products}
              columns={[
                {
                  header: uiText("Nummer"),
                  pdfHeader: uiText("Nr.", "No."),
                  value: (product) => product.customId,
                  align: "right",
                },
                {
                  header: uiText("Bezeichnung"),
                  value: (product) => product.name,
                  width: "2fr",
                },
                {
                  header: uiText("Hersteller"),
                  value: (product) => product.brand,
                },
                {
                  header: uiText("Kategorie"),
                  value: (product) => product.categories?.join(", "),
                  width: "1.5fr",
                },
                {
                  header: uiText("Basiseinheit"),
                  value: (product) => product.baseUnit,
                },
                {
                  header: uiText("Aktueller Preis"),
                  value: (product) => product.latestPrice,
                  format: (value) =>
                    value == null ? "" : formatCurrency(Number(value)),
                  excelNumberFormat: EXCEL_CURRENCY_NUM_FMT,
                  align: "right",
                },
              ]}
            />
          </div>
        }
      />

      <MyTable
        className=""
        persistentId="Products"
        rows={filteredProducts ?? []}
        loading={!products}
        error={productsError}
        onRowClick={(row) => navigate(`/products/${row.id}`)}
        columns={[
          {
            label: uiText("Nummer"),
            render: (row) => row.customId.toString(),
            sortKey: (row) => row.customId,
          },
          {
            label: uiText("Bezeichnung"),
            render: (row) => row.name,
            sortKey: (row) => row.name.toLowerCase(),
          },
          {
            label: uiText("Hersteller"),
            render: (row) => row.brand,
            sortKey: (row) => row.brand?.toLowerCase() ?? "",
          },
          // {
          //   label: 'Beschreibung',
          //   render: row => row.description,
          //   sortKey: row => row.description?.toLowerCase() ?? '',
          // },
        ]}
        loadMore={{}}
        renderSmallViewport={(product) => <SmallProductTile data={product} />}
      />
    </>
  );
}
