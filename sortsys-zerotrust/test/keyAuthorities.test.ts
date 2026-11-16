import { expect, test } from "bun:test";
import {
  areaKey,
  bytes,
  certifyIdentity,
  createIdentity,
  createZeroTrust,
  openBox,
  publicIdentity,
  type KeyAuthority,
} from "../src/index";

async function fixture() {
  const security = createZeroTrust({ facets: ["notes", "prices"] });
  const root = await createIdentity();
  const manager = await createIdentity();
  const reader = await createIdentity();
  const recovery = await createIdentity();
  const holder = await certifyIdentity(
    {
      tenant: "laboratory:alpha",
      generation: "1",
      user: "researcher:lee",
      ...(await publicIdentity(manager)),
    },
    root.signingKey.privateKey,
  );
  const certificate = await security.keyAuthorities.certify(
    {
      tenant: holder.tenant,
      generation: holder.generation,
      scope: "experiment:1",
      facet: "notes",
      holder,
    },
    root.signingKey.privateKey,
  );
  const area = {
    tenant: holder.tenant,
    id: "experiment:1:notes",
    scope: certificate.scope,
    facet: certificate.facet,
    generation: "1",
  };
  const history = (generation: string) => {
    if (generation !== "1") throw new Error("Unknown authority generation");
    return root.signingKey.publicKey;
  };
  return {
    security,
    root,
    manager,
    reader,
    recovery,
    holder,
    certificate,
    area,
    history,
  };
}

test("a scoped key authority binds the certified holder and every public field", async () => {
  const f = await fixture();
  const expected = { ...f.area, generation: "1", holder: f.holder.user };
  expect(
    (
      await f.security.keyAuthorities.verify(
        f.certificate,
        expected,
        f.root.signingKey.publicKey,
      )
    ).signature,
  ).toBe(f.certificate.signature);
  for (const patch of [
    { tenant: "laboratory:other" },
    { generation: "2" },
    { scope: "experiment:2" },
    { facet: "prices" },
    { holder: { ...f.holder, user: "researcher:ada" } },
    { extra: "unsupported" },
    { signature: f.holder.signature },
  ]) {
    await expect(
      f.security.keyAuthorities.verify(
        { ...f.certificate, ...patch },
        expected,
        f.root.signingKey.publicKey,
      ),
    ).rejects.toThrow();
  }
  await expect(
    f.security.keyAuthorities.verify(
      f.certificate,
      { ...expected, holder: "researcher:ada" },
      f.root.signingKey.publicKey,
    ),
  ).rejects.toThrow();
  await expect(
    f.security.keyAuthorities.verify(
      f.certificate,
      expected,
      f.reader.signingKey.publicKey,
    ),
  ).rejects.toThrow();
});

test("a manager creates a recoverable key generation using only its own private key", async () => {
  const f = await fixture();
  const made = await f.security.domains.createManagedDomain({
    ...f.area,
    policyVersion: "2",
    keyAuthority: f.certificate,
    signingKey: f.manager.signingKey.privateKey,
    recovery: await publicIdentity(f.recovery),
    readers: [
      { subject: f.holder.user, identity: await publicIdentity(f.manager) },
    ],
  });
  const verified = await f.security.domains.verifyDomain(
    made.definition,
    f.area,
    f.history,
  );
  const envelope = verified.envelopes[0]!;
  const raw = await openBox(
    envelope,
    {
      tenant: f.area.tenant,
      purpose: "area-key",
      object: f.area.id,
      generation: "1",
      recipient: f.holder.user,
      author: f.security.keyAuthorities.author(f.certificate),
    },
    f.manager.encryptionKey.privateKey,
    await f.security.domains.domainBoxSigner(verified, envelope, f.history),
  );
  const recovered = await openBox(
    verified.recoveryEnvelope,
    {
      tenant: f.area.tenant,
      purpose: "area-key",
      object: f.area.id,
      generation: "1",
      recipient: "recovery:1",
      author: envelope.author,
    },
    f.recovery.encryptionKey.privateKey,
    await f.security.domains.domainBoxSigner(
      verified,
      verified.recoveryEnvelope,
      f.history,
    ),
  );
  try {
    expect(raw).toEqual(recovered);
    const key = await areaKey(raw);
    const context = {
      tenant: f.area.tenant,
      scope: f.area.scope,
      facet: f.area.facet,
      generation: f.area.generation,
      object: "note:1",
      revision: "1",
      policyVersion: "2",
      author: f.holder.user,
    };
    const encrypted = await f.security.objects.encryptObject(
      context,
      bytes("Vertraulicher Inhalt"),
      made.key,
      f.manager.signingKey.privateKey,
    );
    expect(
      await f.security.objects.decryptObject(
        encrypted,
        context,
        key,
        f.manager.signingKey.publicKey,
      ),
    ).toEqual(bytes("Vertraulicher Inhalt"));
  } finally {
    raw.fill(0);
    recovered.fill(0);
  }
  const altered = structuredClone(made.definition);
  delete altered.keyAuthority;
  await expect(
    f.security.domains.verifyDomain(altered, f.area, f.history),
  ).rejects.toThrow();
});

test("historical grants signed by another manager require that manager's area-bound certificate", async () => {
  const f = await fixture();
  const original = await f.security.domains.createDomain({
    ...f.area,
    policyVersion: "1",
    authorityGeneration: "1",
    authorityKey: f.root.signingKey.privateKey,
    recovery: await publicIdentity(f.recovery),
    readers: [
      { subject: f.holder.user, identity: await publicIdentity(f.manager) },
    ],
  });
  const grants = await f.security.domains.rewrapDomainKey({
    definition: original.definition,
    area: f.area,
    envelope: original.definition.envelopes[0],
    owner: {
      subject: f.holder.user,
      privateKey: f.manager.encryptionKey.privateKey,
    },
    authority: {
      generation: "1",
      privateKey: f.manager.signingKey.privateKey,
      keyAuthority: f.certificate,
    },
    history: f.history,
    readers: [
      { subject: "researcher:ada", identity: await publicIdentity(f.reader) },
    ],
  });
  const grant = grants[0]!;
  await expect(
    f.security.domains.domainBoxSigner(original.definition, grant, f.history),
  ).rejects.toThrow();
  const signer = await f.security.domains.domainBoxSigner(
    original.definition,
    grant,
    f.history,
    f.certificate,
  );
  const plain = await openBox(
    grant,
    {
      tenant: f.area.tenant,
      purpose: "area-key",
      object: f.area.id,
      generation: "1",
      recipient: "researcher:ada",
      author: grant.author,
    },
    f.reader.encryptionKey.privateKey,
    signer,
  );
  expect(plain).toHaveLength(32);
  plain.fill(0);
  const wrong: KeyAuthority<"notes" | "prices"> =
    await f.security.keyAuthorities.certify(
      {
        tenant: f.area.tenant,
        generation: "1",
        scope: "experiment:2",
        facet: "notes",
        holder: f.holder,
      },
      f.root.signingKey.privateKey,
    );
  await expect(
    f.security.domains.domainBoxSigner(
      original.definition,
      grant,
      f.history,
      wrong,
    ),
  ).rejects.toThrow();
  await expect(
    f.security.domains.rewrapDomainKey({
      definition: original.definition,
      area: f.area,
      envelope: original.definition.envelopes[0],
      owner: {
        subject: "researcher:ada",
        privateKey: f.manager.encryptionKey.privateKey,
      },
      authority: {
        generation: "1",
        privateKey: f.manager.signingKey.privateKey,
        keyAuthority: f.certificate,
      },
      history: f.history,
      readers: [],
    }),
  ).rejects.toThrow();
});
