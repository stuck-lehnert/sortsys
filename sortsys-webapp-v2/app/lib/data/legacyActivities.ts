import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  verifyMigrationOrigin,
} from "@sortsys/zerotrust/sortsys";
import {
  type Activity,
  type ActivityCandidate,
  activityId,
} from "./activityData";
import {
  LEGACY_ACTIVITY_PREFIX,
  legacyActivity,
  legacyActivityObject,
  legacyNameArea,
  type LegacyActivity,
  type LegacyName,
} from "./legacyActivityData";
import { publicId } from "./products";
import type { Collection, protectedCollections } from "./protectedObjects";
import { timestampMicros } from "./timestamps";

type Change = NonNullable<QueryResult<"zerotrust.history.get">>;
type Context = Awaited<ReturnType<typeof protectedCollections>>;
type Store = ReturnType<Context>;
type FindChange = (id: string) => Change | undefined;
/** The authority vouches for copied history, not for its original author's
 * identity. Current name keys remain necessary even for old labels. */
export function legacyActivityReader(
  client: Client,
  context: Context,
  collection: (area: Collection) => Store,
  access: (value: Change["access"]) => void,
  live: () => void,
) {
  const fetchedNames = new Map<string, Promise<Change | null>>();
  const opened = new WeakMap<Change, Promise<LegacyActivity>>();

  async function open(change: Change): Promise<LegacyActivity> {
    access(change.access);
    const envelope = change.envelope;
    const area = {
      domain: change.domain,
      scope: envelope.scope,
      facet: envelope.facet,
      prefix: LEGACY_ACTIVITY_PREFIX,
    };
    if (
      area.domain !== `${area.scope}:${area.facet}` ||
      !context.readable(area) ||
      change.previous !== null ||
      change.deletion !== null ||
      change.references !== null
    ) {
      throw new InvalidProtectedData();
    }
    const proof = await verifyMigrationOrigin(
      envelope,
      change.migrationOrigin,
      context.authority,
    );
    live();
    if (
      !proof.history ||
      proof.history.occurredMicros !== change.occurredMicros ||
      proof.history.source !== change.orderId
    ) {
      throw new InvalidProtectedData();
    }
    const opened = await collection(area).openHistorical(
      envelope,
      envelope.object,
    );
    live();
    const value = legacyActivity(opened.value, envelope.object, area);
    if (value.part === "event") {
      const eventId = value.row.values.id;
      const eventMicros = timestampMicros(
        value.row.values.occurred_at as string,
      ).toString();
      if (
        eventId !== proof.history.source ||
        eventMicros !== proof.history.occurredMicros
      ) {
        throw new InvalidProtectedData();
      }
    } else if (value.source !== proof.history.source) {
      throw new InvalidProtectedData();
    }
    return value;
  }

  function openOnce(change: Change) {
    let value = opened.get(change);
    if (!value) {
      value = open(change);
      opened.set(change, value);
    }
    return value;
  }

  function fetchName(id: string) {
    let result = fetchedNames.get(id);
    if (!result) {
      result = (async () => {
        const [change, error] = await client.query(
          "zerotrust.history.get",
          { id, revision: "1" },
          { strategy: "network-only" },
        );
        live();
        if (error) {
          throw error;
        }
        return change;
      })();
      fetchedNames.set(id, result);
    }
    return result;
  }

  async function name(
    values: Record<string, unknown>,
    part: LegacyName["part"],
    instant: string,
    findChange: FindChange,
  ): Promise<LegacyName | null> {
    const area = legacyNameArea(values, part);
    if (!area || !context.readable(area)) {
      return null;
    }

    const id = legacyActivityObject(area, values.id as string, part);
    const change = findChange(id) ?? (await fetchName(id));
    live();
    if (!change) {
      return null;
    }

    if (
      change.domain !== area.domain ||
      change.envelope.object !== id ||
      change.envelope.revision !== "1" ||
      change.occurredMicros !== instant
    ) {
      throw new InvalidProtectedData();
    }

    const value = await openOnce(change);
    live();
    if (value.part !== part) {
      throw new InvalidProtectedData();
    }
    return value;
  }

  return async (
    change: Change,
    findChange: FindChange,
  ): Promise<ActivityCandidate[]> => {
    const value = await openOnce(change);
    live();
    if (value.part !== "event") {
      return [];
    }
    const values = value.row.values;
    const instant = change.occurredMicros;
    const [resource, actor, project] = await Promise.all([
      name(values, "resource", instant, findChange),
      name(values, "actor", instant, findChange),
      name(values, "context", instant, findChange),
    ]);
    live();
    const position = {
      instant: BigInt(instant),
      order: BigInt(change.orderId),
      sequence: BigInt(change.sequence),
      ordinal: 0,
    };
    const occurredAt = new Date(values.occurred_at as string);
    const action = values.action as Activity["action"];
    const resourceTitle = resource?.resourceTitle || resource?.title || null;
    const item: Activity = {
      id: activityId(position, true),
      entityTable: values.entity_table as string,
      entityId: values.entity_id as string,
      changedColumns: [...(values.changed_columns as string[])],
      actorUserId:
        values.actor_user_id === null ? null : publicId(values.actor_user_id),
      actorKind: values.actor_kind as string,
      actorName: actor?.actorName ?? null,
      isImported: values.is_imported as boolean,
      resourceType: values.resource_type as Activity["resourceType"],
      resourceId: publicId(values.resource_id),
      contextId: project?.contextId ?? null,
      contextTitle: project?.contextTitle ?? null,
      contextDate:
        project && values.context_date !== null
          ? new Date(`${values.context_date}T00:00:00Z`)
          : null,
      title:
        resource?.title && resource.title !== values.entity_table
          ? resource.title
          : resourceTitle || `#${publicId(values.resource_id)}`,
      resourceTitle,
      description: values.description as string | null,
      action,
      occurredAt,
      createdAt:
        values.entity_created_at === null
          ? occurredAt
          : new Date(values.entity_created_at as string),
      modifiedAt: ["updated", "completed", "resumed"].includes(action)
        ? occurredAt
        : null,
    };
    return [{ item, group: `source:${values.id}`, ...position }];
  };
}
