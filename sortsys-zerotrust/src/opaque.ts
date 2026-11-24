import { opaqueIdentifiers } from "./credentials";

export { opaqueIdentifiers } from "./credentials";

type OpaqueClient = typeof import("@serenity-kit/opaque").client;
export type OpaqueRegistrationStart = ReturnType<
  OpaqueClient["startRegistration"]
>;
export type OpaqueRegistrationResult = ReturnType<
  OpaqueClient["finishRegistration"]
>;
export type OpaqueLoginStart = ReturnType<OpaqueClient["startLogin"]>;
export type OpaqueLoginResult = NonNullable<
  ReturnType<OpaqueClient["finishLogin"]>
>;

async function loadClient(): Promise<OpaqueClient> {
  // Importing the WASM package starts initialization. Do that only when an
  // OPAQUE operation runs, not when a page imports the shared crypto helpers.
  const { client, ready } = await import("@serenity-kit/opaque");
  await ready;
  return client;
}

// Argon2id 64 MiB / 3 passes; the wrapper must run in a Worker in browser UIs.
const keyStretching = {
  "argon2id-custom": { memory: 65536, iterations: 3, parallelism: 1 },
} as const;

export async function startOpaqueRegistration(
  password: string,
): Promise<OpaqueRegistrationStart> {
  const client = await loadClient();
  return client.startRegistration({ password });
}

export async function finishOpaqueRegistration(
  password: string,
  tenant: string,
  subject: string,
  state: OpaqueRegistrationStart,
  registrationResponse: string,
): Promise<OpaqueRegistrationResult> {
  const client = await loadClient();
  return client.finishRegistration({
    password,
    clientRegistrationState: state.clientRegistrationState,
    registrationResponse,
    identifiers: opaqueIdentifiers(tenant, subject),
    keyStretching,
  });
}

export async function startOpaqueLogin(
  password: string,
): Promise<OpaqueLoginStart> {
  const client = await loadClient();
  return client.startLogin({ password });
}

export async function finishOpaqueLogin(
  password: string,
  tenant: string,
  subject: string,
  state: OpaqueLoginStart,
  loginResponse: string,
): Promise<OpaqueLoginResult> {
  const client = await loadClient();
  const result = client.finishLogin({
    password,
    clientLoginState: state.clientLoginState,
    loginResponse,
    identifiers: opaqueIdentifiers(tenant, subject),
    keyStretching,
  });
  if (!result) throw new Error("Anmeldung fehlgeschlagen.");
  return result;
}
