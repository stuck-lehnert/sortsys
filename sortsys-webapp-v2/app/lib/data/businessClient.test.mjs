import { afterEach, expect, test } from "bun:test";
import { createClient } from "@sortsys/v2-client";
import {
  base64,
  createAccountVault,
  createIdentity,
  createRecoveryPhrase,
  createTenantSetup,
} from "@sortsys/zerotrust/sortsys";
import { acceptVault, lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import { ramCache } from "./ramCache";
import { announceDataChanges } from "./runtime/changes";
import { duckDriver } from "./testing/duckDriver.mjs";

let setup = null;
afterEach(async () => {
  setup = null;
  await lockCryptoSession();
});

async function account() {
  const identity = await createIdentity();
  ({ setup } = await createTenantSetup(
    "client-test",
    "user:1",
    identity,
    createRecoveryPhrase(),
  ));
  const key = base64(crypto.getRandomValues(new Uint8Array(64)));
  const vault = await createAccountVault(
    key,
    "client-test",
    "user:1",
    identity,
    {
      recoveryGeneration: setup.authority.generation,
      recoverySigningKey: setup.authority.recoverySigningKey,
    },
  );
  await acceptVault(key, vault, "owner", false);
}
function raw() {
  const requests = [];
  const base = createClient(
    "https://private-client.test",
    "business-client-test",
    {
      cache: ramCache(),
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: init?.body });
        const replies = new URL(String(url)).pathname
          .slice(1)
          .split(",")
          .map((path) => {
            let value = { success: true };
            if (setup) {
              if (path === "zerotrust.access.snapshot") {
                value = {
                  subject: "user:1",
                  username: "owner",
                  history: {
                    authorities: [
                      { certificate: setup.authority, transition: null },
                    ],
                    identities: [setup.owner],
                  },
                  policy: setup.policy,
                  origins: [],
                  domains: [],
                  snapshot: "fixture-access-snapshot",
                  after: null,
                  unchanged: false,
                };
              } else if (path === "auth.sessionInfo") {
                value = {
                  user: { id: "1", username: "owner", locale: "de" },
                  roles: [":admin"],
                };
              } else if (path === "zerotrust.trust.history") {
                value = {
                  authorities: [
                    { certificate: setup.authority, transition: null },
                  ],
                  identities: [setup.owner],
                };
              } else if (path === "zerotrust.events.open") {
                value = {
                  ticket: "disposable-test-ticket",
                  subject: "user:1",
                  generation: setup.authority.generation,
                };
              } else if (path === "zerotrust.policy.get") {
                value = setup.policy;
              } else if (path === "zerotrust.creations.list") {
                value = [];
              }
            }
            return { result: { data: { json: value } } };
          });
        return new Response(JSON.stringify(replies));
      },
    },
  );
  base.setToken("synthetic-test-token");
  return { base, requests };
}

test("typed cryptographic procedures cross the business facade without a second hand-maintained allowlist", async () => {
  await account();
  const { base, requests } = raw();
  const facade = createBusinessClient(base);
  try {
    const queries = [
      ["zerotrust.keyAuthorities.get", { signature: "public-certificate" }],
      [
        "zerotrust.keyAuthorities.forArea",
        { scope: "catalog:products", facet: "master-data" },
      ],
      ["zerotrust.keyAuthorities.forAreas", { areas: [] }],
      [
        "zerotrust.keys.history",
        { domain: "catalog:products:master-data", generations: ["1"] },
      ],
      [
        "zerotrust.identities.recipients",
        { scope: "catalog:products", facet: "master-data", after: null },
      ],
    ];
    for (const [path, input] of queries) {
      const [, error] = await facade.queryDynamic(path, input, {
        strategy: "network-only",
      });
      expect(error).toBeNull();
      expect(
        requests.some((request) =>
          new URL(request.url).pathname.includes(path),
        ),
      ).toBe(true);
    }
    const [, error] = await facade.mutate("zerotrust.keyAuthorities.register", {
      authorities: [],
    });
    expect(error).toBeNull();
    expect(
      requests.some((request) =>
        new URL(request.url).pathname.includes(
          "zerotrust.keyAuthorities.register",
        ),
      ),
    ).toBe(true);
    for (const [method, path] of [
      ["queryDynamic", "zerotrust.notRegistered"],
      ["queryDynamic", "zerotrust.keyAuthorities.register"],
      ["mutateDynamic", "zerotrust.keyAuthorities.forAreas"],
      ["queryDynamic", "business.notRegistered"],
    ]) {
      const start = requests.length;
      const [, denied] = await facade[method](path, {});
      expect(denied?.code).toBe("UNKNOWN_CLIENT_OPERATION");
      expect(
        requests
          .slice(start)
          .some((request) =>
            new URL(request.url).pathname.slice(1).split(",").includes(path),
          ),
      ).toBe(false);
    }
  } finally {
    facade.dispose();
  }
});
function products() {
  let item = {
    id: "1",
    customId: 1,
    name: "Profil",
    description: "Fensterlaibung",
    brand: null,
    baseUnit: "m",
    otherUnits: {},
    regieReportName: null,
    categories: [],
  };
  let refreshes = 0,
    closes = 0;
  return {
    async list() {
      return [structuredClone(item)];
    },
    async get() {
      return structuredClone(item);
    },
    async create(input) {
      item = { ...item, ...input };
      return { id: item.id };
    },
    async update(input) {
      item = { ...item, ...input.data };
      return { success: true };
    },
    async categories() {
      return item.categories.slice();
    },
    async units() {
      return ["m"];
    },
    async brands() {
      return [];
    },
    async prices() {
      return [];
    },
    async suggestNextCustomId() {
      return 2;
    },
    async setCategories(_id, labels) {
      item.categories = labels;
      return { success: true };
    },
    async tag(_id, label) {
      item.categories.push(label);
      return { success: true };
    },
    async untag(_id, label) {
      item.categories = item.categories.filter((value) => value !== label);
      return { success: true };
    },
    async refresh() {
      refreshes++;
    },
    async close() {
      closes++;
    },
    counts() {
      return { refreshes, closes };
    },
  };
}

test("parallel local queries share unfinished work but receive independent values and no completed cache", async () => {
  await account();
  const { base } = raw();
  const store = products();
  let release;
  let started;
  let calls = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  store.list = async () => {
    calls++;
    started();
    await held;
    return [{ name: "Profil", categories: [] }];
  };
  const client = createBusinessClient(base, {
    openProducts: async () => store,
  });
  try {
    const first = client.query("products.list", {});
    const second = client.queryDynamic("products.list", {});
    await entered;
    expect(calls).toBe(1);
    release();
    const [[left, leftError], [right, rightError]] = await Promise.all([
      first,
      second,
    ]);
    expect(leftError).toBeNull();
    expect(rightError).toBeNull();
    left[0].categories.push("local edit");
    expect(right[0].categories).toEqual([]);
    await client.query("products.list", {});
    expect(calls).toBe(2);
  } finally {
    release();
    client.dispose();
  }
});

test("an announced change prevents a new caller from joining an old unfinished local read", async () => {
  await account();
  const { base } = raw();
  const store = products();
  let release;
  let started;
  let calls = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  store.list = async () => {
    calls++;
    if (calls === 1) {
      started();
      await held;
      return [{ name: "Before the change" }];
    }
    return [{ name: "After the change" }];
  };
  const client = createBusinessClient(base, {
    openProducts: async () => store,
  });
  try {
    const previous = client.query("products.list", {});
    await entered;
    announceDataChanges(base, new Set(["catalog:products:master-data"]));
    const [current, error] = await client.query("products.list", {});
    expect(error).toBeNull();
    expect(current).toEqual([{ name: "After the change" }]);
    expect(calls).toBe(2);
    release();
    expect((await previous)[0]).toEqual([{ name: "Before the change" }]);
  } finally {
    release();
    client.dispose();
  }
});

test("saving visit preferences preserves unrelated in-flight reads", async () => {
  await account();
  const { base } = raw();
  const store = products();
  let release;
  let started;
  let calls = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  store.list = async () => {
    calls++;
    started();
    await held;
    return [{ name: "Profil" }];
  };
  const client = createBusinessClient(base, {
    openProducts: async () => store,
  });
  try {
    const first = client.query("products.list", {});
    await entered;
    announceDataChanges(base, new Set(["preferences:user:1:master-data"]));
    // Cross both the synchronous invalidation and the queued subscription notice.
    await new Promise((resolve) => queueMicrotask(resolve));
    const second = client.query("products.list", {});
    release();
    const results = await Promise.all([first, second]);
    expect(results.map(([value, error]) => ({ value, error }))).toEqual([
      { value: [{ name: "Profil" }], error: null },
      { value: [{ name: "Profil" }], error: null },
    ]);
    expect(calls).toBe(1);
  } finally {
    release();
    client.dispose();
  }
});

test("project subscriptions refresh for project and policy changes, not visit preferences", async () => {
  await account();
  const { base } = raw();
  const client = createBusinessClient(base, { productDriver: duckDriver });
  let subscription;
  const results = [];
  let nextResult;
  let received = new Promise((resolve) => {
    nextResult = resolve;
  });
  try {
    subscription = client
      .streamQuery("projects.list", {})
      .subscribe((value) => {
        results.push(value);
        nextResult();
      });
    await received;
    expect(results).toEqual([[[], null]]);

    announceDataChanges(base, new Set(["preferences:user:1:master-data"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(results).toHaveLength(1);

    received = new Promise((resolve) => {
      nextResult = resolve;
    });
    announceDataChanges(base, new Set(["project:1:master-data"]));
    await received;
    expect(results).toHaveLength(2);

    received = new Promise((resolve) => {
      nextResult = resolve;
    });
    announceDataChanges(base, undefined, { control: true, revalidate: true });
    await received;
    expect(results).toHaveLength(3);
    expect(
      results.every(([value, error]) => error === null && value.length === 0),
    ).toBe(true);
  } finally {
    subscription?.unsubscribe();
    client.dispose();
  }
});

test("explicit product invalidation refreshes product subscribers without restarting project subscriptions", async () => {
  await account();
  const { base } = raw();
  const store = products();
  const client = createBusinessClient(base, {
    openProducts: async () => store,
    productDriver: duckDriver,
  });
  const subscriptions = [];
  const projectResults = [];
  const productResults = [];
  try {
    await Promise.all([
      new Promise((resolve) => {
        subscriptions.push(
          client.streamQuery("projects.list", {}).subscribe((reply) => {
            projectResults.push(reply);
            resolve();
          }),
        );
      }),
      new Promise((resolve) => {
        subscriptions.push(
          client.streamQuery("products.get", { id: "1" }).subscribe((reply) => {
            productResults.push(reply);
            resolve();
          }),
        );
      }),
    ]);
    expect(projectResults).toHaveLength(1);
    expect(productResults).toHaveLength(1);
    await client.invalidate("products.list");
    // Await shared reads so any incorrectly restarted subscription also has
    // time to deliver; this assertion does not depend on an arbitrary sleep.
    const replies = await Promise.all([
      client.query("projects.list", {}),
      client.query("products.get", { id: "1" }),
    ]);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(replies.every(([, error]) => error === null)).toBe(true);
    expect(store.counts().refreshes).toBe(1);
    expect(productResults).toHaveLength(2);
    expect(projectResults).toHaveLength(1);
  } finally {
    for (const subscription of subscriptions) subscription.unsubscribe();
    client.dispose();
  }
});

test("locking while a shared result is copied still prevents plaintext delivery", async () => {
  await account();
  const { base } = raw();
  const store = products();
  store.list = async () => [
    Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        void lockCryptoSession();
        return "Private value after lock";
      },
    }),
  ];
  const client = createBusinessClient(base, {
    openProducts: async () => store,
  });
  try {
    const [value, error] = await client.query("products.list", {});
    expect(value).toBeNull();
    expect(error).toBeInstanceOf(Error);
  } finally {
    client.dispose();
  }
});

test("seed-authorized recovery pages remain reachable without an unlocked account", async () => {
  await lockCryptoSession();
  const { base, requests } = raw();
  base.setToken(null);
  const client = createBusinessClient(base);
  try {
    const [, error] = await client.mutate("zerotrust.recovery.page", {
      tenant: "client-test",
      generation: "1",
      challengeId: "recovery:test",
      snapshot: "1.2.3",
      after: null,
      proof: base64(new Uint8Array(64)),
    });
    expect(error).toBeNull();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/zerotrust.recovery.page");
  } finally {
    client.dispose();
  }
});

test("unsupported typed, dynamic and subscribed business calls never reach the network", async () => {
  await account();
  const { base, requests } = raw();
  const client = createBusinessClient(base);
  try {
    const marker = "Vertraulicher Kalkulationspreis 12345";
    const replies = await Promise.all([
      client.query("projects.deployments.list", { projectId: marker }),
      client.queryDynamic("users.vacations.list", { search: marker }),
      client.mutate("commercial.documents.save", { xml: marker }),
      client.mutateDynamic("zerotrust.missingRoute", { content: marker }),
      client.mutate("auth.setPassword", {
        username: "somebody-else",
        password: marker,
      }),
    ]);
    expect(
      replies.every(
        ([value, error]) => value === null && error instanceof Error,
      ),
    ).toBe(true);
    await new Promise((resolve) => {
      const subscription = client
        .streamQuery("productVendors.list", { search: marker })
        .subscribe(([value, error]) => {
          expect(value).toBeNull();
          expect(error).toBeInstanceOf(Error);
          resolve();
          queueMicrotask(() => subscription.unsubscribe());
        });
    });
    expect(requests).toEqual([]);
    expect((await client.query("auth.check", undefined))[1]).toBeNull();
    expect(requests.length).toBe(1);
    expect(JSON.stringify(requests)).not.toContain(marker);
  } finally {
    client.dispose();
  }
});

test("existing product API calls use the local store and refresh active subscriptions", async () => {
  await account();
  const { base, requests } = raw(),
    store = products();
  const client = createBusinessClient(base, {
    openProducts: async () => store,
  });
  let subscription;
  try {
    const values = [];
    let changed;
    const change = new Promise((resolve) => {
      changed = resolve;
    });
    subscription = client
      .streamQuery("products.get", { id: "1" })
      .subscribe(([value, error]) => {
        expect(error).toBeNull();
        values.push(value);
        if (value.description === "Neue Beschreibung") changed();
      });
    expect(
      (await client.query("products.list", { search: "Fenster" }))[0].length,
    ).toBe(1);
    await client.mutate("products.update", {
      id: "1",
      data: { description: "Neue Beschreibung" },
    });
    await change;
    expect(values.at(-1).description).toBe("Neue Beschreibung");
    expect(
      (
        await client.mutateDynamic("products.categories.set", {
          id: "1",
          categories: ["Fassade"],
        })
      )[1],
    ).toBeNull();
    expect(
      (await client.queryDynamic("products.get", { id: "1" }))[0].categories,
    ).toEqual(["Fassade"]);
    await client.invalidate("products.get");
    expect(store.counts().refreshes).toBe(1);
    expect(requests).toEqual([]);
  } finally {
    subscription?.unsubscribe();
    client.dispose();
  }
});

test("access observers restart against the replacement account lifetime after a reset", async () => {
  await account();
  const { base } = raw(),
    client = createBusinessClient(base),
    previous = client.dataSession.context();
  let observed, result;
  const stop = client.access.subscribe(() => {
    observed = client.dataSession.context();
    result = client.access.read().then(
      () => true,
      () => false,
    );
  });
  try {
    await client.clearCache();
    expect(previous.aborted).toBe(true);
    expect(observed).not.toBe(previous);
    expect(observed).toBe(client.files.context());
    expect(observed).toBe(client.dataSession.context());
    expect(await result).toBe(true);
  } finally {
    stop();
    client.dispose();
  }
});

test("policy revalidation preserves the data session while an account lock invalidates every observer", async () => {
  await account();
  const { base: transport } = raw();
  const foreignContext = AbortSignal.abort();
  const base = {
    ...transport,
    dataSession: {
      context: () => foreignContext,
      listenContext: () => () => {},
    },
  };
  const client = createBusinessClient(base);
  const previous = client.dataSession.context();
  expect(previous).not.toBe(foreignContext);
  const notifications = [];
  const stop = client.dataSession.listenContext(() => {
    notifications.push(client.dataSession.context());
  });
  try {
    announceDataChanges(base, undefined, { control: true, revalidate: true });
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(previous.aborted).toBe(false);
    expect(client.dataSession.context()).toBe(previous);
    expect(client.files.context()).toBe(previous);
    expect(notifications).toEqual([]);
    await lockCryptoSession();
    expect(previous.aborted).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toBe(client.dataSession.context());
    expect(notifications[0]).not.toBe(previous);
  } finally {
    stop();
    client.dispose();
  }
});

test("locking an account discards a still-running local response and closes its store", async () => {
  await account();
  const { base, requests } = raw(),
    store = products();
  let release, started;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  store.list = async () => {
    started();
    await waiting;
    return [{ name: "Must not survive sign-out" }];
  };
  const client = createBusinessClient(base, {
    openProducts: async () => store,
  });
  try {
    const pending = client.query("products.list", {});
    await entered;
    await lockCryptoSession();
    release();
    const [value, error] = await pending;
    expect(value).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(store.counts().closes).toBe(1);
    expect(requests).toEqual([]);
  } finally {
    client.dispose();
  }
});

test("a replacement bearer session discards old responses even before the account vault changes", async () => {
  await account();
  const { base } = raw(),
    store = products();
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  store.list = async () => {
    entered();
    await waiting;
    return [{ name: "Prior session" }];
  };
  const client = createBusinessClient(base, {
    openProducts: async () => store,
  });
  try {
    const pending = client.query("products.list", {});
    await started;
    base.setToken("replacement-session-token");
    release();
    const [data, error] = await pending;
    expect(data).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(store.counts().closes).toBe(1);
  } finally {
    client.dispose();
  }
});

test("requests waiting for synchronization cannot execute under a replacement bearer session", async () => {
  await account();
  const { base } = raw();
  let opened = 0;
  const client = createBusinessClient(base, {
    openProducts: async () => {
      opened++;
      return products();
    },
  });
  try {
    const read = client.query("products.list", {});
    const write = client.mutate("products.update", {
      id: "1",
      data: { name: "Prior session edit" },
    });
    base.setToken("replacement-session-token");
    for (const pending of [read, write]) {
      const [value, error] = await pending;
      expect(value).toBeNull();
      expect(error).toBeInstanceOf(Error);
    }
    expect(opened).toBe(0);
  } finally {
    client.dispose();
  }
});

test("a remote change refreshes each active read once after synchronization", async () => {
  await account();
  const { base } = raw();
  const store = products();
  let reads = 0;
  store.list = async () => [{ reads: ++reads }];
  const fingerprint = base64(new Uint8Array(32).fill(5));
  const previousSocket = globalThis.WebSocket;
  let socket;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      socket = this;
      queueMicrotask(() =>
        this.message({ type: "challenge", nonce: "disposable-challenge" }),
      );
    }
    message(value) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    send() {
      this.message({ type: "ready", fingerprint });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  };
  const client = createBusinessClient(base, {
    endpoint: "https://private-client.test",
    realtime: true,
    openProducts: async () => store,
  });
  const initial = Promise.withResolvers();
  const refreshed = Promise.withResolvers();
  const results = [];
  const subscription = client.streamQuery("products.list", {}).subscribe(
    ([rows, error]) => {
      if (error) {
        if (results.length === 0) initial.reject(error);
        else refreshed.reject(error);
        return;
      }
      results.push(rows);
      if (results.length === 1) initial.resolve();
      if (results.length === 2) refreshed.resolve();
    },
  );
  try {
    await initial.promise;
    socket.message({
      type: "changed",
      reset: false,
      all: false,
      control: false,
      domains: { "catalog:products:master-data": "2" },
      fingerprint,
    });
    await refreshed.promise;
    expect(store.counts().refreshes).toBe(1);
    expect(results).toEqual([[{ reads: 1 }], [{ reads: 2 }]]);
  } finally {
    subscription.unsubscribe();
    client.dispose();
    globalThis.WebSocket = previousSocket;
  }
});

test("unknown actions and malformed inputs carry distinct errors without migration states", async () => {
  await account();
  const { base, requests } = raw();
  const client = createBusinessClient(base);
  try {
    const [, unknown] = await client.queryDynamic("business.unknown", {});
    expect(unknown?.data?.code).toBe("UNKNOWN_CLIENT_OPERATION");
    expect(unknown?.data?.path).toBe("business.unknown");
    const [, invalid] = await client.query("products.get", {
      unsupportedField: true,
    });
    expect(invalid?.data?.code).toBe("BAD_REQUEST");
    const [, removed] = await client.queryDynamic("zerotrust.migration.read", {
      table: "users",
    });
    expect(removed?.data?.code).toBe("UNKNOWN_CLIENT_OPERATION");
    expect(requests).toEqual([]);
  } finally {
    client.dispose();
  }
});
