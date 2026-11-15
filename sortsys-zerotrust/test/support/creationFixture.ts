import { certifyCreationCapability, certifyIdentity, createDelegatedDomain, createIdentity, createOrigin, createRecoveryPhrase, createTenantSetup, publicIdentity } from "../../src/sortsys";
import type { CreationNamespace } from "../../src/sortsys";

export async function creationFixture(namespace: CreationNamespace = "project") {
  const owner = await createIdentity(), creator = await createIdentity();
  const { setup, authorityKey } = await createTenantSetup("test", "user:1", owner, createRecoveryPhrase());
  const member = await certifyIdentity({ tenant: "test", generation: "1", user: "user:2", ...await publicIdentity(creator) }, authorityKey.privateKey);
  const capability = await certifyCreationCapability({ tenant: "test", generation: "1", id: "create_test", namespace, creator: member, readers: [setup.owner] }, authorityKey.privateKey);
  const origin = await createOrigin({ tenant: "test", id: `${namespace}:abc:master-data`, scope: `${namespace}:abc`, facet: "master-data", capability }, creator.signingKey.privateKey);
  const made = await createDelegatedDomain({ origin, creatorKey: creator.signingKey.privateKey, policyVersion: "1",
    recovery: { encryptionKey: setup.authority.recoveryEncryptionKey, signingKey: setup.authority.recoverySigningKey } });
  return { owner, creator, setup, authorityKey, origin, ...made };
}
