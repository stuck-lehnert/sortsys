import type { Client } from "@sortsys/v2-client";
import {
  encryptedObject,
  InvalidProtectedData,
  record,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import type { DuckDriver } from "./database";
import { newProductRowId, publicId } from "./products";
import { protectedCollection, required } from "./protectedObjects";
import {
  compareRemarksNewestFirst,
  REMARK_MODEL,
  REMARK_MUTATIONS,
  REMARK_PREFIX,
  remarkAreaFromScope,
  remarkBody,
  remarkObject,
  remarkParent,
  remarkPayload,
  remarkRequest,
  remarkResource,
  remarkResourceFromRow,
  remarkValues,
  wireRemark,
} from "./remarkData";
import { businessSchema } from "./schema";
import { acquireDataRuntime } from "./runtime/session";

export function createProtectedRemarks(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  const domains = new Set<string>();

  async function locate(id: string) {
    addressId(id);
    const object = REMARK_PREFIX + id;
    const packet = encryptedObject(
      await required(
        client.query(
          "zerotrust.objects.get",
          { id: object },
          { strategy: "network-only" },
        ),
      ),
    );
    live();
    if (packet.object !== object || packet.facet !== "master-data")
      throw new InvalidProtectedData();
    const area = remarkAreaFromScope(packet.scope);
    domains.add(area.domain);
    const collection = await protectedCollection(client, area, signal);
    try {
      const opened = await collection.open(packet, object);
      live();
      if (opened.envelope.format === TOMBSTONE_FORMAT)
        throw new InvalidProtectedData();
      const value = remarkPayload(opened.value, object, area);
      const resource = remarkResourceFromRow(value.row);
      return { object, resource, signature: opened.envelope.signature };
    } finally {
      collection.close();
    }
  }

  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate(domains);
    },
    async query(path: string, input: unknown) {
      live();
      if (path !== "remarks.list") throw new InvalidProtectedData();
      const resource = remarkResource(input);
      const parent = remarkParent(resource);
      const request = remarkRequest(resource);
      domains.add(request.area.domain);
      const result = await runtime.read([parent.request, request], (view) => {
        parent.check(view);
        return view
          .documents(request)
          .map((document) => document.value)
          .filter((payload) => {
            const target = remarkResourceFromRow(payload.row);
            return (
              target.resourceType === resource.resourceType &&
              target.resourceId === resource.resourceId
            );
          })
          .sort(compareRemarksNewestFirst)
          .map(wireRemark);
      });
      live();
      return result;
    },
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      live();
      cancellation?.throwIfAborted();
      if (!REMARK_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path === "remarks.create";
      const deleting = path === "remarks.delete";
      let fields: string[];
      if (creating) fields = ["resourceType", "resourceId", "body"];
      else if (deleting) fields = ["id"];
      else fields = ["id", "body"];
      const data = record(input, fields);
      const body = deleting ? null : remarkBody(data.body);
      const rawId = creating ? newProductRowId() : addressId(data.id);
      const located = creating ? null : await locate(publicId(rawId));
      live();
      cancellation?.throwIfAborted();
      const resource =
        located?.resource ??
        remarkResource({
          resourceType: data.resourceType,
          resourceId: data.resourceId,
        });
      const parent = remarkParent(resource);
      const object = remarkObject(rawId);
      const request = {
        model: REMARK_MODEL,
        area: remarkRequest(resource).area,
        ids: [object],
      };
      domains.add(request.area.domain);
      let actor: string | null = null;
      if (creating) {
        const session = await required(
          client.query("auth.sessionInfo", undefined, {
            strategy: "network-only",
          }),
        );
        live();
        actor = addressId(session.user.id);
      }
      const now = new Date().toISOString();
      await runtime.transaction(
        [parent.request, request],
        (transaction) => {
          live();
          cancellation?.throwIfAborted();
          parent.check(transaction);
          if (located)
            transaction.expect(request, object, {
              signature: located.signature,
            });
          if (deleting) {
            transaction.delete(request, object);
          } else if (creating) {
            transaction.create(request, object, {
              format: "sortsys-remark-v1",
              row: {
                format: "sortsys-row-v2",
                schema: businessSchema.fingerprint,
                table: "resource_notes",
                values: {
                  id: rawId,
                  ...remarkValues(resource),
                  body,
                  created_by_user_id: actor,
                  created_at: now,
                  modified_at: now,
                },
              },
            });
          } else {
            transaction.patch(
              "resource_notes",
              { id: rawId },
              { body, modified_at: now },
            );
          }
        },
        { retries: 3 },
      );
      live();
      if (creating) return { id: publicId(rawId) };
      return { success: true as const };
    },
  };
}
