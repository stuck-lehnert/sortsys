import { createRequire } from "node:module";

const require = createRequire(import.meta.url),
  duckdb = require("@duckdb/duckdb-wasm/blocking");
/** Same in-memory engine for model, transaction and business-facade tests. */
export async function duckDriver() {
  const engine = await duckdb.createDuckDB(
    {
      mvp: {
        mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm"),
      },
      eh: {
        mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"),
      },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await engine.instantiate();
  engine.open({
    path: ":memory:",
    allowUnsignedExtensions: false,
    arrowLosslessConversion: false,
    query: {
      castBigIntToDouble: false,
      castDecimalToDouble: false,
      castTimestampToDate: true,
    },
  });
  const connection = engine.connect();
  return { connection, close: () => connection.close() };
}
