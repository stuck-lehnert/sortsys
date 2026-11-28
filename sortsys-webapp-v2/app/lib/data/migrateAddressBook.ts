import type { Client } from "@sortsys/v2-client";
import { CUSTOMER_COLLECTION, CONTACT_COLLECTION, addressPayload, type AddressPayload } from "./addressBook";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { prepareOwnerCollections } from "./prepareCollections";
import { copyProtectedCollection } from "./copyCollection";
import { publicId } from "./products";

export async function prepareAddressBook(client: Client, source: BusinessDatabase, subject: string, signal: AbortSignal): Promise<void> {
  await prepareOwnerCollections(client, subject, [CUSTOMER_COLLECTION, CONTACT_COLLECTION], signal);
  const links = await readBusinessRows(source, "customer_contacts");
  for (const kind of ["customers", "contacts"] as const) {
    const collection = kind === "customers" ? CUSTOMER_COLLECTION : CONTACT_COLLECTION;
    const rows = (await readBusinessRows(source, kind)).map(row => ({ id: collection.prefix + publicId(row.values.id),
      value: { format: "sortsys-address-v1", kind, row, links: kind === "customers" ? links.filter(link => link.values.customer_id === row.values.id) : [] } satisfies AddressPayload }));
    await copyProtectedCollection(client, collection, rows, (value, object) => addressPayload(value, object, kind), signal);
  }
}
