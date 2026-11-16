import { expect, test } from "bun:test";
import {
  areaKey,
  bytes,
  createIdentity,
  createZeroTrust,
  InvalidProtectedData,
  openBox,
  publicIdentity,
  sealBox,
  sign,
} from "../src/index";

async function fixture() {
  const framework = createZeroTrust({ facets: ["clinical-note"] });
  const owner = await createIdentity();
  const readers = [await createIdentity(), await createIdentity()];
  const area = {
    tenant: "practice:alpha",
    id: "records:ada:notes",
    scope: "patient:ada",
    facet: "clinical-note" as const,
    generation: "1",
  };
  const made = await framework.domains.createDomain({
    ...area,
    policyVersion: "1",
    authorityGeneration: "1",
    authorityKey: owner.signingKey.privateKey,
    recovery: await publicIdentity(owner),
    readers: [
      { subject: "doctor:owner", identity: await publicIdentity(owner) },
    ],
  });
  const input = {
    area,
    definition: made.definition,
    envelope: made.definition.envelopes[0]!,
    owner: {
      subject: "doctor:owner",
      privateKey: owner.encryptionKey.privateKey,
    },
    authority: { generation: "1", privateKey: owner.signingKey.privateKey },
    history: () => owner.signingKey.publicKey,
    readers: await Promise.all(
      readers.map(async (reader, index) => ({
        subject: `doctor:reader${index}`,
        identity: await publicIdentity(reader),
      })),
    ),
  };
  return { framework, owner, readers, made, input };
}

test("an unrelated application shares authenticated area keys without exposing their plaintext", async () => {
  const f = await fixture();
  const grants = await f.framework.domains.rewrapDomainKey(f.input);
  const context = {
    tenant: f.input.area.tenant,
    scope: f.input.area.scope,
    facet: f.input.area.facet,
    object: "note:7",
    revision: "1",
    generation: "1",
    policyVersion: "1",
    author: "doctor:owner",
  };
  const plaintext = bytes("Confidential clinical record");
  const record = await f.framework.objects.encryptObject(
    context,
    plaintext,
    f.made.key,
    f.owner.signingKey.privateKey,
  );
  expect(grants).toHaveLength(2);
  for (let index = 0; index < grants.length; index++) {
    const raw = await openBox(
      grants[index],
      {
        tenant: f.input.area.tenant,
        purpose: "area-key",
        object: f.input.area.id,
        generation: "1",
        recipient: `doctor:reader${index}`,
        author: "authority:1",
      },
      f.readers[index]!.encryptionKey.privateKey,
      f.owner.signingKey.publicKey,
    );
    try {
      expect(
        await f.framework.objects.decryptObject(
          record,
          context,
          await areaKey(raw),
          f.owner.signingKey.publicKey,
        ),
      ).toEqual(plaintext);
    } finally {
      raw.fill(0);
    }
  }
});

test("sharing rejects a substituted area, unsigned definition, wrong owner and duplicate recipients", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, area: { ...f.input.area, tenant: "another:practice" } },
    { ...f.input, area: { ...f.input.area, generation: "2" } },
    {
      ...f.input,
      definition: { ...f.made.definition, scope: "patient:someone-else" },
    },
    {
      ...f.input,
      owner: {
        ...f.input.owner,
        privateKey: f.readers[0]!.encryptionKey.privateKey,
      },
    },
    { ...f.input, readers: [f.input.readers[0]!, f.input.readers[0]!] },
  ])
    await expect(
      f.framework.domains.rewrapDomainKey(input),
    ).rejects.toBeInstanceOf(InvalidProtectedData);
});

test("cancellation and a closed account after decryption cannot return any grant", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.framework.domains.rewrapDomainKey({
      ...f.input,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  let checkpoints = 0;
  await expect(
    f.framework.domains.rewrapDomainKey({
      ...f.input,
      live: () => {
        if (++checkpoints === 3)
          throw new Error("The owning session was closed");
      },
    }),
  ).rejects.toThrow("The owning session was closed");
  expect(checkpoints).toBe(3);
});

test("a correctly signed envelope containing malformed key material cannot be forwarded", async () => {
  const f = await fixture();
  const bad = await sealBox(
    {
      tenant: f.input.area.tenant,
      purpose: "area-key",
      object: f.input.area.id,
      generation: "1",
      recipient: "doctor:owner",
      author: "authority:1",
    },
    new Uint8Array(17),
    f.owner.encryptionKey.publicKey,
    f.owner.signingKey.privateKey,
  );
  const definition = { ...f.made.definition, envelopes: [bad] };
  definition.proof = await sign(
    f.owner.signingKey.privateKey,
    await f.framework.domains.domainFrame(definition),
  );
  await expect(
    f.framework.domains.rewrapDomainKey({
      ...f.input,
      definition,
      envelope: bad,
    }),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
});
