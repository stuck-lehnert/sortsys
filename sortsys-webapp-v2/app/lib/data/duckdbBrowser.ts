import * as duckdb from "@duckdb/duckdb-wasm";
import mvpModule from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import ehModule from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import type { DuckDriver } from "./database";
import { uiText } from "../i18n";

export async function createDuckDriver(): Promise<DuckDriver> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpModule, mainWorker: mvpWorker },
    eh: { mainModule: ehModule, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const startup = new AbortController();
  // DuckDB clears pending requests on a worker error without rejecting them.
  const failed = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(
        new Error(
          uiText(
            "Die lokale Datenbank konnte nicht gestartet werden.",
            "The local database could not be started.",
          ),
        ),
      );
    const options = { once: true, signal: startup.signal };
    worker.addEventListener("error", fail, options);
    worker.addEventListener("messageerror", fail, options);
  });
  try {
    const connect = async () => {
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      await db.open({
        path: ":memory:",
        allowUnsignedExtensions: false,
        arrowLosslessConversion: false,
        query: {
          castBigIntToDouble: false,
          castDecimalToDouble: false,
          castTimestampToDate: true,
        },
      });
      return db.connect();
    };
    const connection = await Promise.race([connect(), failed]);
    return {
      connection,
      async close() {
        try {
          await connection.close();
        } finally {
          await db.terminate();
        }
      },
    };
  } catch (error) {
    await db.terminate();
    throw error;
  } finally {
    startup.abort();
  }
}
