import { ACTIONS, base64, bytes, createAccountVault, createDomain, createIdentity, createRecoveryPhrase, createTenantSetup, encryptObject, encryptTombstone,
  objectTimestampTarget, OTS_CALENDARS, publicIdentity, serializeOtsProof, signPolicy, sized } from "../src/sortsys";
const identity = await createIdentity(), tenant = "test", subject = "user:interop", scope = "absence:interop";
const areas = [{ scope, facet: "master-data" as const }, { scope, facet: "personnel" as const }];
const { setup, authorityKey } = await createTenantSetup(tenant, subject, identity, createRecoveryPhrase());
const { signature, ...initialPolicy } = setup.policy;
const policy = await signPolicy({ ...initialPolicy, version: "2", rules: [...initialPolicy.rules, ...areas.map(area => ({ ...area, subject, actions: [...ACTIONS], effect: "allow" as const }))] }, authorityKey.privateKey);
const vault = await createAccountVault(base64(crypto.getRandomValues(new Uint8Array(64))), tenant, subject, identity, {});
const domains: Awaited<ReturnType<typeof createDomain>>[] = [];
for (const area of areas) domains.push(await createDomain({ tenant, id: `${area.scope}:${area.facet}`, ...area, generation: "1", policyVersion: "2", authorityGeneration: "1", authorityKey: authorityKey.privateKey,
  recovery: { encryptionKey: setup.authority.recoveryEncryptionKey, signingKey: setup.authority.recoverySigningKey }, readers: [{ subject, identity: await publicIdentity(identity) }] }));
const context = { tenant, scope, facet: "master-data" as const, object: `${scope}:request:3`, revision: "1", generation: "1", policyVersion: "2", author: subject };
const request = await encryptObject(context, bytes('{"private":"Synthetic absence request"}'), domains[0]!.key, identity.signingKey.privateKey);
const decision = { ...context, facet: "personnel" as const, object: `${scope}:decision:3` };
const decisions = await Promise.all(["approved", "denied"].map(status => encryptObject(decision, bytes(JSON.stringify({ private: status, requestSignature: request.signature })), domains[1]!.key, identity.signingKey.privateKey)));
const withdrawal = await encryptTombstone({ ...context, revision: "2" }, domains[0]!.key, identity.signingKey.privateKey);
const changed = await encryptObject({ ...context, revision: "2" }, bytes('{"private":"Unauthorized ordinary revision"}'), domains[0]!.key, identity.signingKey.privateKey);
const target = (await objectTimestampTarget(request, identity.signingKey.publicKey))!, uri = bytes(OTS_CALENDARS[0]);
const pendingProof = (digest: Uint8Array<ArrayBuffer>) => base64(serializeOtsProof({ hash: 8, digest, node: { attestations: [{ tag: new Uint8Array([131,223,227,13,46,249,12,142]), payload: new Uint8Array([uri.length, ...uri]) }], edges: [] } }));
// Tenant owner has every business action before revocation. Immutability must
// hold despite update/delete rights, and admin must not bypass a later denial.
if (setup.policy.rules.some(rule => rule.actions.length !== ACTIONS.length)) throw new Error("Incomplete test permissions");
const revoked = await signPolicy({ tenant, version: "3", rules: [] }, authorityKey.privateKey);
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-native-business.json", import.meta.url), JSON.stringify({
  notice: "Public synthetic browser protocol vector. No private keys, export key or recovery phrase. The opaque-record placeholder in the native business test is fixture setup; real OPAQUE is covered by the replica/recovery scenario.",
  setup, policy, vault, domains: domains.map(domain => domain.definition), request, decisions, withdrawal, changed, target,
  proof: pendingProof(sized(target.digest, 32)), unrelatedProof: pendingProof(new Uint8Array(32)), revoked,
}, null, 2) + "\n");
