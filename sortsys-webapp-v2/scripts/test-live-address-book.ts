import assert from "node:assert/strict";
import { createClient, type Client, type QueryResult } from "@sortsys/v2-client";
import { acceptVault, signIn, unlockedAccount } from "../app/lib/crypto/session";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareAddressBook } from "../app/lib/data/migrateAddressBook";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { CUSTOMER_COLLECTION, CONTACT_COLLECTION } from "../app/lib/data/addressBook";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { until } from "./test-live-events";

export async function testProtectedAddressBook(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>,
  customers: QueryResult<"customers.list">, contacts: QueryResult<"contacts.list">, customerId: string, contactId: string, password: string) {
  const signal = new AbortController().signal;
  await prepareAddressBook(client, source, subject, signal);
  await prepareAddressBook(client, source, subject, signal);
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "address-book-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password });
  await acceptVault(owner.exportKey, owner.vault, false);
  const requests: unknown[] = [], keys: string[] = [];
  let loseAck = false, falseAck = false, race = false;
  const observed: Client = { ...client, query: ((path, input, options) => {
    requests.push({ path, input });
    if (path === "zerotrust.keys.get") keys.push((input as { domain: string }).domain);
    return client.query(path, input, options);
  }) as Client["query"], mutate: (async (path, input, options) => {
    requests.push({ path, input });
    if (path === "zerotrust.objects.batch") {
      if (falseAck) { falseAck = false; return [{ success: true, heads: (input as { heads: unknown }).heads }, null]; }
      if (race) { race = false; await required(other.mutate("contacts.update", { id: contactId, data: { firstName: "Zwischenzeitlich geändert" } })); }
      const result = await client.mutate(path, input, options);
      if (loseAck && !result[1]) { loseAck = false; return [null, new Error("Synthetic lost address acknowledgement")]; }
      return result;
    }
    return client.mutate(path, input, options);
  }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  let stage = "migration baseline";
  const sorted = <T extends { id: string }>(values: T[]) => values.slice().sort((a, b) => a.id.localeCompare(b.id));
  try {
    assert.deepEqual(sorted(await required(business.query("customers.list", {}))), sorted(customers));
    assert.equal(keys.includes(CONTACT_COLLECTION.domain), false, "Customer reads do not request a contact key");
    assert.equal(keys.some(domain => domain.includes("products")), false);
    assert.deepEqual(sorted(await required(business.query("contacts.list", {}))), sorted(contacts));
    assert.ok((await required(business.query("customers.list", { search: "Pirckheimer" }))).some(row => row.id === customerId));
    assert.ok((await required(business.query("contacts.list", { search: "123456" }))).some(row => row.id === contactId));
    assert.ok((await required(business.query("customers.contacts.list", { customerId }))).some(row => row.id === contactId));
    assert.ok((await required(business.query("contacts.customers.list", { contactId }))).some(row => row.id === customerId));
    stage = "real edits and local subscriptions";
    const seen: string[][] = [];
    const subscription = business.streamQuery("customers.list", { search: "Verschlüsselter Adresskunde" }).subscribe(([rows, error]) => { if (!error && rows) seen.push(rows.map(row => row.name)); });
    let created: { id: string };
    try {
      created = await required(business.mutate("customers.create", { name: "Verschlüsselter Adresskunde", salutation: " Firma ",
        address: { streetAddress: " Musterstraße 12 ", city: "Nürnberg" }, emailAddresses: [{ email: "info@adresskunde.example" }] }));
      await until(() => seen.at(-1)?.includes("Verschlüsselter Adresskunde") ?? false, "address subscription");
      loseAck = true;
      await required(business.mutate("customers.update", { id: created.id, data: { name: "Verschlüsselter Adresskunde geändert", phoneNumbers: [{ number: "+49 98765" }] } }));
      assert.equal(loseAck, false);
      assert.equal((await required(business.query("customers.get", { id: created.id }))).address?.streetAddress, "Musterstraße 12");
      falseAck = true;
      assert.ok((await business.mutate("customers.update", { id: created.id, data: { name: "Unbestätigte Adressänderung" } }))[1]);
      assert.equal((await required(business.query("customers.get", { id: created.id }))).name, "Verschlüsselter Adresskunde geändert");
      const count = requests.filter(value => (value as { path: string }).path === "zerotrust.objects.batch").length;
      assert.ok((await business.mutateDynamic("customers.update", { id: created.id, data: { address: { city: "Nürnberg" } } }))[1]);
      assert.equal(requests.filter(value => (value as { path: string }).path === "zerotrust.objects.batch").length, count);
      const person = await required(business.mutate("contacts.create", { firstName: "Klara", lastName: "Verschlüsselter Kontakt" }));
      await required(business.mutate("customers.contacts.set", { customerId: created.id, contactIds: [person.id, person.id] }));
      assert.deepEqual((await required(business.query("customers.contacts.list", { customerId: created.id }))).map(row => row.id), [person.id]);
      stage = "cross-instance reference race";
      race = true;
      assert.ok((await business.mutate("customers.contacts.add", { customerId: created.id, contactId }))[1], "A contact change after validation must reject the whole relation write");
      assert.deepEqual((await required(business.query("customers.contacts.list", { customerId: created.id }))).map(row => row.id), [person.id]);
      await required(business.mutate("customers.contacts.add", { customerId: created.id, contactId }));
      await required(business.mutate("customers.contacts.remove", { customerId: created.id, contactId }));
      stage = "fresh reopening and deletion";
      await other.invalidate("customers.list");
      assert.equal((await required(other.query("customers.get", { id: created.id }))).name, "Verschlüsselter Adresskunde geändert");
      await required(business.mutate("contacts.delete", { id: person.id }));
      assert.deepEqual(await required(business.query("customers.contacts.list", { customerId: created.id })), []);
      await required(business.mutate("customers.delete", { id: created.id }));
      assert.ok((await business.query("customers.get", { id: created.id }))[1]);
      assert.equal((await required(business.query("customers.list", {}))).some(row => row.id === created.id), false);
    } finally { subscription.unsubscribe(); }
    for (const canary of ["Verschlüsselter Adresskunde", "Musterstraße 12", "info@adresskunde.example", "Unbestätigte Adressänderung", "Verschlüsselter Kontakt"])
      assert.equal(JSON.stringify(requests).includes(canary), false, "Address business values never enter ordinary API requests");
    // Extra read guards require an explicit current read right; the member
    // fixture exercises denied guards separately after invitation certification.
    const collection = await protectedCollection(client, CUSTOMER_COLLECTION, signal);
    try {
      const object = (await collection.read()).find(item => item.envelope.object === CUSTOMER_COLLECTION.prefix + customerId)!;
      const packet = await collection.packet(object.envelope.object, object.value, object.envelope);
      assert.ok((await client.mutate("zerotrust.objects.batch", { objects: [packet], heads: [{ domain: CONTACT_COLLECTION.domain, sequence: "0" }] }))[1], "The written area's head cannot be omitted");
    } finally { collection.close(); }
  } catch (cause) { throw new Error(`Protected address book failed at ${stage}`, { cause }); }
  finally { business.dispose(); other.dispose(); }
  console.log("Protected address book verified: legacy customer/contact equality, separate keys, address/channel search, existing API calls, subscriptions, durable CRUD, linked contacts, cross-instance read guards, lost acknowledgement and plaintext-free requests.");
}
