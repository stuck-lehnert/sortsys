import { expect, spyOn, test } from "bun:test";
import { firstValueFrom } from "rxjs";
import { lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import {
  newPersonnelProfile,
  personnelCollection,
  personnelPart,
} from "./personnelData";
import { loadPersonnelNames } from "./personnelNames";
import * as objects from "./protectedObjects";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

test("the overview reads only the assigned leader's name, not the full profile", async () => {
  const master = personnelCollection("2", "master-data");
  const calculation = personnelCollection("2", "calculation");
  const hidden = personnelCollection("3", "master-data");
  const tenant = await protectedTenant(
    [master, calculation, hidden],
    (area) => (area === hidden ? [] : ["read"]),
  );
  const app = createBusinessClient(tenant.client, { productDriver: duckDriver });

  try {
    const profile = newPersonnelProfile(
      "2", "tanja", "2026-03-01T12:00:00.000000Z", null, "de",
      { first_name: "Tanja", last_name: "Fuchs", cost_per_hour: 100 },
    );
    await tenant.seed(master, master.prefix, personnelPart(profile, "master-data"));
    await tenant.seed(
      calculation, calculation.prefix, personnelPart(profile, "calculation"),
    );

    const beforeName = tenant.calls.length;
    expect(await firstValueFrom(app.streamPersonnelName("2"))).toEqual([
      "Tanja Fuchs", null,
    ]);

    const nameCalls = tenant.calls.slice(beforeName);
    const isSnapshot = ({ path }) => path === "zerotrust.access.snapshot";
    const snapshots = nameCalls.filter(isSnapshot);
    expect(snapshots.map(({ input }) => input.domains)).toEqual([[master.domain]]);
    expect(JSON.stringify(nameCalls)).not.toContain(calculation.domain);

    const beforeProfile = tenant.calls.length;
    const [user, error] = await app.query("users.get", { id: "2" });
    expect(error).toBeNull();
    expect(user?.firstName).toBe("Tanja");
    expect(user?.costPerHour).toBe(100);

    const profileCalls = tenant.calls.slice(beforeProfile);
    expect(profileCalls.filter(isSnapshot).length).toBeGreaterThan(snapshots.length);
    expect(JSON.stringify(profileCalls)).toContain(calculation.domain);

    const [hiddenName] = await firstValueFrom(app.streamPersonnelName("3"));
    expect(hiddenName).toBeNull();

    await lockCryptoSession();
    const [afterLock, locked] = await firstValueFrom(app.streamPersonnelName("2"));
    expect(afterLock).toBeNull();
    expect(locked).not.toBeNull();
  } finally {
    app.dispose();
    await lockCryptoSession();
  }
}, fixtureTimeout(30_000));

test("names use only distinct, readable master-data areas", async () => {
  const areas = ["2", "3", "4"].map((id) => personnelCollection(id, "master-data"));
  const profile = newPersonnelProfile("2", "tanja", "2026-03-01T12:00:00.000000Z", null, "de", {
    first_name: "Tanja",
    last_name: "Fuchs",
  });
  const payload = personnelPart(profile, "master-data");
  const readAreas = [];
  const access = {
    readable: (area) => area.domain !== areas[1].domain,
    prefetch: async (selections) => {
      expect(selections).toEqual([{ area: areas[0] }, { area: areas[2] }]);
    },
    read: async (area) => {
      readAreas.push(area);
      return area.domain === areas[0].domain
        ? [{ envelope: { object: area.prefix }, value: payload }]
        : [];
    },
  };

  const transport = {};
  const signal = new AbortController().signal;
  const open = spyOn(objects, "protectedCollections").mockResolvedValue(access);
  try {
    const names = await loadPersonnelNames(transport, ["2", "3", "2", "4"], signal);

    expect([...names]).toEqual([["2", "Tanja Fuchs"]]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(transport, signal, areas.map(({ domain }) => domain));
    expect(readAreas).toEqual([areas[0], areas[2]]);
  } finally {
    open.mockRestore();
  }
});

test("revoking the context during a read discards the result and stops further reads", async () => {
  const profile = newPersonnelProfile("2", "tanja", "2026-03-01T12:00:00.000000Z", null, "de");
  const payload = personnelPart(profile, "master-data");
  const controller = new AbortController();
  const readAreas = [];
  const access = {
    readable: () => true,
    prefetch: async () => {},
    read: async (area) => {
      readAreas.push(area);
      controller.abort();
      return [{ envelope: { object: area.prefix }, value: payload }];
    },
  };

  const open = spyOn(objects, "protectedCollections").mockResolvedValue(access);
  try {
    await expect(loadPersonnelNames({}, ["2", "3"], controller.signal)).rejects.toThrow();
    expect(readAreas).toEqual([personnelCollection("2", "master-data")]);
  } finally {
    open.mockRestore();
  }
});
