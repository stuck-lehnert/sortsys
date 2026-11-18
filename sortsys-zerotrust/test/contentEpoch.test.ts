import { expect, test } from "bun:test";
import {
  base64,
  contentEpoch,
  contentEpochFingerprint,
  contentEpochFollows,
  contentEpochNumber,
  contentPin,
  contentPinKey,
  createIdentity,
  logicalRecord,
  namespaceRecord,
  signContentEpoch,
  verifyContentEpoch,
} from "../src/index";

async function fixture() {
  const firstKey = await createIdentity();
  const currentKey = await createIdentity();
  const first = await signContentEpoch(
    {
      format: "zt-content-epoch-v1",
      tenant: "laboratory",
      authorityGeneration: "1",
      number: "1",
      previous: null,
      sourceNumber: "0",
      sourceHead: null,
      snapshot: base64(new Uint8Array(32).fill(1)),
      actor: "researcher:admin",
    },
    firstKey.signingKey.privateKey,
  );
  const second = await signContentEpoch(
    {
      ...first,
      authorityGeneration: "2",
      number: "2",
      previous: await contentEpochFingerprint(first),
      sourceNumber: "1",
      sourceHead: await contentEpochFingerprint(first),
      snapshot: base64(new Uint8Array(32).fill(2)),
    },
    currentKey.signingKey.privateKey,
  );
  const third = await signContentEpoch(
    { ...second, number: "3", previous: await contentEpochFingerprint(second) },
    currentKey.signingKey.privateKey,
  );
  const authority = (generation: string) => {
    if (generation === "1") return firstKey.signingKey.publicKey;
    if (generation === "2") return currentKey.signingKey.publicKey;
    throw new Error("Unknown authority generation");
  };
  return { firstKey, currentKey, first, second, third, authority };
}

test("successive content restores bind the current head and an older published source across authority changes", async () => {
  const { first, second, third, authority } = await fixture();
  for (const value of [first, second, third]) {
    expect(
      await verifyContentEpoch(
        value,
        { tenant: "laboratory", actor: "researcher:admin" },
        authority,
      ),
    ).toEqual(value);
  }
  await contentEpochFollows(first, null, null);
  await contentEpochFollows(second, first, first);
  await contentEpochFollows(third, second, first);
  expect(await contentEpochFingerprint(third)).not.toBe(
    await contentEpochFingerprint(second),
  );
});

test("provider keys, substituted snapshots, actors and previous authorities cannot authorize a restore", async () => {
  const { second, authority } = await fixture();
  const provider = await createIdentity();
  await expect(
    verifyContentEpoch(
      second,
      { tenant: "laboratory" },
      () => provider.signingKey.publicKey,
    ),
  ).rejects.toThrow();
  for (const changed of [
    { ...second, snapshot: base64(new Uint8Array(32).fill(9)) },
    { ...second, actor: "researcher:provider" },
    { ...second, previous: base64(new Uint8Array(32).fill(9)) },
  ])
    await expect(
      verifyContentEpoch(changed, { tenant: "laboratory" }, authority),
    ).rejects.toThrow();
  await expect(
    verifyContentEpoch(second, { tenant: "other" }, authority),
  ).rejects.toThrow();
  await expect(
    verifyContentEpoch(
      second,
      { tenant: "laboratory", authorityGeneration: "1" },
      authority,
    ),
  ).rejects.toThrow();
  await expect(
    verifyContentEpoch(
      second,
      { tenant: "laboratory", actor: "researcher:provider" },
      authority,
    ),
  ).rejects.toThrow();
});

test("stale predecessors and independently signed source forks do not follow the selected chain", async () => {
  const { firstKey, currentKey, first, second, third } = await fixture();
  const fork = await signContentEpoch(
    { ...first, snapshot: base64(new Uint8Array(32).fill(7)) },
    firstKey.signingKey.privateKey,
  );
  await expect(contentEpochFollows(third, first, first)).rejects.toThrow();
  await expect(contentEpochFollows(third, second, fork)).rejects.toThrow();
  await expect(contentEpochFollows(third, second, null)).rejects.toThrow();
  await expect(contentEpochFollows(second, null, first)).rejects.toThrow();
  const oldAuthority = await signContentEpoch(
    { ...third, authorityGeneration: "1" },
    firstKey.signingKey.privateKey,
  );
  await expect(
    contentEpochFollows(oldAuthority, second, first),
  ).rejects.toThrow();
  const foreign = await signContentEpoch(
    { ...first, tenant: "other" },
    currentKey.signingKey.privateKey,
  );
  await expect(contentEpochFollows(second, foreign, first)).rejects.toThrow();
});

test("content epoch numbers and null bindings are canonical and reject extra fields", async () => {
  const { first, second } = await fixture();
  for (const number of [
    "00",
    "01",
    "-1",
    "1.0",
    "9223372036854775808",
    1,
    null,
  ]) {
    expect(() => contentEpochNumber(number)).toThrow();
  }
  expect(contentEpochNumber("0")).toBe("0");
  for (const changed of [
    { ...first, number: "0" },
    { ...first, previous: first.snapshot },
    { ...second, previous: null },
    { ...first, sourceNumber: "1" },
    { ...second, sourceHead: null },
    { ...second, sourceNumber: "2" },
    { ...first, snapshot: "invalid" },
    { ...first, extra: true },
  ])
    expect(() => contentEpoch(changed)).toThrow();
});

test("physical namespaces retain logical IDs, reject nesting and do not alias prefix-like numbers", () => {
  const original = { collection: "notes", key: "record:42" };
  for (const number of ["0", "1", "10", "9223372036854775807"]) {
    const physical = namespaceRecord(original, number);
    expect(logicalRecord(physical, number)).toEqual(original);
    expect(physical.key).toBe(original.key);
  }
  expect(namespaceRecord(original, "1").collection).not.toBe(
    namespaceRecord(original, "10").collection,
  );
  expect(() => logicalRecord(namespaceRecord(original, "10"), "1")).toThrow();
  expect(() => namespaceRecord(namespaceRecord(original, "1"), "2")).toThrow();
  const copy = namespaceRecord(original, "0");
  copy.key = "changed";
  expect(original.key).toBe("record:42");
  const longest = { ...original, collection: "n".repeat(192) };
  expect(namespaceRecord(longest, "0")).toEqual(longest);
  expect(() => namespaceRecord(longest, "1")).toThrow();
});

test("immutable pins bind one logical record to its exact physical namespace and preserve key ordering", async () => {
  const first = { collection: "notes", key: "record:01" };
  const second = { ...first, key: "record:02" };
  const value = contentPin({
    format: "zt-content-pin-v1",
    record: first,
    number: "2",
    physical: namespaceRecord(first, "2"),
  });
  const a = await contentPinKey(first);
  const b = await contentPinKey(second);
  expect(a.collection).toBe(b.collection);
  expect(a.key < b.key).toBe(true);
  expect(
    (await contentPinKey({ ...first, collection: "other" })).collection,
  ).not.toBe(a.collection);
  expect(() =>
    contentPin({ ...value, physical: namespaceRecord(first, "1") }),
  ).toThrow();
  expect(() =>
    contentPin({ ...value, physical: namespaceRecord(second, "2") }),
  ).toThrow();
  value.record.key = "changed";
  expect(first.key).toBe("record:01");
});
