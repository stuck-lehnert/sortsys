import { expect, test } from "bun:test";
import { signPolicy, signingPair } from "@sortsys/zerotrust/sortsys";
import { publishVerifiedPolicy, readVerifiedPolicy } from "./policy";

async function fixture() {
  const keys = await signingPair(),
    permissions = { tenant: "test", version: "4", rules: [] },
    signed = await signPolicy(permissions, keys.privateKey);
  const calls = [];
  let active = true,
    authorityReads = 0;
  const context = {
    account: { tenant: "test" },
    authority: keys.privateKey,
    history: {
      current: { generation: "2" },
      authority(generation) {
        expect(generation).toBe("2");
        authorityReads++;
        return keys.publicKey;
      },
    },
    live() {
      if (!active) throw new Error("Access context replaced");
    },
  };
  const client = {
    async query(path, input, options) {
      calls.push({ path, input, options });
      return [signed, null];
    },
  };
  return {
    client,
    context,
    signed,
    permissions,
    calls,
    revoke() {
      active = false;
    },
    authorityReads: () => authorityReads,
  };
}

test("policy readers use the pinned generation and network-only verification", async () => {
  const f = await fixture();
  expect(await readVerifiedPolicy(f.client, f.context)).toEqual({
    permissions: f.permissions,
    signature: f.signed.signature,
  });
  expect(f.calls).toEqual([
    {
      path: "zerotrust.policy.get",
      input: undefined,
      options: { strategy: "network-only" },
    },
  ]);
  f.context.account.tenant = "other";
  await expect(readVerifiedPolicy(f.client, f.context)).rejects.toThrow();
});

test("a late policy response cannot pass into a replaced access context", async () => {
  const f = await fixture();
  let finish;
  f.client.query = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const loading = readVerifiedPolicy(f.client, f.context);
  f.revoke();
  finish([f.signed, null]);
  await expect(loading).rejects.toThrow("Access context replaced");
  expect(f.authorityReads()).toBe(0);
});

test("a context replaced during signature verification cannot return permissions", async () => {
  const f = await fixture(),
    authority = f.context.history.authority;
  f.context.history.authority = (generation) => {
    const key = authority(generation);
    f.revoke();
    return key;
  };
  await expect(readVerifiedPolicy(f.client, f.context)).rejects.toThrow(
    "Access context replaced",
  );
});

test("transport errors and malformed policy replies fail without a grant", async () => {
  const f = await fixture(),
    failure = new Error("No permission response");
  f.client.query = async () => [null, failure];
  await expect(readVerifiedPolicy(f.client, f.context)).rejects.toBe(failure);
  f.client.query = async () => [null, null];
  await expect(readVerifiedPolicy(f.client, f.context)).rejects.toThrow();
});

for (const mode of ["success", "lost reply", "thrown reply"])
  test(`a published policy is confirmed by its exact signature after ${mode}`, async () => {
    const f = await fixture(),
      next = { ...f.permissions, version: "5" };
    let saved;
    f.client.mutate = async (path, packet) => {
      expect(path).toBe("zerotrust.policy.replace");
      saved = packet;
      if (mode === "thrown reply") throw new Error("Reply lost after commit");
      return mode === "lost reply"
        ? [null, new Error("Reply lost after commit")]
        : [{ success: true }, null];
    };
    f.client.query = async () => [saved, null];
    expect(await publishVerifiedPolicy(f.client, f.context, next)).toEqual({
      permissions: next,
      signature: saved.signature,
    });
  });

test("a false successful acknowledgement cannot confirm an unapplied revocation", async () => {
  const f = await fixture();
  let reads = 0;
  f.client.mutate = async () => [{ success: true }, null];
  f.client.query = async () => {
    reads++;
    return [f.signed, null];
  };
  await expect(
    publishVerifiedPolicy(f.client, f.context, {
      ...f.permissions,
      version: "5",
    }),
  ).rejects.toThrow();
  expect(reads).toBe(1);
});

test("a concurrent signed replacement cannot acknowledge our own policy change", async () => {
  const f = await fixture();
  const concurrent = await signPolicy(
    { ...f.permissions, version: "6" },
    f.context.authority,
  );
  f.client.mutate = async () => [{ success: true }, null];
  f.client.query = async () => [concurrent, null];
  await expect(
    publishVerifiedPolicy(f.client, f.context, {
      ...f.permissions,
      version: "5",
    }),
  ).rejects.toThrow();
});

test("an unapplied policy preserves the original publication failure", async () => {
  const f = await fixture(),
    failure = new Error("Policy revision conflict");
  f.client.mutate = async () => [null, failure];
  await expect(
    publishVerifiedPolicy(f.client, f.context, {
      ...f.permissions,
      version: "5",
    }),
  ).rejects.toBe(failure);
});

test("an authority that does not match the pinned public key cannot publish a policy", async () => {
  const f = await fixture();
  let publications = 0;
  f.client.mutate = async () => {
    publications++;
    return [{ success: true }, null];
  };
  await expect(
    publishVerifiedPolicy(
      f.client,
      { ...f.context, authority: (await signingPair()).privateKey },
      { ...f.permissions, version: "5" },
    ),
  ).rejects.toThrow();
  expect(publications).toBe(0);
});

test("a policy publication cannot finish in a replaced account context", async () => {
  const f = await fixture();
  f.client.mutate = async () => {
    f.revoke();
    return [{ success: true }, null];
  };
  await expect(
    publishVerifiedPolicy(f.client, f.context, {
      ...f.permissions,
      version: "5",
    }),
  ).rejects.toThrow("Access context replaced");
  expect(f.calls).toHaveLength(0);
});
