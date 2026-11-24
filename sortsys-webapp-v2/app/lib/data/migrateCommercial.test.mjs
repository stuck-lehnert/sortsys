import { expect, spyOn, test } from "bun:test";
import { COMMERCIAL_FACETS, commercialCollection } from "./commercialAreas";
import * as copier from "./copyCollection";
import * as billing from "./migrateBilling";
import { prepareCommercialCases } from "./migrateCommercial";
import * as projectCommercial from "./migrateProjectCommercial";
import * as projectFinance from "./migrateProjectFinance";
import * as provisioning from "./prepareCollections";
import { publicId } from "./products";
import * as objects from "./protectedObjects";
import { row } from "./testing/businessRow.mjs";

test("commercial copy groups share the bounded copier without changing facet payloads", async () => {
  const cases = ["101", "102", "103", "104", "105"].map((id) => ({
    id: publicId(id),
    rows: [
      row("commercial_cases", {
        id,
        kind: "offer",
        status: "draft",
        title: `Angebot ${id}`,
        scope_item_ids: "[]",
      }),
    ],
  }));
  const open = () => {
    throw new Error("Unexpected collection read outside the copier");
  };

  const read = spyOn(billing, "readCommercialSource").mockResolvedValue(cases);
  const prepareAreas = spyOn(provisioning, "prepareOwnerCollections").mockResolvedValue();
  const access = spyOn(objects, "protectedCollections").mockResolvedValue(open);
  const copy = spyOn(copier, "copyProtectedSingletons").mockResolvedValue();
  const registers = spyOn(billing, "prepareBillingRegisters").mockResolvedValue();
  const projects = spyOn(projectCommercial, "prepareProjectCommercial").mockResolvedValue();
  const finance = spyOn(projectFinance, "prepareProjectFinance").mockResolvedValue();

  try {
    const client = {};
    const source = {};
    const { signal } = new AbortController();

    await prepareCommercialCases(client, source, "owner", signal);

    const groups = copy.mock.calls.map(([, entries]) => entries);
    expect(groups.map((entries) => entries.length)).toEqual([
      4 * COMMERCIAL_FACETS.length,
      COMMERCIAL_FACETS.length,
    ]);
    for (const [, , copySignal, context] of copy.mock.calls) {
      expect(copySignal).toBe(signal);
      expect(context).toBe(open);
    }

    const areas = cases.flatMap(({ id }) =>
      COMMERCIAL_FACETS.map((facet) => commercialCollection(id, facet)),
    );
    expect(prepareAreas).toHaveBeenCalledWith(client, "owner", areas, signal);
    expect(groups.flat().map(({ area }) => area)).toEqual(areas);
    for (const { area, row, partial, validate } of groups.flat()) {
      expect(partial).toBe(true);
      expect(row.id).toBe(`${area.prefix}case`);
      expect(validate(row.value, row.id)).toEqual(row.value);
      expect(() => validate(row.value, `${area.prefix}other`)).toThrow();
    }

    expect(registers).toHaveBeenCalledWith(client, cases, signal);
    expect(projects).toHaveBeenCalledWith(client, source, "owner", signal);
    expect(finance).toHaveBeenCalledWith(client, source, "owner", signal);
  } finally {
    for (const spy of [read, prepareAreas, access, copy, registers, projects, finance]) {
      spy.mockRestore();
    }
  }
});
