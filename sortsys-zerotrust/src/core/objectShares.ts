import { boxPacketFrame, sealedBox, type SealedBox } from "../boxes";
import {
  digest,
  frame,
  InvalidProtectedData,
  signedPacketFrame,
  unbase64,
} from "../encoding";
import {
  identityCertificate,
  identityCertificateFrame,
  type IdentityCertificate,
} from "./certificates";

/** Commitment for the binding field of a ResourceAccessState. An explicitly
 * inactive state commits to the absence of both recipient and key envelope.
 * The host must require that signed state for every shareable source write. */
export async function objectKeyRecipientBinding(
  recipient: IdentityCertificate | null,
  envelope: SealedBox | null,
): Promise<string> {
  const packets: string[] = [];
  if (recipient !== null || envelope !== null) {
    if (recipient === null || envelope === null)
      throw new InvalidProtectedData();
    const identity = identityCertificate(recipient);
    const box = sealedBox(envelope);
    if (
      box.purpose !== "object-key" ||
      box.recipient !== identity.user ||
      box.tenant !== identity.tenant ||
      box.generation !== identity.generation ||
      unbase64(box.ciphertext, 48).length !== 48
    )
      throw new InvalidProtectedData();
    packets.push(
      ...(await Promise.all([
        digest(
          signedPacketFrame(
            identityCertificateFrame(identity),
            identity.signature,
          ),
        ),
        digest(boxPacketFrame(box)),
      ])),
    );
  }
  return digest(frame("sortsys/object-key-recipient/v1", packets));
}
