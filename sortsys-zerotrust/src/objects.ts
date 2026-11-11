import { base64, frame, identifier, InvalidProtectedData, randomSecret, record, revision, sized, unbase64 } from "./encoding";
import { sign, verify } from "./identity";

export const FACETS = ["scope", "contract-quantities", "measurement", "offer-prices", "calculation", "procurement", "billing", "master-data", "personnel", "attachment"] as const;
export type Facet = typeof FACETS[number];

export type ObjectContext = {
  tenant: string;
  scope: string;
  facet: Facet;
  object: string;
  revision: string;
  generation: string;
  policyVersion: string;
  author: string;
};

export type EncryptedObject = ObjectContext & {
  format: "sortsys-object-v1";
  nonce: string;
  ciphertext: string;
  wrappedKey: string;
  signature: string;
};

const contextKeys = ["tenant", "scope", "facet", "object", "revision", "generation", "policyVersion", "author"] as const;
const envelopeKeys = [...contextKeys, "format", "nonce", "ciphertext", "wrappedKey", "signature"];
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

export function objectContext(value: unknown): ObjectContext {
  const obj = record(value, contextKeys);
  for (const key of ["tenant", "scope", "object", "author"] as const) identifier(obj[key]);
  for (const key of ["revision", "generation", "policyVersion"] as const) revision(obj[key]);
  if (!FACETS.includes(obj.facet as Facet)) throw new InvalidProtectedData();
  return { ...obj } as ObjectContext;
}

export function contextFrame(context: ObjectContext): Uint8Array<ArrayBuffer> {
  objectContext(context);
  return frame("sortsys/object-context/v1", contextKeys.map(key => context[key]));
}

export function objectFrame(value: EncryptedObject): Uint8Array<ArrayBuffer> {
  return frame("sortsys/object/v1", [...contextKeys.map(key => value[key]), value.format, value.nonce, value.ciphertext, value.wrappedKey]);
}

export function encryptedObject(value: unknown): EncryptedObject {
  const obj = record(value, envelopeKeys);
  objectContext(Object.fromEntries(contextKeys.map(key => [key, obj[key]])));
  if (obj.format !== "sortsys-object-v1") throw new InvalidProtectedData();
  for (const key of ["nonce", "ciphertext", "wrappedKey", "signature"] as const) {
    if (typeof obj[key] !== "string") throw new InvalidProtectedData();
  }
  sized(obj.nonce as string, 12);
  sized(obj.wrappedKey as string, 40);
  sized(obj.signature as string, 64);
  const ciphertext = unbase64(obj.ciphertext as string, MAX_CONTENT_BYTES + 16);
  if (ciphertext.length < 16) throw new InvalidProtectedData();
  return { ...obj } as EncryptedObject;
}

export async function encryptObject(context: ObjectContext, plaintext: Uint8Array<ArrayBuffer>, key: CryptoKey, author: CryptoKey): Promise<EncryptedObject> {
  if (plaintext.length > MAX_CONTENT_BYTES) throw new InvalidProtectedData();
  const raw = randomSecret();
  try {
    const dataKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const [ciphertext, wrappedKey] = await Promise.all([
      crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: contextFrame(context), tagLength: 128 }, dataKey, plaintext),
      crypto.subtle.wrapKey("raw", dataKey, key, "AES-KW"),
    ]);
    const obj: EncryptedObject = { ...context, format: "sortsys-object-v1", nonce: base64(nonce), ciphertext: base64(ciphertext), wrappedKey: base64(wrappedKey), signature: "" };
    obj.signature = await sign(author, objectFrame(obj));
    return obj;
  } finally {
    raw.fill(0);
  }
}

export async function decryptObject(input: unknown, expected: ObjectContext, key: CryptoKey, author: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const obj = encryptedObject(input);
    objectContext(expected);
    if (contextKeys.some(name => obj[name] !== expected[name])) throw new InvalidProtectedData();
    await verify(author, obj.signature, objectFrame(obj));
    const dataKey = await crypto.subtle.unwrapKey("raw", sized(obj.wrappedKey, 40), key, "AES-KW", "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sized(obj.nonce, 12), additionalData: contextFrame(expected), tagLength: 128 }, dataKey, unbase64(obj.ciphertext, MAX_CONTENT_BYTES + 16)));
  } catch {
    throw new InvalidProtectedData();
  }
}
