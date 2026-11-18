import {
  creationResourceBinding,
  InvalidProtectedData,
  signResourceAccess,
  type CreationOrigin,
  type EncryptedObject,
  type IdentityCertificate,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import { TOOL_MODEL } from "./toolData";
import { publicId } from "./products";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { required } from "./protectedObjects";

function bookingValue(
  origin: CreationOrigin,
  envelope: EncryptedObject,
  value: unknown,
) {
  if (
    origin.capability.namespace !== "tool-tracking" ||
    envelope.object !== `${origin.scope}:master-data:record`
  )
    return null;
  if (envelope.format === TOMBSTONE_FORMAT) return { active: false };
  if (
    !origin.assignee &&
    !origin.access &&
    (value === null ||
      typeof value !== "object" ||
      !("format" in value) ||
      value.format !== "sortsys-tool-part-v1")
  )
    return null;
  const part = TOOL_MODEL.decode(value, envelope.object, {
    domain: origin.id,
    scope: origin.scope,
    facet: "master-data",
    prefix: envelope.object,
  });
  if (part.deleted) return { active: false };
  const row = part.rows[0]!.values;
  if (
    origin.assignee &&
    (row.responsible_user_id === null ||
      `user:${publicId(row.responsible_user_id)}` !== origin.assignee.user)
  )
    throw new InvalidProtectedData();
  return { active: row.ended_at === null && row.responsible_user_id !== null };
}

export async function toolResponsibilityPacket(
  origin: CreationOrigin | undefined,
  envelope: EncryptedObject,
  value: unknown,
  author: IdentityCertificate,
  key: CryptoKey,
) {
  if (!origin) return undefined;
  const booking = bookingValue(origin, envelope, value);
  if (!booking) return undefined;
  return signResourceAccess(
    {
      tenant: envelope.tenant,
      resource: origin.scope,
      object: envelope.object,
      revision: envelope.revision,
      generation: origin.capability.generation,
      binding: await creationResourceBinding(origin),
      active: booking.active,
      packetSignature: envelope.signature,
      author,
    },
    key,
  );
}

export function checkToolResponsibility(
  origin: CreationOrigin | undefined,
  envelope: EncryptedObject,
  value: unknown,
  historical = false,
) {
  if (!origin || historical) return;
  const booking = bookingValue(origin, envelope, value);
  if (!booking) return;
  const state = origin.access;
  // A pre-existing booking without any conditional recipient can be read
  // before its administrator publishes the first live-state checkpoint.
  if (!state && !origin.assignee) return;
  if (
    !state ||
    state.revision !== envelope.revision ||
    state.packetSignature !== envelope.signature ||
    state.author.user !== envelope.author ||
    state.active !== booking.active
  )
    throw new InvalidProtectedData();
}

/** Remove former recipients from future generations once an administrator has
 * committed the closing packets. Durable markers remain for resumable work. */
export async function finishToolResponsibilityChanges(
  client: Client,
  packets: readonly MutateInput<"zerotrust.objects.save">[],
  signal: AbortSignal,
) {
  const resources = new Set(
    packets
      .filter((packet) => packet.resourceAccess?.active === false)
      .map((packet) => packet.resourceAccess!.resource),
  );
  if (!resources.size) return;
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  signal.throwIfAborted();
  if (!session.roles.includes(":admin")) return;
  const { finishAccessChanges } = await import("../crypto/accessRotations");
  await finishAccessChanges(
    client,
    signal,
    [...resources].flatMap((scope) => [
      `${scope}:master-data`,
      `${scope}:scope`,
    ]),
  );
}
