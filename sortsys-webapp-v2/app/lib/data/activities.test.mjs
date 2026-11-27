import { afterEach, expect, spyOn, test } from "bun:test";
import {
  attestMigrationOrigin,
  compilePolicy,
  signPolicy,
} from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import {
  personnelCollection,
  personnelPart,
  newPersonnelProfile,
} from "./personnelData";
import { createProtectedActivity } from "./activities";
import { createBusinessClient } from "./businessClient";
import { splitLegacyActivity } from "./legacyActivityData";
import { row } from "./rowCodec.test.mjs";
import { financialCollection, financialObject } from "./projectFinancialData";
import { projectCollection } from "./projectData";
import { toolCollection, toolPart } from "./toolData";

afterEach(() => lockCryptoSession());

// Keep this fixture comparator independent of the application's comparator;
// the native integration tests also exercise the actual SQL ordering.
function compareHistoryEntriesNewestFirst(left, right) {
  const byTimestamp = compareIntegersNewestFirst(
    left.occurredMicros,
    right.occurredMicros,
  );
  if (byTimestamp !== 0) {
    return byTimestamp;
  }

  const byOriginalId = compareIntegersNewestFirst(left.orderId, right.orderId);
  if (byOriginalId !== 0) {
    return byOriginalId;
  }

  return compareIntegersNewestFirst(left.sequence, right.sequence);
}

function compareIntegersNewestFirst(left, right) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue > rightValue) {
    return -1;
  }
  if (leftValue < rightValue) {
    return 1;
  }
  return 0;
}

async function createActivityFixture(extraAreas = []) {
  const areas = [
    ...["master-data", "scope", "calculation"].map((facet) =>
      personnelCollection("2", facet),
    ),
    personnelCollection("1", "master-data"),
    ...extraAreas,
  ];
  const tenant = await protectedTenant(areas);
  const history = [];
  const queryOriginal = tenant.client.query;
  const returnedDomains = [];
  let policy = (await queryOriginal("zerotrust.policy.get"))[0];
  let sequenceNumber = 0;

  function currentAccess() {
    return { generation: "1", policyVersion: policy.version };
  }

  function visibleHistory() {
    const { signature, ...unsignedPolicy } = policy;
    const permissions = compilePolicy(unsignedPolicy, ["user:1"]);
    return history.filter((entry) =>
      permissions.allows(entry.envelope.scope, entry.envelope.facet, "read"),
    );
  }

  function withCurrentAccess(entry) {
    return { ...structuredClone(entry), access: currentAccess() };
  }

  function readHistoryEntry(input) {
    const entry = visibleHistory()
      .filter((candidate) => {
        if (candidate.envelope.object !== input.id) {
          return false;
        }
        if (!input.revision) {
          return true;
        }
        return candidate.envelope.revision === input.revision;
      })
      .at(-1);

    return entry ? withCurrentAccess(entry) : null;
  }

  function readHistoryPage(input) {
    const matchingEntries = visibleHistory().filter((entry) =>
      input.prefixes.some((prefix) => entry.envelope.object.startsWith(prefix)),
    );

    let latestSequence = 0n;
    for (const entry of matchingEntries) {
      const sequence = BigInt(entry.sequence);
      if (sequence > latestSequence) {
        latestSequence = sequence;
      }
    }

    const current = String(latestSequence);
    const total = String(matchingEntries.length);
    const snapshot = input.snapshot ?? current;
    const unchanged = input.known === current && input.knownTotal === total;
    const page = {
      access: currentAccess(),
      current,
      total,
      snapshot,
      after: null,
      afterMicros: null,
      afterOrder: null,
      changes: [],
      unchanged,
    };

    if (unchanged) {
      return page;
    }

    const cursor = matchingEntries.find(
      (entry) => entry.sequence === input.before,
    );
    const snapshotSequence = BigInt(snapshot);
    const pageEntries = matchingEntries
      .filter((entry) => {
        if (BigInt(entry.sequence) > snapshotSequence) {
          return false;
        }
        if (!cursor) {
          return true;
        }
        return compareHistoryEntriesNewestFirst(entry, cursor) > 0;
      })
      .sort(compareHistoryEntriesNewestFirst)
      .slice(0, 16);

    const boundary = pageEntries.length === 16 ? pageEntries.at(-1) : null;
    page.after = boundary?.sequence ?? null;
    page.afterMicros = boundary?.occurredMicros ?? null;
    page.afterOrder = boundary?.orderId ?? null;
    page.changes = pageEntries.map(withCurrentAccess);
    returnedDomains.push(...pageEntries.map((entry) => entry.domain));
    return page;
  }

  tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.policy.get") {
      return [policy, null];
    }

    if (path === "zerotrust.history.get") {
      tenant.calls.push({ path, input: structuredClone(input) });
      return [readHistoryEntry(input), null];
    }

    if (path === "zerotrust.history.list") {
      tenant.calls.push({ path, input: structuredClone(input) });
      return [readHistoryPage(input), null];
    }

    return queryOriginal(path, input, options);
  };
  const source = newPersonnelProfile(
    "2",
    "native.worker",
    "2026-01-01T10:00:00Z",
    "1",
    "de",
    { first_name: "Vertraulicher Name 928461", cost_per_hour: 37.125 },
  );
  async function append(
    facet,
    changes = {},
    imported = false,
    publication = `pub_${sequenceNumber + 1}`,
  ) {
    const area = personnelCollection("2", facet);
    const value = personnelPart(
      { ...source, values: { ...source.values, ...changes } },
      facet,
    );
    return appendObject(area, area.prefix, value, imported, publication);
  }

  async function appendObject(
    area,
    object,
    value,
    imported = false,
    publication = `pub_${sequenceNumber + 1}`,
  ) {
    const previous = tenant.objects.get(object) ?? null;
    const envelope = await tenant.seed(area, object, value);
    const firstEntry = history.find(
      (entry) => entry.envelope.object === object,
    );
    const initialPublication = firstEntry?.initialPublication ?? publication;
    let migrationOrigin = null;
    if (imported) {
      migrationOrigin = await attestMigrationOrigin(
        envelope,
        "1",
        tenant.authorityKey.privateKey,
      );
    }
    sequenceNumber += 1;
    const entry = {
      access: currentAccess(),
      sequence: String(sequenceNumber),
      publication,
      initialPublication,
      domain: area.domain,
      envelope,
      previous,
      migrationOrigin,
      deletion: null,
      references: null,
      occurredAt: new Date(
        `2026-11-12T12:00:${String(sequenceNumber).padStart(2, "0")}Z`,
      ),
    };
    entry.occurredMicros = String(BigInt(entry.occurredAt.getTime()) * 1000n);
    entry.orderId = entry.sequence;
    history.push(entry);
    return entry;
  }
  await append("master-data", {}, true, "legacy");
  await append("calculation", {}, true, "legacy");
  const controller = new AbortController();
  const store = createProtectedActivity(tenant.client, controller.signal);
  async function revokeArea(scope, facet) {
    const { signature, ...plain } = policy;
    policy = await signPolicy(
      {
        ...plain,
        version: String(BigInt(policy.version) + 1n),
        rules: policy.rules.filter(
          (rule) => rule.scope !== scope || rule.facet !== facet,
        ),
      },
      tenant.authorityKey.privateKey,
    );
  }
  async function legacy(source) {
    const entries = [];
    for (const part of splitLegacyActivity(source)) {
      const envelope = await tenant.seed(part.area, part.id, part.value);
      const publication = `legacy_${sequenceNumber + 1}`;
      sequenceNumber += 1;
      const entry = {
        access: currentAccess(),
        sequence: String(sequenceNumber),
        publication,
        initialPublication: publication,
        domain: part.area.domain,
        envelope,
        previous: null,
        migrationOrigin: await attestMigrationOrigin(
          envelope,
          "1",
          tenant.authorityKey.privateKey,
          { source: part.source, occurredMicros: part.occurredMicros },
        ),
        deletion: null,
        references: null,
        orderId: part.source,
        occurredMicros: part.occurredMicros,
        occurredAt: new Date(source.values.occurred_at),
      };
      history.push(entry);
      entries.push(entry);
    }
    return entries;
  }
  return {
    ...tenant,
    history,
    areas,
    append,
    appendObject,
    legacy,
    store,
    controller,
    returnedDomains,
    revokeArea,
    async revokeCosts() {
      await revokeArea("personnel:2", "calculation");
    },
    close() {
      store.close();
      controller.abort();
    },
  };
}
const legacyRow = (id, time, changes = {}) =>
  row("entity_changes", {
    id,
    entity_table: "users",
    entity_id: "2",
    entity_key: '{"id":2}',
    action: "updated",
    occurred_at: time,
    entity_created_at: "2020-01-01T00:00:00Z",
    actor_user_id: "1",
    actor_kind: "legacy",
    actor_name: "Frühere Bearbeiterin 71928",
    changed_columns: ["first_name", "cost_per_hour"],
    resource_type: "user",
    resource_id: "2",
    title: "Historischer Name 26481",
    resource_title: "Historischer Name 26481",
    is_imported: true,
    ...changes,
  });

test("a warm activity head starts while the fresh access check is pending", async () => {
  const f = await createActivityFixture();
  const path = "personalization.activity.list";
  const request = { limit: 5 };

  try {
    await f.append("master-data", { first_name: "Sichtbare Aktivität" });
    const expected = await f.store.query(path, request);
    expect(expected).not.toHaveLength(0);

    const accessRequested = Promise.withResolvers();
    const releaseAccess = Promise.withResolvers();
    const original = f.client.query;
    let warmHead;
    f.client.query = async (route, input, options) => {
      if (route === "zerotrust.access.snapshot") {
        accessRequested.resolve();
        await releaseAccess.promise;
      }
      if (route === "zerotrust.history.list") warmHead = input.known;

      return original(route, input, options);
    };

    const response = f.store.query(path, request);
    try {
      await accessRequested.promise;
      expect(warmHead).toMatch(/^[1-9][0-9]*$/);
    } finally {
      releaseAccess.resolve();
      expect(await response).toEqual(expected);
    }
  } finally {
    f.close();
  }
});

test("a changed access stamp re-reads a warm history head even when its counters stay the same", async () => {
  const unused = toolCollection("tool", "34", "master-data");
  const f = await createActivityFixture([unused]);
  const path = "personalization.activity.list";
  const request = { limit: 5 };

  try {
    await f.append("master-data", { first_name: "Unveränderte Aktivität" });
    const expected = await f.store.query(path, request);
    expect(expected).not.toHaveLength(0);

    await f.revokeArea(unused.scope, unused.facet);
    const start = f.calls.length;
    expect(await f.store.query(path, request)).toEqual(expected);

    const heads = f.calls
      .slice(start)
      .filter(({ path }) => path === "zerotrust.history.list");
    expect(heads).toHaveLength(2);
    expect(heads[0].input.known).toMatch(/^[1-9][0-9]*$/);
    expect(heads[1].input).toMatchObject({ known: null, knownTotal: null });
  } finally {
    f.close();
  }
});

test("a tool timeline excludes unrelated history and keeps its cache separate from the complete activity list", async () => {
  const master = toolCollection("tool", "34", "master-data");
  const booking = toolCollection("tool-tracking", "35", "master-data");
  const f = await createActivityFixture([master, booking]);
  try {
    await f.append("master-data", { first_name: "Andere Tätigkeit" });
    await f.appendObject(
      master,
      master.prefix,
      toolPart("tool", "34", "master-data", [
        row("tools", {
          id: "100",
          custom_id: "73",
          brand: "Muster",
          category: "Bohrhammer",
        }),
      ]),
    );
    await f.appendObject(
      booking,
      booking.prefix,
      toolPart("tool-tracking", "35", "master-data", [
        row("tool_trackings", {
          id: "101",
          tool_id: "100",
          started_at: "2026-11-16T08:00:00Z",
          ended_at: null,
        }),
      ]),
    );
    f.calls.length = 0;
    const selected = await f.store.query("personalization.activity.list", {
      resourceType: "tool",
      resourceId: "34",
      limit: 50,
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(
      selected.every(
        (item) => item.resourceType === "tool" && item.resourceId === "34",
      ),
    ).toBe(true);
    const reads = f.calls.filter(
      (call) => call.path === "zerotrust.history.list",
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every(
        (call) =>
          JSON.stringify(call.input.prefixes) ===
          JSON.stringify(["tool:34:", "tool-tracking:", "legacy-activity:"]),
      ),
    ).toBe(true);
    const complete = await f.store.query("personalization.activity.list", {
      limit: 50,
    });
    expect(complete.some((item) => item.resourceType === "user")).toBe(true);

    f.calls.length = 0;
    const again = await f.store.query("personalization.activity.list", {
      resourceType: "tool",
      resourceId: "34",
      limit: 50,
    });
    expect(again).toEqual(selected);
    expect(
      await f.store.query("personalization.activity.list", { limit: 50 }),
    ).toEqual(complete);

    const warmReads = f.calls.filter(
      (call) => call.path === "zerotrust.history.list",
    );
    const head = f.history.at(-1).sequence;
    expect(warmReads.map(({ input }) => [input.known, input.knownTotal])).toEqual([
      [head, "2"],
      [head, String(f.history.length)],
    ]);
    expect(
      f.calls.filter(({ path }) => path === "zerotrust.history.get"),
    ).toHaveLength(0);

    await f.revokeArea(master.scope, master.facet);
    await f.revokeArea(booking.scope, booking.facet);
    for (const input of [{}, { resourceType: "tool", resourceId: "34" }]) {
      const afterRevocation = await f.store.query(
        "personalization.activity.list",
        input,
      );
      expect(
        afterRevocation.some(({ resourceType }) => resourceType === "tool"),
      ).toBe(false);
    }
  } finally {
    f.store.close();
  }
});

test("project finance history recognizes manual and permanent records without opening workflow registers", async () => {
  const project = projectCollection("4");
  const offers = financialCollection("4", "offer");
  const invoices = financialCollection("4", "invoice");
  const permanent = financialCollection("4", "invoice", true);
  const tenant = await createActivityFixture([project, offers, invoices]);
  try {
    await tenant.appendObject(
      project,
      project.prefix,
      {
        format: "sortsys-project-v1",
        project: row("projects", { id: "4", title: "Fenstersanierung 862451" }),
        contacts: [],
      },
      true,
    );
    const offer = row("project_financial_entries", {
      id: "12",
      project_id: "4",
      type: "offer",
      amount: 1000,
    });
    const payload = {
      format: "sortsys-project-financial-v1",
      row: offer,
      exactAmount: null,
    };
    await tenant.appendObject(offers, financialObject(offer), payload);
    await tenant.appendObject(offers, financialObject(offer), {
      ...payload,
      row: { ...offer, values: { ...offer.values, amount: 1200 } },
    });
    const invoice = row("project_financial_entries", {
      id: "13",
      project_id: "4",
      type: "invoice",
      amount: 134,
      commercial_case_id: "6",
    });
    await tenant.appendObject(permanent, financialObject(invoice), {
      ...payload,
      row: invoice,
    });
    // This area also contains the workflow register, which has another decoder.
    await tenant.appendObject(
      { ...offers, prefix: "project:4:offer-prices:workflow:" },
      "project:4:offer-prices:workflow:register",
      { notAFinancialRow: true },
    );
    const query = { resourceType: "project", resourceId: "4" };
    const history = await tenant.store.query(
      "personalization.activity.list",
      query,
    );
    expect(history).toHaveLength(3);
    expect(
      history.every((entry) => entry.title === "Fenstersanierung 862451"),
    ).toBe(true);
    expect(history.map((entry) => entry.action)).toEqual([
      "created",
      "updated",
      "created",
    ]);
    expect(history[0].changedColumns).toContain("commercial_case_id");
    expect(history[1].changedColumns).toEqual(["amount"]);
    await tenant.revokeArea("project:4", "billing");
    const visible = await tenant.store.query(
      "personalization.activity.list",
      query,
    );
    expect(visible).toHaveLength(2);
    expect(visible.map((entry) => entry.entityId)).toEqual(["12", "12"]);
  } finally {
    tenant.close();
  }
});

test("activity derives verified changes from separate personal facets and omits the source-copy publications", async () => {
  const tenant = await createActivityFixture();
  try {
    expect(
      await tenant.store.query("personalization.activity.list", {}),
    ).toEqual([]);
    await tenant.append("calculation", { cost_per_hour: 89.87654321 });
    await tenant.append("master-data", {
      first_name: "Neue Vorarbeiterin 729481",
    });
    const values = await tenant.store.query(
      "personalization.activity.list",
      {},
    );
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({
      resourceType: "user",
      resourceId: "2",
      action: "updated",
      changedColumns: ["first_name"],
      actorUserId: "1",
      actorName: null,
      title: "Neue Vorarbeiterin 729481",
    });
    expect(values[1].changedColumns).toEqual(["cost_per_hour"]);
    expect(JSON.stringify(tenant.calls)).not.toContain("89.87654321");
    expect(JSON.stringify(tenant.calls)).not.toContain(
      "Neue Vorarbeiterin 729481",
    );
  } finally {
    tenant.close();
  }
});

test("a cold activity read overlaps history with access, but discards a page from before revocation", async () => {
  const tenant = await createActivityFixture();
  const area = personnelCollection("2", "master-data");
  const accessRequested = Promise.withResolvers();
  const releaseAccess = Promise.withResolvers();
  const query = tenant.client.query;
  let firstPage;
  let pending;

  try {
    await tenant.append("master-data", { first_name: "Vertrauliche Änderung" });
    tenant.client.query = async (path, input, options) => {
      if (path === "zerotrust.access.snapshot") {
        accessRequested.resolve();
        await releaseAccess.promise;
      }
      const response = query(path, input, options);
      if (path === "zerotrust.history.list") firstPage ??= response;
      return response;
    };

    pending = tenant.store.query("personalization.activity.list", {});
    await accessRequested.promise;
    expect(firstPage).toBeDefined();
    const [stale] = await firstPage;
    expect(stale.changes.some(({ domain }) => domain === area.domain)).toBe(true);

    await tenant.revokeArea(area.scope, area.facet);
    releaseAccess.resolve();

    expect(await pending).toEqual([]);
    expect(
      tenant.calls.filter(({ path }) => path === "zerotrust.history.list"),
    ).toHaveLength(2);
    expect(
      tenant.calls.filter(
        ({ path, input }) =>
          path === "zerotrust.keys.history" && input.domain === area.domain,
      ),
    ).toHaveLength(0);
  } finally {
    releaseAccess.resolve();
    await pending?.catch(() => {});
    tenant.close();
  }
});

test("copied history reuses verified name facets from the preceding page", async () => {
  const tenant = await createActivityFixture();
  const query = () =>
    tenant.store.query("personalization.activity.list", { limit: 5 });

  try {
    // Four newer copied events have three facets apiece. Together with the
    // two native copy publications they leave just enough room for the older
    // event's names, but not the event itself, on the first page.
    for (let id = 101; id <= 104; id++) {
      await tenant.legacy(
        legacyRow(String(id), "2026-11-13T12:00:00Z", {
          changed_columns: ["first_name"],
        }),
      );
    }
    await tenant.legacy(
      legacyRow("100", "2026-11-11T12:00:00Z", {
        changed_columns: ["first_name"],
        actor_name: "Bearbeiterin vor der Übernahme",
        resource_title: "Name vor der Übernahme",
      }),
    );

    tenant.calls.length = 0;
    const items = await query();
    expect(items).toHaveLength(5);
    expect(items.at(-1)).toMatchObject({
      actorName: "Bearbeiterin vor der Übernahme",
      resourceTitle: "Name vor der Übernahme",
    });
    const count = (route) => tenant.calls.filter(({ path }) => path === route);
    expect(count("zerotrust.history.list")).toHaveLength(2);
    expect(count("zerotrust.history.get")).toHaveLength(0);

    await tenant.revokeArea("personnel:1", "master-data");
    expect((await query()).at(-1)).toMatchObject({
      actorName: null,
      resourceTitle: "Name vor der Übernahme",
    });
  } finally {
    tenant.close();
  }
});

test("adjacent history pages open each signed revision only once", async () => {
  const tenant = await createActivityFixture();
  const names = Array.from({ length: 34 }, (_, index) => `Vorname ${index + 1}`);

  try {
    for (const first_name of names) {
      await tenant.append("master-data", { first_name });
    }

    const decrypt = spyOn(crypto.subtle, "decrypt");
    try {
      const result = await tenant.store.query("personalization.activity.list", {
        limit: 50,
      });
      expect(result.map(({ title }) => title)).toEqual(names.toReversed());
      const pages = tenant.calls.filter(
        ({ path }) => path === "zerotrust.history.list",
      );
      expect(pages).toHaveLength(3);

      const revisionNonces = new Set(
        tenant.history.map(({ envelope }) => envelope.nonce),
      );
      const openedRevisions = decrypt.mock.calls
        .map(([algorithm]) => Buffer.from(algorithm.iv).toString("base64url"))
        .filter((nonce) => revisionNonces.has(nonce));
      expect(openedRevisions).toHaveLength(revisionNonces.size);
      expect(new Set(openedRevisions)).toEqual(revisionNonces);
    } finally {
      decrypt.mockRestore();
    }
  } finally {
    tenant.close();
  }
});

test("a different packet on the next page cannot reuse a verified opening", async () => {
  const tenant = await createActivityFixture();
  try {
    for (let index = 0; index < 17; index++) {
      await tenant.append("master-data", { first_name: `Vorname ${index}` });
    }

    // Keep the previous revision on page one intact, but change the packet
    // for that same signed revision at the start of page two.
    const change = tenant.history.at(-17);
    const { envelope } = change;
    expect(tenant.history.at(-16).previous).toEqual(envelope);
    const first = envelope.ciphertext.startsWith("A") ? "B" : "A";
    change.envelope = {
      ...envelope,
      ciphertext: first + envelope.ciphertext.slice(1),
    };

    await expect(
      tenant.store.query("personalization.activity.list", { limit: 50 }),
    ).rejects.toThrow();
    expect(tenant.calls.filter(({ path }) => path === "zerotrust.history.list"))
      .toHaveLength(2);
  } finally {
    tenant.close();
  }
});

test("unchanged pages reuse verified data; a signed revocation drops old price metadata even when the maximum sequence is unchanged", async () => {
  const tenant = await createActivityFixture();
  try {
    await tenant.append("calculation", { cost_per_hour: 99.375 });
    await tenant.append("master-data", { first_name: "Neu" });
    expect(
      await tenant.store.query("personalization.activity.list", {}),
    ).toHaveLength(2);
    const count = tenant.calls.filter(
      (call) => call.path === "zerotrust.history.get",
    ).length;
    expect(
      await tenant.store.query("personalization.activity.list", {}),
    ).toHaveLength(2);
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.history.get"),
    ).toHaveLength(count);
    await tenant.revokeCosts();
    tenant.returnedDomains.length = 0;
    const values = await tenant.store.query(
      "personalization.activity.list",
      {},
    );
    expect(values).toHaveLength(1);
    expect(values[0].changedColumns).toEqual(["first_name"]);
    expect(tenant.returnedDomains).not.toContain(
      personnelCollection("2", "calculation").domain,
    );
  } finally {
    tenant.close();
  }
});

test("native history reads names only for returned actors and purges them after revocation", async () => {
  const tenant = await createActivityFixture();
  const author = personnelCollection("1", "master-data");
  const actorReads = () =>
    tenant.calls.filter(
      ({ path, input }) =>
        path === "zerotrust.history.get" && input.id === author.prefix,
    );
  const query = (resourceType) =>
    tenant.store.query("personalization.activity.list", { resourceType });

  try {
    const profile = newPersonnelProfile(
      "1",
      "test-owner",
      "2026-01-01T10:00:00Z",
      "1",
      "de",
      { first_name: "Test", last_name: "Autor" },
    );
    await tenant.appendObject(
      author,
      author.prefix,
      personnelPart(profile, "master-data"),
      true,
    );
    await tenant.append("master-data", { first_name: "Neuer Name" });

    expect(await query("project")).toEqual([]);
    expect(actorReads()).toHaveLength(0);

    const visible = await query("user");
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      actorUserId: "1",
      actorName: "Test Autor",
    });
    expect(actorReads()).toHaveLength(1);

    expect(await query("user")).toEqual(visible);
    expect(actorReads()).toHaveLength(1);

    await tenant.revokeArea(author.scope, author.facet);
    const revoked = await query("user");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ actorUserId: "1", actorName: null });
    expect(actorReads()).toHaveLength(1);
  } finally {
    tenant.close();
  }
});

test("timeline cursors, latest-per-resource and a fresh reader preserve paging without duplicates", async () => {
  const tenant = await createActivityFixture();
  try {
    for (let i = 0; i < 22; i++) {
      await tenant.append("master-data", { first_name: `Stand ${i}` });
    }
    const first = await tenant.store.query("personalization.activity.list", {
      limit: 5,
    });
    const second = await tenant.store.query("personalization.activity.list", {
      limit: 5,
      cursor: first.at(-1).id,
    });
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(10);
    const fresh = createProtectedActivity(
      tenant.client,
      tenant.controller.signal,
    );
    try {
      expect(
        await fresh.query("personalization.activity.list", {
          limit: 5,
          cursor: first.at(-1).id,
        }),
      ).toEqual(second);
    } finally {
      fresh.close();
    }
    const latest = await tenant.store.query("personalization.activity.list", {
      latestPerResource: true,
    });
    expect(latest).toHaveLength(1);
    expect(
      await tenant.store.query("personalization.activity.list", {
        latestPerResource: true,
        cursor: latest[0].id,
      }),
    ).toEqual([]);
    expect(
      await tenant.store.query("personalization.activity.list", {
        resourceType: "project",
        resourceId: "3",
      }),
    ).toEqual([]);
    for (const value of [
      { cursor: "not-a-cursor" },
      { resourceType: "private" },
      { userId: "other" },
      { limit: NaN },
    ]) {
      await expect(
        tenant.store.query("personalization.activity.list", value),
      ).rejects.toThrow();
    }
  } finally {
    tenant.close();
  }
});
test("native facets merge across pages without exposing the cached result to callers", async () => {
  const tenant = await createActivityFixture();
  const occurredAt = new Date("2026-11-12T12:01:00Z");
  const occurredMicros = String(BigInt(occurredAt.getTime()) * 1000n);

  async function append(facet, changes, publication) {
    const entry = await tenant.append(facet, changes, false, publication);
    entry.occurredAt = occurredAt;
    entry.occurredMicros = occurredMicros;
  }

  try {
    await append("calculation", { cost_per_hour: 44 }, "paired");
    for (let i = 0; i < 15; i++) {
      await append("master-data", { first_name: `Zwischenstand ${i}` });
    }
    await append("master-data", { first_name: "Endstand" }, "paired");

    const input = { limit: 1 };
    const query = () => tenant.store.query("personalization.activity.list", input);
    const result = await query();
    expect(result).toHaveLength(1);
    expect(result[0].changedColumns).toEqual(["cost_per_hour", "first_name"]);

    result[0].changedColumns.length = 0;
    result[0].occurredAt.setTime(0);

    const repeated = await query();
    expect(repeated[0].changedColumns).toEqual(["cost_per_hour", "first_name"]);
    expect(repeated[0].occurredAt).toEqual(occurredAt);
  } finally {
    tenant.close();
  }
});

test("forged origin evidence and changed ciphertext fail before a history row is shown", async () => {
  for (const tamper of [
    (entry) => {
      entry.migrationOrigin.signature = "A".repeat(86);
    },
    (entry) => {
      entry.envelope.policyVersion = "999";
    },
  ]) {
    const tenant = await createActivityFixture();
    try {
      tamper(tenant.history[0]);
      await expect(
        tenant.store.query("personalization.activity.list", {}),
      ).rejects.toThrow();
    } finally {
      tenant.close();
    }
  }
});
test("the business facade serves shared activity through encrypted technical reads and clears it on account lock", async () => {
  const tenant = await createActivityFixture();
  const business = createBusinessClient(tenant.client);
  try {
    await tenant.append("master-data", {
      first_name: "Privater Änderungsverlauf",
    });
    const [values, error] = await business.query(
      "personalization.activity.list",
      {},
    );
    expect(error).toBeNull();
    expect(values).toHaveLength(1);
    expect(
      tenant.calls.some(
        (call) => call.path === "personalization.activity.list",
      ),
    ).toBe(false);
    await lockCryptoSession();
    expect(
      (await business.query("personalization.activity.list", {}))[1],
    ).toBeTruthy();
  } finally {
    business.dispose();
    tenant.close();
  }
});
test("late legacy copies retain original microsecond chronology, actors and labels while facets merge once", async () => {
  const tenant = await createActivityFixture();
  try {
    await tenant.append("master-data", { first_name: "Heutiger Name" });
    for (const [id, time] of [
      ["101", "2026-02-01T09:30:00.123454Z"],
      ["102", "2026-02-01T09:30:00.123456Z"],
      ["103", "2026-02-01T09:30:00.123455Z"],
    ]) {
      await tenant.legacy(legacyRow(id, time));
    }
    const events = await tenant.store.query("personalization.activity.list", {
      limit: 2,
    });
    expect(events).toHaveLength(2);
    expect(events[0].isImported).toBe(false);
    expect(events[1]).toMatchObject({
      title: "Historischer Name 26481",
      resourceTitle: "Historischer Name 26481",
      actorKind: "legacy",
      actorUserId: "1",
      actorName: "Frühere Bearbeiterin 71928",
      isImported: true,
      changedColumns: ["cost_per_hour", "first_name"],
      action: "updated",
    });
    const legacyNameReads = () =>
      tenant.calls.filter(
        (call) =>
          call.path === "zerotrust.history.get" &&
          call.input.id.startsWith("legacy-activity:"),
      );
    expect(legacyNameReads()).toEqual([]);

    const rest = await tenant.store.query("personalization.activity.list", {
      limit: 10,
      cursor: events[1].id,
    });
    expect(rest).toHaveLength(2);
    expect(new Set([...events, ...rest].map((value) => value.id)).size).toBe(4);
    expect([...events, ...rest].map((value) => value.id.split("_")[1])).toEqual(
      [
        "1794484803000000",
        "1769938200123456",
        "1769938200123455",
        "1769938200123454",
      ],
    );
    await tenant.revokeCosts();
    const hidden = await tenant.store.query("personalization.activity.list", {
      limit: 10,
    });
    expect(hidden).toHaveLength(4);
    expect(
      hidden.every((value) => !value.changedColumns.includes("cost_per_hour")),
    ).toBe(true);
    await tenant.revokeArea("personnel:1", "master-data");
    const withoutActor = await tenant.store.query(
      "personalization.activity.list",
      { limit: 10 },
    );
    expect(withoutActor.filter((value) => value.isImported)).toHaveLength(3);
    expect(withoutActor.every((value) => value.actorName === null)).toBe(true);
    expect(legacyNameReads()).toEqual([]);
    expect(JSON.stringify(tenant.calls)).not.toContain("Frühere Bearbeiterin");
  } finally {
    tenant.close();
  }
});
test("a late committed lower sequence invalidates an unchanged maximum and remains visible", async () => {
  const tenant = await createActivityFixture();
  try {
    const delayed = await tenant.append("calculation", {
      cost_per_hour: 99.375,
    });
    tenant.history.splice(tenant.history.indexOf(delayed), 1);
    await tenant.append("master-data", { first_name: "Später abgeschlossen" });
    expect(
      await tenant.store.query("personalization.activity.list", {}),
    ).toHaveLength(1);
    tenant.history.push(delayed);
    expect(
      await tenant.store.query("personalization.activity.list", {}),
    ).toHaveLength(2);
  } finally {
    tenant.close();
  }
});
test("stripped or altered chronology never turns a copied action into a current signed edit", async () => {
  for (const change of [
    (entry) => {
      entry.migrationOrigin = null;
    },
    (entry) => {
      delete entry.migrationOrigin.history;
    },
    (entry) => {
      entry.migrationOrigin.history.occurredMicros = "1769938200123457";
    },
  ]) {
    const tenant = await createActivityFixture();
    try {
      const entries = await tenant.legacy(
        legacyRow("101", "2026-02-01T09:30:00.123456Z"),
      );
      change(entries[0]);
      await expect(
        tenant.store.query("personalization.activity.list", {}),
      ).rejects.toThrow();
    } finally {
      tenant.close();
    }
  }
});
test("a historical name included on the page still needs its authority proof", async () => {
  const tenant = await createActivityFixture();
  try {
    const entries = await tenant.legacy(
      legacyRow("101", "2026-02-01T09:30:00.123456Z"),
    );
    const actor = entries.find((entry) =>
      entry.envelope.object.endsWith(":actor"),
    );
    expect(actor).toBeDefined();
    actor.migrationOrigin.history.occurredMicros = "1769938200123457";

    await expect(
      tenant.store.query("personalization.activity.list", {}),
    ).rejects.toThrow();
    expect(
      tenant.calls.some((call) => call.path === "zerotrust.history.get"),
    ).toBe(false);
  } finally {
    tenant.close();
  }
});
test("same-time originals keep source-ID order and a split across storage pages never duplicates an action", async () => {
  const tenant = await createActivityFixture();
  try {
    for (const id of [109, 103, 102, 108, 101, 106, 105, 110, 107, 104]) {
      await tenant.legacy(legacyRow(String(id), "2026-02-01T09:30:00.123456Z"));
    }
    const first = await tenant.store.query("personalization.activity.list", {
      limit: 5,
    });
    const second = await tenant.store.query("personalization.activity.list", {
      limit: 5,
      cursor: first.at(-1).id,
    });
    expect(
      [...first, ...second].map((value) => value.id.split("_")[2]),
    ).toEqual([
      "110",
      "109",
      "108",
      "107",
      "106",
      "105",
      "104",
      "103",
      "102",
      "101",
    ]);
    expect(new Set([...first, ...second].map((value) => value.id)).size).toBe(
      10,
    );
    expect(
      [...first, ...second].every((value) => value.changedColumns.length === 2),
    ).toBe(true);
    expect(
      [...first, ...second].every(
        (value) =>
          value.actorName === "Frühere Bearbeiterin 71928" &&
          value.resourceTitle === "Historischer Name 26481",
      ),
    ).toBe(true);
    const boundaryReads = tenant.calls.filter(
      (call) =>
        call.path === "zerotrust.history.get" &&
        call.input.id.startsWith("legacy-activity:"),
    );
    expect(boundaryReads.length).toBeGreaterThan(0);
    expect(boundaryReads.length).toBeLessThan(10);
    expect(boundaryReads.every((call) => call.input.revision === "1")).toBe(true);
  } finally {
    tenant.close();
  }
});
