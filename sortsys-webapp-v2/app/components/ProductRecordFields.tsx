import { MyButton } from "~/components/MyButton";
import { MyForm, type MyMultiSelectCreateAction } from "~/components/MyForm";
import { client } from "~/lib/client";
import { productTitle } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";
import { SmallProductTile } from "~/lib/tiles";
import type { Product } from "~/type-helpers";

type ProductRecordFieldsProps = {
  prefix: string;
  focusProduct: boolean;
  productHidden?: boolean;
  createProduct?: MyMultiSelectCreateAction<Product>;
  onProductChange: () => void;
  onRemove: () => void;
};

export function ProductRecordFields({
  prefix,
  focusProduct,
  productHidden,
  createProduct,
  onProductChange,
  onRemove,
}: ProductRecordFieldsProps) {
  const context = MyForm.$useContext();
  const productName = `${prefix}product`;
  const currentProduct = () =>
    context.field<Product[]>(productName)?.getValue()?.[0];

  return (
    <>
      {productHidden ? (
        <p>
          {uiText("Produkt")}: {uiText("Nicht freigegeben", "Not shared")}
        </p>
      ) : (
        <MyForm.MultiSelect
          name={productName}
          labelText={uiText("Produkt")}
          focusOnMount={focusProduct}
          minSelectedItems={1}
          maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const [data, error] = await client.query("products.list", {
              search: query,
            });
            if (error) throw error;

            return data ?? [];
          }}
          renderItem={({ item }) => `${item.customId} ${productTitle(item)}`}
          renderTile={(item) => <SmallProductTile data={item} noLink />}
          createAction={createProduct}
          onValueChange={onProductChange}
        />
      )}

      <div className="flex gap-2 items-end">
        <div className="grow flex gap-2">
          <div className="min-w-0 basis-1/2 flex-1">
            <MyForm.Input
              required
              name={`${prefix}amount`}
              labelText={uiText("Anzahl")}
              type="number"
              rules={[MyForm.Input.rules.num]}
            />
          </div>

          <div className="min-w-0 basis-1/2 flex-1">
            <MyForm.Select
              name={`${prefix}unit`}
              labelText={uiText("Einheit")}
              getOptions={() => {
                const product = currentProduct();
                if (!product) return [];

                return [product.baseUnit, ...Object.keys(product.otherUnits)].map(
                  (id) => ({ id }),
                );
              }}
              getOptionsDeps={[currentProduct()?.id]}
              buildOption={({ id }) => ({ text: id, value: id })}
              suffix={
                <MyButton
                  kind="ghost"
                  size="sm"
                  className="ss-input-suffix-btn"
                  title={uiText("Eintrag entfernen")}
                  aria-label={uiText("Eintrag entfernen")}
                  onClick={onRemove}
                >
                  <Icons.Delete />
                </MyButton>
              }
            />
          </div>
        </div>
      </div>
    </>
  );
}
