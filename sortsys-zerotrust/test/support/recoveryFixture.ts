import { server } from "@serenity-kit/opaque";
import {
  base64,
  createDomain,
  createIdentity,
  createRecoveryPhrase,
  createTenantSetup,
  opaqueReady,
  opaqueIdentifiers,
  prepareRecovery,
  randomSecret,
} from "../../src/sortsys";
import type { RecoverySource } from "../../src/sortsys";

export async function recoveryFixture(options: { context?: string } = {}) {
  await opaqueReady;
  const phrase = createRecoveryPhrase();
  const owner = await createIdentity();
  const { setup, authorityKey } = await createTenantSetup(
    "test",
    "user:interop",
    owner,
    phrase,
    options,
  );
  const { definition, key } = await createDomain({
    tenant: "test",
    id: "domain:calculation",
    scope: "tenant:test",
    facet: "calculation",
    generation: "1",
    policyVersion: "1",
    authorityGeneration: "1",
    authorityKey: authorityKey.privateKey,
    recovery: {
      encryptionKey: setup.authority.recoveryEncryptionKey,
      signingKey: setup.authority.recoverySigningKey,
    },
    readers: [{ subject: setup.owner.user, identity: setup.owner }],
  });
  const source: RecoverySource = {
    challengeId: `zt_${base64(randomSecret())}`,
    challenge: base64(randomSecret()),
    authority: setup.authority,
    catalog: setup.catalog,
    catalogVersion: "2",
    policyVersion: "1",
    domains: [
      {
        id: definition.id,
        scope: definition.scope,
        facet: definition.facet,
        generation: "1",
      },
    ],
    domainProofs: [definition],
    keys: [definition.recoveryEnvelope],
  };
  const serverSetup = server.createSetup();
  const newPhrase = createRecoveryPhrase();
  const password = "public-synthetic-test-password";
  const register = async (input: {
    tenant: string;
    subject: string;
    registrationRequest: string;
  }) =>
    server.createRegistrationResponse({
      serverSetup,
      userIdentifier: opaqueIdentifiers(input.tenant, input.subject).client,
      registrationRequest: input.registrationRequest,
    });
  const { plan, identity } = await prepareRecovery({
    oldPhrase: phrase,
    newPhrase,
    password,
    source,
    register,
  });
  return {
    phrase,
    newPhrase,
    password,
    source,
    plan,
    identity,
    key,
    owner,
    serverSetup,
    register,
    setup,
    definition,
    authorityKey,
  };
}
