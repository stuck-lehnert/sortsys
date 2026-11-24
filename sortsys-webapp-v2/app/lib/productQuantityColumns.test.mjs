import { expect, test } from "bun:test";
import { formatNumber } from "./format";
import { productQuantityColumns } from "./productQuantityColumns";

const row = { productId: "34", quantity: 12, unit: "Stk" };
const product = { baseUnit: "Stk", otherUnits: { Paket: 12 } };

function clientWith(result) {
  return {
    async query(path, input, options) {
      expect(path).toBe("products.get");
      expect(input).toEqual({ id: row.productId });
      expect(options).toEqual({ strategy: "cache-first" });
      return [result, null];
    },
  };
}

test("matched quantities show the packaging and the quantity in base units", async () => {
  const [display, base] = productQuantityColumns(clientWith(product));

  expect(await display.render(row)).toBe(`${formatNumber(1)} Paket`);
  expect(await base.render(row)).toBe(`${formatNumber(12)} Stk`);
});

test("a recorded base unit does not display a redundant base quantity", async () => {
  const [display, base] = productQuantityColumns(
    clientWith(product),
    (_product, row) => [row.quantity, row.unit],
  );

  expect(await display.render(row)).toBe(`${formatNumber(12)} Stk`);
  expect(await base.render(row)).toBe("-");
});

test("quantities remain visible without inventing a unit for an unreadable product", async () => {
  const [display, base] = productQuantityColumns(clientWith(null));

  expect(await display.render(row)).toBe(`${formatNumber(12)} ???`);
  expect(await base.render(row)).toBe(formatNumber(12));
});
