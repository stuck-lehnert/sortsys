import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
import { trustedHistory } from "../crypto/session";
import type { OfficeCapsule, OfficeContext } from "./officeCapsule";

export async function officeRecipients(client: Client, authorization: OfficeContext & { writers: string[] }, signal: AbortSignal) {
  const history = await trustedHistory(client); signal.throwIfAborted();
  if (history.current.generation !== authorization.authorityGeneration || authorization.writers.length > 2000) throw new InvalidProtectedData();
  const result: { subject: string; encryptionKey: string }[] = [];
  for (const subject of authorization.writers) {
    // The signed public history is already readable by ordinary members. The
    // administration-only identity inventory must not be needed for editing.
    const certificate = history.identityCertificate(subject);
    result.push({ subject, encryptionKey: certificate.encryptionKey });
  }
  return result;
}
export function sameOfficeRecipients(capsule: OfficeCapsule, recipients: { subject: string; encryptionKey: string }[]): boolean {
  return capsule.writers.length === recipients.length && recipients.every(recipient => capsule.writers.some(writer => writer.subject === recipient.subject && writer.encryptionKey === recipient.encryptionKey));
}
