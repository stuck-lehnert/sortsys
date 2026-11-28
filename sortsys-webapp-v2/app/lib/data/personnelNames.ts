import type { Client } from "@sortsys/v2-client";
import { arrayBatches, mapConcurrent } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { userFullName } from "../format";
import { PERSONNEL_MODEL, personnelCollection } from "./personnelData";
import { protectedCollections } from "./protectedObjects";

const PERSONNEL_PAGE_BATCH = 16;

export async function loadPersonnelNames(
  client: Client,
  userIds: Iterable<string>,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const people = [...new Set(userIds)].map((id) => ({
    id,
    area: personnelCollection(id, "master-data"),
  }));
  const names = new Map<string, string>();
  if (!people.length) return names;

  const selected = people.length <= PERSONNEL_PAGE_BATCH ? people : undefined;
  const access = await protectedCollections(
    client,
    signal,
    selected?.map(({ area }) => area.domain),
    selected?.map(({ area }) => ({ area })),
    { retryUnavailableInitial: true },
  );
  const readable = people.filter(({ area }) => access.readable(area));

  for (const group of arrayBatches(readable, PERSONNEL_PAGE_BATCH)) {
    signal.throwIfAborted();
    await access.prefetch(group.map(({ area }) => ({ area })));

    await mapConcurrent(group, 4, async ({ id, area }) => {
      signal.throwIfAborted();
      const [person, unexpected] = await access.read(area);
      signal.throwIfAborted();
      if (!person) return;
      if (unexpected) throw new InvalidProtectedData();

      const { values } = PERSONNEL_MODEL.decode(
        person.value,
        person.envelope.object,
        area,
      );
      const name = userFullName({
        firstName: values.first_name as string,
        lastName: values.last_name as string | null,
      });
      if (name) names.set(id, name);
    });
  }

  signal.throwIfAborted();
  return names;
}
