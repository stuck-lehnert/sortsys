import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;
before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open({ prf = true, duringCreation = true } = {}) {
  const origin = server.origin.replace("127.0.0.1", "localhost");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((assertionOnly) => {
    window.passkeyAssertionOnly = assertionOnly;
  }, !duringCreation);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        // Exercise WebAuthn PRF through CTAP's HMAC-secret extension. Advertising
        // native PRF at the same time makes Chromium's virtual device abort
        // during registration when both creation extensions are requested.
        hasHmacSecret: prf,
        hasHmacSecretMc: prf && duringCreation,
      },
    },
  );
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  page.setDefaultTimeout(10000);
  await page.goto(`${origin}/passkeys.html`);
  await page.waitForFunction(() => window.passkeyFixture);
  await page.evaluate(() => window.passkeyFixture.initialize());
  return { context, page, cdp, authenticatorId, external };
}

for (const duringCreation of [true, false]) {
  test(
    `real WebAuthn PRF unlocks a cold device (${duringCreation ? "creation" : "assertion-only adapter"}) without uploading the secret`,
    { timeout: 15000 },
    async () => {
      const { context, page, external } = await open({ duringCreation });
      try {
        await page.evaluate(() => window.passkeyFixture.register());
        await page.evaluate(() => window.passkeyFixture.coldDevice());
        const result = await page.evaluate(() =>
          window.passkeyFixture.signIn(),
        );
        assert.equal(result.success, true);
        const state = await page.evaluate(() => window.passkeyFixture.state());
        assert.equal(state.authenticated, true);
        assert.equal(state.unlocked, true);
        assert.equal(state.identityMatches, true);
        assert.equal(state.pending, false);
        assert.equal(state.encryptedKeyStored, true);
        assert.ok(state.secretCount >= 2);
        assert.equal(state.creationResults, 1);
        assert.equal(state.assertionResults, duringCreation ? 1 : 2);
        assert.equal(state.secretsLeaked, false);
        assert.equal(state.secretViewsWiped, true);
        assert.equal(state.extensionOutputUploaded, false);
        assert.deepEqual(state.paths, [
          "auth.passkeys.registerOptions",
          "auth.passkeys.register",
          "auth.passkeys.loginOptions",
          "auth.passkeys.login",
        ]);
        assert.deepEqual(external, []);
      } finally {
        await context.close();
      }
    },
  );
}

test(
  "a passkey without PRF authenticates but cannot unlock a cold device",
  { timeout: 15000 },
  async () => {
    const { context, page } = await open({ prf: false });
    try {
      await page.evaluate(() => window.passkeyFixture.register());
      await page.evaluate(() => window.passkeyFixture.coldDevice());
      assert.equal(
        (await page.evaluate(() => window.passkeyFixture.signIn())).success,
        true,
      );
      const state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.authenticated, true);
      assert.equal(state.unlocked, false);
      assert.equal(state.pending, false);
      assert.equal(state.encryptedKeyStored, false);
      assert.equal(state.secretCount, 0);
    } finally {
      await context.close();
    }
  },
);

test(
  "a passkey without PRF retains encrypted access on an already remembered device",
  { timeout: 15000 },
  async () => {
    const { context, page } = await open({ prf: false });
    try {
      await page.evaluate(() => window.passkeyFixture.register());
      await page.evaluate(() => window.passkeyFixture.rememberDevice());
      await page.evaluate(() => window.passkeyFixture.lock());
      assert.equal(
        (await page.evaluate(() => window.passkeyFixture.signIn())).success,
        true,
      );
      const state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.authenticated, true);
      assert.equal(state.identityMatches, true);
      assert.equal(state.pending, false);
      assert.equal(state.encryptedKeyStored, false);
    } finally {
      await context.close();
    }
  },
);

test(
  "failure after decryption clears both authentication and the unlocked identity",
  { timeout: 15000 },
  async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(() => window.passkeyFixture.failAfterUnlock());
      const state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.authenticated, false);
      assert.equal(state.unlocked, false);
      assert.equal(state.pending, false);
    } finally {
      await context.close();
    }
  },
);

test(
  "a corrupted PRF wrapper rejects sign-in and installs neither token nor identity",
  { timeout: 15000 },
  async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(() => window.passkeyFixture.register());
      await page.evaluate(() => window.passkeyFixture.coldDevice());
      await page.evaluate(() => window.passkeyFixture.corruptWrapper());
      assert.equal(
        (await page.evaluate(() => window.passkeyFixture.signIn())).success,
        false,
      );
      const state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.authenticated, false);
      assert.equal(state.unlocked, false);
      assert.equal(state.pending, false);
      assert.equal(state.secretViewsWiped, true);
    } finally {
      await context.close();
    }
  },
);

test(
  "locking aborts an open authenticator prompt and allows a fresh retry",
  { timeout: 15000 },
  async () => {
    const { context, page, cdp, authenticatorId } = await open();
    try {
      await page.evaluate(() => window.passkeyFixture.register());
      await page.evaluate(() => window.passkeyFixture.coldDevice());
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: false,
      });
      const pending = page.evaluate(() => window.passkeyFixture.signIn());
      await page.waitForFunction(() =>
        window.passkeyFixture
          .state()
          .then((state) => state.activeAssertions === 1),
      );
      await page.evaluate(() => window.passkeyFixture.lock());
      assert.equal((await pending).success, false);
      let state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.unlocked, false);
      assert.equal(state.authenticated, false);
      assert.equal(
        state.paths.filter((path) => path === "auth.passkeys.login").length,
        0,
      );
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: true,
      });
      assert.equal(
        (await page.evaluate(() => window.passkeyFixture.signIn())).success,
        true,
      );
      state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.identityMatches, true);
    } finally {
      await context.close();
    }
  },
);

test(
  "locking cancels an actual registration prompt before a credential or key wrapper is stored",
  { timeout: 15000 },
  async () => {
    const { context, page, cdp, authenticatorId } = await open();
    try {
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: false,
      });
      const pending = page.evaluate(async () => {
        try {
          await window.passkeyFixture.register();
          return true;
        } catch {
          return false;
        }
      });
      await page.waitForFunction(() =>
        window.passkeyFixture
          .state()
          .then((state) => state.activeCreations === 1),
      );
      await page.evaluate(() => window.passkeyFixture.lock());
      assert.equal(await pending, false);
      const state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.authenticated, false);
      assert.equal(state.unlocked, false);
      assert.equal(state.registrationStored, false);
      assert.equal(state.encryptedKeyStored, false);
      assert.equal(state.activeCreations, 0);
    } finally {
      await context.close();
    }
  },
);

test(
  "a late passkey response cannot replace a newer unlocked session",
  { timeout: 15000 },
  async () => {
    const { context, page } = await open();
    try {
      await page.evaluate(() => window.passkeyFixture.register());
      await page.evaluate(() => window.passkeyFixture.coldDevice());
      await page.evaluate(() => window.passkeyFixture.holdLogin());
      const stale = page.evaluate(() => window.passkeyFixture.signIn());
      await page.waitForFunction(() =>
        window.passkeyFixture.state().then((state) => state.loginHeld),
      );
      assert.equal(
        (await page.evaluate(() => window.passkeyFixture.signIn())).success,
        true,
      );
      await page.evaluate(() => window.passkeyFixture.releaseLogin());
      assert.equal((await stale).success, false);
      const state = await page.evaluate(() => window.passkeyFixture.state());
      assert.equal(state.authenticated, true);
      assert.equal(state.identityMatches, true);
      assert.equal(state.pending, false);
    } finally {
      await context.close();
    }
  },
);
