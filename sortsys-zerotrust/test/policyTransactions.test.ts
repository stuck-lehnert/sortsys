import { expect, test } from "bun:test";
import { policyPacketCommitment } from "../src/policyTransactions";
import {
  base64,
  compilePolicy,
  createIdentity,
  createRecoveryPhrase,
  createTenantSetup,
  policy,
  policyTransaction,
  sign,
  signPolicy,
  signPolicyTransaction,
  signingPair,
  tenantSetupFrame,
  verifyPolicy,
  verifyTenantSetup,
} from "../src/sortsys";
const signature = (fill: number) => base64(new Uint8Array(64).fill(fill));
const permissions = {
  tenant: "test",
  version: "2",
  rules: [
    {
      subject: "user:1",
      scope: "absence:2",
      facet: "personnel" as const,
      effect: "allow" as const,
      actions: ["read" as const, "approve" as const],
      origin: "absence-default" as const,
    },
  ],
};
const binding = {
  author: "user:1",
  previousSignature: signature(1),
  packets: [signature(2)],
  heads: [{ domain: "personnel:2:scope", sequence: "1" }],
};
test("automatic grants retain their origin in the authority signature and explicit denials veto them", async () => {
  const keys = await signingPair(),
    signed = await signPolicy(permissions, keys.privateKey),
    expected = { tenant: "test", authority: keys.publicKey };
  expect((await verifyPolicy(signed, expected)).permissions).toEqual(
    permissions,
  );
  const rules = signed.rules.map(({ origin, ...rule }) => rule);
  await expect(verifyPolicy({ ...signed, rules }, expected)).rejects.toThrow();
  expect(
    compilePolicy(
      {
        ...permissions,
        rules: [
          ...permissions.rules,
          {
            subject: "user:1",
            scope: "absence:2",
            facet: "personnel",
            effect: "deny",
            actions: ["approve"],
          },
        ],
      },
      ["user:1"],
    ).allows("absence:2", "personnel", "approve"),
  ).toBe(false);
  for (const change of [
    { origin: "other" },
    { origin: null },
    { effect: "deny" },
    { scope: "project:2" },
    { subject: "user:01" },
    { actions: ["delete"] },
    { facet: "scope" },
  ])
    expect(() =>
      policy({
        ...permissions,
        rules: [{ ...permissions.rules[0], ...change }],
      }),
    ).toThrow();
});
test("a policy transaction binds packets, read prerequisites, previous policy and author", async () => {
  const keys = await signingPair(),
    signed = await signPolicyTransaction(permissions, binding, keys.privateKey),
    expected = { tenant: "test", authority: keys.publicKey };
  const checked = await verifyPolicy(signed, expected);
  expect(checked.permissions).toEqual(permissions);
  expect(checked.transaction).toEqual(binding);
  expect(Object.hasOwn(checked.permissions, "transaction")).toBe(false);
  const { transaction, ...stripped } = signed;
  await expect(verifyPolicy(stripped, expected)).rejects.toThrow();
  for (const change of [
    { author: "user:2" },
    { previousSignature: signature(3) },
    { packets: [] },
    { heads: [{ domain: "personnel:2:scope", sequence: "2" }] },
  ])
    await expect(
      verifyPolicy(
        { ...signed, transaction: { ...binding, ...change } },
        expected,
      ),
    ).rejects.toThrow();
  const plain = await signPolicy(permissions, keys.privateKey);
  await expect(
    verifyPolicy({ ...plain, transaction: binding }, expected),
  ).rejects.toThrow();
});
test("transaction prerequisites have one unambiguous order and bounded canonical representations", () => {
  expect(policyTransaction({ ...binding, packets: [] })).toMatchObject({
    packets: [],
  });
  for (const change of [
    { heads: [] },
    { heads: [...binding.heads, ...binding.heads] },
    { packets: [signature(2), signature(2)] },
    { packets: Array(65).fill(signature(2)) },
    {
      heads: [
        { domain: "z", sequence: "0" },
        { domain: "a", sequence: "0" },
      ],
    },
    { heads: [{ domain: "a", sequence: "01" }] },
    { previousSignature: "invalid" },
    { extra: true },
  ])
    expect(() => policyTransaction({ ...binding, ...change })).toThrow();
});
test("a setup envelope retains and verifies a transaction-bound policy rather than stripping its manifest", async () => {
  const identity = await createIdentity(),
    created = await createTenantSetup(
      "test",
      "user:1",
      identity,
      createRecoveryPhrase(),
    );
  const next = {
    ...created.setup,
    policy: await signPolicyTransaction(
      permissions,
      binding,
      created.authorityKey.privateKey,
    ),
  };
  next.proof = await sign(
    identity.signingKey.privateKey,
    await tenantSetupFrame(next),
  );
  const checked = await verifyTenantSetup(next, {
    tenant: "test",
    generation: "1",
    recoverySigningKey: next.authority.recoverySigningKey,
  });
  expect(checked.policy.transaction).toEqual(binding);
  expect(checked.policy.signature).toBe(next.policy.signature);
});

test("large permission publications bind every packet through a compact signed commitment", async () => {
  const keys = await signingPair();
  const packets = Array.from({ length: 70 }, (_, index) =>
    signature(index),
  ).sort();
  const signed = await signPolicyTransaction(
    permissions,
    { ...binding, packets },
    keys.privateKey,
  );
  const expected = { tenant: "test", authority: keys.publicKey };
  const checked = await verifyPolicy(signed, expected);
  const transaction = checked.transaction;
  if (!transaction) throw new Error("Expected a signed transaction manifest");
  expect(transaction.packets).toEqual([]);
  expect(transaction.packetCommitment).toEqual(
    policyPacketCommitment(packets),
  );
  expect(JSON.stringify(transaction).length).toBeLessThan(600);
  for (const commitment of [
    { ...transaction.packetCommitment, count: 69 },
    {
      ...transaction.packetCommitment,
      digest: base64(new Uint8Array(32)),
    },
  ]) {
    await expect(
      verifyPolicy(
        {
          ...signed,
          transaction: { ...transaction, packetCommitment: commitment },
        },
        expected,
      ),
    ).rejects.toThrow();
  }
  expect(() =>
    policyTransaction({ ...transaction, packets: [signature(3)] }),
  ).toThrow();
  expect(() => policyPacketCommitment([...packets].reverse())).toThrow();
});
