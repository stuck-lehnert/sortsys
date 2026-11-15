import { expect, test } from "bun:test";
import {
  base64,
  claimInvitation,
  createIdentity,
  createInvitation,
  invitationRegistrationFrame,
  randomSecret,
  sign,
  verify,
  verifyInvitationClaim,
} from "../src/sortsys";

test("invitation registration binds an opaque signed exchange without an identifier-size limit", async () => {
  const authority = await createIdentity();
  const identity = await createIdentity();
  const invitation = await createInvitation(
    {
      tenant: "test",
      generation: "1",
      user: "user:123",
      username: "invited",
      validUntil: "1900000000",
    },
    authority.signingKey.privateKey,
  );
  const claim = await claimInvitation(
    invitation.invitation,
    invitation.secret,
    identity,
    "1",
  );
  const hash = base64(randomSecret());
  const exchange = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(256)}.${base64(randomSecret())}`;
  const message = await invitationRegistrationFrame(
    invitation.invitation,
    exchange,
    hash,
    hash,
    claim,
  );
  const proof = await sign(identity.signingKey.privateKey, message);
  await verify(identity.signingKey.publicKey, proof, message);
  const changed = await invitationRegistrationFrame(
    invitation.invitation,
    `${exchange}b`,
    hash,
    hash,
    claim,
  );
  await expect(
    verify(identity.signingKey.publicKey, proof, changed),
  ).rejects.toThrow();
  for (const invalid of ["", "a".repeat(4097), "a\nb", "a b"]) {
    await expect(
      invitationRegistrationFrame(
        invitation.invitation,
        invalid,
        hash,
        hash,
        claim,
      ),
    ).rejects.toThrow();
  }
  await expect(
    verifyInvitationClaim(
      { ...claim, confirmation: base64(randomSecret()) },
      invitation.invitation,
      invitation.secret,
    ),
  ).rejects.toThrow();
});
