import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import type { DuckDriver } from "./database";
import {
  DELIVERY_MODEL,
  DELIVERY_PRICE_MODEL,
  deliveryCollection,
  deliveryCosts,
  deliveryDomain,
  DELIVERY_QUERIES,
  wireDelivery,
  type DeliveryPayload,
  type DeliveryPrices,
} from "./deliveryNoteData";
import { PRICE_COLLECTION, publicId } from "./products";
import {
  protectedCollection,
  protectedCollections,
  required,
} from "./protectedObjects";
import { deliveryAllocation } from "./deliveryRegistry";
import { acquireDataRuntime } from "./runtime/session";
import { effectivePrice } from "./stockObjects";

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
        priceRevisions = new Map<string, string>();
      for (const request of quantityRequests)
        for (const document of view.documents(request)) {
          payloads.push(document.value);
          revisions.set(
            publicId(document.value.note.values.id),
            document.revision,
          );
        }
      for (const request of priceRequests)
        for (const document of view.documents(request)) {
          if (prices.has(document.value.noteId))
            throw new InvalidProtectedData();
          prices.set(document.value.noteId, document.value);
          priceRevisions.set(document.value.noteId, document.revision);
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
        ? { priceRevision: state.priceRevisions.get(id) ?? "0" }
        : {}),
    };
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
          (typeof data.expectedRevision !== "string" ||
            !/^[1-9]\d{0,18}$/.test(data.expectedRevision))
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
        await runtime.remove(
          { model: DELIVERY_MODEL, area },
          area.prefix + allocation.id,
          {
            expectedRevision: data.expectedRevision as string | undefined,
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
      const state = await load(allocation.projectId);
      live();
      const payload = state.payloads.find(
        (item) => publicId(item.note.values.id) === allocation.id,
      );
      if (!payload) throw new InvalidProtectedData();
      const special = state.prices.get(publicId(payload.note.values.id));
      if (path === "deliveryNotes.get") return wire(payload, state);
      const projectId = publicId(payload.note.values.project_id);
      if (!state.pricedProjects.has(projectId))
        throw new InvalidProtectedData();
      let productPrices: import("./rowCodec").BusinessRow[] = [];
      if (payload.records.length) {
        const collection = await protectedCollection(
          client,
          PRICE_COLLECTION,
          signal,
        );
        try {
          productPrices = (await collection.read()).map(effectivePrice);
          live();
        } finally {
          collection.close();
        }
      }
      return deliveryCosts(
        payload,
        special ?? {
          format: "sortsys-delivery-prices-v1",
          projectId,
          noteId: publicId(payload.note.values.id),
          prices: [],
        },
        productPrices,
      );
    },
    async refresh() {
      live();
      runtime.invalidate();
    },
    close: lease.close,
  };
}
