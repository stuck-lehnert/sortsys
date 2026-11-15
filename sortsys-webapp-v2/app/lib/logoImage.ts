import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import {
  LOGO_TYPES,
  MAX_LOGO_BYTES,
  MAX_LOGO_INPUT_BYTES,
} from "./data/logoData";
import { validatePrintAssetBytes } from "./data/printAssetBytes";

export type PreparedLogo = {
  blob: Blob;
  width: number;
  height: number;
  fileName: string;
};

/** Decode local raster bytes only. Canvas removes metadata, applies camera
 * orientation and preserves transparency; no original image enters a job queue. */
export async function prepareLogoImage(
  file: File,
  signal: AbortSignal,
): Promise<PreparedLogo> {
  signal.throwIfAborted();
  if (
    !(file instanceof Blob) ||
    typeof file.name !== "string" ||
    !file.size ||
    file.size > MAX_LOGO_INPUT_BYTES
  )
    throw new InvalidProtectedData();
  let mime = file.type.toLowerCase();
  if (mime === "image/jpg") mime = "image/jpeg";
  if (!mime) {
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    if (extension === "png") mime = "image/png";
    else if (extension === "jpg" || extension === "jpeg") mime = "image/jpeg";
    else if (extension === "webp") mime = "image/webp";
  }
  if (!(LOGO_TYPES as readonly string[]).includes(mime))
    throw new InvalidProtectedData();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    validatePrintAssetBytes(mime, bytes);
  } finally {
    bytes.fill(0);
  }
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    signal.throwIfAborted();
    const pixels = bitmap.width * bitmap.height;
    if (!pixels || pixels > 64_000_000) throw new InvalidProtectedData();
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    let blob: Blob;
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new InvalidProtectedData();
        context.drawImage(bitmap, 0, 0, width, height);
        blob = await canvas.convertToBlob({ type: "image/png" });
      } finally {
        canvas.width = canvas.height = 1;
      }
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new InvalidProtectedData();
        context.drawImage(bitmap, 0, 0, width, height);
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((value) => {
            if (value) resolve(value);
            else reject(new InvalidProtectedData());
          }, "image/png"),
        );
      } finally {
        canvas.width = canvas.height = 1;
      }
    }
    signal.throwIfAborted();
    if (!blob.size || blob.size > MAX_LOGO_BYTES || blob.type !== "image/png")
      throw new InvalidProtectedData();
    const stem =
      file.name
        .replace(/\.[^.]*$/, "")
        .replace(/[\0\r\n/\\]/g, "_")
        .trim()
        .slice(0, 60) || "Logo";
    return { blob, width, height, fileName: stem + ".png" };
  } finally {
    bitmap.close();
  }
}
