import { describe, expect, test } from "bun:test";
import { createActivityHistory } from "./activityHistory";

function item(id, resourceId = id, resourceType = "project") {
  return { id, resourceId, resourceType };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe("dashboard activity history", () => {
  test("keeps a stable snapshot and does not load past a short first page", async () => {
    const history = createActivityHistory([item("newest")], 2);
    const snapshot = history.getSnapshot();
    let requested = false;

    await history.loadOlder(async () => {
      requested = true;
      return [];
    });

    expect(history.getSnapshot()).toBe(snapshot);
    expect(snapshot.complete).toBe(true);
    expect(requested).toBe(false);
  });

  test("appends older resources without changing existing order or input arrays", async () => {
    const firstPage = [item("4"), item("3")];
    const page = [item("2"), item("1")];
    const history = createActivityHistory(firstPage, 2);
    const cursors = [];

    await history.loadOlder(async (cursor) => {
      cursors.push(cursor);
      return page;
    });

    expect(cursors).toEqual(["3"]);
    expect(history.getSnapshot().items.map((entry) => entry.id)).toEqual([
      "4",
      "3",
      "2",
      "1",
    ]);
    expect(history.getSnapshot().complete).toBe(false);
    expect(firstPage).toEqual([item("4"), item("3")]);
    expect(page).toEqual([item("2"), item("1")]);
  });

  test("suppresses simultaneous loads and notifies active subscribers", async () => {
    const history = createActivityHistory([item("4"), item("3")], 2);
    const response = deferred();
    const updates = [];
    let duplicateRequested = false;

    const unsubscribe = history.subscribe(() => {
      updates.push(history.getSnapshot().loading);
    });

    const pending = history.loadOlder(() => response.promise);

    await history.loadOlder(async () => {
      duplicateRequested = true;
      return [];
    });
    response.resolve([item("2")]);
    await pending;

    unsubscribe();

    expect(duplicateRequested).toBe(false);
    expect(updates).toEqual([true, false]);
    expect(history.getSnapshot().items).toEqual([
      item("4"),
      item("3"),
      item("2"),
    ]);
  });

  test("preserves loaded rows after failure and retries the same cursor", async () => {
    const history = createActivityHistory([item("4"), item("3")], 2);
    const cursors = [];

    await history.loadOlder(async (cursor) => {
      cursors.push(cursor);
      throw new Error("offline");
    });

    expect(history.getSnapshot()).toEqual({
      items: [item("4"), item("3")],
      loading: false,
      complete: false,
      error: true,
    });

    await history.loadOlder(async (cursor) => {
      cursors.push(cursor);
      return [item("2")];
    });

    expect(cursors).toEqual(["3", "3"]);
    expect(history.getSnapshot().error).toBe(false);
    expect(history.getSnapshot().complete).toBe(true);
  });

  test("finishes after an empty page at an exact page boundary", async () => {
    const history = createActivityHistory([item("4"), item("3")], 2);

    await history.loadOlder(async () => [item("2"), item("1")]);
    await history.loadOlder(async () => []);

    let requested = false;

    await history.loadOlder(async () => {
      requested = true;
      return [];
    });

    expect(history.getSnapshot().complete).toBe(true);
    expect(history.getSnapshot().items).toHaveLength(4);
    expect(requested).toBe(false);
  });

  test("advances over overlapping resources using the server page cursor", async () => {
    const history = createActivityHistory([item("10", "a"), item("9", "b")], 2);
    const cursors = [];

    await history.loadOlder(async (cursor) => {
      cursors.push(cursor);
      return [item("8", "a"), item("7", "b")];
    });
    await history.loadOlder(async (cursor) => {
      cursors.push(cursor);
      return [item("6", "c")];
    });

    expect(cursors).toEqual(["9", "7"]);
    expect(history.getSnapshot().items).toEqual([
      item("10", "a"),
      item("9", "b"),
      item("6", "c"),
    ]);
    expect(history.getSnapshot().complete).toBe(true);
  });

  test("does not merge different resource types with the same public id", () => {
    const history = createActivityHistory(
      [item("4", "same", "project"), item("3", "same", "customer")],
      2,
    );

    expect(history.getSnapshot().items).toHaveLength(2);
  });

  test("isolates late responses after a refreshed first page or session change", async () => {
    const previous = createActivityHistory([item("4"), item("3")], 2);
    const response = deferred();
    const pending = previous.loadOlder(() => response.promise);

    const refreshed = createActivityHistory([item("new")], 2);
    let refreshedUpdates = 0;

    refreshed.subscribe(() => {
      refreshedUpdates += 1;
    });

    response.resolve([item("2")]);
    await pending;

    expect(refreshed.getSnapshot().items).toEqual([item("new")]);
    expect(refreshedUpdates).toBe(0);
  });

  test("stops if the server returns the requested cursor without progress", async () => {
    const history = createActivityHistory([item("4"), item("3")], 2);

    await history.loadOlder(async () => [item("4"), item("3")]);

    expect(history.getSnapshot().complete).toBe(true);
    expect(history.getSnapshot().items).toHaveLength(2);
  });
});
