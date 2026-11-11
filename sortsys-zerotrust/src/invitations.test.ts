import { expect, test } from "bun:test";
import { base64, digest, randomSecret } from "./encoding";
import { createIdentity, sign, verify, signingPair } from "./identity";
import { claimInvitation, createInvitation, invitation, invitationClaimHash, invitationRegistrationFrame, readInvitationLink, verifyInvitation, verifyInvitationClaim } from "./invitations";

async function fixture() {
  const authority = await signingPair(), identity = await createIdentity();
  const { invitation, secret } = await createInvitation({ tenant: "test", generation: "2", user: "user:123", username: "frank.doe", validUntil: "2000000000" }, authority.privateKey);
  return { authority, identity, invitation, secret };
}
test("the invitation secret binds an administrator-confirmed identity without entering the public packet", async () => {
  const f = await fixture();
  expect(JSON.stringify(f.invitation)).not.toContain(f.secret);
  expect(await verifyInvitation(f.invitation, f.authority.publicKey, f.secret)).toEqual(f.invitation);
  const claim = await claimInvitation(f.invitation, f.secret, f.identity, "3");
  expect(JSON.stringify(claim)).not.toContain(f.secret);
  expect(await verifyInvitationClaim(claim, f.invitation, f.secret)).toEqual(claim);
  expect(await invitationClaimHash(claim, f.invitation)).toMatch(/^[\w-]{43}$/);
});
test("database replacement of public keys, account revisions, recipients and invitation generation cannot forge confirmation", async () => {
  const f = await fixture(), claim = await claimInvitation(f.invitation, f.secret, f.identity, "3");
  const attacker = await createIdentity(), replacement = await claimInvitation(f.invitation, f.secret, attacker, "3");
  for (const changed of [{ ...claim, encryptionKey: replacement.encryptionKey }, { ...claim, signingKey: replacement.signingKey },
    { ...replacement, confirmation: claim.confirmation }, { ...claim, revision: "4" }, { ...claim, user: "user:124" }, { ...claim, generation: "3" }]) {
    await expect(verifyInvitationClaim(changed, f.invitation, f.secret)).rejects.toThrow();
  }
  await expect(verifyInvitation(f.invitation, f.authority.publicKey, base64(randomSecret()))).rejects.toThrow();
  await expect(verifyInvitation({ ...f.invitation, username: "someone.else" }, f.authority.publicKey, f.secret)).rejects.toThrow();
});
test("confirmation is bound to the exact signed invitation and cannot cross tenants or invitations", async () => {
  const f = await fixture(), claim = await claimInvitation(f.invitation, f.secret, f.identity, "1");
  for (const signed of [{ ...f.invitation, id: "invite_other" }, { ...f.invitation, tenant: "other" }, { ...f.invitation, validUntil: "2000000001" }]) {
    await expect(verifyInvitationClaim(claim, signed, f.secret)).rejects.toThrow();
  }
  expect(() => invitation({ ...f.invitation, privateKey: "forbidden" })).toThrow();
  expect(() => readInvitationLink({ invitation: f.invitation, secret: "short", recoverySigningKey: base64(randomSecret()) })).toThrow();
});

test("a claimed identity cannot authorize a substituted registration, vault or exchange", async () => {
  const f = await fixture(), claim = await claimInvitation(f.invitation, f.secret, f.identity, "1");
  const record = await digest(new TextEncoder().encode("opaque credential")), vault = await digest(new TextEncoder().encode("encrypted vault"));
  const message = await invitationRegistrationFrame(f.invitation, "exchange_1", record, vault, claim);
  const proof = await sign(f.identity.signingKey.privateKey, message);
  await verify(f.identity.signingKey.publicKey, proof, message);
  const other = await digest(new TextEncoder().encode("replacement"));
  for (const changed of [await invitationRegistrationFrame(f.invitation, "exchange_2", record, vault, claim),
    await invitationRegistrationFrame(f.invitation, "exchange_1", other, vault, claim),
    await invitationRegistrationFrame(f.invitation, "exchange_1", record, other, claim),
    await invitationRegistrationFrame(f.invitation, "exchange_1", record, vault, { ...claim, confirmation: base64(randomSecret()) })]) {
    await expect(verify(f.identity.signingKey.publicKey, proof, changed)).rejects.toThrow();
  }
});
