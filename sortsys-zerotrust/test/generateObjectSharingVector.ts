import { writeFile } from "node:fs/promises";
import { objectSharingFixture } from "./support/objectShares";
import { sealBox } from "../src/boxes";
import { objectKeyRecipientBinding } from "../src/core/objectShares";
import { publicIdentity } from "../src/identity";

const fixture = await objectSharingFixture();
const authority = await publicIdentity(fixture.authority);
const context = await fixture.security.objects.objectKeyShareContext(
  fixture.object,
  fixture.share,
);
const malformedKeys = await Promise.all(
  [16, 48].map((length) =>
    sealBox(
      context,
      new Uint8Array(length),
      fixture.recipient.encryptionKey.publicKey,
      fixture.manager.signingKey.privateKey,
    ),
  ),
);
const differentObjects = await Promise.all(
  [
    { ...fixture.expected, object: "appointment:18" },
    { ...fixture.expected, revision: "5" },
  ].map((expected) =>
    fixture.security.objects.encryptObject(
      expected,
      fixture.plaintext,
      fixture.wrappingKey,
      fixture.writer.signingKey.privateKey,
    ),
  ),
);
await writeFile(
  new URL("./fixtures/object-shares.json", import.meta.url),
  JSON.stringify(
    {
      source: fixture.object,
      share: fixture.envelope,
      context: fixture.share,
      sourceSigner: fixture.publicWriter.signingKey,
      grantSigner: fixture.publicManager.signingKey,
      malformedKeys,
      differentObjects,
      recipientCertificate: fixture.certifiedRecipient,
      authority: authority.signingKey,
      recipientBinding: await objectKeyRecipientBinding(
        fixture.certifiedRecipient,
        fixture.envelope,
      ),
      emptyBinding: await objectKeyRecipientBinding(null, null),
    },
    null,
    2,
  ) + "\n",
);
