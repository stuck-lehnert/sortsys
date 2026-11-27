const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const maxBase64Bytes = 24 * 1024 * 1024;

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

/** Validate canonical, unpadded base64url without allocating decoded bytes. */
export function base64ByteLength(
  value: unknown,
  maximum = maxBase64Bytes,
): number {
  if (typeof value !== "string") throw new InvalidProtectedData();

  const bits = value.length * 6;
  const length = Math.floor(bits / 8);
  if (
    length > maximum ||
    value.length % 4 === 1 ||
    /[^A-Za-z0-9_-]/.test(value)
  ) {
    throw new InvalidProtectedData();
  }

  // Unused bits in the last digit must be zero, even when atob accepts them.
  const unusedBits = bits % 8;
  if (unusedBits > 0) {
    const lastDigit = base64urlAlphabet.indexOf(value[value.length - 1]!);
    if (lastDigit % (1 << unusedBits) !== 0) throw new InvalidProtectedData();
  }
  return length;
}

/** Check a fixed-size wire field without making a decoded copy. */
export function validateBase64Size(
  value: unknown,
  length: number,
): asserts value is string {
  if (base64ByteLength(value, length) !== length) {
    throw new InvalidProtectedData();
  }
}

export function unbase64(
  value: string,
  maximum = maxBase64Bytes,
): Uint8Array<ArrayBuffer> {
  const length = base64ByteLength(value, maximum);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = binary.charCodeAt(i);
    }
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

export function parseRevision(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new InvalidProtectedData();
  }

  const number = BigInt(value);
  if (number > 9223372036854775807n) throw new InvalidProtectedData();
  return number;
}

export function revision(value: unknown): asserts value is string {
  parseRevision(value);
}

/** A signed wire counter, with zero allowed as the empty position. */
export function parseWireCounter(value: unknown): bigint {
  return value === "0" ? 0n : parseRevision(value);
}

/** Canonical UTC microseconds in the journal and signed migration proofs. */
export function parseWireMicros(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > 19 ||
    !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value)
  ) {
    throw new InvalidProtectedData();
  }

  const micros = BigInt(value);
  if (micros < -62135596800000000n || micros > 253402300799999999n) {
    throw new InvalidProtectedData();
  }
  return micros;
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
