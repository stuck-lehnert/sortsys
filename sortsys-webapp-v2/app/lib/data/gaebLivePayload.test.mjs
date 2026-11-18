import { expect, test } from "bun:test";
import { initializeSharedField, SharedFields } from "@sortsys/gaeb";
import { bytes } from "@sortsys/zerotrust/sortsys";
import {
  gaebLivePayloadInbox,
  GAEB_LIVE_PAYLOAD_MAX_BYTES,
  splitGaebLivePayload,
} from "./gaebLivePayload";
import { DOCUMENT_MESSAGE_MAX_BYTES } from "./documentMessages";

function received(value, changes = {}) {
  return {
    value,
    author: "user:writer",
    authorityGeneration: "1",
    content: "current",
    kind: "initialize",
    ...changes,
  };
}

test("short updates keep their original single-packet format", () => {
  const value = { facet: "scope", data: "YWJj" };
  expect(splitGaebLivePayload(value)).toEqual([value]);
  expect(gaebLivePayloadInbox().stage().receive(received(value))).toEqual({
    value,
  });
});

test("a long UTF-8 initializer reaches the editor only after all pages are accepted", () => {
  const field = "item-1:text:0";
  const text = "Fläche ↔ 🧱\t".repeat(13_000);
  const value = { field, value: text, data: initializeSharedField(field, text) };
  const parts = splitGaebLivePayload(value);
  expect(parts.length).toBeGreaterThan(2);
  const inbox = gaebLivePayloadInbox();
  for (const part of parts.slice(0, -1)) {
    expect(bytes(JSON.stringify(part)).length).toBeLessThan(
      DOCUMENT_MESSAGE_MAX_BYTES,
    );
    const page = inbox.stage();
    expect(page.receive(received(part))).toBeUndefined();
    page.commit();
  }
  const last = received(parts.at(-1));
  expect(inbox.stage().receive(last)).toEqual({ value });
  // A failed Yjs page must be able to repeat its last fragment.
  const replay = inbox.stage();
  const opened = replay.receive(last);
  expect(opened).toEqual({ value });
  const fields = new SharedFields();
  const reception = fields.beginReceive();
  try {
    reception.initialize(field, opened.value.value, opened.value.data);
    reception.commit();
    expect(fields.value(field)).toBe(text);
  } finally {
    reception.destroy();
    fields.destroy();
  }
  replay.commit();
  expect(inbox.stage().receive(last)).toBeUndefined();
});

test("parts never combine across authors, authority generations, content heads or message kinds", () => {
  const value = { value: "Ziegel und Mörtel".repeat(4500) };
  const [first, ...rest] = splitGaebLivePayload(value);
  const inbox = gaebLivePayloadInbox();
  const initial = inbox.stage();
  expect(initial.receive(received(first))).toBeUndefined();
  initial.commit();

  const interleaved = inbox.stage();
  for (const binding of [
    { author: "user:other" },
    { authorityGeneration: "2" },
    { content: "older" },
    { kind: "update" },
  ]) {
    for (const part of rest) {
      expect(interleaved.receive(received(part, binding))).toBeUndefined();
    }
  }
  expect(interleaved.receive(received(first))).toBeUndefined();
  for (const part of rest.slice(0, -1)) {
    expect(interleaved.receive(received(part))).toBeUndefined();
  }
  expect(interleaved.receive(received(rest.at(-1)))).toEqual({ value });
});

test("oversized, inconsistent and conflicting parts cannot complete a message", () => {
  expect(() =>
    splitGaebLivePayload({ value: "x".repeat(GAEB_LIVE_PAYLOAD_MAX_BYTES) }),
  ).toThrow();
  const parts = splitGaebLivePayload({ value: "x".repeat(100_000) });
  const [first, second] = parts;
  const page = gaebLivePayloadInbox().stage();
  expect(() => page.receive(received({ ...first, count: 1000 }))).toThrow();
  expect(page.receive(received(first))).toBeUndefined();
  expect(() => page.receive(received({ ...second, count: 4 }))).toThrow();
  expect(() =>
    page.receive(received({ ...first, data: "A" + first.data.slice(1) })),
  ).toThrow();
  expect(() => page.receive(received({ ...second, data: "" }))).toThrow();
});

test("abandoned incomplete groups cannot permanently block new messages", () => {
  const value = { value: "x".repeat(70_000) };
  const groups = Array.from({ length: 9 }, () => splitGaebLivePayload(value));
  const page = gaebLivePayloadInbox().stage();
  for (const [first] of groups.slice(0, 8)) {
    expect(page.receive(received(first))).toBeUndefined();
  }
  expect(page.discarded()).toBe(false);
  expect(page.receive(received(groups[8][0]))).toBeUndefined();
  expect(page.discarded()).toBe(true);
  expect(page.receive(received(groups[0][1]))).toBeUndefined();
  expect(page.receive(received(groups[8][1]))).toEqual({ value });
});
