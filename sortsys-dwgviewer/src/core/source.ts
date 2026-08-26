import type { PlanSource } from "../types.ts";

export async function loadSourceBytes(source: PlanSource): Promise<ArrayBuffer> {
  if (source.kind === "arrayBuffer") {
    if (source.data instanceof Uint8Array) {
      const copy = new Uint8Array(source.data.byteLength);
      copy.set(source.data);
      return copy.buffer as ArrayBuffer;
    }
    return source.data.slice(0);
  }

  if (source.kind === "blob") {
    return source.blob.arrayBuffer();
  }

  const response = await fetch(source.url, {
    headers: source.headers,
  });
  if (!response.ok) {
    throw new Error(`Failed to load plan source (${response.status})`);
  }
  return response.arrayBuffer();
}

export function sourceLabel(source: PlanSource) {
  if (source.kind === "url") return source.url.split("/").pop() || source.url;
  if (source.kind === "blob") return (source.blob as File).name || "Blob";
  return "ArrayBuffer";
}
