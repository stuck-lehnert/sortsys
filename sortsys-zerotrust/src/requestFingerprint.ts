import { base64, frame, InvalidProtectedData } from "./encoding";
import { deriveSecret } from "./identity";

/** Retry receipts depend on the account data key, never on a password's OPAQUE
 * export key. The same action remains recognizable after another sign-in method. */
export async function accountRequestFingerprint(
  dataKey: CryptoKey,
  purpose: string,
  tenant: string,
  subject: string,
  input: unknown,
): Promise<string> {
  const algorithm = dataKey.algorithm as AesKeyAlgorithm;
  if (
    dataKey.type !== "secret" || algorithm.name !== "AES-GCM" ||
    algorithm.length !== 256
  ) {
    throw new InvalidProtectedData();
  }
  const serialized = JSON.stringify(input);
  if (typeof serialized !== "string") {
    throw new InvalidProtectedData();
  }
  let secret: Uint8Array<ArrayBuffer> | undefined;
  let derived: Uint8Array<ArrayBuffer> | undefined;
  const message = frame(purpose, [tenant, subject, serialized]);
  try {
    secret = new Uint8Array(await crypto.subtle.exportKey("raw", dataKey));
    derived = await deriveSecret(secret, "sortsys/account-request-key/v1", [
      purpose,
      tenant,
      subject,
    ]);
    const key = await crypto.subtle.importKey(
      "raw",
      derived,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return base64(await crypto.subtle.sign("HMAC", key, message));
  } finally {
    secret?.fill(0);
    derived?.fill(0);
    message.fill(0);
  }
}
