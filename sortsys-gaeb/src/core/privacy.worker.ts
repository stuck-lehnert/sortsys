import type { GaebXmlFragment, GaebXmlLayout, GaebPrivateFacet } from "./privacy";

self.onmessage = async (event: MessageEvent<{ type: string; source: string; kind: string; layout: GaebXmlLayout; fragments: Map<GaebPrivateFacet, GaebXmlFragment[]> }>) => {
  try {
    const { partitionGaebXml, renderGaebXml } = await import("./privacy");
    const data = event.data;
    if (data.type === "positions") {
      const { extractPositionText } = await import("./positionExtract");
      self.postMessage({ ok: true, value: extractPositionText(data.source) }); return;
    }
    if (data.type !== "partition" && data.type !== "render") throw new Error("invalid-operation");
    self.postMessage({ ok: true, value: data.type === "partition" ? partitionGaebXml(data.source, data.kind) : renderGaebXml(data.layout, data.fragments) });
  } catch { self.postMessage({ ok: false }); }
};
