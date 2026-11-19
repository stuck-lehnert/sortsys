import { expect, test } from "bun:test";
import { chatToolPaths, openChatTools } from "./chatTools";
import { toolCollection } from "./toolData";

const master = toolCollection("tool", "1", "master-data");
const inventory = toolCollection("tool", "1", "measurement");
const booking = toolCollection("tool-tracking", "2", "master-data");

function access(snapshot, areas) {
  const domains = areas.map(({ domain }) => ({ id: domain }));
  const permitted = new Set(domains.map(({ id }) => id));
  return { domains, snapshot, canRead: ({ domain }) => permitted.has(domain) };
}

test("inventory coverage needs both permissions on the same tool", () => {
  const unrelated = toolCollection("tool", "2", "measurement");
  expect(chatToolPaths(access("first", [master, unrelated, booking]))).toEqual([
    "tools.list", "tools.get", "tools.inventories.list", "tools.trackings.list",
  ]);
  expect(chatToolPaths(access("second", [master, inventory, booking])))
    .toContain("tools.inventories.overview");
  expect(chatToolPaths(access("own-only", [booking]))).toEqual(["tools.trackings.list"]);
});

test("tool results are discarded if permissions change while an answer is prepared", async () => {
  let authorized = access("readable", [master]);
  const client = {
    async query(path, input) {
      expect(path).toBe("tools.list");
      expect(input).toEqual({ search: "Rührwerk" });
      authorized = access("revoked", []);
      return [[{ id: "1", label: "Rührwerk" }], null];
    },
  };
  const tools = openChatTools(client, async () => authorized);
  await expect(tools.search("tools.list", { query: "Rührwerk" }, 1, new AbortController().signal))
    .rejects.toThrow();
});

test("booking search prefers the current tool name when its master data is readable", async () => {
  const oldName = { customId: 20, brand: "Werkzeugbau", category: "Messgerät", label: "Rotationslaser" };
  const newName = { ...oldName, label: "Nivelliergerät" };
  const client = {
    async query(path, input) {
      if (path === "tools.list") return [[{ id: "1", ...newName }], null];
      expect(path).toBe("tools.trackings.list");
      expect(input.finished).toBe(false);
      return [[{
        id: "2", toolId: "1", toolSummary: oldName, responsibleUserId: null,
        projectId: null, comment: null, toolUsageCostPerDay: 25,
      }], null];
    },
  };
  const signal = new AbortController().signal;
  const current = openChatTools(client, async () => access("member", [master, booking]));
  const result = await current.search("tools.trackings.list", { query: "Nivellier" }, 10, signal);
  expect(result.records[0].tool).toEqual(newName);
  expect(result.records[0]).not.toHaveProperty("toolUsageCostPerDay");

  const own = openChatTools(client, async () => access("own", [booking]));
  const ownResult = await own.search("tools.trackings.list", { query: "Rotations" }, 10, signal);
  expect(ownResult.records[0].tool).toEqual(oldName);
});
