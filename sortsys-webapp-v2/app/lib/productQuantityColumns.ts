import type { Client } from "@sortsys/v2-client";
import type { MyTableColumn } from "~/components/MyTable";
import type { Product } from "~/type-helpers";
import { formatBaseQuantity, formatNumber, formatProductAmount } from "./format";
import { uiText } from "./i18n";
import { upmatchUnit } from "./utils";

type QuantityRow = { productId: string; quantity: number; unit?: string | null };

export function productQuantityColumns(
  client: Pick<Client, "query">,
  displayQuantity: (product: Product, row: QuantityRow) => [number, string] =
    (product, row) => upmatchUnit(product, row.quantity),
): MyTableColumn<QuantityRow>[] {
  function render(kind: "display" | "base") {
    return async (row: QuantityRow) => {
      const [product] = await client.query(
        "products.get",
        { id: row.productId },
        { strategy: "cache-first" },
      );

      if (!product) {
        const amount = formatNumber(row.quantity);
        return kind === "base" ? amount : `${amount} ???`;
      }

      const [amount, unit] = displayQuantity(product, row);
      return kind === "base"
        ? formatBaseQuantity(row.quantity, product.baseUnit, unit)
        : formatProductAmount(amount, unit);
    };
  }

  return [
    { label: uiText("Menge"), render: render("display") },
    { label: uiText("Basismenge"), render: render("base") },
  ];
}
