import type { Client, QueryInput } from "@sortsys/v2-client";
import { arrayBatches } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../crypto/administration";
import { commercialDomain, commercialMasterArea } from "./commercialAreas";
import { reviewCommercialLinks } from "./commercialCaseLinks";
import {
  projectCommercialCollection,
  projectCommercialDomain,
} from "./projectCommercial";
import { financialCollection, financialDomain } from "./projectFinancialData";
import {
  protectedCollection,
  protectedCollections,
  required,
  type Collection,
  type OpenedObject,
} from "./protectedObjects";

const REVIEW_BATCH_SIZE = 8;
const PREFETCH_LIMIT = 16;
type Administrator = Awaited<ReturnType<typeof administratorContext>>;
type PreparedSelection = NonNullable<
  QueryInput<"zerotrust.stock.references">["prepared"]
>;
type RelationshipView = Pick<
  Awaited<ReturnType<typeof protectedCollections>>,
  "areas" | "prefetch" | "read"
> & {
  prepared?: PreparedSelection;
};

function relationshipAreas(domain: string): Collection[] {
  const commercial = commercialDomain(domain);
  if (commercial?.facet === "master-data")
    return [commercialMasterArea(commercial.id)];

  const areas: Collection[] = [];
  const workflow = projectCommercialDomain(domain);
  if (workflow) {
    const area = projectCommercialCollection(workflow.id, workflow.facet);
    areas.push({ ...area, prefix: `${area.prefix}register` });
  }

  const financial = financialDomain(domain);
  if (financial) {
    const { projectId, type } = financial;
    areas.push(financialCollection(projectId, type));
    if (type === "invoice")
      areas.push(financialCollection(projectId, type, true));
  }

  return areas;
}

async function reviewOpenedObjects(
  client: Client,
  administrator: Administrator,
  area: Collection,
  objects: readonly OpenedObject[],
  signal: AbortSignal,
  prepared?: PreparedSelection,
) {
  administrator.live();
  const proofs = await Promise.all(
    objects.map(async (object) => {
      const proof = await reviewCommercialLinks(object, administrator.authority);
      if (!proof || proof.domain !== area.domain)
        throw new InvalidProtectedData();
      return proof;
    }),
  );

  administrator.live();
  const result = await required(
    client.mutate(
      "zerotrust.commercial.reviewRelationships",
      { proofs, ...(prepared ? { prepared } : {}) },
      { signal },
    ),
  );
  administrator.live();
  if (!result.success) throw new InvalidProtectedData();
}

/** Review one bounded selection of current packets. This does not certify the
 * completeness of a collection or authorize deletion. */
export async function reviewLegacyCommercialSelection(
  client: Client,
  area: Collection,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (
    ids.length === 0 ||
    ids.length > REVIEW_BATCH_SIZE ||
    new Set(ids).size !== ids.length
  )
    throw new InvalidProtectedData();

  const administrator = await administratorContext(client, signal);
  const collection = await protectedCollection(client, area, signal);

  try {
    const objects = await collection.selected(ids);
    if (objects.length !== ids.length) throw new InvalidProtectedData();

    await reviewOpenedObjects(client, administrator, area, objects, signal);
  } finally {
    collection.close();
  }
}

/** Review the live collections this administrator can read. This resumable
 * pass does not claim coverage of hidden or concurrently published objects. */
export async function reviewReadableCommercialRelationships(
  client: Client,
  signal: AbortSignal,
  progress?: (reviewed: number) => void,
): Promise<number> {
  const administrator = await administratorContext(client, signal);
  const collections = await protectedCollections(client, signal);
  return reviewRelationshipView(
    client,
    administrator,
    collections,
    signal,
    progress,
  );
}

/** Check readable packets from the selected view. Coverage of all current
 * addresses is checked separately by the server. */
export async function reviewRelationshipView(
  client: Client,
  administrator: Administrator,
  view: RelationshipView,
  signal: AbortSignal,
  progress?: (reviewed: number) => void,
): Promise<number> {
  const areas = view
    .areas((domain) => relationshipAreas(domain)[0] ?? null)
    .flatMap(({ domain }) => relationshipAreas(domain));
  let reviewed = 0;

  for (const page of arrayBatches(areas, PREFETCH_LIMIT)) {
    administrator.live();
    await view.prefetch(page.map((area) => ({ area })));

    for (const area of page) {
      administrator.live();
      const objects = await view.read(area);

      for (const batch of arrayBatches(objects, REVIEW_BATCH_SIZE)) {
        await reviewOpenedObjects(
          client,
          administrator,
          area,
          batch,
          signal,
          view.prepared,
        );
        reviewed += batch.length;
        progress?.(reviewed);
      }
    }
  }

  administrator.live();
  return reviewed;
}
