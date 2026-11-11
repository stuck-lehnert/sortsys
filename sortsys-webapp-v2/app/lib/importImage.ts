import { InvalidProtectedData } from "@sortsys/zerotrust";

/** Resolve camera orientation in the browser and send upright pixels. Model
 * image decoders must not depend on interpreting the camera's EXIF metadata. */
export async function prepareImportImage(file: File, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    signal.throwIfAborted();
    const pixels = bitmap.width * bitmap.height;
    if (!pixels || pixels > 64_000_000) throw new InvalidProtectedData();
    const scale = Math.min(1, Math.sqrt(32_000_000 / pixels));
    const width = Math.max(1, Math.floor(bitmap.width * scale)), height = Math.max(1, Math.floor(bitmap.height * scale));
    let encoded: Blob;
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
      if (!context) throw new InvalidProtectedData();
      context.drawImage(bitmap, 0, 0, width, height);
      encoded = await canvas.convertToBlob({ type: "image/jpeg", quality: .96 });
      canvas.width = canvas.height = 1;
    } else {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); if (!context) throw new InvalidProtectedData();
      context.drawImage(bitmap, 0, 0, width, height);
      encoded = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new InvalidProtectedData()), "image/jpeg", .96));
      canvas.width = canvas.height = 1;
    }
    signal.throwIfAborted();
    if (!encoded.size || encoded.size > 20 * 1024 * 1024) throw new InvalidProtectedData();
    return encoded;
  } finally { bitmap.close(); }
}
