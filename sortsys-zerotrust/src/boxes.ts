import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  sized,
  unbase64,
} from "./encoding";
import { hpke, sign, verify } from "./identity";

export const BOX_PURPOSES = [
  "area-key",
  "object-key",
  "authority-key",
  "recovery-catalog",
  "validation-request",
  "validation-result",
  "search-request",
  "search-result",
  "live-llm-context",
] as const;
export type BoxContext = {
  tenant: string;
  purpose: (typeof BOX_PURPOSES)[number];
  object: string;
  generation: string;
  recipient: string;
  author: string;
};
export type SealedBox = BoxContext & {
  format: "sortsys-hpke-v1";
  enc: string;
  ciphertext: string;
  signature: string;
};
const contextKeys = [
  "tenant",
  "purpose",
  "object",
  "generation",
  "recipient",
  "author",
] as const;
const keys = [...contextKeys, "format", "enc", "ciphertext", "signature"];
const MAX_BYTES = 32 * 1024 * 1024;

function context(value: unknown): BoxContext {
  const obj = record(value, contextKeys);
  for (const name of ["tenant", "object", "recipient", "author"] as const)
    identifier(obj[name]);
  revision(obj.generation);
  if (!BOX_PURPOSES.includes(obj.purpose as BoxContext["purpose"]))
    throw new InvalidProtectedData();
  return { ...obj } as BoxContext;
}

function info(value: BoxContext): Uint8Array<ArrayBuffer> {
  return frame(
    "sortsys/hpke-context/v1",
    contextKeys.map((key) => value[key]),
  );
}

export function boxFrame(value: SealedBox): Uint8Array<ArrayBuffer> {
  return frame("sortsys/hpke/v1", [
    ...contextKeys.map((key) => value[key]),
    value.format,
    value.enc,
    value.ciphertext,
  ]);
}

export function sealedBox(value: unknown): SealedBox {
  const obj = record(value, keys);
  context(Object.fromEntries(contextKeys.map((key) => [key, obj[key]])));
  if (obj.format !== "sortsys-hpke-v1") throw new InvalidProtectedData();
  for (const name of ["enc", "ciphertext", "signature"] as const) {
    if (typeof obj[name] !== "string") throw new InvalidProtectedData();
  }
  sized(obj.enc as string, 32);
  sized(obj.signature as string, 64);
  if (unbase64(obj.ciphertext as string, MAX_BYTES + 16).length < 16)
    throw new InvalidProtectedData();
  return { ...obj } as SealedBox;
}

export async function sealBox(
  expected: BoxContext,
  plaintext: Uint8Array<ArrayBuffer>,
  recipient: CryptoKey,
  author: CryptoKey,
): Promise<SealedBox> {
  const ctx = context(expected);
  if (plaintext.length > MAX_BYTES) throw new InvalidProtectedData();
  const sealed = await hpke.seal(
    { recipientPublicKey: recipient, info: info(ctx) },
    plaintext,
    info(ctx),
  );
  const result: SealedBox = {
    ...ctx,
    format: "sortsys-hpke-v1",
    enc: base64(sealed.enc),
    ciphertext: base64(sealed.ct),
    signature: "",
  };
  result.signature = await sign(author, boxFrame(result));
  return result;
}

export async function openBox(
  input: unknown,
  expected: BoxContext,
  recipient: CryptoKey,
  author: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const box = sealedBox(input);
    const ctx = context(expected);
    if (contextKeys.some((key) => box[key] !== ctx[key]))
      throw new InvalidProtectedData();
    await verify(author, box.signature, boxFrame(box));
    return new Uint8Array(
      await hpke.open(
        { recipientKey: recipient, enc: sized(box.enc, 32), info: info(ctx) },
        unbase64(box.ciphertext, MAX_BYTES + 16),
        info(ctx),
      ),
    );
  } catch {
    throw new InvalidProtectedData();
  }
}
