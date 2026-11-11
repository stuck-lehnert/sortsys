import { expect, test } from "bun:test";
import { bindLLMPageLifetime, createLLMActivity } from "./llmActivity";

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("an LLM operation outlives a route subscriber and publishes only progress metadata", async () => {
  const activity = createLLMActivity(), response = deferred();
  let report, signal;
  const work = activity.run("document-import", "import", async (current, progress) => {
    signal = current; report = progress; return response.promise;
  });
  await Promise.resolve();
  const leave = activity.subscribe(() => {}); leave();
  report("Produktabgleich");
  expect(signal.aborted).toBe(false);
  expect(activity.snapshot()).toEqual([{ id: 1, kind: "document-import", label: "import", stage: "Produktabgleich" }]);
  expect(activity.snapshot()).toBe(activity.snapshot());
  response.resolve({ confidential: "Only the caller receives this" });
  expect(await work).toEqual({ confidential: "Only the caller receives this" });
  expect(activity.snapshot()).toEqual([]);
});

test("cancellation rejects immediately and late responses cannot restore the old activity", async () => {
  const activity = createLLMActivity(), old = deferred();
  let signal;
  const work = activity.run("chat", "chat-id", current => { signal = current; return old.promise; });
  await Promise.resolve(); activity.cancelAll();
  await expect(work).rejects.toHaveProperty("name", "AbortError");
  expect(signal.aborted).toBe(true); expect(activity.snapshot()).toEqual([]);
  expect(await activity.run("chat", "new", async () => "new answer")).toBe("new answer");
  old.resolve("old answer"); await Promise.resolve();
  expect(activity.snapshot()).toEqual([]);
});

test("only the active request signal is recognized for nested chat lifetime ownership", async () => {
  const activity = createLLMActivity(), unrelated = new AbortController();
  let owned;
  expect(activity.owns(unrelated.signal)).toBe(false);
  await activity.run("chat", "chat-id", async signal => {
    owned = signal;
    expect(activity.owns(signal)).toBe(true);
    expect(activity.owns(unrelated.signal)).toBe(false);
    expect(activity.snapshot()).toHaveLength(1);
  }, unrelated.signal);
  expect(activity.owns(owned)).toBe(false);
});

test("reload warns without cancelling; actual pagehide cancels even for the back-forward cache", async () => {
  const activity = createLLMActivity(), target = new EventTarget(), result = deferred();
  const detach = bindLLMPageLifetime(activity, target);
  try {
    expect(target.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
    const work = activity.run("chat", "chat-id", () => result.promise);
    await Promise.resolve();
    expect(target.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
    expect(activity.snapshot().length).toBe(1);
    target.dispatchEvent(new Event("pagehide"));
    await expect(work).rejects.toHaveProperty("name", "AbortError");
    expect(target.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
    result.resolve("late");
  } finally { detach(); }
});
