import { afterEach, expect, test } from "bun:test";
import { processImport } from "./importProcessing";
import { llmActivity } from "./llmActivity";

afterEach(() => llmActivity.cancelAll());
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("the import dialog stays active through model completion and encrypted persistence", async () => {
  const model = deferred(), committed = deferred(), saving = deferred();
  let completed = false;
  const operation = processImport(async (signal, progress) => {
    await model.promise; signal.throwIfAborted();
    progress("Ergebnis wird gespeichert"); saving.resolve();
    await committed.promise; signal.throwIfAborted();
    return "encrypted-result-id";
  }).then(value => { completed = true; return value; });
  model.resolve(); await saving.promise;
  expect(completed).toBe(false);
  expect(llmActivity.snapshot()[0].kind).toBe("document-import");
  expect(llmActivity.snapshot()[0].stage).toBe("Ergebnis wird gespeichert");
  committed.resolve(); expect(await operation).toBe("encrypted-result-id");
  expect(llmActivity.snapshot()).toEqual([]);
});

test("closing the page cancels the live operation and suppresses late persistence", async () => {
  const model = deferred(); let signal, persisted = false;
  const result = processImport(async current => {
    signal = current; await model.promise; current.throwIfAborted(); persisted = true;
  });
  await Promise.resolve(); llmActivity.cancelAll();
  await expect(result).rejects.toHaveProperty("name", "AbortError");
  expect(signal.aborted).toBe(true); model.resolve(); await Promise.resolve();
  expect(persisted).toBe(false); expect(llmActivity.snapshot()).toEqual([]);
});

test("a failed import releases its activity and permits another attempt", async () => {
  await expect(processImport(async () => { throw new Error("Could not save"); })).rejects.toThrow("Could not save");
  expect(llmActivity.snapshot()).toEqual([]);
  expect(await processImport(async () => "saved-on-retry")).toBe("saved-on-retry");
  expect(llmActivity.snapshot()).toEqual([]);
});
