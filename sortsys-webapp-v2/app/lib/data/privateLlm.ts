import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { prepareOwnerCollections } from "./prepareCollections";
import { privateLlmCollection } from "./assistantArea";
import { openAssistantCollection } from "./assistantStore";
export { privateLlmCollection } from "./assistantArea";

export async function preparePrivateLlm(
  client: Client,
  subject: string,
  signal: AbortSignal,
) {
  await prepareOwnerCollections(
    client,
    subject,
    [privateLlmCollection(subject)],
    signal,
  );
}
export function newAssistantId(): string {
  let id = 0n;
  while (!id) {
    id = 0n;
    for (const byte of crypto.getRandomValues(new Uint8Array(8)))
      id = (id << 8n) | BigInt(byte);
    id &= 9223372036854775807n;
  }
  return id.toString(32);
}
export function assistantId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9a-v][0-9a-v]{0,12}$/.test(value))
    throw new InvalidProtectedData();
  let number = 0n;
  for (const c of value) number = number * 32n + BigInt(parseInt(c, 32));
  if (number > 9223372036854775807n) throw new InvalidProtectedData();
  return value;
}

export function assistantPayload(
  input: unknown,
  object: string,
  kind: "scan" | "chat",
) {
  const data = record(input, ["format", "kind", "id", "value"]);
  const id = assistantId(data.id);
  if (
    data.format !== "sortsys-assistant-v1" ||
    data.kind !== kind ||
    object !== `assistant:${kind}:${id}`
  ) {
    throw new InvalidProtectedData();
  }
  return { id, value: data.value };
}

/** Each user's selected model context and results have an independent domain.
 * Catalogue access, even with its master-data key, cannot decrypt this history. */
export async function openPrivateLlm(client: Client, signal: AbortSignal) {
  const { subject, collection, live } = await openAssistantCollection(
    client,
    signal,
  );
  return {
    subject,
    async list(kind: "scan" | "chat") {
      const objects = await collection.read();
      live();
      return objects
        .filter((object) =>
          object.envelope.object.startsWith(`assistant:${kind}:`),
        )
        .map((object) => {
          const data = assistantPayload(
            object.value,
            object.envelope.object,
            kind,
          );
          return { ...data, revision: object.envelope.revision };
        });
    },
    async save(
      kind: "scan" | "chat",
      id: string,
      value: unknown,
      previousRevision: string | null = null,
    ): Promise<void> {
      live();
      assistantId(id);
      const object = `assistant:${kind}:${id}`;
      const current = (await collection.read()).find(
        (row) => row.envelope.object === object,
      );
      live();
      const payload = { format: "sortsys-assistant-v1", kind, id, value };
      if (current && JSON.stringify(current.value) === JSON.stringify(payload))
        return;
      if ((current?.envelope.revision ?? null) !== previousRevision)
        throw new InvalidProtectedData();
      const packet = await collection.packet(
        object,
        payload,
        current?.envelope,
      );
      // A competing head fails rather than replacing an unchecked newer value.
      try {
        await collection.write([packet]);
      } catch (error) {
        live();
        // A transport failure can hide a committed write. Verify that exact
        // signed packet before deciding whether persistence failed.
        await client.invalidate("zerotrust.objects.list");
        const committed = (await collection.read()).find(
          (row) => row.envelope.object === object,
        );
        live();
        if (committed?.envelope.signature !== packet.envelope.signature)
          throw error;
      }
      live();
      const saved = (await collection.read()).find(
        (row) => row.envelope.object === object,
      );
      live();
      if (
        !saved ||
        JSON.stringify(saved.value) !==
          JSON.stringify({ format: "sortsys-assistant-v1", kind, id, value })
      )
        throw new InvalidProtectedData();
    },
    close() {
      collection.close();
    },
  };
}
