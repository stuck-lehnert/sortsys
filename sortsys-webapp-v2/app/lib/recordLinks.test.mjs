import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";

globalThis.__SORTSYS_REVISION__ ??= "ui-test";
const { client } = await import("./client");
const { regieProductTitle } = await import("./format");
const { productLink } = await import("./recordLinks");

test("product links use the readable product and retain the report designation", async () => {
  const product = {
    id: "c",
    brand: "Beispiel",
    name: "Montageschiene",
    regieReportName: " Schiene für Fensteranschluss ",
  };
  const query = spyOn(client, "query").mockImplementation(async (_, { id }) =>
    id === product.id ? [product, null] : [null, new Error("Forbidden")],
  );

  try {
    const normal = await productLink("c");
    const report = await productLink("c", regieProductTitle);
    const hidden = await productLink("d");

    assert.equal(normal.props.to, "/products/c");
    assert.equal(normal.props.children, "Beispiel Montageschiene");
    assert.equal(report.props.to, normal.props.to);
    assert.equal(report.props.children, "Schiene für Fensteranschluss");
    assert.equal(hidden, "Unbekannt");
    assert.deepEqual(query.mock.calls, ["c", "c", "d"].map((id) => [
      "products.get", { id }, { strategy: "cache-first" },
    ]));
  } finally {
    query.mockRestore();
  }
});
