import { absenceRecord, objectWriteAction } from "./absenceRecords";
import {
  documentHead,
  documentHeadHash,
  documentId,
  documentScope,
  verifyDocumentHead,
} from "./documents";
import {
  digest,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "./encoding";
import { verify } from "./identity";
import { encryptedObject, FACETS, objectFrame, type Facet } from "./objects";
import { immutableRecord, immutableWriteAction } from "./immutableRecords";

export type TimestampTarget = {
  format: "sortsys-timestamp-target-v1";
  kind:
    | "absence-request"
    | "absence-decision"
    | "absence-withdrawal"
    | "document"
    | `immutable-${Facet}`;
  tenant: string;
  scope: string;
  object: string;
  revision: string;
  signature: string;
  digest: string;
};

/** An external proof is an independent sidecar. It is deliberately absent
 * from the signed business object and never determines its edit permission. */
export function timestampTarget(input: unknown): TimestampTarget {
  const value = record(input, [
    "format",
    "kind",
    "tenant",
    "scope",
    "object",
    "revision",
    "signature",
    "digest",
  ]);
  if (value.format !== "sortsys-timestamp-target-v1")
    throw new InvalidProtectedData();
  identifier(value.tenant);
  identifier(value.scope);
  identifier(value.object);
  revision(value.revision);
  sized(value.signature as string, 64);
  sized(value.digest as string, 32);
  if (typeof value.kind === "string" && value.kind.startsWith("immutable-")) {
    const facet = value.kind.slice("immutable-".length) as Facet;
    if (
      !FACETS.includes(facet) ||
      value.revision !== "1" ||
      !immutableRecord({
        scope: value.scope as string,
        facet,
        object: value.object as string,
      })
    )
      throw new InvalidProtectedData();
  } else if (value.kind === "document") {
    documentScope(value.scope);
    documentId(value.object);
  } else {
    if (
      !["absence-request", "absence-decision", "absence-withdrawal"].includes(
        value.kind as string,
      )
    )
      throw new InvalidProtectedData();
    const binding = absenceRecord({
      scope: value.scope as string,
      object: value.object as string,
      facet: value.kind === "absence-decision" ? "personnel" : "master-data",
    });
    if (
      !binding ||
      value.revision !== (value.kind === "absence-withdrawal" ? "2" : "1") ||
      binding.kind !==
        (value.kind === "absence-decision" ? "decision" : "request")
    )
      throw new InvalidProtectedData();
  }
  return { ...value } as TimestampTarget;
}

/** Callers provide the already pinned author's key, not an API-supplied key.
 * A timestamp is evidence for this exact signed ciphertext, including its
 * authorization context; neither plaintext nor a caller's date is submitted. */
export async function objectTimestampTarget(
  input: unknown,
  author: CryptoKey,
): Promise<TimestampTarget | null> {
  const envelope = encryptedObject(input);
  const immutable = immutableRecord(envelope);
  const binding = immutable ? null : absenceRecord(envelope);
  if (!immutable && !binding) return null;
  const action = objectWriteAction(envelope);
  const message = objectFrame(envelope);
  let kind: TimestampTarget["kind"];
  if (immutable) {
    immutableWriteAction(envelope);
    kind = `immutable-${envelope.facet}`;
  } else if (action === "delete") {
    kind = "absence-withdrawal";
  } else {
    kind =
      binding!.kind === "decision" ? "absence-decision" : "absence-request";
  }
  await verify(author, envelope.signature, message);
  return timestampTarget({
    format: "sortsys-timestamp-target-v1",
    kind,
    tenant: envelope.tenant,
    scope: envelope.scope,
    object: envelope.object,
    revision: envelope.revision,
    signature: envelope.signature,
    digest: await digest(signedPacketFrame(message, envelope.signature)),
  });
}

/** Incoming read-only files can still acquire a newer received version. Only
 * an explicitly locked document head is an irreversible finalization target. */
export async function documentTimestampTarget(
  input: unknown,
  author: CryptoKey,
): Promise<TimestampTarget | null> {
  const head = documentHead(input);
  if (!head.locked) return null;
  await verifyDocumentHead(
    head,
    { tenant: head.tenant, scope: head.scope, id: head.id },
    author,
  );
  return timestampTarget({
    format: "sortsys-timestamp-target-v1",
    kind: "document",
    tenant: head.tenant,
    scope: head.scope,
    object: head.id,
    revision: head.version,
    signature: head.signature,
    digest: await documentHeadHash(head),
  });
}
