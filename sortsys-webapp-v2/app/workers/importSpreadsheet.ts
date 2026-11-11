import { importSpreadsheetText } from "../lib/importSpreadsheet";

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  const bytes = new Uint8Array(event.data);
  try { self.postMessage({ text: await importSpreadsheetText(event.data) }); }
  catch { self.postMessage({ error: "invalid-spreadsheet" }); }
  finally { bytes.fill(0); }
};
