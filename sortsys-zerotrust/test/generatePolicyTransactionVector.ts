import { areaKey, base64, bytes, createIdentity, encryptObject, publicSigningKey, signPolicy, signPolicyTransaction, type Policy } from "../src/sortsys";
const identity = await createIdentity(), key = await areaKey();
const policy: Policy = { tenant: "test", version: "4", rules: [{ subject: "user:1", scope: "absence:2", facet: "personnel", effect: "allow", actions: ["read", "approve"], origin: "absence-default" }] };
const previous = await signPolicy({ ...policy, version: "3", rules: [] }, identity.signingKey.privateKey);
const envelope = await encryptObject({ tenant: "test", scope: "personnel:2", facet: "scope", object: "personnel:2:scope:record", revision: "2", generation: "1", policyVersion: "3", author: "user:1" }, bytes("{}"), key, identity.signingKey.privateKey);
const heads = [{ domain: "personnel:2:scope", sequence: "8" }];
const variants = await Promise.all([undefined, [] as string[], ["user:3"]].map(suspended => signPolicyTransaction({ ...policy, ...(suspended === undefined ? {} : { suspended }) },
  { author: "user:1", previousSignature: previous.signature, packets: [envelope.signature], heads }, identity.signingKey.privateKey)));
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-policy-transactions.json", import.meta.url), JSON.stringify({ notice: "Public synthetic protocol vectors; no private keys or recovery phrase.", signer: await publicSigningKey(identity.signingKey.publicKey), previous, policies: variants, objects: [{ domain: "personnel:2:scope", messageId: "synthetic-command", envelope }], heads }, null, 2) + "\n");
