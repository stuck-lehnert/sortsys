import { expect, test } from "bun:test";
import {
  immutableObject as frameworkImmutableObject,
  immutableRecord as frameworkImmutableRecord,
  immutableWriteAction as frameworkImmutableWriteAction,
} from "../src/index";
import vector from "./fixtures/framework.json";
import {
  areaKey,
  bytes,
  createIdentity,
  encryptObject,
  encryptTombstone,
  immutableObject,
  immutablePrefix,
  immutableRecord,
  objectTimestampTarget,
  objectWriteAction,
  timestampTarget,
} from "../src/sortsys";

const context = {
  tenant: "test",
  scope: "project:2",
  facet: "billing" as const,
  object: immutableObject("project:2", "billing", "financial-invoice", "3"),
  revision: "1",
  generation: "1",
  policyVersion: "1",
  author: "user:1",
  format: "sortsys-object-v1",
};

test("the neutral API protects permanent records in an unrelated application's facet", () => {
  const permanent = vector.permanent;
  expect(frameworkImmutableObject("patient:ada", "patient-notes", "record", "visit_1"))
    .toBe(permanent.object);
  expect(frameworkImmutableRecord(permanent)).toEqual({ kind: "record", id: "visit_1" });
  expect(frameworkImmutableWriteAction(permanent)).toBe("create");
  expect(() => frameworkImmutableWriteAction({ ...permanent, revision: "2" })).toThrow();
  expect(() => frameworkImmutableWriteAction({ ...permanent, format: "sortsys-object-tombstone-v1" })).toThrow();
  expect(() => frameworkImmutableRecord({ ...permanent, facet: "appointments" })).toThrow();
  expect(() => frameworkImmutableObject("patient:ada", "invalid field", "record", "visit_1")).toThrow();
});

test("permanent record names bind scope, facet, category and stable record ID", () => {
  expect(immutablePrefix("project:2", "billing", "financial-invoice")).toBe(
    "immutable:project:2:billing:financial-invoice:",
  );
  expect(immutableRecord(context)).toEqual({
    kind: "financial-invoice",
    id: "3",
  });
  expect(objectWriteAction(context)).toBe("create");
  expect(
    immutableRecord({ ...context, object: "financial:2:invoice:3" }),
  ).toBeNull();
  for (const changed of [
    { scope: "project:4" },
    { facet: "master-data" },
    { object: context.object + ":extra" },
    { object: "immutable:project:2:billing:Invoice:3" },
    { object: "immutable:project:2:billing:invoice:" },
  ])
    expect(() =>
      immutableRecord({ ...context, ...changed } as typeof context),
    ).toThrow();
});

test("permanent records allow no update or tombstone, regardless of recovery generation", () => {
  for (const changed of [
    { revision: "2" },
    { revision: "3" },
    { revision: "2", format: "sortsys-object-tombstone-v1" },
  ])
    expect(() => objectWriteAction({ ...context, ...changed })).toThrow();
  const recovered = { ...context, generation: "4" };
  expect(objectWriteAction(recovered)).toBe("create");
  const absence = {
    ...context,
    scope: "absence:2",
    facet: "master-data" as const,
    object: immutableObject("absence:2", "master-data", "record", "3"),
  };
  expect(objectWriteAction(absence)).toBe("create");
});

test("permanent ciphertext receives an optional independently verifiable timestamp target", async () => {
  const identity = await createIdentity();
  const key = await areaKey();
  const { format, ...binding } = context;
  const envelope = await encryptObject(
    binding,
    bytes('{"amount":"134.00"}'),
    key,
    identity.signingKey.privateKey,
  );
  const target = await objectTimestampTarget(
    envelope,
    identity.signingKey.publicKey,
  );
  expect(target).toMatchObject({
    kind: "immutable-billing",
    object: context.object,
    revision: "1",
  });
  expect(timestampTarget(target)).toEqual(target!);
  expect(JSON.stringify(target)).not.toContain("134.00");
  expect(() =>
    timestampTarget({ ...target, kind: "immutable-master-data" }),
  ).toThrow();
  expect(() => timestampTarget({ ...target, revision: "2" })).toThrow();
  expect(() => timestampTarget({ ...target, ots: null })).toThrow();
  await expect(
    objectTimestampTarget(
      { ...envelope, signature: "" },
      identity.signingKey.publicKey,
    ),
  ).rejects.toThrow();
  const update = await encryptObject(
    { ...binding, revision: "2" },
    bytes("{}"),
    key,
    identity.signingKey.privateKey,
  );
  await expect(
    objectTimestampTarget(update, identity.signingKey.publicKey),
  ).rejects.toThrow();
  const deletion = await encryptTombstone(
    { ...binding, revision: "2" },
    key,
    identity.signingKey.privateKey,
  );
  await expect(
    objectTimestampTarget(deletion, identity.signingKey.publicKey),
  ).rejects.toThrow();
});
