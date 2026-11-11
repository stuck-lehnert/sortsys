// Run manually with Bun after an intentional protocol change. All credentials
// below are public synthetic test values, never examples for live accounts.
import { recoveryFixture } from "./support/recoveryFixture";
import { base64, bytes, createAccountVault, encryptObject, finishOpaqueRegistration, frame, randomSecret, recoveryIdentity, recoveryTransitionFrame, sign, startOpaqueRegistration } from "../src";
import { server } from "@serenity-kit/opaque";

const f = await recoveryFixture();
const nonce=base64(randomSecret());
const inspectProbe={tenant:"test",generation:"1",nonce,proof:await sign((await recoveryIdentity(f.phrase,"test","1")).signingKey.privateKey,frame("sortsys/recovery-inspect/v1",["test","1",nonce]))};
const registration = await startOpaqueRegistration(f.password);
const response = server.createRegistrationResponse({ serverSetup: f.serverSetup, userIdentifier: "test/scenario.admin", registrationRequest: registration.registrationRequest });
const initialAccount = await finishOpaqueRegistration(f.password, "test", "scenario.admin", registration, response.registrationResponse);
const vault = await createAccountVault(initialAccount.exportKey, "test", "scenario.admin", f.owner, { recoveryGeneration: "1", recoverySigningKey: f.setup.authority.recoverySigningKey });
const envelope = await encryptObject({ tenant: "test", scope: "tenant:test", facet: "calculation", object: "position:fixture", revision: "1", generation: "1", policyVersion: "1", author: "user:interop" }, bytes("123.45"), f.key, f.owner.signingKey.privateKey);
const stalePlan = structuredClone(f.plan);
stalePlan.transition.operation = `zt_${base64(randomSecret())}`;
stalePlan.proof = await sign((await recoveryIdentity(f.phrase, "test", "1")).signingKey.privateKey, recoveryTransitionFrame(stalePlan.transition));
stalePlan.nextProof = await sign((await recoveryIdentity(f.newPhrase, "test", "2")).signingKey.privateKey, recoveryTransitionFrame(stalePlan.transition));
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-recovery.json", import.meta.url), JSON.stringify({ notice: "Public synthetic browser protocol vector. No production data, phrases or private tenant keys.", plan: f.plan, source: f.source, inspectProbe, initialSetup: f.setup, initialDomain: f.definition, initialVault: vault, initialObject: envelope, initialRegistrationRequest: registration.registrationRequest, initialRegistrationResponse: response.registrationResponse, initialRegistrationRecord: initialAccount.registrationRecord, opaqueServerSetup: f.serverSetup, password: f.password, stalePlan }, null, 2) + "\n");
