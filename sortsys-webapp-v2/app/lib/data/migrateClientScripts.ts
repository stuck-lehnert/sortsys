import type { Client } from "@sortsys/v2-client";
import type { BusinessDatabase } from "./database";
import type { BusinessRow } from "./rowCodec";
import {
  CLIENT_SCRIPT_COLLECTION,
  clientScriptObject,
  clientScriptPayload,
} from "./clientScriptData";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { readBusinessRows } from "./products";

export async function copyClientScripts(
  client: Client,
  rows: readonly BusinessRow[],
  signal: AbortSignal,
) {
  const entries = rows.map((row) => {
    const id = clientScriptObject(row.values.id);
    return {
      id,
      value: clientScriptPayload(
        { format: "sortsys-client-script-v1", row },
        id,
      ),
    };
  });
  await copyProtectedCollection(
    client,
    CLIENT_SCRIPT_COLLECTION,
    entries,
    clientScriptPayload,
    signal,
  );
}

export async function prepareClientScripts(
  client: Client,
  source: BusinessDatabase,
  owner: string,
  signal: AbortSignal,
) {
  const rows = await readBusinessRows(source, "client_scripts");
  signal.throwIfAborted();
  await prepareOwnerCollections(
    client,
    owner,
    [CLIENT_SCRIPT_COLLECTION],
    signal,
  );
  await copyClientScripts(client, rows, signal);
}
