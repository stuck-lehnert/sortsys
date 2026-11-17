import React from "react";
import { MemoryRouter } from "react-router";
import {
  createIdentity,
  createTenantSetup,
  importSigningKey,
  recoveryAccountFrame,
  recoveryMemberFrame,
  base64,
  randomSecret,
  verify,
} from "@sortsys/zerotrust/sortsys";
import { I18nProvider } from "../../app/lib/i18n";
import { client } from "../../app/lib/client";
import { lockCryptoSession } from "../../app/lib/crypto/session";
import RecoveryPage from "../../app/routes/auth/recovery";

// Public BIP-39 test phrase; this fixture contains no real tenant credentials.
const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

export async function showRecoveryPage(root, options = {}) {
  await lockCryptoSession();
  const { setup } = await createTenantSetup(
    "test",
    "user:1",
    await createIdentity(),
    phrase,
  );
  const calls = [];
  client.query = async (path) => {
    if (path !== "zerotrust.recovery.head")
      throw new Error("Unexpected recovery query: " + path);
    return [
      { generation: "1", authority: setup.authority, operation: null },
      null,
    ];
  };
  client.mutate = async (path, input) => {
    if (
      path !== "zerotrust.recovery.account" &&
      path !== "zerotrust.recovery.member"
    )
      throw new Error("Unexpected recovery mutation: " + path);
    await verify(
      await importSigningKey(setup.authority.recoverySigningKey),
      input.proof,
      path === "zerotrust.recovery.member"
        ? recoveryMemberFrame(
            input.tenant,
            input.generation,
            input.username,
            input.nonce,
          )
        : recoveryAccountFrame(input.tenant, input.generation, input.nonce),
    );
    calls.push({
      path,
      seedProofValid: true,
      secretUploaded: [
        phrase,
        "Typed-recovery-test-password-2026!",
        "Typed-member-recovery-password-2026!",
      ].some((secret) => JSON.stringify(input).includes(secret)),
    });
    if (path === "zerotrust.recovery.account" && options.administratorAvailable)
      return [
        {
          subject: "user:1",
          username: "administrator",
          version: base64(randomSecret()),
        },
        null,
      ];
    if (path === "zerotrust.recovery.member" && options.memberAvailable)
      return [
        {
          subject: "user:2",
          username: input.username,
          version: base64(randomSecret()),
        },
        null,
      ];
    // Exercise the explicit unavailable-account choice before generating a
    // full recovery. Native integration tests cover successful publication.
    return [null, null];
  };
  window.cryptoFixture.recoveryRequests = () => [...calls];
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <MemoryRouter>
          <RecoveryPage />
        </MemoryRouter>
      </I18nProvider>
    </React.StrictMode>,
  );
  return { tenant: "test", phrase };
}
