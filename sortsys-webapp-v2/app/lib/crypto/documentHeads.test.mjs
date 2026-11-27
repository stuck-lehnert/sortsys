import { afterEach, expect, spyOn, test } from "bun:test";
import { verifyDocumentHead } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "./session";
import { createDocumentHeadFixture } from "../data/testing/documentHeads.mjs";

afterEach(() => lockCryptoSession());

test("a genuinely signed reader head is rejected before opening XML or walking its history", async () => {
  const current = await createDocumentHeadFixture();
  const forged = await current.head(null, {}, true);
  expect(
    await verifyDocumentHead(
      forged,
      { tenant: "test", scope: current.scope, id: "3" },
      current.reader.signingKey.publicKey,
    ),
  ).toEqual(forged);
  await expect(current.verifier.check(forged)).rejects.toThrow();
  expect(current.counts()).toEqual({ historyReads: 0, keyReads: 0 });
});

test("a scope writer retains private price references but cannot replace prices, drop a part or finalize", async () => {
  const current = await createDocumentHeadFixture(["scope"]);
  const first = await current.head();
  const allowed = await current.head(
    first,
    { parts: await current.changedPart(first, "scope") },
    true,
  );
  expect(await current.verifier.check(allowed)).toEqual(allowed);
  const invalidChanges = [
    { parts: await current.changedPart(allowed, "offer-prices") },
    { parts: allowed.parts.filter((part) => part.facet === "scope") },
    { readOnly: true, locked: true },
  ];
  for (const changes of invalidChanges) {
    await expect(
      current.verifier.check(await current.head(allowed, changes, true)),
    ).rejects.toThrow();
  }
  expect(current.counts().keyReads).toBe(0);
});

test("a later valid writer signature cannot launder an unauthorized predecessor", async () => {
  const current = await createDocumentHeadFixture(["scope"]);
  const first = await current.head();
  const forged = await current.head(
    first,
    { parts: await current.changedPart(first, "offer-prices") },
    true,
  );
  const later = await current.head(forged, {
    policyVersion: "3",
    readOnly: true,
    locked: true,
  });
  await expect(current.verifier.check(later)).rejects.toThrow();
});

test("even a full writer cannot unlock read-only history or extend a finalized document", async () => {
  for (const locked of [false, true]) {
    const current = await createDocumentHeadFixture();
    const first = await current.head(null, { readOnly: true, locked });
    const next = await current.head(first, { readOnly: locked, locked });
    await expect(current.verifier.check(next)).rejects.toThrow();
  }
});

test("history pages preserve a legacy initial version and verified ancestors make later saves incremental", async () => {
  const current = await createDocumentHeadFixture();
  let latest = await current.head(null, { version: "7" });
  for (let version = 8; version <= 76; version += 1) {
    latest = await current.head(latest);
  }
  expect(await current.verifier.check(latest)).toEqual(latest);
  expect(current.counts().historyReads).toBe(3);
  const next = await current.head(latest);
  expect(await current.verifier.check(next)).toEqual(next);
  expect(current.counts()).toEqual({ historyReads: 3, keyReads: 0 });
  current.stop();
  await expect(current.verifier.check(next)).rejects.toThrow(
    "Replaced account",
  );
});

test("a known public document head needs no WebCrypto digests but still binds its parts", async () => {
  const current = await createDocumentHeadFixture();
  const head = await current.head();
  expect(await current.verifier.check(head)).toEqual(head);

  const digest = spyOn(crypto.subtle, "digest");
  try {
    expect(await current.verifier.check(structuredClone(head))).toEqual(head);
    expect(digest).not.toHaveBeenCalled();
  } finally {
    digest.mockRestore();
  }

  const altered = { ...head, parts: await current.changedPart(head, "scope") };
  await expect(current.verifier.check(altered)).rejects.toThrow();
});

test("historical writer rights remain valid after revocation while regrant never legitimizes a denied publication", async () => {
  const current = await createDocumentHeadFixture(["offer-prices"]);
  const first = await current.head();
  const old = await current.head(
    first,
    { parts: await current.changedPart(first, "offer-prices") },
    true,
  );
  await current.policy("4", []);
  expect(await current.verifier.check(old)).toEqual(old);
  const denied = await current.head(
    old,
    { parts: await current.changedPart(old, "scope") },
    true,
  );
  await current.policy("5", ["scope", "offer-prices"]);
  await expect(current.verifier.check(denied)).rejects.toThrow();
});
