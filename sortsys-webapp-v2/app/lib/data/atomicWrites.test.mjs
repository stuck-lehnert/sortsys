import { expect, test } from "bun:test";
import { commitProtectedWrites, ProtectedWriteConflict } from "./atomicWrites";

function group(count) { return { packets: Array.from({ length: count }, (_, id) => ({ domain: "area", messageId: `msg-${id}`, envelope: { object: `item:${id}`, ciphertext: "ciphertext" } })), head: { domain: "area", sequence: "1" }, async verify() { return true; }, close() {} }; }

test("large encrypted batches upload bounded parts and publish only once", async () => {
  const calls = [], source = group(150);
  const client = { async mutate(path, input) { calls.push({ path, input }); return [path.endsWith(".stage") ? { id: String(calls.length).padStart(64, "0") } : { success: true }, null]; }, async invalidate() {} };
  await commitProtectedWrites(client, [source], new AbortController().signal);
  expect(calls.map(call => call.path)).toEqual(["zerotrust.objects.stage", "zerotrust.objects.stage", "zerotrust.objects.stage", "zerotrust.objects.commit"]);
  expect(calls.slice(0, 3).map(call => call.input.objects.length)).toEqual([64, 64, 22]);
  expect(calls[3].input.heads).toEqual([source.head]); expect(calls[3].input.parts).toHaveLength(3);
});

test("a failed or cancelled stage never attempts publication", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(), paths = [], failed = new Error("Stage unavailable");
    const client = { async mutate(path) { paths.push(path); if (cancel) controller.abort(); return [null, failed]; }, async invalidate() {} };
    await expect(commitProtectedWrites(client, [group(70)], controller.signal)).rejects.toThrow();
    expect(paths).toEqual(["zerotrust.objects.stage"]);
  }
});

test("a successful commit response still requires checked readback", async () => {
  const source = group(70); source.verify = async () => false;
  const client = { async mutate(path) { return [path.endsWith(".stage") ? { id: "a".repeat(64) } : { success: true }, null]; }, async invalidate() {} };
  await expect(commitProtectedWrites(client, [source], new AbortController().signal)).rejects.toBeInstanceOf(ProtectedWriteConflict);
});

test("a rejected publication retains its original conflict when readback has no newly created object", async () => {
  const conflict = Object.assign(new Error("Concurrent write"), { code: "CONFLICT" }), missing = new Error("Object was never created"), source = group(1);
  source.verify = async () => { throw missing; };
  const client = { async mutate() { return [null, conflict]; }, async invalidate() {} };
  await expect(commitProtectedWrites(client, [source], new AbortController().signal)).rejects.toBe(conflict);
  client.mutate = async () => [{ success: true }, null];
  await expect(commitProtectedWrites(client, [source], new AbortController().signal)).rejects.toBe(missing);
});
