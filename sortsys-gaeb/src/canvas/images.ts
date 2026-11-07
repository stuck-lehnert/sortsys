import { useSyncExternalStore } from "react";
export type EmbeddedCanvasImage = {
  image: HTMLImageElement;
  width: number;
  height: number;
  ready: boolean;
  failed: boolean;
};
let revision = 0;
const listeners = new Set<() => void>();
const nodes = new WeakMap<Element, EmbeddedCanvasImage>();
const cache = new Map<string, EmbeddedCanvasImage>();
export const useImageRevision = () =>
  useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => revision,
    () => 0,
  );
export function embeddedCanvasImage(
  element: Element,
): EmbeddedCanvasImage | undefined {
  const existing = nodes.get(element);
  if (existing) return existing;
  const mime = element.getAttribute("Type")?.toLowerCase();
  if (
    !mime ||
    !/^image\/(?:jpeg|png|gif|bmp|webp)$/.test(mime) ||
    element.getAttribute("Encoding")?.toLowerCase() !== "base64"
  )
    return;
  const data = (element.textContent ?? "").replace(/\s+/g, "");
  if (!data || data.length > 14 * 1024 * 1024 || /[^A-Za-z\d+/=]/.test(data))
    return;
  const source = `data:${mime};base64,${data}`;
  let value = cache.get(source);
  if (!value) {
    const image = new Image();
    image.decoding = "async";
    value = { image, width: 378, height: 284, ready: false, failed: false };
    const resource = value;
    const changed = () => {
      revision++;
      for (const listener of listeners) listener();
    };
    image.onload = () => {
      if (image.naturalWidth * image.naturalHeight > 32_000_000) {
        resource.failed = true;
      } else {
        resource.width = image.naturalWidth;
        resource.height = image.naturalHeight;
        resource.ready = true;
      }
      changed();
    };
    image.onerror = () => {
      resource.failed = true;
      changed();
    };
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(source, value);
    image.src = source;
  }
  nodes.set(element, value);
  return value;
}
