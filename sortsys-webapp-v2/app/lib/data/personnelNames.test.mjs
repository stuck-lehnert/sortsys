import { expect, spyOn, test } from "bun:test";
import { newPersonnelProfile, personnelCollection, personnelPart } from "./personnelData";
import { loadPersonnelNames } from "./personnelNames";
import * as objects from "./protectedObjects";

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
