import { afterEach, expect, test } from "bun:test";
import { base64 } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { COMMERCIAL_FACETS, commercialCollection } from "./commercialAreas";
import {
  documentMessageObject,
  openDocumentMessages,
} from "./documentMessages";
import { connectProtectedGaebLive } from "./gaebLive";
import { announceDataChanges } from "./runtime/changes";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { isKeyEnvelopeQuery } from "./testing/keyQueries.mjs";

afterEach(() => lockCryptoSession());

test("a live channel loads only its required key domains and the document header domain", async () => {
  const selected = commercialCollection("4", "offer-prices");
  const header = commercialCollection("4", "master-data");
  const other = commercialCollection("6", "master-data");
  const tenant = await protectedTenant([selected, header, other]);
  const messages = await openDocumentMessages(
    tenant.client,
    { scope: selected.scope, document: "5", facet: selected.facet },
    new AbortController().signal,
  );
  try {
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.access.snapshot"),
    ).toEqual([
      {
        path: "zerotrust.access.snapshot",
        input: { domains: [selected.domain, header.domain] },
      },
    ]);
    expect(
      tenant.calls.some((call) => call.path === "zerotrust.creations.list"),
    ).toBe(false);
    expect(messages.canWrite).toBe(true);
  } finally {
    messages.close();
  }
});

test("GAEB shares the transport until access changes and stops opening after abort", async () => {
  const scope = commercialCollection("4", "scope");
  const header = commercialCollection("4", "master-data");
  const tenant = await protectedTenant([scope, header]);
  const query = tenant.client.query.bind(tenant.client);
  const sent = [];

  tenant.client.query = async (path, input, options) => {
    if (path !== "zerotrust.documents.messages.pages") return query(path, input, options);

    const pages = input.selections.map(({ after }) => ({
      after, more: false, messages: [], presence: [],
    }));
    return [pages, null];
  };
  tenant.client.mutate = async (path, input) => {
    expect(path).toBe("zerotrust.documents.messages.post");
    sent.push(input.kind);
    return [{ success: true }, null];
  };

  const connections = [];
  // Exercise the real encrypted transport, without an XML editor in Bun.
  const sharedFields = {
    enableFacets() {},
    acknowledge() {},
    connectFacet(facet, _, writable) { connections.push({ facet, writable }); },
    disconnectFacet() {},
    beginReceive: () => ({ commit() {}, destroy() {} }),
    cursor: (selection) => selection,
    participants: (people) => people,
  };
  const controller = new AbortController();
  const statuses = [];
  const connection = connectProtectedGaebLive(tenant.client, {
    room: { scope: scope.scope, document: "5" },
    initial: { xml: "", fileName: "Probe.x83", version: 1n, canEdit: true },
    readableFacets: ["scope"],
    sharedFields,
    signal: controller.signal,
    name: "Testperson",
    onParticipants() {},
    onStatus: (status) => statuses.push(status),
  });
  const opens = () =>
    tenant.calls.filter((call) => call.path === "zerotrust.access.snapshot").length;

  try {
    expect(await Promise.all([connection.flush(), connection.flush()])).toEqual([
      { scope: "0" }, { scope: "0" },
    ]);
    expect(opens()).toBe(1);

    announceDataChanges(tenant.client, undefined, { control: true });
    expect(await connection.flush()).toEqual({ scope: "0" });
    expect(opens()).toBe(2);
    expect(statuses).toContain("offline");
    expect(statuses.at(-1)).toBe("online");

    controller.abort();
    await expect(connection.flush()).rejects.toThrow();
    expect(opens()).toBe(2);
    expect(sent).toEqual(["presence", "presence"]);
    expect(connections).toEqual([
      { facet: "scope", writable: true }, { facet: "scope", writable: true },
    ]);
  } finally {
    connection.close();
  }
});

async function fixture(readOnlyFacet) {
  const tenant = await protectedTenant(
    COMMERCIAL_FACETS.map((facet) => commercialCollection("4", facet)),
    (area) => (area.facet === readOnlyFacet ? ["read"] : ["read", "update"]),
  );
  let last;
  tenant.client.mutate = async (path, input) => {
    if (path !== "zerotrust.documents.messages.post")
      throw new Error(`Unexpected mutation: ${path}`);
    // Simulate a dishonest store, so the reader's cryptographic author check
    // must reject updates signed by a certified reader without edit rights.
    last = { ...structuredClone(input), sequence: "1" };
    delete last.room;
    return [{ success: true }, null];
  };
  const messages = await openDocumentMessages(
    tenant.client,
    { scope: "commercial:4", document: "5", facet: "opaque" },
    new AbortController().signal,
  );
  return { messages, last: () => last };
}

test("every live encryption layer checks the author's signed update permission, not just their identity", async () => {
  const session = await fixture("billing");
  try {
    expect(session.messages.canWrite).toBe(false);
    await session.messages.post("update", { data: "Geheimer Text 827491" });
    await expect(session.messages.open(session.last())).rejects.toThrow(
      "Die geschützten Daten konnten nicht geprüft werden.",
    );
    await session.messages.post("presence", { selection: { field: null } });
    expect((await session.messages.open(session.last())).value).toEqual({
      selection: { field: null },
    });
  } finally {
    session.messages.close();
  }
});

test("live-layer key reads overlap within a bounded group before sending and opening", async () => {
  const tenant = await protectedTenant(
    COMMERCIAL_FACETS.map((facet) => commercialCollection("4", facet)),
  );
  const room = { scope: "commercial:4", document: "5", facet: "opaque" };
  const signal = new AbortController().signal;
  let stored;
  tenant.client.mutate = async (_path, packet) => {
    stored = { ...structuredClone(packet), sequence: "1" };
    return [{ success: true }, null];
  };
  const writer = await openDocumentMessages(tenant.client, room, signal);
  let reader;
  try {
    const query = tenant.client.query;
    let active = 0;
    let maximum = 0;
    tenant.client.query = async (path, input, options) => {
      if (!isKeyEnvelopeQuery(path)) return query(path, input, options);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await Bun.sleep(2);
        return await query(path, input, options);
      } finally {
        active--;
      }
    };
    await writer.post("update", { data: "Vertraulicher mehrschichtiger Text" });
    const writeMaximum = maximum;
    maximum = 0;
    reader = await openDocumentMessages(tenant.client, room, signal);
    expect((await reader.open(stored)).value.data).toBe(
      "Vertraulicher mehrschichtiger Text",
    );
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(writeMaximum).toBeGreaterThan(1);
    expect(writeMaximum).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
    expect(JSON.stringify(stored)).not.toContain(
      "Vertraulicher mehrschichtiger Text",
    );
  } finally {
    writer.close();
    reader?.close();
  }
});

test("a scope-only member exchanges text without obtaining or querying financial keys", async () => {
  const area = commercialCollection("4", "scope");
  const tenant = await protectedTenant([area]);
  const room = { scope: area.scope, document: "5", facet: "scope" };
  let stored;
  tenant.client.mutate = async (_path, packet) => {
    stored = { ...packet, sequence: "1" };
    return [{ success: true }, null];
  };
  const text = await openDocumentMessages(
    tenant.client,
    room,
    new AbortController().signal,
  );
  try {
    expect(text.canWrite).toBe(true);
    await text.post("update", {
      facet: "scope",
      data: "Vertraulicher Text 572918",
    });
    expect((await text.open(stored)).value.data).toBe(
      "Vertraulicher Text 572918",
    );
    const domains = tenant.calls
      .filter((call) => isKeyEnvelopeQuery(call.path))
      .map((call) => call.input.domain);
    expect(domains.length).toBeGreaterThan(0);
    expect(new Set(domains)).toEqual(new Set([area.domain]));
    expect(JSON.stringify(stored)).not.toContain("Vertraulicher Text 572918");
  } finally {
    text.close();
  }
});

test("the same retry key cannot rebind ciphertext to another content channel", async () => {
  const tenant = await protectedTenant(
    COMMERCIAL_FACETS.map((facet) => commercialCollection("4", facet)),
  );
  let stored;
  tenant.client.mutate = async (_path, packet) => {
    stored = { ...packet, sequence: "1" };
    return [{ success: true }, null];
  };
  const room = { scope: "commercial:4", document: "5", facet: "billing" };
  const signal = new AbortController().signal;
  const billing = await openDocumentMessages(tenant.client, room, signal);
  const scope = await openDocumentMessages(
    tenant.client,
    { ...room, facet: "scope" },
    signal,
  );
  try {
    await billing.post("update", { facet: "billing", data: "Preis 912.53" });
    await expect(scope.open(stored)).rejects.toThrow();
    const billingId = documentMessageObject(room, "update", stored.key);
    const scopeId = documentMessageObject(
      { ...room, facet: "scope" },
      "update",
      stored.key,
    );
    expect(scopeId).not.toBe(billingId);
    expect((await billing.open(stored)).value.data).toBe("Preis 912.53");
  } finally {
    billing.close();
    scope.close();
  }
});

test("live packets bind room, purpose, author and ciphertext before exposing their contents", async () => {
  const session = await fixture();
  try {
    await session.messages.post("update", {
      data: "Vertraulicher Inhalt 892461",
    });
    const original = session.last();
    expect((await session.messages.open(original)).value.data).toBe(
      "Vertraulicher Inhalt 892461",
    );
    for (const alter of [
      (message) => {
        message.kind = "presence";
      },
      (message) => {
        message.envelope.author = "user:2";
      },
      (message) => {
        message.envelope.signature = "A".repeat(86);
      },
      (message) => {
        message.authorityGeneration = "2";
      },
    ]) {
      const modified = structuredClone(original);
      alter(modified);
      await expect(session.messages.open(modified)).rejects.toThrow();
    }
  } finally {
    session.messages.close();
  }
});

test("restored live messages bind both encryption layers to the active content", async () => {
  const tenant = await protectedTenant([commercialCollection("4", "scope")]);
  const room = { scope: "commercial:4", document: "5", facet: "scope" };
  const query = tenant.client.query;
  const content = base64(crypto.getRandomValues(new Uint8Array(32)));
  tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.documents.messages.state")
      return [{ current: "0", checkpoint: null, content }, null];
    return query(path, input, options);
  };
  let message;
  tenant.client.mutate = async (_path, packet) => {
    message = { ...packet, sequence: "1" };
    return [{ success: true }, null];
  };
  const session = await openDocumentMessages(
    tenant.client,
    room,
    new AbortController().signal,
  );
  try {
    await session.post("update", { text: "Aktuelle Bearbeitung" });
    expect(message.content).toBe(content);
    expect(message.envelope.object.endsWith(`:${content}`)).toBe(true);
    expect((await session.open(message)).value.text).toBe(
      "Aktuelle Bearbeitung",
    );
    const other = base64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(
      session.open({ ...message, content: other }),
    ).rejects.toThrow();
  } finally {
    session.close();
  }
});
