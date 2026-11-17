import { expect, test } from "bun:test";
import {
  base64,
  bytes,
  createIdentity,
  digest,
  passkeyDeletionFrame,
  passkeyRegistrationFrame,
  passkeyTenantFingerprint,
  registrationCredentialFrame,
  routingUserHandle,
  sign,
  unbase64,
  verify,
} from "../src/index";

async function fixture() {
  const credential = {
    id: base64(new Uint8Array([1, 2, 3])),
    rawId: base64(new Uint8Array([1, 2, 3])),
    type: "public-key" as const,
    response: {
      clientDataJSON: base64(bytes("public client data")),
      attestationObject: base64(new Uint8Array([0xa0])),
    },
    transports: ["internal"],
  };
  const binding = {
    tenant: "laboratory:alpha",
    subject: "researcher:kai",
    userHandle: await routingUserHandle(
      "laboratory:alpha",
      new Uint8Array([42]),
    ),
    exchangeHash: await digest(bytes("challenge token")),
    credentialHash: await digest(registrationCredentialFrame(credential)),
    keyVaultHash: "",
    label: "Arbeitsgerät",
  };
  return { credential, binding };
}

test("account authorization binds every enrollment field and the deletion target", async () => {
  const { binding } = await fixture();
  const identity = await createIdentity();
  const signature = await sign(
    identity.signingKey.privateKey,
    passkeyRegistrationFrame(binding),
  );
  await verify(
    identity.signingKey.publicKey,
    signature,
    passkeyRegistrationFrame(binding),
  );
  for (const change of [
    { tenant: "laboratory:beta" },
    { subject: "researcher:lee" },
    {
      userHandle: await routingUserHandle(binding.tenant, new Uint8Array([43])),
    },
    { exchangeHash: await digest(bytes("another token")) },
    { credentialHash: await digest(bytes("another credential")) },
    { keyVaultHash: await digest(bytes("another wrapper")) },
    { label: "Anderes Gerät" },
  ]) {
    await expect(
      verify(
        identity.signingKey.publicKey,
        signature,
        passkeyRegistrationFrame({ ...binding, ...change }),
      ),
    ).rejects.toThrow();
  }
  const principal = { tenant: binding.tenant, subject: binding.subject };
  const deletion = await sign(
    identity.signingKey.privateKey,
    passkeyDeletionFrame(principal, "device:1"),
  );
  await expect(
    verify(
      identity.signingKey.publicKey,
      deletion,
      passkeyDeletionFrame(principal, "device:2"),
    ),
  ).rejects.toThrow();
});

test("enrollment commitments reject ambiguous packets and noncanonical labels", async () => {
  const { credential, binding } = await fixture();
  expect(
    registrationCredentialFrame({ ...credential, transports: null }),
  ).toEqual(registrationCredentialFrame({ ...credential, transports: [] }));
  for (const change of [
    { rawId: base64(new Uint8Array([4])) },
    { id: "" },
    { transports: ["internal", "internal"] },
    { transports: ["USB"] },
    { extra: "field" },
  ]) {
    expect(() =>
      registrationCredentialFrame({ ...credential, ...change }),
    ).toThrow();
  }
  for (const change of [
    { label: "" },
    { label: " Leading" },
    { label: "Trailing " },
    { label: "Control\ncharacter" },
    { label: "ä".repeat(64) },
    { exchangeHash: "" },
    { userHandle: "" },
    { extra: "field" },
  ]) {
    expect(() => passkeyRegistrationFrame({ ...binding, ...change })).toThrow();
  }
});

test("routing handles fit long tenant names and snapshot mutable caller buffers", async () => {
  const tenant = "t".repeat(63);
  const payload = new Uint8Array(31).fill(9);
  const pending = routingUserHandle(tenant, payload);
  payload.fill(0);
  const handle = unbase64(await pending, 64);
  expect(handle.length).toBe(64);
  expect(handle[0]).toBe(1);
  expect(base64(handle.slice(1, 33))).toBe(
    await passkeyTenantFingerprint(tenant),
  );
  expect(handle.slice(33)).toEqual(new Uint8Array(31).fill(9));
  expect(await routingUserHandle("other", new Uint8Array([9]))).not.toBe(
    await routingUserHandle(tenant, new Uint8Array([9])),
  );
  await expect(routingUserHandle(tenant, new Uint8Array())).rejects.toThrow();
  await expect(routingUserHandle(tenant, new Uint8Array(32))).rejects.toThrow();
});
