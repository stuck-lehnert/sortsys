// Public interoperability credentials. Never use these values in production.
import { server } from "@serenity-kit/opaque";
import {
  finishOpaqueLogin,
  finishOpaqueRegistration,
  opaqueIdentifiers,
  startOpaqueLogin,
  startOpaqueRegistration,
} from "../src/index";

const tenant = "test";
const subject = `user:${(9021).toString(32)}`;
const password = "Synthetic-OPAQUE-interop-261117!";
const registration = await startOpaqueRegistration(password);
const setup = server.createSetup();
const identifiers = opaqueIdentifiers(tenant, subject);
const response = server.createRegistrationResponse({
  serverSetup: setup,
  userIdentifier: identifiers.client,
  registrationRequest: registration.registrationRequest,
});
const registered = await finishOpaqueRegistration(
  password,
  tenant,
  subject,
  registration,
  response.registrationResponse,
);
const login = await startOpaqueLogin(password);
const challenge = server.startLogin({
  serverSetup: setup,
  userIdentifier: identifiers.client,
  registrationRecord: registered.registrationRecord,
  startLoginRequest: login.startLoginRequest,
  identifiers,
});
const finished = await finishOpaqueLogin(
  password,
  tenant,
  subject,
  login,
  challenge.loginResponse,
);
server.finishLogin({
  serverLoginState: challenge.serverLoginState,
  finishLoginRequest: finished.finishLoginRequest,
  identifiers,
});
await Bun.write(
  new URL(
    "../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-opaque.json",
    import.meta.url,
  ),
  JSON.stringify(
    {
      notice:
        "Public synthetic OPAQUE interoperability vector. Never use these credentials in production.",
      tenant,
      subject,
      password,
      setup,
      registrationRecord: registered.registrationRecord,
      ...login,
      ...challenge,
      ...finished,
    },
    null,
    2,
  ) + "\n",
);
