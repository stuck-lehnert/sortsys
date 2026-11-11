import type { GaebXmlFragment, GaebXmlLayout, GaebXmlPartition, GaebPrivateFacet } from "./privacy";
import type { GaebSchemaIdentity, GaebValidation } from "./types";
import { validateGaebInBrowser } from "./validationClient";
import type { PositionText } from "./positionExtract";

export type GaebXmlProcessor = {
  positions(source: string, signal: AbortSignal): Promise<PositionText[]>;
  partition(source: string, kind: string, signal: AbortSignal): Promise<GaebXmlPartition>;
  render(layout: GaebXmlLayout, fragments: Map<GaebPrivateFacet, GaebXmlFragment[]>, signal: AbortSignal): Promise<{ xml: string; complete: boolean; missing: GaebPrivateFacet[] }>;
  validate(source: string, identity: GaebSchemaIdentity, signal: AbortSignal): Promise<GaebValidation>;
};
function operation<T>(message: unknown, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./privacy.worker.ts", import.meta.url), { type: "module" });
    const dispose = () => { clearTimeout(timeout); worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { dispose(); reject(new DOMException("Aborted", "AbortError")); };
    const timeout = setTimeout(() => { dispose(); reject(new Error("document-processing-timeout")); }, 40000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => { dispose(); event.data?.ok === true ? resolve(event.data.value as T) : reject(new Error("invalid-gaeb-partition")); };
    worker.onerror = () => { dispose(); reject(new Error("document-processing-failed")); };
    worker.postMessage(message);
  });
}
export const browserGaebXml: GaebXmlProcessor = {
  positions: (source, signal) => operation({ type: "positions", source }, signal),
  partition: (source, kind, signal) => operation({ type: "partition", source, kind }, signal),
  render: (layout, fragments, signal) => operation({ type: "render", layout, fragments }, signal),
  validate: validateGaebInBrowser,
};
