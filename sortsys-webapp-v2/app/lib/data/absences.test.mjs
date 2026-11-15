import { afterEach, expect, test } from "bun:test";
import { ACTIONS, bytes, encryptObject } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { createProtectedAbsences } from "./absences";
import { absenceCollection } from "./absenceData";
import { personnelCollection, personnelPart } from "./personnelData";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { row } from "./rowCodec.test.mjs";
import { protectedCollection } from "./protectedObjects";
import { createBusinessClient } from "./businessClient";
import { announceDataChanges } from "./runtime/changes";
afterEach(() => lockCryptoSession());
const dates = { from: "2026-12-28", to: "2027-01-05" };
async function fixture(
  approver = false,
  hr = true,
  requestActions = ["read", "create", "delete"],
  decisionActions = approver ? ["read", "approve", "delete"] : ["read"],
) {
  const source = absenceCollection("2"),
    decisions = absenceCollection("2", true),
    person = personnelCollection("2", "master-data"),
    details = personnelCollection("2", "scope");
  const f = await protectedTenant(
    [source, decisions, person, details],
    (area) =>
      area === source
        ? requestActions
        : area === decisions
          ? decisionActions
          : area === details && !hr
            ? []
            : [...ACTIONS],
  );
  const user = row("users", {
    id: "2",
    username: "maria",
    first_name: "Maria",
    contract_type: "internal",
    ui_locale: "de",
    vacation_days_per_year: "30",
    supervisor_user_id: "1",
  });
  for (const [area, facet] of [
    [person, "master-data"],
    [details, "scope"],
  ])
    await f.seed(area, area.prefix, personnelPart(user, facet));
  return {
    ...f,
    source,
    decisions,
    store: createProtectedAbsences(
      f.client,
      new AbortController().signal,
      duckDriver,
    ),
  };
}
test("an ordinary creator gets a pending request and cannot approve or forge an approved request", async () => {
  const f = await fixture();
  try {
    const created = await f.store.mutate("users.vacations.create", {
      operationId: "3",
      userId: "2",
      ...dates,
      note: "Vertraulicher Urlaubsgrund",
    });
    expect(created).toEqual({ id: "3", status: "requested" });
    const [entry] = await f.store.query("users.vacations.list", {});
    expect(entry).toMatchObject({
      id: "3",
      status: "requested",
      canApprove: false,
      canDeny: false,
      canDelete: true,
    });
    await expect(
      f.store.mutate("users.vacations.approve", {
        id: "3",
        expectedRevision: entry.revision,
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(f.calls)).not.toContain("Vertraulicher Urlaubsgrund");
    const count = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    ).length;
    expect(
      await f.store.mutate("users.vacations.create", {
        operationId: "3",
        userId: "2",
        ...dates,
        note: "Vertraulicher Urlaubsgrund",
      }),
    ).toEqual(created);
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").length,
    ).toBe(count);
    await expect(
      f.store.mutate("users.vacations.create", {
        operationId: "3",
        userId: "2",
        ...dates,
        note: "Anderer Inhalt",
      }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, 20000);
test("automatic approval commits request and signature-bound decision together despite a lost reply", async () => {
  const f = await fixture(true);
  try {
    f.state.loseReply = true;
    expect(
      await f.store.mutate("users.vacations.create", {
        operationId: "3",
        userId: "2",
        ...dates,
      }),
    ).toEqual({ id: "3", status: "approved" });
    const calls = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].input.objects).toHaveLength(2);
    const parent = f.objects.get(f.source.prefix + "3"),
      child = await f.plain(f.decisions, f.decisions.prefix + "3");
    expect(child.requestSignature).toBe(parent.signature);
    const [entry] = await f.store.query("users.vacations.list", {});
    expect(entry).toMatchObject({
      status: "approved",
      decidedByUserId: "1",
      canApprove: false,
    });
  } finally {
    f.store.close();
  }
}, 20000);
test("an authorized decision preserves the request and stale forms cannot replace it", async () => {
  const f = await fixture(
    false,
    true,
    ["read", "create", "delete"],
    ["read", "approve"],
  );
  try {
    // Create a source record through the actual creator-only protocol first.
    const now = new Date().toISOString(),
      source = {
        format: "sortsys-absence-request-v1",
        legacy: null,
        row: row("user_vacations", {
          id: "3",
          user_id: "2",
          requested_by_user_id: "1",
          ...dates,
          status: "requested",
          absence_type: "vacation",
          created_at: now,
          modified_at: now,
        }),
      };
    await f.seed(f.source, f.source.prefix + "3", source);
    const before = f.objects.get(f.source.prefix + "3"),
      [entry] = await f.store.query("users.vacations.list", {});
    expect(entry.vacationUsage).toMatchObject([
      { year: 2026, requestedDays: 4, allowanceDays: 30 },
      { year: 2027, requestedDays: 3, allowanceDays: 30 },
    ]);
    await f.store.mutate("users.vacations.deny", {
      id: "3",
      expectedRevision: entry.revision,
      reason: "  Bauabschnitt fertigstellen  ",
    });
    expect(f.objects.get(f.source.prefix + "3")).toEqual(before);
    const [denied] = await f.store.query("users.vacations.list", {});
    expect(denied).toMatchObject({
      status: "denied",
      denialReason: "Bauabschnitt fertigstellen",
      canApprove: false,
      canDelete: false,
    });
    await expect(
      f.store.mutate("users.vacations.approve", {
        id: "3",
        expectedRevision: entry.revision,
      }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("users.vacations.delete", { id: "3" }),
    ).rejects.toThrow();
    expect(
      await f.store.query("users.vacations.list", { includeDenied: false }),
    ).toEqual([]);
  } finally {
    f.store.close();
  }
}, 20000);
test("a signed decision for another valid signature of the request never grants an approved status", async () => {
  const f = await fixture(true);
  try {
    await f.store.mutate("users.vacations.create", {
      operationId: "3",
      userId: "2",
      ...dates,
    });
    // A genuinely signed Create fork with the same revision can be supplied by
    // a malicious server. It must not inherit another source's decision.
    const original = f.objects.get(f.source.prefix + "3"),
      payload = await f.plain(f.source, f.source.prefix + "3");
    payload.row.values.note = "Andere Anfrage";
    const replacement = await encryptObject(
      Object.fromEntries(
        [
          "tenant",
          "scope",
          "facet",
          "object",
          "revision",
          "generation",
          "policyVersion",
          "author",
        ].map((key) => [key, original[key]]),
      ),
      bytes(JSON.stringify(payload)),
      f.domains.get(f.source.domain).key,
      f.identity.signingKey.privateKey,
    );
    f.objects.set(f.source.prefix + "3", replacement);
    f.domains.get(f.source.domain).head++;
    f.store.close();
    const source = await protectedCollection(
        f.client,
        f.source,
        new AbortController().signal,
      ),
      decisions = await protectedCollection(
        f.client,
        f.decisions,
        new AbortController().signal,
      );
    try {
      expect(
        (await source.get(f.source.prefix + "3")).value.row.values.note,
      ).toBe("Andere Anfrage");
      expect(
        (await decisions.get(f.decisions.prefix + "3")).value.requestSignature,
      ).toBe(original.signature);
    } finally {
      source.close();
      decisions.close();
    }
    const fresh = createProtectedAbsences(
      f.client,
      new AbortController().signal,
      duckDriver,
    );
    try {
      await expect(fresh.query("users.vacations.list", {})).rejects.toThrow();
    } finally {
      fresh.close();
    }
  } finally {
    f.store.close();
  }
}, 20000);
test("a missing HR grant remains unknown and never appears as a zero-day allowance", async () => {
  const f = await fixture(true, false);
  try {
    const now = new Date().toISOString();
    await f.seed(f.source, f.source.prefix + "3", {
      format: "sortsys-absence-request-v1",
      legacy: null,
      row: row("user_vacations", {
        id: "3",
        user_id: "2",
        requested_by_user_id: "1",
        ...dates,
        status: "requested",
        absence_type: "vacation",
        created_at: now,
        modified_at: now,
      }),
    });
    const [entry] = await f.store.query("users.vacations.list", {});
    expect(
      entry.vacationUsage.every(
        (usage) =>
          usage.allowanceDays === null && usage.remainingAfterApproval === null,
      ),
    ).toBe(true);
  } finally {
    f.store.close();
  }
}, 20000);

test("the ordinary business client serves absence subscriptions locally and refreshes their HR dependencies", async () => {
  const f = await fixture(true),
    now = new Date().toISOString();
  f.store.close();
  await f.seed(f.source, f.source.prefix + "3", {
    format: "sortsys-absence-request-v1",
    legacy: null,
    row: row("user_vacations", {
      id: "3",
      user_id: "2",
      requested_by_user_id: "1",
      ...dates,
      status: "requested",
      absence_type: "vacation",
      created_at: now,
      modified_at: now,
    }),
  });
  const client = createBusinessClient(f.client, { productDriver: duckDriver }),
    seen = [],
    errors = [];
  let initial, changed;
  const first = new Promise((resolve) => {
      initial = resolve;
    }),
    second = new Promise((resolve) => {
      changed = resolve;
    });
  const subscription = client
    .streamQuery("users.vacations.list", {})
    .subscribe(([values, error]) => {
      if (error) {
        errors.push(error);
        initial();
        changed();
        return;
      }
      seen.push(values);
      if (values[0]?.vacationUsage[0]?.allowanceDays === 30) initial();
      if (values[0]?.vacationUsage[0]?.allowanceDays === 40) changed();
    });
  try {
    await first;
    expect(errors).toEqual([]);
    const profile = row("users", {
      id: "2",
      username: "maria",
      first_name: "Maria",
      contract_type: "internal",
      ui_locale: "de",
      vacation_days_per_year: "40",
      supervisor_user_id: "1",
    });
    const area = personnelCollection("2", "scope");
    await f.seed(area, area.prefix, personnelPart(profile, "scope"));
    announceDataChanges(f.client, new Set([area.domain]), { revalidate: true });
    await second;
    expect(errors).toEqual([]);
    expect(seen.at(-1)[0].vacationUsage[0].allowanceDays).toBe(40);
    const entry = seen.at(-1)[0];
    expect(
      (
        await client.mutate("users.vacations.approve", {
          id: "3",
          expectedRevision: entry.revision,
        })
      )[1],
    ).toBeNull();
    expect((await client.query("users.vacations.list", {}))[0][0].status).toBe(
      "approved",
    );
    expect(
      f.calls.some((call) => call.path.startsWith("users.vacations.")),
    ).toBe(false);
  } finally {
    subscription.unsubscribe();
    client.dispose();
  }
}, 20000);
