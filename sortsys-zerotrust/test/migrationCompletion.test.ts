import { expect, test } from "bun:test";
import vector from "./fixtures/migration-completion.json";
import {
  base64,
  importSigningKey,
  InvalidProtectedData,
  MigrationInventory,
  migrationSeal,
  migrationSealFrame,
  verify,
} from "../src/index";

test("portable migration inventories and seals have the same Rust/browser frame", async () => {
  const inventory = new MigrationInventory();
  for (const entry of vector.entries) inventory.add(entry);
  expect(inventory.finish()).toEqual(vector.seal.source);
  expect(inventory.finish()).toEqual(vector.seal.source);
  expect(new MigrationInventory().finish()).toEqual(vector.seal.target);
  const seal = migrationSeal(vector.seal);
  expect(base64(migrationSealFrame(seal))).toBe(vector.frame);
  await verify(
    await importSigningKey(vector.identity.signingKey),
    seal.proof,
    migrationSealFrame(seal),
  );
});

test("migration commitments reject repeats, reordering and appending after completion", () => {
  const inventory = new MigrationInventory();
  inventory.add(vector.entries[1]!);
  expect(() => inventory.add(vector.entries[0]!)).toThrow(InvalidProtectedData);
  expect(() => inventory.add(vector.entries[1]!)).toThrow(InvalidProtectedData);
  inventory.finish();
  expect(() =>
    inventory.add({ ...vector.entries[1]!, id: "patient:2" }),
  ).toThrow(InvalidProtectedData);
  for (const revision of ["-1", "01", "9223372036854775808", "1.0"]) {
    expect(() =>
      new MigrationInventory().add({ ...vector.entries[0]!, revision }),
    ).toThrow(InvalidProtectedData);
  }
});

test("completion signatures bind both inventories, authority versions and tenant", async () => {
  const seal = migrationSeal(vector.seal);
  const key = await importSigningKey(vector.identity.signingKey);
  for (const changed of [
    { ...seal, tenant: "practice:other" },
    { ...seal, migration: "migration:2" },
    { ...seal, schema: "schema:2" },
    { ...seal, generation: "4" },
    { ...seal, policyVersion: "18" },
    { ...seal, catalogVersion: "10" },
    { ...seal, author: "doctor:other" },
    { ...seal, source: { ...seal.source, count: "1" } },
    { ...seal, target: seal.source },
  ]) {
    await expect(
      verify(key, seal.proof, migrationSealFrame(changed)),
    ).rejects.toThrow(InvalidProtectedData);
  }
  expect(() =>
    migrationSeal({ ...seal, source: { ...seal.source, count: 2 } }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    migrationSeal({ ...seal, plaintext: "not part of this protocol" }),
  ).toThrow(InvalidProtectedData);
});
