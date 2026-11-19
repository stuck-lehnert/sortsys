import { expect, test } from "bun:test";
import { createPositionIndex } from "./positionIndex";
const text = (shortText = "Innenputz", description = "Laibungen sorgfältig vorbereiten", unit = "m²") => ({ shortText, description, unit });
const source = (id, content = [text()], version = "1", modifiedAt = "2026-11-11T12:00:00Z") => ({ id, version, fileName: `Leistungen-${id}.x84`, modifiedAt, async read() { return JSON.stringify(content); } });

test("cold searches progress in batches, deduplicate and match description prefixes", async () => {
  const rows = Array.from({ length: 9 }, (_, index) => source(String(index)));
  let reads = 0;
  const index = createPositionIndex(async () => rows, async xml => { reads++; return JSON.parse(xml); }, new AbortController().signal);
  try {
    expect((await index.search({ query: "LAIB VORB" })).indexing).toBe(true); expect(reads).toBe(4);
    expect((await index.search({ query: "laib vorb" })).indexing).toBe(true); expect(reads).toBe(8);
    const result = await index.search({ query: "laib vorb" }); expect(result.indexing).toBe(false); expect(result.items).toHaveLength(1); expect(reads).toBe(9);
    expect(result.items[0].description).toContain("Laibungen"); expect(result.items[0].sourceFile).toBe("Leistungen-0.x84");
    expect((await index.search({ query: "innen" })).items).toHaveLength(1); expect(reads).toBe(9);
    expect((await index.search({ query: "999.00" })).items).toEqual([]);
  } finally { index.close(); }
});
test("changed versions and withdrawn sources remove old matches, including the final empty inventory", async () => {
  let rows = [source("1")];
  const index = createPositionIndex(async () => rows, async xml => JSON.parse(xml), new AbortController().signal);
  try {
    expect((await index.search({ query: "Laib" })).items).toHaveLength(1);
    rows = [source("1", [text("Fensteranschluss", "Neue Beschreibung")], "2")];
    expect((await index.search({ query: "Laib" })).items).toEqual([]);
    expect((await index.search({ query: "Neue" })).items[0].shortText).toBe("Fensteranschluss");
    rows = []; expect(await index.search({ query: "" })).toEqual({ items: [], indexing: false });
  } finally { index.close(); }
});
test("newest distinct matches use exact microseconds and stop after twenty", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => source(String(i), [text(`Position ${i}`)], "1", `2026-11-11T12:00:00.${String(i).padStart(6, "0")}Z`));
  rows.push(source("old", [text("Älter ohne Nachkommastellen")]));
  const index = createPositionIndex(async () => rows, async xml => JSON.parse(xml), new AbortController().signal);
  try {
    let result; do { result = await index.search({ query: "" }); } while (result.indexing);
    expect(result.items).toHaveLength(20); expect(result.items[0].shortText).toBe("Position 24"); expect(result.items.at(-1).shortText).toBe("Position 5");
  } finally { index.close(); }
});

test("overlapping source reads keep the newest result first", async () => {
  const events = [];
  const older = source("old", [text()], "1", "2026-11-10T12:00:00Z");
  const newer = source("new");
  const rows = [
    {
      ...newer,
      async read() {
        events.push("start newer");
        await Promise.resolve();
        events.push("finish newer");
        return newer.read();
      },
    },
    {
      ...older,
      async read() {
        events.push("start older");
        events.push("finish older");
        return older.read();
      },
    },
  ];
  const index = createPositionIndex(
    async () => rows,
    async (xml) => JSON.parse(xml),
    new AbortController().signal,
  );
  try {
    const result = await index.search({ query: "innen" });
    expect(events).toEqual([
      "start newer",
      "start older",
      "finish older",
      "finish newer",
    ]);
    expect(result.items.map(({ sourceFile }) => sourceFile)).toEqual([
      newer.fileName,
    ]);
    expect(result.indexing).toBe(false);
  } finally {
    index.close();
  }
});

test("a prefetched source becoming a cache hit keeps later responses aligned", async () => {
  const repeated = source("1", [text("Innenputz")]);
  const next = source("2", [text("Außenputz")]);
  const index = createPositionIndex(
    async () => [repeated, repeated, next],
    async (xml) => JSON.parse(xml),
    new AbortController().signal,
  );
  try {
    const result = await index.search({ query: "" });
    const matches = result.items.map(({ shortText, sourceFile }) => [
      shortText,
      sourceFile,
    ]);
    expect(matches).toEqual([
      ["Innenputz", repeated.fileName],
      ["Außenputz", next.fileName],
    ]);
  } finally {
    index.close();
  }
});

test("failure of an older prefetched source affects only searches that need it", async () => {
  const positions = Array.from({ length: 20 }, (_, index) =>
    text(`Innenputz ${index}`),
  );
  const first = source("1", positions);
  const second = {
    ...source("2"),
    async read() {
      throw new Error("Encrypted source unavailable");
    },
  };
  const index = createPositionIndex(
    async () => [first, second],
    async (xml) => JSON.parse(xml),
    new AbortController().signal,
  );
  try {
    const complete = await index.search({ query: "innen" });
    expect(complete.items).toHaveLength(20);
    expect(complete.indexing).toBe(false);
    await expect(index.search({ query: "außen" })).rejects.toThrow(
      "Encrypted source unavailable",
    );
  } finally {
    index.close();
  }
});

test("late source data cannot survive a rights or account cancellation", async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { started = resolve; });
  const controller = new AbortController(), index = createPositionIndex(async () => [source("1")], async xml => { started(); await gate; return JSON.parse(xml); }, controller.signal);
  const pending = index.search({ query: "" }); await waiting; controller.abort(); release();
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  await expect(index.search({ query: "" })).rejects.toHaveProperty("name", "AbortError"); index.close();
});
test("unknown input fields, excessive queries and corrupt sources never supply results", async () => {
  const index = createPositionIndex(async () => [source("1")], async () => { throw new Error("corrupt source"); }, new AbortController().signal);
  try {
    await expect(index.search({ query: "", tenant: "other" })).rejects.toThrow();
    await expect(index.search({ query: "a".repeat(201) })).rejects.toThrow();
    await expect(index.search({ query: "" })).rejects.toThrow("corrupt source");
  } finally { index.close(); }
});

test("rapid query changes abort the old worker and skip superseded queued searches", async () => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; }); let calls = 0;
  const index = createPositionIndex(async () => [source("1")], async (xml, signal) => {
    if (++calls > 1) return JSON.parse(xml);
    started(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Superseded", "AbortError")), { once: true }));
  }, new AbortController().signal);
  try {
    const old = index.search({ query: "old" }); const oldResult = old.catch(error => error); await waiting;
    const middle = index.search({ query: "middle" }); const middleResult = middle.catch(error => error);
    const current = index.search({ query: "Laib" });
    expect((await oldResult).name).toBe("AbortError"); expect((await middleResult).name).toBe("AbortError");
    expect((await current).items).toHaveLength(1); expect(calls).toBe(2);
  } finally { index.close(); }
});
