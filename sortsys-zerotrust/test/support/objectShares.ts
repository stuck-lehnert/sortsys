import { areaKey, createIdentity, publicIdentity } from "../../src/identity";
import { bytes, randomSecret } from "../../src/encoding";
import { createZeroTrust } from "../../src/core/framework";
import { certifyIdentity } from "../../src/core/certificates";

export async function objectSharingFixture() {
  const security = createZeroTrust({
    facets: ["appointments", "research-notes"],
  });
  const writer = await createIdentity();
  const manager = await createIdentity();
  const recipient = await createIdentity();
  const authority = await createIdentity();
  const wrappingKey = await areaKey(randomSecret());
  const expected = {
    tenant: "practice:alpha",
    scope: "calendar:private",
    facet: "appointments" as const,
    object: "appointment:17",
    revision: "4",
    generation: "7",
    policyVersion: "12",
    author: "doctor:writer",
  };
  const share = {
    authorityGeneration: "3",
    recipient: "patient:recipient",
    author: "doctor:manager",
  };
  const plaintext = bytes(
    "Privater Termin 918264 — kein Zugriff auf andere Termine",
  );
  const object = await security.objects.encryptObject(
    expected,
    plaintext,
    wrappingKey,
    writer.signingKey.privateKey,
  );
  const issue = {
    object,
    expected,
    wrappingKey,
    objectSigner: writer.signingKey.publicKey,
    share,
    recipientKey: recipient.encryptionKey.publicKey,
    signingKey: manager.signingKey.privateKey,
  };
  const envelope = await security.objects.shareObjectKey(issue);
  const certifiedRecipient = await certifyIdentity(
    {
      tenant: expected.tenant,
      generation: share.authorityGeneration,
      user: share.recipient,
      ...(await publicIdentity(recipient)),
    },
    authority.signingKey.privateKey,
  );
  const certifiedIssuer = await certifyIdentity(
    {
      tenant: expected.tenant,
      generation: share.authorityGeneration,
      user: share.author,
      ...(await publicIdentity(manager)),
    },
    authority.signingKey.privateKey,
  );
  const open = {
    object,
    expected,
    objectSigner: writer.signingKey.publicKey,
    envelope,
    share,
    recipientKey: recipient.encryptionKey.privateKey,
    grantSigner: manager.signingKey.publicKey,
  };
  return {
    security,
    writer,
    manager,
    recipient,
    authority,
    certifiedRecipient,
    certifiedIssuer,
    wrappingKey,
    expected,
    share,
    plaintext,
    object,
    envelope,
    issue,
    open,
    publicWriter: await publicIdentity(writer),
    publicManager: await publicIdentity(manager),
    publicRecipient: await publicIdentity(recipient),
  };
}
