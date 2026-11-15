import {
  areaKey,
  base64,
  bytes,
  createIdentity,
  createZeroTrust,
  type ObjectContext,
  publicIdentity,
  migrationFileReceiptFrame,
  immutableObject,
  randomSecret,
  type RecoveryTransition,
  recoveryTransitionFrame,
  recoveryPageFrame,
  sign,
} from "../src/index";

const framework = createZeroTrust({
  facets: ["patient-notes", "appointments"],
});
const identity = await createIdentity();
const context: ObjectContext<"patient-notes"> = {
  tenant: "practice:alpha",
  scope: "patient:ada",
  facet: "patient-notes",
  object: "note:1",
  revision: "1",
  generation: "1",
  policyVersion: "1",
  author: "doctor:lee",
};
const object = await framework.objects.encryptObject(
  context,
  bytes("Synthetic example"),
  await areaKey(),
  identity.signingKey.privateKey,
);
const policy = await framework.policies.signPolicy({
  tenant: context.tenant,
  version: "1",
  suspended: ["doctor:suspended"],
  rules: [{
    subject: context.author,
    scope: context.scope,
    facet: context.facet,
    actions: ["read", "update"],
    effect: "allow",
  }],
}, identity.signingKey.privateKey);
const transition: RecoveryTransition = {
  tenant: context.tenant,
  generation: "1",
  operation: "recovery:example",
  challenge: base64(randomSecret()),
  catalogVersion: "1",
  catalogHash: base64(randomSecret()),
  previousAuthorityCertificateHash: base64(randomSecret()),
  nextRecoveryEncryptionKey: base64(randomSecret()),
  nextRecoverySigningKey: base64(randomSecret()),
  nextAuthoritySigningKey: base64(randomSecret()),
  nextAdministrator: context.author,
  nextAdministratorBundleHash: base64(randomSecret()),
};
const transitionSignature = await sign(
  identity.signingKey.privateKey,
  recoveryTransitionFrame(transition),
);
const pageAccess = {
  tenant: context.tenant,
  generation: "1",
  challengeId: "recovery:example",
  challenge: base64(randomSecret()),
  snapshot: "1.2.3",
  after: "opaque:cursor",
};
const pageSignature = await sign(identity.signingKey.privateKey, recoveryPageFrame(pageAccess));
const unsignedFileReceipt = {
  tenant: context.tenant,
  migration: "migration:practice",
  generation: "1",
  source: "source:scan",
  bytes: "262151",
  object: "archive:scan",
  revision: "1",
  ciphertextHash: base64(randomSecret()),
  blocks: [
    { id: "block:scan:0", hash: base64(randomSecret()) },
    { id: "block:scan:1", hash: base64(randomSecret()) },
  ],
  author: context.author,
};
const fileReceipt = {
  ...unsignedFileReceipt,
  proof: await sign(identity.signingKey.privateKey, migrationFileReceiptFrame(unsignedFileReceipt)),
};
const permanent = await framework.objects.encryptObject(
  { ...context, object: immutableObject(context.scope, context.facet, "record", "visit_1") },
  bytes("Synthetic permanent record"),
  await areaKey(),
  identity.signingKey.privateKey,
);
await Bun.write(
  new URL("./fixtures/framework.json", import.meta.url),
  JSON.stringify(
    {
      notice:
        "Public synthetic browser protocol vector; no private keys or real business data.",
      signer: await publicIdentity(identity),
      object,
      policy,
      transition,
      transitionSignature,
      pageAccess,
      pageSignature,
      fileReceipt,
      permanent,
    },
    null,
    2,
  ) + "\n",
);
