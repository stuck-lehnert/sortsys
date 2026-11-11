import { base64, bytes, frame, hpke, InvalidProtectedData, record, revision, sized, unbase64 } from "@sortsys/zerotrust";
import type { PrivateIdentity } from "@sortsys/zerotrust";

export type OfficeContext = { authorityGeneration: string; policyVersion: string; keyGeneration: string };
export type OfficeCapsule = OfficeContext & {
  format: "sortsys-office-session-v1";
  epoch: string;
  viewKey: string;
  writers: { subject: string; encryptionKey: string; enc: string; ciphertext: string }[];
};
export function officeKey(input: unknown, mode: "view" | "edit"): string {
  // The pinned integration creates unpassworded version-2 capability hashes.
  if (typeof input !== "string" || !new RegExp(`^/2/integration/${mode}/[A-Za-z0-9+_-]{16,128}/$`).test(input)) throw new InvalidProtectedData();
  return input;
}
export function officeCapsule(input: unknown): OfficeCapsule {
  const value = record(input, ["format", "authorityGeneration", "policyVersion", "keyGeneration", "epoch", "viewKey", "writers"]);
  if (value.format !== "sortsys-office-session-v1" || typeof value.epoch !== "string" || !/^[a-f0-9]{32}$/.test(value.epoch)
    || !Array.isArray(value.writers) || !value.writers.length || value.writers.length > 2000) throw new InvalidProtectedData();
  for (const key of ["authorityGeneration", "policyVersion", "keyGeneration"] as const) revision(value[key]);
  const seen = new Set<string>();
  return { format: value.format, authorityGeneration: value.authorityGeneration as string, policyVersion: value.policyVersion as string,
    keyGeneration: value.keyGeneration as string, epoch: value.epoch, viewKey: officeKey(value.viewKey, "view"), writers: value.writers.map(input => {
      const writer = record(input, ["subject", "encryptionKey", "enc", "ciphertext"]);
      if (typeof writer.subject !== "string" || !/^user:[1-9a-v][0-9a-v]{0,12}$/.test(writer.subject) || seen.has(writer.subject)) throw new InvalidProtectedData();
      seen.add(writer.subject);
      for (const key of ["encryptionKey", "enc"] as const) { if (typeof writer[key] !== "string") throw new InvalidProtectedData(); sized(writer[key], 32); }
      if (typeof writer.ciphertext !== "string" || unbase64(writer.ciphertext, 512).length < 16) throw new InvalidProtectedData();
      return writer as OfficeCapsule["writers"][number];
    }) };
}
export function sameOfficeContext(capsule: OfficeContext, current: OfficeContext): boolean {
  return capsule.authorityGeneration === current.authorityGeneration && capsule.policyVersion === current.policyVersion && capsule.keyGeneration === current.keyGeneration;
}
function info(tenant: string, project: string, file: string, capsule: Omit<OfficeCapsule, "writers">, subject: string, encryptionKey: string) {
  return frame("sortsys/office-edit-capability/v1", [tenant, project, file, capsule.authorityGeneration, capsule.policyVersion,
    capsule.keyGeneration, capsule.epoch, capsule.viewKey, subject, encryptionKey]);
}
/** The containing file envelope signs this capsule. File readers get the view
 * capability; only individually certified writers can open an edit capsule. */
export async function sealOfficeSession(tenant: string, project: string, file: string, context: OfficeContext,
  session: { editKey: string; viewKey: string }, recipients: { subject: string; encryptionKey: string }[]): Promise<OfficeCapsule> {
  const value = { ...context, format: "sortsys-office-session-v1" as const, epoch: crypto.randomUUID().replaceAll("-", ""), viewKey: officeKey(session.viewKey, "view") };
  const plain = bytes(officeKey(session.editKey, "edit"));
  try {
    const writers = [];
    for (const recipient of recipients) {
      const associated = info(tenant, project, file, value, recipient.subject, recipient.encryptionKey);
      const result = await hpke.seal({ recipientPublicKey: await hpke.kem.deserializePublicKey(sized(recipient.encryptionKey, 32)), info: associated }, plain, associated);
      writers.push({ ...recipient, enc: base64(result.enc), ciphertext: base64(result.ct) });
    }
    return officeCapsule({ ...value, writers });
  } finally { plain.fill(0); }
}
export async function openOfficeSession(tenant: string, project: string, file: string, input: unknown,
  subject: string, identity: PrivateIdentity): Promise<{ editKey: string; viewKey: string }> {
  const capsule = officeCapsule(input), recipient = capsule.writers.find(writer => writer.subject === subject);
  if (!recipient) throw new InvalidProtectedData();
  const associated = info(tenant, project, file, capsule, subject, recipient.encryptionKey);
  let plain: Uint8Array<ArrayBuffer> | undefined;
  try {
    plain = new Uint8Array(await hpke.open({ recipientKey: identity.encryptionKey.privateKey, enc: sized(recipient.enc, 32), info: associated }, unbase64(recipient.ciphertext, 512), associated));
    return { editKey: officeKey(new TextDecoder("utf-8", { fatal: true }).decode(plain), "edit"), viewKey: capsule.viewKey };
  } catch { throw new InvalidProtectedData(); }
  finally { plain?.fill(0); }
}
