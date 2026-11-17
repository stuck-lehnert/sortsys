import {
  base64,
  createAccountVault,
  createIdentity,
  createPasskeyVault,
  finishOpaqueRegistration,
  openAccountVault,
  randomSecret,
  opaqueIdentifiers,
  opaqueReady,
  startOpaqueRegistration,
} from "../src/index";
import { server } from "@serenity-kit/opaque";

// Public test credentials only. The production server never receives the
// password export key or the authenticator's PRF output.
await opaqueReady;
const password = "SyntheticPasskeyAccount-261113";
const opaqueServerSetup = server.createSetup();
const started = await startOpaqueRegistration(password);
const response = server.createRegistrationResponse({
  serverSetup: opaqueServerSetup,
  userIdentifier: opaqueIdentifiers("test", "user:1").client,
  registrationRequest: started.registrationRequest,
});
const registration = await finishOpaqueRegistration(
  password,
  "test",
  "user:1",
  started,
  response.registrationResponse,
);
const identity = await createIdentity();
const exportKey = registration.exportKey;
const account = await createAccountVault(
  exportKey,
  "test",
  "user:1",
  identity,
);
const opened = await openAccountVault(exportKey, "test", "user:1", account);
const prf = randomSecret();
try {
  const packet = await createPasskeyVault(
    prf,
    opened.dataKey,
    account,
    "example.test",
    base64(randomSecret()),
  );
  await Bun.write(
    new URL("./fixtures/passkey-vault.json", import.meta.url),
    JSON.stringify(
      {
        notice:
          "Public synthetic test credentials, OPAQUE server setup, account and signed PRF wrapper. No private account key, password export key or PRF output is retained. Never use these credentials in production.",
        password,
        opaqueServerSetup,
        registrationRecord: registration.registrationRecord,
        account,
        packet,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  prf.fill(0);
}
