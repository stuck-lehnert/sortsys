const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let part = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    part += ALPHABET[(value >>> 18) & 63];
    part += ALPHABET[(value >>> 12) & 63];
    part += second === undefined ? "=" : ALPHABET[(value >>> 6) & 63];
    part += third === undefined ? "=" : ALPHABET[value & 63];

    if (part.length >= 8192) {
      parts.push(part);
      part = "";
    }
  }

  parts.push(part);

  return parts.join("");
}
