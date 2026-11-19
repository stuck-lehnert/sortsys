import { expect, test } from "bun:test";
import { base64 } from "@sortsys/zerotrust/sortsys";
import { eventFingerprint, watchEncryptedEvents } from "./events";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { lockCryptoSession } from "../crypto/session";

test("event fingerprints are canonical 32-byte hashes, including leading base64url symbols", () => {
  for (const first of [0, 248, 255]) {
    const bytes = new Uint8Array(32);
    bytes[0] = first;
    const value = base64(bytes);
    expect(eventFingerprint(value)).toBe(value);
  }
  for (const value of [
    null,
    {},
    "plain-identifier",
    base64(new Uint8Array(31)),
    base64(new Uint8Array(33)),
    base64(new Uint8Array(32)) + "=",
  ])
    expect(() => eventFingerprint(value)).toThrow();
});

async function until(test) {
  const deadline = Date.now() + 2000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Event callback did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const scenario of ["unchanged", "changed", "failed admission"]) {
  test(`reconnecting resynchronizes data with ${scenario} event authorization`, async () => {
    const failFirst = scenario === "failed admission";
    const fixture = await protectedTenant([]);
    fixture.client.mutate = async () => [
      { ticket: "disposable-test-ticket", subject: "user:1", generation: "1" },
      null,
    ];
    const original = globalThis.WebSocket;
    const sockets = [];
    const fingerprint = base64(new Uint8Array(32).fill(8));
    const changedFingerprint = base64(new Uint8Array(32).fill(9));
    class TestSocket {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        sockets.push(this);
        queueMicrotask(() => {
          if (failFirst && sockets.length === 1) {
            this.close();
          } else {
            this.message({ type: "challenge", nonce: "disposable-challenge" });
          }
        });
      }
      message(value) {
        this.onmessage?.({ data: JSON.stringify(value) });
      }
      send(payload) {
        const proof = JSON.parse(payload);
        expect(proof.ticket).toBe("disposable-test-ticket");
        expect(typeof proof.proof).toBe("string");
        this.message({
          type: "ready",
          fingerprint:
            scenario === "changed" && sockets.length > 1
              ? changedFingerprint
              : fingerprint,
        });
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.();
      }
    }
    globalThis.WebSocket = TestSocket;
    const controller = new AbortController();
    const changes = [];
    let admissions = 0;
    const watched = watchEncryptedEvents(
      fixture.client,
      "http://127.0.0.1/api/v2",
      (change) => changes.push(change),
      controller.signal,
      () => admissions++,
    );
    try {
      await until(() => admissions === 1);
      expect(changes).toEqual([]);
      if (!failFirst) {
        sockets[0].message({
          type: "changed",
          reset: false,
          all: false,
          control: false,
          staged: true,
          domains: { "commercial:2:scope": "2" },
          fingerprint,
        });
        await until(() => changes.length === 1);
        expect(changes[0].staged).toBe(true);
        sockets[0].message({
          type: "changed",
          reset: false,
          all: false,
          control: false,
          domains: { "catalog:products:master-data": "1" },
          fingerprint,
        });
        await until(() => changes.length === 2);
        expect(changes[1].staged).toBeUndefined();
        expect(changes[1].domains).toEqual({
          "catalog:products:master-data": "1",
        });
        sockets[0].close();
      }
      await until(() => changes.some((change) => change.all));
      expect(admissions).toBe(1);
      const last = changes.at(-1);
      expect(last.reset).toBe(scenario === "changed");
      expect(last.all).toBe(true);
      expect(last.control).toBe(scenario !== "unchanged");
      expect(last.domains).toEqual({});
    } finally {
      controller.abort();
      await watched;
      globalThis.WebSocket = original;
      await lockCryptoSession();
    }
  });
}
