import { expect, test } from "bun:test";
import { server } from "@serenity-kit/opaque";
import { createAccountVault, createIdentity, finishOpaqueLogin, finishOpaqueRegistration, opaqueIdentifiers, opaqueReady, openAccountVault, publicIdentity, rewrapAccountVault, startOpaqueLogin, startOpaqueRegistration } from "../src/sortsys";

test("OPAQUE authenticates without sending a password and unlocks the same client vault", async () => {
  await opaqueReady;
  const password = "8#New-password-never-at-the-server";
  const setup = server.createSetup();
  const registration = await startOpaqueRegistration(password);
  const response = server.createRegistrationResponse({ serverSetup: setup, userIdentifier: "test/john.doe", registrationRequest: registration.registrationRequest });
  const registered = await finishOpaqueRegistration(password, "test", "john.doe", registration, response.registrationResponse);
  const identity = await createIdentity();
  const vault = await createAccountVault(registered.exportKey, "test", "john.doe", identity, { recovery: "pinned-key" });
  const login = await startOpaqueLogin(password);
  const serverLogin = server.startLogin({ serverSetup: setup, userIdentifier: "test/john.doe", registrationRecord: registered.registrationRecord, startLoginRequest: login.startLoginRequest, identifiers: opaqueIdentifiers("test", "john.doe") });
  const clientLogin = await finishOpaqueLogin(password, "test", "john.doe", login, serverLogin.loginResponse);
  expect(server.finishLogin({ serverLoginState: serverLogin.serverLoginState, finishLoginRequest: clientLogin.finishLoginRequest }).sessionKey).toBe(clientLogin.sessionKey);
  expect(clientLogin.exportKey).toBe(registered.exportKey);
  const opened = await openAccountVault(clientLogin.exportKey, "test", "john.doe", vault);
  expect(await publicIdentity(opened.identity)).toEqual(await publicIdentity(identity));
  expect(opened.pins.recovery).toBe("pinned-key");
  expect(JSON.stringify([registration.registrationRequest, response, registered.registrationRecord, login.startLoginRequest, serverLogin.loginResponse, clientLogin.finishLoginRequest, vault])).not.toContain(password);

  const incorrect = await startOpaqueLogin("wrong password");
  const incorrectResponse = server.startLogin({ serverSetup: setup, userIdentifier: "test/john.doe", registrationRecord: registered.registrationRecord, startLoginRequest: incorrect.startLoginRequest, identifiers: opaqueIdentifiers("test", "john.doe") });
  await expect(finishOpaqueLogin("wrong password", "test", "john.doe", incorrect, incorrectResponse.loginResponse)).rejects.toThrow();
}, 15000);

test("password changes only rewrap the vault; old export key no longer opens the new package", async () => {
  const first = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64url");
  const second = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64url");
  const identity = await createIdentity();
  const vault = await createAccountVault(first, "test", "john.doe", identity);
  const next = await rewrapAccountVault(first, second, vault);
  expect(next.ciphertext).toBe(vault.ciphertext);
  expect(next.wrappedKey).not.toBe(vault.wrappedKey);
  await expect(openAccountVault(first, "test", "john.doe", next)).rejects.toThrow();
  expect(await publicIdentity((await openAccountVault(second, "test", "john.doe", next)).identity)).toEqual(await publicIdentity(identity));
  await expect(openAccountVault(second, "other", "john.doe", next)).rejects.toThrow();
});
