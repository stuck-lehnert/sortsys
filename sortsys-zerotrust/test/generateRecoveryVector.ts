// Public synthetic test credentials only; never use these values in production.
import { recoveryFixture } from "./support/recoveryFixture";
import {
  base64, bytes, createAccountVault, createDomain, encryptObject,
  finishOpaqueRegistration, frame, randomSecret, recoveryIdentity,
  opaqueIdentifiers, recoveryPageFrame, recoveryTransitionFrame, sign, startOpaqueRegistration,
} from "../src/sortsys";
import { server } from "@serenity-kit/opaque";

const f = await recoveryFixture();
const oldRecovery = await recoveryIdentity(f.phrase, "test", "1");
const nonce = base64(randomSecret());
const inspectProbe = {
  tenant: "test",
  generation: "1",
  nonce,
  proof: await sign(oldRecovery.signingKey.privateKey,
    frame("sortsys/recovery-inspect/v1", ["test", "1", nonce])),
};
const registration = await startOpaqueRegistration(f.password);
const response = server.createRegistrationResponse({
  serverSetup: f.serverSetup,
  userIdentifier: opaqueIdentifiers("test", f.setup.owner.user).client,
  registrationRequest: registration.registrationRequest,
});
const initialAccount = await finishOpaqueRegistration(
  f.password, "test", f.setup.owner.user, registration, response.registrationResponse,
);
const vault = await createAccountVault(
  initialAccount.exportKey, "test", f.setup.owner.user, f.owner,
  { recoveryGeneration: "1", recoverySigningKey: f.setup.authority.recoverySigningKey },
);
const envelope = await encryptObject({
  tenant: "test", scope: "tenant:test", facet: "calculation", object: "position:fixture",
  revision: "1", generation: "1", policyVersion: "1", author: "user:interop",
}, bytes("123.45"), f.key, f.owner.signingKey.privateKey);
const stalePlan = structuredClone(f.plan);
stalePlan.transition.operation = `zt_${base64(randomSecret())}`;
stalePlan.proof = await sign(oldRecovery.signingKey.privateKey, recoveryTransitionFrame(stalePlan.transition));
stalePlan.nextProof = await sign(
  (await recoveryIdentity(f.newPhrase, "test", "2")).signingKey.privateKey,
  recoveryTransitionFrame(stalePlan.transition),
);

// Valid but unpublished future generations must not truncate a paged catalogue
// or be mistaken for keys that have already encrypted business contents.
const futureDefinitions = [];
for (let generation = 2; generation <= 66; generation++) {
  const { definition } = await createDomain({
    tenant: "test", id: f.definition.id, scope: f.definition.scope, facet: f.definition.facet,
    generation: String(generation), policyVersion: "1", authorityGeneration: "1",
    authorityKey: f.authorityKey.privateKey,
    recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey },
    readers: [{ subject: f.setup.owner.user, identity: f.setup.owner }],
  });
  futureDefinitions.push(definition);
}
const snapshot = `1.${f.source.catalogVersion}.${f.source.policyVersion}`;
const cursors = [
  null,
  base64(bytes(JSON.stringify({ section: "keysStart" }))),
  base64(bytes(JSON.stringify({ section: "keys", domain: f.definition.id, generation: "64" }))),
];
const pageRequests = [];
for (const after of cursors) {
  const access = {
    tenant: "test", generation: "1", challengeId: f.source.challengeId,
    challenge: f.source.challenge, snapshot, after,
  };
  pageRequests.push({
    tenant: access.tenant, generation: access.generation, challengeId: access.challengeId,
    snapshot, after, proof: await sign(oldRecovery.signingKey.privateKey, recoveryPageFrame(access)),
  });
}
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-recovery.json", import.meta.url),
  JSON.stringify({
    notice: "Public synthetic browser protocol vector. No production data, phrases or private tenant keys.",
    plan: f.plan, source: f.source, inspectProbe, initialSetup: f.setup,
    initialDomain: f.definition, initialVault: vault, initialObject: envelope,
    initialRegistrationRequest: registration.registrationRequest,
    initialRegistrationResponse: response.registrationResponse,
    initialRegistrationRecord: initialAccount.registrationRecord,
    opaqueServerSetup: f.serverSetup, password: f.password, stalePlan,
    futureDefinitions, pageRequests,
  }, null, 2) + "\n");
