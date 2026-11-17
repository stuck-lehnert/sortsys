import {
  areaKey,
  bytes,
  certifyIdentity,
  createIdentity,
  createRecoveryPhrase,
  createTenantSetup,
  encryptObject,
  publicIdentity,
  randomSecret,
  signingPair,
} from "../../src/sortsys";

export async function identitySuccessionFixture() {
  const owner = await createIdentity();
  const { setup, authorityKey } = await createTenantSetup(
    "test",
    "account:administrator",
    owner,
    createRecoveryPhrase(),
  );
  const first = await createIdentity();
  const second = { ...first, signingKey: await signingPair() };
  const third = { ...first, signingKey: await signingPair() };
  const initial = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "account:member",
      ...(await publicIdentity(first)),
    },
    authorityKey.privateKey,
  );
  const next = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: initial.user,
      ...(await publicIdentity(second)),
      previousSignature: initial.signature,
    },
    authorityKey.privateKey,
  );
  const latest = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: initial.user,
      ...(await publicIdentity(third)),
      previousSignature: next.signature,
    },
    authorityKey.privateKey,
  );
  const key = await areaKey(randomSecret());
  const context = {
    tenant: "test",
    scope: "tenant:test",
    facet: "master-data" as const,
    object: "record:original",
    generation: "1",
    policyVersion: "1",
    revision: "1",
    author: initial.user,
  };
  const oldObject = await encryptObject(
    context,
    bytes("Original vor dem Schlüsselwechsel"),
    key,
    first.signingKey.privateKey,
  );
  const newObject = await encryptObject(
    { ...context, revision: "2" },
    bytes("Änderung nach dem Schlüsselwechsel"),
    key,
    third.signingKey.privateKey,
  );
  return {
    owner,
    first,
    second,
    third,
    authorityKey,
    setup,
    initial,
    next,
    latest,
    oldObject,
    newObject,
    history: {
      authorities: [{ certificate: setup.authority, transition: null }],
      identities: [latest, setup.owner, initial, next],
    },
    pinned: {
      tenant: "test",
      generation: "1",
      recoverySigningKey: setup.authority.recoverySigningKey,
    },
  };
}
