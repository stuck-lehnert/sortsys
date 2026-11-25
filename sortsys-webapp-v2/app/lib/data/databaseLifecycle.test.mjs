import { expect, test } from "bun:test";
import { BusinessDatabase } from "./database";

test("close drains already queued work even after a transaction rolls back", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const failure = new Error("transaction failed");
  const calls = [];
  const db = new BusinessDatabase({
    connection: {
      query(sql) {
        calls.push(sql);
        return { schema: { fields: [] }, toArray: () => [] };
      },
      prepare() {
        throw new Error("unexpected prepared statement");
      },
    },
    close() {
      calls.push("close");
    },
  });

  const transaction = db
    .transaction(async () => {
      started.resolve();
      await release.promise;
      throw failure;
    })
    .catch((error) => error);
  const queued = db.query("SELECT 1");
  const closing = db.close();
  const tooLate = db.query("SELECT 2").catch((error) => error);

  try {
    await started.promise;
    expect(calls).toEqual(["BEGIN TRANSACTION"]);
  } finally {
    release.resolve();
    await closing;
  }

  expect(await transaction).toBe(failure);
  expect(await queued).toEqual({ rows: [] });
  expect(await tooLate).toMatchObject({ message: "Database is closed" });
  expect(calls).toEqual(["BEGIN TRANSACTION", "ROLLBACK", "SELECT 1", "close"]);
});
