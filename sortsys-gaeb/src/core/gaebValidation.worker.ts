import type { GaebSchemaIdentity } from "./types";

const raw = import.meta.glob("../../vendor/gaeb/**/*.xsd", {
  query: "?raw",
  import: "default",
  eager: true,
});
const schemas = Object.fromEntries(
  Object.entries(raw).map(([path, text]) => [
    path.split("/vendor/gaeb/")[1]!,
    text as string,
  ]),
);

self.onmessage = async (
  event: MessageEvent<{ source: string; identity: GaebSchemaIdentity }>,
) => {
  try {
    // Register the handler before loading the WASM module: its top-level await
    // otherwise lets early worker messages arrive before onmessage exists.
    const { validateGaebXml } = await import("./validation");
    self.postMessage(
      validateGaebXml(event.data.source, event.data.identity, schemas),
    );
  } catch {
    self.postMessage({
      valid: false,
      schema: "",
      issues: [{ message: "validation-failed" }],
    });
  }
};
