import { expect, test } from "bun:test";
import { server } from "@serenity-kit/opaque";
import { opaqueIdentifiers, opaqueReady } from "../src";
import { OpaqueWorkerClient } from "../src/opaqueWorker";

test("password stretching runs in a dedicated worker and preserves the native OPAQUE protocol", async () => {
  await opaqueReady;
  const worker = new OpaqueWorkerClient(new Worker(new URL("./support/opaqueWorker.ts", import.meta.url), { type: "module" }));
  try {
    const password = "synthetic-worker-password";
    const serverSetup = server.createSetup();
    const started = await worker.call("registrationStart", { password });
    const response = server.createRegistrationResponse({ serverSetup, userIdentifier: "test/worker", registrationRequest: started.registrationRequest });
    const registration = await worker.call("registrationFinish", { password, tenant: "test", username: "worker", state: started, response: response.registrationResponse });
    const login = await worker.call("loginStart", { password });
    const challenge = server.startLogin({ serverSetup, userIdentifier: "test/worker", registrationRecord: registration.registrationRecord, startLoginRequest: login.startLoginRequest, identifiers: opaqueIdentifiers("test", "worker") });
    const result = await worker.call("loginFinish", { password, tenant: "test", username: "worker", state: login, response: challenge.loginResponse });
    expect(result.exportKey).toBe(registration.exportKey);
    expect(server.finishLogin({ serverLoginState: challenge.serverLoginState, finishLoginRequest: result.finishLoginRequest }).sessionKey).toBe(result.sessionKey);
  } finally { worker.close(); }
  await expect(worker.call("loginStart", { password: "after-close" })).rejects.toThrow();
}, 15000);
