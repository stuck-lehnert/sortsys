import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId } from "./products";
import {
  deliveryCollection,
  deliveryPayload,
  deliveryPrices,
  type DeliveryPayload,
  type DeliveryPrices,
} from "./deliveryNoteData";
import { initializeDeliveryRegistry } from "./deliveryRegistry";
import { adoptDeliveryNumbers } from "../backups/deliveryNumbers";

/** Quantity readers never receive the original special-record price column.
 * The verified archive retains it until both independent copies are checked. */
export async function prepareDeliveryNotes(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
) {
  await initializeDeliveryRegistry(client, signal);
  const projects = await readBusinessRows(source, "projects"),
    notes = await readBusinessRows(source, "product_delivery_notes"),
    records = await readBusinessRows(source, "product_delivery_records"),
    specials = await readBusinessRows(
      source,
      "product_delivery_special_records",
    );
  const projectIds = new Set(projects.map((row) => row.values.id)),
    noteIds = new Set(notes.map((row) => row.values.id));
  if (
    notes.some((row) => !projectIds.has(row.values.project_id)) ||
    [...records, ...specials].some((row) => !noteIds.has(row.values.note_id))
  )
    throw new InvalidProtectedData();
  await prepareOwnerCollections(
    client,
    subject,
    projects.flatMap((project) => [
      deliveryCollection(publicId(project.values.id)),
      deliveryCollection(publicId(project.values.id), true),
    ]),
    signal,
  );
  await adoptDeliveryNumbers(client, notes, signal);
  for (const project of projects) {
    signal.throwIfAborted();
    const projectId = publicId(project.values.id),
      quantity = deliveryCollection(projectId),
      pricing = deliveryCollection(projectId, true);
    const selected = notes.filter(
        (note) => note.values.project_id === project.values.id,
      ),
      copies: { id: string; value: DeliveryPayload }[] = [],
      prices: { id: string; value: DeliveryPrices }[] = [];
    for (const note of selected) {
      const id = publicId(note.values.id),
        lines = specials.filter((row) => row.values.note_id === note.values.id);
      copies.push({
        id: quantity.prefix + id,
        value: {
          format: "sortsys-delivery-note-v1",
          note,
          records: records.filter(
            (row) => row.values.note_id === note.values.id,
          ),
          specialRecords: lines.map((row) => ({
            ...row,
            values: { ...row.values, price_per_unit: null },
          })),
        },
      });
      prices.push({
        id: pricing.prefix + id,
        value: {
          format: "sortsys-delivery-prices-v1",
          projectId,
          noteId: id,
          prices: lines.map((row) => ({
            id: publicId(row.values.id),
            pricePerUnit: row.values.price_per_unit as number | null,
          })),
        },
      });
    }
    await copyProtectedCollection(
      client,
      quantity,
      copies,
      (value, object) => deliveryPayload(value, object, projectId),
      signal,
    );
    await copyProtectedCollection(
      client,
      pricing,
      prices,
      (value, object) => deliveryPrices(value, object, projectId),
      signal,
    );
  }
}
