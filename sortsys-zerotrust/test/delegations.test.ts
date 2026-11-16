import { expect, test } from "bun:test";
import {
  base64,
  certifyIdentity,
  createDelegationCodec,
  createIdentity,
  InvalidProtectedData,
  publicIdentity,
} from "../src/index";

async function fixture() {
  const codec = createDelegationCodec(["patient-file", "appointment"]);
  const authority = await createIdentity();
  const creator = await createIdentity();
  const supervisor = await createIdentity();
  const tenant = "practice:alpha";
  const generation = "1";
  async function certificate(user: string, identity: typeof creator) {
    return certifyIdentity(
      { tenant, generation, user, ...(await publicIdentity(identity)) },
      authority.signingKey.privateKey,
    );
  }
  const unsigned = {
    tenant,
    generation,
    id: "delegation:clinician7",
    namespace: "patient-file" as const,
    creator: await certificate("clinician:7", creator),
    readers: [await certificate("clinician:supervisor", supervisor)],
  };
  const expected = {
    tenant,
    generation,
    namespace: unsigned.namespace,
    creator: unsigned.creator.user,
  };
  return {
    codec,
    authority,
    creator,
    unsigned,
    expected,
    signed: await codec.certify(unsigned, authority.signingKey.privateKey),
  };
}

test("an unrelated application verifies a delegation against its own account and namespace", async () => {
  const f = await fixture();
  const verified = await f.codec.verify(
    f.signed,
    f.expected,
    f.authority.signingKey.publicKey,
  );
  expect(verified).toEqual(f.signed);
  expect(verified).not.toBe(f.signed);
  expect(verified.creator).not.toBe(f.signed.creator);
  expect(verified.readers[0]).not.toBe(f.signed.readers[0]);
  expect(await f.codec.frame(verified)).toEqual(
    await f.codec.frame(f.unsigned),
  );
});

test("a valid certificate cannot cross tenant, generation, namespace or account boundaries", async () => {
  const f = await fixture();
  for (const expected of [
    { ...f.expected, tenant: "practice:beta" },
    { ...f.expected, generation: "2" },
    { ...f.expected, namespace: "appointment" as const },
    { ...f.expected, creator: "clinician:8" },
  ]) {
    await expect(
      f.codec.verify(f.signed, expected, f.authority.signingKey.publicKey),
    ).rejects.toBeInstanceOf(InvalidProtectedData);
  }
  await expect(
    f.codec.verify(f.signed, f.expected, f.creator.signingKey.publicKey),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
});

test("namespace vocabulary and certificate structure reject unbounded or substituted recipients", async () => {
  const f = await fixture();
  for (const changed of [
    { ...f.signed, namespace: "bank-transfer" },
    { ...f.signed, readers: [] },
    {
      ...f.signed,
      readers: Array.from({ length: 9 }, () => f.signed.readers[0]),
    },
    { ...f.signed, readers: [f.signed.readers[0], f.signed.readers[0]] },
    { ...f.signed, creator: { ...f.signed.creator, generation: "2" } },
    {
      ...f.signed,
      readers: [{ ...f.signed.readers[0], tenant: "practice:beta" }],
    },
    {
      ...f.signed,
      readers: [{ ...f.signed.readers[0], privateKey: "forbidden" }],
    },
    { ...f.signed, privateKey: "forbidden" },
  ]) {
    expect(() => f.codec.parse(changed)).toThrow(InvalidProtectedData);
  }
  expect(() => createDelegationCodec([])).toThrow(InvalidProtectedData);
  expect(() => createDelegationCodec(["patient-file", "patient-file"])).toThrow(
    InvalidProtectedData,
  );
  expect(() => createDelegationCodec(["*"])).toThrow(InvalidProtectedData);
});

test("the authority signature binds the ordered recipients and each exact identity certificate", async () => {
  const f = await fixture();
  const both = await f.codec.certify(
    { ...f.unsigned, readers: [f.unsigned.readers[0]!, f.unsigned.creator] },
    f.authority.signingKey.privateKey,
  );
  for (const changed of [
    { ...f.signed, id: "delegation:someone-else" },
    { ...f.signed, signature: base64(new Uint8Array(64)) },
    {
      ...f.signed,
      readers: [{ ...f.signed.readers[0], user: "clinician:intruder" }],
    },
    { ...both, readers: [...both.readers].reverse() },
  ]) {
    await expect(
      f.codec.verify(changed, f.expected, f.authority.signingKey.publicKey),
    ).rejects.toBeInstanceOf(InvalidProtectedData);
  }
  await expect(
    f.codec.verify(
      { ...f.signed, namespace: "appointment" },
      { ...f.expected, namespace: "appointment" },
      f.authority.signingKey.publicKey,
    ),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
  // A valid outer signature cannot replace the individual authority proofs.
  const invalidIdentity = await f.codec.certify(
    {
      ...f.unsigned,
      readers: [
        { ...f.unsigned.readers[0]!, signature: base64(new Uint8Array(64)) },
      ],
    },
    f.authority.signingKey.privateKey,
  );
  await expect(
    f.codec.verify(
      invalidIdentity,
      f.expected,
      f.authority.signingKey.publicKey,
    ),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
});

test("certifying a delegation retains an owned snapshot across asynchronous signing", async () => {
  const f = await fixture();
  const input = structuredClone(f.unsigned);
  const signing = f.codec.certify(input, f.authority.signingKey.privateKey);
  input.id = "delegation:replaced";
  input.creator.user = "clinician:intruder";
  input.readers.length = 0;
  const signed = await signing;
  expect(signed.id).toBe(f.unsigned.id);
  expect(signed.readers).toHaveLength(1);
  await f.codec.verify(signed, f.expected, f.authority.signingKey.publicKey);
});
