import { RpcClientError } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import {
  DELIVERY_MODEL,
  deliveryCollection,
  deliveryDomain,
  wireDelivery,
} from "../data/deliveryNoteData";
import { PRODUCT_COLLECTION, productPayload, publicId } from "../data/products";
import { projectCollection } from "../data/projectData";
import {
  REGIE_MODEL,
  regieCollection,
  regieDomain,
} from "../data/regieReportData";
import type { BusinessRow } from "../data/rowCodec";
import { readContentAreas, type ContentReadView } from "./readContentAreas";

export class RestoreMaterialConflict extends Error {}

export async function inspectRestoredMaterial(
  view: ContentReadView,
  projectIds: ReadonlySet<string>,
  signal: AbortSignal,
) {
  const productRefs = new Map<string, number>();
  let deliveryNotes = 0;
  let regieReports = 0;
  let missingProjects = 0;
  let uncheckedReferences = 0;

  function checkDocument(projectId: string, products: readonly BusinessRow[]) {
    if (!view.readable(projectCollection(projectId))) uncheckedReferences++;
    else if (!projectIds.has(projectId)) missingProjects++;
    for (const { values } of products) {
      const id = publicId(values.product_id);
      productRefs.set(id, (productRefs.get(id) ?? 0) + 1);
    }
  }

  try {
    const areas = view.areas((domain) => {
      const delivery = deliveryDomain(domain);
      if (delivery && !delivery.prices)
        return deliveryCollection(delivery.projectId);
      const regie = regieDomain(domain);
      return regie && !regie.hours ? regieCollection(regie.projectId) : null;
    });
    await readContentAreas(view, areas, (area, { envelope, value }) => {
      if (deliveryDomain(area.domain)) {
        const delivery = DELIVERY_MODEL.decode(value, envelope.object, area);
        const note = wireDelivery(delivery);
        checkDocument(note.projectId, delivery.records);
        deliveryNotes++;
        return;
      }
      const regie = REGIE_MODEL.decode(value, envelope.object, area);
      if (!regie.report) return;
      checkDocument(publicId(regie.report.values.project_id), regie.products);
      regieReports++;
    });

    const canReadProducts = view.readable(PRODUCT_COLLECTION);
    if (productRefs.size && canReadProducts) {
      for (const { envelope, value } of await view.read(PRODUCT_COLLECTION)) {
        const { product } = productPayload(value, envelope.object);
        productRefs.delete(publicId(product.values.id));
      }
    }
    let missingProducts = 0;
    for (const count of productRefs.values()) {
      if (canReadProducts) missingProducts += count;
      else uncheckedReferences += count;
    }
    return {
      deliveryNotes,
      regieReports,
      missingProjects,
      missingProducts,
      uncheckedReferences,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof InvalidProtectedData ||
      (error instanceof RpcClientError && error.code === "NOT_FOUND")
    ) {
      throw new RestoreMaterialConflict(
        "Invalid delivery, work report or product record",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
