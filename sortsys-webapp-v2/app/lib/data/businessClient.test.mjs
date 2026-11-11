import { afterEach, expect, test } from "bun:test";
import { createClient } from "@sortsys/v2-client";
import { base64, createAccountVault, createIdentity } from "@sortsys/zerotrust";
import { acceptVault, lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import { ramCache } from "./ramCache";

afterEach(() => lockCryptoSession());

async function account() {
  const identity = await createIdentity();
  const key = base64(crypto.getRandomValues(new Uint8Array(64)));
  const vault = await createAccountVault(key, "client-test", "owner", identity, {});
  await acceptVault(key, vault, false);
}
function raw() {
  const requests = [];
  const base = createClient("https://private-client.test", "business-client-test", {
    cache: ramCache(), fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify([{ result: { data: { json: { success: true } } } }]));
    },
  });
  base.setToken("synthetic-test-token");
  return { base, requests };
}
function products() {
  let item = { id: "1", customId: 1, name: "Profil", description: "Fensterlaibung", brand: null, baseUnit: "m", otherUnits: {}, regieReportName: null, categories: [] };
  let refreshes = 0, closes = 0;
  return {
    async list() { return [structuredClone(item)]; }, async get() { return structuredClone(item); },
    async create(input) { item = { ...item, ...input }; return { id: item.id }; },
    async update(input) { item = { ...item, ...input.data }; return { success: true }; },
    async categories() { return item.categories.slice(); }, async units() { return ["m"]; }, async brands() { return []; },
    async prices() { return []; }, async suggestNextCustomId() { return 2; },
    async setCategories(_id, labels) { item.categories = labels; return { success: true }; },
    async tag(_id, label) { item.categories.push(label); return { success: true }; },
    async untag(_id, label) { item.categories = item.categories.filter(value => value !== label); return { success: true }; },
    async refresh() { refreshes++; }, async close() { closes++; },
    counts() { return { refreshes, closes }; },
  };
}

test("unsupported typed, dynamic and subscribed business calls never reach the network", async () => {
  await account();
  const { base, requests } = raw();
  const client = createBusinessClient(base);
  try {
    const marker = "Vertraulicher Kalkulationspreis 12345";
    const replies = await Promise.all([
      client.query("regieReports.list", { projectId: marker }),
      client.queryDynamic("users.list", { search: marker }),
      client.mutate("deliveryNotes.delete", { id: "1" }),
      client.mutate("commercial.documents.save", { xml: marker }),
      client.mutateDynamic("zerotrust.missingRoute", { content: marker }),
      client.mutateDynamic("auth.setPassword", { username: "somebody-else", password: marker }),
    ]);
    expect(replies.every(([value, error]) => value === null && error instanceof Error)).toBe(true);
    await new Promise(resolve => {
      const subscription = client.streamQuery("productVendors.list", { search: marker }).subscribe(([value, error]) => {
        expect(value).toBeNull(); expect(error).toBeInstanceOf(Error);
        resolve(); queueMicrotask(() => subscription.unsubscribe());
      });
    });
    expect(requests).toEqual([]);
    expect((await client.query("auth.check", undefined))[1]).toBeNull();
    expect(requests.length).toBe(1);
    expect(JSON.stringify(requests)).not.toContain(marker);
  } finally { client.dispose(); }
});

test("existing product API calls use the local store and refresh active subscriptions", async () => {
  await account();
  const { base, requests } = raw(), store = products();
  const client = createBusinessClient(base, { openProducts: async () => store });
  let subscription;
  try {
    const values = [];
    let changed;
    const change = new Promise(resolve => { changed = resolve; });
    subscription = client.streamQuery("products.get", { id: "1" }).subscribe(([value, error]) => {
      expect(error).toBeNull(); values.push(value);
      if (value.description === "Neue Beschreibung") changed();
    });
    expect((await client.query("products.list", { search: "Fenster" }))[0].length).toBe(1);
    await client.mutate("products.update", { id: "1", data: { description: "Neue Beschreibung" } });
    await change;
    expect(values.at(-1).description).toBe("Neue Beschreibung");
    expect((await client.mutateDynamic("products.categories.set", { id: "1", categories: ["Fassade"] }))[1]).toBeNull();
    expect((await client.queryDynamic("products.get", { id: "1" }))[0].categories).toEqual(["Fassade"]);
    await client.invalidate("products.get");
    expect(store.counts().refreshes).toBe(1);
    expect(requests).toEqual([]);
  } finally { subscription?.unsubscribe(); client.dispose(); }
});

test("access observers restart against the replacement account lifetime after a reset", async () => {
  await account();
  const { base } = raw(), client = createBusinessClient(base), previous = client.files.context();
  let observed, result;
  const stop = client.access.subscribe(() => { observed = client.files.context(); result = client.access.read().then(() => true, () => false); });
  try {
    await client.clearCache();
    expect(previous.aborted).toBe(true); expect(observed).not.toBe(previous);
    expect(observed).toBe(client.files.context()); expect(await result).toBe(true);
  } finally { stop(); client.dispose(); }
});

test("locking an account discards a still-running local response and closes its store", async () => {
  await account();
  const { base, requests } = raw(), store = products();
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  store.list = async () => { started(); await waiting; return [{ name: "Must not survive sign-out" }]; };
  const client = createBusinessClient(base, { openProducts: async () => store });
  try {
    const pending = client.query("products.list", {});
    await entered; await lockCryptoSession(); release();
    const [value, error] = await pending;
    expect(value).toBeNull(); expect(error).toBeInstanceOf(Error);
    expect(store.counts().closes).toBe(1);
    expect(requests).toEqual([]);
  } finally { client.dispose(); }
});

test("a replacement bearer session discards old responses even before the account vault changes", async () => {
  await account();
  const { base } = raw(), store = products();
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  store.list = async () => { entered(); await waiting; return [{ name: "Prior session" }]; };
  const client = createBusinessClient(base, { openProducts: async () => store });
  try {
    const pending = client.query("products.list", {}); await started;
    base.setToken("replacement-session-token"); release();
    const [data, error] = await pending;
    expect(data).toBeNull(); expect(error).toBeInstanceOf(Error);
    expect(store.counts().closes).toBe(1);
  } finally { client.dispose(); }
});
