export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export function emailContentId(value: string): string {
  try { value = decodeURIComponent(value); } catch { /* Some senders leave literal percent signs. */ }
  return value.trim().replace(/^<|>$/g, "").toLowerCase();
}

export function rasterImageType(content: ArrayBuffer): string | null {
  const data = new Uint8Array(content);
  const starts = (...signature: number[]) => signature.every((value, index) => data[index] === value);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  if (starts(71, 73, 70, 56) && (data[4] === 55 || data[4] === 57) && data[5] === 97) return "image/gif";
  if (starts(82, 73, 70, 70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "image/webp";
  return null;
}

// Only self-contained raster bytes may become an image source, never SVG or HTML.
export function safeEmailImageData(value: string): string | null {
  if (value.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 64) return null;
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    if (binary.length > MAX_INLINE_IMAGE_BYTES) return null;
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return rasterImageType(bytes.buffer) === match[1].toLowerCase()
      ? `data:${match[1].toLowerCase()};base64,${match[2]}` : null;
  } catch { return null; }
}
