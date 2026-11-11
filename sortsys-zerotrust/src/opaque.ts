import { client, ready } from "@serenity-kit/opaque";
import { identifier } from "./encoding";

export { ready as opaqueReady };
export type OpaqueRegistrationStart = ReturnType<typeof client.startRegistration>;
export type OpaqueRegistrationResult = ReturnType<typeof client.finishRegistration>;
export type OpaqueLoginStart = ReturnType<typeof client.startLogin>;
export type OpaqueLoginResult = NonNullable<ReturnType<typeof client.finishLogin>>;

export function opaqueIdentifiers(tenant: string, username: string): { client: string; server: string } {
  identifier(tenant);
  identifier(username);
  return { client: `${tenant.toLowerCase()}/${username.toLowerCase()}`, server: "sortsys/opaque/v1" };
}

// Argon2id 64 MiB / 3 passes; the wrapper must run in a Worker in browser UIs.
const keyStretching = { "argon2id-custom": { memory: 65536, iterations: 3, parallelism: 1 } } as const;

export async function startOpaqueRegistration(password: string): Promise<OpaqueRegistrationStart> {
  await ready;
  return client.startRegistration({ password });
}

export async function finishOpaqueRegistration(password: string, tenant: string, username: string, state: OpaqueRegistrationStart, registrationResponse: string): Promise<OpaqueRegistrationResult> {
  await ready;
  return client.finishRegistration({ password, clientRegistrationState: state.clientRegistrationState, registrationResponse, identifiers: opaqueIdentifiers(tenant, username), keyStretching });
}

export async function startOpaqueLogin(password: string): Promise<OpaqueLoginStart> {
  await ready;
  return client.startLogin({ password });
}

export async function finishOpaqueLogin(password: string, tenant: string, username: string, state: OpaqueLoginStart, loginResponse: string): Promise<OpaqueLoginResult> {
  await ready;
  const result = client.finishLogin({ password, clientLoginState: state.clientLoginState, loginResponse, identifiers: opaqueIdentifiers(tenant, username), keyStretching });
  if (!result) throw new Error("Anmeldung fehlgeschlagen.");
  return result;
}
