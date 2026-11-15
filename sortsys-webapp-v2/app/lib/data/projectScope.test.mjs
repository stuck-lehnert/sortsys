import { afterEach, expect, test } from "bun:test";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { readableAreas } from "./readableAreas";
import {
  PROJECT_ACCESS_KEYS,
  projectAccessArea,
  projectAccessDomain,
  projectModuleArea,
  projectModuleDomain,
} from "./projectScope";
import { dailyCollection, dailyDomain } from "./dailyReportData";
import { deliveryCollection, deliveryDomain } from "./deliveryNoteData";
import { regieCollection, regieDomain } from "./regieReportData";

afterEach(() => lockCryptoSession());
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
