import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import type { DuckDriver } from "./database";
import {
  calculateDeliveryCosts,
  DELIVERY_MODEL,
  DELIVERY_PRICE_MODEL,
  deliveryCollection,
  deliveryDomain,
  DELIVERY_QUERIES,
  wireDelivery,
  wireDeliveryCosts,
  type DeliveryPayload,
  type DeliveryPrices,
} from "./deliveryNoteData";
import { priceRequest, publicId } from "./products";
import { protectedCollections, required } from "./protectedObjects";
import { historicalPriceIndex } from "./historicalPrices";
import { deliveryAllocation } from "./deliveryRegistry";
import {
  deliveryFormRevision,
  deliveryObject,
  deliveryPlacement,
  isDeliveryFormRevision,
} from "./deliveryIdentity";
import { ProtectedWriteConflict } from "./atomicWrites";
import { acquireDataRuntime } from "./runtime/session";
import type { DataView } from "./runtime/runtime";

export function createProtectedDeliveryNotes(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime,
    live = lease.live;
  type Loaded = {
    payloads: DeliveryPayload[];
    prices: Map<string, DeliveryPrices>;
    pricedProjects: Set<string>;
    quantityProjects: Set<string>;
    revisions: Map<string, string>;
    priceRevisions: Map<string, string>;
    placements: Map<string, string | undefined>;
  };
  async function load(projectId?: string): Promise<Loaded> {
    const domains =
      projectId === undefined
        ? undefined
        : [
            deliveryCollection(projectId).domain,
            deliveryCollection(projectId, true).domain,
          ];
    const inventory = await protectedCollections(client, signal, domains);
    const areas = inventory.areas((domain) => {
      const area = deliveryDomain(domain);
      return area ? deliveryCollection(area.projectId, area.prices) : null;
    });
    live();
    const quantities = areas.filter((area) => area.facet === "master-data"),
      quantityProjects = new Set(
        quantities.map((area) => deliveryDomain(area.domain)!.projectId),
      );
    const priceAreas = areas.filter(
      (area) =>
        area.facet === "procurement" &&
        quantityProjects.has(deliveryDomain(area.domain)!.projectId),
    );
    const quantityRequests = quantities.map((area) => ({
        model: DELIVERY_MODEL,
        area,
      })),
      priceRequests = priceAreas.map((area) => ({
        model: DELIVERY_PRICE_MODEL,
        area,
      }));
    return runtime.read([...quantityRequests, ...priceRequests], (view) => {
      const payloads: DeliveryPayload[] = [],
        prices = new Map<string, DeliveryPrices>(),
        revisions = new Map<string, string>(),
        priceRevisions = new Map<string, string>(),
        placements = new Map<string, string | undefined>();
      for (const request of quantityRequests)
        for (const document of view.documents(request)) {
          payloads.push(document.value);
          const { id, project_id } = document.value.note.values;
          const identity = { id: publicId(id), projectId: publicId(project_id) };
          const placement = deliveryPlacement(document.id, identity);
          placements.set(identity.id, placement);
          revisions.set(
            identity.id,
            deliveryFormRevision(document.revision, placement),
          );
        }
      for (const request of priceRequests)
        for (const document of view.documents(request)) {
          if (prices.has(document.value.noteId))
            throw new InvalidProtectedData();
          prices.set(document.value.noteId, document.value);
          const { noteId, projectId } = document.value;
          const placement = deliveryPlacement(document.id, { id: noteId, projectId }, true);
          if (placement !== placements.get(noteId)) throw new InvalidProtectedData();
          priceRevisions.set(noteId, deliveryFormRevision(document.revision, placement));
        }
      return {
        payloads,
        prices,
        quantityProjects,
        pricedProjects: new Set(
          priceAreas.map((area) => deliveryDomain(area.domain)!.projectId),
        ),
        revisions,
        priceRevisions,
        placements,
      };
    });
  }
  function wire(payload: DeliveryPayload, state: Loaded) {
    const id = publicId(payload.note.values.id),
      project = publicId(payload.note.values.project_id);
    return {
      ...wireDelivery(payload, state.prices.get(id)),
      revision: state.revisions.get(id),
      ...(state.pricedProjects.has(project)
        ? { priceRevision: state.priceRevisions.get(id) ?? deliveryFormRevision("0", state.placements.get(id)) }
        : {}),
    };
  }

  async function readCosts(allocation: ReturnType<typeof deliveryAllocation>) {
    const quantity = {
      model: DELIVERY_MODEL,
      area: deliveryCollection(allocation.projectId),
      ids: [deliveryObject(allocation)],
    };
    const price = {
      model: DELIVERY_PRICE_MODEL,
      area: deliveryCollection(allocation.projectId, true),
      ids: [deliveryObject(allocation, true)],
    };
    const requests = [quantity, price];

    function costs(view: DataView, withCatalog: boolean) {
      const note = view.documents(quantity)[0]?.value;
      if (!note) throw new InvalidProtectedData();
      if (note.records.length && !withCatalog) return null;

      const special = view.documents(price)[0]?.value;
      const lookup = withCatalog ? historicalPriceIndex(view) : undefined;
      return wireDeliveryCosts(calculateDeliveryCosts(note, special, lookup));
    }

    const local = await runtime.read(requests, (view) => costs(view, false));
    if (local) return local;

    // Reopen the selected note with the price history so both use the same view.
    return runtime.read([...requests, priceRequest], (view) => costs(view, true));
  }

  return {
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      live();
      const current = cancellation
        ? AbortSignal.any([signal, cancellation])
        : signal;
      if (path === "deliveryNotes.delete") {
        const data = partialAddressRecord(input, ["id", "expectedRevision"]);
        addressId(data.id);
        if (
          data.expectedRevision !== undefined &&
          !isDeliveryFormRevision(data.expectedRevision)
        ) {
          throw new InvalidProtectedData();
        }
        const allocation = deliveryAllocation(
          await required(
            client.query(
              "zerotrust.deliveryNotes.locate",
              { id: data.id as string, includeDeleted: true },
              { strategy: "network-only" },
            ),
          ),
        );
        live();
        current.throwIfAborted();
        const area = deliveryCollection(allocation.projectId);
        let expected = data.expectedRevision as string | undefined;
        if (expected !== undefined) {
          const revision = expected.split(":").at(-1)!;
          if (expected !== deliveryFormRevision(revision, allocation.placement)) {
            throw new ProtectedWriteConflict();
          }
          expected = revision;
        }
        await runtime.remove(
          { model: DELIVERY_MODEL, area },
          deliveryObject(allocation),
          {
            expectedRevision: expected,
            signal: current,
          },
        );
        live();
        current.throwIfAborted();
        return { success: true as const };
      }
      const { writeDeliveryNote } = await import("./deliveryWrites");
      const result = await writeDeliveryNote(
        client,
        path,
        input,
        current,
        driver,
      );
      live();
      return result;
    },
    async query(path: string, input: unknown) {
      live();
      if (!DELIVERY_QUERIES.has(path)) throw new InvalidProtectedData();
      const data = partialAddressRecord(
        input ?? {},
        path === "deliveryNotes.list"
          ? ["projectId", "createdByUserId"]
          : path === "deliveryNotes.get"
            ? ["id", "autoId"]
            : ["id"],
      );
      if (path === "deliveryNotes.list") {
        const project =
            data.projectId == null ? null : addressId(data.projectId),
          author =
            data.createdByUserId == null
              ? null
              : addressId(data.createdByUserId),
          state = await load(
            data.projectId == null ? undefined : (data.projectId as string),
          );
        live();
        if (
          data.projectId != null &&
          !state.quantityProjects.has(data.projectId as string)
        )
          throw new InvalidProtectedData();
        return state.payloads
          .filter(
            (item) =>
              (project === null || item.note.values.project_id === project) &&
              (author === null ||
                item.note.values.created_by_user_id === author),
          )
          .sort((a, b) =>
            BigInt(a.note.values.auto_id as string) >
            BigInt(b.note.values.auto_id as string)
              ? -1
              : 1,
          )
          .map((item) => wire(item, state));
      }
      if (data.id !== undefined) addressId(data.id);
      else if (
        path !== "deliveryNotes.get" ||
        typeof data.autoId !== "number" ||
        !Number.isSafeInteger(data.autoId) ||
        data.autoId < 1
      )
        throw new InvalidProtectedData();
      const allocation = deliveryAllocation(
        await required(
          client.query(
            "zerotrust.deliveryNotes.locate",
            data.id !== undefined
              ? { id: data.id as string }
              : { number: String(data.autoId) },
            { strategy: "network-only" },
          ),
        ),
      );
      live();
      if (path === "deliveryNotes.costs.get") {
        const result = await readCosts(allocation);
        live();
        return result;
      }

      const state = await load(allocation.projectId);
      live();
      const payload = state.payloads.find(
        (item) => publicId(item.note.values.id) === allocation.id,
      );
      if (!payload || state.placements.get(allocation.id) !== allocation.placement)
        throw new InvalidProtectedData();
      return wire(payload, state);
    },
    async refresh() {
      live();
      runtime.invalidate();
    },
    close: lease.close,
  };
}
