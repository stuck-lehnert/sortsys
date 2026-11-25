import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { formatOfferNumber, previewOfferNumbers } from "../invoiceNumbering";
import { commitProtectedWrites } from "./atomicWrites";
import { archivedOfferClaims } from "./migrateOfferNumbers";
import { offerNumberLedger, openOfferNumbers } from "./offerNumbers";
import {
  OFFER_LEDGER_COLLECTION,
  OFFER_NUMBERING_COLLECTION,
  offerNumbering,
  organizationObject,
} from "./organizationData";
import { acquireDataRuntime } from "./runtime/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

const day = new Date("2026-11-11T23:55:00Z");

test("the offer preview uses UTC, excludes project schemes and keeps exact int64 numbers", () => {
  expect(formatOfferNumber({ scheme: "dateSeparated", startNumber: "5368" }, day))
    .toBe("26-11-11-5368");
  expect(previewOfferNumbers({ scheme: "sequential", startNumber: "9223372036854775806" }, day))
    .toEqual(["9223372036854775806", "9223372036854775807"]);
  expect(() => offerNumbering({ scheme: "projectLocal", startNumber: "1" })).toThrow();
  expect(() => offerNumbering({ scheme: "projectGlobal", startNumber: "1" })).toThrow();
});

test("a reader cannot initialize the offer ledger while planning a number", async () => {
  const tenant = await protectedTenant(
    [OFFER_NUMBERING_COLLECTION, OFFER_LEDGER_COLLECTION],
    () => ["read"],
  );
  const controller = new AbortController();
  const { runtime, live, close } = acquireDataRuntime(tenant.client, controller.signal);

  try {
    await tenant.seed(OFFER_NUMBERING_COLLECTION, organizationObject("offerNumbering"), {
      format: "sortsys-organization-v1",
      kind: "offerNumbering",
      value: { scheme: "sequential", startNumber: "1" },
    });
    await expect(openOfferNumbers(runtime, live).plan("5", day)).rejects.toThrow(
      /offer numbers|Angebotsnummern/,
    );
    expect(tenant.calls.some(({ path }) => path === "zerotrust.objects.batch")).toBe(false);
  } finally {
    close();
    controller.abort();
  }
});

test("an unconfigured offer sequence does not initialize the ledger", async () => {
  const tenant = await protectedTenant(
    [OFFER_NUMBERING_COLLECTION, OFFER_LEDGER_COLLECTION],
    () => ["read", "create", "update"],
  );
  const controller = new AbortController();
  const { runtime, live, close } = acquireDataRuntime(tenant.client, controller.signal);

  try {
    await expect(openOfferNumbers(runtime, live).plan("5", day)).rejects.toThrow(
      /eingerichtet|Set up offer numbering/,
    );
    expect(tenant.calls.some(({ path }) => path === "zerotrust.objects.batch")).toBe(false);
  } finally {
    close();
    controller.abort();
  }
});

test("create permission alone cannot advance an existing offer counter", async () => {
  const tenant = await protectedTenant(
    [OFFER_NUMBERING_COLLECTION, OFFER_LEDGER_COLLECTION],
    (area) => area.domain === OFFER_LEDGER_COLLECTION.domain
      ? ["read", "create"]
      : ["read"],
  );
  const controller = new AbortController();
  const { runtime, live, close } = acquireDataRuntime(tenant.client, controller.signal);
  const counter = offerNumberLedger.counterRequest("global");

  try {
    await tenant.seed(OFFER_NUMBERING_COLLECTION, organizationObject("offerNumbering"), {
      format: "sortsys-organization-v1",
      kind: "offerNumbering",
      value: { scheme: "sequential", startNumber: "1" },
    });
    await tenant.seed(OFFER_LEDGER_COLLECTION, counter.area.prefix, {
      format: "sortsys-offer-counter-v1",
      scope: "global",
      nextNumber: "17",
    });

    await expect(openOfferNumbers(runtime, live).plan("5", day)).rejects.toThrow(
      /offer numbers|Angebotsnummern/,
    );
    expect(tenant.calls.some(({ path }) => path === "zerotrust.objects.batch")).toBe(false);
  } finally {
    close();
    controller.abort();
  }
});

test("offer reservations are opaque, monotonic and survive format collisions", async () => {
  const tenant = await protectedTenant(
    [OFFER_NUMBERING_COLLECTION, OFFER_LEDGER_COLLECTION],
    (area) => area.domain === OFFER_NUMBERING_COLLECTION.domain
      ? ["read"]
      : ["read", "create", "update"],
  );
  const controller = new AbortController();
  const { runtime, live, close } = acquireDataRuntime(tenant.client, controller.signal);
  const numbers = openOfferNumbers(runtime, live);

  async function configure(scheme, startNumber) {
    await tenant.seed(OFFER_NUMBERING_COLLECTION, organizationObject("offerNumbering"), {
      format: "sortsys-organization-v1",
      kind: "offerNumbering",
      value: { scheme, startNumber },
    });
    runtime.revalidate();
  }

  async function commit(prepared) {
    try {
      await commitProtectedWrites(tenant.client, prepared.groups, controller.signal, prepared.guards);
    } finally {
      prepared.close();
    }
  }

  try {
    await configure("dateCompact", "1");
    const main = await numbers.plan("5", day);
    const other = await numbers.plan("6", day);
    expect(main.number).toBe("2611111");
    expect(other.number).toBe(main.number);
    const stale = await other.prepare();
    await commit(await main.prepare());
    await expect(commit(stale)).rejects.toThrow();
    expect(JSON.stringify(tenant.calls)).not.toContain(main.number);

    await configure("sequential", "2611111");
    const alternative = await numbers.plan("7", day);
    expect(alternative.number).toBe("2611112");
    await commit(await alternative.prepare());

    await configure("dateSeparated", "1");
    const oldFormat = await numbers.plan("8", day);
    expect(oldFormat.number).toBe("26-11-11-2611113");

    await configure("sequential", "1");
    await expect(oldFormat.prepare()).rejects.toThrow();
    expect((await numbers.plan("8", day)).number).toBe("2611113");

    const claims = archivedOfferClaims([
      { values: { kind: "alternative", reference: "3000000", id: "8" } },
      { values: { kind: "offer", reference: "ANG-2026-9", id: "9" } },
      { values: { kind: "invoice", reference: "3000002", id: "10" } },
    ], new Set(["3000000", "3000001", "2611113", "ANG-2026-9"]));
    expect(claims).toEqual(new Map([
      ["3000000", "8"], ["3000002", "a"], ["3000001", null], ["2611113", null],
    ]));

    await numbers.restore("7000", claims);
    await configure("sequential", "1");
    expect((await numbers.plan("9", day)).number).toBe("2611114");

    await numbers.restore("3000000", claims);
    const callsBeforeReplay = tenant.calls.length;
    await numbers.restore("7000", claims);
    expect(tenant.calls.slice(callsBeforeReplay).some(
      ({ path }) => path === "zerotrust.objects.batch",
    )).toBe(false);
    expect((await numbers.plan("9", day)).number).toBe("3000003");
  } finally {
    close();
    controller.abort();
  }
});
