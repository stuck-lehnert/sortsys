import type { Client } from "@sortsys/v2-client";
import { base64, frame, InvalidProtectedData, policy, policyFrame, record, sign, sized, verify } from "@sortsys/zerotrust";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { addressId } from "./addressBook";
import { decodeBusinessRow } from "./rowCodec";
import type { OpenedObject } from "./protectedObjects";
const required = async <T>(request: Promise<[
  T | null,
  Error | null
]>): Promise<T> => { const [value, error] = await request; if (error)
  throw error; if (value === null)
  throw new InvalidProtectedData(); return value; };
export async function deliveryRequestContext(client: Client, signal: AbortSignal) {
  const account = unlockedAccount();
  if (!account)
    throw new InvalidProtectedData();
  const live = () => { signal.throwIfAborted(); if (account !== unlockedAccount())
    throw new InvalidProtectedData(); };
  const history = await trustedHistory(client), session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" }));
  live();
  const raw = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...unsigned } = raw, permissions = policy(unsigned);
  if (typeof signature !== "string" || permissions.tenant !== account.tenant)
    throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions));
  live();
  return { account, subject: `user:${session.user.id}`, generation: history.current.generation, policyVersion: permissions.version, live };
}
export async function initializeDeliveryRegistry(client: Client, signal: AbortSignal) {
  const c = await deliveryRequestContext(client, signal);
  const proof = await sign(c.account.identity.signingKey.privateKey, frame("sortsys/delivery-initialize/v1", [c.account.tenant, c.subject, c.generation, c.policyVersion]));
  c.live();
  await required(client.mutate("zerotrust.deliveryNotes.initialize", { generation: c.generation, policyVersion: c.policyVersion, proof }, { signal }));
  c.live();
}
export function deliveryAllocation(input: unknown) {
  const value = record(input, ["id", "projectId", "number"]);
  addressId(value.id);
  addressId(value.projectId);
  if (typeof value.number !== "string" || !/^[1-9]\d{0,18}$/.test(value.number) || BigInt(value.number) > 9223372036854775807n)
    throw new InvalidProtectedData();
  return { id: value.id as string, projectId: value.projectId as string, number: value.number };
}
export async function allocateDeliveryNote(client: Client, projectId: string, requestId: string, signal: AbortSignal) {
  addressId(projectId);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId))
    throw new InvalidProtectedData();
  const c = await deliveryRequestContext(client, signal), proof = await sign(c.account.identity.signingKey.privateKey, frame("sortsys/delivery-allocate/v1", [c.account.tenant, c.subject, projectId, requestId, c.generation, c.policyVersion]));
  c.live();
  const value = deliveryAllocation(await required(client.mutate("zerotrust.deliveryNotes.allocate", { projectId, requestId, generation: c.generation, policyVersion: c.policyVersion, proof }, { signal })));
  c.live();
  if (value.projectId !== projectId)
    throw new InvalidProtectedData();
  return value;
}
/** Compare public numbering metadata with the actual signed private rows. */
export async function checkDeliveryObjects(client: Client, objects: OpenedObject[], live: () => void) {
  const selected = objects.filter(object => object.envelope.object.startsWith("delivery-note:"));
  for (let offset = 0; offset < selected.length; offset += 64) {
    const chunk = selected.slice(offset, offset + 64), result = await required(client.query("zerotrust.deliveryNotes.references", { objects: chunk.map(object => object.envelope.object) }, { strategy: "network-only" }));
    live();
    if (!Array.isArray(result) || result.length !== chunk.length || new Set(result.map(row => row.object)).size !== chunk.length)
      throw new InvalidProtectedData();
    const byId = new Map(result.map(row => [row.object, row.allocation]));
    for (const object of chunk) {
      const allocation = deliveryAllocation(byId.get(object.envelope.object)), data = record(object.value, ["format", "note", "records", "specialRecords"]), row = decodeBusinessRow(data.note);
      if (data.format !== "sortsys-delivery-note-v1" || row.table !== "product_delivery_notes" || row.values.id !== addressId(allocation.id) || row.values.project_id !== addressId(allocation.projectId)
        || row.values.auto_id !== allocation.number || object.envelope.object !== `delivery-note:${allocation.projectId}:${allocation.id}` || object.envelope.scope !== `project:${allocation.projectId}` || object.envelope.facet !== "contract-quantities")
        throw new InvalidProtectedData();
    }
  }
}
export async function deliveryRequestFingerprint(exportKey: string, tenant: string, subject: string, input: unknown) {
  const secret = sized(exportKey, 64), message = frame("sortsys/delivery-create-request/v1", [tenant, subject, JSON.stringify(input)]);
  try {
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
  }
  finally {
    secret.fill(0);
    message.fill(0);
  }
}
