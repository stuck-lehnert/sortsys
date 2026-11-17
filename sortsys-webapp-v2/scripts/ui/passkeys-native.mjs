import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import superjson from "superjson";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
assert.ok(
  typeof root === "string" &&
    isAbsolute(root) &&
    basename(root).startsWith("sortsys-native-auth-"),
);
const origin = process.env.SORTSYS_PASSKEY_TEST_ORIGIN;
const originUrl = new URL(origin);
assert.equal(originUrl.hostname, "localhost");
assert.equal(originUrl.protocol, "http:");
const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS);
for (const endpoint of endpoints)
  assert.equal(new URL(endpoint).hostname, "127.0.0.1");
async function lifecycle(mode) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.env.SORTSYS_NATIVE_BUN ?? "bun",
      ["scripts/test-native-passkey-account.ts", mode],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      try {
        if (code !== 0 || !JSON.parse(output.trim()).success)
          throw new Error(`Native account step ${mode} failed: ${errors}`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function rpc(side, path, input, suppliedOrigin = origin) {
  const url = new URL(path, endpoints[side]);
  url.searchParams.set("batch", "1");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: suppliedOrigin },
    body: JSON.stringify({ 0: superjson.serialize(input) }),
  });
  const [payload] = await response.json();
  if (payload.error)
    return { ok: false, error: superjson.deserialize(payload.error) };
  return { ok: true, value: superjson.deserialize(payload.result.data) };
}

// This fixture encodes only the bounded CBOR values used by a none-attestation
// ES256 test credential. Chromium starts its ordinary virtual credentials with
// a positive counter; this separate key models authenticators without one.
function cborHead(kind, size) {
  assert.ok(size >= 0 && size < 65536);
  if (size < 24) return Buffer.from([(kind << 5) | size]);
  if (size < 256) return Buffer.from([(kind << 5) | 24, size]);
  return Buffer.from([(kind << 5) | 25, size >> 8, size & 255]);
}
function cbor(value) {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value);
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([cborHead(2, value.length), value]);
  assert.ok(value instanceof Map);
  return Buffer.concat([
    cborHead(5, value.size),
    ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry)]),
  ]);
}
const browser = await chromium.launch();
const context = await browser.newContext();
const external = [];
await context.route("**/*", (route) => {
  if (new URL(route.request().url()).origin === origin) return route.continue();
  external.push(route.request().url());
  return route.abort("blockedbyclient");
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
async function authenticator() {
  return (
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasHmacSecret: true,
        hasHmacSecretMc: true,
      },
    })
  ).authenticatorId;
}
let authenticatorId = await authenticator();
async function click(name) {
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForFunction(() => !window.nativePasskey.state().busy);
  return page.evaluate(() => window.nativePasskey.state());
}
async function coldSignIn(expectedName = "builder") {
  await click("Lokalen Zugang schließen");
  const state = await click("Mit Passkey anmelden");
  assert.equal(state.error, "");
  assert.equal(state.unlocked, true);
  assert.equal(state.authenticated, true);
  assert.equal(state.identityMatches, true);
  assert.equal(state.username, expectedName);
  return state;
}
try {
  await page.goto(origin);
  await page.waitForFunction(() => window.nativePasskey);
  await page
    .getByLabel("Passwort", { exact: true })
    .fill("Only-owner-knows-this-password-2026!");
  let state = await click("Anmelden");
  assert.equal(state.error, "");
  console.log(
    "Native passkey: real browser registration and account-signed PRF wrapper",
  );
  state = await click("Passkey einrichten");
  assert.equal(state.error, "");
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].opensData, true);
  await page
    .getByRole("list", { name: "Passkeys" })
    .getByText("Entschlüsselung verfügbar", { exact: false })
    .waitFor();
  const initialDevice = state.devices[0];
  for (const mode of ["unsigned", "origin", "wrapper", "replay"]) {
    assert.equal(
      (
        await page.evaluate(
          (mode) => window.nativePasskey.rejectedRegistration(mode),
          mode,
        )
      ).ok,
      false,
      mode,
    );
    assert.equal(
      (await page.evaluate(() => window.nativePasskey.list())).length,
      1,
    );
  }
  assert.equal(
    (
      await rpc(
        0,
        "auth.passkeys.loginOptions",
        undefined,
        "https://evil.example.test",
      )
    ).ok,
    false,
  );
  console.log(
    "Native passkey: cold-device unlock across API instances and consumed login rejection",
  );
  await coldSignIn();
  assert.equal(
    (await page.evaluate(() => window.nativePasskey.replayLogin())).ok,
    false,
  );

  console.log(
    "Native passkey: password changes retain the authenticator wrapper",
  );
  await page.evaluate(() => window.nativePasskey.changePassword());
  await coldSignIn();

  console.log(
    "Native passkey: a valid signature from another tenant cannot claim this credential",
  );
  await page.evaluate(() =>
    window.nativePasskey.password(
      "passkey-tenant-b",
      "builder",
      "Only-owner-knows-this-password-2026!",
    ),
  );
  assert.equal(
    (
      await page.evaluate(() =>
        window.nativePasskey.rejectedRegistration("other-tenant"),
      )
    ).ok,
    false,
  );
  assert.equal(
    (await page.evaluate(() => window.nativePasskey.list())).length,
    0,
  );
  await coldSignIn();

  console.log(
    "Native passkey: the actual personnel workflow renames an existing account",
  );
  await lifecycle("rename");
  state = await coldSignIn("builder-updated");
  assert.equal(state.devices[0].id, initialDevice.id);

  console.log(
    "Native passkey: zero-counter assertions are consumed once across concurrent API replicas",
  );
  const { privateKey: syntheticKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicCoordinates = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(32);
  const registrationOptions = await page.evaluate(() =>
    window.nativePasskey.registrationOptions(),
  );
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([0x45]), // User presence, verification and attested public key.
    Buffer.alloc(4), // Registration counter is zero as well.
    Buffer.alloc(16), // Unspecified AAGUID with none attestation.
    Buffer.from([0, credentialId.length]),
    credentialId,
    cbor(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(publicCoordinates.x, "base64url")],
        [-3, Buffer.from(publicCoordinates.y, "base64url")],
      ]),
    ),
  ]);
  const registration = {
    id: credentialId.toString("base64url"),
    rawId: credentialId.toString("base64url"),
    type: "public-key",
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: registrationOptions.options.challenge,
          origin,
          crossOrigin: false,
        }),
      ).toString("base64url"),
      attestationObject: cbor(
        new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authenticatorData],
        ]),
      ).toString("base64url"),
    },
    transports: ["internal"],
  };
  const zeroDevice = await page.evaluate(
    (packet) => window.nativePasskey.registerPublicPacket(packet),
    { options: registrationOptions, credential: registration },
  );
  assert.ok(zeroDevice);
  async function zeroAssertion() {
    const options = await rpc(0, "auth.passkeys.loginOptions", undefined);
    assert.equal(options.ok, true);
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: options.value.options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const authData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([5]),
      Buffer.alloc(4),
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([
        authData,
        createHash("sha256").update(clientData).digest(),
      ]),
      syntheticKey,
    );
    const id = credentialId.toString("base64url");
    return {
      challengeToken: options.value.challengeToken,
      credential: {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle: registrationOptions.options.user.id,
        },
      },
    };
  }
  const same = await zeroAssertion();
  const competing = await Promise.all([
    rpc(0, "auth.passkeys.login", same),
    rpc(1, "auth.passkeys.login", same),
  ]);
  assert.equal(
    competing.filter((result) => result.ok).length,
    1,
    JSON.stringify(competing.map(({ ok, error }) => ({ ok, error }))),
  );
  assert.equal((await rpc(1, "auth.passkeys.login", same)).ok, false);
  assert.equal(
    (await rpc(1, "auth.passkeys.login", await zeroAssertion())).ok,
    true,
  );

  console.log(
    "Native passkey: deletion rejects a fresh, correctly signed assertion",
  );
  await page.evaluate((id) => window.nativePasskey.remove(id), zeroDevice.id);
  assert.equal(
    (await page.evaluate(() => window.nativePasskey.list())).some(
      (device) => device.id === zeroDevice.id,
    ),
    false,
  );
  assert.equal(
    (await rpc(0, "auth.passkeys.login", await zeroAssertion())).ok,
    false,
  );
  await page.screenshot({
    path: join(root, "passkeys-native.png"),
    fullPage: true,
  });
  const privacy = await page.evaluate(() => window.nativePasskey.privacy());
  assert.ok(privacy.requests > 20);
  assert.ok(privacy.prfResults > 0);
  assert.equal(privacy.secretLeaked, false);
  assert.equal(privacy.passwordLeaked, false);
  assert.equal(privacy.extensionOutputUploaded, false);

  console.log(
    "Native passkey: signing-key renewal revokes old devices and permits a fresh credential",
  );
  await lifecycle("create-member");
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  authenticatorId = await authenticator();
  await click("Lokalen Zugang schließen");
  await page
    .getByLabel("Organisation", { exact: true })
    .fill("passkey-tenant-a");
  await page.getByLabel("Anmeldename", { exact: true }).fill("passkey.member");
  await page
    .getByLabel("Passwort", { exact: true })
    .fill("Original-passkey-member-password-2026!");
  assert.equal((await click("Anmelden")).error, "");
  assert.equal((await click("Passkey einrichten")).error, "");
  await coldSignIn("passkey.member");
  const formerMemberCredentials = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials.map((credential) => credential.credentialId);
  await lifecycle("renew-member");
  await click("Lokalen Zugang schließen");
  state = await click("Mit Passkey anmelden");
  assert.notEqual(state.error, "");
  assert.equal(state.unlocked, false);
  await page
    .getByLabel("Passwort", { exact: true })
    .fill("Renewed-passkey-member-password-2026!");
  state = await click("Anmelden");
  assert.equal(state.error, "");
  assert.deepEqual(state.devices, []);
  assert.equal((await click("Passkey einrichten")).error, "");
  const renewedMemberCredentials = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials;
  assert.ok(
    renewedMemberCredentials.some(
      (credential) =>
        !formerMemberCredentials.includes(credential.credentialId),
    ),
  );
  for (const credential of renewedMemberCredentials) {
    if (formerMemberCredentials.includes(credential.credentialId)) {
      await cdp.send("WebAuthn.removeCredential", {
        authenticatorId,
        credentialId: credential.credentialId,
      });
    }
  }
  await coldSignIn("passkey.member");
  await click("Lokalen Zugang schließen");
  await page.getByLabel("Anmeldename", { exact: true }).fill("builder-updated");
  await page
    .getByLabel("Passwort", { exact: true })
    .fill("Passkey-preserved-password-2026!");
  assert.equal((await click("Anmelden")).error, "");
  const afterRenewalPrivacy = await page.evaluate(() =>
    window.nativePasskey.privacy(),
  );
  assert.equal(afterRenewalPrivacy.secretLeaked, false);
  assert.equal(afterRenewalPrivacy.passwordLeaked, false);
  assert.equal(afterRenewalPrivacy.extensionOutputUploaded, false);

  console.log(
    "Native passkey: seed-only recovery invalidates the former passkey generation",
  );
  // A fresh credential is first confirmed usable, so the later denial cannot
  // be explained by deleting its virtual authenticator or losing its key.
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  authenticatorId = await authenticator();
  const old = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  assert.equal(old.credentials.length, 0);
  // The original assertion already captured by the browser has been consumed.
  // A separate new authenticator credential remains active until recovery.
  await page
    .getByLabel("Gerätename", { exact: true })
    .fill("Recovery revocation");
  state = await click("Passkey einrichten");
  assert.equal(state.error, "");
  await coldSignIn("builder-updated");
  await lifecycle("recover");
  await click("Lokalen Zugang schließen");
  state = await click("Mit Passkey anmelden");
  assert.notEqual(state.error, "");
  assert.equal(state.unlocked, false);
  assert.equal(state.authenticated, false);
  await page
    .getByLabel("Passwort", { exact: true })
    .fill("Recovered-passkey-test-password-2026!");
  state = await click("Anmelden");
  assert.equal(state.error, "");
  assert.deepEqual(state.devices, []);
  assert.equal((await click("Passkey einrichten")).error, "");
  await coldSignIn("builder-updated");
  assert.deepEqual(external, []);
  await writeFile(
    join(root, "passkeys-browser-result.json"),
    JSON.stringify({
      success: true,
      privacy,
      zeroCounterReplayRejected: true,
      recoveryRevokedPasskeys: true,
      signingRenewalRevokedPasskeys: true,
    }),
  );
} finally {
  await context.close();
  await browser.close();
}
