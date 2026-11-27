import assert from "node:assert/strict";
import { createClient, type Client, type QueryInput } from "@sortsys/v2-client";
import { initializeTenant } from "../../app/lib/crypto/initializeTenant";
import { lockCryptoSession, signIn } from "../../app/lib/crypto/session";
import { commitOwner, prepareOwner, tenantSetupRequest } from "../../app/lib/crypto/tenantSetup";
import { CUSTOMER_COLLECTION } from "../../app/lib/data/addressBook";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { required } from "../../app/lib/data/protectedObjects";
import { duckDriver } from "../../app/lib/data/testing/duckDriver.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoint = process.env.SORTSYS_AUTH_E2E_API;
const operatorPassword = process.env.SORTSYS_AUTH_E2E_OPERATOR_PASSWORD;
assert.ok(endpoint && operatorPassword);

const api = new URL(endpoint);
assert.equal(api.protocol, "http:");
assert.equal(api.hostname, "127.0.0.1");
assert.ok(api.port);
assert.equal(api.href, `${api.origin}/`);

const credentials = {
  tenant: `offer-list-${crypto.randomUUID()}`,
  username: "owner",
  password: crypto.randomUUID(),
};
const operator = createClient(api.href, "offer-list-test-operator");
const owner = createClient(api.href, "offer-list-test-owner");
const options = {
  productDriver: duckDriver,
  endpoint: api.href,
  realtime: false,
};
const business = createBusinessClient(owner, options);

const names = ["Atlas Dachservice", "Zeder Gebäudetechnik"];
const offers: { id: string; customerId: string; name: string }[] = [];

try {
  const session = await required(operator.mutate("admin.login", {
    tenant: null,
    password: operatorPassword,
  }));
  operator.setToken(session.token);

  const setup = await tenantSetupRequest(credentials.tenant);
  await required(operator.mutate("admin.tenants.create", setup.request));

  const draft = await prepareOwner(owner, setup.link, credentials.username, credentials.password);
  await commitOwner(owner, draft);
  await initializeTenant(owner, new AbortController().signal, duckDriver);

  for (const [index, name] of names.entries()) {
    const { id: customerId } = await required(business.mutate("customers.create", { name }));
    const { id } = await required(business.mutate("commercial.cases.create", {
      title: `Fassadensanierung ${index + 1}`,
      kind: "offer",
      customerId,
      scopeItemIds: [],
    }));
    offers.push({ id, customerId, name });
  }
} finally {
  business.dispose();
  await lockCryptoSession();
  owner.setToken(null);
  operator.setToken(null);
}

type Page = QueryInput<"zerotrust.objects.list">;
async function readFirstPage(search?: string) {
  const client = createClient(api.href, "offer-list-test-reader");
  const objectIds: string[] = [];
  let fullPages = 0;

  const countPage = (page: Page) => {
    if (page.domain === CUSTOMER_COLLECTION.domain && !page.headOnly) fullPages++;
  };

  const observed: Client = {
    ...client,
    query(path, input, settings) {
      if (path === "zerotrust.objects.list") countPage(input as Page);
      if (path === "zerotrust.objects.pages") {
        (input as QueryInput<"zerotrust.objects.pages">).selections.forEach(countPage);
      }
      if (path === "zerotrust.access.snapshot") {
        const request = input as QueryInput<"zerotrust.access.snapshot"> | undefined;
        request?.pages?.selections.forEach(countPage);
      }
      if (path === "zerotrust.objects.get") {
        const { id } = input as QueryInput<"zerotrust.objects.get">;
        if (id.startsWith(CUSTOMER_COLLECTION.prefix)) objectIds.push(id);
      }
      if (path === "zerotrust.objects.getMany") {
        const { domain, ids } = input as QueryInput<"zerotrust.objects.getMany">;
        if (domain === CUSTOMER_COLLECTION.domain) objectIds.push(...ids);
      }
      return client.query(path, input, settings);
    },
  };
  const reader = createBusinessClient(observed, options);

  try {
    await signIn(observed, credentials);
    const rows = await required(reader.query("commercial.cases.list", { limit: 1n, search }));
    return { rows, fullPages, objectIds };
  } finally {
    reader.dispose();
    await lockCryptoSession();
    client.setToken(null);
  }
}

const first = await readFirstPage();
const found = await readFirstPage("atlas dach");

assert.deepEqual(first.rows.map(({ id, customerName }) => ({ id, customerName })), [
  { id: offers[1]!.id, customerName: offers[1]!.name },
]);
assert.deepEqual(found.rows.map(({ id, customerName }) => ({ id, customerName })), [
  { id: offers[0]!.id, customerName: offers[0]!.name },
]);

console.log(JSON.stringify({
  browsing: { fullPages: first.fullPages, selected: first.objectIds.length },
  search: { fullPages: found.fullPages, selected: found.objectIds.length },
}));

assert.equal(first.fullPages, 0, "Browsing must not read a full customer catalog page");
assert.deepEqual(first.objectIds, [CUSTOMER_COLLECTION.prefix + offers[1]!.customerId]);
assert.equal(found.fullPages, 0, "Searching only needs customers linked to the offers");
assert.deepEqual(
  [...found.objectIds].sort(),
  offers.map(({ customerId }) => CUSTOMER_COLLECTION.prefix + customerId).sort(),
);
