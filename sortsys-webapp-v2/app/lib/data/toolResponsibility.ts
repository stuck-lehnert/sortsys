import {
  creationResourceBinding,
  InvalidProtectedData,
  resourceCommandBinding,
  signResourceAccess,
  type CreationOrigin,
  type EncryptedObject,
  type IdentityCertificate,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import { toolCollection, toolDomain, TOOL_MODEL } from "./toolData";
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
  if (envelope.format === TOMBSTONE_FORMAT) {
    return { active: false, returnKey: undefined };
  }
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
  if (part.deleted) return { active: false, returnKey: undefined };
  const row = part.rows[0]!.values;
  if (part.returnKey && part.returnKey.recipient.tenant !== envelope.tenant) {
    throw new InvalidProtectedData();
  }
  if (
    origin.assignee &&
    (row.responsible_user_id === null ||
      `user:${publicId(row.responsible_user_id)}` !== origin.assignee.user)
  )
    throw new InvalidProtectedData();
  return {
    active: row.ended_at === null && row.responsible_user_id !== null,
    returnKey: part.returnKey,
  };
}

async function bookingCommandBinding(key: string | undefined) {
  if (key === undefined) return undefined;
  return resourceCommandBinding(key);
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
  const commandBinding =
    envelope.format === TOMBSTONE_FORMAT
      ? origin.access?.commandBinding
      : await bookingCommandBinding(booking.returnKey?.verificationKey);
  return signResourceAccess(
    {
      tenant: envelope.tenant,
      resource: origin.scope,
      object: envelope.object,
      revision: envelope.revision,
      generation: origin.capability.generation,
      binding: await creationResourceBinding(origin),
      active: booking.active,
      ...(commandBinding ? { commandBinding } : {}),
      packetSignature: envelope.signature,
      author,
    },
    key,
  );
}

export async function checkToolResponsibility(
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
    state.active !== booking.active ||
    (envelope.format !== TOMBSTONE_FORMAT && state.commandBinding !==
      await bookingCommandBinding(booking.returnKey?.verificationKey))
  )
    throw new InvalidProtectedData();
}

/** Remove former recipients from future generations once the closing packets
 * commit. Durable markers remain available to a manager of each affected area. */
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
  await finishToolBookingRotations(client, resources, signal);
}

export async function finishToolBookingRotations(
  client: Client,
  resources: ReadonlySet<string>,
  signal: AbortSignal,
) {
  if (!resources.size) return;
  const areas = [...resources].flatMap((scope) => {
    const booking = toolDomain(`${scope}:master-data`);
    if (booking?.namespace !== "tool-tracking") throw new InvalidProtectedData();
    return (["master-data", "scope"] as const).map((facet) =>
      toolCollection("tool-tracking", booking.id, facet),
    );
  });
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  signal.throwIfAborted();
  if (session.roles.includes(":admin")) {
    const { finishAccessChanges } = await import("../crypto/accessRotations");
    await finishAccessChanges(client, signal, areas.map((area) => area.domain));
    return;
  }
  const { finishDelegatedAccessChanges } =
    await import("../crypto/delegatedAccess");
  await finishDelegatedAccessChanges(client, areas, signal, {
    leaveUnmanagedPending: true,
  });
}
