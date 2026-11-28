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

test("a complete check uses one table scan and still rejects a violation in the last row", async () => {
  const driver = await duckDriver();
  const query = driver.connection.query.bind(driver.connection);
  const prepare = driver.connection.prepare.bind(driver.connection);
  const checkStatements = [];
  const isHourlyRateCheck = (sql) =>
    sql.startsWith('SELECT 1 FROM "users" source WHERE ') &&
    sql.includes("cost_per_hour");
  driver.connection.query = (sql) => {
    if (isHourlyRateCheck(sql)) checkStatements.push({ prepared: false });
    return query(sql);
  };
  driver.connection.prepare = (sql) => {
    if (isHourlyRateCheck(sql)) checkStatements.push({ prepared: true });
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
    await projectRuntimeRows(database, new Map(), original);
    expect(checkStatements).toEqual([{ prepared: false }]);
    expect(
      (await database.query("SELECT count(*) AS total FROM users")).rows[0]
        .total,
    ).toBe(260n);

    const preview = tables("users", [
      { id: "1", username: "renamed-worker", contract_type: "internal" },
    ]);
    await projectRuntimeRows(database, original, preview, { rollback: true });
    expect(
      (await database.query("SELECT username FROM users WHERE id=1")).rows,
    ).toEqual([{ username: "worker-0" }]);

    const invalid = tables(
      "users",
      values.map((value, index) =>
        index === values.length - 1 ? { ...value, cost_per_hour: -1 } : value,
      ),
    );
    await expect(projectRuntimeRows(database, original, invalid)).rejects.toThrow();
    expect(
      (await database.query("SELECT cost_per_hour FROM users WHERE id=260"))
        .rows[0].cost_per_hour,
    ).toBe(42.5);
  } finally {
    await database.close();
  }
});

test("mixed references use scoped checks even when most rows have local parents", async () => {
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
    await projectRuntimeRows(database, new Map(), original);
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
    await expect(projectRuntimeRows(database, original, invalid)).rejects.toThrow();
    expect(
      (await database.query("SELECT count(*) AS total FROM product_categories"))
        .rows[0].total,
    ).toBe(260n);
    const projectedCategories = invalid.get("product_categories");
    projectedCategories.delete("261");
    const owners = projectedCategories.get("260").owners;
    const unrelated = { model: { externalReferences: ["product_vendors"] } };
    owners.set("product_id", [{ document: external }, { document: unrelated }]);
    await expect(projectRuntimeRows(database, original, invalid)).rejects.toThrow();
    expect(
      (await database.query("SELECT count(*) AS total FROM product_categories"))
        .rows[0].total,
    ).toBe(260n);

    owners.set("product_id", [{ document: external }]);
    await projectRuntimeRows(database, original, invalid);
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
    await projectRuntimeRows(database, new Map(), partial);
    const invalid = tables("commercial_cases", [
      { id: "1", kind: "measurement", project_id: null },
    ]);
    await expect(projectRuntimeRows(database, partial, invalid)).rejects.toThrow();
    expect(
      (await database.query("SELECT kind FROM commercial_cases WHERE id=1"))
        .rows[0].kind,
    ).toBe("measurement");
  } finally {
    await database.close();
  }
});
