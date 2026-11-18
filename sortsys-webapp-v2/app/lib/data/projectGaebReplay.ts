import type { Client } from "@sortsys/v2-client";
import {
  encryptedObject,
  InvalidProtectedData,
  projectReplayObject,
  type DocumentPart,
} from "@sortsys/zerotrust/sortsys";
import { liveReplay, MAX_LIVE_REPLAY, type LiveReplay } from "./liveCheckpoints";
import { protectedCollection } from "./protectedObjects";
import { projectFacetArea } from "./projectScope";
import { stockEnvelopeHash } from "./stockObjects";

export function projectGaebReplayArea(project: string) {
  const area = projectFacetArea(project, "attachment");
  return { ...area, prefix: `${area.domain}:replay:` };
}

export async function prepareProjectGaebReplay(
  client: Client,
  project: string,
  file: string,
  target: string,
  sequence: string,
  replay: LiveReplay,
  signal: AbortSignal,
) {
  if (Object.keys(replay).length === 0) return;
  const data = JSON.stringify(replay);
  if (data.length > MAX_LIVE_REPLAY) return;
  const area = projectGaebReplayArea(project);
  const token = crypto.randomUUID().replaceAll("-", "");
  const object = projectReplayObject(area.scope, file, token);
  const collection = await protectedCollection(client, area, signal);
  try {
    const packet = await collection.packet(
      object,
      { format: "sortsys-gaeb-replay-v1", target, sequence, data },
      undefined,
      true,
    );
    const part: DocumentPart = {
      facet: "attachment",
      object,
      hash: await stockEnvelopeHash(encryptedObject(packet.envelope)),
      keys: [{ facet: "attachment", generation: packet.envelope.generation }],
    };
    return { packet, part };
  } finally {
    collection.close();
  }
}

export async function readProjectGaebReplay(
  collection: Awaited<ReturnType<typeof protectedCollection>>,
  part: DocumentPart,
) {
  const { envelope, value } = await collection.get(part.object);
  if (
    envelope.generation !== part.keys[0]?.generation ||
    (await stockEnvelopeHash(envelope)) !== part.hash
  ) {
    throw new InvalidProtectedData();
  }
  return value;
}

export function decodeProjectGaebReplay(data: string): LiveReplay {
  if (data.length > MAX_LIVE_REPLAY) throw new InvalidProtectedData();
  return liveReplay(JSON.parse(data));
}
