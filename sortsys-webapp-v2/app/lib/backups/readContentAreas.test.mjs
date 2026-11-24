import { expect, test } from "bun:test";
import { forEachContentArea, readContentAreas } from "./readContentAreas.ts";

test("prefetches at most sixteen areas and waits for their checks before continuing", async () => {
  const areas = Array.from({ length: 19 }, (_, id) => ({ id }));
  const batches = [];
  const visited = [];
  let batch;
  let active = 0;
  let peak = 0;

  const view = {
    async prefetch(entries) {
      expect(active).toBe(0);
      expect(visited).toHaveLength(batches.flat().length);
      batch = entries.map(({ area }) => area);
      batches.push(batch);
    },
    async read(area) {
      expect(batch).toContain(area);
      return area.id === 0 ? [] : [area.id];
    },
  };

  await forEachContentArea(view, areas, 2, async (area) => {
    peak = Math.max(peak, ++active);
    const objects = await view.read(area);
    expect(objects).toEqual(area.id === 0 ? [] : [area.id]);
    visited.push(area.id);
    active--;
  });

  expect(peak).toBe(2);
  expect(batches).toEqual([areas.slice(0, 16), areas.slice(16)]);
  expect(visited.toSorted((a, b) => a - b)).toEqual(areas.map(({ id }) => id));
});

test("walks an area's requested tombstones in order and stops after a failed check", async () => {
  const onlyArea = { id: "restored" };
  const pending = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const visited = [];
  const failure = new Error("invalid manifest");
  const view = {
    async prefetch(entries) {
      expect(entries).toEqual([{ area: onlyArea }]);
    },
    async read(area, options) {
      expect(area).toBe(onlyArea);
      expect(options).toEqual({ includeTombstones: true });
      return [null, "rejected", "unvisited"];
    },
  };

  const checking = readContentAreas(
    view,
    [onlyArea],
    async (area, object) => {
      expect(area).toBe(onlyArea);
      visited.push(object);
      if (object === null) {
        entered.resolve();
        await pending.promise;
      }
      if (object === "rejected") throw failure;
    },
    { includeTombstones: true },
  );

  await Promise.race([entered.promise, checking]);
  expect(visited).toEqual([null]);
  pending.resolve();

  await expect(checking).rejects.toBe(failure);
  expect(visited).toEqual([null, "rejected"]);
});
