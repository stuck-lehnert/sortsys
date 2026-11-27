import {
  base64,
  base64ByteLength,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
  unbase64,
  validateBase64Size,
} from "./encoding";
import { hpke, sign, verify } from "./identity";
import { verifyPublicProof } from "./publicProofs";

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
  "resource-command-key",
  "project-planning-title",
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

export function boxPacketFrame(box: SealedBox): Uint8Array<ArrayBuffer> {
  return signedPacketFrame(boxFrame(box), box.signature);
}

export function sealedBox(value: unknown): SealedBox {
  const obj = record(value, keys);
  context(Object.fromEntries(contextKeys.map((key) => [key, obj[key]])));
  if (obj.format !== "sortsys-hpke-v1") throw new InvalidProtectedData();
  validateBase64Size(obj.enc, 32);
  validateBase64Size(obj.signature, 64);
  if (base64ByteLength(obj.ciphertext, MAX_BYTES + 16) < 16)
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

  const aad = info(ctx);
  const sealed = await hpke.seal(
    { recipientPublicKey: recipient, info: aad },
    plaintext,
    aad,
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

    // A fresh area grant can return the same signed ciphertext again. Only
    // share its public signature check; HPKE still uses this call's recipient.
    const verifySignature =
      box.purpose === "area-key" ? verifyPublicProof : verify;
    await verifySignature(author, box.signature, boxFrame(box));

    const aad = info(ctx);
    return new Uint8Array(
      await hpke.open(
        { recipientKey: recipient, enc: sized(box.enc, 32), info: aad },
        unbase64(box.ciphertext, MAX_BYTES + 16),
        aad,
      ),
    );
  } catch {
    throw new InvalidProtectedData();
  }
}
