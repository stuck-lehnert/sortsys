import { expect, test } from "bun:test";
import {
  base64,
  createRecoveryPhrase,
  finishOpaqueLogin,
  importSigningKey,
  identityCertificateFrame,
  openAccountVault,
  opaqueIdentifiers,
  prepareRecovery,
  randomSecret,
  recoveredMembersFrame,
  recoveryMemberFrame,
  recoveryMemberRegistrationFrame,
  recoveryIdentity,
  sign,
  startOpaqueLogin,
  verify,
  verifyRecoveryTransition,
} from "../src/sortsys";
import { server } from "@serenity-kit/opaque";
import { recoveryFixture } from "./support/recoveryFixture";

test("seed recovery binds a member credential while retaining its principal and separating it from the administrator", async () => {
  const fixture = await recoveryFixture();
  const account = {
    subject: "user:member",
    username: "member",
    version: base64(randomSecret()),
  };
  const password = "Replacement-member-password-2026!";
  const seed = await recoveryIdentity(fixture.phrase, "test", "1");
  const { plan } = await prepareRecovery({
    oldPhrase: fixture.phrase,
    newPhrase: createRecoveryPhrase(),
    password: fixture.password,
    source: fixture.source,
    members: [{ account, password }],
    register: async (input) => {
      if (input.member) {
        expect(input.subject).toBe(account.subject);
        expect(input.accountVersion).toBe(account.version);
        await verify(
          seed.signingKey.publicKey,
          input.proof,
          recoveryMemberRegistrationFrame({
            tenant: input.tenant,
            challengeId: input.challengeId,
            account,
            registrationRequest: input.registrationRequest,
          }),
        );
      }
      return fixture.register(input);
    },
  });
  await verifyRecoveryTransition(plan);
  const member = plan.members![0]!;
  expect(member.account).toEqual(account);
  expect(plan.nextSetup.owner.user).not.toBe(account.subject);
  expect(member.vault.subject).toBe(account.subject);
  await verify(
    await importSigningKey(plan.nextSetup.authority.authoritySigningKey),
    member.certificate.signature,
    identityCertificateFrame(member.certificate),
  );
  const login = await startOpaqueLogin(password);
  const response = server.startLogin({
    serverSetup: fixture.serverSetup,
    userIdentifier: opaqueIdentifiers("test", account.subject).client,
    registrationRecord: member.registrationRecord,
    startLoginRequest: login.startLoginRequest,
    identifiers: opaqueIdentifiers("test", account.subject),
  });
  const openedLogin = await finishOpaqueLogin(
    password,
    "test",
    account.subject,
    login,
    response.loginResponse,
  );
  const opened = await openAccountVault(
    openedLogin.exportKey,
    "test",
    account.subject,
    member.vault,
  );
  expect(opened.pins.recoveryGeneration).toBe("2");
  for (const change of [
    { ...member, account: { ...account, version: base64(randomSecret()) } },
    { ...member, registrationRecord: base64(randomSecret()) },
    {
      ...member,
      vault: { ...member.vault, wrappedKey: base64(new Uint8Array(40)) },
    },
  ]) {
    await expect(
      verifyRecoveryTransition({ ...plan, members: [change] }),
    ).rejects.toThrow();
  }
  const omitted = { ...plan };
  delete omitted.members;
  await expect(verifyRecoveryTransition(omitted)).rejects.toThrow();
  await expect(recoveredMembersFrame([member, member])).rejects.toThrow();
  await expect(recoveredMembersFrame([])).rejects.toThrow();
  await expect(recoveredMembersFrame(Array(9).fill(member))).rejects.toThrow();
});

test("a seed member lookup binds the alias, tenant, generation and nonce", async () => {
  const seed = await recoveryIdentity(createRecoveryPhrase(), "test", "1");
  const nonce = base64(randomSecret());
  const message = recoveryMemberFrame("test", "1", "member", nonce);
  const proof = await sign(seed.signingKey.privateKey, message);
  await verify(seed.signingKey.publicKey, proof, message);
  for (const changed of [
    recoveryMemberFrame("other", "1", "member", nonce),
    recoveryMemberFrame("test", "2", "member", nonce),
    recoveryMemberFrame("test", "1", "administrator", nonce),
    recoveryMemberFrame("test", "1", "member", base64(randomSecret())),
  ])
    await expect(
      verify(seed.signingKey.publicKey, proof, changed),
    ).rejects.toThrow();
});
