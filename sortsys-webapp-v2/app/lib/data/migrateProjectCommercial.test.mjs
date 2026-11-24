import { expect, spyOn, test } from "bun:test";
import * as migration from "../crypto/migrationOrigin";
import { prepareProjectCommercial } from "./migrateProjectCommercial";
import * as provisioning from "./prepareCollections";
import * as products from "./products";
import * as objects from "./protectedObjects";
import { row } from "./testing/businessRow.mjs";

test("project offer and procurement registers share bounded reads and commits", async () => {
  const rows = {
    projects: Array.from({ length: 9 }, (_, index) => ({
      values: { id: String(index + 1) },
    })),
    commercial_cases: [
      { values: { id: "11", project_id: "1", kind: "offer" } },
      {
        values: { id: "12", project_id: "2", kind: "alternative", status: "accepted" },
      },
      {
        values: {
          id: "13",
          project_id: "1",
          kind: "subcontract",
          status: "awarded",
          parent_case_id: "11",
          scope_item_ids: '["wall"]',
        },
      },
    ],
    project_financial_entries: [row("project_financial_entries", {
      id: "14",
      project_id: "1",
      type: "offer",
      commercial_case_id: "11",
      amount: 1299.5,
    })],
  };

  const saved = new Map();
  const commits = [];
  const reads = [];
  const open = Object.assign(
    (area) => ({
      async read(prefix) {
        expect(prefix).toBe(area.prefix);
        const packet = saved.get(area.domain);
        return packet ? [packet] : [];
      },
      async packet(object, value) {
        return {
          domain: area.domain,
          envelope: { object, ciphertext: "", signature: `signed:${object}` },
          value,
        };
      },
      snapshot: () => "0",
      close() {},
    }),
    {
      async prefetch(areas) {
        reads.push(areas.length);
      },
    },
  );
  const client = {
    async invalidate() {},
    async mutate(path, { heads, objects }) {
      expect(path).toBe("zerotrust.objects.batch");
      expect(heads.map(({ domain }) => domain)).toEqual(
        objects.map(({ domain }) => domain),
      );
      commits.push(objects);
      for (const packet of objects) saved.set(packet.domain, packet);
      return [null, null];
    },
  };

  const read = spyOn(products, "readBusinessRows")
    .mockImplementation(async (_, table) => rows[table]);
  const prepare = spyOn(provisioning, "prepareOwnerCollections")
    .mockResolvedValue(undefined);
  const access = spyOn(objects, "protectedCollections").mockResolvedValue(open);
  const attest = spyOn(migration, "migrationOriginAttester")
    .mockResolvedValue(async (packet) => packet);
  const signal = new AbortController().signal;

  try {
    await prepareProjectCommercial(client, {}, "owner", signal);

    const areas = prepare.mock.calls[0][2];
    expect(areas.map(({ domain }) => domain)).toEqual([...saved.keys()]);
    expect(commits.map((objects) => objects.length)).toEqual([16, 2]);
    expect(reads).toEqual([16, 16, 2, 2]);
    expect(access).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledTimes(1);

    const find = (project, facet) => [...saved.values()].find(
      ({ value }) => value.projectId === project && value.facet === facet,
    ).value;

    expect(find("1", "offer-prices")).toMatchObject({
      mainCaseId: "b",
      offers: [{ row: rows.project_financial_entries[0], exactAmount: null }],
      awards: [],
    });
    expect(find("2", "offer-prices").mainCaseId).toBe("c");
    expect(find("1", "procurement")).toMatchObject({
      mainCaseId: null,
      offers: [],
      awards: [{ caseId: "d", parentCaseId: "b", scopeItemIds: ["wall"] }],
    });

    await prepareProjectCommercial(client, {}, "owner", signal);
    expect(commits).toHaveLength(2);
    expect(reads).toEqual([16, 16, 2, 2, 16, 2]);
    expect(attest).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of [attest, access, prepare, read]) spy.mockRestore();
  }
});
