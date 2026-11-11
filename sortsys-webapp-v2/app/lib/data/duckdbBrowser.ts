import * as duckdb from "@duckdb/duckdb-wasm";
import mvpModule from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import ehModule from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import type { DuckDriver } from "./database";

export async function createDuckDriver(): Promise<DuckDriver> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpModule, mainWorker: mvpWorker },
    eh: { mainModule: ehModule, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.open({
      path: ":memory:", allowUnsignedExtensions: false, arrowLosslessConversion: false,
      query: { castBigIntToDouble: false, castDecimalToDouble: false, castTimestampToDate: true },
    });
    const connection = await db.connect();
    return { connection, close: async () => { await connection.close(); await db.terminate(); worker.terminate(); } };
  } catch (error) { await db.terminate(); worker.terminate(); throw error; }
}
