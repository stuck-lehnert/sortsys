import { afterEach, expect, test } from "bun:test";
import { ACTIONS, InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import {
  invalidateReadableAreas,
  readableAreas,
  setReadableAreasConnection,
} from "./readableAreas";
import {
  PROJECT_ACCESS_KEYS,
  projectAccessArea,
  projectAccessDomain,
  projectModuleArea,
  projectModuleDecoder,
  projectModuleDomain,
} from "./projectScope";
import { dailyCollection, dailyDomain } from "./dailyReportData";
import { deliveryCollection, deliveryDomain } from "./deliveryNoteData";
import { scheduleCollection } from "./projectScheduleData";
import { regieCollection, regieDomain } from "./regieReportData";

afterEach(() => lockCryptoSession());

test("area searches reuse a verified directory only in the connected lifetime", async () => {
  const area = dailyCollection("2");
  const anotherArea = dailyCollection("3");
  const fixture = await protectedTenant([area]);
  const signal = new AbortController().signal;
  const read = (lifetime = signal) =>
    readableAreas(fixture.client, lifetime, (domain) => {
      if (domain === area.domain) return area;
      if (domain === anotherArea.domain) return anotherArea;
      return null;
    });
  const snapshots = () =>
    fixture.calls.filter(({ path }) => path === "zerotrust.access.snapshot").length;

  setReadableAreasConnection(fixture.client, true);
  expect(await Promise.all([read(), read()])).toEqual([[area], [area]]);
  expect(await read()).toEqual([area]);
  expect(snapshots()).toBe(1);
  expect(await read(new AbortController().signal)).toEqual([area]);
  expect(snapshots()).toBe(2);

  await fixture.addArea(anotherArea);
  invalidateReadableAreas(fixture.client);
  expect(await read()).toEqual([area, anotherArea]);
  expect(snapshots()).toBe(3);

  setReadableAreasConnection(fixture.client, false);
  expect(await read()).toEqual([area, anotherArea]);
  expect(await read()).toEqual([area, anotherArea]);
  expect(snapshots()).toBe(5);
  await expect(read(AbortSignal.abort())).rejects.toThrow();
});

test("the shared project inventory has canonical, independent module bindings", () => {
  expect(PROJECT_ACCESS_KEYS).toHaveLength(14);
  expect(new Set(PROJECT_ACCESS_KEYS).size).toBe(14);
  for (const key of PROJECT_ACCESS_KEYS) {
    const area = projectAccessArea("2", key);
    expect(projectAccessDomain(area.domain)).toEqual({ id: "2", key });
  }
  for (const domain of [
    "project:02:daily-reports:master-data",
    "project:8000000000000:daily-reports:master-data",
    "project:2:unknown:master-data",
    "project:2:daily-reports:personnel",
    "project:2:regie-reports:calculation",
    "project:2:delivery-notes:procurement:extra",
  ])
    expect(projectModuleDomain(domain)).toBeNull();
  expect(() => projectModuleArea("2", "daily-reports", "personnel")).toThrow();
  expect(() => projectAccessArea("2", "personnel")).toThrow();
  for (const area of [
    dailyCollection("2"),
    deliveryCollection("2"),
    regieCollection("2"),
  ]) {
    expect(
      [
        dailyDomain(area.domain),
        deliveryDomain(area.domain),
        regieDomain(area.domain),
      ].filter(Boolean),
    ).toHaveLength(1);
  }
});
test("project codecs check the entire collection binding before decoding", () => {
  const dailyCosts = (id) => dailyCollection(id, true);
  const regieHours = (id) => regieCollection(id, true);
  const deliveryPrices = (id) => deliveryCollection(id, true);
  const cases = [
    [dailyCollection, dailyCosts],
    [dailyCosts, dailyCollection],
    [regieCollection, regieHours],
    [regieHours, regieCollection],
    [deliveryCollection, deliveryPrices],
    [deliveryPrices, deliveryCollection],
    [scheduleCollection, dailyCollection],
  ];

  for (const [collection, otherCollection] of cases) {
    const value = { report: "original" };
    const area = collection("1");
    const otherProject = collection("2");
    const object = `${area.prefix}3`;
    let decoded = 0;
    const read = projectModuleDecoder(collection, (input, id, project) => {
      decoded++;
      return { input, id, project };
    });

    expect(read(value, object, area)).toEqual({
      input: value,
      id: object,
      project: "1",
    });

    for (const foreign of [
      otherCollection("1"),
      { ...area, domain: "not-a-project-module" },
      { ...area, domain: otherProject.domain },
      { ...area, scope: otherProject.scope },
      { ...area, facet: "documents" },
      { ...area, prefix: otherProject.prefix },
    ]) {
      expect(() => read(value, object, foreign)).toThrow(InvalidProtectedData);
    }
    expect(decoded).toBe(1);
  }
});

test("report discovery and real envelope keys stay isolated even when every ciphertext is supplied", async () => {
  const areas = [
    dailyCollection("2"),
    dailyCollection("2", true),
    deliveryCollection("2"),
    deliveryCollection("2", true),
    regieCollection("2"),
    regieCollection("2", true),
  ];
  const f = await protectedTenant(areas, (area) =>
    area.scope.endsWith(":daily-reports") && area.facet === "master-data"
      ? [...ACTIONS]
      : [],
  );
  const signal = new AbortController().signal;
  expect(
    (
      await readableAreas(f.client, signal, (domain) => {
        const part = dailyDomain(domain);
        return part ? dailyCollection(part.projectId, part.costs) : null;
      })
    ).map((area) => area.domain),
  ).toEqual([areas[0].domain]);
  for (const [parse, collection] of [
    [deliveryDomain, deliveryCollection],
    [regieDomain, regieCollection],
  ]) {
    expect(
      await readableAreas(f.client, signal, (domain) => {
        const part = parse(domain);
        return part
          ? collection(part.projectId, part.prices ?? part.hours)
          : null;
      }),
    ).toEqual([]);
  }
  // Server admission is deliberately absent here: ciphertext confidentiality
  // must hold even when an operator supplies another module's encrypted blob.
  for (const area of areas.slice(1)) {
    const id = area.prefix + "3";
    await f.seed(area, id, { secret: "not shared" });
    await expect(f.plain(areas[0], id)).rejects.toThrow();
  }
});
