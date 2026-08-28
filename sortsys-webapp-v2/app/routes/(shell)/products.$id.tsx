import { uiText } from "~/lib/i18n";
import { useParams } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { formatCurrency, formatDate, formatNumber, productTitle } from "~/lib/format";
import { MyDivider } from "~/components/MyDivider";
import { AttrList } from "~/components/AttrList";
import { Fragment, lazy, Suspense, useMemo } from "react";
import { MyExpandable } from "~/components/MyExpandable";
import { MyDropdown } from "~/components/MyDropdown";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { Icons } from "~/lib/icons";
import { showCreateProductPriceRecordModal, showDeleteProductModal, showModifyProductModal, showSetProductCategoriesModal } from "~/modals/products";
import { useMyModals } from "~/hooks/useMyModals";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { MyTable } from "~/components/MyTable";
import { MyLink } from "~/components/MyLink";
import { ProductPriceRecordTile } from "~/lib/tiles";
import { Tag } from "@sortsys/react-components";

const ProductPriceChart = lazy(() => import("~/components/ProductPriceChart"));

export default function ProductDetailPage() {
    const { id } = useParams();

    const modals = useMyModals();

    const sessionInfo = useSessionInfo();

    const [product, err] = useClientStream(() => client.streamQuery('products.get', { id: id! }), [id]);
    const [priceRecords] = useClientStream(() => client.streamQuery('products.priceRecords.list', { productId: id! }), [id]);

    useTitle(() => product ? productTitle(product) : null, [product]);

    const sortedPriceRecords = useMemo(() => {
        return priceRecords?.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }, [priceRecords]);

    const latestPriceRecord = sortedPriceRecords?.[0];

    const otherUnitsOverview = useMemo(() => {
        const otherUnits = product?.otherUnits ?? {};

        const overview: Record<string, [number, string][]> = {};
        if (!product || !Object.entries(otherUnits).length) return null;

        Object.entries(otherUnits)
            .sort((a, b) => a[1] - b[1])
            .forEach(([unit, inBaseUnits]) => {
                overview[unit] = [[inBaseUnits, product.baseUnit]];
                Object.entries(otherUnits).forEach(([oUnit, oInBaseUnits]) => {
                    if (unit === oUnit || oInBaseUnits > inBaseUnits) return;

                    if (inBaseUnits % oInBaseUnits === 0) {
                        overview[unit].push([Math.round(inBaseUnits / oInBaseUnits), oUnit]);
                    }
                });
            });

        return overview;
    }, [product?.baseUnit, product?.otherUnits]);

    useShortcut('Control+e', e => {
        if (!product || !sessionInfo.canDo('manage:products')) return;
        e.preventDefault();
        showModifyProductModal(modals, product);
    });

    if (err) return <NotFound reason="resourceNotFound" />;
    if (!product) return;

    return <>
        <MyHeader
            title={productTitle(product)}
            actions={<>
                <MyDropdown items={[
                    {
                        label: uiText("Preis verzeichnen"),
                        renderIcon: Icons.PriceRecord,
                        hideIf: !sessionInfo.canDo('manage:productPriceRecords'),
                        onClick: () => showCreateProductPriceRecordModal(modals, product),
                    },
                    {
                        label: uiText("Kategorien bearbeiten"),
                        renderIcon: Icons.Edit,
                        hideIf: !sessionInfo.canDo('manage:products'),
                        onClick: () => showSetProductCategoriesModal(modals, product),
                    },
                    {
                        label: uiText("Bearbeiten"),
                        renderIcon: Icons.Edit,
                        hideIf: !sessionInfo.canDo('manage:products'),
                        onClick: () => showModifyProductModal(modals, product),
                    },
                    {
                        label: uiText("Löschen"),
                        renderIcon: Icons.Delete,
                        hideIf: !sessionInfo.canDo('delete:products'),
                        onClick: () => showDeleteProductModal(modals, product),
                    },
                ]} />
            </>}
        />

        {!!product.categories.length && <div className="flex flex-wrap gap-2 items-center py-1">
            {product.categories.map(category => (
                <Tag key={category} size="md" type="outline">{category}</Tag>
            ))}
        </div>}

        <MyDivider />

        <AttrList>
            <AttrList.Attr name={uiText("Nummer")} value={product.customId} />
            <AttrList.Attr name="Bezeichnung" value={product.name} />
            {!!product.brand && <AttrList.Attr name="Hersteller" value={product.brand} />}
            {!!product.description && <AttrList.Attr name={uiText("Beschreibung")} value={product.description} />}
            <AttrList.Attr name="Basiseinheit" value={product.baseUnit} />
            {!!latestPriceRecord && <AttrList.Attr name="Letzer EK-Preis" value={`${formatCurrency(latestPriceRecord.price)} / ${product.baseUnit}`} />}
        </AttrList>

        <MyDivider />

        {!!otherUnitsOverview && <MyExpandable title={uiText("Andere Einheiten")} initiallyExpanded>
            <AttrList>
                {Object.entries(otherUnitsOverview).map(([unit, others]) => {
                    return <AttrList.Attr key={unit}
                        name={unit}
                        value={[...others.sort((a, b) => a[0] - b[0])].map(([value, unit], i) => {
                            return <Fragment key={i.toString() + ':' + unit}>{formatNumber(value)} {unit}<br /></Fragment>;
                        })}
                    />;
                })}
            </AttrList>
        </MyExpandable>}

        {!!sortedPriceRecords?.length && <MyExpandable title={uiText("Preisentwicklung")}>
            {sortedPriceRecords.length >= 2 && <>
                <Suspense fallback={<div style={{ height: 150 }} />}>
                    <ProductPriceChart records={sortedPriceRecords} baseUnit={product.baseUnit} />
                </Suspense>

                <div style={{ height: '2rem' }} />
            </>}
            

            <MyTable
                rows={sortedPriceRecords}
                pagination={{}}
                className="th-20rem"
                columns={[
                    {
                        label: uiText("Datum"),
                        render: row => formatDate(row.timestamp),
                        sortKey: (tracking) => tracking.timestamp?.getTime() ?? Number.MAX_SAFE_INTEGER,
                    },
                    {
                        label: uiText("Preis"),
                        render: row => `${formatCurrency(row.price)} / ${product.baseUnit}`,
                        sortKey: row => row.price,
                    },
                    {
                        label: uiText("Händler"),
                        render: async (row) => {
                            if (!row.vendorId) return;
            
                            const [vendor] = await client.query('products.vendors.get', { id: row.vendorId }, { strategy: 'cache-first' });
                            if (!vendor) return uiText('Unbekannter Händler', 'Unknown vendor');
                            return <MyLink to={`/products/vendors/${vendor.id}`}>{vendor.name}</MyLink>;
                        },
                    },
                ]}
                renderSmallViewport={priceRecord => <ProductPriceRecordTile priceRecord={priceRecord} omit={['product']} />}
            />

        </MyExpandable>}
    </>;
}
