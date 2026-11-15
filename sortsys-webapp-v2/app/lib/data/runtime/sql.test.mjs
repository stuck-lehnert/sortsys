import { expect, test } from "bun:test";
import { createBusinessDatabase } from "../database";
import { duckDriver } from "../testing/duckDriver.mjs";
import { projectRuntimeRows } from "./sql";

function tables(name, values) {
  return new Map([
    [
      name,
      new Map(
        values.map((value, index) => [
          String(index),
          {
            table: name,
            key: String(index),
            values: value,
            owners: new Map(),
          },
        ]),
      ),
    ],
  ]);
}

test("many rows keep their checks while using a bounded number of database requests", async () => {
  const driver = await duckDriver();
  const prepare = driver.connection.prepare.bind(driver.connection);
  let prepared = 0;
  driver.connection.prepare = (sql) => {
    prepared++;
    return prepare(sql);
  };
  const database = await createBusinessDatabase(driver, true);
  const values = Array.from({ length: 260 }, (_, index) => ({
    id: String(index + 1),
    username: `worker-${index}`,
    contract_type: "internal",
    cost_per_hour: 42.5,
  }));
  const original = tables("users", values);
  try {
    prepared = 0;
    await projectRuntimeRows(database, new Map(), original, []);
    expect(prepared).toBeLessThan(40);
    expect(
      (await database.query("SELECT count(*) AS total FROM users")).rows[0]
        .total,
    ).toBe(260n);
    const invalid = tables(
      "users",
      values.map((value, index) =>
        index === values.length - 1 ? { ...value, cost_per_hour: -1 } : value,
      ),
    );
    await expect(
      projectRuntimeRows(database, original, invalid, []),
    ).rejects.toThrow();
    expect(
      (await database.query("SELECT cost_per_hour FROM users WHERE id=260"))
        .rows[0].cost_per_hour,
    ).toBe(42.5);
  } finally {
    await database.close();
  }
});

test("composite keys and late missing references fail atomically without hiding non-external rows", async () => {
  const database = await createBusinessDatabase(await duckDriver(), true);
  const categories = Array.from({ length: 260 }, (_, index) => ({
    product_id: "1",
    category: `Gruppe ${index}`,
  }));
  const original = tables("products", [{ id: "1" }]);
  original.set(
    "product_categories",
    tables("product_categories", categories).get("product_categories"),
  );
  try {
    await projectRuntimeRows(database, new Map(), original, []);
    const invalid = tables("products", [{ id: "1" }]);
    invalid.set(
      "product_categories",
      tables("product_categories", [
        ...categories,
        { product_id: "2", category: "Extern" },
        { product_id: "3", category: "Fehlend" },
      ]).get("product_categories"),
    );
    const external = { model: { externalReferences: ["products"] } };
    invalid
      .get("product_categories")
      .get("260")
      .owners.set("product_id", [{ document: external }]);
    await expect(
      projectRuntimeRows(database, original, invalid, [external]),
    ).rejects.toThrow();
    expect(
      (await database.query("SELECT count(*) AS total FROM product_categories"))
        .rows[0].total,
    ).toBe(260n);
    invalid.get("product_categories").delete("261");
    await projectRuntimeRows(database, original, invalid, [external]);
    expect(
      (await database.query("SELECT count(*) AS total FROM product_categories"))
        .rows[0].total,
    ).toBe(261n);
  } finally {
    await database.close();
  }
});

test("an unavailable private field remains distinct from a supplied NULL in cross-field checks", async () => {
  const database = await createBusinessDatabase(await duckDriver(), true);
  const partial = tables("commercial_cases", [
    { id: "1", kind: "measurement" },
  ]);
  try {
    await projectRuntimeRows(database, new Map(), partial, []);
    const invalid = tables("commercial_cases", [
      { id: "1", kind: "measurement", project_id: null },
    ]);
    await expect(
      projectRuntimeRows(database, partial, invalid, []),
    ).rejects.toThrow();
    expect(
      (await database.query("SELECT kind FROM commercial_cases WHERE id=1"))
        .rows[0].kind,
    ).toBe("measurement");
  } finally {
    await database.close();
  }
});
