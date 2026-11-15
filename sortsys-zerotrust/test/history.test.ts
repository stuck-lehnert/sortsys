import { expect, test } from "bun:test";
import {
  areaKey,
  attestMigrationOrigin,
  bytes,
  createIdentity,
  encryptObject,
  historyInstant,
  verifyMigrationOrigin,
} from "../src/sortsys";

test("a legacy origin binds the exact signed first revision to the pinned tenant authority", async () => {
  const author = await createIdentity();
  const authority = await createIdentity();
  const key = await areaKey();
  const envelope = await encryptObject(
    {
      tenant: "test",
      scope: "personnel:2",
      facet: "master-data",
      object: "personnel:2:master-data:record",
      revision: "1",
      generation: "1",
      policyVersion: "1",
      author: "user:1",
    },
    bytes("private"),
    key,
    author.signingKey.privateKey,
  );
  const proof = await attestMigrationOrigin(
    envelope,
    "1",
    authority.signingKey.privateKey,
  );
  const trusted = (generation: string) => {
    expect(generation).toBe("1");
    return authority.signingKey.publicKey;
  };
  expect(await verifyMigrationOrigin(envelope, proof, trusted)).toEqual(proof);
  for (const change of [
    { object: "personnel:3:master-data:record" },
    { scope: "personnel:3" },
    { revision: "2" },
    { tenant: "other" },
    { signature: proof.signature },
  ])
    await expect(
      verifyMigrationOrigin({ ...envelope, ...change }, proof, trusted),
    ).rejects.toThrow();
  await expect(
    verifyMigrationOrigin(envelope, { ...proof, optional: null }, trusted),
  ).rejects.toThrow();
  await expect(
    verifyMigrationOrigin(envelope, proof, () => author.signingKey.publicKey),
  ).rejects.toThrow();
  await expect(
    attestMigrationOrigin(
      { ...envelope, revision: "2" },
      "1",
      authority.signingKey.privateKey,
    ),
  ).rejects.toThrow();
});

test("legacy chronology is authority-bound to the exact encrypted event and cannot be stripped or backdated", async () => {
  const author = await createIdentity();
  const authority = await createIdentity();
  const key = await areaKey();
  const envelope = await encryptObject(
    {
      tenant: "test",
      scope: "personnel:2",
      facet: "calculation",
      object: "legacy-activity:personnel:2:calculation:5:event",
      revision: "1",
      generation: "1",
      policyVersion: "1",
      author: "user:1",
    },
    bytes("original event"),
    key,
    author.signingKey.privateKey,
  );
  const history = { source: "5", occurredMicros: "1794484800000123" };
  const proof = await attestMigrationOrigin(
    envelope,
    "1",
    authority.signingKey.privateKey,
    history,
  );
  const trusted = () => authority.signingKey.publicKey;
  expect(await verifyMigrationOrigin(envelope, proof, trusted)).toEqual(proof);
  const { history: omitted, ...stripped } = proof;
  for (const changed of [
    stripped,
    { ...proof, history: null },
    { ...proof, history: { ...history, source: "6" } },
    { ...proof, history: { ...history, occurredMicros: "1794484800000124" } },
  ])
    await expect(
      verifyMigrationOrigin(envelope, changed, trusted),
    ).rejects.toThrow();
  await expect(
    attestMigrationOrigin(
      { ...envelope, object: "ordinary:5" },
      "1",
      authority.signingKey.privateKey,
      history,
    ),
  ).rejects.toThrow();
  for (const value of [
    "-0",
    "01",
    "1.0",
    "253402300800000000",
    "-62135596800000001",
    1,
    null,
  ])
    expect(() => historyInstant(value)).toThrow();
  for (const value of ["0", "-62135596800000000", "253402300799999999"])
    expect(() => historyInstant(value)).not.toThrow();
});
