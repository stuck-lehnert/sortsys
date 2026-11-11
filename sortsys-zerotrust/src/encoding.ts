const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class InvalidProtectedData extends Error {
  constructor() {
    super("Die geschützten Daten konnten nicht geprüft werden.");
    this.name = "InvalidProtectedData";
  }
}

export function bytes(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function utf8(value: BufferSource): string {
  return decoder.decode(value);
}

export function base64(value: BufferSource): string {
  const data = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (let i = 0; i < data.length; i += 0x4000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x4000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unbase64(value: string, maximum = 24 * 1024 * 1024): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length > Math.ceil(maximum * 4 / 3)) {
    throw new InvalidProtectedData();
  }
  try {
    const result = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    if (result.length > maximum || base64(result) !== value) throw new InvalidProtectedData();
    return result;
  } catch {
    throw new InvalidProtectedData();
  }
}

export function sized(value: string, length: number): Uint8Array<ArrayBuffer> {
  const result = unbase64(value, length);
  if (result.length !== length) throw new InvalidProtectedData();
  return result;
}

/** An unambiguous, cross-language frame; values are UTF-8 strings, never JSON numbers. */
export function frame(domain: string, values: readonly string[]): Uint8Array<ArrayBuffer> {
  const parts = [domain, ...values].map(bytes);
  const result = new Uint8Array(parts.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidProtectedData();
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new InvalidProtectedData();
  return result;
}

export function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_:.@/-]{0,191}$/.test(value)) {
    throw new InvalidProtectedData();
  }
}

export function revision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new InvalidProtectedData();
  }
}

export async function digest(value: BufferSource): Promise<string> {
  return base64(await crypto.subtle.digest("SHA-256", value));
}

export function signedPacketFrame(message: Uint8Array<ArrayBuffer>, signature: string): Uint8Array<ArrayBuffer> {
  sized(signature, 64);
  return frame("sortsys/signed-packet/v1", [base64(message), signature]);
}

export function randomSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}
